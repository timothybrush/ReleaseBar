import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshTarget } from "../../../src/types.js";
import worker, { DashboardBuildLock } from "../../../worker/index.js";
import { durableLocks, kvStore, testDashboard, testProject } from "../dashboard-test-harness.js";

test("push webhooks bypass terminal target backoff before invalidating caches", async () => {
  const owner = "backedoff";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 11,
    terminalBackoffUntil: "2999-01-01T00:00:00Z",
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
    "hot:v3": JSON.stringify(
      testDashboard("hot", [testProject({ owner, name: "repo", commitsSinceRelease: 5 })]),
    ),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  const queued: unknown[] = [];
  const queuedDelays: Array<number | undefined> = [];
  const dashboardCacheAtEnqueue: Array<string | null> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        queuedDelays.push(options?.delaySeconds);
        if (
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "dashboard"
        ) {
          dashboardCacheAtEnqueue.push(await cache.get(key));
        }
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-backedoff-push",
            event: "push",
            delivery: "delivery-backedoff-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  const invalidatedHot = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  assert.equal(invalidatedHot.cache?.state, "fresh");
  assert.ok(Date.parse((await cache.get("hot:v3:invalidated-at")) ?? "") > 0);
  assert.deepEqual(dashboardCacheAtEnqueue, [null]);
  assert.equal(
    queued.some(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { kind?: unknown; targetKey?: unknown }).kind === "dashboard" &&
        (message as { targetKey?: unknown }).targetKey === key,
    ),
    true,
  );

  const activeJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "dashboard",
  ) as { id?: string } | undefined;
  assert.equal(typeof activeJob?.id, "string");
  queued.length = 0;
  await cache.put(
    key,
    JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
  );
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-push",
            event: "push",
            delivery: "delivery-reserved-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  const requeued = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-push",
  );
  assert.equal(requeued, undefined);
  const targetStub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName(key));
  const release = await targetStub.fetch(
    new Request("https://releasebar.internal/job/release", {
      method: "POST",
      body: JSON.stringify({
        jobId: activeJob!.id,
        consumeDirty: true,
      }),
    }),
  );
  assert.equal(release.status, 200);
  assert.equal(((await release.json()) as { reason?: string }).reason, "webhook:push");
});

test("reserved webhook refreshes queue one follow-up after the active job", async () => {
  const owner = "reserved-fallback";
  const now = new Date().toISOString();
  const finalDeliveryStartedAt = new Date(Date.parse(now) + 60_000).toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "sibling" })])),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  const queued: unknown[] = [];
  const delays: Array<number | undefined> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        delays.push(options?.delaySeconds);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const targetStub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName(key));
  const reservation = await targetStub.fetch(
    new Request("https://releasebar.internal/job/reserve", {
      method: "POST",
      body: JSON.stringify({ jobId: "existing-job" }),
    }),
  );
  assert.equal(reservation.status, 204);

  let acknowledged = false;
  let retried = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-fallback",
            event: "repository",
            delivery: "delivery-reserved-fallback",
            payload: {
              action: "publicized",
              repository: {
                full_name: `${owner}/missing`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
            attempts: 0,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  const requeuedWebhook = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-fallback",
  );
  assert.equal(requeuedWebhook, undefined);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);

  let activeAcknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            id: "existing-job",
            targetKey: key,
            target,
            kind: "dashboard",
            status: "succeeded",
            reason: "existing refresh",
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: now,
            startedAt: finalDeliveryStartedAt,
            finishedAt: now,
            attempts: 1,
            durationMs: 1,
          },
          attempts: 1,
          ack() {
            activeAcknowledged = true;
          },
          retry() {
            throw new Error("completed active job should not retry");
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(activeAcknowledged, true);
  const followup = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; reason?: unknown }).kind === "dashboard" &&
      String((message as { reason?: unknown }).reason).includes("repository-publicized:follow-up"),
  ) as { targetKey?: string } | undefined;
  assert.equal(followup?.targetKey, key);
  assert.equal(delays.at(-1), 0);
  assert.equal(await cache.get(key), null);
});

test("worker acknowledges webhook jobs after the durable requeue limit", async () => {
  let abandoned = false;
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/webhook/process") {
          return new Response(null, { status: 500 });
        }
        if (path === "/webhook/abandon") {
          abandoned = true;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
            attempts?: number;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-terminal",
            event: "issues",
            delivery: "delivery-terminal",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        },
      ],
    },
    { DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(abandoned, true);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
});

test("processed webhook retries take over followers behind a stale matching lease", async () => {
  const now = new Date().toISOString();
  const values = new Map<string, unknown>([
    ["webhook-deliveries", [{ id: "delivery-leader", processedAt: Date.now() }]],
    [
      "webhook-active",
      {
        jobId: "job-leader",
        leaseId: "stale-lease",
        delivery: "delivery-leader",
        expiresAt: Date.now() + 60_000,
      },
    ],
    [
      "webhook-pending",
      [
        {
          key: "delivery:delivery-follower",
          revision: "follower-revision",
          job: {
            kind: "github-webhook",
            id: "job-follower",
            event: "status",
            delivery: "delivery-follower",
            payload: {
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: now,
            attempts: 0,
          },
          deliveries: ["delivery-follower"],
        },
      ],
    ],
  ]);
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return values.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          values.set(key, value);
        },
        async delete(key: string) {
          return values.delete(key);
        },
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      },
    },
    {},
  );

  const response = await lock.fetch(
    new Request("https://releasebar.internal/webhook/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "github-webhook",
        id: "job-leader",
        event: "issues",
        delivery: "delivery-leader",
        payload: {
          action: "opened",
          repository: {
            full_name: "owner/repo",
            default_branch: "main",
          },
        },
        createdAt: now,
        attempts: 1,
      }),
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(values.get("webhook-pending"), []);
  assert.equal(values.has("webhook-active"), false);
  assert.equal(
    (values.get("webhook-deliveries") as Array<{ id: string }>).some(
      (delivery) => delivery.id === "delivery-follower",
    ),
    true,
  );
});

test("worker retries terminal webhook jobs when durable abandonment fails", async () => {
  let acknowledged = false;
  let retryDelaySeconds: number | undefined;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/webhook/process" || path === "/webhook/abandon") {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-terminal-abandon-failed",
            event: "issues",
            delivery: "delivery-terminal-abandon-failed",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        } as never,
      ],
    },
    { DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, false);
  assert.equal(retryDelaySeconds, 20);
});

test("worker quickly requeues busy webhook jobs without consuming their failure budget", async () => {
  let acknowledged = false;
  let queuedDelaySeconds: number | undefined;
  let queuedJob: { attempts?: number; delivery?: string } | undefined;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/webhook/process") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
            attempts?: number;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-busy",
            event: "issues",
            delivery: "delivery-busy",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            throw new Error("durably requeued webhook should not retry the original message");
          },
        },
      ],
    },
    {
      DASHBOARD_LOCKS: locks,
      REFRESH_QUEUE: {
        async send(
          job: { attempts?: number; delivery?: string },
          options?: { delaySeconds?: number },
        ) {
          queuedJob = job;
          queuedDelaySeconds = options?.delaySeconds;
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, true);
  assert.equal(queuedJob?.delivery, "delivery-busy");
  assert.equal(queuedJob?.attempts, 48);
  assert.equal(queuedDelaySeconds, 20);
});

test("terminal webhook fanout clears admission and processing deduplication", async () => {
  const abandoned: string[] = [];
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/webhook/abandon") {
          abandoned.push(id);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const cache = {
    ...kvStore(),
    async list() {
      throw new Error("fanout page failed");
    },
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal",
            event: "push",
            delivery: "delivery-fanout-terminal",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: () => undefined },
  );

  assert.deepEqual(abandoned.sort(), ["github-webhook-admission", "github-webhook-process:owner"]);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
});

test("terminal webhook fanout retries when durable abandonment fails", async () => {
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };
  const cache = {
    ...kvStore(),
    async list() {
      throw new Error("fanout page failed");
    },
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal-abandon-failed",
            event: "push",
            delivery: "delivery-fanout-terminal-abandon-failed",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, false);
  assert.equal(retried, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker, { DashboardBuildLock } from "../../../worker/index.js";
import {
  durableLocks,
  kvStore,
  testDashboard,
  testProject,
  webhookSignature,
} from "../dashboard-test-harness.js";

test("GitHub push webhooks prioritize recent targets beyond the durable hot-cache limit", async () => {
  type QueuedWebhook = {
    kind: "github-webhook";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    attempts?: number;
  };
  type QueuedFanout = {
    kind: "github-webhook-fanout";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    action: {
      reason: string;
      includeReleaseDataOnly: boolean;
      invalidateDashboard: boolean;
      recentTargetsOnly?: boolean;
      prioritizedTargetKeys?: string[];
    };
    source: "indexed" | "owner" | "repo" | "kv-owner" | "kv-repo" | "legacy";
    priorityBatchStartedAt?: string;
    cursor?: string;
  };
  const secret = "fanout-webhook-secret";
  const owner = "fanout";
  const now = new Date().toISOString();
  const fallbackTargetIndex = 0;
  const staleTargetIndex = 204;
  const firstReleaseTargetIndex = 26;
  const movedTargetIndex = 201;
  const newestTargetIndex = 202;
  const durableOnlyTargetIndex = 203;
  const metadataOnlyTargetIndexes = new Set(Array.from({ length: 25 }, (_, index) => index + 1));
  const project = testProject({ owner, name: "repo" });
  const degradedRepoTarget = {
    key: "dashboard:v6:custom:noforks-noarchived-unreleased-release:sources-degraded",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: [`${owner}/repo`],
    includeReleaseData: true,
    path: `/?repos=${owner}/repo`,
    priority: 60,
    lastSeenAt: new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  } satisfies RefreshTarget;
  const targets = Array.from({ length: 205 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    const key = `dashboard:v6:${owner}:noforks-noarchived-unreleased-release:sources-${suffix}`;
    return {
      key,
      kind: "dashboard",
      owner,
      owners: [owner],
      repos: [],
      includeReleaseData: !metadataOnlyTargetIndexes.has(index),
      path: `/${owner}?variant=${suffix}`,
      priority: 60,
      lastSeenAt:
        index === staleTargetIndex
          ? new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString()
          : index === fallbackTargetIndex
            ? new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString()
            : metadataOnlyTargetIndexes.has(index)
              ? new Date(Date.parse(now) + 3_000).toISOString()
              : index === newestTargetIndex
                ? new Date(Date.parse(now) + 2_000).toISOString()
                : now,
      lastAttemptAt: null,
      lastSuccessAt: now,
      nextDueAt: "2999-01-01T00:00:00Z",
      failureCount: 0,
      indexVersion: 2,
    } satisfies RefreshTarget;
  });
  const cache = kvStore({
    "refresh:target-index:v1:ready": "2",
    ...Object.fromEntries(
      targets.flatMap((target, index) => [
        [`refresh:target:v1:${target.key}`, JSON.stringify(target)],
        [
          `refresh:target-index:v1:owner:${owner}:${String(index).padStart(3, "0")}`,
          JSON.stringify(target.key),
        ],
        [target.key, JSON.stringify(testDashboard(owner, [project]))],
      ]),
    ),
    [`refresh:target:v1:${degradedRepoTarget.key}`]: JSON.stringify(degradedRepoTarget),
    [degradedRepoTarget.key]: JSON.stringify(testDashboard("custom", [project])),
  });
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:duplicate`,
    JSON.stringify(targets[0]!.key),
  );
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:degraded`,
    JSON.stringify(degradedRepoTarget.key),
  );
  const queued: Array<RefreshJob | QueuedWebhook | QueuedFanout> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const durableOwnerIndex = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(`refresh-target-index:owner:${owner}`),
  );
  for (const [index, target] of targets.entries()) {
    const indexedTarget =
      index === fallbackTargetIndex
        ? {
            ...target,
            lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
          }
        : target;
    const indexed = await durableOwnerIndex.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify(indexedTarget),
      }),
    );
    assert.equal(indexed.status, 204);
  }
  await cache.delete(`refresh:target:v1:${targets[durableOnlyTargetIndex]!.key}`);
  const durableRepoIndex = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(`refresh-target-index:repo:${owner}/repo`),
  );
  const staleRepoDuplicate = {
    ...targets[newestTargetIndex]!,
    lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  const duplicate = await durableRepoIndex.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify(staleRepoDuplicate),
    }),
  );
  assert.equal(duplicate.status, 204);
  const payload = {
    ref: "refs/heads/main",
    after: "abcdef1234567890",
    repository: {
      full_name: `${owner}/repo`,
      archived: false,
      default_branch: "main",
      pushed_at: now,
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-fanout",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 202);
  const webhookJob = queued.find(
    (message): message is QueuedWebhook => message.kind === "github-webhook",
  );
  assert.ok(webhookJob);
  let acknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob,
          attempts: 1,
          ack: () => {
            acknowledged = true;
          },
          retry: () => undefined,
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );
  const initialDashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  const firstFanout = queued.find(
    (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
  );
  assert.ok(firstFanout);
  assert.equal(initialDashboardJobs.length, 25);
  assert.equal(firstFanout.action.prioritizedTargetKeys?.length, 25);
  assert.equal(typeof firstFanout.priorityBatchStartedAt, "string");
  firstFanout.createdAt = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  await cache.put(
    "github:budget:v1:shared:_",
    JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5_000,
      resetAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      reason: "test cooldown",
    }),
  );
  let fanoutAcknowledged = false;
  let fanoutRetryDelaySeconds: number | undefined;
  await worker.queue(
    {
      messages: [
        {
          body: firstFanout,
          attempts: 1,
          ack: () => {
            fanoutAcknowledged = true;
          },
          retry: (options) => {
            fanoutRetryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(fanoutAcknowledged, false);
  assert.equal(fanoutRetryDelaySeconds, 20);
  await cache.delete("github:budget:v1:shared:_");
  for (const job of initialDashboardJobs) {
    const releaseResponse: Response = await env.DASHBOARD_LOCKS.get(
      env.DASHBOARD_LOCKS.idFromName(job.targetKey),
    ).fetch(
      new Request("https://releasebar.internal/job/release", {
        method: "POST",
        body: JSON.stringify({ jobId: job.id }),
      }),
    );
    assert.equal(releaseResponse.status, 204);
  }
  const moved = await durableOwnerIndex.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify({
        ...targets[movedTargetIndex]!,
        lastSeenAt: new Date(Date.parse(now) + 4_000).toISOString(),
      }),
    }),
  );
  assert.equal(moved.status, 204);
  const rebuiltPrioritizedCache = JSON.stringify(testDashboard(owner, [project]));
  await cache.put(targets[newestTargetIndex]!.key, rebuiltPrioritizedCache);
  const pageSizes = [
    queued.filter((message): message is RefreshJob => message.kind === "dashboard").length,
  ];
  while (true) {
    const fanoutIndex = queued.findIndex(
      (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
    );
    if (fanoutIndex < 0) break;
    const [fanout] = queued.splice(fanoutIndex, 1);
    const before = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    await worker.queue(
      {
        messages: [
          {
            body: fanout!,
            attempts: 1,
            ack: () => undefined,
            retry: () => undefined,
          },
        ],
      },
      env,
      { waitUntil: () => undefined },
    );
    const after = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    pageSizes.push(after - before);
  }

  const dashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  assert.equal(acknowledged, true);
  assert.equal(pageSizes.length >= 2, true);
  assert.equal(Math.max(...pageSizes) <= 200, true);
  assert.equal(
    new Set(dashboardJobs.map((job) => job.targetKey)).size,
    targets.length - metadataOnlyTargetIndexes.size,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[staleTargetIndex]!.key),
    false,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[fallbackTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[movedTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[durableOnlyTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === degradedRepoTarget.key),
    true,
  );
  assert.equal(dashboardJobs[0]?.targetKey, targets[newestTargetIndex]!.key);
  const firstJob = dashboardJobs.find(
    (job) => job.targetKey === targets[firstReleaseTargetIndex]!.key,
  );
  assert.ok(firstJob);
  const firstTargetStub = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(targets[firstReleaseTargetIndex]!.key),
  );
  const release = await firstTargetStub.fetch(
    new Request("https://releasebar.internal/job/release", {
      method: "POST",
      body: JSON.stringify({ jobId: firstJob.id, consumeDirty: true }),
    }),
  );
  assert.equal(release.status, 204);
  assert.equal(await cache.get(targets[staleTargetIndex]!.key), null);
  assert.notEqual(await cache.get(targets[1]!.key), null);
  assert.equal(await cache.get(targets[firstReleaseTargetIndex]!.key), null);
  assert.equal(await cache.get(targets[newestTargetIndex]!.key), rebuiltPrioritizedCache);
  assert.equal(await cache.get(targets.at(-1)!.key), null);
  assert.equal(await cache.get(degradedRepoTarget.key), null);
});

test("durable target indexes cap persistent variants per source", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  const stub = locks.get(locks.idFromName("refresh-target-index:owner:owner"));
  for (let index = 0; index < 512; index += 1) {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify({
          key: `dashboard:v6:owner:variant-${index}`,
          kind: "dashboard",
          owner: "owner",
          owners: ["owner"],
          repos: [],
          includeReleaseData: true,
          path: `/owner?variant=${index}`,
          priority: 60,
          lastSeenAt: now,
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextDueAt: now,
          failureCount: 0,
        } satisfies RefreshTarget),
      }),
    );
    assert.equal(response.status, 204);
  }
  const rejected = await stub.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify({
        key: "dashboard:v6:owner:variant-overflow",
        kind: "dashboard",
        owner: "owner",
        owners: ["owner"],
        repos: [],
        includeReleaseData: true,
        path: "/owner?variant=overflow",
        priority: 60,
        lastSeenAt: now,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextDueAt: now,
        failureCount: 0,
      } satisfies RefreshTarget),
    }),
  );
  assert.equal(rejected.status, 429);
});

test("durable target indexes reject oversized entries and serialized source state", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  const stub = locks.get(locks.idFromName("refresh-target-index:owner:owner"));
  const target = (index: number, padding: number): RefreshTarget => ({
    key: `dashboard:v6:owner:large-${index}`,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: `/owner?padding=${"x".repeat(padding)}&variant=${index}`,
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: now,
    failureCount: 0,
  });
  const oversized = await stub.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify(target(0, 9 * 1024)),
    }),
  );
  assert.equal(oversized.status, 413);

  let accepted = 0;
  let rejected = 0;
  for (let index = 1; index <= 512; index += 1) {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify(target(index, 4 * 1024)),
      }),
    );
    if (response.status === 204) accepted += 1;
    if (response.status === 429) {
      rejected = index;
      break;
    }
  }
  assert.equal(accepted > 0, true);
  assert.equal(rejected > 0 && rejected < 512, true);
});

test("repo-only refresh targets do not consume a shared custom-owner index", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:repo-only-index",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: ["owner/repo"],
    includeReleaseData: true,
    path: "/?repos=owner/repo",
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("custom", [testProject({ owner: "owner", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = locks;
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const customIndex = await locks.get(locks.idFromName("refresh-target-index:owner:custom")).fetch(
    new Request("https://releasebar.internal/target-index/list", {
      method: "POST",
    }),
  );
  const repoIndex = await locks.get(locks.idFromName("refresh-target-index:repo:owner/repo")).fetch(
    new Request("https://releasebar.internal/target-index/list", {
      method: "POST",
    }),
  );
  assert.deepEqual(await customIndex.json(), []);
  assert.equal(((await repoIndex.json()) as RefreshTarget[])[0]?.key, target.key);
});

test("multi-source target admission rolls back newly-created durable indexes", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:atomic-index",
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: ["other/repo"],
    includeReleaseData: true,
    path: "/owner?repos=other/repo",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("owner", [testProject({ owner: "other", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const backing = durableLocks(env);
  const locks = {
    idFromName: backing.idFromName,
    get(id: string) {
      if (id === "refresh-target-index:repo:other/repo") {
        return {
          async fetch(request: Request) {
            return new URL(request.url).pathname === "/target-index/upsert"
              ? new Response(null, { status: 429 })
              : new Response(null, { status: 204 });
          },
        };
      }
      return backing.get(id);
    },
  };
  env.DASHBOARD_LOCKS = locks;
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const ownerIndex = await backing
    .get(backing.idFromName("refresh-target-index:owner:owner"))
    .fetch(
      new Request("https://releasebar.internal/target-index/list", {
        method: "POST",
      }),
    );
  assert.deepEqual(await ownerIndex.json(), []);
  assert.equal(await cache.get(`refresh:target:v1:${target.key}`), null);
});

test("rejected target admission does not persist or queue the target", async () => {
  const owner = "capped";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const generatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cached = {
    ...testDashboard(owner, [testProject({ owner, name: "repo" })]),
    generatedAt,
    cache: {
      state: "stale",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt,
      countsUpdatedAt: generatedAt,
      projectCountsUpdatedAt: { [`${owner}/repo`]: generatedAt },
      releasesUpdatedAt: generatedAt,
      ciUpdatedAt: generatedAt,
    },
  } satisfies DashboardPayload;
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
  });
  const queued: unknown[] = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(message) {
        queued.push(message);
      },
    },
  };
  const backing = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: backing.idFromName,
    get(id: string) {
      if (id === `refresh-target-index:owner:${owner}`) {
        return {
          async fetch(request: Request) {
            return new URL(request.url).pathname === "/target-index/upsert"
              ? new Response(null, { status: 429 })
              : new Response(null, { status: 204 });
          },
        };
      }
      return backing.get(id);
    },
  };
  const waits: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`https://release.bar/api/${owner}`), env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.equal(response.status, 200);
  assert.equal(queued.length, 0);
  assert.equal(await cache.get(`refresh:target:v1:${key}`), null);
});

test("archive webhooks invalidate caches when owner snapshots omit the repository", async () => {
  const secret = "archive-no-snapshot-secret";
  const owner = "coldowner";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const dashboard = testDashboard(owner, [testProject({ owner, name: "repo" })]);
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
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`]:
      JSON.stringify({ generatedAt: now, data: { name: "repo" } }),
    [`owner-metadata:v1:${owner}`]: JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [testProject({ owner, name: "sibling" })],
    }),
  });
  const queued: unknown[] = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const payload = {
    action: "archived",
    repository: {
      full_name: `${owner}/repo`,
      archived: true,
      default_branch: "main",
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "repository",
        "x-github-delivery": "delivery-archive-no-snapshot",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 202);
  const webhookJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "github-webhook",
  );
  assert.ok(webhookJob);
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob as never,
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  assert.equal(
    await cache.get(
      `repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`,
    ),
    null,
  );
});

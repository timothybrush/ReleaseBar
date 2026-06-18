import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import {
  kvStore,
  refreshAuditEvents,
  testDashboard,
  testProject,
} from "../dashboard-test-harness.js";

test("worker refresh jobs can use shared quota when no source app token exists", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer shared-token");
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
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
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "succeeded");
  const auditEvents = await refreshAuditEvents(cache);
  assert.equal(
    auditEvents.some((event) => event.event === "job_start"),
    true,
  );
  assert.equal(
    auditEvents.some((event) => event.event === "dashboard_build_start"),
    true,
  );
  const buildDone = auditEvents.find((event) => event.event === "dashboard_build_done");
  assert.equal(buildDone?.status, "fresh");
  assert.equal(buildDone?.projects, 0);
  assert.deepEqual(paths, ["/users/openclaw", "/graphql"]);
});

test("worker refresh jobs preserve profile filters from the queued target snapshot", async () => {
  const key = dashboardCacheKey({
    owner: "profiled",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const profile = {
    owner: "profiled",
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: ["profiled/secret"],
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: "profiled",
  };
  const profileSnapshotKey = `refresh:profile-snapshot:v1:profiled:${encodeURIComponent(
    profile.updatedAt,
  )}`;
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "profiled",
    owners: ["profiled"],
    repos: [],
    profileSnapshotKey,
    includeReleaseData: false,
    path: "/profiled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const targetSnapshotKey = `refresh:jobs:v2:${String(
    Number.MAX_SAFE_INTEGER - Date.parse("2026-06-11T07:00:00Z"),
  ).padStart(16, "0")}:job-profile-snapshot`;
  const job: RefreshJob = {
    id: "job-profile-snapshot",
    targetKey: key,
    target,
    targetSnapshotKey,
    kind: "dashboard",
    status: "queued",
    reason: "cold-metadata",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const latestLastSeenAt = "2026-06-11T07:30:00Z";
  const latestPath = "/profiled?sort=prs&dir=desc";
  const backingCache = kvStore({
    [targetSnapshotKey]: JSON.stringify(job),
    [profileSnapshotKey]: JSON.stringify(profile),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  let mutableJobWrites = 0;
  const cache = {
    ...backingCache,
    async put(storageKey: string, value: string) {
      if (storageKey === `refresh:job:v1:${job.id}`) {
        mutableJobWrites += 1;
      }
      await backingCache.put(storageKey, value);
    },
  };
  const originalFetch = globalThis.fetch;
  let releaseOwnerFetch: (() => void) | undefined;
  const ownerFetchGate = new Promise<void>((resolve) => {
    releaseOwnerFetch = resolve;
  });
  let markOwnerFetchStarted: (() => void) | undefined;
  const ownerFetchStarted = new Promise<void>((resolve) => {
    markOwnerFetchStarted = resolve;
  });
  const repo = (name: string) => ({
    owner: { login: "profiled" },
    name,
    full_name: `profiled/${name}`,
    description: null,
    html_url: `https://github.com/profiled/${name}`,
    default_branch: "main",
    language: "TypeScript",
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  });
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/profiled") {
        await cache.put(
          `refresh:target:v1:${key}`,
          JSON.stringify({
            ...target,
            lastSeenAt: latestLastSeenAt,
            path: latestPath,
          }),
        );
        markOwnerFetchStarted?.();
        await ownerFetchGate;
        return Response.json({ login: "profiled", type: "User" });
      }
      if (url.pathname === "/users/profiled/repos") {
        return Response.json([repo("visible"), repo("secret")]);
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    };

    const processing = (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
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
            body: { ...job, target: undefined },
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("profile snapshot job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    await ownerFetchStarted;
    const deliveries = await cache.list({ prefix: "refresh:job-deliveries:v1:" });
    assert.equal(deliveries.keys.length, 1);
    const running = JSON.parse(
      (await cache.get(deliveries.keys[0]?.name ?? "")) ?? "{}",
    ) as RefreshJob;
    assert.equal(running.status, "running");
    assert.notEqual(running.startedAt, null);
    releaseOwnerFetch?.();
    await processing;
  } finally {
    releaseOwnerFetch?.();
    globalThis.fetch = originalFetch;
  }

  assert.equal(acked, true);
  assert.equal(mutableJobWrites, 1);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.deepEqual(dashboard.profile, profile);
  assert.deepEqual(
    dashboard.projects.map((project) => project.fullName),
    ["profiled/visible"],
  );
  const updatedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(updatedTarget.lastSeenAt, latestLastSeenAt);
  assert.equal(updatedTarget.path, latestPath);
});

test("worker retries refresh jobs when the dashboard build lock is busy", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-locked",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  let acked = false;
  let retryDelaySeconds: number | undefined;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
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
          body: job,
          ack() {
            acked = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: busyLocks },
    { waitUntil: () => undefined },
  );

  assert.equal(acked, false);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.startedAt, null);
  assert.equal(updated.finishedAt, null);
  assert.equal(updated.durationMs, null);
  assert.equal(updated.error, "dashboard locked");
});

test("worker stops and retries stalled progressive dashboard scans", async () => {
  const key = dashboardCacheKey({
    owner: "stalled",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const projects = Array.from({ length: 100 }, (_, index) =>
    testProject({
      owner: "stalled",
      name: `repo-${String(index + 1).padStart(3, "0")}`,
    }),
  );
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "stalled",
    owners: ["stalled"],
    repos: [],
    includeReleaseData: true,
    path: "/stalled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-stalled",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const dashboard = {
    ...testDashboard("stalled", projects),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 100, limit: 200, done: false },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: projects.map((project) => project.fullName.toLowerCase()),
      projects,
      updatedAt: "2026-06-11T07:00:00Z",
    }),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const repoRows = projects.map((project) => ({
    owner: { login: "stalled" },
    name: project.name,
    full_name: project.fullName,
    description: null,
    html_url: project.url,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  }));
  const originalFetch = globalThis.fetch;
  let repoPages = 0;
  let retryDelaySeconds: number | undefined;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/stalled/repos") {
        repoPages += 1;
        return Response.json(repoRows);
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
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
            body: job,
            attempts: 1,
            ack() {
              throw new Error("stalled job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(repoPages, 2);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard stalled");
});

test("worker aborts Queue hydration at the delivery deadline", async () => {
  const key = dashboardCacheKey({
    owner: "deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "deadline",
    owners: ["deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cached = {
    ...testDashboard("deadline", []),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 0, limit: 200, done: false },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let aborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/deadline/repos") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
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
            body: job,
            attempts: 1,
            ack() {
              throw new Error("deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(aborted, true);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard deadline reached");
  assert.equal(updated.finishedAt, null);
});

test("worker aborts Queue GitHub App token lookup at the delivery deadline", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = dashboardCacheKey({
    owner: "credential-deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "credential-deadline",
    owners: ["credential-deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/credential-deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-credential-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let credentialAborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app/installations") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          credentialAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            credentialAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
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
            body: job,
            attempts: 1,
            ack() {
              throw new Error("credential deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(credentialAborted, true);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard deadline reached");
});

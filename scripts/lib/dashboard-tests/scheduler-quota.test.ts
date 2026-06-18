import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, signedJson, testDashboard, testProject } from "../dashboard-test-harness.js";

test("worker scheduler preserves queued backlog jobs until reservation expiry", async () => {
  const sessionId = "session-admin-stale-queued";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=stale-queued",
    kind: "dashboard",
    owner: "stale-queued",
    owners: ["stale-queued"],
    repos: [],
    includeReleaseData: false,
    path: "/stale-queued",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const queuedJob: RefreshJob = {
    id: "queued-backlog-job",
    targetKey: target.key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    durationMs: null,
    error: "dashboard incomplete",
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    [`refresh:job:v1:${queuedJob.id}`]: JSON.stringify(queuedJob),
    "refresh:jobs:index:v1": JSON.stringify([queuedJob.id]),
  });
  const sentJobs: RefreshJob[] = [];

  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  const activeResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });
  assert.equal(activeResponse.status, 200);
  const activeBody = (await activeResponse.json()) as { due: number; enqueued: number };
  assert.equal(activeBody.due, 0);
  assert.equal(activeBody.enqueued, 0);
  assert.equal(sentJobs.length, 0);

  const expiredJob = {
    ...queuedJob,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  };
  await cache.put(`refresh:job:v1:${queuedJob.id}`, JSON.stringify(expiredJob));

  const expiredResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });

  assert.equal(expiredResponse.status, 200);
  const expiredBody = (await expiredResponse.json()) as { due: number; enqueued: number };
  assert.equal(expiredBody.due, 1);
  assert.equal(expiredBody.enqueued, 1);
  assert.equal(sentJobs.length, 1);
  assert.notEqual(sentJobs[0]?.id, queuedJob.id);
});

test("worker clears fallback reservations after active-job scans fail", async () => {
  const sessionId = "session-admin-reservation-scan-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-scan-failure",
    kind: "dashboard",
    owner: "reservation-scan-failure",
    owners: ["reservation-scan-failure"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-scan-failure",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const backingCache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  let refreshJobListCalls = 0;
  const cache = {
    ...backingCache,
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      if (options.prefix?.startsWith("refresh:job")) {
        refreshJobListCalls += 1;
      }
      if (refreshJobListCalls === 3) {
        throw new Error("active job scan failed");
      }
      return backingCache.list(options);
    },
  };
  const unavailableLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    DASHBOARD_LOCKS: unavailableLocks,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  await assert.rejects(
    worker.fetch(request(), env, { waitUntil: () => undefined }),
    /active job scan failed/,
  );
  assert.equal(sentJobs.length, 0);

  const response = await worker.fetch(request(), env, { waitUntil: () => undefined });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker scheduler falls back when the reservation Durable Object is unavailable", async () => {
  const sessionId = "session-admin-reservation-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-fallback",
    kind: "dashboard",
    owner: "reservation-fallback",
    owners: ["reservation-fallback"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-fallback",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];
  const unavailableLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: unavailableLocks,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker admin GitHub access ignores expired shared quota cooldowns", async () => {
  const sessionId = "session-admin-expired-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { active?: boolean } };
  assert.equal(body.cooldown?.active, false);
  assert.equal(await cache.get("github:budget:v1:shared:_"), null);
});

test("worker admin GitHub access keeps longest active shared quota cooldown", async () => {
  const sessionId = "session-admin-longest-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 10,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "shorter",
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "3000-01-01T00:00:00.000Z",
      reason: "longer",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { resource?: string | null } };
  assert.equal(body.cooldown?.resource, "graphql");
});

test("worker admin scheduler defers shared quota paused targets even with missing cache", async () => {
  const sessionId = "session-admin-shared-quota-defer";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker admin scheduler lets app-token targets bypass shared quota pauses", async () => {
  const sessionId = "session-admin-shared-quota-app-bypass";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler uses app registry coverage without minting tokens", async () => {
  const sessionId = "session-admin-shared-quota-app-registry";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler bypasses shared quota defer time with app coverage", async () => {
  const sessionId = "session-admin-shared-quota-app-stale";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
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
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: "2026-05-15T13:00:00Z",
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker scheduler marks jobs failed when queue delivery fails", async () => {
  const sessionId = "session-admin-queue-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
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
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  await assert.rejects(
    worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send() {
            throw new Error("queue unavailable");
          },
        },
      },
      { waitUntil: () => undefined },
    ),
    /queue unavailable/,
  );

  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  assert.equal(indexedJobs.keys.length, 1);
  const indexed = JSON.parse(
    (await cache.get(indexedJobs.keys[0]?.name ?? "")) ?? "{}",
  ) as RefreshJob;
  const stored = JSON.parse(
    (await cache.get(`refresh:job:v1:${indexed.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.match(stored.error ?? "", /queue unavailable/);
});

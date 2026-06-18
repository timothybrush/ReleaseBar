import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker, { DashboardBuildLock } from "../../../worker/index.js";
import { kvStore, testDashboard, testProject } from "../dashboard-test-harness.js";

test("worker Queue messages stay bounded when profile filters are large", async () => {
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
    hiddenRepos: Array.from(
      { length: 5000 },
      (_, index) => `profiled/repository-${String(index).padStart(4, "0")}`,
    ),
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
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [profileSnapshotKey]: JSON.stringify(profile),
  });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];

  await (
    worker as unknown as {
      scheduled(
        event: { cron: string },
        env: unknown,
        context: { waitUntil(promise: Promise<unknown>): void },
      ): Promise<void>;
    }
  ).scheduled(
    { cron: "*/15 * * * *" },
    {
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: (promise) => waits.push(promise) },
  );
  await Promise.all(waits);

  assert.equal(sentJobs.length, 1);
  assert.equal(sentJobs[0]?.target, undefined);
  assert.equal(JSON.stringify(sentJobs[0]).length < 4096, true);
  const snapshot = JSON.parse(
    (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
  ) as RefreshJob;
  assert.equal(snapshot.target?.profileSnapshotKey, profileSnapshotKey);
  assert.equal(JSON.stringify(snapshot.target).length < 4096, true);
  assert.equal(await cache.get("refresh:target-index:v1:ready"), null);
  const storedProfile = JSON.parse((await cache.get(profileSnapshotKey)) ?? "{}") as {
    hiddenRepos?: string[];
  };
  assert.equal(storedProfile.hiddenRepos?.length, 5000);
});

test("owner count scheduling rotates beyond a deferred owner cap", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const owners = Array.from({ length: 21 }, (_, index) => `owner${String(index).padStart(3, "0")}`);
  const entries = Object.fromEntries(
    owners.flatMap((owner) => {
      const key = dashboardCacheKey({
        owner,
        includeUnreleased: true,
        includeReleaseData: true,
        schemaVersion: 6,
      });
      const project = testProject({ owner, name: "repo" });
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
      return [
        [`refresh:target:v1:${key}`, JSON.stringify(target)],
        [key, JSON.stringify(testDashboard(owner, [project]))],
        [
          `owner-metadata:v1:${owner}`,
          JSON.stringify({
            owner,
            generatedAt: now,
            metadataUpdatedAt: now,
            countsUpdatedAt: staleAt,
            releaseDataComplete: true,
            knownRepos: [project.fullName.toLowerCase()],
            removedRepos: {},
            projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
            projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
            projects: [project],
          }),
        ],
      ];
    }),
  );
  const cache = kvStore(entries);
  const run = async () => {
    const waits: Promise<unknown>[] = [];
    await (
      worker as unknown as {
        scheduled(
          event: { cron: string },
          env: unknown,
          context: { waitUntil(promise: Promise<unknown>): void },
        ): Promise<void>;
      }
    ).scheduled(
      { cron: "*/15 * * * *" },
      { DASHBOARD_CACHE: cache },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  };

  await run();
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), "owner019");
  await run();
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), "owner018");
});

test("owner count scheduling throttles recent incomplete scans", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "large-owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "large-owner", name: "repo" });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "large-owner",
    owners: ["large-owner"],
    repos: [],
    includeReleaseData: true,
    path: "/large-owner",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [key]: JSON.stringify(testDashboard("large-owner", [project])),
    "owner-metadata:v1:large-owner": JSON.stringify({
      owner: "large-owner",
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: staleAt,
      countsAttemptedAt: now,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      removedRepos: {},
      projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
      projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
      projects: [project],
    }),
  });
  const originalFetch = globalThis.fetch;
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname === "/graphql") graphqlRequests += 1;
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/15 * * * *" } as never,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(graphqlRequests, 0);
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), null);
});

test("worker scheduler terminalizes retryable refreshes when Queue is unavailable", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: "/owner",
    priority: 100,
    lastSeenAt: "2026-06-11T06:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T06:00:00Z",
    failureCount: 0,
  };
  const cached: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: new Date().toISOString(),
      progress: {
        scanned: 12,
        limit: 200,
        done: false,
      },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  let released = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const waits: Promise<unknown>[] = [];
  await (
    worker as unknown as {
      scheduled(
        event: { cron: string },
        env: unknown,
        context: { waitUntil(promise: Promise<unknown>): void },
      ): Promise<void>;
    }
  ).scheduled(
    { cron: "*/15 * * * *" },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: (promise) => waits.push(promise) },
  );

  while (waits.length > 0) {
    await Promise.all(waits.splice(0));
  }

  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  assert.equal(indexedJobs.keys.length, 1);
  const indexed = JSON.parse(
    (await cache.get(indexedJobs.keys[0]?.name ?? "")) ?? "{}",
  ) as RefreshJob;
  const stored = JSON.parse(
    (await cache.get(`refresh:job:v1:${indexed.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.match(stored.error ?? "", /Queue continuation unavailable/);
  assert.equal(released, true);
});

test("dashboard build lock only releases the matching lease token", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );

  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    409,
  );

  storage.set("lock", { token: "first", expiresAt: Date.now() - 1 });
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  const secondExpiresAt = (storage.get("lock") as { expiresAt: number }).expiresAt;
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal((storage.get("lock") as { expiresAt: number }).expiresAt >= secondExpiresAt, true);
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/release", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.deepEqual(storage.get("lock"), {
    token: "second",
    expiresAt: (storage.get("lock") as { expiresAt: number }).expiresAt,
  });
});

test("dashboard build lock reserves one refresh job per dashboard", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );
  const request = (path: string, jobId: string) =>
    lock.fetch(
      new Request(`https://releasebar.internal${path}`, {
        method: "POST",
        body: JSON.stringify({ jobId }),
      }),
    );

  assert.equal((await request("/job/reserve", "first")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 409);
  assert.equal((await request("/job/reserve", "first")).status, 204);
  assert.equal((await request("/job/release", "second")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 409);
  assert.equal((await request("/job/release", "first")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 204);
});

test("dashboard target mutations preserve terminal backoff across stale observations", async () => {
  const storage = new Map<string, unknown>();
  const cache = kvStore();
  const lock = new DashboardBuildLock(
    {
      blockConcurrencyWhile: async (callback) => callback(),
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    { DASHBOARD_CACHE: cache },
  );
  const input = {
    key: "dashboard:v6:owner=target-race",
    owner: "target-race",
    owners: ["target-race"],
    repos: [],
    includeReleaseData: true,
    path: "/target-race",
    priority: 100,
  };
  const mutate = async (snapshot: RefreshTarget | null, mutation: unknown) => {
    const response = await lock.fetch(
      new Request("https://releasebar.internal/target/mutate", {
        method: "POST",
        body: JSON.stringify({ snapshot, mutation }),
      }),
    );
    assert.equal(response.status, 200);
    return (await response.json()) as RefreshTarget;
  };

  const observed = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:00:00Z",
    profileProvided: false,
  });
  const failed = await mutate(observed, {
    kind: "failure",
    at: "2026-06-11T12:01:00Z",
    message: "terminal failure",
    terminal: true,
  });
  const observedAgain = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:02:00Z",
    profileProvided: false,
  });

  assert.equal(observedAgain.failureCount, 1);
  assert.equal(observedAgain.nextDueAt, failed.nextDueAt);
  assert.equal(observedAgain.terminalBackoffUntil, failed.nextDueAt);
  assert.equal(observedAgain.message, "terminal failure");
  const stored = JSON.parse(
    (await cache.get(`refresh:target:v1:${input.key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(stored.terminalBackoffUntil, failed.nextDueAt);
});

test("dashboard build lock stores strongly consistent build progress", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );
  const request = (path: string, body?: unknown) =>
    lock.fetch(
      new Request(`https://releasebar.internal${path}`, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const progress = {
    scannedRepos: ["owner/repo"],
    projects: [testProject({ owner: "owner", name: "repo" })],
    updatedAt: "2026-06-11T12:00:00Z",
  };

  const empty = await request("/progress/get");
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get("x-releasebar-progress"), "durable");
  assert.equal((await request("/progress/put", progress)).status, 204);
  const stored = await request("/progress/get");
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get("x-releasebar-progress"), "durable");
  assert.deepEqual(await stored.json(), progress);
  assert.equal((await request("/progress/delete")).status, 204);
  assert.equal((await request("/progress/get")).status, 204);

  assert.equal(
    (
      await request("/progress/put", {
        ...progress,
        updatedAt: "2020-01-01T00:00:00Z",
      })
    ).status,
    204,
  );
  assert.equal((await request("/progress/get")).status, 204);
  assert.equal(storage.has("build-progress"), false);
});

test("worker falls back to KV progress when the Durable Object is unavailable", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
    }
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: async (request: Request) => {
              if (new URL(request.url).pathname === "/owner-metadata/read") {
                return new Response(null, { status: 204 });
              }
              throw new Error("Durable Object unavailable");
            },
          }),
        },
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          send: async () => undefined,
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const fallback = JSON.parse((await cache.get(`progress:v1:${key}`)) ?? "{}") as {
      durableFallback?: boolean;
    };
    assert.equal(fallback.durableFallback, true);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker resumes marked KV progress after an authoritative Durable Object miss", async () => {
  const key = dashboardCacheKey({
    owner: "fallback",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "fallback",
    owners: ["fallback"],
    repos: [],
    includeReleaseData: true,
    path: "/fallback",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-kv-progress-fallback",
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
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "fallback" },
      name,
      full_name: `fallback/${name}`,
      description: null,
      html_url: `https://github.com/fallback/${name}`,
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
    };
  });
  const progressProjects = repos.slice(0, 12).map((repo) =>
    testProject({
      owner: "fallback",
      name: repo.name,
      pushedAt: repo.pushed_at,
      updatedAt: repo.updated_at,
      latestCommitDate: repo.updated_at,
    }),
  );
  const cache = kvStore({
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: progressProjects.map((project) => project.fullName.toLowerCase()),
      projects: progressProjects,
      updatedAt: "2026-06-11T07:00:00Z",
      durableFallback: true,
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/progress/get") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/progress/delete" || path === "/progress/put") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  const originalFetch = globalThis.fetch;
  const hydratedRepos: string[] = [];
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/fallback") {
        return Response.json({ login: "fallback", type: "User" });
      }
      if (path === "/users/fallback/repos") {
        return Response.json(repos);
      }
      if (path.endsWith("/releases")) {
        hydratedRepos.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
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
              acked = true;
            },
            retry() {
              throw new Error("KV fallback progress should complete");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: locks },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(acked, true);
  assert.deepEqual(hydratedRepos, ["repo-13"]);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.equal(dashboard.projects.length, 13);
  assert.equal(dashboard.cache?.progress?.done, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, testProject } from "../dashboard-test-harness.js";

test("worker does not restore stale KV progress after an authoritative Durable Object miss", async () => {
  const key = dashboardCacheKey({
    owner: "authoritative",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "authoritative",
    owners: ["authoritative"],
    repos: [],
    includeReleaseData: true,
    path: "/authoritative",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-authoritative-progress",
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
  const staleProject = testProject({ owner: "authoritative", name: "deleted" });
  const cache = kvStore({
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [staleProject.fullName.toLowerCase()],
      projects: [staleProject],
      updatedAt: "2026-06-11T07:00:00Z",
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
        if (path === "/progress/put" || path === "/progress/delete") {
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
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/authoritative") {
        return Response.json({ login: "authoritative", type: "User" });
      }
      if (path === "/users/authoritative/repos") {
        return Response.json([]);
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
              throw new Error("authoritative progress job should not retry");
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
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.deepEqual(dashboard.projects, []);
  const tombstone = JSON.parse((await cache.get(`progress:tombstone:v1:${key}`)) ?? "{}") as {
    clearedAt?: string;
  };
  assert.equal(typeof tombstone.clearedAt, "string");
});

test("worker does not persist delayed progress older than its tombstone", async () => {
  const key = dashboardCacheKey({
    owner: "delayed-progress",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "delayed-progress",
    owners: ["delayed-progress"],
    repos: [],
    includeReleaseData: false,
    path: "/delayed-progress",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: new Date().toISOString(),
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-delayed-progress",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "delayed-progress" },
      name,
      full_name: `delayed-progress/${name}`,
      description: null,
      html_url: `https://github.com/delayed-progress/${name}`,
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
  const cache = kvStore({
    [`progress:tombstone:v1:${key}`]: JSON.stringify({
      clearedAt: "2999-01-01T00:00:00Z",
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  let retryDelaySeconds: number | undefined;

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/delayed-progress") {
      return Response.json({ login: "delayed-progress", type: "User" });
    }
    if (path === "/users/delayed-progress/repos") {
      return Response.json(repos);
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
              throw new Error("partial delayed progress should retry");
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

  assert.equal(retryDelaySeconds, 2);
  assert.equal(await cache.get(`progress:v1:${key}`), null);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.equal(dashboard.cache?.progress?.scanned, 12);
  assert.equal(dashboard.cache?.progress?.done, false);
});

test("worker tombstones failed Durable Object progress deletion before publishing fresh cache", async () => {
  const originalFetch = globalThis.fetch;
  const key = dashboardCacheKey({
    owner: "delete-failure",
    includeUnreleased: false,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const progressStorageKey = `progress:v1:${key}`;
  const progressTombstoneStorageKey = `progress:tombstone:v1:${key}`;
  const storedProgress = JSON.stringify({
    scannedRepos: [],
    projects: [],
    updatedAt: new Date().toISOString(),
  });
  const cache = kvStore({ [progressStorageKey]: storedProgress });
  const staleProject = testProject({
    owner: "delete-failure",
    name: "repo",
    version: "v0.1.0",
    releaseDate: "2025-01-01T00:00:00Z",
  });
  let released = false;
  let deleteAttempts = 0;
  let deleteFails = true;
  let durableProgressPresent = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/acquire") {
          return new Response(null, { status: 204 });
        }
        if (path === "/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/progress/get") {
          return durableProgressPresent
            ? Response.json(
                {
                  scannedRepos: [staleProject.fullName.toLowerCase()],
                  projects: [staleProject],
                  updatedAt: "2026-06-10T00:00:00Z",
                },
                { headers: { "x-releasebar-progress": "durable" } },
              )
            : new Response(null, {
                status: 204,
                headers: { "x-releasebar-progress": "durable" },
              });
        }
        if (path === "/progress/delete") {
          deleteAttempts += 1;
          if (!deleteFails) {
            durableProgressPresent = false;
            return new Response(null, {
              status: 204,
              headers: { "x-releasebar-progress": "durable" },
            });
          }
          durableProgressPresent = true;
          return new Response(null, {
            status: 503,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/job/reserve" || path === "/job/release") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/delete-failure") {
      return Response.json({ login: "delete-failure", type: "User" });
    }
    if (path === "/users/delete-failure/repos") {
      return Response.json([
        {
          owner: { login: "delete-failure" },
          name: "repo",
          full_name: "delete-failure/repo",
          description: null,
          html_url: "https://github.com/delete-failure/repo",
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
        },
      ]);
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/delete-failure/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-06-10T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-06-11T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/delete-failure/repo/compare",
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

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/delete-failure?unreleased=false"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: locks,
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "fresh");
    assert.equal(body.projects[0]?.version, "v1.0.0");
    const tombstone = JSON.parse((await cache.get(progressTombstoneStorageKey)) ?? "{}") as {
      clearedAt?: string;
    };
    assert.equal(typeof tombstone.clearedAt, "string");
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(cached.cache?.state, "fresh");
    assert.equal(deleteAttempts, 1);
    assert.equal(released, true);

    deleteFails = false;
    const target: RefreshTarget = {
      key,
      kind: "dashboard",
      owner: "delete-failure",
      owners: ["delete-failure"],
      repos: [],
      includeReleaseData: true,
      path: "/delete-failure?unreleased=false",
      priority: 100,
      lastSeenAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextDueAt: new Date().toISOString(),
      failureCount: 0,
    };
    const job: RefreshJob = {
      id: "job-delete-failure-recovery",
      targetKey: key,
      target,
      kind: "dashboard",
      status: "queued",
      reason: "error-cache",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      durationMs: null,
    };
    let acked = false;
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
              throw new Error("recovered progress deletion should not retry");
            },
          },
        ],
      },
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: locks,
      },
      { waitUntil: () => undefined },
    );

    assert.equal(acked, true);
    const recovered = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(recovered.cache?.state, "fresh");
    assert.equal(recovered.projects[0]?.version, "v1.0.0");
    const recoveredTombstone = JSON.parse(
      (await cache.get(progressTombstoneStorageKey)) ?? "{}",
    ) as { clearedAt?: string };
    assert.equal(typeof recoveredTombstone.clearedAt, "string");
    assert.equal(deleteAttempts >= 2, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

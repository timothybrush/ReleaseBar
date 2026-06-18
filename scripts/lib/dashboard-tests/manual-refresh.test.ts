import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob } from "../../../src/types.js";
import worker, { DashboardBuildLock } from "../../../worker/index.js";
import { durableLocks, kvStore, testDashboard, testProject } from "../dashboard-test-harness.js";

test("worker manual dashboard refresh returns metadata before release hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const repoNode = (issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: "Manual refresh repo",
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [] },
    stargazerCount: 42,
    forkCount: 2,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    releases: {
      nodes: [
        {
          tagName: "v1.0.0",
          name: null,
          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          isDraft: false,
          publishedAt: "2026-05-01T00:00:00Z",
        },
      ],
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      assert.equal(body.variables?.first, 100);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode(9, 4)],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.match(body.cache?.message ?? "", /repository metadata refreshed/);
    assert.equal(body.projects[0]?.openIssues, 9);
    assert.equal(body.projects[0]?.openPullRequests, 4);
    assert.equal(body.projects[0]?.version, "repo search");

    const repeated = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(repeated.status, 202);
    const repeatedBody = (await repeated.json()) as DashboardPayload;
    assert.match(repeatedBody.cache?.message ?? "", /manual refresh recently started/);
    assert.equal(repeatedBody.projects[0]?.openIssues, 9);

    await Promise.all(waits);
    const cached = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.projects[0]?.version, "v1.0.0");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual refreshes merge owner removals observed during the build before caching", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] & {
    GITHUB_TOKEN: string;
    REFRESH_QUEUE: { send(): Promise<void> };
  } = {
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: { send: async () => undefined },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  let removalRecorded = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
    }
    if (url.pathname === "/graphql") {
      if (!removalRecorded) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const stub = env.DASHBOARD_LOCKS!.get(
          env.DASHBOARD_LOCKS!.idFromName("owner-metadata:owner"),
        );
        const removed = await stub.fetch(
          new Request("https://releasebar.internal/owner-metadata/mutate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "owner",
              mutation: {
                kind: "remove",
                fullName: "owner/repo",
                observedAt: new Date().toISOString(),
              },
            }),
          }),
        );
        assert.equal(removed.ok, true);
        removalRecorded = true;
      }
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "removed during build",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 1,
                  forkCount: 0,
                  issues: { totalCount: 1 },
                  pullRequests: { totalCount: 0 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T00:00:00Z",
                  releases: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 0);
    const cached = JSON.parse(
      (await cache.get(
        dashboardCacheKey({
          owner: "owner",
          includeUnreleased: true,
          includeReleaseData: true,
          schemaVersion: 6,
        }),
      )) ?? "{}",
    ) as DashboardPayload;
    assert.equal(cached.projects.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves repository cap metadata", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const offset = body.variables?.after ? 100 : 0;
      const nodes = Array.from({ length: 100 }, (_, index) => {
        const number = offset + index + 1;
        const name = `repo-${number}`;
        return {
          owner: { login: "wide", __typename: "User" },
          name,
          nameWithOwner: `wide/${name}`,
          description: null,
          url: `https://github.com/wide/${name}`,
          defaultBranchRef: { name: "main" },
          primaryLanguage: null,
          repositoryTopics: { nodes: [] },
          stargazerCount: 0,
          forkCount: 0,
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          isArchived: false,
          isFork: false,
          isPrivate: false,
          pushedAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:00Z",
        };
      });
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: {
                hasNextPage: true,
                endCursor: offset === 0 ? "page-2" : "page-3",
              },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide", { method: "POST" }),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(graphqlCalls, 2);
    assert.equal(body.projects.length, 200);
    assert.equal(body.cache?.capped, true);
    assert.equal(body.cache?.repoLimit, 200);
    assert.equal(sentJobs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker limits cold metadata to one small page before queue hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  const nodes = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${index + 1}`;
    return {
      owner: { login: "wide", __typename: "User" },
      name,
      nameWithOwner: `wide/${name}`,
      description: null,
      url: `https://github.com/wide/${name}`,
      defaultBranchRef: { name: "main" },
      primaryLanguage: { name: "TypeScript" },
      repositoryTopics: { nodes: [] },
      stargazerCount: index,
      forkCount: 0,
      issues: { totalCount: index + 1 },
      pullRequests: { totalCount: index },
      isArchived: false,
      isFork: index === 0,
      isPrivate: false,
      pushedAt: "2026-05-15T00:00:00Z",
      updatedAt: "2026-05-15T00:00:00Z",
    };
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; after?: string | null; includeReleases?: boolean };
      };
      assert.equal(body.variables?.first, 25);
      assert.equal(body.variables?.after, null);
      assert.equal(body.variables?.includeReleases, false);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next-page" },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(graphqlCalls, 1);
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.equal(body.cache?.repoLimit, 200);
    assert.equal(body.options?.repoLimit, 200);
    assert.equal(body.projects.length, 24);
    assert.equal(
      body.projects.some((project) => project.name === "repo-1"),
      false,
    );
    assert.equal(body.projects.find((project) => project.name === "repo-25")?.openIssues, 25);
    assert.equal(body.projects.find((project) => project.name === "repo-25")?.openPullRequests, 24);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns structured GitHub errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.match(body.cache?.message ?? "", /GitHub shared API quota is exhausted/);

    const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
    const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
    dashboard.generatedAt = new Date().toISOString();
    if (dashboard.cache && dashboard.options) {
      dashboard.cache.generatedAt = dashboard.generatedAt;
      dashboard.options.includeUnreleased = true;
    }
    const cache = kvStore({ [key]: JSON.stringify(dashboard) });
    const cachedResponse = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(cachedResponse.status, 429);
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(cached.cache?.state, "fresh");
    assert.equal(cached.projects.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL backoff does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore({
    "github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL upstream failure does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "upstream unavailable" },
        {
          status: 503,
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "800",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner", "/graphql"]);
    assert.ok(await cache.get("github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata"));
    assert.ok(await cache.get("github:budget:v1:shared:graphql"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves released-only cache while rebuilding", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "Released repo",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 42,
                  forkCount: 2,
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-05-15T00:00:00Z",
                  updatedAt: "2026-05-15T00:00:00Z",
                  releases: {
                    nodes: [
                      {
                        tagName: "v1.0.0",
                        name: null,
                        url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                        isDraft: false,
                        publishedAt: "2026-05-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: false, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const env = {
    DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]?.version, "v1.0.0");
    assert.match(body.cache?.message ?? "", /release data updating/);

    await Promise.all(waits);
    const cached = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false"),
      env,
      { waitUntil: () => undefined },
    );
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.projects[0]?.openIssues, 7);
    assert.equal(hydrated.projects[0]?.openPullRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

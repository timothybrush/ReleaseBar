import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, signedJson, testDashboard, testProject } from "../dashboard-test-harness.js";

test("worker only exposes public selected installation repositories", async () => {
  const sessionId = "session-public-repos";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "steipete",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/58493",
              html_url: "https://github.com/steipete",
            },
            html_url: "https://github.com/settings/installations/1",
            repository_selection: "selected",
            target_type: "User",
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/1/repositories") {
      return Response.json({
        repositories: [
          {
            full_name: "steipete/public-repo",
            private: false,
            visibility: "public",
          },
          {
            full_name: "steipete/private-repo",
            private: true,
            visibility: "private",
          },
          {
            full_name: "steipete/contradictory-private-repo",
            private: true,
            visibility: "public",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/?repos=steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.installations[0].repositories, ["steipete/public-repo"]);
    assert.equal(body.installNeeded, false);

    const repoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoRoute.status, 200);
    const repoRouteBody = await repoRoute.json();
    assert.equal(repoRouteBody.installNeeded, false);

    const escapedRepoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/-/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(escapedRepoRoute.status, 200);
    const escapedRepoRouteBody = await escapedRepoRoute.json();
    assert.equal(escapedRepoRouteBody.installNeeded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker allows mixed-account dashboards to use partitioned App quota", async () => {
  const sessionId = "session-2";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: ["openclaw", "steipete"].map((login, index) => ({
          id: index + 1,
          account: {
            login,
            type: index === 0 ? "Organization" : "User",
            avatar_url: `https://avatars.githubusercontent.com/u/${index + 2}`,
            html_url: `https://github.com/${login}`,
          },
          html_url: `https://github.com/settings/installations/${index + 1}`,
          repository_selection: "all",
          target_type: index === 0 ? "Organization" : "User",
        })),
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps signed-in mixed-account dashboards on shared release scans", async () => {
  const sessionId = "session-mixed-dashboard";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const graphqlIncludeReleases: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/users/steipete") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "steipete", type: "User" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer shared-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { includeReleases?: boolean };
      };
      graphqlIncludeReleases.push(Boolean(body.variables?.includeReleases));
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4996",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.deepEqual(graphqlIncludeReleases, [false, false]);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
    assert.equal(body.cache?.quota?.source, "shared");
    assert.equal(body.cache?.quota?.remaining, 4996);
    assert.doesNotMatch(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured owner dashboards metadata-only", async () => {
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "v9.9.9",
      releaseName: "hydrated release cache",
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const fetchedPaths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    fetchedPaths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "repo",
          full_name: "owner/repo",
          description: null,
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          language: "TypeScript",
          topics: ["releasebar"],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 2,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.deepEqual(fetchedPaths, ["/users/owner", "/users/owner/repos"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "cookie");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.equal(body.projects[0]?.commitsSinceRelease, null);
    assert.equal(body.projects[0]?.openIssues, null);
    assert.equal(body.projects[0]?.openPullRequests, null);
    assert.equal(body.cache?.countsUpdatedAt, null);
    assert.match(body.cache?.message ?? "", /release scan skipped/);
    assert.notEqual(body.projects[0]?.releaseName, "hydrated release cache");
    assert.equal(await env.DASHBOARD_CACHE.get("hot:index:v3"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses GitHub App installation token for cold owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-3";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  let appRestFallbacks = 0;
  const appReleasePageSizes: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      assert.equal(authorization, "Bearer installation-token");
      appRestFallbacks += 1;
      return Response.json([]);
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      if (!body.variables?.includeReleases) {
        return Response.json({ message: "upstream unavailable" }, { status: 502 });
      }
      if (body.variables?.includeReleases && body.variables.first) {
        appReleasePageSizes.push(body.variables.first);
      }
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4997",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, null);
    assert.equal(appRestFallbacks, 1);
    assert.deepEqual(appReleasePageSizes, [50]);
    assert.ok(
      await env.DASHBOARD_CACHE.get(
        "github:backoff:v2:graphql:app:openclaw:ReleaseBarOwnerRepos.metadata",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered source-owned app tokens for anonymous owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const auditLogs: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  console.log = (message?: unknown) => {
    if (typeof message === "string" && message.includes("github_token_use")) {
      auditLogs.push(JSON.parse(message));
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4998",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, 4998);
    assert.equal(
      auditLogs.some(
        (entry) =>
          (entry as { event?: string; quota?: { source?: string; account?: string } }).event ===
            "github_token_use" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.source === "app" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.account ===
            "openclaw",
      ),
      true,
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps stale source installation coverage when discovery fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
    "auth:installation-token:1": "installation-token",
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let discoveryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      discoveryCalls += 1;
      return Response.json({ message: "temporarily unavailable" }, { status: 503 });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
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
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(discoveryCalls, 1);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(await cache.get("auth:installation-miss:v1:openclaw"), null);
    assert.notEqual(await cache.get("auth:installation:v1:openclaw"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

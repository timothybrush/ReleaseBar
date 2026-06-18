import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard, dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import {
  kvStore,
  refreshAuditEvents,
  testDashboard,
  testProject,
} from "../dashboard-test-harness.js";

test("worker rejects POST to reserved read-only owner-like APIs", async () => {
  for (const path of ["/api/me", "/api/_hot", "/api/_discover"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`, { method: "POST" }),
      {},
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 405, path);
  }
});

test("worker marks GitHub discovery hydration complete when release scan is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      return Response.json({
        total_count: 1,
        items: [
          {
            name: "releasebar",
            full_name: "acme/releasebar",
            private: false,
            fork: false,
            archived: false,
            html_url: "https://github.com/acme/releasebar",
            description: "Release dashboard",
            default_branch: "main",
            language: "TypeScript",
            stargazers_count: 1200,
            forks_count: 42,
            open_issues_count: 7,
            pushed_at: "2026-05-16T12:00:00Z",
            updated_at: "2026-05-16T12:00:00Z",
            owner: { login: "acme" },
          },
        ],
      });
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const waitUntil: Promise<unknown>[] = [];
  const env = { DASHBOARD_CACHE: kvStore() };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntil.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    await Promise.all(waitUntil.splice(0));
    const cached = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    const body = (await cached.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "fresh");
    assert.equal(body.cache?.progress?.done, true);
    assert.equal(body.projects[0]?.version, "repo search");
    assert.match(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker pauses shared quota after discovery secondary rate limits", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "You have exceeded a secondary rate limit" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "search",
        },
      },
    );
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const cooldown = JSON.parse((await cache.get("github:budget:v1:shared:search")) ?? "{}") as {
      active?: boolean;
      resource?: string;
      reason?: string;
      resetAt?: string | null;
    };
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.resource, "search");
    assert.equal(cooldown.reason, "rate limited status 403");
    assert.equal(typeof cooldown.resetAt, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker falls back to stale discovery cache when GitHub search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [testProject({ owner: "cached", name: "repo" })]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    }),
  };
  globalThis.fetch = async () =>
    Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.projects[0]?.fullName, "cached/repo");
    assert.match(body.cache?.message ?? "", /cached search/);
    assert.doesNotMatch(body.cache?.message ?? "", /install the app/i);

    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=month"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(coldResponse.status, 429);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    assert.equal(coldBody.cache?.state, "error");
    assert.match(coldBody.cache?.message ?? "", /repository search quota is exhausted/);
    assert.doesNotMatch(coldBody.cache?.message ?? "", /install the app/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns dashboard-shaped rate-limit errors without raw GitHub JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/vincentkoc") {
      return Response.json(
        {
          message: "API rate limit exceeded for user ID 58493",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
          status: "403",
        },
        { status: 403 },
      );
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  const waits: Array<Promise<unknown>> = [];
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.equal(body.owners[0]?.login, "vincentkoc");
    assert.deepEqual(body.projects, []);
    assert.match(body.cache?.message ?? "", /shared API quota is exhausted/);
    assert.doesNotMatch(body.cache?.message ?? "", /58493|documentation_url|request ID/i);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(cached.status, 429);
    await cached.arrayBuffer();
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard build records GitHub quota headers", async () => {
  const resetAt = Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "installation-token",
    quotaSource: "app",
    quotaAccount: "owner",
    repoLimit: 200,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") {
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
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  });

  assert.equal(payload.cache?.quota?.source, "app");
  assert.equal(payload.cache?.quota?.account, "owner");
  assert.equal(payload.cache?.quota?.limit, 5000);
  assert.equal(payload.cache?.quota?.remaining, 4998);
  assert.equal(payload.cache?.quota?.resetAt, "2026-05-15T13:00:00.000Z");
  assert.equal(payload.cache?.quota?.resource, "graphql");
});

test("worker preserves cached quota metadata on fresh responses", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", []);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
    dashboard.cache.quota = {
      source: "app",
      account: "owner",
      limit: 5000,
      remaining: 4900,
      resetAt: "2026-05-15T13:00:00.000Z",
      resource: "graphql",
    };
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.cache?.state, "fresh");
  assert.equal(body.cache?.quota?.source, "app");
  assert.equal(body.cache?.quota?.remaining, 4900);
});

test("worker streams cached dashboard snapshots over owner events", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /owner\/repo/);
});

test("worker records dashboard stream sync audits", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const cache = kvStore({ [key]: JSON.stringify(dashboard) });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  await response.text();
  const events = await refreshAuditEvents(cache);
  assert.equal(
    events.some((event) => event.event === "dashboard_stream_start"),
    true,
  );
  const send = events.find((event) => event.event === "dashboard_stream_send");
  assert.equal(send?.status, "fresh");
  assert.equal(send?.projects, 1);
  const done = events.find((event) => event.event === "dashboard_stream_done");
  assert.equal(done?.events, 1);
});

test("worker keeps owner events working for the repos owner slug", async () => {
  const key = dashboardCacheKey({ owner: "repos", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("repos", [testProject({ owner: "repos", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /repos\/repo/);
});

test("worker returns rebuilding while another isolate owns the dashboard build lock", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: kvStore(),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses an in-isolate build lease when Durable Objects fail open", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  let graphqlCalls = 0;
  let markGraphqlStarted: (() => void) | undefined;
  let releaseGraphql: (() => void) | undefined;
  const graphqlStarted = new Promise<void>((resolve) => {
    markGraphqlStarted = resolve;
  });
  const graphqlGate = new Promise<void>((resolve) => {
    releaseGraphql = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/local") {
      return Response.json({ login: "local", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      markGraphqlStarted?.();
      await graphqlGate;
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
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const failedLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/acquire") {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  const env = {
    DASHBOARD_CACHE: cache,
    DASHBOARD_LOCKS: failedLocks,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: { send: async () => undefined },
  };

  try {
    const first = worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    await graphqlStarted;
    const second = await worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(second.status, 202);
    const secondBody = (await second.json()) as DashboardPayload;
    assert.equal(secondBody.cache?.state, "rebuilding");
    releaseGraphql?.();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(graphqlCalls, 1);
  } finally {
    releaseGraphql?.();
    globalThis.fetch = originalFetch;
  }
});

test("worker does not display dashboard data past the stale display window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/old") {
      return Response.json({ login: "old", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const key = dashboardCacheKey({ owner: "old", schemaVersion: 6 });
  const dashboard = testDashboard("old", [testProject({ owner: "old", name: "ancient" })]);
  dashboard.generatedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/old"),
      {
        DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(body.projects.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves partial cached sources while combined dashboard rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const now = new Date().toISOString();
  const alphaSource = testProject({ owner: "alpha", name: "one", openIssues: 1 });
  const alphaMetadata = testProject({
    owner: "alpha",
    name: "one",
    openIssues: 9,
    version: "repo search",
    releaseDate: null,
  });

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        DASHBOARD_CACHE: kvStore({
          [alphaKey]: JSON.stringify(testDashboard("alpha", [alphaSource])),
          [betaKey]: JSON.stringify(
            testDashboard("beta", [testProject({ owner: "beta", name: "two" })]),
          ),
          "owner-metadata:v1:alpha": JSON.stringify({
            owner: "alpha",
            generatedAt: now,
            metadataUpdatedAt: now,
            countsUpdatedAt: now,
            projects: [alphaMetadata],
          }),
        }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.deepEqual(body.projects.map((project) => project.fullName).sort(), [
      "alpha/one",
      "beta/two",
    ]);
    assert.equal(body.totals.repos, 2);
    assert.equal(body.cache?.countsUpdatedAt, null);
    assert.equal(body.cache?.releasesUpdatedAt, null);
    assert.equal(body.cache?.ciUpdatedAt, null);
    const mergedAlpha = body.projects.find((project) => project.fullName === "alpha/one");
    assert.equal(mergedAlpha?.openIssues, 9);
    assert.equal(mergedAlpha?.version, alphaSource.version);
    assert.equal(mergedAlpha?.releaseDate, alphaSource.releaseDate);
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

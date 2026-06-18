import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import { attentionReasons, needsAttention, releaseDebtText } from "../../../src/dashboard-view.js";
import type { DashboardPayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, testDashboard, testProject } from "../dashboard-test-harness.js";

test("need attention explains release debt, stale releases, CI, and open work", () => {
  const stale = testProject({
    owner: "owner",
    name: "stale",
    releaseDate: "2026-01-01T00:00:00Z",
  });
  const pressured = testProject({
    owner: "owner",
    name: "pressure",
    commitsSinceRelease: 42,
    freshness: "hot",
    ciState: "failure",
    openPullRequests: 12,
    openIssues: 120,
  });
  const releaseDebt = testProject({
    owner: "owner",
    name: "release-debt",
    commitsSinceRelease: 201,
    freshness: "hot",
    releaseDate: "2026-05-01T00:00:00Z",
  });

  assert.equal(needsAttention(stale), true);
  assert.deepEqual(attentionReasons(stale, Date.parse("2026-05-15T00:00:00Z")), [
    "last release 134 days ago",
  ]);
  assert.equal(needsAttention(pressured), true);
  assert.deepEqual(attentionReasons(pressured), ["CI failing", "12 open PRs", "120 open issues"]);
  assert.equal(needsAttention(releaseDebt), true);
  assert.equal(needsAttention({ ...pressured, archived: true }), false);
  assert.equal(releaseDebtText({ ...releaseDebt, archived: true }), null);
  assert.deepEqual(attentionReasons({ ...pressured, archived: true }), []);
  assert.deepEqual(attentionReasons(releaseDebt, Date.parse("2026-05-15T00:00:00Z")), [
    "201 commits since release",
  ]);
  assert.equal(
    attentionReasons(
      testProject({ owner: "owner", name: "fresh" }),
      Date.parse("2026-05-15T00:00:00Z"),
    ).length,
    0,
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "warm",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "hot-placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "unreleased",
        version: "unreleased",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
});

test("worker builds root hot dashboard from cached dashboards", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const forksKey = dashboardCacheKey({ owner: "forks", includeForks: true, schemaVersion: 6 });
  const legacyKey = dashboardCacheKey({ owner: "legacy", schemaVersion: 5 });
  const env = {
    DASHBOARD_CACHE: kvStore({
      "hot:index:v3": JSON.stringify([alphaKey, legacyKey]),
      [alphaKey]: JSON.stringify(
        testDashboard("alpha", [
          testProject({
            owner: "alpha",
            name: "hot",
            commitsSinceRelease: 100,
            freshness: "hot",
          }),
          testProject({ owner: "alpha", name: "second", commitsSinceRelease: 80 }),
          testProject({ owner: "alpha", name: "third", commitsSinceRelease: 60 }),
          testProject({ owner: "alpha", name: "fourth", commitsSinceRelease: 40 }),
          testProject({
            owner: "alpha",
            name: "archived",
            archived: true,
            commitsSinceRelease: 120,
          }),
        ]),
      ),
      [betaKey]: JSON.stringify(
        testDashboard("beta", [
          testProject({
            owner: "beta",
            name: "popular",
            stars: 500,
            commitsSinceRelease: 20,
          }),
          testProject({
            owner: "beta",
            name: "unreleased",
            releaseDate: null,
            commitsSinceRelease: null,
          }),
        ]),
      ),
      [forksKey]: JSON.stringify({
        ...testDashboard("forks", [
          testProject({
            owner: "forks",
            name: "cached-fork",
            commitsSinceRelease: 500,
            freshness: "hot",
          }),
        ]),
        options: {
          includeForks: true,
          includeArchived: false,
          includeUnreleased: false,
          repoLimit: 200,
        },
      }),
      [legacyKey]: JSON.stringify(
        testDashboard("legacy", [
          testProject({
            owner: "legacy",
            name: "estimated-counts",
            stars: 10_000,
            openIssues: 500,
            openPullRequests: 100,
          }),
        ]),
      ),
      [dashboardCacheKey({ owner: "gamma", schemaVersion: 6 })]: JSON.stringify(
        testDashboard("gamma", [
          testProject({
            owner: "gamma",
            name: "from-list",
            commitsSinceRelease: 30,
          }),
        ]),
      ),
      "owner-metadata:v1:alpha": JSON.stringify({
        owner: "alpha",
        generatedAt: new Date().toISOString(),
        metadataUpdatedAt: new Date().toISOString(),
        countsUpdatedAt: new Date().toISOString(),
        releaseDataComplete: true,
        projects: [
          testProject({ owner: "alpha", name: "hot", openIssues: 99 }),
          testProject({ owner: "alpha", name: "second", archived: true }),
        ],
      }),
    }),
  };

  const response = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.title, "ReleaseBar Hot");
  assert.deepEqual(body.owners, []);
  assert.equal(body.projects[0]?.fullName, "alpha/hot");
  assert.equal(body.projects[0]?.openIssues, 99);
  assert.equal(
    body.projects.some((project) => project.fullName === "alpha/second"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "alpha/archived"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "beta/unreleased"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "legacy/estimated-counts"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "forks/cached-fork"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "gamma/from-list"),
    true,
  );
  assert.equal(body.projects.filter((project) => project.owner === "alpha").length <= 3, true);
  assert.match(body.cache?.message ?? "", /cached dashboards/);

  const cachedResponse = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });
  const cachedBody = (await cachedResponse.json()) as DashboardPayload;
  assert.equal(cachedBody.cache?.repoLimit, null);
  assert.match(cachedBody.cache?.message ?? "", /cached dashboards/);
});

test("worker serves stale hot dashboards while one background rebuild refreshes the cache", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const staleAt = new Date(Date.now() - 1000).toISOString();
  const staleHot: DashboardPayload = {
    ...testDashboard("stale", [
      testProject({ owner: "stale", name: "cached", commitsSinceRelease: 5 }),
    ]),
    title: "ReleaseBar Hot",
    generatedAt: staleAt,
    owners: [],
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: null,
      generatedAt: staleAt,
    },
  };
  const cache = kvStore({
    "hot:v3": JSON.stringify(staleHot),
    "hot:v3:invalidated-at": staleAt,
    "hot:index:v3": JSON.stringify([alphaKey]),
    [alphaKey]: JSON.stringify(
      testDashboard("alpha", [
        testProject({ owner: "alpha", name: "fresh", commitsSinceRelease: 50 }),
      ]),
    ),
  });
  const waits: Array<Promise<unknown>> = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/_hot"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );
  const body = (await response.json()) as DashboardPayload;

  assert.equal(response.status, 200);
  assert.equal(body.cache?.state, "stale");
  assert.match(body.cache?.message ?? "", /while it refreshes/);
  assert.equal(body.projects[0]?.fullName, "stale/cached");

  await Promise.all(waits);
  const refreshed = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  assert.equal(refreshed.cache?.state, "fresh");
  assert.equal(refreshed.projects[0]?.fullName, "alpha/fresh");
});

test("worker keeps hot owner route distinct from root hot API", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/hot") {
      return Response.json({ login: "hot", type: "User" });
    }
    if (url.pathname === "/users/hot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/hot"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: (promise) => waits.push(promise) },
    );
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(response.status, 200);
    assert.equal(body.owners[0]?.login, "hot");
    assert.notEqual(body.title, "ReleaseBar Hot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves escaped dotted repository detail paths as app shell", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/-/openclaw/react.dev"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ReleaseBar release freshness dashboard for openclaw\/react\.dev/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
});

test("worker reserves owner activity pages while escaped activity repositories remain available", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/acme/activity"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /@acme activity/);
  assert.doesNotMatch(html, /id="releasebar-initial-data"/);

  const escaped = await worker.fetch(
    new Request("https://release.bar/-/acme/activity"),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );
  assert.equal(escaped.status, 200);
  assert.match(await escaped.text(), /acme\/activity/);

  for (const owner of ["api", "og"]) {
    const reserved = await worker.fetch(
      new Request(`https://release.bar/-/owners/${owner}/activity`),
      {
        ASSETS: {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, "/index.html");
            return new Response(
              '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
              { headers: { "content-type": "text/html" } },
            );
          },
        },
        DASHBOARD_CACHE: kvStore(),
      },
      { waitUntil: () => undefined },
    );
    assert.equal(reserved.status, 200);
    assert.match(await reserved.text(), new RegExp(`@${owner} activity`));
  }
});

test("worker preserves API and social namespaces beside escaped reserved-owner activity pages", async () => {
  const generatedAt = new Date().toISOString();
  const dashboard = testDashboard("activity", []);
  dashboard.generatedAt = generatedAt;
  if (dashboard.cache && dashboard.options) {
    dashboard.cache.generatedAt = generatedAt;
    dashboard.options.includeUnreleased = true;
  }
  const key = dashboardCacheKey({
    owner: "activity",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/activity"),
    {
      ASSETS: {
        fetch: async () => {
          throw new Error("API namespace must not reach app assets");
        },
      },
      DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    },
    { waitUntil: () => undefined },
  );
  assert.equal(apiResponse.status, 200);
  assert.match(apiResponse.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(((await apiResponse.json()) as DashboardPayload).owners[0]?.login, "activity");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const socialResponse = await worker.fetch(
      new Request("https://release.bar/og/activity"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(socialResponse.status, 200);
    assert.match(socialResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    assert.match(await socialResponse.text(), /@activity/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached public dashboard data in the app shell", async () => {
  const payload = testDashboard("hot", [testProject({ owner: "acme", name: "releasebar" })]);
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"dashboard"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for ReleaseBar Hot"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/ReleaseBar%20Hot\.png"/,
  );
  assert.ok(html.indexOf('id="releasebar-initial-data"') < html.indexOf('<script type="module"'));
});

test("worker embeds cached metadata-only owner dashboard data in the app shell", async () => {
  const payload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.options = { ...payload.options!, includeUnreleased: true };
  payload.cache = {
    ...payload.cache!,
    message: "release scan skipped until GitHub App quota is available",
  };
  const metadataKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = {
    ...payload,
    projects: [
      testProject({
        owner: "owner",
        name: "repo",
        version: "v9.9.9",
        releaseName: "hydrated release cache",
      }),
    ],
  } satisfies DashboardPayload;
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        [metadataKey]: JSON.stringify(payload),
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "cookie");
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /owner\\u002frepo|owner\/repo/);
  assert.match(html, /release scan skipped/);
  assert.doesNotMatch(html, /hydrated release cache/);
});

test("worker does not embed a release-only cache for an unsynced owner dashboard", async () => {
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
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore({
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /hydrated release cache/);
  assert.doesNotMatch(html, /id="releasebar-initial-data"/);
});

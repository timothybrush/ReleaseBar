import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RepoDetailPayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import {
  crawlerRequest,
  kvStore,
  signedJson,
  socialRenderAsset,
  testDashboard,
  testProject,
} from "../dashboard-test-harness.js";

test("signed-in mixed-account fast paths preserve release dashboards", async () => {
  const sessionId = "session-mixed-cache";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const generatedAt = new Date().toISOString();
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const keyInput = {
    owner: "openclaw",
    owners: ["steipete"],
    includeUnreleased: true,
    schemaVersion: 6,
  };
  const metadataKey = dashboardCacheKey({ ...keyInput, includeReleaseData: false });
  const releaseKey = dashboardCacheKey({ ...keyInput, includeReleaseData: true });
  const metadataPayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "repo search",
      releaseName: "metadata cache",
    }),
  ]);
  metadataPayload.generatedAt = generatedAt;
  metadataPayload.cache = { ...metadataPayload.cache!, generatedAt };
  const releasePayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "v1.2.3",
      releaseName: "hydrated release cache",
    }),
  ]);
  releasePayload.generatedAt = generatedAt;
  releasePayload.cache = { ...releasePayload.cache!, generatedAt };
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    ASSETS: {
      fetch: async () =>
        new Response(
          '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
          { headers: { "content-type": "text/html" } },
        ),
    },
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
      [metadataKey]: JSON.stringify(metadataPayload),
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const requestHeaders = { cookie: `rd_session=${authCookie}` };

  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(apiResponse.status, 200);
  const apiPayload = (await apiResponse.json()) as DashboardPayload;
  assert.equal(apiPayload.projects[0]?.releaseName, "hydrated release cache");

  const pageResponse = await worker.fetch(
    new Request("https://release.bar/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /hydrated release cache/);
  assert.doesNotMatch(html, /metadata cache/);
});

test("worker embeds cached crawler dashboard shells without discovering app installs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  let installationListCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([]);
    }
    throw new Error(`crawler shell should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/owner", "Googlebot/2.1", null),
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
          [key]: JSON.stringify(payload),
        }),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );

    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="releasebar-initial-data"/);
    assert.match(html, /owner\\u002frepo|owner\/repo/);
    assert.equal(installationListCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached language-filtered discover data in the app shell", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&hotLang=TypeScript"),
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
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /typedbar/);
  assert.doesNotMatch(html, /allbar/);
});

test("worker preserves partial discover state in embedded app shell data", async () => {
  const payload = testDashboard("all", [
    testProject({
      owner: "acme",
      name: "placeholder",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 0, limit: 1, done: false },
  };
  const response = await worker.fetch(
    new Request("https://release.bar/"),
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
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"state":"partial"/);
  assert.match(html, /"done":false/);
});

test("worker does not treat view language filters as discover cache selectors", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&lang=TypeScript"),
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
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /allbar/);
  assert.doesNotMatch(html, /typedbar/);
});

test("worker embeds cached public repository detail data in the app shell", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({ owner: "acme", name: "releasebar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const response = await worker.fetch(
    new Request("https://release.bar/acme/releasebar"),
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
        "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"repo"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for acme\/releasebar"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/acme%2Freleasebar\.png"/,
  );
});

test("worker social cards include owner avatars and repository release metrics", async () => {
  const generatedAt = new Date().toISOString();
  const repoPayload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      description: "Release freshness for maintainers",
      version: "v2.0.0",
      commitsSinceRelease: 42,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "repo-detail:v4:acme/releasebar": JSON.stringify(repoPayload),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && ["/acme.png", "/openclaw.png"].includes(url.pathname)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };

  try {
    const repoResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.svg"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoResponse.status, 200);
    const repoSvg = await repoResponse.text();
    assert.match(repoSvg, /acme\/releasebar/);
    assert.match(repoSvg, /v2\.0\.0 · 42 commits since release/);
    assert.match(repoSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(repoSvg, /https:\/\/github\.com\/acme\.png\?size=240/);

    const ownerResponse = await worker.fetch(
      new Request("https://release.bar/og/openclaw.svg"),
      env,
      { waitUntil: () => undefined },
    );
    const ownerSvg = await ownerResponse.text();
    assert.match(ownerSvg, /@openclaw/);
    assert.match(ownerSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(ownerSvg, /https:\/\/github\.com\/openclaw\.png\?size=240/);

    const pngAssetPaths: string[] = [];
    const pngResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.png"),
      {
        ...env,
        ASSETS: {
          fetch: (request: Request) => socialRenderAsset(request, pngAssetPaths),
        },
      },
      { waitUntil: () => undefined },
    );
    assert.equal(pngResponse.status, 200);
    assert.equal(pngResponse.headers.get("content-type"), "image/png");
    const pngBytes = new Uint8Array(await pngResponse.arrayBuffer());
    assert.deepEqual(Array.from(pngBytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(pngBytes.byteLength > 1_000);
    assert.deepEqual(pngAssetPaths, [
      "/resvg.wasm",
      "/jetbrains-mono-latin-400-normal.woff2",
      "/jetbrains-mono-latin-700-normal.woff2",
    ]);
    assert.notEqual(pngAssetPaths[0], "/og-card.png");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const coldStore = kvStore();
  const coldCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/cold.png") {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/png" },
      });
    }
    coldCalls.push(url.pathname);
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
    if (url.pathname === "/repos/cold/repo") {
      return Response.json({
        owner: { login: "cold" },
        name: "repo",
        full_name: "cold/repo",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/cold/repo",
        description: "Cold social repository",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/repos/cold/repo/releases") {
      return Response.json([
        {
          tag_name: "v3.0.0",
          name: "v3",
          html_url: "https://github.com/cold/repo/releases/tag/v3.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-16T12:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/repos/cold/repo/compare/v3.0.0...main") {
      return Response.json({
        total_commits: 9,
        html_url: "https://github.com/cold/repo/compare/v3.0.0...main",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/og/cold%2Frepo.svg"),
      { DASHBOARD_CACHE: coldStore, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const coldSvg = await coldResponse.text();
    assert.match(coldSvg, /v3\.0\.0 · 9 commits since release/);
    assert.match(coldSvg, /data:image\/png;base64,BAUG/);
    assert.deepEqual(coldCalls, [
      "/repos/cold/repo",
      "/repos/cold/repo/releases",
      "/repos/cold/repo/compare/v3.0.0...main",
    ]);
    assert.notEqual(await coldStore.get("social-repo:v3:cold/repo"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stalePayload: RepoDetailPayload = {
    ...repoPayload,
    fullName: "stale/repo",
    generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    project: testProject({
      owner: "stale",
      name: "repo",
      version: "v9.9.9",
      commitsSinceRelease: 7,
    }),
  };
  const queued: Promise<unknown>[] = [];
  let backgroundCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/stale.png") {
      return new Response("not an image", { headers: { "content-type": "text/plain" } });
    }
    backgroundCalls += 1;
    throw new Error("queued refresh only");
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/og/stale%2Frepo.svg"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:stale/repo": JSON.stringify(stalePayload),
        }),
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    const staleSvg = await staleResponse.text();
    assert.match(staleSvg, /v9\.9\.9 · 7 commits since release/);
    assert.match(staleSvg, />SR<\/text>/);
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    assert.equal(backgroundCalls > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cached GitHub discovery dashboards from repository search", async () => {
  const originalFetch = globalThis.fetch;
  const searchItems = Array.from({ length: 13 }, (_, index) => {
    const name = index === 0 ? "releasebar" : `releasebar-${index + 1}`;
    return {
      name,
      full_name: `acme/${name}`,
      private: false,
      fork: false,
      archived: false,
      html_url: `https://github.com/acme/${name}`,
      description: "Release dashboard",
      default_branch: "main",
      language: "TypeScript",
      topics: ["releases", "dashboard"],
      stargazers_count: 1200 - index,
      forks_count: 42,
      open_issues_count: 7,
      pushed_at: "2026-05-16T12:00:00Z",
      updated_at: "2026-05-16T12:00:00Z",
      owner: { login: "acme" },
    };
  });
  let searchCalls = 0;
  const hydratedPaths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      searchCalls += 1;
      assert.match(url.searchParams.get("q") ?? "", /language:"TypeScript"/);
      assert.match(url.searchParams.get("q") ?? "", /pushed:>=/);
      assert.equal(url.searchParams.get("sort"), "stars");
      assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
      return Response.json(
        {
          total_count: searchItems.length,
          incomplete_results: false,
          items: searchItems,
        },
        {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1770000000",
            "x-ratelimit-resource": "search",
          },
        },
      );
    }
    hydratedPaths.push(url.pathname);
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/releases$/)) {
      if (url.pathname === "/repos/acme/releasebar-13/releases") {
        return Response.json([]);
      }
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          published_at: "2026-05-15T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const first = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = (await first.json()) as DashboardPayload;
    assert.equal(body.title, "GitHub Hot");
    assert.equal(body.projects[0]?.fullName, "acme/releasebar");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.deepEqual(body.projects[0]?.topics, ["releases", "dashboard"]);
    assert.equal(body.projects[0]?.openIssues, 7);
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.equal(body.cache?.progress?.limit, searchItems.length);
    assert.equal(body.cache?.quota?.remaining, 4999);
    assert.match(body.cache?.message ?? "", /repository search/);

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(second.status, 200);
    const firstBatch = (await second.json()) as DashboardPayload;
    assert.equal(firstBatch.cache?.state, "partial");
    assert.equal(firstBatch.cache?.progress?.done, false);
    assert.equal(firstBatch.cache?.progress?.scanned, 8);
    assert.equal(
      firstBatch.projects.filter((project) => project.version === "repo search").length,
      5,
    );

    await Promise.all(waitUntil.splice(0));

    const third = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(third.status, 200);
    const hydrated = (await third.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.cache?.progress?.done, true);
    assert.equal(hydrated.cache?.progress?.scanned, searchItems.length);
    assert.equal(
      hydrated.projects.filter((project) => project.version === "repo search").length,
      0,
    );
    assert.equal(hydrated.projects[0]?.version, "v1.2.3");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, null);
    assert.equal(hydrated.projects[0]?.openPullRequests, 0);
    assert.equal(hydrated.projects[12]?.version, "unreleased");
    assert.equal(hydrated.projects[12]?.releaseDate, null);
    assert.equal(searchCalls, 1);
    assert.equal(hydratedPaths.length, searchItems.length);
    assert.equal(
      hydratedPaths.every((path) => /^\/repos\/acme\/[^/]+\/releases$/.test(path)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not rehydrate completed GitHub discovery cache", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date().toISOString(),
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: new Date().toISOString(),
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async () => {
    throw new Error("discovery cache should not fetch");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale discovery caches to crawlers without searching GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const waits: Array<Promise<unknown>> = [];
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: "2026-05-15T12:00:00Z",
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: "2026-05-15T12:00:00Z",
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh discovery ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/_discover?period=week", "SemrushBot/7~bl", null),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.cache?.message, "showing cached discovery results");
    assert.equal(waits.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

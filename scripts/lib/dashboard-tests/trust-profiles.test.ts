import assert from "node:assert/strict";
import test from "node:test";
import type { TrustProfilePayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore } from "../dashboard-test-harness.js";

test("worker builds bounded trust profiles for people pages", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "principal/trust-map",
          html_url: "https://github.com/principal/trust-map",
          description: "Trust signals",
          language: "TypeScript",
          stargazers_count: 10,
          forks_count: 2,
          fork: false,
          archived: false,
          topics: ["trust", "developer-tools"],
          pushed_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
    assert.equal(body.login, "principal");
    assert.equal(body.type, "user");
    assert.equal(body.profileKind, "user_trust");
    assert.equal(body.scoreLabel, "trust score");
    assert.equal(body.tier, "high");
    assert.ok((body.accountAgeDays ?? 0) > 3650);
    assert.ok(body.dimensions.trust >= 80);
    assert.equal(body.stats.totalStars, 130);
    assert.equal(body.stats.activeRepositories, 2);
    assert.equal(body.stats.languages[0]?.name, "typescript");
    assert.equal(body.stats.topics[0]?.name, "developer-tools");
    assert.equal(body.orgs[0]?.login, "github");
    assert.equal(body.topRepositories[0]?.fullName, "principal/release-tools");
    assert.equal(body.factors.find((factor) => factor.key === "age")?.label, "account age");
    assert.match(
      body.factors.find((factor) => factor.key === "builder")?.detail ?? "",
      /recent repos scanned/,
    );
    assert.match(body.reasons.join(" "), /notable org: github/);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker preserves bot tier for typed trust profiles", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/crawlerbot") {
      return Response.json({
        login: "crawlerbot",
        avatar_url: "https://avatars.githubusercontent.com/u/99",
        html_url: "https://github.com/crawlerbot",
        type: "Bot",
        name: null,
        company: "GitHub",
        bio: "Automation",
        location: "CI",
        blog: null,
        twitter_username: null,
        followers: 5000,
        following: 0,
        public_repos: 80,
        public_gists: 0,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/crawlerbot/orgs") {
      return Response.json([]);
    }
    if (url.pathname === "/users/crawlerbot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/crawlerbot/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.login, "crawlerbot");
    assert.equal(body.tier, "bot");
    assert.equal(body.score, 0);
    assert.deepEqual(body.reasons, ["automation account"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered app quota for anonymous trust profiles", async () => {
  const cache = kvStore({
    "auth:installation:v1:principal": JSON.stringify({
      id: 42,
      accountLogin: "principal",
      accountType: "user",
      accountUrl: "https://github.com/principal",
      avatarUrl: "https://avatars.githubusercontent.com/u/10",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer installation-token");
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.quota?.source, "app");
    assert.equal(body.cache.quota?.account, "principal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns org signal profiles for organization accounts", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/openclaw") {
      return Response.json({
        login: "openclaw",
        avatar_url: "https://avatars.githubusercontent.com/u/20",
        html_url: "https://github.com/openclaw",
        type: "Organization",
        name: "OpenClaw",
        company: null,
        bio: "Open source agent tooling",
        location: "Internet",
        blog: "https://openclaw.dev",
        twitter_username: null,
        followers: 1200,
        following: 0,
        public_repos: 42,
        public_gists: 0,
        created_at: "2018-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      assert.equal(url.searchParams.get("type"), "public");
      return Response.json([
        {
          full_name: "openclaw/openclaw",
          html_url: "https://github.com/openclaw/openclaw",
          description: "Agent runtime",
          language: "TypeScript",
          stargazers_count: 900,
          forks_count: 80,
          private: false,
          visibility: "public",
          fork: false,
          archived: false,
          topics: ["agents", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "openclaw/private-signals",
          html_url: "https://github.com/openclaw/private-signals",
          description: "Should never leak",
          language: "TypeScript",
          stargazers_count: 9999,
          forks_count: 0,
          private: true,
          visibility: "private",
          fork: false,
          archived: false,
          topics: ["private"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/openclaw/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, ["/users/openclaw", "/orgs/openclaw/repos"]);
    assert.equal(body.type, "org");
    assert.equal(body.profileKind, "org_signal");
    assert.equal(body.scoreLabel, "org signal");
    assert.equal(body.stats.totalStars, 900);
    assert.deepEqual(
      body.topRepositories.map((repo) => repo.fullName),
      ["openclaw/openclaw"],
    );
    assert.equal(body.orgs.length, 0);
    assert.ok(body.reasons.includes("organization account"));
    assert.equal(
      body.factors.find((factor) => factor.key === "orgs"),
      undefined,
    );
    assert.equal(
      body.factors.find((factor) => factor.key === "builder")?.label,
      "repository footprint",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes stale trust profiles in the background", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const staleProfile: TrustProfilePayload = {
    login: "principal",
    type: "user",
    profileKind: "user_trust",
    scoreLabel: "trust score",
    avatarUrl: "https://avatars.githubusercontent.com/u/10",
    url: "https://github.com/principal",
    name: "Old Principal",
    company: null,
    bio: null,
    location: null,
    blog: null,
    twitterUsername: null,
    followers: 1,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    accountCreatedAt: "2020-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-16T12:00:00Z",
    accountAgeDays: 1000,
    score: 10,
    tier: "low",
    reasons: [],
    dimensions: { trust: 0, influence: 0, builder: 0, recency: 0, risk: 100 },
    factors: [],
    orgs: [],
    topRepositories: [],
    stats: {
      totalStars: 0,
      totalForks: 0,
      recentRepositories: 0,
      activeRepositories: 0,
      publicOrganizations: 0,
      languages: [],
      topics: [],
    },
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "bounded public GitHub profile signals",
    },
  };
  const cache = kvStore({
    "trust-profile:v4:principal": JSON.stringify(staleProfile),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "New Principal",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "refreshing trust profile");
    assert.equal(body.name, "Old Principal");
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    const refreshed = JSON.parse(
      (await cache.get("trust-profile:v4:principal")) ?? "{}",
    ) as TrustProfilePayload;
    assert.equal(refreshed.name, "New Principal");
    assert.equal(refreshed.cache.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

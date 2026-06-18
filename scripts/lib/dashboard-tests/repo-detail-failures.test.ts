import assert from "node:assert/strict";
import test from "node:test";
import type { RepoDetailPayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore } from "../dashboard-test-harness.js";

test("worker rejects private repository detail payloads", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/private") {
      return Response.json({
        owner: { login: "acme" },
        name: "private",
        full_name: "acme/private",
        private: true,
        html_url: "https://github.com/acme/private",
        description: null,
        default_branch: "main",
        language: null,
        topics: [],
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/private"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const body = (await response.json()) as { error?: string };
    assert.equal(response.status, 502);
    assert.match(body.error ?? "", /private repositories are not visible/);
    assert.equal(
      await cache.get(
        `repo-detail:aux:v2:${encodeURIComponent("acme/private")}:repository:${encodeURIComponent("/repos/acme/private")}`,
      ),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when pull request count fails", async () => {
  const originalFetch = globalThis.fetch;
  let failPulls = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/retrybar") {
      return Response.json({
        owner: { login: "acme" },
        name: "retrybar",
        full_name: "acme/retrybar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/retrybar",
        description: "Retry dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/retrybar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/retrybar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/retrybar/pulls") {
      if (failPulls) {
        return Response.json(
          { message: "rate limit exceeded", documentation_url: "https://docs.github.com/rest" },
          { status: 403, headers: { "retry-after": "60" } },
        );
      }
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/2/pulls?state=open&per_page=1&page=3>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/retrybar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/retrybar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/stats/code_frequency") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const failed = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(failed.status, 429);

    failPulls = false;
    await Promise.all([
      env.DASHBOARD_CACHE.delete("github:budget:v1:shared:_"),
      env.DASHBOARD_CACHE.delete("github:budget:v1:shared:core"),
    ]);
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.openPullRequests, 3);
    assert.equal(body.project.openIssues, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns 404 for missing repository detail pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/missing") {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/missing"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 404);
    assert.match(await response.text(), /GitHub API 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores optional repository detail permission gaps", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/limitedbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "limitedbar",
        full_name: "acme/limitedbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/limitedbar",
        description: "Limited dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/limitedbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/limitedbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/limitedbar/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/commits/1234567890/check-runs") {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (path === "/repos/acme/limitedbar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/stats/code_frequency") {
      return Response.json(
        { message: "repository must have fewer than 10000 commits" },
        { status: 422 },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/limitedbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.ciState, "unknown");
    assert.equal(body.cache.state, "fresh");
    assert.equal(body.stats?.codeFrequency.state, "unavailable");
    assert.match(body.stats?.codeFrequency.message ?? "", /fewer than 10000 commits/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker backs off repository stats per repo after one warming response", async () => {
  const originalFetch = globalThis.fetch;
  let codeFrequencyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/warmstats") {
      return Response.json({
        owner: { login: "acme" },
        name: "warmstats",
        full_name: "acme/warmstats",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/warmstats",
        description: "Stats warming",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/warmstats/releases") return Response.json([]);
    if (path === "/repos/acme/warmstats/contributors") return Response.json([]);
    if (path === "/repos/acme/warmstats/languages") return Response.json({});
    if (path === "/repos/acme/warmstats/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/warmstats/pulls") return Response.json([]);
    if (path === "/repos/acme/warmstats/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/warmstats/stats/commit_activity") {
      return new Response(null, { status: 202 });
    }
    if (path === "/repos/acme/warmstats/stats/code_frequency") {
      codeFrequencyCalls += 1;
      return Response.json([]);
    }
    if (path === "/search/issues") {
      return Response.json({ total_count: 0 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmstats"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "warming");
    assert.equal(body.stats?.commitActivity.state, "warming");
    assert.equal(body.stats?.codeFrequency.state, "warming");
    assert.equal(codeFrequencyCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when optional calls are rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/slowbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "slowbar",
        full_name: "acme/slowbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/slowbar",
        description: "Slow dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/slowbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/slowbar/contributors") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "retry-after": "60" } },
      );
    }
    if (path === "/repos/acme/slowbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/slowbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/slowbar/pulls") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/slowbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail when work trend GraphQL is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/trendbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "trendbar",
        full_name: "acme/trendbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/trendbar",
        description: "Trend dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/trendbar/releases") return Response.json([]);
    if (path === "/repos/acme/trendbar/contributors") return Response.json([]);
    if (path === "/repos/acme/trendbar/languages") return Response.json({});
    if (path === "/repos/acme/trendbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/trendbar/pulls") return Response.json([]);
    if (path === "/repos/acme/trendbar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/trendbar/stats/commit_activity") return Response.json([]);
    if (path === "/repos/acme/trendbar/stats/code_frequency") return Response.json([]);
    if (path === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/trendbar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.workTrend, null);
    assert.notEqual(await cache.get("repo-detail:v4:acme/trendbar"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reuses repository detail auxiliary caches across rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/cachebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "cachebar",
        full_name: "acme/cachebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/cachebar",
        description: "Cached detail dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/cachebar/releases") {
      count("releases");
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: "v1.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T12:00:00Z",
          html_url: "https://github.com/acme/cachebar/releases/tag/v1.0.0",
        },
      ]);
    }
    if (path === "/repos/acme/cachebar/commits/main") {
      count("latest_commit");
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/cachebar/pulls") {
      count("open_pulls");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/compare/v1.0.0...main") {
      count("compare");
      return Response.json({
        html_url: "https://github.com/acme/cachebar/compare/v1.0.0...main",
        ahead_by: 0,
        total_commits: 0,
        commits: [],
      });
    }
    if (path === "/repos/acme/cachebar/commits/1234567890/check-runs") {
      count("check_runs");
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/cachebar/contributors") {
      count("contributors");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/languages") {
      count("languages");
      return Response.json({ TypeScript: 100 });
    }
    if (path === "/repos/acme/cachebar/stats/commit_activity") {
      count("commit_activity");
      return new Response("", { status: 202 });
    }
    if (path === "/repos/acme/cachebar/stats/code_frequency") {
      count("code_frequency");
      return new Response("", { status: 202 });
    }
    if (path === "/graphql") {
      const payload = JSON.parse(String(init?.body)) as { query?: string };
      assert.match(payload.query ?? "", /ReleaseBarRepoWorkTrend/);
      count("work_trend");
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 1 },
          issuesClosed30d: { issueCount: 1 },
          pullRequestsOpened30d: { issueCount: 1 },
          pullRequestsClosed30d: { issueCount: 1 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const request = new Request("https://release.bar/api/repos/acme/cachebar");
    const first = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(first.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal(calls.get("work_trend"), 1);

    await cache.delete("repo-detail:v4:acme/cachebar");

    const second = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(second.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal(calls.get("work_trend"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

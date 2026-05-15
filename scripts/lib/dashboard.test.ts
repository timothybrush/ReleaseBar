import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboard,
  dashboardCacheKey,
  filterRepo,
  freshness,
  normalizeBuildOptions,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard.js";
import {
  dashboardRoute,
  optionsFromSearch,
  ownerFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../src/routing.js";
import worker from "../../worker/index.js";

test("owner route parsing keeps root static and owners API-backed", () => {
  assert.equal(ownerFromPath("/"), null);
  assert.equal(ownerFromPath("/index.html"), null);
  assert.equal(ownerFromPath("/OpenClaw"), "OpenClaw");
  assert.equal(ownerFromPath("/bad_owner"), null);

  assert.deepEqual(dashboardRoute("/", "").isDefault, true);
  assert.equal(dashboardRoute("/openclaw", "").apiPath, `${workerApiOrigin}/api/openclaw`);
  assert.equal(
    dashboardRoute("/openclaw", "?forks=true&archived=true&unreleased=true").apiPath,
    `${workerApiOrigin}/api/openclaw?forks=true&archived=true&unreleased=true`,
  );
  assert.equal(
    dashboardRoute("/openclaw", "?owners=steipete,openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/openclaw?owners=steipete&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/dashboard?owners=openclaw&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw").fallbackApiPath,
    `${workersDevApiOrigin}/api/dashboard?owners=openclaw`,
  );
});

test("worker rejects oversized custom source requests", async () => {
  const owners = Array.from({ length: 9 }, (_, index) => `owner-${index}`).join(",");
  const response = await worker.fetch(
    new Request(`https://releasedeck.dev/api/dashboard?owners=${owners}`),
    {},
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /too many custom sources/);
});

test("query options are explicit booleans", () => {
  assert.deepEqual(optionsFromSearch("?forks=true&archived=false&unreleased=true"), {
    includeForks: true,
    includeArchived: false,
    includeUnreleased: true,
  });
});

test("build option normalization preserves config includeUnreleased", () => {
  const options = normalizeBuildOptions({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
  });

  assert.equal(options.includeUnreleased, true);
  assert.equal(
    normalizeBuildOptions({ ...options, includeUnreleased: undefined }).includeUnreleased,
    false,
  );
});

test("cache keys include owner, schema, and visibility flags", () => {
  assert.equal(
    dashboardCacheKey({
      owner: "@OpenClaw",
      includeForks: true,
      includeArchived: false,
      includeUnreleased: true,
      schemaVersion: 4,
    }),
    "dashboard:v4:openclaw:forks-noarchived-unreleased",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 4,
    }),
    "dashboard:v4:openclaw:noforks-noarchived-released:sources-2dgec2fqc87xi",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: Array.from({ length: 50 }, (_, index) => `owner-${index}`),
      repos: Array.from({ length: 50 }, (_, index) => `owner-${index}/repo-${index}`),
    }).length < 512,
    true,
  );
});

test("owner slugs match public GitHub login rules", () => {
  assert.equal(validOwnerSlug("steipete"), true);
  assert.equal(validOwnerSlug("openclaw"), true);
  assert.equal(validOwnerSlug("-bad"), false);
  assert.equal(validOwnerSlug("bad-"), false);
  assert.equal(validOwnerSlug("bad_owner"), false);
  assert.equal(validRepoSlug("steipete/oracle"), true);
  assert.equal(validRepoSlug("bad_owner/oracle"), false);
});

test("repo filtering respects forks, archived repos, private repos, and excludes", () => {
  const repo = {
    full_name: "owner/repo",
    fork: false,
    archived: false,
    private: false,
  };
  assert.equal(filterRepo(repo, { includeForks: false, includeArchived: false }), true);
  assert.equal(
    filterRepo({ ...repo, fork: true }, { includeForks: false, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, archived: true }, { includeForks: true, includeArchived: false }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, private: true }, { includeForks: true, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo(repo, {
      includeForks: true,
      includeArchived: true,
      excludeRepos: ["owner/repo"],
    }),
    false,
  );
});

test("freshness buckets remain compatible with existing dashboard semantics", () => {
  const project = { commitsSinceRelease: null };
  assert.equal(freshness(project), "hot");
  assert.equal(freshness({ ...project, commitsSinceRelease: 0 }), "fresh");
  assert.equal(freshness({ ...project, commitsSinceRelease: 5 }), "warm");
  assert.equal(freshness({ ...project, commitsSinceRelease: 25 }), "busy");
  assert.equal(freshness({ ...project, commitsSinceRelease: 26 }), "hot");
});

test("dashboard build skips empty unreleased repositories without failing", async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "empty",
          full_name: "owner/empty",
          description: null,
          html_url: "https://github.com/owner/empty",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        },
      ]);
    }
    if (path === "/repos/owner/empty/releases") {
      return Response.json([]);
    }
    if (path === "/repos/owner/empty/commits/main") {
      return new Response("empty repository", { status: 409 });
    }
    throw new Error(`unexpected ${path}`);
  };

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    fetch: fetcher,
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build can add explicit public repositories without an owner scan", async () => {
  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/repo"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/other/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path === "/repos/other/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/other/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/other/repo/compare/v1.0.0...main",
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return Response.json([]);
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.fullName, "other/repo");
});

test("dashboard cache cap only marks omitted repos as capped", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const build = (repos: unknown[]) =>
    buildDashboard({
      title: "ReleaseDeck",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 2,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json(repos);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
          return Response.json([
            {
              tag_name: "v1.0.0",
              name: null,
              html_url: "https://github.com/owner/repo/releases/v1.0.0",
              draft: false,
              published_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path.includes("/compare/")) {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare",
          });
        }
        if (path.endsWith("/pulls")) {
          return Response.json([]);
        }
        if (path.endsWith("/check-runs")) {
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build([repo("one"), repo("two")])).cache?.capped, false);
  assert.equal((await build([repo("one"), repo("two"), repo("three")])).cache?.capped, true);
});

test("explicit repositories survive capped owner scan trimming", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["owner/three"],
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      if (path === "/repos/owner/three") {
        return Response.json(repo("three"));
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/three"),
    true,
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies after visibility filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    repoLimit: 2,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("fork", { fork: true }),
          repo("archived", { archived: true }),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies per owner for custom dashboards", async () => {
  const repo = (owner: string, name: string) => ({
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    description: null,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [
      { type: "user", login: "owner" },
      { type: "org", login: "other" },
    ],
    includeForks: false,
    includeArchived: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("owner", "one"), repo("owner", "two"), repo("owner", "three")]);
      }
      if (path === "/orgs/other/repos") {
        return Response.json([
          repo("other", "alpha"),
          repo("other", "beta"),
          repo("other", "gamma"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const fullNames = payload.projects.map((project) => project.fullName);
  assert.equal(payload.totals.repos, 4);
  assert.equal(fullNames.includes("owner/one"), true);
  assert.equal(fullNames.includes("owner/two"), true);
  assert.equal(fullNames.includes("owner/three"), false);
  assert.equal(fullNames.includes("other/alpha"), true);
  assert.equal(fullNames.includes("other/beta"), true);
  assert.equal(fullNames.includes("other/gamma"), false);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies after release eligibility", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const released = new Set(["one", "two", "three"]);

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("empty-a"),
          repo("empty-b"),
          repo("empty-c"),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      const name = path.split("/")[3];
      if (path.endsWith("/releases")) {
        return Response.json(
          released.has(name)
            ? [
                {
                  tag_name: "v1.0.0",
                  name: null,
                  html_url: "https://github.com/owner/repo/releases/v1.0.0",
                  draft: false,
                  published_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap keeps paginating until eligible repos survive filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseDeck",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    repoLimit: 1,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      const page = parsed.searchParams.get("page");
      if (path === "/users/owner/repos" && page === "1") {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`fork-${index}`, { fork: true })),
        );
      }
      if (path === "/users/owner/repos" && page === "2") {
        return Response.json([repo("one"), repo("two")]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one"],
  );
  assert.equal(payload.cache?.capped, true);
});

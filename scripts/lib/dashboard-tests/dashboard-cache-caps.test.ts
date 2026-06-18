import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../dashboard.js";
import { kvStore } from "../dashboard-test-harness.js";

test("dashboard cached hydration keeps fresh owner issue and PR totals", async () => {
  const cache = kvStore();
  let openIssues = 1;
  let openPullRequests = 1;
  const repoNode = () => ({
    owner: { login: "owner", __typename: "User" },
    name: "one",
    nameWithOwner: "owner/one",
    description: null,
    url: "https://github.com/owner/one",
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: openIssues },
    pullRequests: { totalCount: openPullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    releases: { nodes: [] },
  });
  const fetch: typeof globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode()],
            },
          },
        },
      });
    }
    if (path === "/repos/owner/one/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-01-02T00:00:00Z" } },
      });
    }
    if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const options = {
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user" as const, login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    repoScanLimit: 1,
    repoScanTarget: 1,
    token: "token",
    projectCache: cache,
    fetch,
  };

  await buildDashboard(options);
  openIssues = 8;
  openPullRequests = 5;
  const payload = await buildDashboard(options);

  assert.equal(payload.projects[0]?.openIssues, 8);
  assert.equal(payload.projects[0]?.openPullRequests, 5);
});

test("dashboard build reuses cached repo fragments when metadata is unchanged", async () => {
  const backingCache = kvStore();
  const writtenKeys: string[] = [];
  const cache = {
    ...backingCache,
    async put(key: string, value: string) {
      writtenKeys.push(key);
      await backingCache.put(key, value);
    },
  };
  let fanoutCalls = 0;
  const build = () =>
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 1,
      token: "token",
      projectCache: cache,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/graphql") {
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
                      description: null,
                      url: "https://github.com/owner/repo",
                      defaultBranchRef: { name: "main" },
                      primaryLanguage: null,
                      stargazerCount: 1,
                      forkCount: 0,
                      issues: { totalCount: 0 },
                      pullRequests: { totalCount: 0 },
                      isArchived: false,
                      isFork: false,
                      isPrivate: false,
                      pushedAt: "2026-01-03T00:00:00Z",
                      updatedAt: "2026-01-03T00:00:00Z",
                      releases: {
                        nodes: [
                          {
                            tagName: "v1.0.0",
                            name: null,
                            url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                            isDraft: false,
                            publishedAt: "2026-01-01T00:00:00Z",
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
        if (path === "/repos/owner/repo/commits/main") {
          fanoutCalls += 1;
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-03T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          fanoutCalls += 1;
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          fanoutCalls += 1;
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build()).totals.repos, 1);
  assert.equal((await build()).totals.repos, 1);
  assert.equal(fanoutCalls, 3);
  assert.equal(
    writtenKeys.some((key) => key.startsWith("repo:v2:owner/repo:")),
    true,
  );
});

test("dashboard build ignores explicit private repositories", async () => {
  let releaseFetched = false;
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/private"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/private") {
        return Response.json({
          owner: { login: "other" },
          name: "private",
          full_name: "other/private",
          description: null,
          html_url: "https://github.com/other/private",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: true,
        });
      }
      if (path === "/repos/other/private/releases") {
        releaseFetched = true;
        return Response.json([]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
  assert.equal(releaseFetched, false);
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
      title: "ReleaseBar",
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
    title: "ReleaseBar",
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
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
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
    title: "ReleaseBar",
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

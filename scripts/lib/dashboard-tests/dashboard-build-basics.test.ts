import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboard,
  dashboardCacheKey,
  filterRepo,
  freshness,
  GitHubRateLimitError,
  normalizeBuildOptions,
  resolveOwnerType,
  validOwnerSlug,
  validRepoSlug,
} from "../dashboard.js";
import { optionsFromSearch } from "../../../src/routing.js";

test("query options are explicit booleans", () => {
  assert.deepEqual(optionsFromSearch("?forks=true&archived=false&unreleased=true"), {
    includeForks: true,
    includeArchived: false,
    includeUnreleased: true,
  });
  assert.deepEqual(optionsFromSearch("?unreleased=false"), {
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
  });
  assert.equal(optionsFromSearch("").includeUnreleased, true);
});

test("build option normalization preserves config includeUnreleased", () => {
  const options = normalizeBuildOptions({
    title: "ReleaseBar",
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
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:forks-noarchived-unreleased-release",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:noforks-noarchived-released-release:sources-2dgec2fqc87xi",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      includeReleaseData: false,
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:noforks-noarchived-released-metadata",
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

test("owner resolution keeps GitHub profile identity", async () => {
  const owner = await resolveOwnerType("OpenClaw", {
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/users/openclaw");
      return Response.json({
        login: "OpenClaw",
        type: "Organization",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
        html_url: "https://github.com/openclaw",
      });
    },
  });

  assert.deepEqual(owner, {
    type: "org",
    login: "OpenClaw",
    avatarUrl: "https://avatars.githubusercontent.com/u/123",
    url: "https://github.com/openclaw",
  });
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
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    fetch: fetcher,
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build partitions GitHub App quota by owner", async () => {
  const authorizations = new Map<string, string | null>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/graphql");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      variables?: { login?: string };
    };
    const login = body.variables?.login ?? "";
    authorizations.set(login, new Headers(init?.headers).get("authorization"));
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
          "x-ratelimit-resource": "graphql",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": login === "alpha" ? "4200" : "3900",
        },
      },
    );
  };

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [
      { type: "org", login: "alpha" },
      { type: "org", login: "beta" },
    ],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    fetch: fetcher,
    token: "shared-token",
    quotaSource: "shared",
    ownerCredentials: {
      alpha: {
        token: "alpha-token",
        quotaSource: "app",
        quotaAccount: "alpha",
      },
      beta: {
        token: "beta-token",
        quotaSource: "app",
        quotaAccount: "beta",
      },
    },
  });

  assert.deepEqual(Object.fromEntries(authorizations), {
    alpha: "Bearer alpha-token",
    beta: "Bearer beta-token",
  });
  assert.equal(payload.cache?.quota?.source, "app");
  assert.equal(payload.cache?.quota?.account, null);
  assert.equal(payload.cache?.quota?.remaining, 3900);
});

test("dashboard build keeps empty included repositories without check-run calls", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(path);
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
        return Response.json(
          { message: "Git Repository is empty.", status: "409" },
          { status: 409 },
        );
      }
      if (path === "/repos/owner/empty/pulls") {
        return Response.json([]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.version, "unreleased");
  assert.equal(payload.projects[0]?.ciState, "unknown");
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
});

test("dashboard build treats empty successful GitHub JSON as no data", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeRepos: ["other/repo"],
    includeForks: false,
    includeArchived: false,
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
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
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
        return new Response("", { status: 200 });
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openPullRequests, 0);
});

test("dashboard build falls back when GraphQL returns an empty success body", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") return new Response("", { status: 200 });
      if (path === "/users/owner/repos") return Response.json([]);
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build treats ignored 403 check-run rate limits as quota errors", async () => {
  await assert.rejects(
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json([
            {
              owner: { login: "owner" },
              name: "repo",
              full_name: "owner/repo",
              description: null,
              html_url: "https://github.com/owner/repo",
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
        if (path === "/repos/owner/repo/releases") {
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
        if (path === "/repos/owner/repo/commits/main") {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/pulls") {
          return Response.json([]);
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          return Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
              },
            },
          );
        }
        throw new Error(`unexpected ${path}`);
      },
    }),
    GitHubRateLimitError,
  );
});

test("dashboard build can add explicit public repositories without an owner scan", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
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

test("dashboard metadata splits explicit repository issue and PR counts", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    includeRepos: ["other/repo"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
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
          open_issues_count: 7,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return Response.json([{}], {
          headers: {
            link: '<https://api.github.com/repos/other/repo/pulls?state=open&per_page=1&page=3>; rel="last"',
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.deepEqual(requested, ["/repos/other/repo", "/repos/other/repo/pulls"]);
});

test("dashboard metadata splits authenticated REST owner issue and PR counts", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 1,
    repoScanLimit: 0,
    repoScanTarget: 1,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return new Response(null, { status: 500 });
      }
      if (path === "/users/owner/repos") {
        return Response.json([
          {
            owner: { login: "owner" },
            name: "repo",
            full_name: "owner/repo",
            description: null,
            html_url: "https://github.com/owner/repo",
            default_branch: "main",
            language: null,
            stargazers_count: 1,
            forks_count: 0,
            open_issues_count: 7,
            archived: false,
            pushed_at: null,
            updated_at: null,
            fork: false,
            private: false,
          },
        ]);
      }
      if (path === "/repos/owner/repo/pulls") {
        return Response.json([{}], {
          headers: {
            link: '<https://api.github.com/repos/owner/repo/pulls?state=open&per_page=1&page=3>; rel="last"',
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.cache?.capped, false);
  assert.deepEqual(requested, ["/graphql", "/users/owner/repos", "/repos/owner/repo/pulls"]);
});

test("dashboard REST hydration only splits counts for the hydrated batch", async () => {
  const requested: string[] = [];
  const repos = ["one", "two", "three"].map((name) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 7,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  }));
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 3,
    repoScanLimit: 1,
    repoScanTarget: 3,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return new Response(null, { status: 500 });
      }
      if (path === "/users/owner/repos") {
        return Response.json(repos);
      }
      if (path === "/repos/owner/one/releases") {
        return Response.json([]);
      }
      if (path === "/repos/owner/one/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/one/pulls") {
        return Response.json([{}]);
      }
      if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    requested.filter((path) => path.endsWith("/pulls")),
    ["/repos/owner/one/pulls"],
  );
  assert.equal(payload.projects.find((project) => project.name === "one")?.openIssues, 6);
  assert.equal(payload.projects.find((project) => project.name === "one")?.openPullRequests, 1);
  assert.equal(payload.projects.find((project) => project.name === "two")?.openIssues, null);
  assert.equal(
    payload.projects.find((project) => project.name === "three")?.openPullRequests,
    null,
  );
});

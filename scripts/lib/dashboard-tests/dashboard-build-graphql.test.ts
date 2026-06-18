import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../dashboard.js";
import { testProject } from "../dashboard-test-harness.js";

test("dashboard build uses GraphQL owner metadata when token is available", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 2,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                          {
                            __typename: "CheckRun",
                            name: "lint",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/2",
                            completedAt: "2026-01-03T00:11:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
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
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
                    isArchived: false,
                    isFork: false,
                    isPrivate: false,
                    pushedAt: "2026-01-03T00:00:00Z",
                    updatedAt: "2026-01-03T00:00:00Z",
                    releases: {
                      nodes: [
                        {
                          tagName: "v2.0.0-alpha.1",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v2.0.0-alpha.1",
                          isDraft: false,
                          publishedAt: "2026-01-04T00:00:00Z",
                        },
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
      if (path === "/repos/owner/repo/compare/v2.0.0-alpha.1...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v2.0.0-alpha.1...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openIssues, 7);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.projects[0]?.version, "v2.0.0-alpha.1");
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "2/2 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/releases")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/pulls")),
    false,
  );
});

test("dashboard released-only build uses GraphQL detail hydration for CI", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
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
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
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
      if (path === "/repos/owner/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.version, "v1.0.0");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "1/1 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
});

test("dashboard build emits owner metadata before release hydration", async () => {
  const progress: Awaited<ReturnType<typeof buildDashboard>>[] = [];
  const requested: string[] = [];
  const repoNode = (name: string, issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name,
    nameWithOwner: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: `2026-01-0${issues}T00:00:00Z`,
    updatedAt: `2026-01-0${issues}T00:00:00Z`,
    releases: { nodes: [] },
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 3,
    repoScanLimit: 1,
    repoScanTarget: 3,
    hydrateSort: "prs",
    hydrateDirection: "desc",
    token: "token",
    previousReleasesUpdatedAt: "2026-01-01T00:00:00Z",
    previousCiUpdatedAt: "2026-01-02T00:00:00Z",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [repoNode("three", 3, 0), repoNode("one", 5, 2), repoNode("two", 4, 1)],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/one/commits/main") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-04T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (partial) => {
      progress.push(partial);
    },
  });

  assert.equal(progress[0]?.projects.length, 3);
  assert.deepEqual(
    progress[0]?.projects.map((project) => [
      project.name,
      project.openIssues,
      project.openPullRequests,
      project.version,
    ]),
    [
      ["one", 5, 2, "repo search"],
      ["two", 4, 1, "repo search"],
      ["three", 3, 0, "repo search"],
    ],
  );
  assert.equal(progress[0]?.cache?.progress?.scanned, 0);
  assert.equal(payload.cache?.countsUpdatedAt, progress[0]?.cache?.countsUpdatedAt);
  assert.equal(progress[0]?.cache?.releasesUpdatedAt, "2026-01-01T00:00:00Z");
  assert.equal(progress[0]?.cache?.ciUpdatedAt, "2026-01-02T00:00:00Z");
  assert.equal(requested.includes("/repos/owner/one/commits/main"), true);
  assert.equal(requested.includes("/repos/owner/three/commits/main"), false);
  assert.equal(payload.cache?.state, "partial");
  assert.equal(payload.cache?.releasesUpdatedAt, "2026-01-01T00:00:00Z");
  assert.equal(payload.cache?.ciUpdatedAt, "2026-01-02T00:00:00Z");
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two", "three"],
  );
});

test("partial owner scans do not advance count freshness without current coverage", async () => {
  const previousCountsUpdatedAt = "2026-06-11T01:00:00Z";
  const initialProjects = [
    testProject({ owner: "partial-counts", name: "one", openIssues: 1, openPullRequests: 1 }),
    testProject({ owner: "partial-counts", name: "two", openIssues: 2, openPullRequests: 2 }),
  ];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "partial-counts" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 3,
    repoScanLimit: 0,
    repoScanTarget: 3,
    ownerPageLimit: 1,
    initialProjects,
    token: "token",
    previousCountsUpdatedAt,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      assert.equal(path, "/graphql");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                {
                  owner: { login: "partial-counts", __typename: "User" },
                  name: "one",
                  nameWithOwner: "partial-counts/one",
                  description: null,
                  url: "https://github.com/partial-counts/one",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: null,
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 0,
                  forkCount: 0,
                  issues: { totalCount: 9 },
                  pullRequests: { totalCount: 4 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T03:00:00Z",
                  updatedAt: "2026-06-11T03:00:00Z",
                  releases: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    },
  });

  assert.equal(payload.cache?.state, "partial");
  assert.equal(payload.projects.find((project) => project.name === "one")?.openIssues, 9);
  assert.equal(payload.projects.find((project) => project.name === "two")?.openIssues, 2);
  assert.equal(payload.cache?.countsUpdatedAt, previousCountsUpdatedAt);
});

test("multi-page count scans keep their first-request observation time", async () => {
  let page = 0;
  let secondRequestStartedAt = 0;
  const repoNode = (name: string) => ({
    owner: { login: "count-clock", __typename: "User" },
    name,
    nameWithOwner: `count-clock/${name}`,
    description: null,
    url: `https://github.com/count-clock/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: 1 },
    pullRequests: { totalCount: 0 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T03:00:00Z",
    updatedAt: "2026-06-11T03:00:00Z",
    releases: { nodes: [] },
  });
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "count-clock" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 0,
    ownerPageSize: 1,
    token: "token",
    fetch: async (url) => {
      assert.equal(new URL(String(url)).pathname, "/graphql");
      page += 1;
      if (page === 2) secondRequestStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: {
                hasNextPage: page === 1,
                endCursor: page === 1 ? "next" : null,
              },
              nodes: [repoNode(page === 1 ? "one" : "two")],
            },
          },
        },
      });
    },
  });

  assert.equal(payload.projects.length, 2);
  assert.ok(secondRequestStartedAt > 0);
  assert.ok(Date.parse(payload.cache?.countsUpdatedAt ?? "") < secondRequestStartedAt);
});

test("metadata-only released-only builds preserve count freshness without fetching", async () => {
  const previousCountsUpdatedAt = "2026-06-11T01:00:00Z";
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "released-only" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    includeReleaseData: false,
    previousCountsUpdatedAt,
    fetch: async () => {
      throw new Error("released-only metadata build should not fetch");
    },
  });

  assert.deepEqual(payload.projects, []);
  assert.equal(payload.cache?.countsUpdatedAt, previousCountsUpdatedAt);
});

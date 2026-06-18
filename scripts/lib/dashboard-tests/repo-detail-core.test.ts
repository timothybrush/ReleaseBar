import assert from "node:assert/strict";
import test from "node:test";
import type { RepoDetailPayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { githubAccessRouteRecords, kvStore } from "../dashboard-test-harness.js";

test("worker builds cached repository detail with releases and stats", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json(
        {
          owner: { login: "acme" },
          name: "releasebar",
          full_name: "acme/releasebar",
          private: false,
          fork: false,
          archived: false,
          html_url: "https://github.com/acme/releasebar",
          description: "Release dashboard",
          default_branch: "main",
          language: "TypeScript",
          topics: ["release-health"],
          stargazers_count: 1234,
          forks_count: 45,
          open_issues_count: 9,
          pushed_at: "2026-05-16T12:00:00Z",
          updated_at: "2026-05-16T12:00:00Z",
        },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "3000",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    if (path === "/repos/acme/releasebar/releases") {
      assert.equal(url.searchParams.get("per_page"), "100");
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T00:00:00Z",
        },
        {
          tag_name: "v1.2.2",
          name: "Release 1.2.2",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.2",
          draft: false,
          prerelease: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/contributors") {
      return Response.json([
        {
          login: "octo",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/octo",
          contributions: 42,
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/languages") {
      return Response.json({ TypeScript: 900, CSS: 100 });
    }
    if (path === "/repos/acme/releasebar/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/releasebar/pulls") {
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/releasebar/compare/v1.2.3...main") {
      return Response.json({
        total_commits: 6,
        html_url: "https://github.com/acme/releasebar/compare/v1.2.3...main",
      });
    }
    if (path === "/repos/acme/releasebar/commits/abcdef123456/check-runs") {
      return Response.json({
        check_runs: [
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/1",
            status: "completed",
            conclusion: "success",
            name: "CI",
            completed_at: "2026-05-16T12:30:00Z",
          },
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/2",
            status: "completed",
            conclusion: "failure",
            name: "Lint",
            completed_at: "2026-05-16T12:20:00Z",
          },
        ],
      });
    }
    if (path === "/repos/acme/releasebar/stats/commit_activity") {
      return Response.json([{ week: 1778889600, total: 7, days: [0, 1, 2, 0, 3, 1, 0] }]);
    }
    if (path === "/repos/acme/releasebar/stats/code_frequency") {
      return Response.json([[1778889600, 120, -20]]);
    }
    if (path === "/graphql") {
      const payload = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: Record<string, string>;
      };
      assert.match(payload.query ?? "", /ReleaseBarRepoWorkTrend/);
      assert.match(payload.variables?.issuesOpened30d ?? "", /is:issue created:>=/);
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 5 },
          issuesClosed30d: { issueCount: 3 },
          pullRequestsOpened30d: { issueCount: 4 },
          pullRequestsClosed30d: { issueCount: 2 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:octo": JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 73,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.fullName, "acme/releasebar");
    assert.equal(body.project.version, "v1.2.3");
    assert.equal(body.project.commitsSinceRelease, 6);
    assert.equal(body.project.openIssues, 7);
    assert.equal(body.project.openPullRequests, 2);
    assert.equal(body.project.ciState, "failure");
    assert.equal(body.project.ciWorkflow, "Lint");
    assert.equal(body.releases.length, 2);
    assert.equal(body.contributors[0]?.login, "octo");
    assert.equal(body.contributors[0]?.trustScore, 73);
    assert.equal(body.contributors[0]?.trustTier, "high");
    assert.equal(body.commitActivity[0]?.total, 7);
    assert.equal(body.codeFrequency[0]?.additions, 120);
    assert.equal(body.codeFrequency[0]?.deletions, 20);
    assert.equal(body.stats?.commitActivity.state, "ready");
    assert.equal(body.stats?.codeFrequency.state, "ready");
    assert.equal(body.workTrend?.issuesOpened30d, 5);
    assert.equal(body.workTrend?.pullRequestsClosed30d, 2);
    assert.deepEqual(
      body.languages.map((language) => language.name),
      ["TypeScript", "CSS"],
    );
    const accessRecords = await githubAccessRouteRecords(env.DASHBOARD_CACHE);
    assert.ok(
      accessRecords.some(
        (record) =>
          record.area === "repo-detail" &&
          record.source === "shared" &&
          record.resource === "core" &&
          record.status === 200,
      ),
    );
    assert.equal(await env.DASHBOARD_CACHE.get("github:budget:v1:shared:core"), null);

    await env.DASHBOARD_CACHE.put(
      "trust-profile:v4:octo",
      JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 62,
        tier: "medium",
        generatedAt: "2026-05-16T12:05:00Z",
      }),
    );
    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    const cachedBody = (await cached.json()) as RepoDetailPayload;
    assert.equal(cachedBody.contributors[0]?.trustScore, 62);
    assert.equal(cachedBody.contributors[0]?.trustTier, "medium");
    assert.equal(calls, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker revalidates stale repository metadata with ETags", async () => {
  const fullName = "acme/etag";
  const repoPath = "/repos/acme/etag";
  const auxKey = `repo-detail:aux:v2:${encodeURIComponent(fullName)}:repository:${encodeURIComponent(repoPath)}`;
  const env = {
    DASHBOARD_CACHE: kvStore({
      [auxKey]: JSON.stringify({
        generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        etag: '"repo-etag"',
        data: {
          owner: { login: "acme" },
          name: "etag",
          full_name: fullName,
          private: false,
          fork: false,
          archived: false,
          html_url: `https://github.com/${fullName}`,
          description: "ETag repository",
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 0,
          pushed_at: "2026-06-12T12:00:00Z",
          updated_at: "2026-06-12T12:00:00Z",
        },
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  let repositoryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === repoPath) {
      repositoryCalls += 1;
      assert.equal(new Headers(init?.headers).get("if-none-match"), '"repo-etag"');
      return new Response(null, { status: 304, headers: { etag: '"repo-etag"' } });
    }
    if (path === `${repoPath}/releases`) return Response.json([]);
    if (path === `${repoPath}/commits/main`) {
      return Response.json({ message: "Git Repository is empty." }, { status: 409 });
    }
    if (path === `${repoPath}/pulls`) return Response.json([]);
    if (path === `${repoPath}/contributors`) return Response.json([]);
    if (path === `${repoPath}/languages`) return Response.json({});
    if (path === `${repoPath}/stats/commit_activity`) return Response.json([]);
    if (path === `${repoPath}/stats/code_frequency`) return Response.json([]);
    if (path === "/graphql") {
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(`https://release.bar/api/repos/${fullName}`),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.description, "ETag repository");
    assert.equal(repositoryCalls, 1);
    const refreshed = JSON.parse((await env.DASHBOARD_CACHE.get(auxKey)) ?? "{}") as {
      generatedAt?: string;
      etag?: string;
    };
    assert.equal(refreshed.etag, '"repo-etag"');
    assert.ok(Date.parse(refreshed.generatedAt ?? "") > Date.now() - 60_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker bundles App-backed repository core data through GraphQL", async () => {
  const account = "acme";
  const env = {
    DASHBOARD_CACHE: kvStore({
      [`auth:installation:v1:${account}`]: JSON.stringify({
        id: 1,
        accountLogin: account,
        accountType: "org",
        accountUrl: `https://github.com/${account}`,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        repositorySelection: "all",
        repositories: [],
        updatedAt: new Date().toISOString(),
      }),
      "auth:installation-token:1": "installation-token",
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "unused",
  };
  const originalFetch = globalThis.fetch;
  let coreCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer installation-token");
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: { name?: string };
      };
      if (body.query?.includes("ReleaseBarRepoDetailCore")) {
        coreCalls += 1;
        const name = body.variables?.name ?? "graphql";
        const statusContext =
          name === "pending"
            ? {
                __typename: "StatusContext",
                context: "Deploy",
                state: "PENDING",
                targetUrl: "https://github.com/acme/pending/actions",
                createdAt: "2026-06-13T12:25:00Z",
              }
            : {
                __typename: "StatusContext",
                context: "Legacy CI",
                state: "ERROR",
                targetUrl: "https://github.com/acme/graphql/actions",
                createdAt: "2026-06-13T12:25:00Z",
              };
        return Response.json({
          data: {
            repository: {
              owner: { login: account },
              name,
              nameWithOwner: `${account}/${name}`,
              url: `https://github.com/${account}/${name}`,
              description: "Bundled repository detail",
              isPrivate: false,
              isFork: false,
              isArchived: false,
              primaryLanguage: { name: "TypeScript" },
              repositoryTopics: { nodes: [] },
              stargazerCount: 42,
              forkCount: 3,
              issues: { totalCount: 2 },
              pullRequests: { totalCount: 1 },
              pushedAt: "2026-06-13T12:00:00Z",
              updatedAt: "2026-06-13T12:00:00Z",
              defaultBranchRef: {
                name: "main",
                target: {
                  oid: "abcdef123456",
                  committedDate: "2026-06-13T12:00:00Z",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        statusContext,
                        {
                          __typename: "CheckRun",
                          name: "CI",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "https://github.com/acme/graphql/actions/runs/1",
                          completedAt: "2026-06-13T12:30:00Z",
                          startedAt: "2026-06-13T12:20:00Z",
                        },
                      ],
                    },
                  },
                },
              },
              releases: { nodes: [] },
            },
          },
        });
      }
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    if (url.pathname.endsWith("/contributors")) return Response.json([]);
    if (url.pathname.endsWith("/languages")) return Response.json({});
    if (url.pathname.endsWith("/stats/commit_activity")) return Response.json([]);
    if (url.pathname.endsWith("/stats/code_frequency")) return Response.json([]);
    throw new Error(`unexpected REST core fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/graphql"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(coreCalls, 1);
    assert.equal(body.project.openIssues, 2);
    assert.equal(body.project.openPullRequests, 1);
    assert.equal(body.project.latestCommitSha, "abcdef1");
    assert.equal(body.project.ciState, "failure");
    assert.equal(body.cache.quota?.source, "app");
    assert.equal(body.cache.quota?.account, account);

    const pendingResponse = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/pending"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(pendingResponse.status, 200);
    const pending = (await pendingResponse.json()) as RepoDetailPayload;
    assert.equal(coreCalls, 2);
    assert.equal(pending.project.ciState, "running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache private App-backed repository core data", async () => {
  const account = "acme";
  const cache = kvStore({
    [`auth:installation:v1:${account}`]: JSON.stringify({
      id: 1,
      accountLogin: account,
      accountType: "org",
      accountUrl: `https://github.com/${account}`,
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:1": "installation-token",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/graphql");
    return Response.json({
      data: {
        repository: {
          owner: { login: account },
          name: "private",
          nameWithOwner: `${account}/private`,
          url: `https://github.com/${account}/private`,
          description: null,
          isPrivate: true,
          isFork: false,
          isArchived: false,
          primaryLanguage: null,
          repositoryTopics: { nodes: [] },
          stargazerCount: 0,
          forkCount: 0,
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          pushedAt: "2026-06-13T12:00:00Z",
          updatedAt: "2026-06-13T12:00:00Z",
          defaultBranchRef: {
            name: "main",
            target: null,
          },
          releases: { nodes: [] },
        },
      },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/private"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 502);
    assert.equal(
      await cache.get(
        `repo-detail:aux:v2:${encodeURIComponent("acme/private")}:core-graphql:${encodeURIComponent("acme/private")}`,
      ),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker coalesces concurrent cold repository detail builds", async () => {
  const originalFetch = globalThis.fetch;
  let repositoryCalls = 0;
  let releaseRepository: (() => void) | undefined;
  const repositoryGate = new Promise<void>((resolve) => {
    releaseRepository = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/coalesced") {
      repositoryCalls += 1;
      await repositoryGate;
      return Response.json({
        owner: { login: "acme" },
        name: "coalesced",
        full_name: "acme/coalesced",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/coalesced",
        description: "Coalesced detail",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-06-13T12:00:00Z",
        updated_at: "2026-06-13T12:00:00Z",
      });
    }
    if (path === "/repos/acme/coalesced/releases") return Response.json([]);
    if (path === "/repos/acme/coalesced/commits/main") {
      return Response.json({ message: "Git Repository is empty." }, { status: 409 });
    }
    if (path === "/repos/acme/coalesced/pulls") return Response.json([]);
    if (path === "/repos/acme/coalesced/contributors") return Response.json([]);
    if (path === "/repos/acme/coalesced/languages") return Response.json({});
    if (path === "/repos/acme/coalesced/stats/commit_activity") return Response.json([]);
    if (path === "/repos/acme/coalesced/stats/code_frequency") return Response.json([]);
    if (path === "/graphql") {
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const request = () =>
      worker.fetch(new Request("https://release.bar/api/repos/acme/coalesced"), env, {
        waitUntil: () => undefined,
      });
    const first = request();
    await Promise.resolve();
    const second = request();
    releaseRepository?.();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(repositoryCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

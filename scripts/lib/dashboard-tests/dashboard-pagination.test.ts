import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard, fetchOwnerRepoCounts } from "../dashboard.js";
import { testProject } from "../dashboard-test-harness.js";

test("dashboard filtering does not report archived repositories as absent", async () => {
  const previousReleasesUpdatedAt = "2026-06-10T05:00:00Z";
  const previousCiUpdatedAt = "2026-06-10T06:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    archived: false,
    pushedAt: "2026-06-10T07:00:00Z",
    updatedAt: "2026-06-10T07:00:00Z",
  });
  const removed: string[] = [];
  const absent: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 1,
    initialProjects: [project],
    skipRepos: [project.fullName],
    previousReleasesUpdatedAt,
    previousCiUpdatedAt,
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
            archived: true,
            pushed_at: "2026-06-11T07:00:00Z",
            updated_at: "2026-06-11T07:00:00Z",
            fork: false,
            private: false,
          },
        ]);
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (_partial, progress) => {
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.deepEqual(payload.projects, []);
  assert.deepEqual(removed, ["owner/repo"]);
  assert.deepEqual(absent, []);
  assert.equal(payload.cache?.releasesUpdatedAt, previousReleasesUpdatedAt);
  assert.equal(payload.cache?.ciUpdatedAt, previousCiUpdatedAt);
});

test("dashboard reconciliation preserves live repositories later on a short page", async () => {
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
    pushed_at: "2026-06-11T07:00:00Z",
    updated_at: "2026-06-11T07:00:00Z",
    fork: false,
    private: false,
  });
  const initialProjects = Array.from({ length: 200 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    });
  });
  const liveRepos = Array.from({ length: 20 }, (_, index) =>
    repo(`repo-${String(index + 1).padStart(3, "0")}`),
  );
  const removed = new Set<string>();
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 200,
    initialProjects,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json(liveRepos);
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
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
    onProgress: (_partial, progress) => {
      for (const fullName of progress.removedRepos ?? []) {
        removed.add(fullName);
      }
    },
  });

  assert.equal(payload.projects.length, 20);
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-020"),
    true,
  );
  assert.equal(removed.size, 180);
  assert.equal(payload.cache?.progress?.scanned, 12);
  assert.equal(payload.cache?.progress?.done, false);
});

test("dashboard reconciliation follows GraphQL pagination when a page contains null nodes", async () => {
  const repoNode = (name: string) => ({
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
    issues: { totalCount: 0 },
    pullRequests: { totalCount: 0 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    releases: { nodes: [] },
  });
  const initialProjects = ["keep", "later"].map((name) =>
    testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    }),
  );
  let graphqlPages = 0;

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 0,
    repoScanTarget: 2,
    initialProjects,
    skipRepos: ["owner/keep", "owner/later"],
    token: "token",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/graphql") {
        throw new Error(`unexpected ${path}`);
      }
      graphqlPages += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const after = body.variables?.after;
      const finalPage = after === "page-3";
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: finalPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: after === "page-2" ? "page-3" : "page-2" },
              nodes: finalPage ? [repoNode("keep"), repoNode("later")] : [null],
            },
          },
        },
      });
    },
  });

  assert.equal(graphqlPages, 3);
  assert.deepEqual(payload.projects.map((project) => project.fullName).sort(), [
    "owner/keep",
    "owner/later",
  ]);
});

test("dashboard metadata scan follows GraphQL pagination past all-null pages", async () => {
  const repoNode = {
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: null,
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: 4 },
    pullRequests: { totalCount: 2 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    releases: { nodes: [] },
  };
  let graphqlPages = 0;

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
    token: "token",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/graphql") {
        throw new Error(`unexpected ${path}`);
      }
      graphqlPages += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const after = body.variables?.after;
      const finalPage = after === "page-3";
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: finalPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: after === "page-2" ? "page-3" : "page-2" },
              nodes: finalPage ? [repoNode] : [null],
            },
          },
        },
      });
    },
  });

  assert.equal(graphqlPages, 3);
  assert.equal(payload.projects[0]?.fullName, "owner/repo");
  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 2);
});

test("dashboard released-only repo cap scans past unreleased repositories", async () => {
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
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
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
                  html_url: `https://github.com/owner/${name}/releases/v1.0.0`,
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
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.totals.unreleased, 0);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap stops giant owners after recent repos", async () => {
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
  const releaseFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("empty-a"), repo("empty-b"), repo("released")]);
      }
      if (path.endsWith("/releases")) {
        releaseFetches.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
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

  assert.deepEqual(releaseFetches, ["empty-a", "empty-b"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 2 recently pushed repos/);
});

test("dashboard metadata-only mode skips release hydration", async () => {
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
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const unexpectedHydrationFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      unexpectedHydrationFetches.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(unexpectedHydrationFetches, []);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["repo search", "repo search"],
  );
  assert.equal(payload.projects[0]?.commitsSinceRelease, null);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard metadata-only released-only mode keeps released-only semantics", async () => {
  const fetchedPaths: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      fetchedPaths.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(fetchedPaths, []);
  assert.deepEqual(payload.projects, []);
  assert.equal(payload.totals.repos, 0);
  assert.equal(payload.totals.unreleased, 0);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard shared owner page cap finishes as fresh capped data", async () => {
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
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    quotaSource: "shared",
    repoLimit: 400,
    repoScanLimit: 0,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        const page = parsed.searchParams.get("page") ?? "";
        pages.push(page);
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`page-${page}-${index}`)),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1", "2", "3"]);
  assert.equal(payload.cache?.state, "fresh");
  assert.equal(payload.cache?.progress?.done, undefined);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap marks full page boundary truncation as capped", async () => {
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
  const pages: string[] = [];
  const pageSizes: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 100,
    repoScanLimit: 100,
    ownerPageSize: 200,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        pageSizes.push(parsed.searchParams.get("per_page") ?? "");
        return Response.json(Array.from({ length: 100 }, (_, index) => repo(`empty-${index}`)));
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
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

  assert.deepEqual(pages, ["1"]);
  assert.deepEqual(pageSizes, ["100"]);
  assert.equal(payload.totals.repos, 100);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 100 recently pushed repos/);
});

test("dashboard resume stops paging when visible cap is already scanned", async () => {
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
  const project = (
    name: string,
  ): Awaited<ReturnType<typeof buildDashboard>>["projects"][number] => ({
    owner: "owner",
    name,
    fullName: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 0,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/owner/${name}/issues`,
    pullRequestsUrl: `https://github.com/owner/${name}/pulls`,
    archived: false,
    pushedAt: null,
    updatedAt: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `https://github.com/owner/${name}/releases`,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    repoScanTarget: 2,
    initialProjects: [project("one"), project("two")],
    skipRepos: ["owner/one", "owner/two"],
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.progress?.done, true);
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
    title: "ReleaseBar",
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

test("owner count refresh uses the lean GraphQL shape", async () => {
  let query = "";
  const result = await fetchOwnerRepoCounts({
    owner: "owner",
    token: "token",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query?: string };
      query = body.query ?? "";
      return Response.json({
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  nameWithOwner: "owner/repo",
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T01:00:00Z",
                },
              ],
            },
          },
        },
      });
    },
  });

  assert.match(query, /query ReleaseBarOwnerCounts/);
  assert.doesNotMatch(query, /repositoryTopics|releases|statusCheckRollup/);
  assert.equal(result.complete, true);
  assert.deepEqual(result.repos[0], {
    fullName: "owner/repo",
    openIssues: 7,
    openPullRequests: 3,
    archived: false,
    fork: false,
    private: false,
    pushedAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T01:00:00Z",
  });

  const truncated = await fetchOwnerRepoCounts({
    owner: "owner",
    token: "token",
    limit: 1,
    fetch: async () =>
      Response.json({
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                {
                  nameWithOwner: "owner/repo",
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T01:00:00Z",
                },
              ],
            },
          },
        },
      }),
  });
  assert.equal(truncated.complete, false);
});

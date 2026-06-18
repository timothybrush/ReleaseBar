import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../dashboard.js";
import { testProject } from "../dashboard-test-harness.js";

test("dashboard repo cap applies to visible rows before release hydration", async () => {
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
    open_issues_count: name === "empty-a" ? 3 : 0,
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
    includeUnreleased: true,
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
        return Response.json(name === "empty-a" ? [{}] : []);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({
          check_runs:
            name === "empty-a"
              ? [
                  {
                    name: "ci",
                    status: "completed",
                    conclusion: "success",
                    html_url: "https://github.com/owner/empty-a/actions/runs/1",
                    completed_at: "2026-01-02T00:00:00Z",
                    started_at: "2026-01-02T00:00:00Z",
                  },
                ]
              : [],
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["unreleased", "unreleased"],
  );
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.openIssues, 2);
  assert.equal(payload.projects[0]?.openPullRequests, 1);
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.cache?.capped, true);
});

test("dashboard hydration advances across a metadata-seeded 200-repo cap", async () => {
  const repos = Array.from({ length: 200 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return {
      owner: { login: "owner" },
      name,
      full_name: `owner/${name}`,
      description: null,
      html_url: `https://github.com/owner/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: index === 150 ? 99 : 0,
      open_issues_total: index === 150 ? 99 : 0,
      open_pull_requests_total: 0,
      archived: false,
      pushed_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      fork: false,
      private: false,
    };
  });
  const fetcher: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === "/users/owner/repos") {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return Response.json(repos.slice((page - 1) * 100, page * 100));
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
  };
  const baseOptions = {
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user" as const, login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 200,
    repoScanTarget: 200,
    hydrateSort: "issues" as const,
    hydrateDirection: "desc" as const,
    fetch: fetcher,
  };
  const metadata = await buildDashboard({
    ...baseOptions,
    includeReleaseData: false,
    repoScanLimit: 0,
  });
  assert.equal(metadata.projects.length, 200);

  const firstScanned: string[] = [];
  const first = await buildDashboard({
    ...baseOptions,
    includeReleaseData: true,
    repoScanLimit: 12,
    initialProjects: metadata.projects,
    onProgress: async (_payload, progress) => {
      if (progress.scannedRepo) firstScanned.push(progress.scannedRepo);
    },
  });
  assert.equal(firstScanned.length, 12);
  assert.equal(firstScanned[0], "owner/repo-151");
  assert.equal(first.cache?.progress?.scanned, 12);
  assert.equal(first.cache?.progress?.done, false);

  const secondScanned: string[] = [];
  const second = await buildDashboard({
    ...baseOptions,
    includeReleaseData: true,
    repoScanLimit: 12,
    initialProjects: first.projects,
    skipRepos: firstScanned,
    onProgress: async (_payload, progress) => {
      if (progress.scannedRepo) secondScanned.push(progress.scannedRepo);
    },
  });
  assert.equal(secondScanned.length, 12);
  assert.equal(
    secondScanned.some((repo) => firstScanned.includes(repo)),
    false,
  );
  assert.equal(second.cache?.progress?.scanned, 24);
  assert.equal(second.cache?.progress?.done, false);
});

test("dashboard hydration reconciles new repositories into a cached 200-repo set", async () => {
  const repo = (name: string, pushedAt: string) => ({
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
    pushed_at: pushedAt,
    updated_at: pushedAt,
    fork: false,
    private: false,
  });
  const oldRepos = Array.from({ length: 200 }, (_, index) =>
    repo(
      `repo-${String(index + 1).padStart(3, "0")}`,
      new Date(Date.UTC(2026, 0, 1) + (200 - index) * 1000).toISOString(),
    ),
  );
  const liveRepos = [repo("repo-new", "2026-06-11T07:00:00Z"), ...oldRepos.slice(0, 199)];
  const initialProjects = oldRepos.map((item) =>
    testProject({
      owner: item.owner.login,
      name: item.name,
      pushedAt: item.pushed_at,
      updatedAt: item.updated_at,
      latestCommitDate: item.updated_at,
    }),
  );
  const scanned: string[] = [];
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
    repoScanTarget: 200,
    initialProjects,
    skipRepos: oldRepos.map((item) => item.full_name),
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        const page = Number(parsed.searchParams.get("page") ?? "1");
        return Response.json(liveRepos.slice((page - 1) * 100, page * 100));
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
      if (progress.scannedRepo) scanned.push(progress.scannedRepo);
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.equal(payload.projects.length, 200);
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-new"),
    true,
  );
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-200"),
    false,
  );
  assert.deepEqual(scanned, ["owner/repo-new"]);
  assert.deepEqual(removed, ["owner/repo-200"]);
  assert.deepEqual(absent, []);
  assert.equal(payload.cache?.progress?.scanned, 200);
  assert.equal(payload.cache?.progress?.done, true);
});

test("dashboard hydration removes vanished repositories after complete owner enumeration", async () => {
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
  const initialProjects = ["keep", "old-name"].map((name) =>
    testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    }),
  );
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
    repoScanTarget: 2,
    initialProjects,
    skipRepos: ["owner/keep", "owner/old-name"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("keep"), repo("new-name")]);
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
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.deepEqual(payload.projects.map((project) => project.fullName).sort(), [
    "owner/keep",
    "owner/new-name",
  ]);
  assert.deepEqual(removed, ["owner/old-name"]);
  assert.deepEqual(absent, ["owner/old-name"]);
  assert.equal(payload.cache?.progress?.scanned, 2);
  assert.equal(payload.cache?.progress?.done, true);
});

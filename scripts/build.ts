import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import type {
  CiState,
  DashboardPayload,
  Freshness,
  Owner,
  Project,
  ReleaseDeckConfig,
} from "../src/types.js";

const root = process.cwd();
const distDir = path.join(root, "dist");
const configPath = path.join(root, "releasedeck.config.json");
const publicDir = path.join(root, "src");
const checkOnly = process.argv.includes("--check");

const config = JSON.parse(await readFile(configPath, "utf8")) as ReleaseDeckConfig;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ReleaseDeck",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

type GitHubOwner = {
  login: string;
};

type GitHubRepo = {
  owner: GitHubOwner;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  pushed_at: string | null;
  updated_at: string | null;
  fork: boolean;
  private: boolean;
};

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft?: boolean;
  published_at: string | null;
};

type GitHubCommit = {
  sha: string;
  commit?: {
    committer?: {
      date?: string;
    };
  };
};

type GitHubCompare = {
  total_commits?: number;
  html_url?: string;
};

type GitHubCheckRun = {
  name: string | null;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  completed_at: string | null;
  started_at: string | null;
};

type GitHubCheckRuns = {
  check_runs?: GitHubCheckRun[];
};

type CiDetails = {
  state: CiState;
  status: string | null;
  conclusion: string | null;
  workflow: string | null;
  url: string | null;
  runDate: string | null;
};

async function github<T>(pathname: string, ignoreStatuses: number[] = [404]): Promise<T | null> {
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (ignoreStatuses.includes(response.status)) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

async function githubPages<T>(pathname: string): Promise<T[]> {
  let page = 1;
  const items: T[] = [];
  while (true) {
    const joiner = pathname.includes("?") ? "&" : "?";
    const result = await github<T[]>(`${pathname}${joiner}per_page=100&page=${page}`);
    if (!result || result.length === 0) {
      break;
    }
    items.push(...result);
    if (result.length < 100) {
      break;
    }
    page += 1;
  }
  return items;
}

async function githubCount(pathname: string): Promise<number> {
  const joiner = pathname.includes("?") ? "&" : "?";
  const response = await fetch(`https://api.github.com${pathname}${joiner}per_page=1`, { headers });
  if (response.status === 404) {
    return 0;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }

  const link = response.headers.get("link");
  const lastPage = link?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
  if (lastPage) {
    return Number(lastPage);
  }

  const items = (await response.json()) as unknown[];
  return items.length;
}

async function ownerRepos(owner: Owner): Promise<GitHubRepo[]> {
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  return githubPages<GitHubRepo>(`${base}?type=public&sort=pushed&direction=desc`);
}

async function latestRelease(repo: GitHubRepo): Promise<GitHubRelease | null> {
  const releases = await github<GitHubRelease[]>(`/repos/${repo.full_name}/releases?per_page=10`);
  return (
    releases?.find((release) => release.tag_name && !release.draft && release.published_at) ?? null
  );
}

async function checkRuns(repo: GitHubRepo, ref: string): Promise<GitHubCheckRun[]> {
  const runs = await github<GitHubCheckRuns>(
    `/repos/${repo.full_name}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    [404, 403, 409],
  );
  return runs?.check_runs ?? [];
}

function ciDetails(runs: GitHubCheckRun[]): CiDetails {
  if (runs.length === 0) {
    return {
      state: "unknown",
      status: null,
      conclusion: null,
      workflow: null,
      url: null,
      runDate: null,
    };
  }

  const failure = runs.find((run) =>
    ["failure", "timed_out", "action_required"].includes(run.conclusion ?? ""),
  );
  const active = runs.find((run) => run.status && run.status !== "completed");
  const cancelled = runs.find((run) => run.conclusion === "cancelled");
  const successCount = runs.filter((run) => run.conclusion === "success").length;
  const neutralCount = runs.filter((run) => run.conclusion === "neutral").length;
  const skippedCount = runs.filter((run) => run.conclusion === "skipped").length;
  const selected = failure ?? active ?? cancelled ?? runs[0];

  let state: CiState = "unknown";
  if (failure) {
    state = "failure";
  } else if (active) {
    state = active.status === "in_progress" ? "running" : "pending";
  } else if (cancelled) {
    state = "cancelled";
  } else if (successCount > 0) {
    state = "success";
  } else if (neutralCount > 0) {
    state = "neutral";
  } else if (skippedCount > 0) {
    state = "skipped";
  }

  return {
    state,
    status: selected.status,
    conclusion: selected.conclusion,
    workflow: state === "success" ? `${successCount}/${runs.length} checks` : selected.name,
    url: selected.html_url,
    runDate: selected.completed_at ?? selected.started_at,
  };
}

function repoAllowed(repo: GitHubRepo): boolean {
  const fullName = repo.full_name;
  if (!config.includeForks && repo.fork) {
    return false;
  }
  if (!config.includeArchived && repo.archived) {
    return false;
  }
  if ((config.excludeRepos || []).includes(fullName)) {
    return false;
  }
  return !repo.private;
}

async function repoSummary(repo: GitHubRepo): Promise<Omit<Project, "freshness"> | null> {
  const [release, latestCommit] = await Promise.all([
    latestRelease(repo),
    github<GitHubCommit>(`/repos/${repo.full_name}/commits/${repo.default_branch}`),
  ]);
  if (!release?.tag_name) {
    return null;
  }

  let commitsSinceRelease: number | null = null;
  let compareUrl: string | null = null;
  const latestRef = latestCommit?.sha ?? repo.default_branch;
  const [compare, openPullRequests, checks] = await Promise.all([
    github<GitHubCompare>(
      `/repos/${repo.full_name}/compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
    ),
    githubCount(`/repos/${repo.full_name}/pulls?state=open`),
    checkRuns(repo, latestRef),
  ]);
  commitsSinceRelease = compare?.total_commits ?? null;
  compareUrl = compare?.html_url ?? null;
  const ci = ciDetails(checks);

  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: Math.max(repo.open_issues_count - openPullRequests, 0),
    openPullRequests,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: latestCommit?.sha?.slice(0, 7) ?? null,
    latestCommitDate: latestCommit?.commit?.committer?.date ?? null,
    version: release.tag_name,
    releaseName: release.name,
    releaseUrl: release.html_url,
    releaseDate: release.published_at,
    commitsSinceRelease,
    compareUrl,
    ciState: ci.state,
    ciStatus: ci.status,
    ciConclusion: ci.conclusion,
    ciWorkflow: ci.workflow,
    ciUrl: ci.url,
    ciRunDate: ci.runDate,
  };
}

function freshness(project: Omit<Project, "freshness">): Freshness {
  if (project.commitsSinceRelease === 0) {
    return "fresh";
  }
  if (project.commitsSinceRelease !== null && project.commitsSinceRelease <= 5) {
    return "warm";
  }
  if (project.commitsSinceRelease !== null && project.commitsSinceRelease <= 25) {
    return "busy";
  }
  return "hot";
}

async function main() {
  const repos: GitHubRepo[] = [];
  for (const owner of config.owners) {
    repos.push(...(await ownerRepos(owner)));
  }

  const uniqueRepos = [
    ...new Map(repos.filter(repoAllowed).map((repo) => [repo.full_name, repo])).values(),
  ];
  const projects: Project[] = [];

  for (const [index, repo] of uniqueRepos.entries()) {
    process.stdout.write(`fetch ${index + 1}/${uniqueRepos.length} ${repo.full_name}\n`);
    const project = await repoSummary(repo);
    if (!project) {
      process.stdout.write(`skip ${repo.full_name}: no releases\n`);
      continue;
    }
    projects.push({ ...project, freshness: freshness(project) });
  }

  projects.sort((a, b) => {
    const aDate = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const bDate = b.pushedAt ? Date.parse(b.pushedAt) : 0;
    return bDate - aDate;
  });

  const generatedAt = new Date().toISOString();
  const payload: DashboardPayload = {
    title: config.title,
    subtitle: config.subtitle,
    canonicalDomain: config.canonicalDomain,
    generatedAt,
    owners: config.owners,
    totals: {
      repos: projects.length,
      released: projects.length,
      unreleased: 0,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease || 0),
        0,
      ),
    },
    projects,
  };

  if (checkOnly) {
    console.log(JSON.stringify(payload.totals, null, 2));
    return;
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "data"), { recursive: true });

  for (const file of [
    "index.html",
    "styles.css",
    "app.js",
    "favicon.ico",
    "favicon.svg",
    "apple-touch-icon.png",
    "og-card.png",
  ]) {
    if (file === "app.js") {
      const appSource = await readFile(path.join(publicDir, "app.ts"), "utf8");
      const appOutput = ts.transpileModule(appSource, {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
          removeComments: false,
        },
        fileName: "app.ts",
      });
      await writeFile(path.join(distDir, file), appOutput.outputText);
    } else {
      await copyFile(path.join(publicDir, file), path.join(distDir, file));
    }
  }

  await writeFile(path.join(distDir, "CNAME"), `${config.canonicalDomain}\n`);
  await writeFile(
    path.join(distDir, "data", "projects.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(`built ${projects.length} projects at ${generatedAt}`);
}

await main();

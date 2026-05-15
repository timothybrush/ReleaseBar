import type {
  CiState,
  DashboardPayload,
  Freshness,
  Owner,
  Project,
  ReleaseBarConfig,
} from "../../src/types.js";

export type DashboardBuildOptions = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  owners: Owner[];
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased?: boolean;
  excludeRepos?: string[];
  includeRepos?: string[];
  repoLimit?: number;
  token?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

type GitHubOwner = {
  login: string;
  type?: "User" | "Organization";
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

type GitHubClient = {
  fetch: typeof fetch;
  headers: Record<string, string>;
};

export class GitHubRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function rateLimitFromResponse(response: Response, pathname: string): GitHubRateLimitError | null {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const isRateLimited =
    response.status === 429 ||
    (response.status === 403 && remaining === "0") ||
    retryAfter !== null;
  if (!isRateLimited) return null;
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfterSeconds = retryAfter
    ? Number(retryAfter)
    : reset
      ? Math.max(0, Number(reset) - Math.floor(Date.now() / 1000))
      : null;
  return new GitHubRateLimitError(
    `GitHub rate limit hit for ${pathname}`,
    Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
  );
}

export function normalizeBuildOptions(
  config: ReleaseBarConfig,
  overrides: Partial<DashboardBuildOptions> = {},
): DashboardBuildOptions {
  return {
    ...config,
    includeUnreleased: config.includeUnreleased ?? false,
    ...overrides,
    owners: overrides.owners ?? config.owners,
    excludeRepos: overrides.excludeRepos ?? config.excludeRepos,
  };
}

export function slugOwner(login: string): string {
  return login.trim().replace(/^@/, "").toLowerCase();
}

export function validOwnerSlug(login: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login);
}

export function validRepoSlug(repo: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d._-]{1,100}$/i.test(repo);
}

function cacheHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

export function dashboardCacheKey(options: {
  owner: string;
  owners?: string[];
  repos?: string[];
  includeForks?: boolean;
  includeArchived?: boolean;
  includeUnreleased?: boolean;
  schemaVersion?: number;
}): string {
  const schemaVersion = options.schemaVersion ?? 1;
  const flags = [
    options.includeForks ? "forks" : "noforks",
    options.includeArchived ? "archived" : "noarchived",
    options.includeUnreleased ? "unreleased" : "released",
  ].join("-");
  const owners = (options.owners ?? []).map(slugOwner).sort().join(",");
  const repos = (options.repos ?? [])
    .map((repo) => repo.toLowerCase())
    .sort()
    .join(",");
  const sourceText = owners || repos ? `${owners}\n${repos}` : "";
  const sources = sourceText ? `:sources-${cacheHash(sourceText)}` : "";
  return `dashboard:v${schemaVersion}:${slugOwner(options.owner)}:${flags}${sources}`;
}

export function filterRepo(
  repo: Pick<GitHubRepo, "archived" | "fork" | "full_name" | "private">,
  options: Pick<DashboardBuildOptions, "excludeRepos" | "includeArchived" | "includeForks">,
): boolean {
  if (!options.includeForks && repo.fork) {
    return false;
  }
  if (!options.includeArchived && repo.archived) {
    return false;
  }
  if ((options.excludeRepos || []).includes(repo.full_name)) {
    return false;
  }
  return !repo.private;
}

export function freshness(project: Pick<Project, "commitsSinceRelease">): Freshness {
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

function githubClient(token = "", fetcher: typeof fetch = fetch): GitHubClient {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ReleaseBar",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return { fetch: fetcher, headers };
}

async function github<T>(
  client: GitHubClient,
  pathname: string,
  ignoreStatuses: number[] = [404],
): Promise<T | null> {
  const response = await client.fetch(`https://api.github.com${pathname}`, {
    headers: client.headers,
  });
  const rateLimit = rateLimitFromResponse(response, pathname);
  if (rateLimit) throw rateLimit;
  if (ignoreStatuses.includes(response.status)) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

async function githubPage<T>(client: GitHubClient, pathname: string, page: number): Promise<T[]> {
  const joiner = pathname.includes("?") ? "&" : "?";
  return (await github<T[]>(client, `${pathname}${joiner}per_page=100&page=${page}`)) ?? [];
}

async function githubPages<T>(client: GitHubClient, pathname: string): Promise<T[]> {
  let page = 1;
  const items: T[] = [];
  while (true) {
    const result = await githubPage<T>(client, pathname, page);
    if (result.length === 0) {
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

async function githubCount(client: GitHubClient, pathname: string): Promise<number> {
  const joiner = pathname.includes("?") ? "&" : "?";
  const response = await client.fetch(`https://api.github.com${pathname}${joiner}per_page=1`, {
    headers: client.headers,
  });
  if (response.status === 404) {
    return 0;
  }
  if (!response.ok) {
    const rateLimit = rateLimitFromResponse(response, pathname);
    if (rateLimit) throw rateLimit;
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

async function ownerRepos(
  client: GitHubClient,
  owner: Owner,
  page?: number,
): Promise<GitHubRepo[]> {
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  const path = `${base}?type=public&sort=pushed&direction=desc`;
  return page ? githubPage<GitHubRepo>(client, path, page) : githubPages<GitHubRepo>(client, path);
}

async function repoByFullName(client: GitHubClient, fullName: string): Promise<GitHubRepo | null> {
  return github<GitHubRepo>(client, `/repos/${fullName}`, [404]);
}

async function latestRelease(
  client: GitHubClient,
  repo: GitHubRepo,
): Promise<GitHubRelease | null> {
  const releases = await github<GitHubRelease[]>(
    client,
    `/repos/${repo.full_name}/releases?per_page=10`,
  );
  return (
    releases?.find((release) => release.tag_name && !release.draft && release.published_at) ?? null
  );
}

async function checkRuns(
  client: GitHubClient,
  repo: GitHubRepo,
  ref: string,
): Promise<GitHubCheckRun[]> {
  const runs = await github<GitHubCheckRuns>(
    client,
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

async function repoSummary(
  client: GitHubClient,
  repo: GitHubRepo,
  includeUnreleased: boolean,
): Promise<Omit<Project, "freshness"> | null> {
  const release = await latestRelease(client, repo);
  if (!release?.tag_name && !includeUnreleased) {
    return null;
  }

  let commitsSinceRelease: number | null = null;
  let compareUrl: string | null = null;
  const latestCommit = await github<GitHubCommit>(
    client,
    `/repos/${repo.full_name}/commits/${repo.default_branch}`,
    [404, 409],
  );
  const latestRef = latestCommit?.sha ?? repo.default_branch;
  const [compare, openPullRequests, checks] = await Promise.all([
    release?.tag_name
      ? github<GitHubCompare>(
          client,
          `/repos/${repo.full_name}/compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
        )
      : Promise.resolve(null),
    githubCount(client, `/repos/${repo.full_name}/pulls?state=open`),
    checkRuns(client, repo, latestRef),
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
    version: release?.tag_name ?? "unreleased",
    releaseName: release?.name ?? null,
    releaseUrl: release?.html_url ?? repo.html_url,
    releaseDate: release?.published_at ?? null,
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

export async function resolveOwnerType(
  login: string,
  options: Pick<DashboardBuildOptions, "fetch" | "token"> = {},
): Promise<Owner | null> {
  const owner = slugOwner(login);
  if (!validOwnerSlug(owner)) {
    return null;
  }
  const client = githubClient(options.token, options.fetch);
  const result = await github<GitHubOwner>(client, `/users/${encodeURIComponent(owner)}`);
  if (!result?.login) {
    return null;
  }
  return {
    login: result.login,
    type: result.type === "Organization" ? "org" : "user",
  };
}

export async function buildDashboard(options: DashboardBuildOptions): Promise<DashboardPayload> {
  const client = githubClient(options.token, options.fetch);
  const projects: Project[] = [];
  let capped = false;
  const seen = new Set<string>();

  async function addRepo(repo: GitHubRepo, countLabel: string, force = false): Promise<void> {
    if (projects.some((project) => project.fullName === repo.full_name)) {
      return;
    }
    if ((!force && seen.has(repo.full_name)) || !filterRepo(repo, options)) {
      return;
    }
    seen.add(repo.full_name);
    options.log?.(`fetch ${countLabel} ${repo.full_name}`);
    const project = await repoSummary(client, repo, Boolean(options.includeUnreleased));
    if (!project) {
      options.log?.(`skip ${repo.full_name}: no releases`);
      return;
    }
    projects.push({ ...project, freshness: freshness(project) });
  }

  if (options.repoLimit) {
    for (const owner of options.owners) {
      const ownerStart = projects.length;
      let page = 1;
      while (projects.length - ownerStart <= options.repoLimit) {
        const repos = await ownerRepos(client, owner, page);
        if (repos.length === 0) {
          break;
        }
        for (const repo of repos) {
          const ownerCount = projects.length - ownerStart;
          await addRepo(repo, `${owner.login} ${ownerCount + 1}/${options.repoLimit}`);
          if (projects.length - ownerStart > options.repoLimit) {
            capped = true;
            break;
          }
        }
        if (repos.length < 100) {
          break;
        }
        page += 1;
      }
      if (projects.length - ownerStart > options.repoLimit) {
        projects.splice(ownerStart + options.repoLimit);
      }
    }
  } else {
    const repos: GitHubRepo[] = [];
    for (const owner of options.owners) {
      repos.push(...(await ownerRepos(client, owner)));
    }

    const uniqueRepos = [
      ...new Map(
        repos.filter((repo) => filterRepo(repo, options)).map((repo) => [repo.full_name, repo]),
      ).values(),
    ];

    for (const [index, repo] of uniqueRepos.entries()) {
      await addRepo(repo, `${index + 1}/${uniqueRepos.length}`);
    }
  }

  for (const fullName of options.includeRepos ?? []) {
    const repo = await repoByFullName(client, fullName);
    if (repo) {
      await addRepo(repo, `custom`, true);
    }
  }

  projects.sort((a, b) => {
    const aDate = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const bDate = b.pushedAt ? Date.parse(b.pushedAt) : 0;
    return bDate - aDate;
  });

  const generatedAt = new Date().toISOString();
  const released = projects.filter((project) => project.releaseDate).length;
  return {
    title: options.title,
    subtitle: options.subtitle,
    canonicalDomain: options.canonicalDomain,
    generatedAt,
    owners: options.owners,
    options: {
      includeForks: options.includeForks,
      includeArchived: options.includeArchived,
      includeUnreleased: Boolean(options.includeUnreleased),
      repoLimit: options.repoLimit ?? null,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped,
      repoLimit: options.repoLimit ?? null,
      generatedAt,
    },
    totals: {
      repos: projects.length,
      released,
      unreleased: projects.length - released,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease || 0),
        0,
      ),
    },
    projects,
  };
}

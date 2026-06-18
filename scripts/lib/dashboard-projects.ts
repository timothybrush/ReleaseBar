import type { Freshness, Project, ReleaseBarConfig } from "../../src/types.js";
import type { DashboardBuildOptions, GitHubRepo } from "./dashboard-contracts.js";

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

export function cacheHash(value: string): string {
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
  salt?: string;
  includeForks?: boolean;
  includeArchived?: boolean;
  includeUnreleased?: boolean;
  includeReleaseData?: boolean;
  schemaVersion?: number;
}): string {
  const schemaVersion = options.schemaVersion ?? 1;
  const flags = [
    options.includeForks ? "forks" : "noforks",
    options.includeArchived ? "archived" : "noarchived",
    options.includeUnreleased ? "unreleased" : "released",
    options.includeReleaseData === false ? "metadata" : "release",
  ].join("-");
  const owners = (options.owners ?? []).map(slugOwner).sort().join(",");
  const repos = (options.repos ?? [])
    .map((repo) => repo.toLowerCase())
    .sort()
    .join(",");
  const sourceText = options.salt
    ? `${owners}\n${repos}\n${options.salt}`
    : owners || repos
      ? `${owners}\n${repos}`
      : "";
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
  if (
    (options.excludeRepos || [])
      .map((value) => value.toLowerCase())
      .includes(repo.full_name.toLowerCase())
  ) {
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

export function repoSearchProject(repo: GitHubRepo): Project {
  const hasSplitCounts =
    repo.open_issues_total !== undefined && repo.open_pull_requests_total !== undefined;
  const openPullRequests = hasSplitCounts ? (repo.open_pull_requests_total ?? 0) : null;
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    language: repo.language,
    topics: repo.topics ?? [],
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: hasSplitCounts
      ? (repo.open_issues_total ??
        Math.max(repo.open_issues_count - (repo.open_pull_requests_total ?? 0), 0))
      : null,
    openPullRequests,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived,
    fork: repo.fork,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `${repo.html_url}/releases`,
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
  };
}

export function mergeRepoMetadata(project: Project, repo: GitHubRepo): Project;
export function mergeRepoMetadata(
  project: Omit<Project, "freshness">,
  repo: GitHubRepo,
): Omit<Project, "freshness">;
export function mergeRepoMetadata(
  project: Project | Omit<Project, "freshness">,
  repo: GitHubRepo,
): Project | Omit<Project, "freshness"> {
  const metadata = repoSearchProject(repo);
  const hasSplitCounts =
    repo.open_issues_total !== undefined && repo.open_pull_requests_total !== undefined;
  return {
    ...project,
    owner: metadata.owner,
    name: metadata.name,
    fullName: metadata.fullName,
    description: metadata.description,
    url: metadata.url,
    defaultBranch: metadata.defaultBranch,
    language: metadata.language,
    topics: metadata.topics,
    stars: metadata.stars,
    forks: metadata.forks,
    openIssues: hasSplitCounts ? metadata.openIssues : project.openIssues,
    openPullRequests: hasSplitCounts ? metadata.openPullRequests : project.openPullRequests,
    issuesUrl: metadata.issuesUrl,
    pullRequestsUrl: metadata.pullRequestsUrl,
    archived: metadata.archived,
    fork: metadata.fork,
    pushedAt: metadata.pushedAt,
    updatedAt: metadata.updatedAt,
  };
}

export function isRepoSearchProject(project: Project): boolean {
  return (
    project.version === "repo search" &&
    project.releaseDate === null &&
    project.commitsSinceRelease === null &&
    project.compareUrl === null
  );
}

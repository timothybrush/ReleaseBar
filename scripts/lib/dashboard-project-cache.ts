import type { Owner, Project } from "../../src/types.js";
import {
  type DashboardBuildOptions,
  type GitHubOwner,
  type GitHubRepo,
  type ProjectCache,
  type ProjectCacheEntry,
  repoFragmentTtlSeconds,
} from "./dashboard-contracts.js";
import { github, githubClient } from "./dashboard-github.js";
import { slugOwner, validOwnerSlug } from "./dashboard-projects.js";

export function projectCacheKey(
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
): string {
  return `repo:v2:${repo.full_name.toLowerCase()}:${includeUnreleased ? "unreleased" : "released"}:${includeReleaseData ? "release" : "metadata"}`;
}

export function projectCacheSignature(repo: GitHubRepo): string {
  return [
    repo.default_branch,
    repo.pushed_at ?? "",
    repo.updated_at ?? "",
    (repo.topics ?? []).join(","),
    repo.latest_release?.tag_name ?? "",
    repo.latest_release?.published_at ?? "",
    repo.latest_commit?.sha ?? "",
    repo.latest_commit?.commit?.committer?.date ?? "",
    repo.status_check_rollup?.state ?? "",
    repo.status_check_rollup?.contexts?.totalCount ?? "",
    repo.status_check_rollup?.contexts?.nodes
      .map((context) =>
        [
          context?.name ?? context?.context ?? "",
          context?.status ?? "",
          context?.conclusion ?? "",
          context?.state ?? "",
        ].join(":"),
      )
      .join(",") ?? "",
  ].join("|");
}

export function hydrationPriorityValue(
  repo: GitHubRepo,
  sort: DashboardBuildOptions["hydrateSort"],
): number {
  if (sort === "prs") return repo.open_pull_requests_total ?? 0;
  if (sort === "issues") {
    const pullRequests = repo.open_pull_requests_total ?? 0;
    return repo.open_issues_total ?? Math.max(repo.open_issues_count - pullRequests, 0);
  }
  return 0;
}

export function prioritizedHydrationQueue(
  repos: GitHubRepo[],
  options: Pick<DashboardBuildOptions, "hydrateSort" | "hydrateDirection">,
): GitHubRepo[] {
  if (options.hydrateSort !== "prs" && options.hydrateSort !== "issues") return repos;
  const direction = options.hydrateDirection === "asc" ? 1 : -1;
  return repos
    .map((repo, index) => ({ repo, index }))
    .sort((a, b) => {
      const value = hydrationPriorityValue(a.repo, options.hydrateSort);
      const other = hydrationPriorityValue(b.repo, options.hydrateSort);
      if (value !== other) return (value - other) * direction;
      const pushed = Date.parse(a.repo.pushed_at ?? "") || 0;
      const otherPushed = Date.parse(b.repo.pushed_at ?? "") || 0;
      if (pushed !== otherPushed) return otherPushed - pushed;
      return a.index - b.index;
    })
    .map(({ repo }) => repo);
}

export async function readProjectCache(
  cache: ProjectCache | undefined,
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
): Promise<Omit<Project, "freshness"> | null> {
  const raw = await cache?.get(projectCacheKey(repo, includeUnreleased, includeReleaseData));
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as ProjectCacheEntry;
    return cached.signature === projectCacheSignature(repo) ? cached.project : null;
  } catch {
    return null;
  }
}

export async function writeProjectCache(
  cache: ProjectCache | undefined,
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
  project: Omit<Project, "freshness">,
): Promise<void> {
  await cache?.put(
    projectCacheKey(repo, includeUnreleased, includeReleaseData),
    JSON.stringify({
      signature: projectCacheSignature(repo),
      project,
    } satisfies ProjectCacheEntry),
    { expirationTtl: repoFragmentTtlSeconds },
  );
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
    avatarUrl: result.avatar_url,
    url: result.html_url ?? `https://github.com/${result.login}`,
  };
}

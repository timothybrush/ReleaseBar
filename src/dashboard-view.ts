import type { Freshness, Project } from "./types.js";

export type SortKey =
  | "repo"
  | "version"
  | "release"
  | "since"
  | "activity"
  | "issues"
  | "prs"
  | "ci";
export type SortDirection = "asc" | "desc";
export type DashboardFilter = Freshness | "all" | "attention";

export type DashboardViewState = {
  query: string;
  filter: DashboardFilter;
  sortKey: SortKey;
  sortDirection: SortDirection;
  devMode: boolean;
};

export const filterOptions: DashboardFilter[] = ["all", "attention", "hot", "busy", "fresh"];
export const attentionFreshness: Freshness[] = ["hot", "busy"];
export const sortOptions: SortKey[] = ["repo", "version", "release", "since", "activity"];
export const devSortOptions: SortKey[] = ["issues", "prs", "ci"];

const filterValues = new Set<string>(filterOptions);
const sortValues = new Set<string>([...sortOptions, ...devSortOptions]);
const directionValues = new Set<string>(["asc", "desc"]);

export function defaultSortKey(isDefaultRoute: boolean): SortKey {
  return isDefaultRoute ? "since" : "activity";
}

export function defaultSortDirection(key: SortKey): SortDirection {
  return key === "repo" || key === "version" ? "asc" : "desc";
}

export function isDevSortKey(key: SortKey): boolean {
  return devSortOptions.includes(key);
}

export function filterLabel(value: DashboardFilter): string {
  return value === "attention" ? "need attention" : value;
}

export function needsAttention(project: Project): boolean {
  return attentionFreshness.includes(project.freshness);
}

export function parseViewState(
  search: string,
  isDefaultRoute: boolean,
  persistedDevMode = false,
): DashboardViewState {
  const params = new URLSearchParams(search);
  const rawFilter = params.get("filter") ?? "";
  const rawSort = params.get("sort") ?? "";
  const sortKey = (sortValues.has(rawSort) ? rawSort : defaultSortKey(isDefaultRoute)) as SortKey;
  const rawDirection = params.get("dir") ?? "";
  const sortDirection = (
    directionValues.has(rawDirection) ? rawDirection : defaultSortDirection(sortKey)
  ) as SortDirection;
  const devMode = params.get("dev") === "true" || persistedDevMode || isDevSortKey(sortKey);

  return {
    query: (params.get("q") ?? "").trim(),
    filter: (filterValues.has(rawFilter) ? rawFilter : "all") as DashboardFilter,
    sortKey,
    sortDirection,
    devMode,
  };
}

export function viewStateSearch(
  currentSearch: string,
  state: DashboardViewState,
  isDefaultRoute: boolean,
): string {
  const params = new URLSearchParams(currentSearch);
  const normalizedQuery = state.query.trim();
  const fallbackSortKey = defaultSortKey(isDefaultRoute);
  const fallbackDirection = defaultSortDirection(fallbackSortKey);

  setOrDelete(params, "q", normalizedQuery);
  setOrDelete(params, "filter", state.filter === "all" ? "" : state.filter);

  const customSort = state.sortKey !== fallbackSortKey || state.sortDirection !== fallbackDirection;
  setOrDelete(params, "sort", customSort ? state.sortKey : "");
  setOrDelete(params, "dir", customSort ? state.sortDirection : "");
  setOrDelete(params, "dev", state.devMode ? "true" : "");

  const next = params.toString();
  return next ? `?${next}` : "";
}

export function matchesFilter(project: Project, value: DashboardFilter): boolean {
  if (value === "all") return true;
  if (value === "attention") return needsAttention(project);
  return project.freshness === value;
}

export function sortValue(project: Project, key: SortKey): string | number {
  switch (key) {
    case "repo":
      return project.fullName.toLowerCase();
    case "version":
      return (project.version ?? "").toLowerCase();
    case "release":
      return timestamp(project.releaseDate);
    case "since":
      return project.commitsSinceRelease ?? -1;
    case "activity":
      return timestamp(project.latestCommitDate || project.pushedAt);
    case "issues":
      return project.openIssues;
    case "prs":
      return project.openPullRequests;
    case "ci":
      return ciRank(project);
  }
}

export function sortProjects(
  projects: Project[],
  activeSortKey: SortKey,
  activeSortDirection: SortDirection,
): Project[] {
  const direction = activeSortDirection === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const aValue = sortValue(a, activeSortKey);
    const bValue = sortValue(b, activeSortKey);
    if (typeof aValue === "string" && typeof bValue === "string") {
      return aValue.localeCompare(bValue) * direction;
    }
    return ((aValue as number) - (bValue as number)) * direction;
  });
}

function setOrDelete(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function ciRank(project: Project): number {
  const rank: Record<Project["ciState"], number> = {
    failure: 7,
    cancelled: 6,
    running: 5,
    pending: 4,
    unknown: 3,
    skipped: 2,
    neutral: 1,
    success: 0,
  };
  return rank[project.ciState];
}

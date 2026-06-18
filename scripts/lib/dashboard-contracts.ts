import type { ApiQuota, CiState, DashboardPayload, Owner, Project } from "../../src/types.js";

export type DashboardBuildOptions = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  owners: Owner[];
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased?: boolean;
  includeReleaseData?: boolean;
  excludeRepos?: string[];
  includeRepos?: string[];
  initialProjects?: Project[];
  skipRepos?: string[];
  repoLimit?: number;
  repoScanLimit?: number;
  repoScanTarget?: number;
  ownerPageSize?: number;
  ownerPageLimit?: number;
  hydrateSort?: "issues" | "prs" | null;
  hydrateDirection?: "asc" | "desc";
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
  ownerCredentials?: Record<
    string,
    {
      token: string;
      quotaSource: ApiQuota["source"];
      quotaAccount: string | null;
      fetch?: typeof fetch;
    }
  >;
  previousCountsUpdatedAt?: string | null;
  previousProjectCountsUpdatedAt?: Record<string, string>;
  previousReleasesUpdatedAt?: string | null;
  previousCiUpdatedAt?: string | null;
  generationStartedAt?: string;
  fetch?: typeof fetch;
  projectCache?: ProjectCache;
  onProgress?: (
    payload: DashboardPayload,
    progress: {
      scannedRepo: string;
      scanned: number;
      done: boolean;
      phase: "metadata" | "hydrate" | "complete";
      removedRepos?: string[];
      absentRepos?: string[];
      observedProjects?: Project[];
    },
  ) => Promise<void> | void;
  log?: (message: string) => void;
};

export type OwnerRepoCount = {
  fullName: string;
  openIssues: number;
  openPullRequests: number;
  archived: boolean;
  fork: boolean;
  private: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
};

export type ProjectCache = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type GitHubOwner = {
  login: string;
  type?: "User" | "Organization";
  avatar_url?: string;
  html_url?: string;
};

export type GitHubRepo = {
  owner: GitHubOwner;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  pushed_at: string | null;
  updated_at: string | null;
  fork: boolean;
  private: boolean;
  latest_release?: GitHubRelease | null;
  latest_commit?: GitHubCommit | null;
  status_check_rollup?: GitHubStatusCheckRollup | null;
  open_issues_total?: number;
  open_pull_requests_total?: number;
};

export type GitHubRelease = {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft?: boolean;
  published_at: string | null;
};

export type GitHubCommit = {
  sha: string;
  commit?: {
    committer?: {
      date?: string;
    };
  };
};

export type GitHubCompare = {
  total_commits?: number;
  html_url?: string;
};

export type GitHubCheckRun = {
  name: string | null;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  completed_at: string | null;
  started_at: string | null;
};

export type GitHubCheckRuns = {
  check_runs?: GitHubCheckRun[];
};

export type GitHubStatusCheckRollup = {
  state: string | null;
  contexts?: {
    totalCount: number;
    nodes: Array<{
      __typename?: string;
      name?: string | null;
      context?: string | null;
      status?: string | null;
      conclusion?: string | null;
      state?: string | null;
      detailsUrl?: string | null;
      targetUrl?: string | null;
      completedAt?: string | null;
      startedAt?: string | null;
      createdAt?: string | null;
    } | null>;
  } | null;
};

export type CiDetails = {
  state: CiState;
  status: string | null;
  conclusion: string | null;
  workflow: string | null;
  url: string | null;
  runDate: string | null;
};

export type GitHubClient = {
  fetch: typeof fetch;
  headers: Record<string, string>;
  graphqlCursors: Map<string, Array<string | null | undefined>>;
  quota: ApiQuota;
};

export type GraphQLRepoNode = {
  owner: {
    login: string;
    __typename?: string;
  };
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  defaultBranchRef: null | {
    name: string;
    target?: {
      oid: string;
      committedDate: string | null;
      statusCheckRollup?: GitHubStatusCheckRollup | null;
    } | null;
  };
  primaryLanguage: null | {
    name: string;
  };
  repositoryTopics?: {
    nodes: Array<{
      topic?: {
        name?: string | null;
      } | null;
    } | null>;
  };
  stargazerCount: number;
  forkCount: number;
  issues: {
    totalCount: number;
  };
  pullRequests: {
    totalCount: number;
  };
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  releases?: {
    nodes: Array<{
      tagName: string;
      name: string | null;
      url: string;
      isDraft?: boolean;
      publishedAt: string | null;
    } | null>;
  } | null;
};

export type GraphQLRepoPage = {
  data?: {
    repositoryOwner?: null | {
      __typename?: string;
      repositories: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<GraphQLRepoNode | null>;
      };
    };
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export type OwnerReposPage = {
  repos: GitHubRepo[];
  hasNextPage: boolean;
  cursor?: string | null;
};

export type GraphQLRepoDetailNode = {
  nameWithOwner: string;
  defaultBranchRef: null | {
    name: string;
    target?: {
      oid: string;
      committedDate: string | null;
      statusCheckRollup?: GitHubStatusCheckRollup | null;
    } | null;
  };
};

export type GraphQLRepoDetailsPage = {
  data?: Record<string, GraphQLRepoDetailNode | null>;
  errors?: Array<{ message?: string; type?: string }>;
};

export type ProjectCacheEntry = {
  signature: string;
  project: Omit<Project, "freshness">;
};

export const repoFragmentTtlSeconds = 30 * 60;

export class GitHubRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function rateLimitFromResponse(
  response: Response,
  pathname: string,
): GitHubRateLimitError | null {
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

export function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resetAtHeader(headers: Headers): string | null {
  const reset = numberHeader(headers, "x-ratelimit-reset");
  return reset === null ? null : new Date(reset * 1000).toISOString();
}

export function recordRateLimit(client: GitHubClient, response: Response): void {
  const limit = numberHeader(response.headers, "x-ratelimit-limit");
  const remaining = numberHeader(response.headers, "x-ratelimit-remaining");
  const resetAt = resetAtHeader(response.headers);
  const resource = response.headers.get("x-ratelimit-resource");
  if (limit === null && remaining === null && resetAt === null && resource === null) {
    return;
  }

  const replaceBucket =
    remaining !== null && (client.quota.remaining === null || remaining <= client.quota.remaining);
  client.quota = {
    ...client.quota,
    limit: replaceBucket ? (limit ?? client.quota.limit) : (client.quota.limit ?? limit),
    remaining: replaceBucket ? remaining : client.quota.remaining,
    resetAt: replaceBucket ? (resetAt ?? client.quota.resetAt) : (client.quota.resetAt ?? resetAt),
    resource: replaceBucket
      ? (resource ?? client.quota.resource)
      : (client.quota.resource ?? resource),
  };
}

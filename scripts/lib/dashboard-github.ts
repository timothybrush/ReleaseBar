import type { ApiQuota, CiState, Owner, Project } from "../../src/types.js";
import {
  type CiDetails,
  type GitHubCheckRun,
  type GitHubCheckRuns,
  type GitHubClient,
  type GitHubCommit,
  type GitHubCompare,
  GitHubRateLimitError,
  type GitHubRelease,
  type GitHubRepo,
  type GitHubStatusCheckRollup,
  type GraphQLRepoDetailsPage,
  type GraphQLRepoNode,
  type GraphQLRepoPage,
  type OwnerRepoCount,
  type OwnerReposPage,
  rateLimitFromResponse,
  recordRateLimit,
} from "./dashboard-contracts.js";
import { slugOwner } from "./dashboard-projects.js";

export function githubClient(
  token = "",
  fetcher: typeof fetch = fetch,
  quotaSource: ApiQuota["source"] = token ? "shared" : "anonymous",
  quotaAccount: string | null = null,
): GitHubClient {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ReleaseBar",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    fetch: fetcher,
    headers,
    graphqlCursors: new Map(),
    quota: {
      source: quotaSource,
      account: quotaAccount,
      remaining: null,
      limit: null,
      resetAt: null,
      resource: null,
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function github<T>(
  client: GitHubClient,
  pathname: string,
  ignoreStatuses: number[] = [404],
): Promise<T | null> {
  const response = await client.fetch(`https://api.github.com${pathname}`, {
    headers: client.headers,
  });
  recordRateLimit(client, response);
  const rateLimit = rateLimitFromResponse(response, pathname);
  if (rateLimit) throw rateLimit;
  if (ignoreStatuses.includes(response.status)) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }
  return githubJsonBody<T>(response, pathname);
}

export async function githubJsonBody<T>(response: Response, pathname: string): Promise<T | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`GitHub API invalid JSON for ${pathname}: ${errorMessage(error)}`);
  }
}

export async function githubPage<T>(
  client: GitHubClient,
  pathname: string,
  page: number,
  perPage = 100,
): Promise<T[]> {
  const joiner = pathname.includes("?") ? "&" : "?";
  return (await github<T[]>(client, `${pathname}${joiner}per_page=${perPage}&page=${page}`)) ?? [];
}

export async function githubPages<T>(client: GitHubClient, pathname: string): Promise<T[]> {
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

export async function githubGraphql<T>(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  if (!client.headers.Authorization) {
    return null;
  }
  const response = await client.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...client.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  recordRateLimit(client, response);
  if (response.headers.get("x-releasebar-github-backoff") === "graphql") {
    throw new GitHubRateLimitError("GitHub GraphQL temporarily paused after upstream errors", null);
  }
  const rateLimit = rateLimitFromResponse(response, "/graphql");
  if (rateLimit) throw rateLimit;
  if (!response.ok) {
    return null;
  }
  const body = await githubJsonBody<GraphQLRepoPage>(response, "/graphql");
  if (!body) return null;
  if (body.errors?.length) {
    const message = body.errors.map((error) => error.message ?? error.type).join("; ");
    if (/rate limit|secondary rate|api rate limit/i.test(message)) {
      throw new GitHubRateLimitError(`GitHub rate limit hit for /graphql`, null);
    }
    return null;
  }
  return body as T;
}

export const ownerReposQuery = /* GraphQL */ `
  query ReleaseBarOwnerRepos(
    $login: String!
    $first: Int!
    $after: String
    $includeReleases: Boolean!
  ) {
    repositoryOwner(login: $login) {
      __typename
      repositories(
        first: $first
        after: $after
        orderBy: { field: PUSHED_AT, direction: DESC }
        ownerAffiliations: OWNER
        privacy: PUBLIC
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          owner {
            login
            __typename
          }
          name
          nameWithOwner
          description
          url
          primaryLanguage {
            name
          }
          repositoryTopics(first: 6) {
            nodes {
              topic {
                name
              }
            }
          }
          stargazerCount
          forkCount
          issues(states: OPEN) {
            totalCount
          }
          pullRequests(states: OPEN) {
            totalCount
          }
          isArchived
          isFork
          isPrivate
          pushedAt
          updatedAt
          releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC })
            @include(if: $includeReleases) {
            nodes {
              tagName
              name
              url
              isDraft
              publishedAt
            }
          }
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
                committedDate
              }
            }
          }
        }
      }
    }
  }
`;

export const ownerRepoCountsQuery = /* GraphQL */ `
  query ReleaseBarOwnerCounts($login: String!, $first: Int!, $after: String) {
    repositoryOwner(login: $login) {
      repositories(
        first: $first
        after: $after
        orderBy: { field: PUSHED_AT, direction: DESC }
        ownerAffiliations: OWNER
        privacy: PUBLIC
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          nameWithOwner
          issues(states: OPEN) {
            totalCount
          }
          pullRequests(states: OPEN) {
            totalCount
          }
          isArchived
          isFork
          isPrivate
          pushedAt
          updatedAt
        }
      }
    }
  }
`;

export type GraphQLRepoCountNode = {
  nameWithOwner: string;
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
};

export type GraphQLRepoCountRepositories = {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: Array<GraphQLRepoCountNode | null>;
};

export type GraphQLRepoCountPage = {
  data?: {
    repositoryOwner?: null | {
      repositories: GraphQLRepoCountRepositories;
    };
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export async function fetchOwnerRepoCounts(options: {
  owner: string;
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
  fetch?: typeof fetch;
  limit?: number;
}): Promise<{ repos: OwnerRepoCount[]; quota: ApiQuota; complete: boolean }> {
  const client = githubClient(
    options.token,
    options.fetch,
    options.quotaSource,
    options.quotaAccount,
  );
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 200)));
  const repos: OwnerRepoCount[] = [];
  let after: string | null = null;
  let complete = false;
  while (repos.length < limit) {
    const first = Math.min(100, limit - repos.length);
    const body: GraphQLRepoCountPage | null = await githubGraphql<GraphQLRepoCountPage>(
      client,
      ownerRepoCountsQuery,
      {
        login: options.owner,
        first,
        after,
      },
    );
    const page: GraphQLRepoCountRepositories | undefined =
      body?.data?.repositoryOwner?.repositories;
    if (!page) {
      throw new Error(`GitHub GraphQL owner count query failed for ${options.owner}`);
    }
    repos.push(
      ...page.nodes
        .filter((node): node is GraphQLRepoCountNode => Boolean(node))
        .map((node) => ({
          fullName: node.nameWithOwner,
          openIssues: node.issues.totalCount,
          openPullRequests: node.pullRequests.totalCount,
          archived: node.isArchived,
          fork: node.isFork,
          private: node.isPrivate,
          pushedAt: node.pushedAt,
          updatedAt: node.updatedAt,
        })),
    );
    if (!page.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    if (!page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return { repos, quota: client.quota, complete };
}

export function graphQlRepo(node: GraphQLRepoNode): GitHubRepo {
  const latestRelease = node.releases?.nodes.find(
    (release) => release?.tagName && !release.isDraft && release.publishedAt,
  );
  return {
    owner: {
      login: node.owner.login,
      type: node.owner.__typename === "Organization" ? "Organization" : "User",
    },
    name: node.name,
    full_name: node.nameWithOwner,
    description: node.description,
    html_url: node.url,
    default_branch: node.defaultBranchRef?.name ?? "main",
    language: node.primaryLanguage?.name ?? null,
    topics:
      node.repositoryTopics?.nodes
        .map((topicNode) => topicNode?.topic?.name)
        .filter((name): name is string => Boolean(name)) ?? [],
    stargazers_count: node.stargazerCount,
    forks_count: node.forkCount,
    open_issues_count: node.issues.totalCount + node.pullRequests.totalCount,
    archived: node.isArchived,
    pushed_at: node.pushedAt,
    updated_at: node.updatedAt,
    fork: node.isFork,
    private: node.isPrivate,
    latest_release: latestRelease
      ? {
          tag_name: latestRelease.tagName,
          name: latestRelease.name,
          html_url: latestRelease.url,
          draft: latestRelease.isDraft,
          published_at: latestRelease.publishedAt,
        }
      : null,
    latest_commit:
      node.defaultBranchRef?.target && "oid" in node.defaultBranchRef.target
        ? {
            sha: node.defaultBranchRef.target.oid,
            commit: {
              committer: {
                date: node.defaultBranchRef.target.committedDate ?? undefined,
              },
            },
          }
        : null,
    status_check_rollup:
      node.defaultBranchRef?.target && "statusCheckRollup" in node.defaultBranchRef.target
        ? (node.defaultBranchRef.target.statusCheckRollup ?? null)
        : null,
    open_issues_total: node.issues.totalCount,
    open_pull_requests_total: node.pullRequests.totalCount,
  };
}

export async function ownerReposGraphqlPage(
  client: GitHubClient,
  owner: Owner,
  page: number,
  includeReleaseData: boolean,
  pageSize: number,
): Promise<OwnerReposPage | null> {
  const cursorKey = `${owner.type}:${slugOwner(owner.login)}`;
  const cursors = client.graphqlCursors.get(cursorKey) ?? [null];
  const after = cursors[page - 1];
  if (after === undefined) {
    return null;
  }
  const body = await githubGraphql<GraphQLRepoPage>(client, ownerReposQuery, {
    login: owner.login,
    first: pageSize,
    after,
    includeReleases: includeReleaseData,
  });
  const repositoryOwner = body?.data?.repositoryOwner;
  if (!repositoryOwner) {
    return null;
  }
  const repos = repositoryOwner.repositories.nodes
    .filter((node): node is GraphQLRepoNode => Boolean(node))
    .map(graphQlRepo);
  cursors[page] = repositoryOwner.repositories.pageInfo.hasNextPage
    ? repositoryOwner.repositories.pageInfo.endCursor
    : undefined;
  client.graphqlCursors.set(cursorKey, cursors);
  return {
    repos,
    hasNextPage: repositoryOwner.repositories.pageInfo.hasNextPage,
    cursor: after,
  };
}

export function repoDetailsQuery(repos: GitHubRepo[]): string {
  const fields = repos
    .map((repo, index) => {
      const [owner, name] = repo.full_name.split("/");
      return `
        r${index}: repository(owner: ${JSON.stringify(owner ?? "")}, name: ${JSON.stringify(
          name ?? "",
        )}) {
          nameWithOwner
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
                committedDate
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        detailsUrl
                        completedAt
                        startedAt
                      }
                      ... on StatusContext {
                        context
                        state
                        targetUrl
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
    })
    .join("\n");
  return `query ReleaseBarRepoDetails { ${fields} }`;
}

export async function hydrateRepoDetailsGraphql(
  client: GitHubClient,
  repos: GitHubRepo[],
): Promise<Map<string, Partial<GitHubRepo>>> {
  const details = new Map<string, Partial<GitHubRepo>>();
  const candidates = repos.filter((repo) => repo.full_name.includes("/"));
  if (candidates.length === 0 || !client.headers.Authorization) return details;
  const body = await githubGraphql<GraphQLRepoDetailsPage>(
    client,
    repoDetailsQuery(candidates),
    {},
  );
  for (const node of Object.values(body?.data ?? {})) {
    if (!node?.nameWithOwner) continue;
    const target = node.defaultBranchRef?.target;
    const detail: Partial<GitHubRepo> = {};
    if (node.defaultBranchRef?.name) {
      detail.default_branch = node.defaultBranchRef.name;
    }
    if (target && "oid" in target) {
      detail.latest_commit = {
        sha: target.oid,
        commit: {
          committer: {
            date: target.committedDate ?? undefined,
          },
        },
      };
      if ("statusCheckRollup" in target) {
        detail.status_check_rollup = target.statusCheckRollup ?? null;
      }
    }
    details.set(node.nameWithOwner.toLowerCase(), detail);
  }
  return details;
}

export async function hydrateRepoDetailsOrEmpty(
  client: GitHubClient,
  repos: GitHubRepo[],
): Promise<Map<string, Partial<GitHubRepo>>> {
  return hydrateRepoDetailsGraphql(client, repos).catch((error: unknown) => {
    if (error instanceof GitHubRateLimitError) throw error;
    return new Map<string, Partial<GitHubRepo>>();
  });
}

export function repoWithGraphqlDetails(
  repo: GitHubRepo,
  details: Map<string, Partial<GitHubRepo>>,
): GitHubRepo {
  const detail = details.get(repo.full_name.toLowerCase());
  return detail ? { ...repo, ...detail } : repo;
}

export async function githubCount(client: GitHubClient, pathname: string): Promise<number> {
  const joiner = pathname.includes("?") ? "&" : "?";
  const response = await client.fetch(`https://api.github.com${pathname}${joiner}per_page=1`, {
    headers: client.headers,
  });
  recordRateLimit(client, response);
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

  const items = (await githubJsonBody<unknown[]>(response, pathname)) ?? [];
  return items.length;
}

export async function repoWithSplitIssueCounts(
  client: GitHubClient,
  repo: GitHubRepo,
): Promise<GitHubRepo> {
  if (repo.open_issues_total !== undefined && repo.open_pull_requests_total !== undefined) {
    return repo;
  }
  if (repo.open_issues_count === 0) {
    return {
      ...repo,
      open_issues_total: 0,
      open_pull_requests_total: 0,
    };
  }
  const openPullRequests =
    repo.open_pull_requests_total ??
    (await githubCount(client, `/repos/${repo.full_name}/pulls?state=open`));
  return {
    ...repo,
    open_issues_total:
      repo.open_issues_total ?? Math.max(repo.open_issues_count - openPullRequests, 0),
    open_pull_requests_total: openPullRequests,
  };
}

export async function ownerReposPage(
  client: GitHubClient,
  owner: Owner,
  includeReleaseData: boolean,
  page: number,
  requestedPageSize = 100,
): Promise<OwnerReposPage> {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(requestedPageSize)));
  const graphqlPage = await ownerReposGraphqlPage(
    client,
    owner,
    page,
    includeReleaseData,
    pageSize,
  );
  if (graphqlPage) {
    return graphqlPage;
  }
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  const path = `${base}?type=public&sort=pushed&direction=desc`;
  const repos = await githubPage<GitHubRepo>(client, path, page, pageSize);
  if (!client.headers.Authorization) {
    return {
      repos: repos.map((repo) =>
        repo.open_issues_count === 0
          ? {
              ...repo,
              open_issues_total: 0,
              open_pull_requests_total: 0,
            }
          : repo,
      ),
      hasNextPage: repos.length === pageSize,
    };
  }
  if (includeReleaseData) {
    return { repos, hasNextPage: repos.length === pageSize };
  }
  const splitRepos: GitHubRepo[] = [];
  for (let index = 0; index < repos.length; index += 12) {
    splitRepos.push(
      ...(await Promise.all(
        repos.slice(index, index + 12).map((repo) => repoWithSplitIssueCounts(client, repo)),
      )),
    );
  }
  return { repos: splitRepos, hasNextPage: repos.length === pageSize };
}

export async function ownerRepos(
  client: GitHubClient,
  owner: Owner,
  includeReleaseData: boolean,
): Promise<GitHubRepo[]> {
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  const path = `${base}?type=public&sort=pushed&direction=desc`;
  if (!client.headers.Authorization) {
    return githubPages<GitHubRepo>(client, path);
  }
  const repos: GitHubRepo[] = [];
  for (let page = 1; ; page += 1) {
    const next = await ownerReposPage(client, owner, includeReleaseData, page);
    repos.push(...next.repos);
    if (!next.hasNextPage) return repos;
  }
}

export async function repoByFullName(
  client: GitHubClient,
  fullName: string,
): Promise<GitHubRepo | null> {
  return github<GitHubRepo>(client, `/repos/${fullName}`, [404]);
}

export async function latestRelease(
  client: GitHubClient,
  repo: GitHubRepo,
): Promise<GitHubRelease | null> {
  if (repo.latest_release !== undefined) {
    const release = repo.latest_release;
    return release?.tag_name && !release.draft && release.published_at ? release : null;
  }
  const releases = await github<GitHubRelease[]>(
    client,
    `/repos/${repo.full_name}/releases?per_page=10`,
  );
  return (
    releases?.find((release) => release.tag_name && !release.draft && release.published_at) ?? null
  );
}

export async function checkRuns(
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

export function ciDetails(runs: GitHubCheckRun[]): CiDetails {
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

export function normalizeGraphqlState(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

export function ciDetailsFromRollup(
  rollup: GitHubStatusCheckRollup | null | undefined,
): CiDetails | null {
  if (!rollup) return null;
  const contexts =
    rollup.contexts?.nodes.filter((node): node is NonNullable<typeof node> => Boolean(node)) ?? [];
  const total = rollup.contexts?.totalCount ?? contexts.length;
  if (total === 0 && !rollup.state) return null;

  const failure = contexts.find((context) =>
    ["failure", "timed_out", "action_required", "error"].includes(
      normalizeGraphqlState(context.conclusion ?? context.state),
    ),
  );
  const active = contexts.find((context) =>
    ["queued", "in_progress", "requested", "waiting", "pending", "expected"].includes(
      normalizeGraphqlState(context.status ?? context.state),
    ),
  );
  const cancelled = contexts.find(
    (context) => normalizeGraphqlState(context.conclusion) === "cancelled",
  );
  const successCount = contexts.filter((context) =>
    ["success", "successful"].includes(normalizeGraphqlState(context.conclusion ?? context.state)),
  ).length;
  const neutralCount = contexts.filter(
    (context) => normalizeGraphqlState(context.conclusion ?? context.state) === "neutral",
  ).length;
  const skippedCount = contexts.filter(
    (context) => normalizeGraphqlState(context.conclusion ?? context.state) === "skipped",
  ).length;
  const selected = failure ?? active ?? cancelled ?? contexts[0] ?? null;
  const rollupState = normalizeGraphqlState(rollup.state);

  let state: CiState = "unknown";
  if (failure || ["failure", "error"].includes(rollupState)) {
    state = "failure";
  } else if (active || ["pending", "expected"].includes(rollupState)) {
    state =
      normalizeGraphqlState(active?.status ?? active?.state) === "in_progress"
        ? "running"
        : "pending";
  } else if (cancelled) {
    state = "cancelled";
  } else if (successCount > 0 || rollupState === "success") {
    state = "success";
  } else if (neutralCount > 0) {
    state = "neutral";
  } else if (skippedCount > 0) {
    state = "skipped";
  }

  const selectedName = selected?.name ?? selected?.context ?? null;
  return {
    state,
    status: selected?.status ?? selected?.state ?? rollup.state,
    conclusion: selected?.conclusion ?? selected?.state ?? rollup.state,
    workflow:
      state === "success" && total > 0 ? `${successCount || total}/${total} checks` : selectedName,
    url: selected?.detailsUrl ?? selected?.targetUrl ?? null,
    runDate: selected?.completedAt ?? selected?.startedAt ?? selected?.createdAt ?? null,
  };
}

export async function repoSummary(
  client: GitHubClient,
  repo: GitHubRepo,
  includeUnreleased: boolean,
): Promise<Omit<Project, "freshness"> | null> {
  const release = await latestRelease(client, repo);
  if (!release?.tag_name) {
    if (!includeUnreleased) {
      return null;
    }
  }

  let commitsSinceRelease: number | null = null;
  let compareUrl: string | null = null;
  const latestCommit =
    repo.latest_commit ??
    (await github<GitHubCommit>(
      client,
      `/repos/${repo.full_name}/commits/${repo.default_branch}`,
      [404, 409],
    ));
  const latestRef = latestCommit?.sha ?? repo.default_branch;
  const [compare, openPullRequests, checks] = await Promise.all([
    release?.tag_name
      ? github<GitHubCompare>(
          client,
          `/repos/${repo.full_name}/compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
        )
      : Promise.resolve(null),
    repo.open_pull_requests_total ??
      githubCount(client, `/repos/${repo.full_name}/pulls?state=open`),
    repo.status_check_rollup || !latestCommit
      ? Promise.resolve([])
      : checkRuns(client, repo, latestRef),
  ]);
  commitsSinceRelease = compare?.total_commits ?? null;
  compareUrl = compare?.html_url ?? null;
  const ci = ciDetailsFromRollup(repo.status_check_rollup) ?? ciDetails(checks);

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
    openIssues: repo.open_issues_total ?? Math.max(repo.open_issues_count - openPullRequests, 0),
    openPullRequests,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived,
    fork: repo.fork,
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

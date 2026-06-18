import { slugOwner } from "../scripts/lib/dashboard.js";
import type { ApiQuota, Project, RepoDetailPayload } from "../src/types.js";
import {
  githubGraphqlAuditPath,
  graphqlBackoffActive,
  markGraphqlBackoff,
  quotaFromGitHubResponse,
  recordAuditedGitHubAccess,
  sharedQuotaConservation,
} from "./github-audit.js";
import { workerFetch } from "./http.js";
import type { Env } from "./runtime.js";
import {
  gitHubCheckRunsSchema,
  gitHubCodeFrequencySchema,
  gitHubCommitActivitySchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubLanguageSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
} from "./schemas.js";
import * as v from "valibot";
import type { InferOutput } from "valibot";
import { releaseProject } from "./audience-data.js";
import { bestInstallationToken } from "./auth-tokens.js";
import {
  githubGraphqlRepoDetailCoreOperation,
  localRepoDetailBuilds,
  repoDetailLiveProbeCacheTtlMs,
  repoDetailReleaseCacheTtlMs,
} from "./config.js";
import { acquireBuildLock, sleep } from "./dashboard-rebuild.js";
import {
  cachedContributorTrustSignals,
  optionalRepoDetail,
  readRepoDetail,
  releaseSummaryState,
  type RepoDetailCore,
  type RepoDetailCredential,
  writeRepoDetail,
} from "./release-summary.js";
import {
  buildWorkTrend,
  cachedDetailGitHubCount,
  cachedDetailGitHubJson,
  detailGitHubStats,
  readRepoDetailAux,
  repoDetailAuxCacheKey,
  writeRepoDetailAux,
} from "./repo-github.js";

export type RepoDetailCoreGraphqlResponse = {
  data?: {
    repository?: {
      owner?: { login?: string };
      name?: string;
      nameWithOwner?: string;
      description?: string | null;
      url?: string;
      isPrivate?: boolean;
      isFork?: boolean;
      isArchived?: boolean;
      primaryLanguage?: { name?: string } | null;
      repositoryTopics?: { nodes?: Array<{ topic?: { name?: string } | null } | null> };
      stargazerCount?: number;
      forkCount?: number;
      issues?: { totalCount?: number };
      pullRequests?: { totalCount?: number };
      pushedAt?: string | null;
      updatedAt?: string | null;
      defaultBranchRef?: {
        name?: string;
        target?: {
          oid?: string;
          committedDate?: string | null;
          statusCheckRollup?: {
            contexts?: {
              nodes?: Array<{
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
            };
          } | null;
        } | null;
      } | null;
      releases?: {
        nodes?: Array<{
          tagName?: string;
          name?: string | null;
          url?: string;
          isDraft?: boolean;
          isPrerelease?: boolean;
          publishedAt?: string | null;
        } | null>;
      };
    } | null;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export const repoDetailCoreQuery = /* GraphQL */ `
  query ReleaseBarRepoDetailCore($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      owner {
        login
      }
      name
      nameWithOwner
      description
      url
      isPrivate
      isFork
      isArchived
      primaryLanguage {
        name
      }
      repositoryTopics(first: 20) {
        nodes {
          topic {
            name
          }
        }
      }
      stargazerCount
      forkCount
      issues(states: OPEN, first: 1) {
        totalCount
      }
      pullRequests(states: OPEN, first: 1) {
        totalCount
      }
      pushedAt
      updatedAt
      defaultBranchRef {
        name
        target {
          ... on Commit {
            oid
            committedDate
            statusCheckRollup {
              contexts(first: 100) {
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
      releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          tagName
          name
          url
          isDraft
          isPrerelease
          publishedAt
        }
      }
    }
  }
`;

export async function repoDetailCredential(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<RepoDetailCredential> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  return {
    token: requestToken?.token ?? env.GITHUB_TOKEN ?? null,
    quotaSource: requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous"),
    quotaAccount: requestToken?.quotaAccount ?? null,
  };
}

export function lowerNullable(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function statusContextState(value: string | null | undefined): {
  status: string;
  conclusion: string | null;
} {
  const state = lowerNullable(value);
  if (state === "pending" || state === "expected") {
    return { status: "in_progress", conclusion: null };
  }
  if (state === "error" || state === "failure") {
    return { status: "completed", conclusion: "failure" };
  }
  return { status: "completed", conclusion: state };
}

export async function repoDetailCoreGraphql(
  fullName: string,
  owner: string,
  repoName: string,
  credential: RepoDetailCredential,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<RepoDetailCore> {
  const cacheKey = repoDetailAuxCacheKey(fullName, "core-graphql", fullName);
  const cached = await readRepoDetailAux<RepoDetailCore>(
    env,
    cacheKey,
    repoDetailLiveProbeCacheTtlMs,
  );
  if (cached) return cached;
  if (
    await graphqlBackoffActive(
      env,
      credential.quotaSource,
      credential.quotaAccount,
      githubGraphqlRepoDetailCoreOperation,
    )
  ) {
    throw new Error("GitHub GraphQL repository detail backoff active");
  }
  const response = await workerFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      query: repoDetailCoreQuery,
      variables: { owner, name: repoName },
    }),
  });
  const quota = quotaFromGitHubResponse(response, credential.quotaSource, credential.quotaAccount);
  onQuota(quota);
  await recordAuditedGitHubAccess(
    env,
    "repo-detail",
    githubGraphqlAuditPath(githubGraphqlRepoDetailCoreOperation),
    response.status,
    quota,
    false,
  );
  if (response.status >= 500 && response.status < 600) {
    await markGraphqlBackoff(
      env,
      quota.source,
      quota.account,
      githubGraphqlRepoDetailCoreOperation,
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as RepoDetailCoreGraphqlResponse | null;
  const message = body?.errors
    ?.map((error) => error.message ?? error.type)
    .filter(Boolean)
    .join("; ");
  if (!response.ok || body?.errors?.length) {
    throw new Error(message || `GitHub GraphQL ${response.status}`);
  }
  const node = body?.data?.repository;
  const defaultBranch = node?.defaultBranchRef?.name;
  if (
    !node?.owner?.login ||
    !node.name ||
    !node.nameWithOwner ||
    !node.url ||
    !defaultBranch ||
    typeof node.stargazerCount !== "number" ||
    typeof node.forkCount !== "number" ||
    typeof node.issues?.totalCount !== "number" ||
    typeof node.pullRequests?.totalCount !== "number"
  ) {
    throw new Error("GitHub GraphQL returned incomplete repository detail");
  }
  const target = node.defaultBranchRef?.target;
  const latestCommit = target?.oid
    ? {
        sha: target.oid,
        commit: {
          committer: {
            date: target.committedDate ?? null,
          },
        },
      }
    : null;
  const checkRuns = (target?.statusCheckRollup?.contexts?.nodes ?? []).flatMap((context) => {
    if (!context) return [];
    const legacy =
      context.__typename === "StatusContext" ? statusContextState(context.state) : null;
    return [
      {
        name: context.name ?? context.context ?? null,
        html_url: context.detailsUrl ?? context.targetUrl ?? "",
        status: legacy?.status ?? lowerNullable(context.status),
        conclusion: legacy?.conclusion ?? lowerNullable(context.conclusion),
        completed_at: context.completedAt ?? context.createdAt ?? null,
        started_at: context.startedAt ?? context.createdAt ?? null,
      },
    ];
  });
  const core: RepoDetailCore = {
    repo: {
      owner: { login: node.owner.login },
      name: node.name,
      full_name: node.nameWithOwner,
      private: node.isPrivate ?? false,
      fork: node.isFork ?? false,
      archived: node.isArchived ?? false,
      html_url: node.url,
      description: node.description ?? null,
      default_branch: defaultBranch,
      language: node.primaryLanguage?.name ?? null,
      topics: (node.repositoryTopics?.nodes ?? []).flatMap((topic) =>
        topic?.topic?.name ? [topic.topic.name] : [],
      ),
      stargazers_count: node.stargazerCount,
      forks_count: node.forkCount,
      open_issues_count: node.issues.totalCount + node.pullRequests.totalCount,
      pushed_at: node.pushedAt ?? null,
      updated_at: node.updatedAt ?? null,
    },
    releases: (node.releases?.nodes ?? []).flatMap((release) =>
      release?.tagName && release.url
        ? [
            {
              tag_name: release.tagName,
              name: release.name ?? null,
              html_url: release.url,
              draft: release.isDraft ?? false,
              prerelease: release.isPrerelease ?? false,
              published_at: release.publishedAt ?? null,
            },
          ]
        : [],
    ),
    latestCommit,
    openPullRequests: node.pullRequests.totalCount,
    checks: { check_runs: checkRuns },
  };
  if (!core.repo.private) {
    await writeRepoDetailAux(env, cacheKey, core);
  }
  return core;
}

export async function buildRepoDetail(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
  options: { credential?: RepoDetailCredential; enrich?: boolean } = {},
): Promise<RepoDetailPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const credential =
    options.credential ?? (await repoDetailCredential(owner, repoName, request, env));
  const { token, quotaSource, quotaAccount } = credential;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const graphqlCore =
    credential.quotaSource === "app" && credential.token
      ? await repoDetailCoreGraphql(fullName, owner, repoName, credential, onQuota, env).catch(
          () => null,
        )
      : null;
  const repo =
    graphqlCore?.repo ??
    (await cachedDetailGitHubJson(
      fullName,
      "repository",
      path,
      gitHubRepositorySchema,
      "repository detail",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      undefined,
      undefined,
      env,
      repoDetailReleaseCacheTtlMs,
      (repository) => {
        if (repository.private) {
          throw new Error("private repositories are not visible in public dashboards");
        }
      },
    ));
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }

  const [releases, latestCommit, openPullRequests] = graphqlCore
    ? [graphqlCore.releases, graphqlCore.latestCommit, graphqlCore.openPullRequests]
    : await Promise.all([
        cachedDetailGitHubJson(
          fullName,
          "releases",
          `${path}/releases?per_page=100`,
          v.array(gitHubReleaseSchema),
          "repository releases",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          undefined,
          env,
          repoDetailReleaseCacheTtlMs,
        ),
        optionalRepoDetail(
          cachedDetailGitHubJson(
            fullName,
            "latest-commit",
            `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
            gitHubCommitSchema,
            "latest commit",
            token,
            quotaSource,
            quotaAccount,
            onQuota,
            undefined,
            undefined,
            env,
            repoDetailLiveProbeCacheTtlMs,
          ),
          null,
        ),
        cachedDetailGitHubCount(
          fullName,
          "open-pulls",
          `${path}/pulls?state=open&per_page=1`,
          repoDetailLiveProbeCacheTtlMs,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          env,
        ),
      ]);

  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        cachedDetailGitHubJson(
          fullName,
          "compare",
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "release compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          undefined,
          env,
          repoDetailLiveProbeCacheTtlMs,
        ),
        null,
      )
    : null;
  const checks =
    graphqlCore?.checks ??
    (latestCommit?.sha
      ? await optionalRepoDetail(
          cachedDetailGitHubJson(
            fullName,
            "check-runs",
            `${path}/commits/${encodeURIComponent(latestCommit.sha)}/check-runs?per_page=100`,
            gitHubCheckRunsSchema,
            "repository check runs",
            token,
            quotaSource,
            quotaAccount,
            onQuota,
            undefined,
            undefined,
            env,
            repoDetailLiveProbeCacheTtlMs,
          ),
          null,
        )
      : null);

  const conservation =
    quotaSource === "shared" ? await sharedQuotaConservation(env).catch(() => null) : null;
  const enrich = options.enrich !== false && !conservation?.active;
  const enrichmentMessage = enrich
    ? null
    : "Detailed repository statistics are deferred while shared GitHub quota recovers.";
  const [contributors, languages] = enrich
    ? await Promise.all([
        optionalRepoDetail(
          cachedDetailGitHubJson(
            fullName,
            "contributors",
            `${path}/contributors?per_page=12`,
            v.array(gitHubContributorSchema),
            "repository contributors",
            token,
            quotaSource,
            quotaAccount,
            onQuota,
            undefined,
            undefined,
            env,
          ),
          [],
        ),
        optionalRepoDetail(
          cachedDetailGitHubJson(
            fullName,
            "languages",
            `${path}/languages`,
            gitHubLanguageSchema,
            "repository languages",
            token,
            quotaSource,
            quotaAccount,
            onQuota,
            undefined,
            undefined,
            env,
          ),
          {},
        ),
      ])
    : [[], {}];
  const [commitActivity, workTrend] = enrich
    ? await Promise.all([
        detailGitHubStats(
          fullName,
          `${path}/stats/commit_activity`,
          gitHubCommitActivitySchema,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          env,
        ),
        buildWorkTrend(
          repo.full_name,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          env,
        ).catch(() => null),
      ])
    : [
        {
          state: "warming" as const,
          data: null,
          message: enrichmentMessage ?? undefined,
        },
        null,
      ];
  const codeFrequency =
    !enrich || commitActivity.state === "warming"
      ? {
          state: "warming" as const,
          data: null,
          message:
            enrichmentMessage ??
            commitActivity.message ??
            "GitHub is preparing repository statistics.",
        }
      : await detailGitHubStats(
          fullName,
          `${path}/stats/code_frequency`,
          gitHubCodeFrequencySchema,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          env,
        );
  const statsWarming =
    !enrich || [commitActivity, codeFrequency].some((stat) => stat.state === "warming");
  const project = releaseProject(repo);
  project.openPullRequests = openPullRequests;
  project.openIssues = Math.max(repo.open_issues_count - openPullRequests, 0);
  project.latestCommitSha = latestCommit?.sha.slice(0, 7) ?? null;
  project.latestCommitDate = latestCommit?.commit.committer?.date ?? null;
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  const ci = detailCiDetails(checks?.check_runs ?? []);
  project.ciStatus = ci.ciStatus;
  project.ciConclusion = ci.ciConclusion;
  project.ciWorkflow = ci.ciWorkflow;
  project.ciUrl = ci.ciUrl;
  project.ciRunDate = ci.ciRunDate;
  project.ciState = ci.ciState;
  const [releaseSummary, contributorTrustSignals] = await Promise.all([
    releaseSummaryState(project, env),
    cachedContributorTrustSignals(env, contributors),
  ]);

  const generatedAt = new Date().toISOString();
  return {
    fullName: repo.full_name,
    generatedAt,
    cache: {
      state: statsWarming ? "warming" : "fresh",
      stale: statsWarming,
      generatedAt,
      ...(statsWarming
        ? {
            message:
              enrichmentMessage ??
              commitActivity.message ??
              codeFrequency.message ??
              "GitHub is preparing repository statistics.",
          }
        : {}),
      ...(quota ? { quota } : {}),
    },
    stats: {
      commitActivity: {
        state: commitActivity.state,
        ...(commitActivity.message ? { message: commitActivity.message } : {}),
      },
      codeFrequency: {
        state: codeFrequency.state,
        ...(codeFrequency.message ? { message: codeFrequency.message } : {}),
      },
    },
    releaseSummary,
    project,
    releases: releases
      .filter((release) => !release.draft)
      .map((release) => ({
        name: release.name,
        tagName: release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        prerelease: release.prerelease ?? false,
      })),
    contributors: contributors.map((contributor) => {
      const login = contributor.login ?? "anonymous";
      const trustSignal = contributorTrustSignals.get(slugOwner(login));
      return {
        login,
        avatarUrl: contributor.avatar_url ?? null,
        url: contributor.html_url ?? null,
        commits: contributor.contributions,
        ...(trustSignal ? { trustScore: trustSignal.score, trustTier: trustSignal.tier } : {}),
      };
    }),
    commitActivity: (commitActivity.data ?? []).map((week) => ({
      week: new Date(week.week * 1000).toISOString(),
      total: week.total,
      days: week.days,
    })),
    codeFrequency: (codeFrequency.data ?? []).map(([week, additions, deletions]) => ({
      week: new Date(week * 1000).toISOString(),
      additions,
      deletions: Math.abs(deletions),
    })),
    languages: Object.entries(languages)
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    workTrend,
  };
}

export function freshnessForDetail(commits: number | null): Project["freshness"] {
  if (commits === 0) return "fresh";
  if (commits !== null && commits <= 5) return "warm";
  if (commits !== null && commits <= 25) return "busy";
  return "hot";
}

export type DetailCheckRun = NonNullable<
  InferOutput<typeof gitHubCheckRunsSchema>["check_runs"]
>[number];

export function detailCiDetails(
  runs: DetailCheckRun[],
): Pick<Project, "ciState" | "ciStatus" | "ciConclusion" | "ciWorkflow" | "ciUrl" | "ciRunDate"> {
  if (runs.length === 0) {
    return {
      ciState: "unknown",
      ciStatus: null,
      ciConclusion: null,
      ciWorkflow: null,
      ciUrl: null,
      ciRunDate: null,
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

  let ciState: Project["ciState"] = "unknown";
  if (failure) {
    ciState = "failure";
  } else if (active) {
    ciState = active.status === "in_progress" ? "running" : "pending";
  } else if (cancelled) {
    ciState = "cancelled";
  } else if (successCount > 0) {
    ciState = "success";
  } else if (neutralCount > 0) {
    ciState = "neutral";
  } else if (skippedCount > 0) {
    ciState = "skipped";
  }

  return {
    ciState,
    ciStatus: selected.status ?? null,
    ciConclusion: selected.conclusion ?? null,
    ciWorkflow:
      ciState === "success" ? `${successCount}/${runs.length} checks` : (selected.name ?? null),
    ciUrl: selected.html_url ?? null,
    ciRunDate: selected.completed_at ?? selected.started_at ?? null,
  };
}

export async function refreshRepoDetail(
  key: string,
  owner: string,
  repo: string,
  request: Request,
  env: Env,
  credential?: RepoDetailCredential,
): Promise<void> {
  await buildRepoDetailSingleFlight(key, owner, repo, request, env, credential);
}

export async function buildRepoDetailSingleFlight(
  key: string,
  owner: string,
  repo: string,
  request: Request,
  env: Env,
  credential?: RepoDetailCredential,
): Promise<RepoDetailPayload | null> {
  const local = localRepoDetailBuilds.get(key);
  if (local) return local;
  const build = (async () => {
    const lock = await acquireBuildLock(env, `${key}:refresh`);
    if (!lock) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(250);
        const cached = await readRepoDetail(env, key);
        if (cached) return cached;
      }
      return null;
    }
    try {
      const payload = await buildRepoDetail(owner, repo, request, env, { credential });
      await writeRepoDetail(env, key, payload);
      return payload;
    } finally {
      await lock.release();
    }
  })();
  localRepoDetailBuilds.set(key, build);
  try {
    return await build;
  } finally {
    if (localRepoDetailBuilds.get(key) === build) {
      localRepoDetailBuilds.delete(key);
    }
  }
}

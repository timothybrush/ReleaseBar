import {
  type AudienceOrgSignal,
  type AudienceRepoSignal,
  type AudienceScoreTier,
  calculateAudienceScore,
} from "../scripts/lib/audience.js";
import { GitHubRateLimitError, slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type {
  ApiQuota,
  AudienceRange,
  Project,
  RepoAudiencePayload,
  RepoAudienceUser,
  RepoDetailPayload,
  TrustProfilePayload,
} from "../src/types.js";
import {
  type GitHubAuditArea,
  githubGraphqlAuditPath,
  githubGraphqlBackoffSeconds,
  graphqlBackoffActive,
  isRateLimitResponse,
  markGraphqlBackoff,
  parseHeaderInt,
  quotaFromGitHubResponse,
  recordAuditedGitHubAccess,
  responseRateLimitSignal,
} from "./github-audit.js";
import { workerFetch } from "./http.js";
import type { Env } from "./runtime.js";
import {
  gitHubRepositorySchema,
  type GitHubStargazer,
  gitHubStargazerListSchema,
  type GitHubUserOrganization,
  gitHubUserOrganizationListSchema,
  type GitHubUserProfile,
  gitHubUserProfileSchema,
  type GitHubUserRepository,
  gitHubUserRepositoryListSchema,
  safeJsonParse,
  tryJsonParse,
} from "./schemas.js";
import type { InferOutput } from "valibot";
import { buildTrustProfile } from "./audience.js";
import {
  dashboardStorageTtlSeconds,
  githubGraphqlRepoStargazersOperation,
  repoAudienceStargazerLimit,
  repoAudienceUserRepoLimit,
  repoAudienceUserTtlSeconds,
  type UserTrustSignal,
} from "./config.js";
import { isGitHubRateLimit } from "./dashboard-cache.js";
import { acquireBuildLock } from "./dashboard-rebuild.js";
import { privateRepositoryNames } from "./owner-metadata-read.js";
import { detailGitHubJson, detailGitHubJsonWithHeaders } from "./repo-github.js";

export function lastPageFromLink(link: string | null): number | null {
  if (!link) return null;
  const last = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel="last"/.test(part));
  const match = last?.match(/[?&]page=(\d+)/);
  if (!match?.[1]) return null;
  const page = Number.parseInt(match[1], 10);
  return Number.isFinite(page) ? page : null;
}

export function releaseProject(repo: InferOutput<typeof gitHubRepositorySchema>): Project {
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
    openIssues: repo.open_issues_count,
    openPullRequests: 0,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived ?? false,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "unreleased",
    releaseName: null,
    releaseUrl: repo.html_url,
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

export function audienceRangeFromUrl(url: URL): AudienceRange {
  return url.searchParams.get("range")?.toLowerCase() === "week" ? "week" : "month";
}

export function audienceRangeMs(range: AudienceRange): number {
  return range === "week" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

export function repoAudienceCacheKey(owner: string, repo: string, range: AudienceRange): string {
  return `repo-audience:v5:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

export function repoAudienceUserKey(login: string): string {
  return `audience-user:v1:${slugOwner(login)}`;
}

export function repoAudienceUserOrgsKey(login: string): string {
  return `audience-user-orgs:v1:${slugOwner(login)}`;
}

export function repoAudienceUserReposKey(login: string): string {
  return `audience-user-repos:v2:${slugOwner(login)}`;
}

export function repoAudienceAgeMs(payload: RepoAudiencePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export async function readRepoAudience(env: Env, key: string): Promise<RepoAudiencePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  const payload = raw ? tryJsonParse<RepoAudiencePayload>(raw, `repo audience ${key}`) : null;
  return payload ? publicRepoAudience(env, payload) : null;
}

export async function writeRepoAudience(
  env: Env,
  key: string,
  payload: RepoAudiencePayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readAudienceUser(env: Env, login: string): Promise<GitHubUserProfile | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserKey(login));
  return raw ? safeJsonParse(gitHubUserProfileSchema, raw, `audience user ${login}`) : null;
}

export async function writeAudienceUser(env: Env, user: GitHubUserProfile): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserKey(user.login), JSON.stringify(user), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

export async function readAudienceUserOrgs(
  env: Env,
  login: string,
): Promise<GitHubUserOrganization[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserOrgsKey(login));
  return raw
    ? safeJsonParse(gitHubUserOrganizationListSchema, raw, `audience user orgs ${login}`)
    : null;
}

export async function writeAudienceUserOrgs(
  env: Env,
  login: string,
  orgs: GitHubUserOrganization[],
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserOrgsKey(login), JSON.stringify(orgs), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

export async function readAudienceUserRepos(
  env: Env,
  login: string,
): Promise<GitHubUserRepository[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserReposKey(login));
  const repos = raw
    ? safeJsonParse(gitHubUserRepositoryListSchema, raw, `audience user repos ${login}`)
    : null;
  return repos ? publicAudienceRepositories(env, repos) : null;
}

export async function writeAudienceUserRepos(
  env: Env,
  login: string,
  repos: GitHubUserRepository[],
): Promise<void> {
  const publicRepos = await publicAudienceRepositories(env, repos);
  if (!publicRepos) return;
  await env.DASHBOARD_CACHE?.put(repoAudienceUserReposKey(login), JSON.stringify(publicRepos), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

export async function audienceUserProfile(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserProfile | null> {
  const cached = await readAudienceUser(env, login);
  if (cached) return cached;
  const user = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}`,
    gitHubUserProfileSchema,
    "audience user profile",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  await writeAudienceUser(env, user);
  return user;
}

export async function recentRepoStargazers(
  owner: string,
  repo: string,
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[]> {
  const graphql = await recentRepoStargazersGraphql(
    owner,
    repo,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (graphql) return graphql;
  return recentRepoStargazersRest(path, token, quotaSource, quotaAccount, onQuota, env);
}

export async function recentRepoStargazersRest(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[]> {
  const firstPath = `${path}/stargazers?per_page=${repoAudienceStargazerLimit}`;
  const firstPage = await detailGitHubJsonWithHeaders(
    firstPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  if (!firstPage.data) {
    throw new Error("GitHub returned no repository stargazer data");
  }
  const lastPage = lastPageFromLink(firstPage.headers.get("link"));
  if (!lastPage || lastPage <= 1) return firstPage.data;
  const lastPath = `${firstPath}&page=${lastPage}`;
  const last = await detailGitHubJson(
    lastPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  if (last.length >= repoAudienceStargazerLimit) return last;
  const previous = await detailGitHubJson(
    `${firstPath}&page=${lastPage - 1}`,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  return [...previous, ...last].slice(-repoAudienceStargazerLimit);
}

export type GraphQLStargazerEdge = {
  starredAt: string | null;
  node: {
    login: string;
    avatarUrl: string;
    url: string;
    __typename?: string;
  } | null;
};

export type GraphQLStargazerResponse = {
  data?: {
    repository?: {
      stargazers?: {
        edges?: GraphQLStargazerEdge[];
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export const repoStargazersQuery = /* GraphQL */ `
  query ReleaseBarRepoStargazers($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      stargazers(first: $first, orderBy: { field: STARRED_AT, direction: DESC }) {
        edges {
          starredAt
          node {
            __typename
            login
            avatarUrl
            url
          }
        }
      }
    }
  }
`;

export async function recentRepoStargazersGraphql(
  owner: string,
  repo: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[] | null> {
  if (!token) return null;
  if (
    await graphqlBackoffActive(env, quotaSource, quotaAccount, githubGraphqlRepoStargazersOperation)
  ) {
    if (quotaSource === "shared") {
      throw new GitHubRateLimitError("GitHub GraphQL backoff active", githubGraphqlBackoffSeconds);
    }
    return null;
  }
  const response = await workerFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      query: repoStargazersQuery,
      variables: { owner, name: repo, first: repoAudienceStargazerLimit },
    }),
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(
    env,
    "repo-audience",
    githubGraphqlAuditPath(githubGraphqlRepoStargazersOperation),
    response.status,
    quota,
    rateLimited,
  );
  if (response.status >= 500 && response.status < 600) {
    await markGraphqlBackoff(
      env,
      quota.source,
      quota.account,
      githubGraphqlRepoStargazersOperation,
      response.status,
    );
    if (quota.source === "shared") {
      throw new GitHubRateLimitError(
        "GitHub GraphQL temporarily unavailable",
        githubGraphqlBackoffSeconds,
      );
    }
    return null;
  }
  const body = (await response.json().catch(() => null)) as GraphQLStargazerResponse | null;
  const message = body?.errors
    ?.map((error) => error.message ?? error.type)
    .filter(Boolean)
    .join("; ");
  if (isRateLimitResponse(response, message ?? "")) {
    throw new GitHubRateLimitError(
      message ?? "GitHub GraphQL rate limit",
      parseHeaderInt(response.headers.get("retry-after")),
    );
  }
  if (!response.ok || body?.errors?.length) return null;
  const edges = body?.data?.repository?.stargazers?.edges ?? [];
  return edges
    .filter(
      (edge): edge is GraphQLStargazerEdge & { node: NonNullable<GraphQLStargazerEdge["node"]> } =>
        Boolean(edge.node?.login),
    )
    .map((edge) => ({
      starred_at: edge.starredAt,
      user: {
        login: edge.node.login,
        avatar_url: edge.node.avatarUrl,
        html_url: edge.node.url,
        type: edge.node.__typename,
      },
    }));
}

export async function audienceUserOrgs(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserOrganization[]> {
  const cached = await readAudienceUserOrgs(env, login);
  if (cached) return cached;
  const orgs = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}/orgs?per_page=20`,
    gitHubUserOrganizationListSchema,
    "audience user orgs",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  await writeAudienceUserOrgs(env, login, orgs);
  return orgs;
}

export async function audienceUserRepos(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserRepository[]> {
  const cached = await readAudienceUserRepos(env, login);
  if (cached) return cached;
  const reposPath =
    profileType === "Organization"
      ? `/orgs/${encodeURIComponent(login)}/repos?sort=updated&type=public&per_page=${repoAudienceUserRepoLimit}`
      : `/users/${encodeURIComponent(login)}/repos?sort=updated&type=owner&per_page=${repoAudienceUserRepoLimit}`;
  const repos = await detailGitHubJson(
    reposPath,
    gitHubUserRepositoryListSchema,
    "audience user repositories",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  const publicRepos = await publicAudienceRepositories(
    env,
    repos.filter(isPublicAudienceRepository),
  );
  if (!publicRepos) {
    throw new Error("repository privacy metadata unavailable");
  }
  await writeAudienceUserRepos(env, login, publicRepos);
  return publicRepos;
}

export function isPublicAudienceRepository(repo: GitHubUserRepository): boolean {
  if (repo.private === true) return false;
  if (repo.visibility && repo.visibility !== "public") return false;
  return true;
}

export async function publicAudienceRepositories(
  env: Env,
  repos: GitHubUserRepository[],
): Promise<GitHubUserRepository[] | null> {
  const privateNames = await privateRepositoryNames(
    env,
    repos.map((repo) => repo.full_name),
  );
  return privateNames
    ? repos.filter((repo) => !privateNames.has(repo.full_name.toLowerCase()))
    : null;
}

export async function audienceUserInsights(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<{ orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] }> {
  const [orgs, repos] = await Promise.all([
    profileType === "Organization"
      ? Promise.resolve([])
      : audienceUserOrgs(login, env, token, quotaSource, quotaAccount, onQuota, auditArea).catch(
          (error) => {
            if (isGitHubRateLimit(error)) throw error;
            return [];
          },
        ),
    audienceUserRepos(
      login,
      env,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      profileType,
      auditArea,
    ).catch((error) => {
      if (isGitHubRateLimit(error)) throw error;
      return [];
    }),
  ]);
  return { orgs, repos };
}

export function audienceOrgSignals(orgs: GitHubUserOrganization[]): AudienceOrgSignal[] {
  return orgs.slice(0, 8).map((org) => ({
    login: org.login,
    description: org.description,
  }));
}

export function audienceRepoSignals(repos: GitHubUserRepository[]): AudienceRepoSignal[] {
  return repos
    .filter((repo) => !repo.archived && !repo.fork)
    .slice(0, repoAudienceUserRepoLimit)
    .map((repo) => ({
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
      topics: repo.topics ?? [],
    }));
}

export function audienceUser(
  stargazer: GitHubStargazer,
  profile: GitHubUserProfile | null,
  insights: { orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] } | null,
  targetLanguage: string | null,
  targetTopics: string[],
): RepoAudienceUser {
  const login = profile?.login ?? stargazer.user.login;
  const orgs = audienceOrgSignals(insights?.orgs ?? []);
  const repos = audienceRepoSignals(insights?.repos ?? []);
  const score = calculateAudienceScore({
    login,
    accountType: profile?.type ?? stargazer.user.type ?? null,
    followers: profile?.followers ?? 0,
    following: profile?.following ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    publicGists: profile?.public_gists ?? 0,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    blog: profile?.blog ?? null,
    twitterUsername: profile?.twitter_username ?? null,
    accountCreatedAt: profile?.created_at ?? null,
    accountUpdatedAt: profile?.updated_at ?? null,
    starredAt: stargazer.starred_at,
    targetLanguage,
    targetTopics,
    orgs,
    repos,
  });
  return {
    login,
    avatarUrl: profile?.avatar_url ?? stargazer.user.avatar_url,
    url: profile?.html_url ?? stargazer.user.html_url,
    name: profile?.name ?? null,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    followers: profile?.followers ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    starredAt: stargazer.starred_at,
    score: score.score,
    tier: score.tier,
    reasons: score.reasons,
    dimensions: score.dimensions,
    factors: score.factors,
    orgs,
    topRepositories: repos
      .sort(
        (a, b) => b.stars - a.stars || b.forks - a.forks || a.fullName.localeCompare(b.fullName),
      )
      .slice(0, 3)
      .map((repo) => ({
        fullName: repo.fullName,
        url: repo.url,
        description: repo.description,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        updatedAt: repo.pushedAt ?? repo.updatedAt,
      })),
    accountCreatedAt: profile?.created_at ?? null,
  };
}

export async function publicRepoAudience(
  env: Env,
  payload: RepoAudiencePayload,
): Promise<RepoAudiencePayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    payload.users.flatMap((user) => (user.topRepositories ?? []).map((repo) => repo.fullName)),
  );
  if (!privateNames) return null;
  if (privateNames.size === 0) return payload;
  return {
    ...payload,
    users: payload.users.map((user) => ({
      ...user,
      topRepositories: (user.topRepositories ?? []).filter(
        (repo) => !privateNames.has(repo.fullName.toLowerCase()),
      ),
    })),
  };
}

export function roundedPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

export function audienceTotals(
  users: RepoAudienceUser[],
  totalStargazers: number,
): RepoAudiencePayload["totals"] {
  const count = (tier: AudienceScoreTier) => users.filter((user) => user.tier === tier).length;
  const highSignal = count("high");
  const mediumSignal = count("medium");
  const lowSignal = count("low");
  const bots = count("bot");
  const scored = users.length;
  return {
    stargazers: totalStargazers,
    stargazersSampled: scored,
    highSignal,
    mediumSignal,
    lowSignal,
    bots,
    highSignalPercent: roundedPercent(highSignal, scored),
    mediumSignalPercent: roundedPercent(mediumSignal, scored),
    lowSignalPercent: roundedPercent(lowSignal, scored),
    botPercent: roundedPercent(bots, scored),
  };
}

export function trustProfileCacheKey(login: string): string {
  return `trust-profile:v4:${slugOwner(login)}`;
}

export function trustProfileAgeMs(payload: TrustProfilePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export async function readTrustProfile(env: Env, key: string): Promise<TrustProfilePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  const payload = raw ? tryJsonParse<TrustProfilePayload>(raw, `trust profile ${key}`) : null;
  return payload ? publicTrustProfile(env, payload) : null;
}

export async function publicTrustProfile(
  env: Env,
  payload: TrustProfilePayload,
): Promise<TrustProfilePayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    (payload.topRepositories ?? []).map((repo) => repo.fullName),
  );
  if (!privateNames) return null;
  if (privateNames.size === 0) return payload;
  return {
    ...payload,
    topRepositories: (payload.topRepositories ?? []).filter(
      (repo) => !privateNames.has(repo.fullName.toLowerCase()),
    ),
    stats: {
      ...payload.stats,
      totalStars: 0,
      totalForks: 0,
      recentRepositories: 0,
      activeRepositories: 0,
      languages: [],
      topics: [],
    },
  };
}

export function userTrustSignal(profile: TrustProfilePayload | null): UserTrustSignal | null {
  if (!profile || profile.profileKind !== "user_trust") return null;
  return { score: profile.score, tier: profile.tier };
}

export async function cachedUserTrustSignals(
  env: Env,
  logins: Array<string | null | undefined>,
): Promise<Map<string, UserTrustSignal>> {
  const signals = new Map<string, UserTrustSignal>();
  if (!env.DASHBOARD_CACHE) return signals;
  const slugs = Array.from(
    new Set(
      logins
        .filter((login): login is string => Boolean(login))
        .map(slugOwner)
        .filter(validOwnerSlug),
    ),
  );
  await Promise.all(
    slugs.map(async (login) => {
      const signal = userTrustSignal(await readTrustProfile(env, trustProfileCacheKey(login)));
      if (signal) signals.set(login, signal);
    }),
  );
  return signals;
}

export async function withRepoAudienceTrustProfiles(
  payload: RepoAudiencePayload,
  env: Env,
): Promise<RepoAudiencePayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.users.map((user) => user.login),
  );
  return {
    ...payload,
    users: payload.users.map((user) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = user;
      const signal = signals.get(slugOwner(user.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

export async function withRepoDetailContributorTrustProfiles(
  payload: RepoDetailPayload,
  env: Env,
): Promise<RepoDetailPayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.contributors.map((contributor) => contributor.login),
  );
  return {
    ...payload,
    contributors: payload.contributors.map((contributor) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = contributor;
      const signal = signals.get(slugOwner(contributor.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

export async function writeTrustProfile(
  env: Env,
  key: string,
  payload: TrustProfilePayload,
): Promise<void> {
  const publicPayload = await publicTrustProfile(env, payload);
  if (!publicPayload) return;
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(publicPayload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function refreshTrustProfile(
  key: string,
  login: string,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await publicTrustProfile(env, await buildTrustProfile(login, request, env));
    if (!payload) return;
    await writeTrustProfile(env, key, payload);
  } finally {
    await lock.release();
  }
}

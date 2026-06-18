import {
  type AudienceRepoSignal,
  type AudienceScoreTier,
  calculateAudienceScore,
} from "../scripts/lib/audience.js";
import { slugOwner, validOwnerSlug, validRepoSlug } from "../scripts/lib/dashboard.js";
import type {
  ApiQuota,
  AudienceRange,
  AudienceScoreFactor,
  RepoAudiencePayload,
  TrustProfilePayload,
} from "../src/types.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { gitHubRepositorySchema, type GitHubUserProfile } from "./schemas.js";
import {
  audienceOrgSignals,
  audienceRangeFromUrl,
  audienceRangeMs,
  audienceRepoSignals,
  audienceTotals,
  audienceUser,
  audienceUserInsights,
  audienceUserProfile,
  publicRepoAudience,
  publicTrustProfile,
  readRepoAudience,
  readTrustProfile,
  recentRepoStargazers,
  refreshTrustProfile,
  repoAudienceAgeMs,
  repoAudienceCacheKey,
  trustProfileAgeMs,
  trustProfileCacheKey,
  withRepoAudienceTrustProfiles,
  writeRepoAudience,
  writeTrustProfile,
} from "./audience-data.js";
import { appTokenConfigured } from "./auth-oauth.js";
import { bestInstallationToken, requestInstallationToken } from "./auth-tokens.js";
import { daysSince } from "./build-progress.js";
import {
  maxDisplayStaleMs,
  repoAudienceCacheTtlMs,
  repoAudienceDeepUserLimit,
  repoAudienceRanges,
  type RequestToken,
} from "./config.js";
import {
  dashboardErrorMessage,
  errorStatus,
  isGitHubRateLimit,
  retryAfterHeaders,
} from "./dashboard-cache.js";
import { acquireBuildLock } from "./dashboard-rebuild.js";
import { repositoryPublicCacheBarrier } from "./owner-metadata-read.js";
import { allowRequestRefresh, crawlerCacheOnlyResponse } from "./owner-metadata-write.js";
import { detailGitHubJson } from "./repo-github.js";

export function signalCounts(
  values: Array<string | null | undefined>,
  limit = 5,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = usefulSignalName(value);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function usefulSignalName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function topTrustRepositories(
  repos: AudienceRepoSignal[],
): TrustProfilePayload["topRepositories"] {
  return repos
    .sort((a, b) => b.stars - a.stars || b.forks - a.forks || a.fullName.localeCompare(b.fullName))
    .slice(0, 5)
    .map((repo) => ({
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      updatedAt: repo.pushedAt ?? repo.updatedAt,
      topics: repo.topics,
    }));
}

export function clampProfileScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreTier(score: number): AudienceScoreTier {
  return score >= 70 ? "high" : score >= 40 ? "medium" : "low";
}

export function retitleFactor(
  factor: AudienceScoreFactor,
  label: string,
  detail: string,
  value = factor.value,
  maxValue = factor.maxValue,
): AudienceScoreFactor {
  const clamped = clampProfileScore(value);
  return {
    ...factor,
    label,
    detail,
    value: clamped,
    maxValue,
    weightedValue: Math.round(clamped * factor.weight * 100) / 100,
  };
}

export function orgSignalScore(
  base: ReturnType<typeof calculateAudienceScore>,
  profile: GitHubUserProfile,
  repos: AudienceRepoSignal[],
  activeRepositories: number,
): ReturnType<typeof calculateAudienceScore> {
  const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
  const totalForks = repos.reduce((sum, repo) => sum + repo.forks, 0);
  const repoFootprint = clampProfileScore(
    Math.min(Math.log10(profile.public_repos + 1) * 18, 38) +
      Math.min(Math.log10(totalStars + totalForks + 1) * 18, 44) +
      Math.min(activeRepositories * 4, 18),
  );
  const profileFields = [
    profile.name,
    profile.company,
    profile.bio,
    profile.location,
    profile.blog,
    profile.twitter_username,
  ].filter((value) => typeof value === "string" && value.trim()).length;
  const orgCredibility = clampProfileScore(
    Math.min((daysSince(profile.created_at) ?? 0) / 90, 28) +
      Math.min(profileFields * 8, 32) +
      Math.min(Math.log10(profile.public_repos + 1) * 12, 24) +
      Math.min(Math.log10(totalStars + 1) * 8, 16),
  );
  const reach = clampProfileScore(
    Math.max(base.dimensions.influence, Math.min(Math.log10(totalStars + 1) * 20, 68)),
  );
  const dimensions = {
    trust: orgCredibility,
    influence: reach,
    builder: Math.max(base.dimensions.builder, repoFootprint),
    recency: base.dimensions.recency,
    risk: base.dimensions.risk,
  };
  const score = clampProfileScore(
    dimensions.trust * 0.24 +
      dimensions.builder * 0.34 +
      dimensions.influence * 0.28 +
      dimensions.risk * 0.14,
  );
  const factors = base.factors
    .filter((factor) => factor.key !== "orgs" && factor.key !== "recency")
    .map((factor) => {
      if (factor.key === "age") {
        return retitleFactor(
          factor,
          "organization age",
          profile.created_at
            ? `${daysSince(profile.created_at)?.toLocaleString("en")} days on GitHub`
            : "GitHub organization age unavailable",
        );
      }
      if (factor.key === "profile") {
        return retitleFactor(factor, "organization profile", factor.detail);
      }
      if (factor.key === "reach") {
        return retitleFactor(
          factor,
          "project reach",
          `${totalStars.toLocaleString("en")} stars, ${profile.followers.toLocaleString("en")} followers`,
          reach,
          100,
        );
      }
      if (factor.key === "builder") {
        return retitleFactor(
          factor,
          "repository footprint",
          `${profile.public_repos.toLocaleString("en")} public repos, ${activeRepositories.toLocaleString("en")} recently active`,
          repoFootprint,
          100,
        );
      }
      if (factor.key === "risk") {
        return retitleFactor(factor, "profile safety", factor.detail);
      }
      return factor;
    });
  const reasons = [
    "organization account",
    profile.public_repos > 0 ? `${profile.public_repos.toLocaleString("en")} public repos` : "",
    totalStars > 0 ? `${totalStars.toLocaleString("en")} public repo stars` : "",
    activeRepositories > 0
      ? `${activeRepositories.toLocaleString("en")} recently active repos`
      : "",
    ...base.reasons.filter(
      (reason) =>
        !/^\d+ public org/.test(reason) &&
        !reason.startsWith("notable org:") &&
        reason !== "active public builder",
    ),
  ].filter(Boolean);
  return {
    score,
    tier: scoreTier(score),
    reasons: reasons.length > 0 ? reasons : ["public organization signal is light"],
    dimensions,
    factors,
  };
}

export async function buildTrustProfile(
  login: string,
  request: Request,
  env: Env,
): Promise<TrustProfilePayload> {
  const requestToken = await bestInstallationToken(request, env, {
    owners: [login],
    repos: [],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const profile = await audienceUserProfile(
    login,
    env,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "trust-profile",
  );
  if (!profile) {
    throw new Error("GitHub profile not found");
  }
  const isOrg = profile.type === "Organization";
  const { orgs, repos } = await audienceUserInsights(
    profile.login,
    env,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    profile.type,
    "trust-profile",
  );
  const orgSignals = audienceOrgSignals(orgs);
  const repoSignals = audienceRepoSignals(repos);
  const activeRepositories = repoSignals.filter((repo) => {
    const ageDays = daysSince(repo.pushedAt ?? repo.updatedAt);
    return ageDays !== null && ageDays <= 180;
  }).length;
  const baseScore = calculateAudienceScore({
    login: profile.login,
    accountType: profile.type,
    followers: profile.followers,
    following: profile.following,
    publicRepos: profile.public_repos,
    publicGists: profile.public_gists,
    company: profile.company,
    bio: profile.bio,
    location: profile.location,
    blog: profile.blog,
    twitterUsername: profile.twitter_username,
    accountCreatedAt: profile.created_at,
    accountUpdatedAt: profile.updated_at,
    starredAt: null,
    orgs: orgSignals,
    repos: repoSignals,
  });
  const score = isOrg
    ? orgSignalScore(baseScore, profile, repoSignals, activeRepositories)
    : baseScore;
  const generatedAt = new Date().toISOString();
  return {
    login: profile.login,
    type: isOrg ? "org" : "user",
    profileKind: isOrg ? "org_signal" : "user_trust",
    scoreLabel: isOrg ? "org signal" : "trust score",
    avatarUrl: profile.avatar_url,
    url: profile.html_url,
    name: profile.name,
    company: profile.company,
    bio: profile.bio,
    location: profile.location,
    blog: profile.blog,
    twitterUsername: profile.twitter_username,
    followers: profile.followers,
    following: profile.following,
    publicRepos: profile.public_repos,
    publicGists: profile.public_gists,
    accountCreatedAt: profile.created_at,
    accountUpdatedAt: profile.updated_at,
    accountAgeDays: daysSince(profile.created_at),
    score: score.score,
    tier: score.tier,
    reasons: score.reasons,
    dimensions: score.dimensions,
    factors: score.factors,
    orgs: orgSignals,
    topRepositories: topTrustRepositories(repoSignals),
    stats: {
      totalStars: repoSignals.reduce((sum, repo) => sum + repo.stars, 0),
      totalForks: repoSignals.reduce((sum, repo) => sum + repo.forks, 0),
      recentRepositories: repoSignals.length,
      activeRepositories,
      publicOrganizations: orgSignals.length,
      languages: signalCounts(repoSignals.map((repo) => repo.language)),
      topics: signalCounts(repoSignals.flatMap((repo) => repo.topics)),
    },
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: isOrg
        ? "bounded public GitHub organization signals"
        : "bounded public GitHub profile signals",
      ...(quota ? { quota } : {}),
    },
  };
}

export function withTrustProfileState(
  payload: TrustProfilePayload,
  state: TrustProfilePayload["cache"]["state"],
  message = payload.cache.message,
): TrustProfilePayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

export async function trustProfileResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const login = slugOwner(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
  if (!validOwnerSlug(login)) {
    return jsonResponse({ error: "invalid user" }, 400, { "cache-control": "no-store" });
  }
  const key = trustProfileCacheKey(login);
  const cached = await readTrustProfile(env, key);
  const ageMs = trustProfileAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && ageMs < repoAudienceCacheTtlMs) {
    return jsonResponse(withTrustProfileState(cached, "fresh"));
  }
  if (cached && ageMs <= maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(refreshTrustProfile(key, login, request, env).catch(() => undefined));
    }
    return jsonResponse(
      withTrustProfileState(
        cached,
        "stale",
        allowRefresh ? "refreshing trust profile" : "showing cached trust profile",
      ),
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached trust profile unavailable for crawler");
  }
  try {
    const payload = await publicTrustProfile(env, await buildTrustProfile(login, request, env));
    if (!payload) {
      throw new Error("repository privacy metadata unavailable");
    }
    await writeTrustProfile(env, key, payload);
    return jsonResponse(payload, 200, { "cache-control": "public, max-age=60" });
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

export function withRepoAudienceState(
  payload: RepoAudiencePayload,
  state: RepoAudiencePayload["cache"]["state"],
  message = payload.cache.message,
): RepoAudiencePayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

export async function buildRepoAudience(
  owner: string,
  repoName: string,
  range: AudienceRange,
  request: Request,
  env: Env,
  tokenOverride?: RequestToken | null,
): Promise<RepoAudiencePayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken =
    tokenOverride ??
    (await requestInstallationToken(request, env, {
      owners: [],
      repos: [fullName],
    }).catch(() => null));
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository audience",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    undefined,
    undefined,
    env,
  );
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }
  const since = Date.now() - audienceRangeMs(range);
  const stargazers = (
    await recentRepoStargazers(
      owner,
      repoName,
      path,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      env,
    )
  ).filter((stargazer) => {
    const starredAt = Date.parse(stargazer.starred_at ?? "");
    return Number.isFinite(starredAt) && starredAt >= since;
  });
  const profileEntries = await Promise.all(
    stargazers.map(async (stargazer) => {
      const profile = await audienceUserProfile(
        stargazer.user.login,
        env,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
      ).catch((error) => {
        if (isGitHubRateLimit(error)) throw error;
        return null;
      });
      return { stargazer, profile };
    }),
  );
  const shallowUsers = profileEntries.map(({ stargazer, profile }) =>
    audienceUser(stargazer, profile, null, repo.language, repo.topics ?? []),
  );
  const deepLogins = new Set(
    shallowUsers
      .filter((user) => user.tier !== "bot")
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.starredAt ?? "") - Date.parse(a.starredAt ?? "") ||
          a.login.localeCompare(b.login),
      )
      .slice(0, repoAudienceDeepUserLimit)
      .map((user) => user.login.toLowerCase()),
  );
  const users = (
    await Promise.all(
      profileEntries.map(async ({ stargazer, profile }) => {
        const login = (profile?.login ?? stargazer.user.login).toLowerCase();
        const insights = deepLogins.has(login)
          ? await audienceUserInsights(
              login,
              env,
              token,
              quotaSource,
              quotaAccount,
              onQuota,
              profile?.type ?? "User",
            )
          : null;
        return audienceUser(stargazer, profile, insights, repo.language, repo.topics ?? []);
      }),
    )
  ).sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.starredAt ?? "") - Date.parse(a.starredAt ?? "") ||
      a.login.localeCompare(b.login),
  );
  const generatedAt = new Date().toISOString();
  return {
    fullName: repo.full_name,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public stargazer profile signals only",
      ...(quota ? { quota } : {}),
    },
    totals: audienceTotals(users, repo.stargazers_count),
    users,
  };
}

export async function refreshRepoAudience(
  key: string,
  owner: string,
  repo: string,
  range: AudienceRange,
  request: Request,
  env: Env,
  tokenOverride?: RequestToken | null,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await publicRepoAudience(
      env,
      await buildRepoAudience(owner, repo, range, request, env, tokenOverride),
    );
    if (!payload) return;
    await writeRepoAudience(env, key, payload);
  } finally {
    await lock.release();
  }
}

export async function repoAudienceResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const barrier = await repositoryPublicCacheBarrier(env, fullName);
  if (barrier === "blocked") {
    return jsonResponse({ error: "repository unavailable" }, 404, {
      "cache-control": "no-store",
    });
  }
  const range = audienceRangeFromUrl(url);
  const key = repoAudienceCacheKey(owner, repo, range);
  const cached = barrier === "clear" ? await readRepoAudience(env, key) : null;
  const ageMs = repoAudienceAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && ageMs < repoAudienceCacheTtlMs) {
    return jsonResponse(
      withRepoAudienceState(await withRepoAudienceTrustProfiles(cached, env), "fresh"),
    );
  }
  if (cached && ageMs <= maxDisplayStaleMs && !allowRefresh) {
    return jsonResponse(
      withRepoAudienceState(
        await withRepoAudienceTrustProfiles(cached, env),
        "stale",
        "showing cached repository audience signals",
      ),
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached repository audience signals unavailable for crawler");
  }
  const requestToken = appTokenConfigured(env)
    ? await requestInstallationToken(request, env, {
        owners: [],
        repos: [fullName],
      }).catch(() => null)
    : null;
  const canBuildAudience = !appTokenConfigured(env) || Boolean(requestToken);
  if (cached && ageMs <= maxDisplayStaleMs) {
    if (canBuildAudience && allowRefresh) {
      context.waitUntil(refreshRepoAudience(key, owner, repo, range, request, env, requestToken));
    }
    return jsonResponse(
      withRepoAudienceState(
        await withRepoAudienceTrustProfiles(cached, env),
        "stale",
        canBuildAudience && allowRefresh
          ? "refreshing repository audience signals"
          : canBuildAudience
            ? "showing cached repository audience signals"
            : "connect the GitHub App for this repository to refresh audience signals",
      ),
    );
  }
  if (!canBuildAudience) {
    return jsonResponse(
      { error: "connect the GitHub App for this repository before building audience caches" },
      403,
      { "cache-control": "no-store" },
    );
  }

  try {
    const payload = await publicRepoAudience(
      env,
      await buildRepoAudience(owner, repo, range, request, env, requestToken),
    );
    if (!payload) {
      throw new Error("repository privacy metadata unavailable");
    }
    await writeRepoAudience(env, key, payload);
    return jsonResponse(await withRepoAudienceTrustProfiles(payload, env), 200, {
      "cache-control": "public, max-age=60",
    });
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

export async function repoAudienceBackfillResponse(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "backfill requires POST" }, 405, { allow: "POST" });
  }
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const barrier = await repositoryPublicCacheBarrier(env, fullName);
  if (barrier === "blocked") {
    return jsonResponse({ error: "repository unavailable" }, 404, {
      "cache-control": "no-store",
    });
  }
  const requestToken = await requestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  if (!requestToken) {
    return jsonResponse(
      { error: "connect the GitHub App for this repository before backfilling audience caches" },
      403,
      { "cache-control": "no-store" },
    );
  }
  const force = url.searchParams.get("force") === "1";
  const ranges: Array<{
    range: AudienceRange;
    state: "busy" | "fresh" | "rebuilt";
    users: number;
    generatedAt: string;
  }> = [];
  for (const range of repoAudienceRanges) {
    const key = repoAudienceCacheKey(owner, repo, range);
    const cached = barrier === "clear" ? await readRepoAudience(env, key) : null;
    const ageMs = repoAudienceAgeMs(cached);
    if (!force && cached && ageMs < repoAudienceCacheTtlMs) {
      ranges.push({
        range,
        state: "fresh",
        users: cached.users.length,
        generatedAt: cached.generatedAt,
      });
      continue;
    }
    const lock = await acquireBuildLock(env, `${key}:backfill`);
    if (!lock) {
      ranges.push({
        range,
        state: "busy",
        users: cached?.users.length ?? 0,
        generatedAt: cached?.generatedAt ?? new Date().toISOString(),
      });
      continue;
    }
    try {
      const payload = await publicRepoAudience(
        env,
        await buildRepoAudience(owner, repo, range, request, env, requestToken),
      );
      if (!payload) {
        throw new Error("repository privacy metadata unavailable");
      }
      await writeRepoAudience(env, key, payload);
      ranges.push({
        range,
        state: "rebuilt",
        users: payload.users.length,
        generatedAt: payload.generatedAt,
      });
    } finally {
      await lock.release();
    }
  }
  return jsonResponse(
    {
      fullName,
      ranges,
      quota: {
        source: requestToken.quotaSource,
        account: requestToken.quotaAccount,
      },
      message: "bounded stargazer trust caches backfilled with GitHub App quota",
    },
    200,
    { "cache-control": "no-store" },
  );
}

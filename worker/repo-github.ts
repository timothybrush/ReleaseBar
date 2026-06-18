import { GitHubRateLimitError, slugOwner } from "../scripts/lib/dashboard.js";
import type { ActivityRange, ApiQuota, RepoDetailWorkTrend } from "../src/types.js";
import {
  type GitHubAuditArea,
  githubGraphqlAuditPath,
  githubGraphqlBackoffSeconds,
  githubRequestOptions,
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
import { gitHubSearchCountSchema, parseGitHubResponse, tryJsonParse } from "./schemas.js";
import type { GenericSchema, InferOutput } from "valibot";
import { lastPageFromLink } from "./audience-data.js";
import {
  discoverCacheSchemaVersion,
  githubGraphqlRepoWorkTrendOperation,
  ownerActivityCacheVersion,
  repoDetailAuxCacheVersion,
  repoDetailAuxTtlSeconds,
  repoDetailSearchCountCacheTtlMs,
  repoDetailStatsBackoffTtlSeconds,
  repoDetailStatsCacheTtlMs,
} from "./config.js";

export type DiscoverPeriod = "day" | "week" | "month" | "year";

export const discoverPeriods = new Set<DiscoverPeriod>(["day", "week", "month", "year"]);

export function discoverPeriod(url: URL): DiscoverPeriod {
  const raw = (url.searchParams.get("period") ?? "week").toLowerCase();
  if (raw === "today") return "day";
  return discoverPeriods.has(raw as DiscoverPeriod) ? (raw as DiscoverPeriod) : "week";
}

export function discoverLanguage(url: URL): string {
  const raw = (url.searchParams.get("lang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

export function discoverPageLanguage(url: URL): string {
  const raw = (url.searchParams.get("hotLang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

export function discoverCacheKey(period: DiscoverPeriod, language: string): string {
  return `discover:v${discoverCacheSchemaVersion}:${period}:${language.trim().toLowerCase() || "all"}`;
}

export function discoverSince(period: DiscoverPeriod): string {
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  const date = new Date(Date.now() - days * 86400000);
  return date.toISOString().slice(0, 10);
}

export function discoverPeriodLabel(period: DiscoverPeriod): string {
  return period === "day" ? "today" : `this ${period}`;
}

export function discoverSearchQuery(period: DiscoverPeriod, language: string): string {
  const minimumStars =
    period === "day" ? 50 : period === "week" ? 100 : period === "month" ? 250 : 1000;
  const parts = [
    `stars:>${minimumStars}`,
    `pushed:>=${discoverSince(period)}`,
    "archived:false",
    "fork:false",
  ];
  if (language) {
    parts.push(`language:"${language.replaceAll('"', "")}"`);
  }
  return parts.join(" ");
}

export async function detailGitHubJson<TSchema extends GenericSchema>(
  path: string,
  schema: TSchema,
  context: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<InferOutput<TSchema>> {
  const { data } = await detailGitHubJsonWithHeaders(
    path,
    schema,
    context,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    acceptOrAuditArea,
    auditArea,
    env,
  );
  if (data === null) {
    throw new Error(`GitHub returned an unexpected not-modified response for ${path}`);
  }
  return data;
}

export async function detailGitHubJsonWithHeaders<TSchema extends GenericSchema>(
  path: string,
  schema: TSchema,
  context: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
  etag?: string | null,
): Promise<{ data: InferOutput<TSchema> | null; headers: Headers; notModified: boolean }> {
  const requestOptions = githubRequestOptions(acceptOrAuditArea, auditArea);
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: requestOptions.accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(
    env,
    requestOptions.auditArea,
    path,
    response.status,
    quota,
    rateLimited,
  );
  if (response.status === 304 && etag) {
    return { data: null, headers: response.headers, notModified: true };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, message)) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(`GitHub API ${response.status} for ${path}: ${message}`);
  }
  return {
    data: parseGitHubResponse(schema, body, context),
    headers: response.headers,
    notModified: false,
  };
}

export type RepoDetailAuxCacheRecord<T> = {
  generatedAt: string;
  etag?: string | null;
  data: T;
};

export function repoDetailAuxCachePrefix(fullName: string): string {
  return `repo-detail:aux:v${repoDetailAuxCacheVersion}:${encodeURIComponent(fullName.toLowerCase())}:`;
}

export function repoDetailAuxCacheKey(fullName: string, kind: string, id: string): string {
  return `${repoDetailAuxCachePrefix(fullName)}${kind}:${encodeURIComponent(id.toLowerCase())}`;
}

export function repoStatsBackoffCacheKeys(fullName: string, path: string): string[] {
  const repoPath = path.replace(/\/stats\/[^/?]+(\?.*)?$/, "/stats");
  return [
    repoDetailAuxCacheKey(fullName, "stats-backoff", path),
    repoDetailAuxCacheKey(fullName, "stats-backoff", repoPath),
  ];
}

export async function readRepoDetailAuxRecord<T>(
  env: Env | undefined,
  key: string,
): Promise<RepoDetailAuxCacheRecord<T> | null> {
  const raw = await env?.DASHBOARD_CACHE?.get(key);
  if (!raw) return null;
  return tryJsonParse<RepoDetailAuxCacheRecord<T>>(raw, `repo detail aux ${key}`);
}

export async function readRepoDetailAux<T>(
  env: Env | undefined,
  key: string,
  maxAgeMs: number,
): Promise<T | null> {
  const record = await readRepoDetailAuxRecord<T>(env, key);
  const generatedAt = Date.parse(record?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > maxAgeMs) return null;
  return record?.data ?? null;
}

export async function writeRepoDetailAux<T>(
  env: Env | undefined,
  key: string,
  data: T,
  ttlSeconds = repoDetailAuxTtlSeconds,
  etag?: string | null,
): Promise<void> {
  await env?.DASHBOARD_CACHE?.put(
    key,
    JSON.stringify({ generatedAt: new Date().toISOString(), data, ...(etag ? { etag } : {}) }),
    { expirationTtl: ttlSeconds },
  );
}

export async function cachedDetailGitHubJson<TSchema extends GenericSchema>(
  fullName: string,
  cacheKind: string,
  path: string,
  schema: TSchema,
  context: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
  maxAgeMs = repoDetailAuxTtlSeconds * 1000,
  validate?: (data: InferOutput<TSchema>) => void,
): Promise<InferOutput<TSchema>> {
  const cacheKey = repoDetailAuxCacheKey(fullName, cacheKind, path);
  const record = await readRepoDetailAuxRecord<InferOutput<TSchema>>(env, cacheKey);
  const generatedAt = Date.parse(record?.generatedAt ?? "");
  if (record && Number.isFinite(generatedAt) && Date.now() - generatedAt <= maxAgeMs) {
    validate?.(record.data);
    return record.data;
  }
  const result = await detailGitHubJsonWithHeaders(
    path,
    schema,
    context,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    acceptOrAuditArea,
    auditArea,
    env,
    record?.etag,
  );
  const data = result.notModified && record ? record.data : result.data;
  if (data === null) {
    throw new Error(`GitHub returned no repository detail data for ${path}`);
  }
  validate?.(data);
  await writeRepoDetailAux(
    env,
    cacheKey,
    data,
    Math.max(repoDetailAuxTtlSeconds, Math.floor(maxAgeMs / 1000)),
    result.headers.get("etag") ?? record?.etag,
  );
  return data;
}

export async function cachedDetailGitHubCount(
  fullName: string,
  cacheKind: string,
  path: string,
  maxAgeMs: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<number> {
  const cacheKey = repoDetailAuxCacheKey(fullName, cacheKind, path);
  const record = await readRepoDetailAuxRecord<number>(env, cacheKey);
  const generatedAt = Date.parse(record?.generatedAt ?? "");
  if (record && Number.isFinite(generatedAt) && Date.now() - generatedAt <= maxAgeMs) {
    return record.data;
  }
  const result = await detailGitHubCount(
    path,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    env,
    record?.etag,
  );
  const count = result.notModified && record ? record.data : result.count;
  await writeRepoDetailAux(
    env,
    cacheKey,
    count,
    Math.max(repoDetailAuxTtlSeconds, Math.floor(maxAgeMs / 1000)),
    result.etag ?? record?.etag,
  );
  return count;
}

export async function detailGitHubStats<TSchema extends GenericSchema>(
  fullName: string,
  path: string,
  schema: TSchema,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<{
  state: "ready" | "warming" | "unavailable";
  data: InferOutput<TSchema> | null;
  message?: string;
}> {
  type StatsResult = {
    state: "ready" | "warming" | "unavailable";
    data: InferOutput<TSchema> | null;
    message?: string;
  };
  const statsCacheKey = repoDetailAuxCacheKey(fullName, "stats", path);
  const cached = await readRepoDetailAux<StatsResult>(
    env,
    statsCacheKey,
    repoDetailStatsCacheTtlMs,
  );
  if (cached) return cached;
  const backoffKeys = repoStatsBackoffCacheKeys(fullName, path);
  let backoff: { message?: string } | null = null;
  for (const key of backoffKeys) {
    backoff = await readRepoDetailAux<{ message?: string }>(
      env,
      key,
      repoDetailStatsBackoffTtlSeconds * 1000,
    );
    if (backoff) break;
  }
  if (backoff) {
    return {
      state: "warming",
      data: null,
      message: backoff.message ?? "GitHub is preparing repository statistics.",
    };
  }
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(env, auditArea, path, response.status, quota, rateLimited);
  if (response.status === 202) {
    const message = "GitHub is preparing repository statistics.";
    await Promise.all(
      backoffKeys.map((key) =>
        writeRepoDetailAux(env, key, { message }, repoDetailStatsBackoffTtlSeconds),
      ),
    );
    return {
      state: "warming",
      data: null,
      message,
    };
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : undefined;
  if (response.status === 204 || response.status === 422) {
    const result: StatsResult = {
      state: "unavailable",
      data: null,
      ...(message ? { message } : {}),
    };
    await writeRepoDetailAux(
      env,
      statsCacheKey,
      result,
      Math.floor(repoDetailStatsCacheTtlMs / 1000),
    );
    return result;
  }
  if (!response.ok) {
    const errorMessage = message ?? `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, errorMessage)) {
      throw new GitHubRateLimitError(
        errorMessage,
        parseHeaderInt(response.headers.get("retry-after")),
      );
    }
    const result: StatsResult = { state: "unavailable", data: null, message: errorMessage };
    await writeRepoDetailAux(
      env,
      statsCacheKey,
      result,
      Math.floor(repoDetailStatsCacheTtlMs / 1000),
    );
    return result;
  }
  const result: StatsResult = { state: "ready", data: parseGitHubResponse(schema, body, path) };
  await writeRepoDetailAux(
    env,
    statsCacheKey,
    result,
    Math.floor(repoDetailStatsCacheTtlMs / 1000),
  );
  return result;
}

export async function detailGitHubCount(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
  etag?: string | null,
): Promise<{ count: number; etag: string | null; notModified: boolean }> {
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(env, auditArea, path, response.status, quota, rateLimited);
  if (response.status === 304 && etag) {
    return { count: 0, etag: response.headers.get("etag") ?? etag, notModified: true };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, message)) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(`GitHub API ${response.status} for ${path}: ${message}`);
  }
  const lastPage = lastPageFromLink(response.headers.get("link"));
  return {
    count: lastPage ?? (Array.isArray(body) ? body.length : 0),
    etag: response.headers.get("etag"),
    notModified: false,
  };
}

export async function detailGitHubSearchCount(
  fullName: string,
  query: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<number> {
  const cacheKey = repoDetailAuxCacheKey(fullName, "search-count", query);
  const cached = await readRepoDetailAux<number>(env, cacheKey, repoDetailSearchCountCacheTtlMs);
  if (cached !== null) return cached;
  const result = await detailGitHubJson(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
    gitHubSearchCountSchema,
    "repository issue search",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  const count = result.total_count ?? 0;
  await writeRepoDetailAux(
    env,
    cacheKey,
    count,
    Math.floor(repoDetailSearchCountCacheTtlMs / 1000),
  );
  return count;
}

export type RepoWorkTrendQueries = {
  issuesOpened30d: string;
  issuesClosed30d: string;
  pullRequestsOpened30d: string;
  pullRequestsClosed30d: string;
};

export type RepoWorkTrendGraphqlResponse = {
  data?: {
    issuesOpened30d?: { issueCount?: number };
    issuesClosed30d?: { issueCount?: number };
    pullRequestsOpened30d?: { issueCount?: number };
    pullRequestsClosed30d?: { issueCount?: number };
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export const repoWorkTrendQuery = /* GraphQL */ `
  query ReleaseBarRepoWorkTrend(
    $issuesOpened30d: String!
    $issuesClosed30d: String!
    $pullRequestsOpened30d: String!
    $pullRequestsClosed30d: String!
  ) {
    issuesOpened30d: search(query: $issuesOpened30d, type: ISSUE, first: 1) {
      issueCount
    }
    issuesClosed30d: search(query: $issuesClosed30d, type: ISSUE, first: 1) {
      issueCount
    }
    pullRequestsOpened30d: search(query: $pullRequestsOpened30d, type: ISSUE, first: 1) {
      issueCount
    }
    pullRequestsClosed30d: search(query: $pullRequestsClosed30d, type: ISSUE, first: 1) {
      issueCount
    }
  }
`;

export async function detailGitHubWorkTrend(
  queries: RepoWorkTrendQueries,
  token: string,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea,
  env?: Env,
): Promise<Omit<RepoDetailWorkTrend, "since">> {
  if (
    await graphqlBackoffActive(env, quotaSource, quotaAccount, githubGraphqlRepoWorkTrendOperation)
  ) {
    throw new GitHubRateLimitError("GitHub GraphQL backoff active", githubGraphqlBackoffSeconds);
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
    body: JSON.stringify({ query: repoWorkTrendQuery, variables: queries }),
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(
    env,
    auditArea,
    githubGraphqlAuditPath(githubGraphqlRepoWorkTrendOperation),
    response.status,
    quota,
    rateLimited,
  );
  if (response.status >= 500 && response.status < 600) {
    await markGraphqlBackoff(
      env,
      quota.source,
      quota.account,
      githubGraphqlRepoWorkTrendOperation,
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as RepoWorkTrendGraphqlResponse | null;
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
  if (!response.ok || body?.errors?.length) {
    throw new Error(message || `GitHub GraphQL ${response.status}`);
  }
  const counts = {
    issuesOpened30d: body?.data?.issuesOpened30d?.issueCount,
    issuesClosed30d: body?.data?.issuesClosed30d?.issueCount,
    pullRequestsOpened30d: body?.data?.pullRequestsOpened30d?.issueCount,
    pullRequestsClosed30d: body?.data?.pullRequestsClosed30d?.issueCount,
  };
  if (Object.values(counts).some((count) => typeof count !== "number")) {
    throw new Error("GitHub GraphQL returned incomplete repository work trend");
  }
  return counts as Omit<RepoDetailWorkTrend, "since">;
}

export async function buildWorkTrend(
  fullName: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<RepoDetailWorkTrend> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const repoQuery = `repo:${fullName}`;
  const queries: RepoWorkTrendQueries = {
    issuesOpened30d: `${repoQuery} is:issue created:>=${since}`,
    issuesClosed30d: `${repoQuery} is:issue closed:>=${since}`,
    pullRequestsOpened30d: `${repoQuery} is:pr created:>=${since}`,
    pullRequestsClosed30d: `${repoQuery} is:pr closed:>=${since}`,
  };
  const cachedCounts = await Promise.all(
    Object.values(queries).map((query) =>
      readRepoDetailAux<number>(
        env,
        repoDetailAuxCacheKey(fullName, "search-count", query),
        repoDetailSearchCountCacheTtlMs,
      ),
    ),
  );
  if (cachedCounts.every((count) => count !== null)) {
    const [issuesOpened30d, issuesClosed30d, pullRequestsOpened30d, pullRequestsClosed30d] =
      cachedCounts as number[];
    return {
      since,
      issuesOpened30d: issuesOpened30d!,
      issuesClosed30d: issuesClosed30d!,
      pullRequestsOpened30d: pullRequestsOpened30d!,
      pullRequestsClosed30d: pullRequestsClosed30d!,
    };
  }
  if (token) {
    const counts = await detailGitHubWorkTrend(
      queries,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      auditArea,
      env,
    );
    await Promise.all(
      Object.entries(queries).map(([key, query]) =>
        writeRepoDetailAux(
          env,
          repoDetailAuxCacheKey(fullName, "search-count", query),
          counts[key as keyof typeof counts],
          Math.floor(repoDetailSearchCountCacheTtlMs / 1000),
        ),
      ),
    );
    return { since, ...counts };
  }
  const [issuesOpened30d, issuesClosed30d, pullRequestsOpened30d, pullRequestsClosed30d] =
    await Promise.all(
      Object.values(queries).map((query) =>
        detailGitHubSearchCount(
          fullName,
          query,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          auditArea,
          env,
        ),
      ),
    );
  return {
    since,
    issuesOpened30d,
    issuesClosed30d,
    pullRequestsOpened30d,
    pullRequestsClosed30d,
  };
}

export function activityRangeFromUrl(url: URL): ActivityRange {
  const value = url.searchParams.get("range")?.toLowerCase();
  return value === "day" || value === "month" ? value : "week";
}

export function activityRangeMs(range: ActivityRange): number {
  if (range === "day") return 24 * 60 * 60 * 1000;
  if (range === "month") return 30 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

export function activityCacheTtlMs(range: ActivityRange): number {
  if (range === "day") return 10 * 60 * 1000;
  if (range === "month") return 6 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

export function ownerActivityCacheKey(owner: string, range: ActivityRange): string {
  return `owner-activity:v${ownerActivityCacheVersion}:${slugOwner(owner)}:${range}`;
}

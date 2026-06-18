import {
  dashboardCacheKey,
  GitHubRateLimitError,
  validOwnerSlug,
} from "../scripts/lib/dashboard.js";
import type { ApiQuota, DashboardPayload, Project } from "../src/types.js";
import {
  isRateLimitResponse,
  parseHeaderInt,
  quotaFromResponse,
  recordAuditedGitHubAccess,
  sharedQuotaCooldown,
} from "./github-audit.js";
import { jsonResponse, workerFetch } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import {
  gitHubReleaseSchema,
  type GitHubSearchRepository,
  gitHubSearchRepositoryListSchema,
  parseGitHubResponse,
} from "./schemas.js";
import * as v from "valibot";
import {
  type InitialPageData,
  ownerListFromUrl,
  repoListFromUrl,
  uniqueSorted,
} from "./app-shell.js";
import { appTokenConfigured, dashboardReleaseDataAllowed } from "./auth-oauth.js";
import { bestInstallationToken, sourceInstallationRegistryCovers } from "./auth-tokens.js";
import { dashboardTotals } from "./build-progress.js";
import {
  buildLockRefreshMs,
  dashboardSchemaVersion,
  discoverCacheTtlMs,
  discoverHydrateBatchSize,
  discoverHydrateLimit,
  discoverLimit,
  fullTtlMs,
  maxCustomSources,
} from "./config.js";
import {
  cacheAgeMs,
  canDisplayCached,
  dashboardErrorMessage,
  errorStatus,
  isGitHubRateLimit,
  optionsFromUrl,
  readCached,
  readProfile,
  retryAfterHeaders,
  withCacheState,
  writeCached,
} from "./dashboard-cache.js";
import { acquireBuildLock, dashboardStreamState } from "./dashboard-rebuild.js";
import { allowRequestRefresh, readCachedWithOwnerMetadata } from "./owner-metadata-write.js";
import { auditDashboardSync, auditSyncEvent, dashboardSyncDetail } from "./refresh-targets.js";
import {
  discoverCacheKey,
  discoverLanguage,
  discoverPageLanguage,
  discoverPeriod,
  type DiscoverPeriod,
  discoverPeriodLabel,
  discoverSearchQuery,
} from "./repo-github.js";

export function discoverFreshness(repo: GitHubSearchRepository): Project["freshness"] {
  const stars = repo.stargazers_count ?? 0;
  const pushedAt = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
  const ageDays = pushedAt ? Math.max(0, (Date.now() - pushedAt) / 86400000) : 365;
  if (stars >= 1000 && ageDays <= 7) return "hot";
  if (stars >= 250 && ageDays <= 30) return "busy";
  return "warm";
}

export function discoverProject(repo: GitHubSearchRepository): Project {
  const owner = repo.owner.login;
  const fullName = repo.full_name;
  const defaultBranch = repo.default_branch || "main";
  const releaseUrl = `${repo.html_url}/releases`;
  return {
    owner,
    name: repo.name,
    fullName,
    description: repo.description,
    url: repo.html_url,
    defaultBranch,
    language: repo.language,
    topics: repo.topics ?? [],
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    openPullRequests: 0,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived ?? false,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: defaultBranch,
    latestCommitDate: repo.pushed_at,
    version: "repo search",
    releaseName: null,
    releaseUrl,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: discoverFreshness(repo),
  };
}

export function isRepositorySearchProject(project: Project): boolean {
  return (
    project.version === "repo search" &&
    project.releaseDate === null &&
    project.commitsSinceRelease === null &&
    project.compareUrl === null
  );
}

export function discoverNeedsHydration(payload: DashboardPayload): boolean {
  if (payload.cache?.progress?.done === true) return false;
  return payload.projects.slice(0, discoverHydrateLimit).some(isRepositorySearchProject);
}

export function discoverErrorPayload(
  period: DiscoverPeriod,
  language: string,
  env: Env,
  error: unknown,
): DashboardPayload {
  const generatedAt = new Date().toISOString();
  return {
    title: "GitHub Hot",
    subtitle: `GitHub repository search for ${language ? `${language} projects ` : "projects "}${discoverPeriodLabel(period)}.`,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: discoverLimit,
    },
    cache: {
      state: "error",
      stale: true,
      capped: false,
      repoLimit: discoverLimit,
      generatedAt,
      message: discoveryErrorMessage(error),
    },
    totals: dashboardTotals([]),
    projects: [],
  };
}

export function discoveryErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub repository search quota is exhausted. Try again after the search quota resets.";
  }
  return dashboardErrorMessage(error);
}

export async function discoverPayload(
  period: DiscoverPeriod,
  language: string,
  env: Env,
): Promise<DashboardPayload> {
  const search = new URL("https://api.github.com/search/repositories");
  search.searchParams.set("q", discoverSearchQuery(period, language));
  search.searchParams.set("sort", "stars");
  search.searchParams.set("order", "desc");
  search.searchParams.set("per_page", String(discoverLimit));

  const response = await workerFetch(search.toString(), {
    headers: {
      accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromResponse(response, env);
  const body = parseGitHubResponse(
    gitHubSearchRepositoryListSchema,
    await response.json(),
    "repository search",
  );
  const message = !response.ok
    ? (body.message ?? `GitHub repository search failed: ${response.status}`)
    : "";
  const rateLimited = !response.ok && isRateLimitResponse(response, message);
  await recordAuditedGitHubAccess(
    env,
    "discover",
    `${search.pathname}${search.search}`,
    response.status,
    quota,
    rateLimited,
  );
  if (!response.ok) {
    if (rateLimited) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(message);
  }

  const projects = (body.items ?? [])
    .filter((repo) => !repo.private && !repo.fork && !repo.archived)
    .map(discoverProject);
  const generatedAt = new Date().toISOString();
  const total = body.total_count ?? projects.length;
  return {
    title: "GitHub Hot",
    subtitle: `Popular public GitHub repositories active ${discoverPeriodLabel(period)}${
      language ? ` in ${language}` : ""
    }.`,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: discoverLimit,
    },
    cache: {
      state: "partial",
      stale: true,
      capped: total > projects.length,
      repoLimit: discoverLimit,
      generatedAt,
      quota,
      progress: {
        scanned: 0,
        limit: Math.min(discoverHydrateLimit, projects.length),
        done: false,
      },
      message: "repository search loaded; scanning release data for top repositories",
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

export type DiscoverHydratedProject = {
  project: Project;
  quota: ApiQuota | null;
};

export async function hydrateDiscoverProject(
  project: Project,
  env: Env,
): Promise<DiscoverHydratedProject> {
  const [owner, repo] = project.fullName.split("/");
  if (!owner || !repo) return { project, quota: null };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=5`;
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromResponse(response, env);
  const body = await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : `GitHub API ${response.status}`;
  const rateLimited = !response.ok && isRateLimitResponse(response, message);
  await recordAuditedGitHubAccess(env, "discover", path, response.status, quota, rateLimited);
  if (!response.ok) {
    if (rateLimited) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    return { project, quota };
  }
  const releases = parseGitHubResponse(
    v.array(gitHubReleaseSchema),
    body,
    "discover repository releases",
  );
  const release =
    releases.find((item) => item.tag_name && !item.draft && item.published_at) ?? null;
  if (!release) {
    return {
      project: {
        ...project,
        version: "unreleased",
        releaseName: null,
        releaseDate: null,
      },
      quota,
    };
  }
  return {
    project: {
      ...project,
      version: release.tag_name,
      releaseName: release.name,
      releaseUrl: release.html_url,
      releaseDate: release.published_at,
    },
    quota,
  };
}

export async function hydrateDiscoverPayload(
  payload: DashboardPayload,
  env: Env,
): Promise<DashboardPayload> {
  const now = new Date().toISOString();
  const limit = Math.min(discoverHydrateLimit, payload.projects.length);
  const scannedBefore = Math.min(payload.cache?.progress?.scanned ?? 0, limit);
  const scanned = Math.min(scannedBefore + discoverHydrateBatchSize, limit);
  const repos = payload.projects.slice(scannedBefore, scanned).map((project) => project.fullName);
  if (repos.length === 0) {
    return {
      ...payload,
      generatedAt: now,
      cache: {
        ...(payload.cache ?? {
          capped: false,
          repoLimit: discoverLimit,
          generatedAt: now,
        }),
        state: "fresh",
        stale: false,
        generatedAt: now,
        progress: { scanned: limit, limit, done: true },
        message: "repository search loaded",
      },
    };
  }
  const hydrated: DiscoverHydratedProject[] = [];
  for (const project of payload.projects.filter((item) => repos.includes(item.fullName))) {
    hydrated.push(await hydrateDiscoverProject(project, env));
  }
  const quota = hydrated.findLast((item) => item.quota)?.quota ?? payload.cache?.quota;
  const hydratedProjects = new Map(
    hydrated.map(({ project }) => [project.fullName.toLowerCase(), project]),
  );
  const projects = payload.projects.map(
    (project) => hydratedProjects.get(project.fullName.toLowerCase()) ?? project,
  );
  const done = scanned >= limit;
  return {
    ...payload,
    generatedAt: now,
    cache: {
      ...(payload.cache ?? {
        capped: false,
        repoLimit: discoverLimit,
        generatedAt: now,
      }),
      state: done ? "fresh" : "partial",
      stale: !done,
      generatedAt: now,
      ...(quota ? { quota } : {}),
      progress: {
        scanned,
        limit,
        done,
      },
      message: done
        ? `release metadata scanned for ${scanned} repositories`
        : `release metadata scanned for ${scanned}/${limit} repositories`,
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

export async function hydrateDiscoverCache(
  key: string,
  payload: DashboardPayload,
  env: Env,
): Promise<void> {
  if (!discoverNeedsHydration(payload)) return;
  const cooldown = await sharedQuotaCooldown(env, "core");
  if (cooldown.active) {
    await auditSyncEvent(env, {
      event: "discover_hydrate_skip",
      targetKey: key,
      status: "skipped",
      reason: "shared-quota",
      projects: payload.projects.length,
      scanned: payload.cache?.progress?.scanned,
      limit: payload.cache?.progress?.limit,
      done: payload.cache?.progress?.done,
      detail: `remaining=${cooldown.remaining ?? "unknown"} resource=${cooldown.resource ?? "any"}`,
    });
    return;
  }
  const lock = await acquireBuildLock(env, `hydrate:${key}`);
  if (!lock) {
    await auditSyncEvent(env, {
      event: "discover_hydrate_skip",
      targetKey: key,
      status: "locked",
      reason: "build-lock",
      projects: payload.projects.length,
      scanned: payload.cache?.progress?.scanned,
      limit: payload.cache?.progress?.limit,
      done: payload.cache?.progress?.done,
    });
    return;
  }
  const refresh = globalThis.setInterval(() => {
    void lock.refresh();
  }, buildLockRefreshMs);
  const startedAt = Date.now();
  await auditSyncEvent(env, {
    event: "discover_hydrate_start",
    targetKey: key,
    status: "running",
    projects: payload.projects.length,
    scanned: payload.cache?.progress?.scanned,
    limit: payload.cache?.progress?.limit,
    done: payload.cache?.progress?.done,
    detail: dashboardSyncDetail(payload),
  });
  try {
    const hydrated = await hydrateDiscoverPayload(payload, env);
    await writeCached(env, key, hydrated);
    await auditSyncEvent(env, {
      event: "discover_hydrate_done",
      targetKey: key,
      status: hydrated.cache?.progress?.done === false ? "partial" : "fresh",
      durationMs: Date.now() - startedAt,
      projects: hydrated.projects.length,
      scanned: hydrated.cache?.progress?.scanned,
      limit: hydrated.cache?.progress?.limit,
      done: hydrated.cache?.progress?.done,
      detail: dashboardSyncDetail(hydrated),
    });
  } catch (error) {
    await writeCached(env, key, {
      ...payload,
      cache: {
        ...(payload.cache ?? {
          capped: false,
          repoLimit: discoverLimit,
          generatedAt: payload.generatedAt,
        }),
        state: "fresh",
        stale: false,
        progress: {
          scanned: 0,
          limit: Math.min(discoverHydrateLimit, payload.projects.length),
          done: true,
        },
        message: `release scan skipped: ${dashboardErrorMessage(error)}`,
      },
    });
    await auditSyncEvent(env, {
      event: "discover_hydrate_failed",
      targetKey: key,
      status: "failed",
      durationMs: Date.now() - startedAt,
      reason: dashboardErrorMessage(error),
    });
  } finally {
    globalThis.clearInterval(refresh);
    await lock.release();
  }
}

export async function discoverResponse(
  request: Request,
  env: Env,
  url: URL,
  context: ExecutionContext,
): Promise<Response> {
  const period = discoverPeriod(url);
  const language = discoverLanguage(url);
  const key = discoverCacheKey(period, language);
  const cached = await readCachedWithOwnerMetadata(env, key);
  const ageMs = cacheAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && canDisplayCached(cached) && ageMs < discoverCacheTtlMs) {
    if (discoverNeedsHydration(cached)) {
      if (allowRefresh) {
        context.waitUntil(hydrateDiscoverCache(key, cached, env).catch(() => undefined));
        auditDashboardSync(context, env, {
          event: "discover_hydrate_schedule",
          targetKey: key,
          status: "queued",
          reason: "partial-cache",
          projects: cached.projects.length,
          scanned: cached.cache?.progress?.scanned,
          limit: cached.cache?.progress?.limit,
          done: cached.cache?.progress?.done,
          detail: dashboardSyncDetail(cached),
        });
      }
      return jsonResponse(
        withCacheState(
          cached,
          "partial",
          allowRefresh
            ? "scanning release data for top repositories"
            : "showing cached discovery results",
        ),
        200,
        { "cache-control": "no-store" },
      );
    }
    return jsonResponse(withCacheState(cached, "fresh"));
  }
  if (cached && canDisplayCached(cached) && !allowRefresh) {
    const state = discoverNeedsHydration(cached) ? "partial" : "stale";
    return jsonResponse(withCacheState(cached, state, "showing cached discovery results"), 200, {
      "cache-control": "no-store",
    });
  }

  try {
    const payload = await discoverPayload(period, language, env);
    await writeCached(env, key, payload);
    if (allowRefresh) {
      context.waitUntil(hydrateDiscoverCache(key, payload, env).catch(() => undefined));
      auditDashboardSync(context, env, {
        event: "discover_hydrate_schedule",
        targetKey: key,
        status: "queued",
        reason: "fresh-search",
        projects: payload.projects.length,
        scanned: payload.cache?.progress?.scanned,
        limit: payload.cache?.progress?.limit,
        done: payload.cache?.progress?.done,
        detail: dashboardSyncDetail(payload),
      });
    }
    return jsonResponse(payload, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (canDisplayCached(cached)) {
      return jsonResponse(
        withCacheState(cached, "stale", `${discoveryErrorMessage(error)} Showing cached search.`),
      );
    }
    const payload = discoverErrorPayload(period, language, env, error);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
}

export async function cachedDiscoverInitialData(
  env: Env,
  url: URL,
): Promise<InitialPageData | null> {
  const period = discoverPeriod(url);
  const language = discoverPageLanguage(url);
  const cached = await readCachedWithOwnerMetadata(env, discoverCacheKey(period, language));
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  const state = discoverNeedsHydration(cached)
    ? "partial"
    : cacheAgeMs(cached) < discoverCacheTtlMs
      ? "fresh"
      : "stale";
  return {
    route: "dashboard",
    payload: withCacheState(cached, state),
  };
}

export async function dashboardCacheKeyForPage(
  request: Request,
  url: URL,
  env: Env,
  primaryOwner: string | null,
): Promise<string | null> {
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return null;
  }
  const options = optionsFromUrl(url);
  const profile = primaryOwner ? await readProfile(env, primaryOwner) : null;
  const hiddenProfileOwners = new Set(profile?.hiddenOwners ?? []);
  const hiddenProfileRepos = new Set(profile?.hiddenRepos ?? []);
  const extraOwnerSlugs = uniqueSorted([
    ...(profile?.includeOwners ?? []),
    ...ownerListFromUrl(url, primaryOwner ?? undefined),
  ]).filter((owner) => owner !== primaryOwner && !hiddenProfileOwners.has(owner));
  const includeRepos = uniqueSorted([
    ...(profile?.includeRepos ?? []),
    ...repoListFromUrl(url),
  ]).filter(
    (repo) => !hiddenProfileOwners.has(repo.split("/")[0] ?? "") && !hiddenProfileRepos.has(repo),
  );
  if (extraOwnerSlugs.length + includeRepos.length > maxCustomSources) {
    return null;
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return null;
  }
  const ownerSlugs =
    primaryOwner && !hiddenProfileOwners.has(primaryOwner)
      ? [primaryOwner, ...extraOwnerSlugs]
      : extraOwnerSlugs;
  const tokenSources = { owners: ownerSlugs, repos: includeRepos };
  const keyInput = {
    owner: primaryOwner ?? "custom",
    owners: extraOwnerSlugs,
    repos: includeRepos,
    salt: profile?.updatedAt,
    ...options,
    schemaVersion: dashboardSchemaVersion,
  };
  const releaseKey = dashboardCacheKey({ ...keyInput, includeReleaseData: true });
  const metadataKey = dashboardCacheKey({ ...keyInput, includeReleaseData: false });
  const [releaseCached, registryCovered] = await Promise.all([
    readCached(env, releaseKey),
    sourceInstallationRegistryCovers(env, tokenSources).catch(() => false),
  ]);
  const unsyncedAppSource = appTokenConfigured(env) && !registryCovered;
  const metadataPreferred =
    unsyncedAppSource &&
    !(await dashboardReleaseDataAllowed(request, env, tokenSources, null, {
      sourceAppCovered: registryCovered,
    }));
  if (metadataPreferred) return metadataKey;
  if (
    releaseCached &&
    releaseCached.cache?.state !== "error" &&
    releaseCached.cache?.state !== "stale" &&
    cacheAgeMs(releaseCached) < fullTtlMs
  ) {
    return releaseKey;
  }
  const allowRefresh = allowRequestRefresh(request);
  const [token, sourceAppCovered] = allowRefresh
    ? [await bestInstallationToken(request, env, tokenSources).catch(() => null), false]
    : [null, registryCovered];
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token, {
    sourceAppCovered,
  });
  return includeReleaseData ? releaseKey : metadataKey;
}

export async function cachedDashboardInitialData(
  request: Request,
  env: Env,
  url: URL,
  primaryOwner: string | null,
): Promise<InitialPageData | null> {
  const key = await dashboardCacheKeyForPage(request, url, env, primaryOwner);
  const cached = key ? await readCachedWithOwnerMetadata(env, key) : null;
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  const state = dashboardStreamState(cached);
  return { route: "dashboard", payload: withCacheState(cached, state) };
}

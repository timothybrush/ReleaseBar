import { dashboardCacheKey, slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type { DashboardPayload, DashboardProfile, Project } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { hotIndexSchema, safeJsonParse, tryJsonParse } from "./schemas.js";
import type { InitialPageData } from "./app-shell.js";
import {
  dashboardCachePrefixes,
  type DashboardRequest,
  dashboardSchemaVersion,
  dashboardStorageTtlSeconds,
  hotCacheKey,
  hotCacheTtlMs,
  hotIndexKey,
  hotIndexLimit,
  hotInvalidatedAtKey,
  hotLimit,
  hotOwnerLimit,
  hotReadConcurrency,
  hotSourceLimit,
  type OwnerMetadataSnapshot,
  progressTtlSeconds,
  repoLimit,
  type StoredBuildProgress,
  type StoredBuildProgressTombstone,
} from "./config.js";
import {
  cacheAgeMs,
  canDisplayCached,
  canDisplayOwnerMetadata,
  canDisplayOwnerProjectCounts,
  canDisplayOwnerProjectMetadata,
  optionsFromUrl,
  withCacheState,
  writeCached,
} from "./dashboard-cache.js";
import { acquireBuildLock } from "./dashboard-rebuild.js";
import {
  mergeProjectCountFields,
  mergeProjectIssuePullCounts,
  mergeProjectMetadata,
  projectWithoutReleaseData,
  readDurableOwnerMetadata,
} from "./owner-metadata-read.js";
import {
  mergeOwnerMetadata,
  readCachedWithOwnerMetadata,
  safeIso,
} from "./owner-metadata-write.js";

export function progressKey(key: string): string {
  return `progress:v1:${key}`;
}

export function progressTombstoneKey(key: string): string {
  return `progress:tombstone:v1:${key}`;
}

export function isStoredBuildProgress(value: unknown): value is StoredBuildProgress {
  const progress = value as StoredBuildProgress | null;
  const validOptionalIso = (timestamp: unknown) =>
    timestamp === undefined ||
    timestamp === null ||
    (typeof timestamp === "string" && safeIso(timestamp) > 0);
  return Boolean(
    progress &&
    Array.isArray(progress.scannedRepos) &&
    Array.isArray(progress.projects) &&
    (progress.generationStartedAt === undefined ||
      (typeof progress.generationStartedAt === "string" &&
        safeIso(progress.generationStartedAt) > 0)) &&
    validOptionalIso(progress.countsUpdatedAt) &&
    (progress.projectCountsUpdatedAt === undefined ||
      (progress.projectCountsUpdatedAt !== null &&
        typeof progress.projectCountsUpdatedAt === "object" &&
        !Array.isArray(progress.projectCountsUpdatedAt) &&
        Object.values(progress.projectCountsUpdatedAt).every(
          (timestamp) => typeof timestamp === "string" && safeIso(timestamp) > 0,
        ))) &&
    validOptionalIso(progress.releasesUpdatedAt) &&
    validOptionalIso(progress.ciUpdatedAt) &&
    typeof progress.updatedAt === "string" &&
    safeIso(progress.updatedAt) > 0,
  );
}

export function isStoredBuildProgressTombstone(
  value: unknown,
): value is StoredBuildProgressTombstone {
  const tombstone = value as StoredBuildProgressTombstone | null;
  return Boolean(
    tombstone && typeof tombstone.clearedAt === "string" && safeIso(tombstone.clearedAt),
  );
}

export function storedBuildProgressExpired(progress: StoredBuildProgress): boolean {
  return Date.now() - safeIso(progress.updatedAt) > progressTtlSeconds * 1000;
}

export async function readFallbackProgress(
  env: Env,
  key: string,
): Promise<StoredBuildProgress | StoredBuildProgressTombstone | null> {
  const raw = await env.DASHBOARD_CACHE?.get(progressKey(key));
  if (!raw) return null;
  const stored = tryJsonParse<unknown>(raw, `progress ${key}`);
  if (isStoredBuildProgress(stored) || isStoredBuildProgressTombstone(stored)) {
    return stored;
  }
  return null;
}

export async function readProgressTombstone(
  env: Env,
  key: string,
): Promise<StoredBuildProgressTombstone | null> {
  const raw = await env.DASHBOARD_CACHE?.get(progressTombstoneKey(key));
  if (!raw) return null;
  const stored = tryJsonParse<unknown>(raw, `progress tombstone ${key}`);
  return isStoredBuildProgressTombstone(stored) ? stored : null;
}

export function latestProgressTombstone(
  fallback: StoredBuildProgress | StoredBuildProgressTombstone | null,
  tombstone: StoredBuildProgressTombstone | null,
): StoredBuildProgressTombstone | null {
  const legacy = isStoredBuildProgressTombstone(fallback) ? fallback : null;
  if (!legacy) return tombstone;
  if (!tombstone) return legacy;
  return safeIso(legacy.clearedAt) >= safeIso(tombstone.clearedAt) ? legacy : tombstone;
}

export function progressCleared(
  progress: StoredBuildProgress,
  tombstone: StoredBuildProgressTombstone | null,
): boolean {
  const generationStartedAt = progress.generationStartedAt ?? progress.updatedAt;
  return Boolean(tombstone && safeIso(tombstone.clearedAt) >= safeIso(generationStartedAt));
}

export function progressGenerationStartedAt(
  tombstone: StoredBuildProgressTombstone | null,
  now = Date.now(),
): string {
  const clearedAt = tombstone ? safeIso(tombstone.clearedAt) : 0;
  return new Date(
    clearedAt > 0 && clearedAt <= now ? Math.max(now, clearedAt + 1) : now,
  ).toISOString();
}

export async function beginProgressGeneration(env: Env, key: string): Promise<string> {
  return progressGenerationStartedAt(await readProgressTombstone(env, key));
}

export async function durableProgressResponse(
  env: Env,
  key: string,
  pathname: "get" | "put" | "delete",
  progress?: StoredBuildProgress,
): Promise<Response | null> {
  if (!env.DASHBOARD_LOCKS) return null;
  try {
    const id = env.DASHBOARD_LOCKS.idFromName(key);
    return await env.DASHBOARD_LOCKS.get(id).fetch(
      new Request(`https://releasebar.internal/progress/${pathname}`, {
        method: "POST",
        ...(progress ? { body: JSON.stringify(progress) } : {}),
      }),
    );
  } catch {
    return null;
  }
}

export function durableProgressSupported(response: Response | null): response is Response {
  return response?.headers.get("x-releasebar-progress") === "durable";
}

export async function readProgress(env: Env, key: string): Promise<StoredBuildProgress | null> {
  const [response, fallbackStored, storedTombstone] = await Promise.all([
    durableProgressResponse(env, key, "get"),
    readFallbackProgress(env, key),
    readProgressTombstone(env, key),
  ]);
  const durable = durableProgressSupported(response);
  const fallback = isStoredBuildProgress(fallbackStored) ? fallbackStored : null;
  const tombstone = latestProgressTombstone(fallbackStored, storedTombstone);
  let durableProgress: StoredBuildProgress | null = null;
  if (durable && response.ok) {
    try {
      const progress = await response.json();
      if (isStoredBuildProgress(progress)) {
        durableProgress = progress;
      }
    } catch {
      durableProgress = null;
    }
  }

  const markedFallback = fallback?.durableFallback ? fallback : null;
  const authoritativeDurable = durable && response.ok;
  const progress =
    durableProgress &&
    (!markedFallback || safeIso(durableProgress.updatedAt) >= safeIso(markedFallback.updatedAt))
      ? durableProgress
      : (markedFallback ?? (!authoritativeDurable ? fallback : null));
  if (!progress) return null;
  if (progressCleared(progress, tombstone)) {
    if (progress === durableProgress) {
      await durableProgressResponse(env, key, "delete");
    }
    return null;
  }
  if (storedBuildProgressExpired(progress)) {
    if (progress === durableProgress) {
      await durableProgressResponse(env, key, "delete");
    }
    await env.DASHBOARD_CACHE?.delete?.(progressKey(key));
    return null;
  }
  return progress;
}

export async function writeProgress(
  env: Env,
  key: string,
  progress: StoredBuildProgress,
): Promise<void> {
  const tombstone = await readProgressTombstone(env, key);
  if (progressCleared(progress, tombstone)) return;
  const response = await durableProgressResponse(env, key, "put", progress);
  if (durableProgressSupported(response) && response.ok) {
    await env.DASHBOARD_CACHE?.delete?.(progressKey(key)).catch(() => undefined);
    return;
  }
  await env.DASHBOARD_CACHE?.put(
    progressKey(key),
    JSON.stringify({ ...progress, durableFallback: true } satisfies StoredBuildProgress),
    {
      expirationTtl: progressTtlSeconds,
    },
  );
}

export async function writeProgressTombstone(
  env: Env,
  key: string,
): Promise<StoredBuildProgressTombstone> {
  const tombstone = {
    clearedAt: new Date().toISOString(),
  } satisfies StoredBuildProgressTombstone;
  await env.DASHBOARD_CACHE?.put(progressTombstoneKey(key), JSON.stringify(tombstone), {
    expirationTtl: progressTtlSeconds,
  });
  return tombstone;
}

export async function deleteProgress(env: Env, key: string): Promise<StoredBuildProgressTombstone> {
  if (env.DASHBOARD_LOCKS) {
    const response = await durableProgressResponse(env, key, "delete");
    if (!response) {
      return writeProgressTombstone(env, key);
    }
    if (response.headers.get("x-releasebar-progress") === "durable") {
      if (!response.ok) {
        return writeProgressTombstone(env, key);
      }
    } else if (!response.ok && response.status !== 404 && response.status !== 405) {
      return writeProgressTombstone(env, key);
    }
  }
  return writeProgressTombstone(env, key);
}

export function projectActivityDate(project: Project): string | null {
  return project.latestCommitDate || project.pushedAt || project.updatedAt;
}

export function daysSince(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

export function hotScore(project: Project): number {
  const commits = project.commitsSinceRelease ?? 0;
  const stars = Math.log1p(project.stars) * 6;
  const activityDays = daysSince(projectActivityDate(project));
  const recency =
    activityDays === null ? 0 : (Math.max(0, 30 - Math.min(activityDays, 30)) / 30) * 20;
  const prs = Math.log1p(project.openPullRequests ?? 0) * 2;
  const ci = project.ciState === "failure" ? 15 : project.ciState === "running" ? 5 : 0;
  return commits * 4 + stars + recency + prs + ci;
}

export function withProfile(
  payload: DashboardPayload,
  profile: DashboardProfile | null,
): DashboardPayload {
  if (!profile) return payload;
  const hiddenOwners = new Set(profile.hiddenOwners);
  const hiddenRepos = new Set(profile.hiddenRepos);
  const projects = payload.projects.filter(
    (project) =>
      !hiddenOwners.has(project.owner.toLowerCase()) &&
      !hiddenRepos.has(project.fullName.toLowerCase()),
  );
  const released = projects.filter((project) => project.releaseDate).length;
  return {
    ...payload,
    profile,
    totals: {
      repos: projects.length,
      released,
      unreleased: projects.length - released,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease ?? 0),
        0,
      ),
    },
    projects,
  };
}

export function dashboardTotals(projects: Project[]): DashboardPayload["totals"] {
  const released = projects.filter((project) => project.releaseDate).length;
  return {
    repos: projects.length,
    released,
    unreleased: projects.length - released,
    commitsSinceRelease: projects.reduce(
      (sum, project) => sum + (project.commitsSinceRelease ?? 0),
      0,
    ),
  };
}

export async function partialDashboardPayload(
  dashboard: DashboardRequest,
  env: Env,
  ownerSlugs: string[],
): Promise<DashboardPayload | null> {
  const options = optionsFromUrl(dashboard.url);
  const keys = [
    ...ownerSlugs.map((owner) =>
      dashboardCacheKey({
        owner,
        ...options,
        includeReleaseData: dashboard.includeReleaseData,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
    ...dashboard.includeRepos.map((repo) =>
      dashboardCacheKey({
        owner: "custom",
        repos: [repo],
        ...options,
        includeReleaseData: dashboard.includeReleaseData,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
  ];
  const dashboards = (
    await Promise.all([...new Set(keys)].map((key) => readCachedWithOwnerMetadata(env, key)))
  ).filter(
    (payload): payload is DashboardPayload =>
      canDisplayCached(payload) && payload.cache?.state !== "error" && payload.projects.length > 0,
  );
  const snapshotOwners = [
    ...new Set([
      ...ownerSlugs.map(slugOwner),
      ...dashboard.includeRepos.map((repo) => slugOwner(repo.split("/")[0] ?? "")),
    ]),
  ].filter(validOwnerSlug);
  const ownerSnapshots = (
    await Promise.all(snapshotOwners.map((owner) => readDurableOwnerMetadata(env, owner)))
  ).filter((snapshot): snapshot is OwnerMetadataSnapshot =>
    Boolean(snapshot && canDisplayOwnerMetadata(snapshot)),
  );
  if (dashboards.length === 0 && ownerSnapshots.length === 0) return null;

  const requestedOwners = new Set(ownerSlugs.map(slugOwner));
  const requestedRepos = new Set(dashboard.includeRepos.map((repo) => repo.toLowerCase()));
  const hiddenOwners = new Set(dashboard.profile?.hiddenOwners ?? []);
  const hiddenRepos = new Set(dashboard.profile?.hiddenRepos ?? []);
  const snapshotProjectVisible = (project: Project, checkRelease = true) => {
    const owner = slugOwner(project.owner);
    const fullName = project.fullName.toLowerCase();
    if (!requestedOwners.has(owner) && !requestedRepos.has(fullName)) return false;
    if (hiddenOwners.has(owner) || hiddenRepos.has(fullName)) return false;
    if (!options.includeForks && project.fork) return false;
    if (!options.includeArchived && project.archived) return false;
    if (checkRelease && !options.includeUnreleased && !project.releaseDate) return false;
    return true;
  };
  const projectsByName = new Map<string, Project>();
  const metadataUpdatedByName = new Map<string, number>();
  const countsUpdatedByName = new Map<string, number>();
  for (const payload of dashboards) {
    for (const project of payload.projects) {
      if (!snapshotProjectVisible(project)) continue;
      const fullName = project.fullName.toLowerCase();
      const metadataUpdatedAt = safeIso(payload.generatedAt);
      if (metadataUpdatedAt >= (metadataUpdatedByName.get(fullName) ?? 0)) {
        projectsByName.set(fullName, project);
        metadataUpdatedByName.set(fullName, metadataUpdatedAt);
        countsUpdatedByName.set(
          fullName,
          safeIso(
            payload.cache?.projectCountsUpdatedAt?.[fullName] ?? payload.cache?.countsUpdatedAt,
          ),
        );
      }
    }
  }
  for (const snapshot of ownerSnapshots) {
    const snapshotCountsUpdatedAt = safeIso(snapshot.countsUpdatedAt);
    if (snapshot.knownRepos) {
      for (const [fullName, project] of projectsByName) {
        if (
          slugOwner(project.owner) === snapshot.owner &&
          snapshotCountsUpdatedAt > (countsUpdatedByName.get(fullName) ?? 0) &&
          !snapshot.knownRepos.includes(fullName)
        ) {
          projectsByName.delete(fullName);
          metadataUpdatedByName.delete(fullName);
          countsUpdatedByName.delete(fullName);
        }
      }
    }
    for (const metadata of snapshot.projects) {
      const fullName = metadata.fullName.toLowerCase();
      if (
        !canDisplayOwnerProjectMetadata(snapshot, fullName) ||
        !snapshotProjectVisible(metadata)
      ) {
        continue;
      }
      const snapshotMetadataUpdatedAt = safeIso(snapshot.projectMetadataUpdatedAt[fullName]);
      const snapshotProjectCountsUpdatedAt = safeIso(snapshot.projectCountsUpdatedAt[fullName]);
      if (snapshot.removedRepos[fullName]) {
        projectsByName.delete(fullName);
        metadataUpdatedByName.delete(fullName);
        countsUpdatedByName.delete(fullName);
        continue;
      }
      const existing = projectsByName.get(fullName);
      const applyMetadata =
        !existing || snapshotMetadataUpdatedAt > (metadataUpdatedByName.get(fullName) ?? 0);
      const applyCounts =
        canDisplayOwnerProjectCounts(snapshot, fullName) &&
        snapshotProjectCountsUpdatedAt > (countsUpdatedByName.get(fullName) ?? 0);
      const metadataOnly = projectWithoutReleaseData(metadata);
      const merged =
        existing && applyMetadata
          ? mergeProjectMetadata(existing, metadataOnly)
          : (existing ?? metadataOnly);
      const counts = snapshot.countOverlays[fullName];
      const metadataClock = applyMetadata
        ? snapshotMetadataUpdatedAt
        : (metadataUpdatedByName.get(fullName) ?? 0);
      const project =
        applyCounts && counts
          ? snapshotProjectCountsUpdatedAt >= metadataClock
            ? mergeProjectCountFields(merged, counts)
            : mergeProjectIssuePullCounts(merged, counts)
          : merged;
      if (snapshotProjectVisible(project, false)) {
        projectsByName.set(fullName, project);
        if (applyMetadata) metadataUpdatedByName.set(fullName, snapshotMetadataUpdatedAt);
        if (applyCounts) countsUpdatedByName.set(fullName, snapshotProjectCountsUpdatedAt);
      } else {
        projectsByName.delete(fullName);
        metadataUpdatedByName.delete(fullName);
        countsUpdatedByName.delete(fullName);
      }
    }
    for (const [fullName, counts] of Object.entries(snapshot.countOverlays)) {
      if (
        snapshot.removedRepos[fullName] ||
        !canDisplayOwnerProjectCounts(snapshot, fullName) ||
        safeIso(snapshot.projectCountsUpdatedAt[fullName]) <=
          (countsUpdatedByName.get(fullName) ?? 0)
      ) {
        continue;
      }
      const existing = projectsByName.get(fullName);
      if (!existing || counts.private) continue;
      const countClock = safeIso(snapshot.projectCountsUpdatedAt[fullName]);
      const project =
        countClock >= (metadataUpdatedByName.get(fullName) ?? 0)
          ? mergeProjectCountFields(existing, counts)
          : mergeProjectIssuePullCounts(existing, counts);
      if (snapshotProjectVisible(project, false)) {
        projectsByName.set(fullName, project);
        countsUpdatedByName.set(fullName, safeIso(snapshot.projectCountsUpdatedAt[fullName]));
      } else {
        projectsByName.delete(fullName);
        metadataUpdatedByName.delete(fullName);
        countsUpdatedByName.delete(fullName);
      }
    }
  }
  const ownerCounts = new Map<string, number>();
  const projects = [...projectsByName.values()]
    .sort((left, right) => safeIso(right.pushedAt) - safeIso(left.pushedAt))
    .filter((project) => {
      const fullName = project.fullName.toLowerCase();
      if (requestedRepos.has(fullName)) return true;
      const owner = slugOwner(project.owner);
      const count = ownerCounts.get(owner) ?? 0;
      if (count >= repoLimit) return false;
      ownerCounts.set(owner, count + 1);
      return true;
    });
  const generatedAt = dashboards
    .map((payload) => payload.generatedAt)
    .concat(ownerSnapshots.map((snapshot) => snapshot.generatedAt))
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()[0];
  const firstQuota = dashboards.find((payload) => payload.cache?.quota)?.cache?.quota;
  const oldestCompleteTimestamp = (values: Array<string | null | undefined>) => {
    if (values.length === 0 || values.some((value) => !value)) return null;
    return [...values].sort()[0] ?? null;
  };
  const countsUpdatedAt = oldestCompleteTimestamp([
    ...dashboards.map((payload) => payload.cache?.countsUpdatedAt),
    ...ownerSnapshots.map((snapshot) => snapshot.countsUpdatedAt),
  ]);
  const projectCountsUpdatedAt = Object.fromEntries(
    projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      const updatedAt = countsUpdatedByName.get(fullName);
      return updatedAt ? [[fullName, new Date(updatedAt).toISOString()]] : [];
    }),
  );
  const releasesUpdatedAt = oldestCompleteTimestamp(
    dashboards.map((payload) => payload.cache?.releasesUpdatedAt),
  );
  const ciUpdatedAt = oldestCompleteTimestamp(
    dashboards.map((payload) => payload.cache?.ciUpdatedAt),
  );
  return withProfile(
    {
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      generatedAt: generatedAt ?? new Date().toISOString(),
      owners: dashboard.owners,
      options: {
        ...options,
        repoLimit,
      },
      cache: {
        state: "partial",
        stale: true,
        capped: dashboards.some((payload) => payload.cache?.capped),
        repoLimit,
        generatedAt: generatedAt ?? new Date().toISOString(),
        countsUpdatedAt,
        projectCountsUpdatedAt,
        releasesUpdatedAt,
        ciUpdatedAt,
        ...(firstQuota ? { quota: firstQuota } : {}),
        message: `showing cached data from ${dashboards.length + ownerSnapshots.length} source${dashboards.length + ownerSnapshots.length === 1 ? "" : "s"} while the combined dashboard updates`,
      },
      totals: dashboardTotals(projects),
      projects,
    },
    dashboard.profile,
  );
}

export async function readCachedDashboards(env: Env): Promise<DashboardPayload[]> {
  if (!env.DASHBOARD_CACHE) return [];
  const cache = env.DASHBOARD_CACHE;

  let keys = await readHotIndex(env);
  if (keys.length < hotSourceLimit && cache.list) {
    for (const prefix of dashboardCachePrefixes) {
      if (keys.length >= hotSourceLimit) break;
      const page = await cache.list({
        prefix,
        limit: hotSourceLimit,
      });
      keys = [...new Set([...keys, ...page.keys.map((key) => key.name)])];
    }
  }

  const dashboards = await mapConcurrent(
    keys.slice(0, hotSourceLimit),
    hotReadConcurrency,
    async (key) => {
      const raw = await cache.get(key);
      if (!raw) return null;
      const rawPayload = tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`);
      if (!canDisplayCached(rawPayload)) return null;
      const payload = await mergeOwnerMetadata(env, rawPayload);
      if (
        payload.cache?.state === "error" ||
        payload.options?.includeForks ||
        payload.projects.length === 0
      ) {
        return null;
      }
      return payload;
    },
  );

  return dashboards.filter((payload): payload is DashboardPayload => payload !== null);
}

export async function readHotIndex(env: Env): Promise<string[]> {
  const raw = await env.DASHBOARD_CACHE?.get(hotIndexKey);
  if (!raw) return [];
  const keys = safeJsonParse(hotIndexSchema, raw, "hot index");
  return keys
    ? keys.filter((key) => dashboardCachePrefixes.some((prefix) => key.startsWith(prefix)))
    : [];
}

export async function rememberHotDashboard(
  env: Env,
  key: string,
  payload: DashboardPayload,
): Promise<void> {
  if (payload.options?.includeForks) return;
  if (!payload.projects.some(canContributeToHotDashboard)) return;
  const keys = await readHotIndex(env);
  const next = [key, ...keys.filter((existing) => existing !== key)].slice(0, hotIndexLimit);
  await env.DASHBOARD_CACHE?.put(hotIndexKey, JSON.stringify(next), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function canContributeToHotDashboard(project: Project): boolean {
  return !project.archived && Boolean(project.releaseDate) && project.commitsSinceRelease !== null;
}

export function hotDashboardPayload(
  dashboards: DashboardPayload[],
  env: Env,
  generatedAt = new Date().toISOString(),
): DashboardPayload {
  const candidates = new Map<string, Project>();
  for (const dashboard of dashboards) {
    for (const project of dashboard.projects) {
      if (!canContributeToHotDashboard(project)) {
        continue;
      }
      const existing = candidates.get(project.fullName.toLowerCase());
      if (!existing || hotScore(project) > hotScore(existing)) {
        candidates.set(project.fullName.toLowerCase(), project);
      }
    }
  }

  const ownerCounts = new Map<string, number>();
  const projects = [...candidates.values()]
    .sort((a, b) => hotScore(b) - hotScore(a))
    .filter((project) => {
      const owner = project.owner.toLowerCase();
      const count = ownerCounts.get(owner) ?? 0;
      if (count >= hotOwnerLimit) return false;
      ownerCounts.set(owner, count + 1);
      return true;
    })
    .slice(0, hotLimit);
  const omitted = candidates.size > projects.length;

  return {
    title: "ReleaseBar Hot",
    subtitle: "Release debt across recently requested public dashboards.",
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: false,
      repoLimit: null,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: omitted,
      repoLimit: null,
      generatedAt,
      message: `built from ${dashboards.length} cached dashboard${dashboards.length === 1 ? "" : "s"}`,
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

export async function refreshHotCache(env: Env): Promise<DashboardPayload | null> {
  const lock = await acquireBuildLock(env, `${hotCacheKey}:refresh`);
  if (!lock) return null;
  try {
    const payload = hotDashboardPayload(await readCachedDashboards(env), env);
    await writeCached(env, hotCacheKey, payload);
    return payload;
  } finally {
    await lock.release();
  }
}

export async function markHotCacheStale(env: Env): Promise<void> {
  await env.DASHBOARD_CACHE?.put(hotInvalidatedAtKey, new Date().toISOString(), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function hotInvalidatedAt(env: Env): Promise<number> {
  return safeIso(await env.DASHBOARD_CACHE?.get(hotInvalidatedAtKey));
}

export function hotCacheIsStale(payload: DashboardPayload, invalidatedAt: number): boolean {
  return (
    payload.cache?.state === "stale" ||
    cacheAgeMs(payload) >= hotCacheTtlMs ||
    invalidatedAt >= safeIso(payload.generatedAt)
  );
}

export async function hotResponse(env: Env, context: ExecutionContext): Promise<Response> {
  const [cached, invalidatedAt] = await Promise.all([
    readCachedWithOwnerMetadata(env, hotCacheKey),
    hotInvalidatedAt(env),
  ]);
  if (cached && canDisplayCached(cached) && !hotCacheIsStale(cached, invalidatedAt)) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }
  if (cached && canDisplayCached(cached)) {
    context.waitUntil(refreshHotCache(env).catch(() => null));
    return jsonResponse(
      withCacheState(cached, "stale", "showing cached Hot dashboard while it refreshes"),
    );
  }

  const payload =
    (await refreshHotCache(env)) ?? hotDashboardPayload(await readCachedDashboards(env), env);
  return jsonResponse(payload);
}

export async function cachedHotInitialData(env: Env): Promise<InitialPageData | null> {
  const [cached, invalidatedAt] = await Promise.all([
    readCachedWithOwnerMetadata(env, hotCacheKey),
    hotInvalidatedAt(env),
  ]);
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  return {
    route: "dashboard",
    payload: withCacheState(cached, hotCacheIsStale(cached, invalidatedAt) ? "stale" : "fresh"),
  };
}

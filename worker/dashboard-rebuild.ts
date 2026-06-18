import {
  buildDashboard,
  dashboardCacheKey,
  slugOwner,
  validOwnerSlug,
} from "../scripts/lib/dashboard.js";
import type { DashboardPayload, Project, RefreshTarget } from "../src/types.js";
import { randomNonce } from "./crypto.js";
import {
  auditGitHubFetch,
  sharedQuotaCooldown,
  type SharedQuotaCooldown,
  sharedQuotaDeferUntil,
} from "./github-audit.js";
import { corsHeaders, jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { statusPayload } from "./admin.js";
import { ownerListFromUrl, repoListFromUrl, uniqueSorted } from "./app-shell.js";
import { appTokenConfigured, dashboardReleaseDataAllowed } from "./auth-oauth.js";
import {
  bestInstallationToken,
  sourceAccounts,
  sourceInstallationRegistryCovers,
  sourceInstallationToken,
  sourcesForAccount,
} from "./auth-tokens.js";
import {
  beginProgressGeneration,
  dashboardTotals,
  deleteProgress,
  progressGenerationStartedAt,
  readProgress,
  rememberHotDashboard,
  withProfile,
  writeProgress,
} from "./build-progress.js";
import {
  authenticatedReleaseOwnerPageSize,
  type BuildLock,
  buildLockRefreshMs,
  buildLockTtlMs,
  type DashboardOwnerCredentials,
  type DashboardRequest,
  dashboardSchemaVersion,
  fullTtlMs,
  initialMetadataRepoLimit,
  installationRegistryFastPathMaxAgeMs,
  localBuildLocks,
  maxCustomSources,
  progressiveBuildBudgetMs,
  progressWriteIntervalMs,
  refreshQueueDeliveryDelaySeconds,
  repoLimit,
  repoScanBatchSize,
  type StoredBuildProgress,
} from "./config.js";
import {
  cacheAgeMs,
  canDisplayCached,
  dashboardErrorMessage,
  errorMessage,
  isAbortError,
  optionsFromUrl,
  quotaForDashboard,
  readCached,
  readCachedRaw,
  readProfile,
  withCacheState,
  writeCached,
} from "./dashboard-cache.js";
import {
  allowRequestRefresh,
  mergeOwnerMetadata,
  readCachedWithOwnerMetadata,
  rememberOwnerMetadata,
} from "./owner-metadata-write.js";
import { enqueueRefreshJob } from "./refresh-queue.js";
import { auditSyncEvent, dashboardSyncDetail } from "./refresh-targets.js";

export async function dashboardEventParts(
  request: Request,
  env: Env,
): Promise<{ key: string } | null> {
  const url = new URL(request.url);
  const rawOwner =
    url.pathname
      .replace(/^\/api\//, "")
      .replace(/\/events$/, "")
      .split("/")[0] ?? "";
  const primaryOwner = rawOwner === "dashboard" ? null : slugOwner(rawOwner);
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
  const allowRefresh = allowRequestRefresh(request);
  const [token, sourceAppCovered] = allowRefresh
    ? [await bestInstallationToken(request, env, tokenSources).catch(() => null), false]
    : [null, await sourceInstallationRegistryCovers(env, tokenSources).catch(() => false)];
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token, {
    sourceAppCovered,
  });
  return {
    key: dashboardCacheKey({
      owner: primaryOwner ?? "custom",
      owners: extraOwnerSlugs,
      repos: includeRepos,
      salt: profile?.updatedAt,
      ...options,
      includeReleaseData,
      schemaVersion: dashboardSchemaVersion,
    }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function dashboardStreamState(
  payload: DashboardPayload,
): NonNullable<DashboardPayload["cache"]>["state"] {
  if (payload.cache?.progress?.done === false) return "partial";
  if (payload.cache?.state === "stale" || payload.cache?.stale) return "stale";
  return cacheAgeMs(payload) < fullTtlMs ? "fresh" : "stale";
}

export function dashboardStreamSignature(
  payload: DashboardPayload,
  state: NonNullable<DashboardPayload["cache"]>["state"] = dashboardStreamState(payload),
): string {
  return JSON.stringify({ state, payload });
}

export async function ownerEventsResponse(request: Request, env: Env): Promise<Response> {
  const parts = await dashboardEventParts(request, env);
  if (!parts) {
    return jsonResponse({ error: "invalid dashboard event stream" }, 400, {
      "cache-control": "no-store",
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      await auditSyncEvent(env, {
        event: "dashboard_stream_start",
        targetKey: parts.key,
        status: "running",
      });
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      controller.enqueue(encoder.encode("retry: 5000\n\n"));
      let lastSignature = "";
      let sent = 0;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const payload = await readCachedWithOwnerMetadata(env, parts.key);
        if (canDisplayCached(payload)) {
          const state = dashboardStreamState(payload);
          const next = withCacheState(payload, state);
          const signature = dashboardStreamSignature(next, state);
          if (signature !== lastSignature) {
            lastSignature = signature;
            send("dashboard", next);
            sent += 1;
            await auditSyncEvent(env, {
              event: "dashboard_stream_send",
              targetKey: parts.key,
              status: state,
              projects: next.projects.length,
              scanned: next.cache?.progress?.scanned,
              limit: next.cache?.progress?.limit,
              done: next.cache?.progress?.done,
              detail: dashboardSyncDetail(next),
            });
          }
          if (state === "fresh") break;
        } else {
          send("ping", { state: "waiting" });
        }
        await sleep(5000);
      }
      await auditSyncEvent(env, {
        event: "dashboard_stream_done",
        targetKey: parts.key,
        status: "closed",
        durationMs: Date.now() - startedAt,
        events: sent,
        detail: `events=${sent}`,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...corsHeaders,
    },
  });
}

export async function acquireBuildLock(env: Env, key: string): Promise<BuildLock | null> {
  const acquireLocal = (): BuildLock | null => {
    const now = Date.now();
    const existing = localBuildLocks.get(key);
    if (existing && existing.expiresAt > now) return null;
    const token = randomNonce();
    localBuildLocks.set(key, { token, expiresAt: now + buildLockTtlMs });
    return {
      refresh: async () => {
        const current = localBuildLocks.get(key);
        if (current?.token === token) {
          localBuildLocks.set(key, { token, expiresAt: Date.now() + buildLockTtlMs });
        }
      },
      release: async () => {
        if (localBuildLocks.get(key)?.token === token) {
          localBuildLocks.delete(key);
        }
      },
    };
  };
  if (!env.DASHBOARD_LOCKS) {
    return acquireLocal();
  }

  try {
    const token = randomNonce();
    const id = env.DASHBOARD_LOCKS.idFromName(key);
    const stub = env.DASHBOARD_LOCKS.get(id);
    const response = await stub.fetch(
      new Request("https://releasebar.internal/acquire", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    );
    if (response.status === 409) {
      return null;
    }
    if (!response.ok) {
      return acquireLocal();
    }
    const sendToken = (pathname: string) =>
      stub.fetch(
        new Request(`https://releasebar.internal/${pathname}`, {
          method: "POST",
          body: JSON.stringify({ token }),
        }),
      );
    return {
      refresh: async () => {
        await sendToken("refresh").catch(() => undefined);
      },
      release: async () => {
        await sendToken("release").catch(() => undefined);
      },
    };
  } catch {
    return acquireLocal();
  }
}

export async function dashboardOwnerCredentials(
  dashboard: DashboardRequest,
  env: Env,
  signal?: AbortSignal,
): Promise<DashboardOwnerCredentials> {
  if (!appTokenConfigured(env)) return {};
  const sources = {
    owners: dashboard.owners.map((owner) => owner.login),
    repos: dashboard.includeRepos,
  };
  const credentials: DashboardOwnerCredentials = {};
  await Promise.all(
    sourceAccounts(sources).map(async (account) => {
      const requestToken =
        dashboard.quotaSource === "app" &&
        dashboard.token &&
        slugOwner(dashboard.quotaAccount ?? "") === account
          ? {
              token: dashboard.token,
              quotaSource: "app" as const,
              quotaAccount: dashboard.quotaAccount ?? account,
            }
          : await sourceInstallationToken(env, sourcesForAccount(sources, account), {
              discover: true,
              maxRegistryAgeMs: installationRegistryFastPathMaxAgeMs,
              signal,
            }).catch(() => null);
      if (!requestToken) return;
      credentials[account] = {
        token: requestToken.token,
        quotaSource: requestToken.quotaSource,
        quotaAccount: requestToken.quotaAccount,
        fetch: auditGitHubFetch(
          "dashboard",
          requestToken.quotaSource,
          requestToken.quotaAccount,
          env,
          undefined,
          signal,
        ),
      };
    }),
  );
  return credentials;
}

export async function rebuild(
  dashboard: DashboardRequest,
  env: Env,
  signal?: AbortSignal,
): Promise<DashboardPayload> {
  const startedAt = Date.now();
  const [storedProgress, existingCached] = await Promise.all([
    readProgress(env, dashboard.key),
    readCachedRaw(env, dashboard.key),
  ]);
  const generationStartedAt =
    storedProgress?.generationStartedAt ??
    storedProgress?.updatedAt ??
    (await beginProgressGeneration(env, dashboard.key));
  await auditSyncEvent(env, {
    event: "dashboard_build_start",
    targetKey: dashboard.key,
    status: "running",
    source: dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
    projects: storedProgress?.projects.length ?? 0,
    scanned: storedProgress?.scannedRepos.length ?? 0,
    detail: storedProgress
      ? `resume scanned=${storedProgress.scannedRepos.length} projects=${storedProgress.projects.length}`
      : "fresh build",
  });
  const scannedRepos = new Set(storedProgress?.scannedRepos ?? []);
  const progressProjects = storedProgress?.projects ?? [];
  const removedOwnerRepos = new Set<string>();
  const observedOwnerProjects = new Map<string, Project>();
  let lastProgressWriteAt = 0;
  const saveProgress = async (
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
  ) => {
    for (const removedRepo of progress.removedRepos ?? []) {
      const fullName = removedRepo.toLowerCase();
      scannedRepos.delete(fullName);
    }
    for (const absentRepo of progress.absentRepos ?? []) {
      removedOwnerRepos.add(absentRepo.toLowerCase());
    }
    for (const project of progress.observedProjects ?? []) {
      observedOwnerProjects.set(project.fullName.toLowerCase(), project);
    }
    const scannedRepo = progress.scannedRepo;
    if (scannedRepo) {
      scannedRepos.add(scannedRepo.toLowerCase());
    }
    const done = payload.cache?.progress?.done !== false;
    const now = Date.now();
    if (!done && now - lastProgressWriteAt < progressWriteIntervalMs) {
      return;
    }
    lastProgressWriteAt = now;
    const profiled = withProfile(payload, dashboard.profile);
    const stored: StoredBuildProgress = {
      scannedRepos: [...scannedRepos],
      projects: profiled.projects,
      generationStartedAt,
      countsUpdatedAt: profiled.cache?.countsUpdatedAt ?? null,
      projectCountsUpdatedAt: profiled.cache?.projectCountsUpdatedAt ?? {},
      releasesUpdatedAt: profiled.cache?.releasesUpdatedAt ?? null,
      ciUpdatedAt: profiled.cache?.ciUpdatedAt ?? null,
      updatedAt: profiled.generatedAt,
    };
    await Promise.all([
      ...(!done
        ? [writeCached(env, dashboard.key, profiled), writeProgress(env, dashboard.key, stored)]
        : []),
      auditSyncEvent(env, {
        event: "dashboard_progress_write",
        targetKey: dashboard.key,
        status: done ? "fresh" : "partial",
        phase: progress.phase,
        projects: profiled.projects.length,
        scanned: payload.cache?.progress?.scanned ?? progress.scanned,
        limit: payload.cache?.progress?.limit,
        done,
        detail: dashboardSyncDetail(profiled, scannedRepo ? `repo=${scannedRepo}` : ""),
      }),
    ]);
  };
  try {
    const ownerCredentials = await dashboardOwnerCredentials(dashboard, env, signal);
    const payload = await buildDashboard({
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      owners: dashboard.owners,
      includeRepos: dashboard.includeRepos,
      excludeRepos: dashboard.profile?.hiddenRepos,
      ...optionsFromUrl(dashboard.url),
      repoLimit,
      repoScanLimit: repoScanBatchSize,
      repoScanTarget: repoLimit,
      ownerPageSize:
        dashboard.includeReleaseData &&
        (dashboard.quotaSource ??
          (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous")) === "app"
          ? authenticatedReleaseOwnerPageSize
          : 100,
      initialProjects: progressProjects,
      skipRepos: [...scannedRepos],
      token: dashboard.token ?? env.GITHUB_TOKEN,
      includeReleaseData: dashboard.includeReleaseData,
      hydrateSort: dashboard.hydrateSort,
      hydrateDirection: dashboard.hydrateDirection,
      quotaSource:
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
      quotaAccount: dashboard.quotaAccount ?? null,
      ownerCredentials,
      previousCountsUpdatedAt:
        existingCached?.cache?.countsUpdatedAt ?? storedProgress?.countsUpdatedAt ?? null,
      previousProjectCountsUpdatedAt:
        existingCached?.cache?.projectCountsUpdatedAt ??
        storedProgress?.projectCountsUpdatedAt ??
        {},
      previousReleasesUpdatedAt:
        existingCached?.cache?.releasesUpdatedAt ?? storedProgress?.releasesUpdatedAt ?? null,
      previousCiUpdatedAt:
        existingCached?.cache?.ciUpdatedAt ?? storedProgress?.ciUpdatedAt ?? null,
      generationStartedAt,
      fetch: auditGitHubFetch(
        "dashboard",
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
        dashboard.quotaAccount ?? null,
        env,
        undefined,
        signal,
      ),
      projectCache: env.DASHBOARD_CACHE,
      onProgress: (partial, progress) => saveProgress(partial, progress),
    });
    const profiled = withProfile(payload, dashboard.profile);
    await rememberOwnerMetadata(
      env,
      {
        ...payload,
        projects: [
          ...payload.projects,
          ...[...observedOwnerProjects.values()].filter(
            (project) =>
              !payload.projects.some(
                (visible) => visible.fullName.toLowerCase() === project.fullName.toLowerCase(),
              ),
          ),
        ],
      },
      "hydrated",
      removedOwnerRepos,
      generationStartedAt,
    );
    const merged = await mergeOwnerMetadata(env, profiled, generationStartedAt);
    if (merged.cache?.progress?.done === false) {
      await Promise.all([
        writeCached(env, dashboard.key, merged),
        writeProgress(env, dashboard.key, {
          scannedRepos: [...scannedRepos],
          projects: merged.projects,
          generationStartedAt,
          countsUpdatedAt: merged.cache?.countsUpdatedAt ?? null,
          projectCountsUpdatedAt: merged.cache?.projectCountsUpdatedAt ?? {},
          releasesUpdatedAt: merged.cache?.releasesUpdatedAt ?? null,
          ciUpdatedAt: merged.cache?.ciUpdatedAt ?? null,
          updatedAt: merged.generatedAt,
        }),
      ]);
    } else {
      await deleteProgress(env, dashboard.key);
      await Promise.all([
        writeCached(env, dashboard.key, merged),
        rememberHotDashboard(env, dashboard.key, merged),
      ]);
    }
    await auditSyncEvent(env, {
      event: "dashboard_build_done",
      targetKey: dashboard.key,
      status: merged.cache?.progress?.done === false ? "partial" : "fresh",
      durationMs: Date.now() - startedAt,
      projects: merged.projects.length,
      scanned: merged.cache?.progress?.scanned,
      limit: merged.cache?.progress?.limit,
      done: merged.cache?.progress?.done,
      detail: dashboardSyncDetail(merged),
    });
    return merged;
  } catch (error) {
    await auditSyncEvent(env, {
      event: isAbortError(error) ? "dashboard_build_aborted" : "dashboard_build_failed",
      targetKey: dashboard.key,
      status: isAbortError(error) ? "aborted" : "failed",
      durationMs: Date.now() - startedAt,
      reason: dashboardErrorMessage(error),
    });
    throw error;
  }
}

export async function rebuildWithBuildLock(
  dashboard: DashboardRequest,
  env: Env,
  signal?: AbortSignal,
): Promise<DashboardPayload | null> {
  const lock = await acquireBuildLock(env, dashboard.key);
  if (!lock) {
    await auditSyncEvent(env, {
      event: "dashboard_build_skip",
      targetKey: dashboard.key,
      status: "locked",
      reason: "build-lock",
    });
    return null;
  }

  const refresh = globalThis.setInterval(() => {
    void lock.refresh();
  }, buildLockRefreshMs);
  try {
    return await rebuild(dashboard, env, signal);
  } finally {
    globalThis.clearInterval(refresh);
    await lock.release();
  }
}

export async function sharedQuotaDashboardCooldown(
  dashboard: DashboardRequest,
  env: Env,
): Promise<SharedQuotaCooldown | null> {
  const source =
    dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous");
  return source === "shared" && env.GITHUB_TOKEN ? sharedQuotaCooldown(env) : null;
}

export async function progressiveBuildPausedForSharedQuota(
  dashboard: DashboardRequest,
  env: Env,
): Promise<boolean> {
  const cooldown = await sharedQuotaDashboardCooldown(dashboard, env);
  if (!cooldown?.active) return false;
  const until = sharedQuotaDeferUntil(cooldown);
  await auditSyncEvent(env, {
    event: "dashboard_progressive_skip",
    targetKey: dashboard.key,
    status: "skipped",
    reason: "shared-quota",
    detail: `until=${until} remaining=${cooldown.remaining ?? "unknown"} resource=${cooldown.resource ?? "any"}`,
  });
  return true;
}

export async function continueProgressiveBuild(
  dashboard: DashboardRequest,
  env: Env,
  budgetMs = progressiveBuildBudgetMs,
  externalSignal?: AbortSignal,
): Promise<DashboardPayload | null> {
  if (await progressiveBuildPausedForSharedQuota(dashboard, env)) return null;
  const startedAt = Date.now();
  const deadlineController = externalSignal ? null : new AbortController();
  const signal = externalSignal ?? deadlineController!.signal;
  const deadlineTimer = deadlineController
    ? globalThis.setTimeout(() => deadlineController.abort(), budgetMs)
    : null;
  await auditSyncEvent(env, {
    event: "dashboard_progressive_start",
    targetKey: dashboard.key,
    status: "running",
    detail: `budgetMs=${budgetMs}`,
  });
  try {
    let previousScanned = (await readProgress(env, dashboard.key))?.scannedRepos.length ?? 0;
    let payload = await rebuildWithBuildLock(dashboard, env, signal);
    while (
      payload?.cache?.progress?.done === false &&
      !signal.aborted &&
      Date.now() - startedAt < budgetMs
    ) {
      const scanned = payload.cache?.progress?.scanned ?? 0;
      if (scanned <= previousScanned) break;
      previousScanned = scanned;
      if (await progressiveBuildPausedForSharedQuota(dashboard, env)) break;
      const next = await rebuildWithBuildLock(dashboard, env, signal);
      if (!next) {
        payload = null;
        break;
      }
      payload = next;
    }
    await auditSyncEvent(env, {
      event: "dashboard_progressive_done",
      targetKey: dashboard.key,
      status:
        payload?.cache?.progress?.done === false ? "partial" : (payload?.cache?.state ?? "done"),
      durationMs: Date.now() - startedAt,
      projects: payload?.projects.length ?? 0,
      scanned: payload?.cache?.progress?.scanned,
      limit: payload?.cache?.progress?.limit,
      done: payload?.cache?.progress?.done,
      detail: dashboardSyncDetail(payload),
    });
    return payload;
  } finally {
    if (deadlineTimer !== null) {
      globalThis.clearTimeout(deadlineTimer);
    }
  }
}

export function scheduleProgressiveBuild(
  dashboard: DashboardRequest,
  env: Env,
  context: ExecutionContext,
  reason: string,
  target: RefreshTarget | null,
  initialBuild?: Promise<DashboardPayload | null>,
  queueDelaySeconds = refreshQueueDeliveryDelaySeconds,
): void {
  const task = env.REFRESH_QUEUE
    ? (async () => {
        if (!target) {
          await auditSyncEvent(env, {
            event: "dashboard_refresh_schedule_failed",
            targetKey: dashboard.key,
            status: "missing-target",
            reason,
          });
          return;
        }
        await enqueueRefreshJob(env, context, target, reason, queueDelaySeconds);
      })()
    : initialBuild
      ? initialBuild.then((payload) =>
          payload && payload.cache?.progress?.done !== false
            ? payload
            : continueProgressiveBuild(dashboard, env, progressiveBuildBudgetMs),
        )
      : continueProgressiveBuild(dashboard, env, progressiveBuildBudgetMs);
  context.waitUntil(
    task.catch((error) =>
      auditSyncEvent(env, {
        event: "dashboard_refresh_schedule_failed",
        targetKey: dashboard.key,
        status: "failed",
        reason: errorMessage(error),
      }),
    ),
  );
}

export async function refreshDashboardMetadataFirst(
  dashboard: DashboardRequest,
  env: Env,
  signal?: AbortSignal,
  resetProgress = false,
  boundedInitialPage = false,
  context?: ExecutionContext,
): Promise<DashboardPayload | null> {
  const lock = await acquireBuildLock(env, dashboard.key);
  if (!lock) {
    await auditSyncEvent(env, {
      event: "dashboard_manual_refresh_skip",
      targetKey: dashboard.key,
      status: "locked",
      reason: "build-lock",
    });
    return null;
  }

  const refresh = globalThis.setInterval(() => {
    void lock.refresh();
  }, buildLockRefreshMs);
  const startedAt = Date.now();
  try {
    const existingCached = await readCached(env, dashboard.key);
    const storedProgress = resetProgress ? null : await readProgress(env, dashboard.key);
    if (storedProgress) {
      const resumed = dashboardPayloadFromProgress(dashboard, env, storedProgress, existingCached);
      await auditSyncEvent(env, {
        event: "dashboard_manual_refresh_resume",
        targetKey: dashboard.key,
        status: "partial",
        projects: resumed.projects.length,
        scanned: resumed.cache?.progress?.scanned,
        limit: resumed.cache?.progress?.limit,
        done: resumed.cache?.progress?.done,
        detail: "phase=metadata source=checkpoint",
      });
      return resumed;
    }
    const tombstone = await deleteProgress(env, dashboard.key);
    const generationStartedAt = progressGenerationStartedAt(tombstone);
    await auditSyncEvent(env, {
      event: "dashboard_manual_refresh_start",
      targetKey: dashboard.key,
      status: "running",
      detail: "phase=metadata",
    });
    const ownerCredentials = await dashboardOwnerCredentials(dashboard, env, signal);
    const payload = await buildDashboard({
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      owners: dashboard.owners,
      includeRepos: dashboard.includeRepos,
      excludeRepos: dashboard.profile?.hiddenRepos,
      ...optionsFromUrl(dashboard.url),
      repoLimit: boundedInitialPage ? initialMetadataRepoLimit : repoLimit,
      repoScanLimit: 0,
      repoScanTarget: repoLimit,
      ...(boundedInitialPage
        ? {
            ownerPageSize: initialMetadataRepoLimit,
            ownerPageLimit: 1,
          }
        : {}),
      token: dashboard.token ?? env.GITHUB_TOKEN,
      includeReleaseData: false,
      hydrateSort: dashboard.hydrateSort,
      hydrateDirection: dashboard.hydrateDirection,
      quotaSource:
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
      quotaAccount: dashboard.quotaAccount ?? null,
      ownerCredentials,
      previousCountsUpdatedAt: existingCached?.cache?.countsUpdatedAt ?? null,
      previousProjectCountsUpdatedAt: existingCached?.cache?.projectCountsUpdatedAt ?? {},
      fetch: auditGitHubFetch(
        "dashboard",
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
        dashboard.quotaAccount ?? null,
        env,
        context,
        signal,
      ),
      projectCache: env.DASHBOARD_CACHE,
    });
    const metadataPayload: DashboardPayload = {
      ...payload,
      ...(payload.options
        ? {
            options: {
              ...payload.options,
              repoLimit,
            },
          }
        : {}),
      ...(payload.cache
        ? {
            cache: {
              ...payload.cache,
              capped: boundedInitialPage ? false : payload.cache.capped,
              repoLimit,
              releasesUpdatedAt:
                existingCached?.cache?.releasesUpdatedAt ?? payload.cache.releasesUpdatedAt ?? null,
              ciUpdatedAt: existingCached?.cache?.ciUpdatedAt ?? payload.cache.ciUpdatedAt ?? null,
            },
          }
        : {}),
    };
    const partial = withCacheState(
      metadataPayload,
      "partial",
      "repository metadata refreshed; release data updating",
    );
    if (partial.cache?.progress) {
      partial.cache.progress.done = false;
    }
    const profiled = withProfile(partial, dashboard.profile);
    await rememberOwnerMetadata(env, partial, "metadata", [], generationStartedAt);
    const merged = await mergeOwnerMetadata(env, profiled, generationStartedAt);
    await writeCached(env, dashboard.key, merged);
    await writeProgress(env, dashboard.key, {
      scannedRepos: [],
      projects: merged.projects,
      generationStartedAt,
      countsUpdatedAt: merged.cache?.countsUpdatedAt ?? null,
      projectCountsUpdatedAt: merged.cache?.projectCountsUpdatedAt ?? {},
      releasesUpdatedAt: merged.cache?.releasesUpdatedAt ?? null,
      ciUpdatedAt: merged.cache?.ciUpdatedAt ?? null,
      updatedAt: merged.generatedAt,
    });
    await auditSyncEvent(env, {
      event: "dashboard_manual_refresh_metadata_done",
      targetKey: dashboard.key,
      status: "partial",
      durationMs: Date.now() - startedAt,
      projects: merged.projects.length,
      scanned: merged.cache?.progress?.scanned,
      limit: merged.cache?.progress?.limit,
      done: merged.cache?.progress?.done,
      detail: dashboardSyncDetail(merged),
    });
    return merged;
  } finally {
    globalThis.clearInterval(refresh);
    await lock.release();
  }
}

export function dashboardPayloadFromProgress(
  dashboard: DashboardRequest,
  env: Env,
  progress: StoredBuildProgress,
  existingCached: DashboardPayload | null = null,
): DashboardPayload {
  const generatedAt = progress.updatedAt;
  return withProfile(
    {
      ...statusPayload(
        dashboard,
        env,
        "partial",
        "release data update resumed from checkpoint",
        generatedAt,
      ),
      cache: {
        state: "partial",
        stale: true,
        capped: false,
        repoLimit,
        generatedAt,
        countsUpdatedAt: progress.countsUpdatedAt ?? existingCached?.cache?.countsUpdatedAt ?? null,
        projectCountsUpdatedAt:
          progress.projectCountsUpdatedAt ?? existingCached?.cache?.projectCountsUpdatedAt ?? {},
        releasesUpdatedAt:
          progress.releasesUpdatedAt ?? existingCached?.cache?.releasesUpdatedAt ?? null,
        ciUpdatedAt: progress.ciUpdatedAt ?? existingCached?.cache?.ciUpdatedAt ?? null,
        quota: quotaForDashboard(dashboard, env),
        progress: {
          scanned: progress.scannedRepos.length,
          limit: repoLimit,
          done: false,
        },
        message: "release data update resumed from checkpoint",
      },
      totals: dashboardTotals(progress.projects),
      projects: progress.projects,
    },
    dashboard.profile,
  );
}

export function errorPayload(
  dashboard: DashboardRequest,
  env: Env,
  message: string,
): DashboardPayload {
  return statusPayload(dashboard, env, "error", message, new Date().toISOString());
}

import { dashboardCacheKey, slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type { DashboardPayload, Owner } from "../src/types.js";
import { corsHeaders, jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { rebuildingPayload, statusPayload, unresolvedDashboardRequest } from "./admin.js";
import { ownerListFromUrl, repoListFromUrl, resolveOwners, uniqueSorted } from "./app-shell.js";
import {
  appTokenConfigured,
  authDependentDashboardHeaders,
  dashboardReleaseDataAllowed,
} from "./auth-oauth.js";
import { bestInstallationToken, sourceInstallationRegistryCovers } from "./auth-tokens.js";
import { partialDashboardPayload, readProgress } from "./build-progress.js";
import {
  buildLockTtlMs,
  buildPending,
  coldBuildWaitMs,
  type DashboardRequest,
  dashboardSchemaVersion,
  fullTtlMs,
  manualRefreshCooldownSeconds,
  maxCustomSources,
  refreshQueueDeliveryDelaySeconds,
  type RequestToken,
} from "./config.js";
import {
  cacheAgeMs,
  canDisplayCached,
  dashboardErrorMessage,
  errorMessage,
  errorStatus,
  isAbortError,
  manualRefreshCooldownActive,
  markManualRefreshCooldown,
  optionsFromUrl,
  readProfile,
  retryAfterHeaders,
  withCacheState,
  writeCached,
} from "./dashboard-cache.js";
import {
  dashboardPayloadFromProgress,
  errorPayload,
  rebuildWithBuildLock,
  refreshDashboardMetadataFirst,
  scheduleProgressiveBuild,
  sleep,
} from "./dashboard-rebuild.js";
import {
  allowRequestRefresh,
  mergeOwnerMetadata,
  readCachedWithOwnerMetadata,
} from "./owner-metadata-write.js";
import { refreshTargetBackoffActive } from "./refresh-queue.js";
import {
  auditDashboardSync,
  auditSyncEvent,
  dashboardSyncDetail,
  rememberRefreshTarget,
} from "./refresh-targets.js";
import { dashboardRequest } from "./request-lock.js";

export async function ownerResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const allowRefresh = allowRequestRefresh(request);
  const rawOwner = url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "";
  const primaryOwner = rawOwner === "dashboard" ? null : slugOwner(rawOwner);
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return jsonResponse({ error: "invalid owner" }, 400);
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
    return jsonResponse({ error: `too many custom sources; max ${maxCustomSources}` }, 400, {
      "cache-control": "no-store",
    });
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return jsonResponse({ error: "at least one owner or repo is required" }, 400);
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
  const [releaseCached, metadataCached, registryCovered] = await Promise.all([
    readCachedWithOwnerMetadata(env, releaseKey),
    readCachedWithOwnerMetadata(env, metadataKey),
    sourceInstallationRegistryCovers(env, tokenSources).catch(() => false),
  ]);
  if (request.method === "GET") {
    const releaseFastCached =
      releaseCached &&
      releaseCached.cache?.state !== "error" &&
      releaseCached.cache?.state !== "stale" &&
      releaseCached.cache?.progress?.done !== false &&
      cacheAgeMs(releaseCached) < fullTtlMs
        ? releaseCached
        : null;
    const metadataFastCached =
      metadataCached &&
      metadataCached.cache?.state !== "error" &&
      metadataCached.cache?.state !== "stale" &&
      metadataCached.cache?.progress?.done !== false &&
      cacheAgeMs(metadataCached) < fullTtlMs
        ? metadataCached
        : null;
    const unsyncedAppSource = appTokenConfigured(env) && !registryCovered;
    const metadataPreferred =
      unsyncedAppSource &&
      !(await dashboardReleaseDataAllowed(request, env, tokenSources, null, {
        sourceAppCovered: registryCovered,
      }));
    const fastCached = metadataPreferred
      ? metadataFastCached
        ? {
            key: metadataKey,
            payload: metadataFastCached,
            includeReleaseData: false,
            refreshKey: metadataKey,
            refreshReleaseData: false,
          }
        : null
      : releaseFastCached
        ? {
            key: releaseKey,
            payload: releaseFastCached,
            includeReleaseData: true,
            refreshKey: releaseKey,
            refreshReleaseData: true,
          }
        : null;
    if (fastCached) {
      if (allowRefresh) {
        context.waitUntil(
          rememberRefreshTarget(env, {
            key: fastCached.refreshKey,
            owner: primaryOwner ?? "custom",
            owners: ownerSlugs,
            repos: includeRepos,
            profile,
            includeReleaseData: fastCached.refreshReleaseData,
            path: `${url.pathname}${url.search}`,
            priority: primaryOwner ? 100 : 60,
          }).catch(() => null),
        );
      }
      const payload = fastCached.payload;
      auditDashboardSync(context, env, {
        event: "dashboard_request",
        targetKey: fastCached.key,
        status: "fresh",
        source: "cache-fast-path",
        projects: payload.projects.length,
        detail: `owners=${ownerSlugs.length} repos=${includeRepos.length} includeReleaseData=${fastCached.includeReleaseData}`,
      });
      return jsonResponse(
        withCacheState(payload, "fresh"),
        200,
        authDependentDashboardHeaders(env),
      );
    }
  }
  const coldBuildStartedAt = allowRefresh && env.REFRESH_QUEUE ? Date.now() : null;
  const credentialController = coldBuildStartedAt === null ? null : new AbortController();
  const credentialTimer = credentialController
    ? globalThis.setTimeout(() => credentialController.abort(), coldBuildWaitMs)
    : undefined;
  let token: RequestToken | null = null;
  if (allowRefresh) {
    token = await bestInstallationToken(request, env, tokenSources, {
      signal: credentialController?.signal,
    }).catch(() => null);
  }
  if (credentialTimer) {
    globalThis.clearTimeout(credentialTimer);
  }
  const sourceAppCovered =
    !allowRefresh || credentialController?.signal.aborted ? registryCovered : false;
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token, {
    sourceAppCovered,
  });
  const key = includeReleaseData ? releaseKey : metadataKey;
  const refreshTarget = allowRefresh
    ? await rememberRefreshTarget(env, {
        key,
        owner: primaryOwner ?? "custom",
        owners: ownerSlugs,
        repos: includeRepos,
        profile,
        includeReleaseData,
        path: `${url.pathname}${url.search}`,
        priority: primaryOwner ? 100 : 60,
      })
    : null;
  const cachedBase = includeReleaseData ? releaseCached : metadataCached;
  const cached = cachedBase;
  const ageMs = cacheAgeMs(cached);
  const displayCached = canDisplayCached(cached);
  auditDashboardSync(context, env, {
    event: "dashboard_request",
    targetKey: key,
    status: displayCached ? (cached.cache?.state ?? "cached") : "miss",
    source: primaryOwner ? "owner" : "custom",
    projects: cached?.projects.length ?? 0,
    scanned: cached?.cache?.progress?.scanned,
    limit: cached?.cache?.progress?.limit,
    done: cached?.cache?.progress?.done,
    detail: `ageMs=${ageMs} owners=${ownerSlugs.length} repos=${includeRepos.length} includeReleaseData=${includeReleaseData}`,
  });

  if (request.method === "POST") {
    if (await manualRefreshCooldownActive(env, key)) {
      await auditSyncEvent(env, {
        event: "dashboard_manual_refresh_skip",
        targetKey: key,
        status: "cooldown",
        reason: "cooldown",
        detail: `cooldownSeconds=${manualRefreshCooldownSeconds}`,
      });
      if (displayCached) {
        const state = cached.cache?.progress?.done === false ? "partial" : "stale";
        return jsonResponse(
          withCacheState(
            cached,
            state,
            "manual refresh recently started; showing cached dashboard",
          ),
          202,
          {
            "cache-control": "no-store",
            ...corsHeaders,
          },
        );
      }
      return jsonResponse({ error: "manual refresh recently started" }, 429, {
        "cache-control": "no-store",
        ...corsHeaders,
      });
    }
    let owners: Owner[] | null = cached?.owners ?? null;
    if (!owners) {
      try {
        owners = await resolveOwners(
          ownerSlugs,
          env,
          token?.token,
          token?.quotaSource,
          token?.quotaAccount ?? null,
          undefined,
          context,
        );
      } catch (error) {
        return jsonResponse({ error: dashboardErrorMessage(error) }, errorStatus(error), {
          ...retryAfterHeaders(error),
          ...corsHeaders,
        });
      }
    }
    if (!owners) {
      return jsonResponse({ error: "owner not found" }, 404, {
        "cache-control": "no-store",
        ...corsHeaders,
      });
    }
    const dashboard = dashboardRequest(
      owners,
      includeRepos,
      profile,
      key,
      url,
      includeReleaseData,
      token,
    );
    if (!options.includeUnreleased) {
      await markManualRefreshCooldown(env, key);
      scheduleProgressiveBuild(dashboard, env, context, "manual-refresh", refreshTarget);
      if (displayCached) {
        return jsonResponse(
          withCacheState(cached, "stale", "manual refresh started; release data updating"),
          202,
          {
            "cache-control": "no-store",
            ...corsHeaders,
          },
        );
      }
      return jsonResponse(rebuildingPayload(dashboard, env), 202, {
        "cache-control": "no-store",
        ...corsHeaders,
      });
    }

    let payload: DashboardPayload | null;
    try {
      payload = await refreshDashboardMetadataFirst(
        dashboard,
        env,
        undefined,
        true,
        false,
        context,
      );
    } catch (error) {
      const failed = errorPayload(dashboard, env, dashboardErrorMessage(error));
      if (!displayCached) {
        await writeCached(env, key, failed, 5 * 60);
      }
      return jsonResponse(failed, errorStatus(error), {
        ...retryAfterHeaders(error),
        ...corsHeaders,
      });
    }
    if (payload) {
      await markManualRefreshCooldown(env, key);
      scheduleProgressiveBuild(dashboard, env, context, "manual-refresh", refreshTarget);
      return jsonResponse(payload, 202, { "cache-control": "no-store", ...corsHeaders });
    }
    if (displayCached) {
      return jsonResponse(
        withCacheState(cached, "partial", "manual refresh already running"),
        202,
        {
          "cache-control": "no-store",
          ...corsHeaders,
        },
      );
    }
    return jsonResponse(rebuildingPayload(dashboard, env), 202, {
      "cache-control": "no-store",
      ...corsHeaders,
    });
  }

  if (displayCached && cached.cache?.state === "error") {
    const dashboard = cachedDashboardRequest(
      cached,
      includeRepos,
      key,
      url,
      includeReleaseData,
      token,
    );
    if (allowRefresh && (!refreshTarget || !refreshTargetBackoffActive(refreshTarget))) {
      scheduleProgressiveBuild(dashboard, env, context, "error-cache", refreshTarget);
      auditDashboardSync(context, env, {
        event: "dashboard_refresh_schedule",
        targetKey: key,
        status: "queued",
        reason: "error-cache",
        projects: cached.projects.length,
        detail: dashboardSyncDetail(cached),
      });
    } else if (allowRefresh && refreshTarget) {
      auditDashboardSync(context, env, {
        event: "dashboard_refresh_schedule",
        targetKey: key,
        status: "backoff",
        reason: "error-cache",
        projects: cached.projects.length,
        detail: `nextDueAt=${refreshTarget.nextDueAt} failureCount=${refreshTarget.failureCount}`,
      });
    }
    return jsonResponse(cached, errorStatus(cached.cache.message ?? ""), {
      "cache-control": "no-store",
    });
  }

  if (
    displayCached &&
    cached.cache?.state !== "stale" &&
    cached.cache?.progress?.done !== false &&
    ageMs < fullTtlMs
  ) {
    return jsonResponse(withCacheState(cached, "fresh"), 200, authDependentDashboardHeaders(env));
  }

  if (displayCached) {
    const dashboard = cachedDashboardRequest(
      cached,
      includeRepos,
      key,
      url,
      includeReleaseData,
      token,
    );
    const state = cached.cache?.progress?.done === false ? "partial" : "stale";
    if (allowRefresh && (!refreshTarget || !refreshTargetBackoffActive(refreshTarget))) {
      scheduleProgressiveBuild(
        dashboard,
        env,
        context,
        state === "partial" ? "partial-cache" : "stale-cache",
        refreshTarget,
      );
      auditDashboardSync(context, env, {
        event: "dashboard_refresh_schedule",
        targetKey: key,
        status: "queued",
        reason: state === "partial" ? "partial-cache" : "stale-cache",
        projects: cached.projects.length,
        scanned: cached.cache?.progress?.scanned,
        limit: cached.cache?.progress?.limit,
        done: cached.cache?.progress?.done,
        detail: dashboardSyncDetail(cached),
      });
    } else if (allowRefresh && refreshTarget) {
      auditDashboardSync(context, env, {
        event: "dashboard_refresh_schedule",
        targetKey: key,
        status: "backoff",
        reason: state === "partial" ? "partial-cache" : "stale-cache",
        projects: cached.projects.length,
        scanned: cached.cache?.progress?.scanned,
        limit: cached.cache?.progress?.limit,
        done: cached.cache?.progress?.done,
        detail: `nextDueAt=${refreshTarget.nextDueAt} failureCount=${refreshTarget.failureCount}`,
      });
    }
    return jsonResponse(withCacheState(cached, state), 200, {
      "cache-control": "no-store",
    });
  }

  if (!allowRefresh) {
    const dashboard = unresolvedDashboardRequest(
      ownerSlugs,
      includeRepos,
      profile,
      key,
      url,
      includeReleaseData,
      token,
    );
    return jsonResponse(
      statusPayload(
        dashboard,
        env,
        "rebuilding",
        "cached dashboard unavailable for crawler",
        new Date().toISOString(),
      ),
      202,
      { "cache-control": "no-store" },
    );
  }

  if (refreshTarget && refreshTargetBackoffActive(refreshTarget)) {
    const dashboard = unresolvedDashboardRequest(
      ownerSlugs,
      includeRepos,
      profile,
      key,
      url,
      includeReleaseData,
      token,
    );
    const message = `refresh paused after repeated failures; retry scheduled ${refreshTarget.nextDueAt}`;
    const storedProgress = await readProgress(env, key);
    const rawPayload = storedProgress
      ? withCacheState(
          dashboardPayloadFromProgress(dashboard, env, storedProgress, cached),
          "partial",
          message,
        )
      : statusPayload(dashboard, env, "rebuilding", message, new Date().toISOString());
    const payload = storedProgress ? await mergeOwnerMetadata(env, rawPayload) : rawPayload;
    auditDashboardSync(context, env, {
      event: "dashboard_response",
      targetKey: key,
      status: "backoff",
      reason: "refresh-target",
      projects: payload.projects.length,
      scanned: payload.cache?.progress?.scanned,
      limit: payload.cache?.progress?.limit,
      done: payload.cache?.progress?.done,
      detail: `nextDueAt=${refreshTarget.nextDueAt} failureCount=${refreshTarget.failureCount}`,
    });
    return jsonResponse(payload, storedProgress ? 200 : 202, {
      "cache-control": "no-store",
    });
  }

  const coldBuildController = env.REFRESH_QUEUE ? new AbortController() : null;
  const coldBuildRemainingMs =
    coldBuildStartedAt === null
      ? coldBuildWaitMs
      : Math.max(0, coldBuildWaitMs - (Date.now() - coldBuildStartedAt));
  let coldWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const coldDeadline = new Promise<typeof buildPending>((resolve) => {
    coldWaitTimer = setTimeout(() => {
      coldBuildController?.abort();
      resolve(buildPending);
    }, coldBuildRemainingMs);
  });
  let owners: Owner[] | null;
  try {
    owners = await resolveOwners(
      ownerSlugs,
      env,
      token?.token,
      token?.quotaSource,
      token?.quotaAccount ?? null,
      coldBuildController?.signal,
      context,
    );
  } catch (error) {
    if (coldWaitTimer) {
      clearTimeout(coldWaitTimer);
    }
    if (coldBuildController && isAbortError(error)) {
      const dashboard = unresolvedDashboardRequest(
        ownerSlugs,
        includeRepos,
        profile,
        key,
        url,
        includeReleaseData,
        token,
      );
      auditDashboardSync(context, env, {
        event: "dashboard_cold_wait_timeout",
        targetKey: key,
        status: "queued",
        reason: "cold-owner",
        detail: `waitMs=${coldBuildWaitMs} phase=owner`,
      });
      scheduleProgressiveBuild(
        dashboard,
        env,
        context,
        options.includeUnreleased && includeReleaseData ? "cold-metadata" : "cold-build",
        refreshTarget,
      );
      const partial = await partialDashboardPayload(dashboard, env, ownerSlugs);
      return jsonResponse(partial ?? rebuildingPayload(dashboard, env), partial ? 200 : 202, {
        "cache-control": "no-store",
      });
    }
    const dashboard = unresolvedDashboardRequest(
      ownerSlugs,
      includeRepos,
      profile,
      key,
      url,
      includeReleaseData,
      token,
    );
    const payload = errorPayload(dashboard, env, dashboardErrorMessage(error));
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
  if (!owners) {
    if (coldWaitTimer) {
      clearTimeout(coldWaitTimer);
    }
    return jsonResponse({ error: "owner not found" }, 404, {
      "cache-control": "no-store",
    });
  }

  const dashboard = dashboardRequest(
    owners,
    includeRepos,
    profile,
    key,
    url,
    includeReleaseData,
    token,
  );
  const metadataFirst = options.includeUnreleased && dashboard.includeReleaseData;
  const build = metadataFirst
    ? refreshDashboardMetadataFirst(
        dashboard,
        env,
        coldBuildController?.signal,
        false,
        true,
        context,
      )
    : rebuildWithBuildLock(dashboard, env, coldBuildController?.signal);
  const buildReason = metadataFirst ? "cold-metadata" : "cold-build";
  try {
    const payload = await Promise.race([build, coldDeadline]);
    if (coldWaitTimer) {
      clearTimeout(coldWaitTimer);
    }
    if (payload === buildPending || payload === null) {
      auditDashboardSync(context, env, {
        event: "dashboard_cold_wait_timeout",
        targetKey: key,
        status: payload === null ? "locked" : "queued",
        reason: buildReason,
        detail: `waitMs=${coldBuildWaitMs} phase=${metadataFirst ? "metadata" : "hydrate"}`,
      });
      let queueDelaySeconds = refreshQueueDeliveryDelaySeconds;
      if (env.REFRESH_QUEUE) {
        const settled = build.then(
          () => true,
          async (error) => {
            if (!isAbortError(error)) {
              await auditSyncEvent(env, {
                event: "dashboard_cold_build_abandoned",
                targetKey: key,
                status: "failed",
                reason: errorMessage(error),
              });
            }
            return true;
          },
        );
        coldBuildController?.abort();
        const stopped = await Promise.race([settled, sleep(250).then(() => false)]);
        if (!stopped) {
          queueDelaySeconds = Math.ceil(buildLockTtlMs / 1000);
          await auditSyncEvent(env, {
            event: "dashboard_cold_build_abort_pending",
            targetKey: key,
            status: "queued",
            reason: buildReason,
            detail: `queueDelaySeconds=${queueDelaySeconds}`,
          }).catch(() => undefined);
        }
      }
      scheduleProgressiveBuild(
        dashboard,
        env,
        context,
        buildReason,
        refreshTarget,
        env.REFRESH_QUEUE ? undefined : build,
        queueDelaySeconds,
      );
      const progressive = await readCachedWithOwnerMetadata(env, key);
      if (canDisplayCached(progressive) && progressive.projects.length) {
        auditDashboardSync(context, env, {
          event: "dashboard_response",
          targetKey: key,
          status: "partial-cache",
          projects: progressive.projects.length,
          scanned: progressive.cache?.progress?.scanned,
          limit: progressive.cache?.progress?.limit,
          done: progressive.cache?.progress?.done,
          detail: dashboardSyncDetail(progressive, "source=progress-cache"),
        });
        return jsonResponse(withCacheState(progressive, "partial"), 200, {
          "cache-control": "no-store",
        });
      }
      const partial = await partialDashboardPayload(dashboard, env, ownerSlugs);
      if (partial) {
        auditDashboardSync(context, env, {
          event: "dashboard_response",
          targetKey: key,
          status: "partial-seed",
          projects: partial.projects.length,
          scanned: partial.cache?.progress?.scanned,
          limit: partial.cache?.progress?.limit,
          done: partial.cache?.progress?.done,
          detail: dashboardSyncDetail(partial, "source=seed-cache"),
        });
        return jsonResponse(partial, 200, {
          "cache-control": "no-store",
        });
      }
      auditDashboardSync(context, env, {
        event: "dashboard_response",
        targetKey: key,
        status: "rebuilding",
        projects: 0,
        detail: "source=status-payload",
      });
      return jsonResponse(rebuildingPayload(dashboard, env), 202, {
        "cache-control": "no-store",
      });
    }
    const visiblePayload = await mergeOwnerMetadata(env, payload);
    if (visiblePayload.cache?.progress?.done === false) {
      if (allowRefresh && (!refreshTarget || !refreshTargetBackoffActive(refreshTarget))) {
        const reason = metadataFirst ? "cold-metadata" : "partial-build";
        scheduleProgressiveBuild(dashboard, env, context, reason, refreshTarget);
        auditDashboardSync(context, env, {
          event: "dashboard_refresh_schedule",
          targetKey: key,
          status: "queued",
          reason,
          projects: visiblePayload.projects.length,
          scanned: visiblePayload.cache?.progress?.scanned,
          limit: visiblePayload.cache?.progress?.limit,
          done: visiblePayload.cache?.progress?.done,
          detail: dashboardSyncDetail(visiblePayload),
        });
      } else if (allowRefresh && refreshTarget) {
        auditDashboardSync(context, env, {
          event: "dashboard_refresh_schedule",
          targetKey: key,
          status: "backoff",
          reason: metadataFirst ? "cold-metadata" : "partial-build",
          projects: visiblePayload.projects.length,
          scanned: visiblePayload.cache?.progress?.scanned,
          limit: visiblePayload.cache?.progress?.limit,
          done: visiblePayload.cache?.progress?.done,
          detail: `nextDueAt=${refreshTarget.nextDueAt} failureCount=${refreshTarget.failureCount}`,
        });
      }
      return jsonResponse(visiblePayload, 200, {
        "cache-control": "no-store",
      });
    }
    return jsonResponse(visiblePayload, 200, authDependentDashboardHeaders(env));
  } catch (error) {
    if (coldWaitTimer) {
      clearTimeout(coldWaitTimer);
    }
    const payload = errorPayload(dashboard, env, dashboardErrorMessage(error));
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
}

export function cachedDashboardRequest(
  payload: DashboardPayload,
  includeRepos: string[],
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    payload.owners,
    includeRepos,
    payload.profile ?? null,
    key,
    url,
    includeReleaseData,
    token,
  );
}

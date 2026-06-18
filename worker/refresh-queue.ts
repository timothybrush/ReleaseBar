import {
  fetchOwnerRepoCounts,
  type OwnerRepoCount,
  slugOwner,
  validOwnerSlug,
} from "../scripts/lib/dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import {
  auditGitHubFetch,
  githubGraphqlOwnerReleaseOperation,
  graphqlBackoffActive,
  sharedQuotaCooldown,
} from "./github-audit.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { sourceInstallationRegistryCovers, sourceInstallationToken } from "./auth-tokens.js";
import { markHotCacheStale } from "./build-progress.js";
import {
  dashboardStorageTtlSeconds,
  githubGraphqlOwnerCountsOperation,
  githubGraphqlRepoDetailsOperation,
  refreshJobReservationTtlMs,
  refreshOwnerCountCursorKey,
  refreshQueueDeliveryDelaySeconds,
  refreshStateKey,
  schedulerBatchLimit,
  schedulerCountConcurrency,
  schedulerCountOwnerLimit,
  schedulerCountRefreshMs,
  schedulerRecentViewMs,
  schedulerSharedDormantAfterMs,
  schedulerSharedDormantRefreshMs,
  schedulerTargetPageLimit,
  type StoredRefreshDirty,
} from "./config.js";
import { canDisplayCached, errorMessage, readCached } from "./dashboard-cache.js";
import { readOwnerMetadata } from "./owner-metadata-read.js";
import { mutateOwnerMetadataSnapshot, safeIso } from "./owner-metadata-write.js";
import {
  auditScheduler,
  auditSyncEvent,
  backfillRefreshTargetIndexes,
  indexRefreshJob,
  jitterMs,
  listRefreshJobs,
  listRefreshTargets,
  localRefreshJobReservationStore,
  readRefreshTarget,
  recordLocalRefreshDirty,
  refreshJob,
  refreshJobActive,
  takeLocalRefreshDirty,
  writeRefreshJob,
} from "./refresh-targets.js";
import { processRefreshJobFallback } from "./scheduler.js";
import { invalidateDashboardTargets } from "./webhook-targets.js";

export function refreshQueueMessage(job: RefreshJob): RefreshJob {
  const { target: _target, ...message } = job;
  return message;
}

export async function reserveRefreshJob(
  env: Env,
  targetKey: string,
  jobId: string,
  dirtyOnConflict?: StoredRefreshDirty,
): Promise<boolean> {
  const reserveFallback = async (): Promise<boolean> => {
    const reservations = localRefreshJobReservationStore(env);
    const now = Date.now();
    const local = reservations.get(targetKey);
    if (local && local.jobId !== jobId && local.expiresAt > now) {
      if (dirtyOnConflict) recordLocalRefreshDirty(env, targetKey, dirtyOnConflict);
      return false;
    }
    reservations.set(targetKey, {
      jobId,
      expiresAt: now + refreshJobReservationTtlMs,
    });
    try {
      const active = (await listRefreshJobs(env)).find(
        (job) => job.targetKey === targetKey && job.id !== jobId && refreshJobActive(job),
      );
      if (!active) return true;
      if (reservations.get(targetKey)?.jobId === jobId) {
        reservations.delete(targetKey);
      }
      if (dirtyOnConflict) recordLocalRefreshDirty(env, targetKey, dirtyOnConflict);
      return false;
    } catch (error) {
      if (reservations.get(targetKey)?.jobId === jobId) {
        reservations.delete(targetKey);
      }
      throw error;
    }
  };
  if (!env.DASHBOARD_LOCKS) {
    return reserveFallback();
  }
  try {
    const id = env.DASHBOARD_LOCKS.idFromName(targetKey);
    const response = await env.DASHBOARD_LOCKS.get(id).fetch(
      new Request("https://releasebar.internal/job/reserve", {
        method: "POST",
        body: JSON.stringify({ jobId, dirtyOnConflict }),
      }),
    );
    if (response.status === 409) return false;
    if (response.ok) return true;
    await auditSyncEvent(env, {
      event: "job_reservation_fallback",
      targetKey,
      jobId,
      status: "fallback",
      reason: `durable reservation status ${response.status}`,
    }).catch(() => undefined);
  } catch (error) {
    await auditSyncEvent(env, {
      event: "job_reservation_fallback",
      targetKey,
      jobId,
      status: "fallback",
      reason: errorMessage(error),
    }).catch(() => undefined);
  }
  return reserveFallback();
}

export async function releaseRefreshJobReservation(
  env: Env,
  targetKey: string,
  jobId: string,
  consumeDirty = false,
): Promise<StoredRefreshDirty | null> {
  const reservations = localRefreshJobReservationStore(env);
  let localDirty: StoredRefreshDirty | null = null;
  if (reservations.get(targetKey)?.jobId === jobId) {
    reservations.delete(targetKey);
    if (consumeDirty) {
      localDirty = takeLocalRefreshDirty(env, targetKey);
    }
  }
  if (!env.DASHBOARD_LOCKS) return localDirty;
  try {
    const id = env.DASHBOARD_LOCKS.idFromName(targetKey);
    const response = await env.DASHBOARD_LOCKS.get(id).fetch(
      new Request("https://releasebar.internal/job/release", {
        method: "POST",
        body: JSON.stringify({ jobId, consumeDirty }),
      }),
    );
    if (response.ok) {
      if (response.status === 200) {
        const dirty = (await response.json()) as StoredRefreshDirty;
        if (typeof dirty.observedAt === "string" && typeof dirty.reason === "string") {
          return dirty;
        }
      }
      return localDirty;
    }
    await auditSyncEvent(env, {
      event: "job_reservation_release_failed",
      targetKey,
      jobId,
      status: "failed",
      reason: `durable reservation release status ${response.status}`,
    }).catch(() => undefined);
  } catch (error) {
    await auditSyncEvent(env, {
      event: "job_reservation_release_failed",
      targetKey,
      jobId,
      status: "failed",
      reason: errorMessage(error),
    }).catch(() => undefined);
  }
  return localDirty;
}

export async function enqueueRefreshJob(
  env: Env,
  context: ExecutionContext,
  target: RefreshTarget,
  reason: string,
  delaySeconds = refreshQueueDeliveryDelaySeconds,
): Promise<RefreshJob | null> {
  if (
    reason !== "manual-refresh" &&
    !reason.startsWith("webhook:") &&
    refreshTargetBackoffActive(target)
  ) {
    await auditSyncEvent(env, {
      event: "job_enqueue_skip",
      targetKey: target.key,
      status: "backoff",
      reason,
      detail: `nextDueAt=${target.nextDueAt} failureCount=${target.failureCount}`,
    });
    return null;
  }
  const job = refreshJob(target, reason);
  const dirtyOnConflict = reason.startsWith("webhook:")
    ? { observedAt: new Date().toISOString(), reason }
    : undefined;
  if (!(await reserveRefreshJob(env, target.key, job.id, dirtyOnConflict))) {
    await auditSyncEvent(env, {
      event: "job_enqueue_skip",
      targetKey: target.key,
      status: "reserved",
      reason,
    });
    return null;
  }
  try {
    await indexRefreshJob(env, job);
    await auditScheduler(env, {
      event: "job_enqueue",
      targetKey: target.key,
      jobId: job.id,
      reason,
    });
    if (env.REFRESH_QUEUE) {
      await env.REFRESH_QUEUE.send(refreshQueueMessage(job), {
        delaySeconds,
      });
    } else {
      context.waitUntil(
        processRefreshJobFallback(job, env).then(
          async (result) => {
            await finishRefreshJobReservation(env, context, result);
          },
          async (error) => {
            await finishRefreshJobReservation(env, context, job);
            throw error;
          },
        ),
      );
    }
  } catch (error) {
    const now = new Date().toISOString();
    await writeRefreshJob(env, {
      ...job,
      status: "failed",
      finishedAt: now,
      updatedAt: now,
      error: errorMessage(error),
    }).catch(() => undefined);
    await releaseRefreshJobReservation(env, target.key, job.id).catch(() => undefined);
    throw error;
  }
  return job;
}

export async function finishRefreshJobReservation(
  env: Env,
  context: ExecutionContext,
  job: RefreshJob,
): Promise<void> {
  const dirty = await releaseRefreshJobReservation(env, job.targetKey, job.id, true);
  if (!dirty) return;
  const target = job.target ?? (await readRefreshTarget(env, job.targetKey));
  if (!target) {
    await auditSyncEvent(env, {
      event: "job_followup_failed",
      targetKey: job.targetKey,
      jobId: job.id,
      status: "failed",
      reason: "target missing",
      detail: `webhookReason=${dirty.reason}`,
    });
    return;
  }
  await invalidateDashboardTargets(env, [target]);
  const followup = await enqueueRefreshJob(env, context, target, `${dirty.reason}:follow-up`, 0);
  await auditSyncEvent(env, {
    event: followup ? "job_followup_enqueue" : "job_followup_defer",
    targetKey: target.key,
    jobId: followup?.id ?? job.id,
    status: followup ? "queued" : "reserved",
    reason: dirty.reason,
  });
}

export function refreshTargetDue(
  target: RefreshTarget,
  cached: DashboardPayload | null,
  now = Date.now(),
): boolean {
  if (refreshTargetBackoffActive(target, now)) return false;
  if (target.failureCount > 0 && now < safeIso(target.nextDueAt)) return false;
  if (!cached || !canDisplayCached(cached)) return true;
  if (cached.cache?.state === "error" || cached.cache?.progress?.done === false) return true;
  return now >= safeIso(target.nextDueAt);
}

export function refreshTargetBackoffActive(target: RefreshTarget, now = Date.now()): boolean {
  return now < safeIso(target.terminalBackoffUntil ?? "");
}

export function refreshReason(target: RefreshTarget, cached: DashboardPayload | null): string {
  if (sharedQuotaDeferredTarget(target)) return "app-quota";
  if (!cached) return "missing-cache";
  if (!canDisplayCached(cached)) return "expired-cache";
  if (cached.cache?.state === "error") return "error-cache";
  if (cached.cache?.progress?.done === false) return "partial-cache";
  return Date.now() >= safeIso(target.nextDueAt) ? "scheduled" : "not-due";
}

export function sharedQuotaDeferredTarget(target: RefreshTarget): boolean {
  return (
    typeof target.message === "string" &&
    target.message.startsWith("shared GitHub quota paused until ") &&
    Date.now() < safeIso(target.nextDueAt)
  );
}

export type SchedulerDueOptions = {
  sharedQuotaPaused: boolean;
  sharedGraphqlPausedOperations: ReadonlySet<string>;
  now: number;
};

export function refreshTargetGraphqlOperations(target: RefreshTarget): string[] {
  const operations: string[] = [];
  if (target.owners.length > 0) {
    operations.push(
      target.includeReleaseData
        ? githubGraphqlOwnerReleaseOperation
        : "ReleaseBarOwnerRepos.metadata",
    );
  }
  if (target.includeReleaseData && target.owners.length > 0) {
    operations.push(githubGraphqlRepoDetailsOperation);
  }
  return operations;
}

export function dormantSharedTargetDue(target: RefreshTarget, now: number): boolean {
  const lastSeenAt = safeIso(target.lastSeenAt);
  if (!lastSeenAt || now - lastSeenAt < schedulerSharedDormantAfterMs) return false;
  const cadenceAnchor = Math.max(
    lastSeenAt,
    safeIso(target.lastAttemptAt),
    safeIso(target.lastSuccessAt),
  );
  const nextDormantRefreshAt =
    cadenceAnchor + schedulerSharedDormantRefreshMs + jitterMs(target.key, 24 * 60 * 60 * 1000);
  return now >= nextDormantRefreshAt;
}

export async function schedulerTargetDue(
  env: Env,
  target: RefreshTarget,
  cached: DashboardPayload | null,
  options: SchedulerDueOptions = {
    sharedQuotaPaused: false,
    sharedGraphqlPausedOperations: new Set<string>(),
    now: Date.now(),
  },
): Promise<boolean> {
  const hasAppTokenCoverage = () =>
    sourceInstallationRegistryCovers(env, {
      owners: target.owners,
      repos: target.repos,
    }).catch(() => false);
  if (sharedQuotaDeferredTarget(target)) {
    return hasAppTokenCoverage();
  }
  const sharedGraphqlPaused = refreshTargetGraphqlOperations(target).some((operation) =>
    options.sharedGraphqlPausedOperations.has(operation),
  );
  if ((options.sharedQuotaPaused || sharedGraphqlPaused) && !(await hasAppTokenCoverage())) {
    return false;
  }
  if (!refreshTargetDue(target, cached, options.now)) return false;
  const hasHealthyCache =
    cached &&
    canDisplayCached(cached) &&
    cached.cache?.state !== "error" &&
    cached.cache?.progress?.done !== false;
  if (!hasHealthyCache) return true;
  if (dormantSharedTargetDue(target, options.now)) return true;
  const lastSeenAt = safeIso(target.lastSeenAt);
  const dormantSharedTarget =
    lastSeenAt > 0 && options.now - lastSeenAt >= schedulerSharedDormantAfterMs;
  if (!dormantSharedTarget) return true;
  const hasApp = await hasAppTokenCoverage();
  if (hasApp) return true;
  return false;
}

export async function schedulerDueOptions(env: Env): Promise<SchedulerDueOptions> {
  const operations = [
    githubGraphqlOwnerCountsOperation,
    "ReleaseBarOwnerRepos.metadata",
    githubGraphqlOwnerReleaseOperation,
    githubGraphqlRepoDetailsOperation,
  ];
  const [cooldown, ...backoffs] = await Promise.all([
    env.GITHUB_TOKEN ? sharedQuotaCooldown(env) : Promise.resolve(null),
    ...operations.map((operation) =>
      env.GITHUB_TOKEN
        ? graphqlBackoffActive(env, "shared", null, operation)
        : Promise.resolve(false),
    ),
  ]);
  return {
    sharedQuotaPaused: Boolean(cooldown?.active),
    sharedGraphqlPausedOperations: new Set(
      operations.filter((_operation, index) => backoffs[index]),
    ),
    now: Date.now(),
  };
}
export async function refreshOwnerCounts(
  env: Env,
  owner: string,
  requiredRepo?: string,
  context?: ExecutionContext,
): Promise<{
  status: "refreshed" | "missing" | "missing-repo" | "deferred";
  exact?: OwnerRepoCount;
}> {
  const snapshot = await readOwnerMetadata(env, owner);
  if (!snapshot) return { status: "missing" };
  const observedAt = new Date().toISOString();
  const token = await sourceInstallationToken(
    env,
    { owners: [owner], repos: [] },
    { discover: false },
  ).catch(() => null);
  const quotaSource = token?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  if (quotaSource === "anonymous") return { status: "deferred" };
  if (
    quotaSource === "shared" &&
    ((await sharedQuotaCooldown(env))?.active ||
      (await graphqlBackoffActive(env, quotaSource, null, githubGraphqlOwnerCountsOperation)))
  ) {
    return { status: "deferred" };
  }
  const result = await fetchOwnerRepoCounts({
    owner,
    token: token?.token ?? env.GITHUB_TOKEN,
    quotaSource,
    quotaAccount: token?.quotaAccount ?? null,
    limit: 500,
    fetch: auditGitHubFetch("dashboard", quotaSource, token?.quotaAccount ?? null, env, context),
  });
  await mutateOwnerMetadataSnapshot(env, owner, {
    kind: "counts",
    updatedAt: observedAt,
    counts: result.repos,
    complete: result.complete,
  });
  await markHotCacheStale(env);
  const exact = requiredRepo
    ? result.repos.find((repo) => repo.fullName.toLowerCase() === requiredRepo.toLowerCase())
    : undefined;
  if (requiredRepo && !exact) return { status: "missing-repo" };
  return { status: "refreshed", exact };
}

export async function refreshDueOwnerCounts(
  env: Env,
  context: ExecutionContext,
  targets: RefreshTarget[],
  now = Date.now(),
): Promise<{ considered: number; refreshed: number; deferred: number; failed: number }> {
  const owners = [
    ...new Set(
      targets
        .filter((target) => now - safeIso(target.lastSeenAt) < schedulerRecentViewMs)
        .flatMap((target) => [
          ...target.owners,
          ...target.repos.map((repo) => repo.split("/")[0] ?? ""),
        ])
        .map(slugOwner)
        .filter(validOwnerSlug),
    ),
  ];
  const cursor = await env.DASHBOARD_CACHE?.get(refreshOwnerCountCursorKey);
  const cursorIndex = cursor ? owners.indexOf(cursor) : -1;
  const rotatedOwners =
    cursorIndex >= 0
      ? [...owners.slice(cursorIndex + 1), ...owners.slice(0, cursorIndex + 1)]
      : owners;
  const due: string[] = [];
  for (const owner of rotatedOwners) {
    const snapshot = await readOwnerMetadata(env, owner);
    if (
      snapshot &&
      now - safeIso(snapshot.countsAttemptedAt) >=
        schedulerCountRefreshMs + jitterMs(owner, 3 * 60 * 1000)
    ) {
      due.push(owner);
    }
    if (due.length >= schedulerCountOwnerLimit) break;
  }
  if (due.length > 0) {
    await env.DASHBOARD_CACHE?.put(refreshOwnerCountCursorKey, due.at(-1)!);
  }
  let refreshed = 0;
  let deferred = 0;
  let failed = 0;
  await mapConcurrent(due, schedulerCountConcurrency, async (owner) => {
    try {
      const result = await refreshOwnerCounts(env, owner, undefined, context);
      if (result.status === "refreshed") refreshed += 1;
      if (result.status === "deferred") deferred += 1;
    } catch (error) {
      failed += 1;
      await auditSyncEvent(env, {
        event: "owner_counts_failed",
        status: "failed",
        account: owner,
        reason: errorMessage(error),
      });
    }
  });
  return { considered: owners.length, refreshed, deferred, failed };
}

export async function schedulerTick(
  env: Env,
  context: ExecutionContext,
  cause: string,
  limit = schedulerBatchLimit,
): Promise<{ enqueued: number; considered: number; due: number }> {
  const [stateRaw, jobs, dueOptions] = await Promise.all([
    env.DASHBOARD_CACHE?.get(refreshStateKey),
    listRefreshJobs(env),
    schedulerDueOptions(env),
  ]);
  const previousState = stateRaw
    ? tryJsonParse<{
        targetCursor?: string;
      }>(stateRaw, "refresh state")
    : null;
  const page = await listRefreshTargets(env, schedulerTargetPageLimit, previousState?.targetCursor);
  const targets = page.targets;
  await backfillRefreshTargetIndexes(env, targets);
  const countRefresh = await refreshDueOwnerCounts(env, context, targets, dueOptions.now);
  const activeTargetKeys = new Set(
    jobs.filter((job) => refreshJobActive(job)).map((job) => job.targetKey),
  );
  const pairs = await mapConcurrent(targets, 16, async (target) => ({
    target,
    cached: await readCached(env, target.key),
  }));
  const duePairs = await mapConcurrent(pairs, 16, async (pair) => ({
    ...pair,
    due: await schedulerTargetDue(env, pair.target, pair.cached, dueOptions),
  }));
  const due = duePairs
    .filter(({ due }) => due)
    .filter(({ target }) => !activeTargetKeys.has(target.key))
    .sort(
      (a, b) =>
        b.target.priority - a.target.priority ||
        safeIso(a.target.nextDueAt) - safeIso(b.target.nextDueAt),
    );
  const picked = due.slice(0, limit);
  let enqueued = 0;
  for (const { target, cached } of picked) {
    if (await enqueueRefreshJob(env, context, target, refreshReason(target, cached))) {
      enqueued += 1;
    }
  }
  await env.DASHBOARD_CACHE?.put(
    refreshStateKey,
    JSON.stringify({
      lastTickAt: new Date().toISOString(),
      cause,
      considered: targets.length,
      due: due.length,
      enqueued,
      targetCursor: page.nextCursor,
      nextDueAt:
        targets
          .map((target) => target.nextDueAt)
          .filter((value) => safeIso(value) > 0)
          .sort()[0] ?? null,
      countRefresh,
    }),
    { expirationTtl: dashboardStorageTtlSeconds },
  );
  await auditScheduler(env, {
    event: "scheduler_tick",
    status: "ok",
    reason: cause,
    detail: `considered=${targets.length} active=${activeTargetKeys.size} due=${due.length} enqueued=${enqueued} counts=${countRefresh.refreshed}/${countRefresh.considered} countFailed=${countRefresh.failed}`,
  });
  return { enqueued, considered: targets.length, due: due.length };
}

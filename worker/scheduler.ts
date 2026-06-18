import type { RefreshJob, SchedulerAdminPayload } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import {
  githubGraphqlBackoffDeferUntil,
  graphqlBackoffActive,
  sharedQuotaCooldown,
  sharedQuotaDeferUntil,
} from "./github-audit.js";
import type { Env } from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { resolveOwners } from "./app-shell.js";
import { sourceInstallationToken } from "./auth-tokens.js";
import {
  adminTargetListLimit,
  progressiveBuildBudgetMs,
  queuedProgressiveBuildBudgetMs,
  refreshStateKey,
} from "./config.js";
import { errorMessage, isAbortError, readCached } from "./dashboard-cache.js";
import { continueProgressiveBuild } from "./dashboard-rebuild.js";
import { safeIso } from "./owner-metadata-write.js";
import {
  refreshTargetGraphqlOperations,
  reserveRefreshJob,
  schedulerDueOptions,
  schedulerTargetDue,
} from "./refresh-queue.js";
import {
  auditSyncEvent,
  currentDashboardCacheKey,
  listAuditEvents,
  listRefreshJobs,
  mergeRefreshTargetState,
  mutateRefreshTargetState,
  readRefreshJob,
  readRefreshJobSnapshot,
  readRefreshTarget,
  refreshJobActive,
  refreshTargetInventory,
  refreshTargetProfile,
  writeRefreshJob,
  writeRefreshJobDelivery,
} from "./refresh-targets.js";
import { dashboardRequest } from "./request-lock.js";

export async function processRefreshJob(
  input: RefreshJob,
  env: Env,
  persistRetryState = true,
  progressiveBudgetMs = queuedProgressiveBuildBudgetMs,
): Promise<RefreshJob> {
  const startedAt = Date.now();
  const [storedJob, snapshotJob] = await Promise.all([
    readRefreshJob(env, input.id),
    input.targetSnapshotKey
      ? readRefreshJobSnapshot(env, input.targetSnapshotKey)
      : Promise.resolve(null),
  ]);
  let job: RefreshJob = {
    ...(snapshotJob ?? input),
    ...storedJob,
    target: storedJob?.target ?? snapshotJob?.target ?? input.target,
    targetSnapshotKey:
      storedJob?.targetSnapshotKey ?? snapshotJob?.targetSnapshotKey ?? input.targetSnapshotKey,
  };
  if (job.status === "succeeded" || job.status === "failed" || job.status === "skipped") {
    return job;
  }
  if (!currentDashboardCacheKey(job.targetKey)) {
    const skipped = {
      ...job,
      status: "skipped" as const,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 0,
      error: "obsolete dashboard schema",
    };
    await writeRefreshJob(env, skipped);
    return skipped;
  }
  if (input.targetSnapshotKey && !snapshotJob?.target && !storedJob?.target && !input.target) {
    const now = new Date().toISOString();
    const retrying = {
      ...job,
      status: "queued" as const,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      attempts: job.attempts + 1,
      durationMs: null,
      error: "target snapshot unavailable",
    };
    if (persistRetryState) {
      await writeRefreshJob(env, retrying);
    }
    await auditSyncEvent(env, {
      event: "job_retry",
      targetKey: retrying.targetKey,
      jobId: retrying.id,
      status: "queued",
      reason: retrying.error,
    });
    return retrying;
  }
  if (!(await reserveRefreshJob(env, job.targetKey, job.id))) {
    const skipped = {
      ...job,
      status: "skipped" as const,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 0,
      error: "newer refresh job active",
    };
    await writeRefreshJob(env, skipped);
    return skipped;
  }
  job = {
    ...job,
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    updatedAt: new Date(startedAt).toISOString(),
    attempts: job.attempts + 1,
    durationMs: null,
    error: undefined,
  };
  await writeRefreshJobDelivery(env, job);
  await auditSyncEvent(env, {
    event: "job_start",
    targetKey: job.targetKey,
    jobId: job.id,
    status: "running",
    reason: job.reason,
  });

  const targetSnapshot = job.target ?? input.target;
  const storedTarget = await readRefreshTarget(env, job.targetKey);
  const target = targetSnapshot
    ? mergeRefreshTargetState(targetSnapshot, storedTarget)
    : storedTarget;
  if (!target) {
    const skipped = {
      ...job,
      status: "skipped" as const,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: "target missing",
    };
    await writeRefreshJob(env, skipped);
    await auditSyncEvent(env, {
      event: "job_skipped",
      targetKey: job.targetKey,
      jobId: job.id,
      status: "skipped",
      reason: "target missing",
    });
    return skipped;
  }

  const deadlineController = new AbortController();
  const deadlineTimer = globalThis.setTimeout(
    () => deadlineController.abort(),
    progressiveBudgetMs,
  );
  try {
    const sources = { owners: target.owners, repos: target.repos };
    const token = await sourceInstallationToken(env, sources, {
      signal: deadlineController.signal,
    });
    const sharedCooldown = !token && env.GITHUB_TOKEN ? await sharedQuotaCooldown(env) : null;
    if (sharedCooldown?.active) {
      const nextDueAt = sharedQuotaDeferUntil(sharedCooldown);
      const now = new Date().toISOString();
      await mutateRefreshTargetState(env, target, {
        kind: "defer",
        at: now,
        nextDueAt,
        message: `shared GitHub quota paused until ${nextDueAt}`,
      });
      const skipped = {
        ...job,
        status: "skipped" as const,
        finishedAt: now,
        updatedAt: now,
        durationMs: Date.now() - startedAt,
        error: sharedCooldown.reason ?? "shared GitHub quota paused",
      };
      await writeRefreshJob(env, skipped);
      await auditSyncEvent(env, {
        event: "job_skipped",
        targetKey: target.key,
        jobId: job.id,
        status: "skipped",
        reason: "shared-quota",
        detail: `until=${nextDueAt} remaining=${sharedCooldown.remaining ?? "unknown"} resource=${sharedCooldown.resource ?? "any"}`,
      });
      return skipped;
    }
    const quotaSource = token?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
    const quotaAccount = token?.quotaAccount ?? null;
    const graphqlStates =
      quotaSource === "shared"
        ? await Promise.all(
            refreshTargetGraphqlOperations(target).map(async (operation) => ({
              operation,
              active: await graphqlBackoffActive(env, quotaSource, quotaAccount, operation),
            })),
          )
        : [];
    const graphqlBackoff = graphqlStates.find((state) => state.active);
    if (graphqlBackoff) {
      const nextDueAt = githubGraphqlBackoffDeferUntil();
      const now = new Date().toISOString();
      await mutateRefreshTargetState(env, target, {
        kind: "defer",
        at: now,
        nextDueAt,
        message: `GitHub GraphQL paused until ${nextDueAt}`,
      });
      const skipped = {
        ...job,
        status: "skipped" as const,
        finishedAt: now,
        updatedAt: now,
        durationMs: Date.now() - startedAt,
        error: "GitHub GraphQL temporarily paused after upstream errors",
      };
      await writeRefreshJob(env, skipped);
      await auditSyncEvent(env, {
        event: "job_skipped",
        targetKey: target.key,
        jobId: job.id,
        status: "skipped",
        reason: "graphql-backoff",
        detail: `until=${nextDueAt} source=${quotaSource} account=${quotaAccount ?? "_"} operation=${graphqlBackoff.operation}`,
      });
      return skipped;
    }

    const cached = await readCached(env, target.key);
    const profile = await refreshTargetProfile(env, target, cached);
    if (profile === undefined) {
      const now = new Date().toISOString();
      const retrying = {
        ...job,
        status: "queued" as const,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
        durationMs: null,
        error: "profile snapshot unavailable",
      };
      if (persistRetryState) {
        await writeRefreshJob(env, retrying);
      }
      await auditSyncEvent(env, {
        event: "job_retry",
        targetKey: target.key,
        jobId: job.id,
        status: "queued",
        reason: retrying.error,
      });
      return retrying;
    }
    const scannedBefore = cached?.cache?.progress?.scanned ?? 0;
    const owners =
      cached?.owners ??
      (await resolveOwners(
        target.owners,
        env,
        token?.token ?? env.GITHUB_TOKEN,
        token?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous"),
        token?.quotaAccount ?? null,
        deadlineController.signal,
      ));
    if (!owners) {
      throw new Error("owner not found");
    }
    const url = new URL(
      target.path,
      `https://${env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar"}`,
    );
    const dashboard = dashboardRequest(
      owners,
      target.repos,
      profile,
      target.key,
      url,
      target.includeReleaseData,
      token,
    );
    const payload = await continueProgressiveBuild(
      dashboard,
      env,
      Math.max(1, progressiveBudgetMs - (Date.now() - startedAt)),
      deadlineController.signal,
    );
    const now = new Date().toISOString();
    if (!payload) {
      const retrying = {
        ...job,
        status: "queued" as const,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
        durationMs: null,
        error: "dashboard locked",
      };
      if (persistRetryState) {
        await writeRefreshJob(env, retrying);
      }
      await auditSyncEvent(env, {
        event: "job_retry",
        targetKey: target.key,
        jobId: job.id,
        status: "queued",
        reason: "dashboard locked",
      });
      return retrying;
    }
    const scannedAfter = payload.cache?.progress?.scanned ?? 0;
    const incomplete = payload.cache?.progress?.done === false;
    const shouldContinue = incomplete;
    const retryError = scannedAfter > scannedBefore ? "dashboard incomplete" : "dashboard stalled";
    if (!shouldContinue) {
      await mutateRefreshTargetState(env, target, {
        kind: "success",
        at: now,
        message: payload.cache?.message,
      });
    }
    const done = {
      ...job,
      status: shouldContinue ? ("queued" as const) : ("succeeded" as const),
      startedAt: shouldContinue ? null : job.startedAt,
      finishedAt: shouldContinue ? null : now,
      updatedAt: now,
      durationMs: shouldContinue ? null : Date.now() - startedAt,
      error: shouldContinue ? retryError : undefined,
    };
    if (!shouldContinue || persistRetryState) {
      await writeRefreshJob(env, done);
    }
    await auditSyncEvent(env, {
      event: shouldContinue ? "job_retry" : "job_done",
      targetKey: target.key,
      jobId: job.id,
      status: done.status,
      account: token?.quotaAccount ?? null,
      durationMs: Date.now() - startedAt,
      projects: payload.projects.length,
      scanned: payload.cache?.progress?.scanned,
      limit: payload.cache?.progress?.limit,
      done: payload.cache?.progress?.done,
      detail: `projects=${payload.projects.length}`,
    });
    return done;
  } catch (error) {
    const message = errorMessage(error);
    const now = new Date().toISOString();
    if (deadlineController.signal.aborted && isAbortError(error)) {
      const retrying = {
        ...job,
        status: "queued" as const,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
        durationMs: null,
        error: "dashboard deadline reached",
      };
      if (persistRetryState) {
        await writeRefreshJob(env, retrying);
      }
      await auditSyncEvent(env, {
        event: "job_retry",
        targetKey: target.key,
        jobId: job.id,
        status: "queued",
        reason: retrying.error,
        durationMs: Date.now() - startedAt,
      });
      return retrying;
    }
    await mutateRefreshTargetState(env, target, {
      kind: "failure",
      at: now,
      message,
      terminal: false,
    });
    const failed = {
      ...job,
      status: "failed" as const,
      finishedAt: now,
      updatedAt: now,
      durationMs: Date.now() - startedAt,
      error: message,
    };
    await writeRefreshJob(env, failed);
    await auditSyncEvent(env, {
      event: "job_failed",
      targetKey: target.key,
      jobId: job.id,
      status: "failed",
      reason: message,
      durationMs: failed.durationMs ?? undefined,
    });
    return failed;
  } finally {
    globalThis.clearTimeout(deadlineTimer);
  }
}

export async function failExhaustedRefreshJob(
  job: RefreshJob,
  env: Env,
  attempts = job.attempts,
): Promise<RefreshJob> {
  const now = new Date().toISOString();
  const failed = {
    ...job,
    status: "failed" as const,
    finishedAt: now,
    updatedAt: now,
    attempts: Math.max(job.attempts, attempts),
    durationMs: null,
    error: `${job.error ?? "refresh incomplete"} after ${attempts} Queue attempts`,
  };
  const target = job.target ?? (await readRefreshTarget(env, job.targetKey));
  if (target) {
    await mutateRefreshTargetState(env, target, {
      kind: "failure",
      at: now,
      message: failed.error,
      terminal: true,
    }).catch(() => undefined);
  }
  await writeRefreshJob(env, failed);
  await auditSyncEvent(env, {
    event: "job_failed",
    targetKey: job.targetKey,
    jobId: job.id,
    status: "failed",
    reason: failed.error,
  });
  return failed;
}

export async function processRefreshJobFallback(input: RefreshJob, env: Env): Promise<RefreshJob> {
  const result = await processRefreshJob(input, env, false, progressiveBuildBudgetMs);
  if (result.status !== "queued") return result;
  const now = new Date().toISOString();
  const failed = {
    ...result,
    status: "failed" as const,
    finishedAt: now,
    updatedAt: now,
    durationMs: null,
    error: `${result.error ?? "refresh incomplete"}; Queue continuation unavailable`,
  };
  await writeRefreshJob(env, failed);
  await auditSyncEvent(env, {
    event: "job_failed",
    targetKey: failed.targetKey,
    jobId: failed.id,
    status: "failed",
    reason: failed.error,
  });
  return failed;
}

export async function schedulerAdminPayload(env: Env): Promise<SchedulerAdminPayload> {
  const [inventory, jobs, events, stateRaw, dueOptions] = await Promise.all([
    refreshTargetInventory(env),
    listRefreshJobs(env),
    listAuditEvents(env),
    env.DASHBOARD_CACHE?.get(refreshStateKey),
    schedulerDueOptions(env),
  ]);
  const state = stateRaw
    ? tryJsonParse<{
        lastTickAt?: string;
        considered?: number;
        due?: number;
        nextDueAt?: string | null;
      }>(stateRaw, "refresh state")
    : null;
  const targets = inventory.targets;
  const activeTargetKeys = new Set(
    jobs.filter((job) => refreshJobActive(job)).map((job) => job.targetKey),
  );
  const activeJobs = jobs.filter((job) => refreshJobActive(job));
  let scannedTargets = state?.considered ?? 0;
  let dueTargets = state?.due ?? 0;
  let nextDueAt = state?.nextDueAt ?? null;
  if (inventory.total <= adminTargetListLimit) {
    const targetStates = await mapConcurrent(targets, 16, async (target) => ({
      target,
      cached: await readCached(env, target.key),
    }));
    const dueTargetStates = await mapConcurrent(targetStates, 16, async (targetState) => ({
      ...targetState,
      due: await schedulerTargetDue(env, targetState.target, targetState.cached, dueOptions),
    }));
    scannedTargets = targets.length;
    dueTargets = dueTargetStates.filter(
      ({ target, due }) => due && !activeTargetKeys.has(target.key),
    ).length;
    nextDueAt =
      targets
        .map((target) => target.nextDueAt)
        .filter((value) => safeIso(value) > 0)
        .sort()[0] ?? null;
  }
  return {
    generatedAt: new Date().toISOString(),
    authorized: true,
    status: {
      targets: inventory.total,
      scannedTargets,
      dueTargets,
      queuedJobs: activeJobs.filter((job) => job.status === "queued").length,
      runningJobs: activeJobs.filter((job) => job.status === "running").length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
      lastTickAt: state?.lastTickAt ?? null,
      nextDueAt,
      queueConfigured: Boolean(env.REFRESH_QUEUE),
    },
    targets: targets.sort((a, b) => safeIso(a.nextDueAt) - safeIso(b.nextDueAt)).slice(0, 120),
    jobs,
    events,
  };
}

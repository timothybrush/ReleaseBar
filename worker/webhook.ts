import type { RefreshTarget } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import { randomNonce } from "./crypto.js";
import {
  githubGraphqlBackoffSeconds,
  sharedQuotaCooldown,
  sharedQuotaDeferUntil,
} from "./github-audit.js";
import { jsonResponse } from "./http.js";
import type {
  Env,
  ExecutionContext,
  GitHubWebhookFanoutJob,
  WebhookTargetAction,
} from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { markHotCacheStale } from "./build-progress.js";
import {
  githubWebhookBodyLimitBytes,
  hotCacheKey,
  webhookPriorityFanoutRetrySeconds,
  webhookPriorityFanoutWaitMs,
  webhookPriorityTargetLimit,
  webhookRecentTargetMs,
} from "./config.js";
import { errorMessage, readCachedRaw } from "./dashboard-cache.js";
import { readOwnerMetadata } from "./owner-metadata-read.js";
import {
  mutateOwnerMetadataSnapshot,
  rememberOwnerMetadata,
  safeIso,
} from "./owner-metadata-write.js";
import { enqueueRefreshJob, refreshOwnerCounts } from "./refresh-queue.js";
import { auditSyncEvent } from "./refresh-targets.js";
import {
  compactGitHubWebhookPayload,
  freshestWebhookTargets,
  invalidateDashboardTargets,
  invalidatePublicRepoCaches,
  invalidateRepoDetailCaches,
  invalidateRepoProjectCache,
  legacyOwnerWebhookSeedTargets,
  mapWebhookTargets,
  releaseWebhookAffectsDashboard,
  validWebhookSignature,
  webhookRepo,
  webhookTargetPage,
  type WebhookTargetPage,
  webhookTargetsForAction,
} from "./webhook-targets.js";

export async function prepareGitHubWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  env: Env,
  context: ExecutionContext,
  repo: NonNullable<ReturnType<typeof webhookRepo>>,
  seedTargets: RefreshTarget[],
): Promise<WebhookTargetAction | null> {
  const action = payload.action;
  const updatedAt = new Date().toISOString();
  const repositoryObservedAt = repo.updatedAt;
  if (event === "issues" || event === "pull_request") {
    const countActions =
      event === "issues"
        ? ["opened", "reopened", "closed", "deleted", "transferred"]
        : ["opened", "reopened", "closed", "deleted"];
    if (!countActions.includes(String(action))) return null;
    let snapshot = await readOwnerMetadata(env, repo.owner);
    if (!snapshot?.projects.some((project) => project.fullName.toLowerCase() === repo.fullName)) {
      for (const target of seedTargets) {
        const cached = await readCachedRaw(env, target.key);
        if (!cached?.projects.some((project) => project.fullName.toLowerCase() === repo.fullName)) {
          continue;
        }
        await rememberOwnerMetadata(env, cached, "metadata");
        break;
      }
      snapshot = await readOwnerMetadata(env, repo.owner);
    }
    if (!snapshot?.projects.some((project) => project.fullName.toLowerCase() === repo.fullName)) {
      return {
        reason: `webhook:${event}:missing-snapshot-repo`,
        includeReleaseDataOnly: false,
        invalidateDashboard: false,
      };
    }
    const refresh = await refreshOwnerCounts(env, repo.owner, repo.fullName, context);
    if (refresh.status === "missing-repo") {
      return {
        reason: `webhook:${event}:exact-count-missing`,
        includeReleaseDataOnly: false,
        invalidateDashboard: false,
      };
    }
    if (refresh.status !== "refreshed" || !refresh.exact) {
      throw new Error(`exact owner count refresh ${refresh.status}`);
    }
    await invalidateRepoDetailCaches(env, repo.fullName);
    return null;
  }

  if (event === "repository" && action === "privatized") {
    await Promise.all([
      mutateOwnerMetadataSnapshot(env, repo.owner, {
        kind: "remove",
        fullName: repo.fullName,
        observedAt: repositoryObservedAt ?? updatedAt,
      }),
      invalidatePublicRepoCaches(env, repo.fullName),
      env.DASHBOARD_CACHE?.delete?.(hotCacheKey),
    ]);
    return {
      reason: "webhook:repository-privatized",
      includeReleaseDataOnly: false,
      invalidateDashboard: true,
    };
  }

  if (event === "repository" && action === "publicized") {
    const restore = repositoryObservedAt
      ? mutateOwnerMetadataSnapshot(env, repo.owner, {
          kind: "restore",
          fullName: repo.fullName,
          observedAt: repositoryObservedAt,
        })
      : refreshOwnerCounts(env, repo.owner, repo.fullName, context);
    await Promise.all([
      restore,
      invalidateRepoProjectCache(env, repo.fullName),
      invalidateRepoDetailCaches(env, repo.fullName),
      markHotCacheStale(env),
    ]);
    return {
      reason: "webhook:repository-publicized",
      includeReleaseDataOnly: false,
      invalidateDashboard: false,
    };
  }

  if (event === "repository" && (action === "archived" || action === "unarchived")) {
    let refresh: Awaited<ReturnType<typeof refreshOwnerCounts>>;
    try {
      refresh = await refreshOwnerCounts(env, repo.owner, repo.fullName, context);
    } catch (error) {
      await auditSyncEvent(env, {
        event: "owner_counts_failed",
        status: "failed",
        account: repo.owner,
        reason: errorMessage(error),
        detail: `githubEvent=repository repo=${repo.fullName}`,
      });
      refresh = { status: "deferred" };
    }
    let visibilityApplied = false;
    if (repositoryObservedAt) {
      const archived = repo.archived ?? action === "archived";
      const visibilitySnapshot = await mutateOwnerMetadataSnapshot(env, repo.owner, {
        kind: "visibility",
        fullName: repo.fullName,
        archived,
        observedAt: repositoryObservedAt,
        repositoryUpdatedAt: repo.updatedAt,
      });
      visibilityApplied = Boolean(
        visibilitySnapshot?.projects.some(
          (project) =>
            project.fullName.toLowerCase() === repo.fullName && project.archived === archived,
        ),
      );
    }
    const requiresFallback =
      (refresh.status !== "refreshed" || !refresh.exact) && !visibilityApplied;
    await Promise.all([
      invalidateRepoProjectCache(env, repo.fullName),
      invalidateRepoDetailCaches(env, repo.fullName),
    ]);
    return {
      reason: "webhook:repository",
      includeReleaseDataOnly: false,
      invalidateDashboard: requiresFallback,
    };
  }

  if (event !== "push" && event !== "release") return null;
  if (
    event === "push" &&
    (payload.deleted === true ||
      (repo.defaultBranch && payload.ref !== `refs/heads/${repo.defaultBranch}`))
  ) {
    return null;
  }
  if (event === "release" && !releaseWebhookAffectsDashboard(payload)) {
    return null;
  }
  await Promise.all([
    invalidateRepoProjectCache(env, repo.fullName),
    invalidateRepoDetailCaches(env, repo.fullName),
  ]);
  return {
    reason: `webhook:${event}`,
    includeReleaseDataOnly: true,
    invalidateDashboard: true,
    recentTargetsOnly: true,
  };
}

export async function applyWebhookTargetAction(
  env: Env,
  context: ExecutionContext,
  targets: RefreshTarget[],
  action: WebhookTargetAction,
): Promise<void> {
  const prioritized = new Set(action.prioritizedTargetKeys ?? []);
  const matching = webhookTargetsForAction(targets, {
    ...action,
    recentTargetsOnly: false,
  });
  const selected = action.recentTargetsOnly
    ? matching.filter(
        (target) =>
          safeIso(target.lastSeenAt) >= Date.now() - webhookRecentTargetMs &&
          !prioritized.has(target.key),
      )
    : matching.filter((target) => !prioritized.has(target.key));
  if (action.invalidateDashboard) {
    await invalidateDashboardTargets(
      env,
      matching.filter((target) => !prioritized.has(target.key)),
    );
  }
  await mapWebhookTargets(selected, (target) =>
    enqueueRefreshJob(env, context, target, action.reason),
  );
}

export async function enqueueWebhookFanout(
  env: Env,
  event: string,
  delivery: string,
  payload: Record<string, unknown>,
  createdAt: string,
  action: WebhookTargetAction,
  next: WebhookTargetPage["next"],
  priorityBatchStartedAt?: string,
): Promise<void> {
  if (!next) return;
  if (!env.REFRESH_QUEUE) throw new Error("webhook queue unavailable");
  await env.REFRESH_QUEUE.send({
    kind: "github-webhook-fanout",
    id: randomNonce(),
    event,
    delivery,
    payload,
    createdAt,
    action,
    source: next.source,
    ...(priorityBatchStartedAt ? { priorityBatchStartedAt } : {}),
    ...(next.cursor ? { cursor: next.cursor } : {}),
    ...(next.backfillFailed ? { backfillFailed: true } : {}),
  });
}

export async function webhookPriorityBatchActive(env: Env, targetKeys: string[]): Promise<boolean> {
  if (!env.DASHBOARD_LOCKS || targetKeys.length === 0) return false;
  const active = await mapConcurrent(targetKeys, 8, async (targetKey) => {
    const id = env.DASHBOARD_LOCKS!.idFromName(targetKey);
    const response = await env.DASHBOARD_LOCKS!.get(id).fetch(
      new Request("https://releasebar.internal/job/status", {
        method: "POST",
      }),
    );
    if (!response.ok) {
      throw new Error(`priority refresh status returned ${response.status}`);
    }
    const body = (await response.json()) as { active?: unknown };
    return body.active === true;
  });
  return active.some(Boolean);
}

export async function processGitHubWebhookFanout(
  job: GitHubWebhookFanoutJob,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  const repo = webhookRepo(job.payload);
  if (!repo) return;
  const priorityKeys = job.action.prioritizedTargetKeys ?? [];
  const priorityBatchStartedAt = safeIso(job.priorityBatchStartedAt ?? job.createdAt);
  if (
    job.action.recentTargetsOnly &&
    priorityKeys.length > 0 &&
    Date.now() - priorityBatchStartedAt < webhookPriorityFanoutWaitMs &&
    (await webhookPriorityBatchActive(env, priorityKeys))
  ) {
    throw new Error("webhook priority refreshes still active");
  }
  const page = await webhookTargetPage(
    env,
    repo.owner,
    repo.fullName,
    job.source,
    job.cursor,
    job.backfillFailed,
  );
  await applyWebhookTargetAction(env, context, page.targets, job.action);
  await enqueueWebhookFanout(
    env,
    job.event,
    job.delivery,
    job.payload,
    job.createdAt,
    job.action,
    page.next,
    job.priorityBatchStartedAt,
  );
}

export async function processGitHubWebhook(
  event: string,
  delivery: string,
  payload: Record<string, unknown>,
  createdAt: string,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  const repo = webhookRepo(payload);
  if (!repo) return;
  const page = await webhookTargetPage(
    env,
    repo.owner,
    repo.fullName,
    undefined,
    undefined,
    undefined,
    event === "push" || event === "release",
  );
  const ownerSeedTargets = await legacyOwnerWebhookSeedTargets(env, repo.owner, repo.fullName);
  const seedTargets = freshestWebhookTargets([...page.targets, ...ownerSeedTargets]);
  const action = await prepareGitHubWebhookEvent(event, payload, env, context, repo, seedTargets);
  if (!action) return;
  const fallbackTargets = webhookTargetsForAction(ownerSeedTargets, action);
  const appliedTargets = page.prioritized
    ? webhookTargetsForAction([...fallbackTargets, ...page.targets], action).slice(
        0,
        webhookPriorityTargetLimit,
      )
    : seedTargets;
  const fanoutSkipKeys = page.prioritized
    ? appliedTargets.map((target) => target.key)
    : ownerSeedTargets.map((target) => target.key).slice(0, webhookPriorityTargetLimit);
  await applyWebhookTargetAction(env, context, appliedTargets, action);
  const priorityBatchStartedAt =
    action.recentTargetsOnly && fanoutSkipKeys.length > 0 ? new Date().toISOString() : undefined;
  await enqueueWebhookFanout(
    env,
    event,
    delivery,
    payload,
    createdAt,
    {
      ...action,
      prioritizedTargetKeys: fanoutSkipKeys.length > 0 ? fanoutSkipKeys : undefined,
    },
    page.next,
    priorityBatchStartedAt,
  );
}

export function githubWebhookProcessorBusy(error: unknown): boolean {
  const reason = errorMessage(error);
  return reason.includes("webhook processor returned 409") || reason.includes("processor busy");
}

export async function githubWebhookRetryDelaySeconds(env: Env, error: unknown): Promise<number> {
  const reason = errorMessage(error);
  if (
    reason.includes("webhook priority refreshes still active") ||
    githubWebhookProcessorBusy(error)
  ) {
    return webhookPriorityFanoutRetrySeconds;
  }
  const cooldown = await sharedQuotaCooldown(env).catch(() => null);
  if (cooldown?.active) {
    return Math.max(
      30,
      Math.min(
        12 * 60 * 60,
        Math.ceil((Date.parse(sharedQuotaDeferUntil(cooldown)) - Date.now()) / 1000) + 5,
      ),
    );
  }
  if (reason.includes("dashboard locked") || reason.includes("target reserved")) {
    return 60;
  }
  if (reason.includes("GraphQL") || reason.includes("deferred")) {
    return githubGraphqlBackoffSeconds;
  }
  return 5 * 60;
}

export async function abandonGitHubWebhookDelivery(
  env: Env,
  delivery: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!env.DASHBOARD_LOCKS) return;
  const owner = webhookRepo(payload)?.owner ?? delivery;
  const objectNames = ["github-webhook-admission", `github-webhook-process:${owner}`];
  const responses = await Promise.all(
    objectNames.map((name) =>
      env.DASHBOARD_LOCKS!.get(env.DASHBOARD_LOCKS!.idFromName(name)).fetch(
        new Request("https://releasebar.internal/webhook/abandon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ delivery }),
        }),
      ),
    ),
  );
  const failed = responses.find((response) => !response.ok);
  if (failed) {
    throw new Error(`webhook delivery abandon returned ${failed.status}`);
  }
}

export async function boundedRequestText(request: Request, limit: number): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) return null;
  if (!request.body) return "";

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function githubWebhookResponse(
  request: Request,
  env: Env,
  _context: ExecutionContext,
): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return jsonResponse({ error: "webhook not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const body = await boundedRequestText(request, githubWebhookBodyLimitBytes);
  if (body === null) {
    return jsonResponse({ error: "webhook payload too large" }, 413, {
      "cache-control": "no-store",
    });
  }
  if (
    !(await validWebhookSignature(
      env.GITHUB_WEBHOOK_SECRET,
      body,
      request.headers.get("x-hub-signature-256"),
    ))
  ) {
    return jsonResponse({ error: "invalid signature" }, 401, { "cache-control": "no-store" });
  }
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const payload = tryJsonParse<Record<string, unknown>>(body, "GitHub webhook");
  if (!payload) {
    return jsonResponse({ error: "invalid payload" }, 400, { "cache-control": "no-store" });
  }
  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") {
    return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
  }
  const repo = webhookRepo(payload);
  if (!delivery) {
    return jsonResponse({ error: "webhook delivery unavailable" }, 503, {
      "cache-control": "no-store",
    });
  }
  if (!repo) {
    return jsonResponse({ ok: true, ignored: true }, 202, {
      "cache-control": "no-store",
    });
  }
  const action = String(payload.action ?? "");
  if (repo.private === true && !(event === "repository" && action === "privatized")) {
    return jsonResponse({ ok: true, ignored: true }, 202, {
      "cache-control": "no-store",
    });
  }
  if (!env.DASHBOARD_LOCKS) {
    return jsonResponse({ error: "webhook delivery unavailable" }, 503, {
      "cache-control": "no-store",
    });
  }
  try {
    const id = env.DASHBOARD_LOCKS.idFromName("github-webhook-admission");
    const compactPayload = compactGitHubWebhookPayload(event, payload);
    return await env.DASHBOARD_LOCKS.get(id).fetch(
      new Request("https://releasebar.internal/webhook/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, delivery, payload: compactPayload }),
      }),
    );
  } catch (error) {
    await auditSyncEvent(env, {
      event: "github_webhook_failed",
      status: "failed",
      reason: errorMessage(error),
      detail: `githubEvent=${event} delivery=${delivery}`,
    }).catch(() => undefined);
    return jsonResponse({ error: "webhook processing failed" }, 500, {
      "cache-control": "no-store",
    });
  }
}

import { slugOwner, validRepoSlug } from "../scripts/lib/dashboard.js";
import type { ActivityRange, RefreshTarget } from "../src/types.js";
import { mapConcurrent } from "./concurrency.js";
import { randomNonce } from "./crypto.js";
import type {
  Env,
  GitHubWebhookFanoutJob,
  GitHubWebhookJob,
  StoredWebhookPending,
  WebhookTargetAction,
} from "./runtime.js";
import { tryJsonParse } from "./schemas.js";
import { repoActivityCacheKey } from "./activity-data.js";
import {
  repoAudienceCacheKey,
  repoAudienceUserReposKey,
  trustProfileCacheKey,
} from "./audience-data.js";
import { deleteProgress, markHotCacheStale } from "./build-progress.js";
import {
  activitySummaryPromptVersion,
  dashboardCachePrefix,
  dashboardStorageTtlSeconds,
  discoverCacheSchemaVersion,
  githubWebhookCoalescingBatchSize,
  githubWebhookPendingLimit,
  githubWebhookPendingLimitBytes,
  refreshTargetIndexReadyKey,
  refreshTargetIndexVersion,
  refreshTargetPrefix,
  refreshTargetSourceLimit,
  releaseSummaryPromptVersion,
  repoAudienceRanges,
  webhookPriorityTargetLimit,
  webhookRecentTargetMs,
  webhookTargetBatchSize,
  webhookTargetConcurrency,
  webhookTargetPageSize,
} from "./config.js";
import { safeIso } from "./owner-metadata-write.js";
import {
  currentDashboardCacheKey,
  isRefreshTarget,
  persistRefreshTargetWithIndexes,
  readRefreshTarget,
  refreshTargetIndexSource,
} from "./refresh-targets.js";
import { repoDetailCacheKey } from "./release-summary.js";
import { ownerActivityCacheKey, repoDetailAuxCachePrefix } from "./repo-github.js";
import { webhookHex } from "./request-lock.js";
import { socialRepoCacheKey } from "./social-card.js";

export async function validWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = `sha256=${webhookHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  )}`;
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return difference === 0;
}

export function webhookRepo(payload: Record<string, unknown>): {
  fullName: string;
  owner: string;
  archived: boolean | null;
  private: boolean | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
} | null {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return null;
  const repo = repository as Record<string, unknown>;
  const fullName = typeof repo.full_name === "string" ? repo.full_name.toLowerCase() : "";
  if (!validRepoSlug(fullName)) return null;
  return {
    fullName,
    owner: fullName.split("/")[0]!,
    archived: typeof repo.archived === "boolean" ? repo.archived : null,
    private:
      typeof repo.private === "boolean"
        ? repo.private
        : repo.visibility === "private"
          ? true
          : repo.visibility === "public"
            ? false
            : null,
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : null,
    pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
    updatedAt: typeof repo.updated_at === "string" ? repo.updated_at : null,
  };
}

export function compactGitHubWebhookPayload(
  event: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  const repository =
    payload.repository && typeof payload.repository === "object"
      ? (payload.repository as Record<string, unknown>)
      : null;
  if (repository) {
    compact.repository =
      event === "repository" && payload.action === "privatized"
        ? {
            full_name: repository.full_name,
            private: repository.private,
            updated_at: repository.updated_at,
          }
        : {
            full_name: repository.full_name,
            archived: repository.archived,
            private: repository.private,
            visibility: repository.visibility,
            default_branch: repository.default_branch,
            pushed_at: repository.pushed_at,
            updated_at: repository.updated_at,
          };
  }
  if (typeof payload.action === "string") compact.action = payload.action;
  if (event === "push") {
    compact.ref = payload.ref;
    compact.after = payload.after;
    compact.deleted = payload.deleted;
    const headCommit =
      payload.head_commit && typeof payload.head_commit === "object"
        ? (payload.head_commit as Record<string, unknown>)
        : null;
    if (headCommit) compact.head_commit = { timestamp: headCommit.timestamp };
  }
  if (event === "release") {
    const release =
      payload.release && typeof payload.release === "object"
        ? (payload.release as Record<string, unknown>)
        : null;
    if (release) {
      compact.release = {
        tag_name: release.tag_name,
        name: release.name,
        html_url: release.html_url,
        published_at: release.published_at,
        draft: release.draft,
      };
    }
  }
  return compact;
}

export function releaseWebhookAffectsDashboard(payload: Record<string, unknown>): boolean {
  const release =
    payload.release && typeof payload.release === "object"
      ? (payload.release as Record<string, unknown>)
      : null;
  const action = String(payload.action ?? "");
  if (!release || (release.draft === true && action !== "unpublished")) return false;
  return Boolean(action);
}

export function githubWebhookCoalescingKey(job: GitHubWebhookJob): string {
  const repo = webhookRepo(job.payload);
  if (!repo) return `delivery:${job.delivery}`;
  const action = String(job.payload.action ?? "");
  if (
    (job.event === "issues" &&
      ["opened", "reopened", "closed", "deleted", "transferred"].includes(action)) ||
    (job.event === "pull_request" && ["opened", "reopened", "closed", "deleted"].includes(action))
  ) {
    return `counts:${repo.fullName}`;
  }
  if (
    (job.event === "push" &&
      job.payload.deleted !== true &&
      (!repo.defaultBranch || job.payload.ref === `refs/heads/${repo.defaultBranch}`)) ||
    (job.event === "release" && releaseWebhookAffectsDashboard(job.payload))
  ) {
    return `release:${repo.fullName}`;
  }
  return `delivery:${job.delivery}`;
}

export function mergePendingWebhook(
  pending: StoredWebhookPending[],
  job: GitHubWebhookJob,
): StoredWebhookPending[] {
  const key = githubWebhookCoalescingKey(job);
  const existingIndex = pending.findIndex((entry) => entry.key === key);
  const next: StoredWebhookPending = {
    key,
    revision: randomNonce(),
    job,
    deliveries:
      existingIndex >= 0
        ? [...new Set([...pending[existingIndex]!.deliveries, job.delivery])]
        : [job.delivery],
  };
  if (existingIndex < 0) return [...pending, next];
  return pending.map((entry, index) => (index === existingIndex ? next : entry));
}

export function pendingWebhookFits(pending: StoredWebhookPending[]): boolean {
  return (
    pending.length <= githubWebhookPendingLimit &&
    new TextEncoder().encode(JSON.stringify(pending)).byteLength <= githubWebhookPendingLimitBytes
  );
}

export function pendingWebhookBatch(
  pending: StoredWebhookPending[],
  leaderDelivery: string,
): StoredWebhookPending[] {
  const sorted = [...pending].sort(
    (left, right) => safeIso(left.job.createdAt) - safeIso(right.job.createdAt),
  );
  const leader = sorted.find((entry) => entry.deliveries.includes(leaderDelivery));
  const others = sorted.filter((entry) => entry !== leader);
  // Finish with the leader so any earlier failure leaves its queue delivery retryable.
  return [
    ...others.slice(0, Math.max(0, githubWebhookCoalescingBatchSize - (leader ? 1 : 0))),
    ...(leader ? [leader] : []),
  ];
}

export type WebhookTargetPage = {
  targets: RefreshTarget[];
  next: Pick<GitHubWebhookFanoutJob, "source" | "cursor" | "backfillFailed"> | null;
  prioritized?: boolean;
};

export function compareWebhookTargets(left: RefreshTarget, right: RefreshTarget): number {
  return (
    safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt) ||
    right.priority - left.priority ||
    left.key.localeCompare(right.key)
  );
}

export function freshestWebhookTargets(targets: RefreshTarget[]): RefreshTarget[] {
  const freshest = new Map<string, RefreshTarget>();
  for (const target of targets) {
    const current = freshest.get(target.key);
    if (!current || compareWebhookTargets(target, current) < 0) {
      freshest.set(target.key, target);
    }
  }
  return [...freshest.values()];
}

export function webhookTargetMatches(
  target: RefreshTarget,
  owner: string,
  fullName: string,
): boolean {
  return target.owners.includes(owner) || target.repos.includes(fullName) || target.owner === owner;
}

export function webhookTargetIndexedByOwner(target: RefreshTarget, owner: string): boolean {
  return (
    slugOwner(target.owner) === owner ||
    target.owners.some((targetOwner) => slugOwner(targetOwner) === owner)
  );
}

export async function indexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<WebhookTargetPage> {
  if (env.DASHBOARD_LOCKS) {
    const { targets, nextCursor } = await durableIndexedWebhookTargets(env, source, value, cursor);
    return {
      targets,
      next: nextCursor
        ? { source, cursor: nextCursor, backfillFailed: undefined }
        : source === "owner"
          ? { source: "repo", cursor: undefined, backfillFailed: undefined }
          : env.DASHBOARD_CACHE?.list
            ? { source: "kv-owner", cursor: undefined, backfillFailed: undefined }
            : null,
    };
  }
  const page = await kvIndexedWebhookTargets(env, source, value, cursor);
  const next = page.nextCursor
    ? { source, cursor: page.nextCursor, backfillFailed: undefined }
    : source === "owner"
      ? { source: "repo" as const, cursor: undefined, backfillFailed: undefined }
      : env.DASHBOARD_CACHE?.list
        ? { source: "kv-owner" as const, cursor: undefined, backfillFailed: undefined }
        : null;
  return { targets: page.targets, next };
}

export async function kvIndexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<{ targets: RefreshTarget[]; nextCursor?: string }> {
  if (!env.DASHBOARD_CACHE?.list) return { targets: [] };
  const page = await env.DASHBOARD_CACHE.list({
    prefix: refreshTargetIndexSource(source, value),
    limit: webhookTargetPageSize,
    ...(cursor ? { cursor } : {}),
  });
  const indexed = await mapConcurrent(page.keys, 16, async (key) => {
    const raw = await env.DASHBOARD_CACHE?.get(key.name);
    const indexedValue = raw
      ? tryJsonParse<RefreshTarget | string>(raw, `refresh target index ${key.name}`)
      : null;
    const targetKey =
      typeof indexedValue === "string"
        ? indexedValue
        : isRefreshTarget(indexedValue)
          ? indexedValue.key
          : null;
    return targetKey ? readRefreshTarget(env, targetKey) : null;
  });
  return {
    targets: freshestWebhookTargets(
      indexed.filter((target): target is RefreshTarget => target !== null),
    ),
    nextCursor: page.list_complete ? undefined : page.cursor,
  };
}

export async function currentWebhookTargets(
  env: Env,
  targets: RefreshTarget[],
): Promise<RefreshTarget[]> {
  if (!env.DASHBOARD_CACHE) return targets;
  const current = await mapConcurrent(targets, 16, (target) => readRefreshTarget(env, target.key));
  return freshestWebhookTargets([
    ...current.filter((target): target is RefreshTarget => target !== null),
    ...targets,
  ]);
}

export async function durableIndexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<{ targets: RefreshTarget[]; nextCursor?: string }> {
  if (!env.DASHBOARD_LOCKS) return { targets: [] };
  const id = env.DASHBOARD_LOCKS.idFromName(`refresh-target-index:${source}:${value}`);
  const response = await env.DASHBOARD_LOCKS.get(id).fetch(
    new Request("https://releasebar.internal/target-index/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor, limit: webhookTargetPageSize }),
    }),
  );
  if (!response.ok) {
    throw new Error(`durable refresh target index returned ${response.status}`);
  }
  const stored = (await response.json()) as {
    targets?: unknown;
    nextCursor?: unknown;
  };
  if (!Array.isArray(stored.targets)) {
    throw new Error("durable refresh target index returned invalid data");
  }
  const indexed = freshestWebhookTargets(
    stored.targets.filter((target): target is RefreshTarget => isRefreshTarget(target)),
  );
  return {
    targets: await currentWebhookTargets(env, indexed),
    nextCursor:
      typeof stored.nextCursor === "string" && stored.nextCursor ? stored.nextCursor : undefined,
  };
}

export async function prioritizedIndexedWebhookTargets(
  env: Env,
  owner: string,
  fullName: string,
  includeReleaseDataOnly: boolean,
): Promise<WebhookTargetPage> {
  if (!env.DASHBOARD_LOCKS) return { targets: [], next: null };
  const read = async (source: "owner" | "repo", value: string): Promise<RefreshTarget[]> => {
    const id = env.DASHBOARD_LOCKS!.idFromName(`refresh-target-index:${source}:${value}`);
    const response = await env.DASHBOARD_LOCKS!.get(id).fetch(
      new Request("https://releasebar.internal/target-index/list", {
        method: "POST",
      }),
    );
    if (!response.ok) {
      throw new Error(`durable refresh target index returned ${response.status}`);
    }
    const stored = await response.json();
    if (!Array.isArray(stored)) {
      throw new Error("durable refresh target index returned invalid data");
    }
    return stored.filter((target): target is RefreshTarget => isRefreshTarget(target));
  };
  const [ownerTargets, repoTargets] = await Promise.all([
    read("owner", owner),
    read("repo", fullName),
  ]);
  const selected = freshestWebhookTargets(
    [...ownerTargets, ...repoTargets]
      .filter((target) => webhookTargetMatches(target, owner, fullName))
      .filter((target) => !includeReleaseDataOnly || target.includeReleaseData),
  )
    .sort(compareWebhookTargets)
    .slice(0, webhookPriorityTargetLimit);
  const targets = freshestWebhookTargets(await currentWebhookTargets(env, selected))
    .filter((target) => webhookTargetMatches(target, owner, fullName))
    .filter((target) => !includeReleaseDataOnly || target.includeReleaseData)
    .sort(compareWebhookTargets);
  return {
    targets,
    next: { source: "owner", cursor: undefined, backfillFailed: undefined },
    prioritized: true,
  };
}

export async function legacyWebhookTargets(
  env: Env,
  owner: string,
  fullName: string,
  cursor?: string,
  backfillFailed = false,
): Promise<WebhookTargetPage> {
  if (!env.DASHBOARD_CACHE?.list) return { targets: [], next: null };
  const page = await env.DASHBOARD_CACHE.list({
    prefix: refreshTargetPrefix,
    limit: webhookTargetPageSize,
    ...(cursor ? { cursor } : {}),
  });
  const readTargets = await mapConcurrent(page.keys, 16, async (key) => {
    const raw = await env.DASHBOARD_CACHE?.get(key.name);
    const target = raw ? tryJsonParse<RefreshTarget>(raw, `refresh target ${key.name}`) : null;
    return isRefreshTarget(target) && currentDashboardCacheKey(target.key) ? target : null;
  });
  const validTargets = readTargets.filter((target): target is RefreshTarget => target !== null);
  const backfillResults = await mapConcurrent(
    validTargets.filter((target) => target.indexVersion !== refreshTargetIndexVersion),
    4,
    (target) => persistRefreshTargetWithIndexes(env, target),
  );
  const pageBackfillFailed = backfillResults.some(
    (result) => result.persisted && result.target.indexVersion !== refreshTargetIndexVersion,
  );
  const failed = backfillFailed || pageBackfillFailed;
  if (page.list_complete && !failed) {
    await env.DASHBOARD_CACHE.put(refreshTargetIndexReadyKey, String(refreshTargetIndexVersion), {
      expirationTtl: dashboardStorageTtlSeconds,
    });
  }
  return {
    targets: validTargets.filter((target) => webhookTargetMatches(target, owner, fullName)),
    next: page.list_complete
      ? null
      : { source: "legacy", cursor: page.cursor, backfillFailed: failed },
  };
}

export async function legacyOwnerWebhookSeedTargets(
  env: Env,
  owner: string,
  fullName: string,
): Promise<RefreshTarget[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const page = await env.DASHBOARD_CACHE.list({
    prefix: `${refreshTargetPrefix}${dashboardCachePrefix}${owner}:`,
    limit: refreshTargetSourceLimit,
  });
  const targets = await mapConcurrent(page.keys, 8, async (key) => {
    const raw = await env.DASHBOARD_CACHE?.get(key.name);
    const target = raw ? tryJsonParse<RefreshTarget>(raw, `refresh target ${key.name}`) : null;
    return isRefreshTarget(target) && webhookTargetMatches(target, owner, fullName) ? target : null;
  });
  return freshestWebhookTargets(
    targets.filter((target): target is RefreshTarget => target !== null),
  )
    .sort(compareWebhookTargets)
    .slice(0, webhookPriorityTargetLimit);
}

export async function webhookTargetPage(
  env: Env,
  owner: string,
  fullName: string,
  source?: GitHubWebhookFanoutJob["source"],
  cursor?: string,
  backfillFailed?: boolean,
  priorityIncludeReleaseDataOnly = false,
): Promise<WebhookTargetPage> {
  if (!env.DASHBOARD_CACHE?.list && !env.DASHBOARD_LOCKS) return { targets: [], next: null };
  const indexReady =
    (await env.DASHBOARD_CACHE?.get(refreshTargetIndexReadyKey)) ===
    String(refreshTargetIndexVersion);
  const selectedSource =
    source ?? (indexReady ? (env.DASHBOARD_LOCKS ? "indexed" : "owner") : "legacy");
  if (selectedSource === "legacy") {
    if (source === undefined && priorityIncludeReleaseDataOnly) {
      return {
        targets: [],
        next: { source: "legacy", cursor: undefined, backfillFailed: undefined },
        prioritized: true,
      };
    }
    const page = await legacyWebhookTargets(env, owner, fullName, cursor, backfillFailed);
    return page;
  }
  if (selectedSource === "indexed") {
    if (source === undefined) {
      return prioritizedIndexedWebhookTargets(env, owner, fullName, priorityIncludeReleaseDataOnly);
    }
    const page = await indexedWebhookTargets(env, "owner", owner, cursor);
    return {
      ...page,
      targets: page.targets.filter((target) => webhookTargetMatches(target, owner, fullName)),
    };
  }
  if (selectedSource === "kv-owner" || selectedSource === "kv-repo") {
    const kvSource = selectedSource === "kv-owner" ? "owner" : "repo";
    const value = kvSource === "owner" ? owner : fullName;
    const page = await kvIndexedWebhookTargets(env, kvSource, value, cursor);
    return {
      targets: page.targets.filter(
        (target) =>
          target.indexVersion !== refreshTargetIndexVersion &&
          webhookTargetMatches(target, owner, fullName) &&
          (kvSource !== "repo" || !webhookTargetIndexedByOwner(target, owner)),
      ),
      next: page.nextCursor
        ? { source: selectedSource, cursor: page.nextCursor, backfillFailed: undefined }
        : selectedSource === "kv-owner"
          ? { source: "kv-repo", cursor: undefined, backfillFailed: undefined }
          : null,
    };
  }
  if (source === undefined && priorityIncludeReleaseDataOnly) {
    return {
      targets: [],
      next: { source: "owner", cursor: undefined, backfillFailed: undefined },
      prioritized: true,
    };
  }
  const value = selectedSource === "owner" ? owner : fullName;
  const page = await indexedWebhookTargets(env, selectedSource, value, cursor);
  const result: WebhookTargetPage = {
    ...page,
    targets: page.targets.filter(
      (target) =>
        webhookTargetMatches(target, owner, fullName) &&
        (selectedSource !== "repo" || !webhookTargetIndexedByOwner(target, owner)),
    ),
  };
  return result;
}

export async function mapWebhookTargets<T>(
  targets: RefreshTarget[],
  operation: (target: RefreshTarget) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < targets.length; index += webhookTargetBatchSize) {
    results.push(
      ...(await mapConcurrent(
        targets.slice(index, index + webhookTargetBatchSize),
        webhookTargetConcurrency,
        operation,
      )),
    );
  }
  return results;
}

export function webhookTargetsForAction(
  targets: RefreshTarget[],
  action: WebhookTargetAction,
  now = Date.now(),
): RefreshTarget[] {
  const recentCutoff = now - webhookRecentTargetMs;
  return freshestWebhookTargets(
    targets
      .filter((target) => !action.includeReleaseDataOnly || target.includeReleaseData)
      .filter((target) => !action.recentTargetsOnly || safeIso(target.lastSeenAt) >= recentCutoff),
  ).sort(compareWebhookTargets);
}

export async function invalidateRepoProjectCache(env: Env, fullName: string): Promise<void> {
  await Promise.all(
    [true, false].flatMap((includeUnreleased) =>
      [true, false].map((includeReleaseData) =>
        env.DASHBOARD_CACHE?.delete?.(
          `repo:v2:${fullName}:${includeUnreleased ? "unreleased" : "released"}:${includeReleaseData ? "release" : "metadata"}`,
        ),
      ),
    ),
  );
}

export async function invalidateRepoDetailCaches(env: Env, fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;
  await Promise.all([
    env.DASHBOARD_CACHE?.delete?.(repoDetailCacheKey(owner, repo)),
    deleteCachePrefix(env, repoDetailAuxCachePrefix(fullName)),
  ]);
}

export async function deleteCachePrefix(env: Env, prefix: string): Promise<void> {
  if (!env.DASHBOARD_CACHE?.list || !env.DASHBOARD_CACHE.delete) return;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    await mapConcurrent(page.keys, 16, (key) => env.DASHBOARD_CACHE!.delete!(key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export async function invalidatePublicRepoCaches(env: Env, fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;
  await Promise.all([
    invalidateRepoProjectCache(env, fullName),
    invalidateRepoDetailCaches(env, fullName),
    env.DASHBOARD_CACHE?.delete?.(socialRepoCacheKey(owner, repo)),
    ...(["day", "week", "month"] as ActivityRange[]).map((range) =>
      env.DASHBOARD_CACHE?.delete?.(repoActivityCacheKey(owner, repo, range)),
    ),
    ...repoAudienceRanges.map((range) =>
      env.DASHBOARD_CACHE?.delete?.(repoAudienceCacheKey(owner, repo, range)),
    ),
    env.DASHBOARD_CACHE?.delete?.(repoAudienceUserReposKey(owner)),
    env.DASHBOARD_CACHE?.delete?.(trustProfileCacheKey(owner)),
    ...(["day", "week", "month"] as ActivityRange[]).map((range) =>
      env.DASHBOARD_CACHE?.delete?.(ownerActivityCacheKey(owner, range)),
    ),
    deleteCachePrefix(env, "repo-audience:v5:"),
    deleteCachePrefix(env, "owner-activity:v"),
    deleteCachePrefix(env, "owner-activity-summary:"),
    deleteCachePrefix(
      env,
      `owner-activity-summary:v${activitySummaryPromptVersion}:${slugOwner(owner)}:`,
    ),
    deleteCachePrefix(
      env,
      `repo-activity-summary:v${activitySummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCachePrefix(
      env,
      `release-summary:v${releaseSummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCachePrefix(env, `discover:v${discoverCacheSchemaVersion}:`),
  ]);
}

export async function invalidateDashboardTargets(
  env: Env,
  targets: RefreshTarget[],
): Promise<void> {
  await markHotCacheStale(env);
  await mapWebhookTargets(targets, async (target) => {
    await Promise.all([env.DASHBOARD_CACHE?.delete?.(target.key), deleteProgress(env, target.key)]);
  });
}

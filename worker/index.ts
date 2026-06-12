import {
  calculateAudienceScore,
  type AudienceOrgSignal,
  type AudienceRepoSignal,
  type AudienceScoreTier,
} from "../scripts/lib/audience.js";
import {
  buildDashboard,
  dashboardCacheKey,
  fetchOwnerRepoCounts,
  GitHubRateLimitError,
  type OwnerRepoCount,
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import * as v from "valibot";
import type { GenericSchema, InferOutput } from "valibot";
import {
  gitHubCheckRunsSchema,
  gitHubCodeFrequencySchema,
  gitHubCommitActivitySchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubInstallationSchema,
  gitHubInstallationListSchema,
  gitHubInstallationRepositoryListSchema,
  gitHubInstallationTokenSchema,
  gitHubLanguageSchema,
  gitHubOAuthTokenSchema,
  gitHubOAuthUserSchema,
  gitHubPublicEventListSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  gitHubSearchRepositoryListSchema,
  gitHubSearchCountSchema,
  gitHubStargazerListSchema,
  gitHubUserOrganizationListSchema,
  gitHubUserProfileSchema,
  gitHubUserRepositoryListSchema,
  hotIndexSchema,
  parseGitHubResponse,
  safeJsonParse,
  storedAuthSessionSchema,
  tryJsonParse,
  type GitHubInstallationRepository,
  type GitHubPublicEvent,
  type GitHubSearchRepository,
  type GitHubStargazer,
  type GitHubUserOrganization,
  type GitHubUserProfile,
  type GitHubUserRepository,
} from "./schemas.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type {
  ApiQuota,
  AudienceRange,
  AuthFunnelEvent,
  AuthFunnelSummary,
  AuthInstallation,
  AuthInstallationRecord,
  AuthPayload,
  AuthUser,
  ActivityRange,
  DashboardProfile,
  DashboardPayload,
  Owner,
  OwnerActivityEvent,
  OwnerActivityPayload,
  OwnerActivityRepository,
  OwnerActivitySummary,
  Project,
  RepoAudiencePayload,
  RepoAudienceUser,
  RepoDetailActivityPayload,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
  RepoDetailWorkTrend,
  RefreshJob,
  RefreshTarget,
  SchedulerAdminPayload,
  SchedulerAuditEvent,
  GitHubAccessSummary,
  GitHubAccessRouteSummary,
  AudienceScoreFactor,
  TrustProfilePayload,
} from "../src/types.js";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

type DurableObjectId = unknown;

type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

type Queue<Message = unknown> = {
  send(message: Message, options?: { delaySeconds?: number }): Promise<void>;
};

type GitHubWebhookJob = {
  kind: "github-webhook";
  id: string;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts?: number;
};

type WebhookTargetAction = {
  reason: string;
  includeReleaseDataOnly: boolean;
  invalidateDashboard: boolean;
  recentTargetsOnly?: boolean;
  prioritizedTargetKeys?: string[];
};

type GitHubWebhookFanoutJob = {
  kind: "github-webhook-fanout";
  id: string;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
  createdAt: string;
  action: WebhookTargetAction;
  source: "indexed" | "owner" | "repo" | "kv-owner" | "kv-repo" | "legacy";
  priorityBatchStartedAt?: string;
  cursor?: string;
  backfillFailed?: boolean;
};

type WorkerQueueMessage = RefreshJob | GitHubWebhookJob | GitHubWebhookFanoutJob;

type MessageBatch<Message = unknown> = {
  messages: Array<{
    body: Message;
    attempts?: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
};

type DurableObjectState = {
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

type Env = {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AUTH_COOKIE_SECRET?: string;
  DASHBOARD_CACHE?: KVNamespace;
  DASHBOARD_LOCKS?: DurableObjectNamespace;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_SUMMARY_MODEL?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
  REFRESH_QUEUE?: Queue<WorkerQueueMessage>;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const githubAccessWriteChains = new WeakMap<ExecutionContext, Promise<void>>();

type ScheduledEvent = {
  cron: string;
  scheduledTime: number;
};

type RequestCf = {
  verifiedBotCategory?: string;
  botManagement?: {
    verifiedBot?: boolean;
  };
};

type UserTrustSignal = {
  score: number;
  tier: AudienceScoreTier;
};

const fullTtlMs = 60 * 60 * 1000;
const dashboardStorageTtlSeconds = 90 * 24 * 60 * 60;
const progressTtlSeconds = 7 * 24 * 60 * 60;
const maxDisplayStaleMs = 30 * 24 * 60 * 60 * 1000;
const installationTokenTtlSeconds = 50 * 60;
const installationAcknowledgementGraceMs = 15 * 60 * 1000;
const installationRegistryFastPathMaxAgeMs = 15 * 60 * 1000;
const coldBuildWaitMs = 15 * 1000;
const initialMetadataRepoLimit = 25;
const authenticatedReleaseOwnerPageSize = 50;
const progressiveBuildBudgetMs = 25 * 1000;
const queuedProgressiveBuildBudgetMs = 12 * 60 * 1000;
const progressWriteIntervalMs = 1100;
const buildLockTtlMs = 2 * 60 * 1000;
const buildLockRefreshMs = 30 * 1000;
const buildLockRetrySeconds = 60;
const refreshJobReservationTtlMs = 2 * 60 * 60 * 1000;
const incompleteBuildRetrySeconds = 2;
const refreshQueueDeliveryDelaySeconds = 2;
const refreshQueueMaxRetries = 10;
// Push consumers receive one initial delivery plus max_retries redeliveries.
const refreshQueueMaxAttempts = refreshQueueMaxRetries + 1;
const refreshJobActiveGraceMs = 60 * 1000;
const repoLimit = 200;
const repoScanBatchSize = 12;
const hotLimit = 50;
const hotOwnerLimit = 3;
const hotSourceLimit = 24;
const hotIndexLimit = 100;
const hotCacheTtlMs = 5 * 60 * 1000;
const localBuildLocks = new Map<string, StoredBuildLock>();
const localRefreshReservationFallbackScope = {};
const localRefreshJobReservations = new WeakMap<object, Map<string, StoredRefreshJobReservation>>();
const localRefreshDirtyMarkers = new WeakMap<object, Map<string, StoredRefreshDirty>>();
const discoverLimit = 40;
const discoverHydrateLimit = 24;
const discoverHydrateBatchSize = 8;
const discoverCacheTtlMs = 60 * 60 * 1000;
const repoDetailCacheTtlMs = 6 * 60 * 60 * 1000;
const repoDetailWarmingRefreshMs = 30 * 1000;
const repoDetailAuxCacheVersion = 1;
const repoDetailAuxTtlSeconds = 7 * 24 * 60 * 60;
const repoDetailReleaseCacheTtlMs = 60 * 60 * 1000;
const repoDetailLiveProbeCacheTtlMs = 10 * 60 * 1000;
const repoDetailSearchCountCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
const repoDetailStatsCacheTtlMs = 12 * 60 * 60 * 1000;
const repoDetailStatsBackoffTtlSeconds = 10 * 60;
const repoAudienceCacheTtlMs = 6 * 60 * 60 * 1000;
const repoAudienceUserTtlSeconds = 7 * 24 * 60 * 60;
const repoAudienceStargazerLimit = 30;
const repoAudienceDeepUserLimit = 12;
const repoAudienceRanges: AudienceRange[] = ["week", "month"];
const repoAudienceUserRepoLimit = 8;
const releaseSummaryPromptVersion = 1;
const releaseSummaryCommitLimit = 500;
const activitySummaryPromptVersion = 2;
const activityEventPageLimit = 3;
const activitySummaryInputLimit = 120;
const maxCustomSources = 8;
const dashboardSchemaVersion = 6;
const auxiliaryCacheSchemaVersion = 3;
const discoverCacheSchemaVersion = 4;
const dashboardCachePrefix = `dashboard:v${dashboardSchemaVersion}:`;
const dashboardCachePrefixes = [dashboardCachePrefix];
const hotCacheKey = `hot:v${auxiliaryCacheSchemaVersion}`;
const hotIndexKey = `hot:index:v${auxiliaryCacheSchemaVersion}`;
const socialRepoCachePrefix = `social-repo:v${auxiliaryCacheSchemaVersion}:`;
const ownerCachePrefix = `owner:v1:`;
const ownerCacheTtlSeconds = 7 * 24 * 60 * 60;
const githubAccessPrefix = `github:access:v1:`;
const githubAccessTtlSeconds = 14 * 24 * 60 * 60;
const githubAccessShardCount = 16;
const githubSharedBudgetPrefix = `github:budget:v1:shared:`;
const githubGraphqlBackoffPrefix = `github:backoff:v2:graphql:`;
const githubGraphqlBackoffSeconds = 2 * 60;
const githubGraphqlOwnerCountsOperation = "ReleaseBarOwnerCounts";
const githubGraphqlOwnerReleaseOperation = "ReleaseBarOwnerRepos.release";
const githubGraphqlRepoDetailsOperation = "ReleaseBarRepoDetails";
const githubGraphqlRepoStargazersOperation = "ReleaseBarRepoStargazers";
const githubAccessAdminHours = 24;
const githubAccessAdminRouteLimit = 30;
const crawlerUserAgentPattern =
  /(ahrefsbot|applebot|baiduspider|bingbot|bot|bytespider|ccbot|claudebot|crawler|duckduckbot|facebookexternalhit|googlebot|googleother|gptbot|linkedinbot|mediapartners|perplexitybot|preview|semrushbot|slackbot|slurp|spider|telegrambot|twitterbot|yandexbot)/i;
const authFunnelPrefix = `auth:funnel:v1:`;
const authFunnelCounterPrefix = `auth:funnel-counter:v1:`;
const authFunnelListLimit = 80;
const sharedQuotaCooldownFallbackSeconds = 30 * 60;
const sharedQuotaMinimumRemaining: Record<string, number> = {
  core: 500,
  graphql: 1000,
  search: 3,
  integration_manifest: 20,
  _: 250,
};
const refreshTargetPrefix = `refresh:target:v1:`;
const refreshTargetIndexPrefix = `refresh:target-index:v1:`;
const refreshTargetIndexReadyKey = `refresh:target-index:v1:ready`;
const refreshTargetIndexVersion = 2;
const refreshTargetIndexBackfillLimit = 50;
const refreshProfileSnapshotPrefix = `refresh:profile-snapshot:v1:`;
const refreshJobPrefix = `refresh:job:v1:`;
const refreshJobIndexPrefix = `refresh:jobs:v2:`;
const refreshJobDeliveryPrefix = `refresh:job-deliveries:v1:`;
const legacyRefreshJobIndexKey = `refresh:jobs:index:v1`;
const refreshAuditPrefix = `refresh:audit:v2:`;
const refreshStateKey = `refresh:state:v1`;
const refreshOwnerCountCursorKey = `refresh:owner-count-cursor:v1`;
const ownerMetadataPrefix = `owner-metadata:v1:`;
const ownerMetadataTtlSeconds = 90 * 24 * 60 * 60;
const githubWebhookDeliveryTtlMs = 24 * 60 * 60 * 1000;
const githubWebhookDeliveryLimit = 2000;
const githubWebhookProcessingLeaseMs = 12 * 60 * 1000;
const githubWebhookBodyLimitBytes = 2 * 1024 * 1024;
const githubWebhookRequeueLimit = 48;
const manualRefreshCooldownPrefix = `refresh:manual:v1:`;
const manualRefreshCooldownSeconds = 10 * 60;
const refreshTargetListLimit = 5000;
const refreshTargetSourceLimit = 512;
const durableRefreshTargetIndexLimit = refreshTargetSourceLimit;
const durableRefreshTargetEntryLimitBytes = 8 * 1024;
const durableRefreshTargetIndexLimitBytes = 1024 * 1024;
const webhookTargetPageSize = 200;
const webhookTargetBatchSize = 50;
const webhookTargetConcurrency = 8;
const webhookPriorityTargetLimit = 25;
const webhookPriorityFanoutWaitMs = 2 * 60 * 1000;
const webhookPriorityFanoutRetrySeconds = 20;
const webhookRecentTargetMs = 24 * 60 * 60 * 1000;
const refreshJobListLimit = 80;
const refreshAuditListLimit = 80;
const schedulerBatchLimit = 20;
const schedulerSharedDormantRefreshMs = 7 * 24 * 60 * 60 * 1000;
const schedulerSharedDormantAfterMs = 24 * 60 * 60 * 1000;
const schedulerRecentViewMs = 7 * 24 * 60 * 60 * 1000;
const schedulerCountRefreshMs = 15 * 60 * 1000;
const schedulerCountOwnerLimit = 20;
const schedulerCountConcurrency = 4;
const schedulerActiveRefreshMs = 6 * 60 * 60 * 1000;
const schedulerDormantRefreshMs = 24 * 60 * 60 * 1000;
const schedulerRetryBaseMs = 30 * 60 * 1000;
const sessionCookie = "rd_session";
const installReturnCookie = "rd_install_return";
const oauthStateCookiePrefix = "rd_oauth_state_";
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const stateMaxAgeSeconds = 10 * 60;
const oauthReturnToMaxLength = 1024;
const buildPending = Symbol("build-pending");
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

function isRepoDetailApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "repos";
}

function isRepoAudienceApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "audience"
  );
}

function isRepoAudienceBackfillApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "repos" &&
    parts[4] === "audience" &&
    parts[5] === "backfill"
  );
}

function isRepoActivityApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "activity"
  );
}

function isOwnerActivityApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "activity";
}

function isOwnerEventsApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "events";
}

function isOwnerApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "api";
}

function isOwnerRefreshApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  const owner = parts[1] ?? "";
  return isOwnerApiPath(pathname) && owner !== "me" && !owner.startsWith("_");
}

function isTrustProfileApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "users" && parts[3] === "trust";
}

type DashboardRequest = {
  owners: Owner[];
  includeRepos: string[];
  profile: DashboardProfile | null;
  subtitle: string;
  key: string;
  url: URL;
  includeReleaseData: boolean;
  hydrateSort?: "issues" | "prs" | null;
  hydrateDirection?: "asc" | "desc";
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
};

type OwnerMetadataSnapshot = {
  owner: string;
  generatedAt: string;
  metadataUpdatedAt: string;
  countsUpdatedAt: string | null;
  countsAttemptedAt: string | null;
  releaseDataComplete: boolean;
  knownRepos: string[] | null;
  privateRepos: Record<string, string>;
  removedRepos: Record<string, string>;
  projectMetadataUpdatedAt: Record<string, string>;
  projectCountsUpdatedAt: Record<string, string>;
  countOverlays: Record<string, OwnerRepoCount>;
  projects: Project[];
};

type RequestToken = {
  token: string;
  quotaSource: "app";
  quotaAccount: string | null;
};

type GitHubAuditArea =
  | "dashboard"
  | "discover"
  | "owner-activity"
  | "repo-activity"
  | "repo-audience"
  | "repo-detail"
  | "release-summary"
  | "trust-profile"
  | "social-card"
  | "auth";

const githubAuditAreas = new Set<GitHubAuditArea>([
  "dashboard",
  "discover",
  "owner-activity",
  "repo-activity",
  "repo-audience",
  "repo-detail",
  "release-summary",
  "trust-profile",
  "social-card",
  "auth",
]);

function githubRequestOptions(
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
): { accept: string; auditArea: GitHubAuditArea } {
  if (githubAuditAreas.has(acceptOrAuditArea as GitHubAuditArea)) {
    return {
      accept: "application/vnd.github+json",
      auditArea: acceptOrAuditArea as GitHubAuditArea,
    };
  }
  return { accept: acceptOrAuditArea, auditArea };
}

type ProfileInput = {
  includeOwners?: unknown;
  includeRepos?: unknown;
  hiddenOwners?: unknown;
  hiddenRepos?: unknown;
};

type BuildLock = {
  refresh(): Promise<void>;
  release(): Promise<void>;
};

type StoredBuildLock = {
  token: string;
  expiresAt: number;
};

type StoredRefreshJobReservation = {
  jobId: string;
  expiresAt: number;
};

type StoredRefreshDirty = {
  observedAt: string;
  reason: string;
};

type StoredWebhookDelivery = {
  id: string;
  processedAt: number;
};

type StoredWebhookProcessing = {
  delivery: string;
  expiresAt: number;
};

type OwnerMetadataMutation =
  | {
      kind: "merge";
      generatedAt: string;
      observedAt: string;
      countsUpdatedAt: string | null;
      countsComplete: boolean;
      releaseDataComplete: boolean;
      mode: "metadata" | "hydrated";
      projects: Project[];
      removedRepos: string[];
    }
  | {
      kind: "counts";
      updatedAt: string;
      counts: OwnerRepoCount[];
      complete: boolean;
    }
  | {
      kind: "visibility";
      fullName: string;
      archived: boolean;
      observedAt: string;
      repositoryUpdatedAt: string | null;
    }
  | {
      kind: "remove";
      fullName: string;
      observedAt: string;
    }
  | {
      kind: "restore";
      fullName: string;
      observedAt: string;
    };

type RefreshTargetMutation =
  | {
      kind: "observe";
      input: Pick<
        RefreshTarget,
        "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
      >;
      observedAt: string;
      profileProvided: boolean;
      profileSnapshotKey?: string | null;
    }
  | {
      kind: "defer";
      at: string;
      nextDueAt: string;
      message: string;
    }
  | {
      kind: "success";
      at: string;
      message?: string;
    }
  | {
      kind: "failure";
      at: string;
      message: string;
      terminal: boolean;
    };

type StoredBuildProgress = {
  scannedRepos: string[];
  projects: Project[];
  generationStartedAt?: string;
  countsUpdatedAt?: string | null;
  projectCountsUpdatedAt?: Record<string, string>;
  releasesUpdatedAt?: string | null;
  ciUpdatedAt?: string | null;
  updatedAt: string;
  durableFallback?: true;
};

type StoredBuildProgressTombstone = {
  clearedAt: string;
};

type StoredSocialRepo = {
  generatedAt: string;
  project: Project;
};

type AuthState = {
  returnTo: string;
  iat: number;
  nonce: string;
};

type AuthSession = {
  id: string;
  exp: number;
};

type StoredAuthSession = {
  user: AuthUser;
  accessToken: string;
  iat: number;
  exp: number;
  installations?: AuthInstallation[];
  installationsUpdatedAt?: string;
};

const storedInstallationSchema = v.object({
  id: v.number(),
  accountLogin: v.string(),
  accountType: v.picklist(["user", "org"]),
  accountUrl: v.string(),
  avatarUrl: v.string(),
  repositorySelection: v.picklist(["all", "selected"]),
  repositories: v.array(v.string()),
  updatedAt: v.optional(v.string()),
});

type StoredInstallationRecord = AuthInstallation & {
  updatedAt?: string;
};

function authFunnelStorageKey(event: Pick<AuthFunnelEvent, "id" | "at">): string {
  const timestamp = safeIso(event.at) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${authFunnelPrefix}${reverseTimestamp}:${event.id}`;
}

function authFunnelCounterKey(
  event: string,
  account: string | null,
  status: string | null,
): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${authFunnelCounterPrefix}${day}:${event}:${account ?? "_"}:${status ?? "_"}`;
}

function authEventDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, " ").slice(0, 160);
}

async function readCounter(env: Env, key: string): Promise<number> {
  const current = Number.parseInt((await env.DASHBOARD_CACHE?.get(key)) ?? "0", 10);
  return Number.isFinite(current) ? current : 0;
}

async function recordAuthFunnelEvent(
  env: Env,
  input: Omit<AuthFunnelEvent, "id" | "at">,
): Promise<void> {
  if (!env.DASHBOARD_CACHE) return;
  try {
    const item: AuthFunnelEvent = {
      id: randomNonce(),
      at: new Date().toISOString(),
      ...input,
      account: input.account ? slugOwner(input.account) : null,
      detail: authEventDetail(input.detail),
    };
    const counterKey = authFunnelCounterKey(item.event, item.account, item.status);
    await Promise.all([
      env.DASHBOARD_CACHE.put(authFunnelStorageKey(item), JSON.stringify(item), {
        expirationTtl: dashboardStorageTtlSeconds,
      }),
      readCounter(env, counterKey).then((count) =>
        env.DASHBOARD_CACHE!.put(counterKey, String(count + 1), {
          expirationTtl: dashboardStorageTtlSeconds,
        }),
      ),
    ]);
  } catch (error) {
    console.warn(
      JSON.stringify({ area: "auth", event: "funnel_write_failed", error: errorMessage(error) }),
    );
  }
}

function storedInstallationRecord(record: StoredInstallationRecord): AuthInstallationRecord {
  return {
    ...record,
    updatedAt: record.updatedAt ?? new Date(0).toISOString(),
  };
}

async function listStoredInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const records: AuthInstallationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: `auth:installation:v1:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const parsed = safeJsonParse(storedInstallationSchema, raw, `app installation ${key.name}`);
      if (parsed) records.push(storedInstallationRecord(parsed));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records.sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt));
}

async function listAuthFunnelEvents(env: Env): Promise<AuthFunnelEvent[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const events: AuthFunnelEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: authFunnelPrefix,
      limit: Math.min(1000, authFunnelListLimit - events.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const parsed = tryJsonParse<AuthFunnelEvent>(raw, `auth funnel ${key.name}`);
      if (parsed?.id && parsed.at && parsed.event) events.push(parsed);
      if (events.length >= authFunnelListLimit) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && events.length < authFunnelListLimit);
  return events.sort((a, b) => safeIso(b.at) - safeIso(a.at));
}

async function listAuthFunnelCounts(env: Env): Promise<Array<{ key: string; count: number }>> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const counts: Array<{ key: string; count: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: authFunnelCounterPrefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const count = Number.parseInt((await env.DASHBOARD_CACHE.get(key.name)) ?? "0", 10);
      if (Number.isFinite(count) && count > 0) {
        counts.push({ key: key.name.slice(authFunnelCounterPrefix.length), count });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return counts.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 80);
}

async function authFunnelSummary(env: Env): Promise<AuthFunnelSummary> {
  const [installations, events, counts] = await Promise.all([
    listStoredInstallations(env),
    listAuthFunnelEvents(env),
    listAuthFunnelCounts(env),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    installations,
    events,
    counts,
  };
}

function isPublicInstallationRepository(repo: GitHubInstallationRepository): boolean {
  if (repo.private === true) {
    return false;
  }
  return repo.private === false || repo.visibility === "public";
}

function installationRegistryKey(accountLogin: string): string {
  return `auth:installation:v1:${slugOwner(accountLogin)}`;
}

function installationMissKey(accountLogin: string): string {
  return `auth:installation-miss:v1:${slugOwner(accountLogin)}`;
}

function normalizedInstallation(installation: AuthInstallation): StoredInstallationRecord {
  return {
    ...installation,
    accountLogin: slugOwner(installation.accountLogin),
    repositories: installation.repositories.map((repo) => repo.toLowerCase()).filter(validRepoSlug),
    updatedAt: new Date().toISOString(),
  };
}

async function writeInstallationRegistry(
  env: Env,
  installations: AuthInstallation[],
): Promise<void> {
  if (!env.DASHBOARD_CACHE) return;
  const normalized = installations.map(normalizedInstallation);
  await Promise.all(
    normalized.map((installation) => {
      return env.DASHBOARD_CACHE!.put(
        installationRegistryKey(installation.accountLogin),
        JSON.stringify(installation),
        { expirationTtl: dashboardStorageTtlSeconds },
      );
    }),
  );
  await Promise.all(
    normalized
      .filter((installation) => installation.repositorySelection === "all")
      .map((installation) =>
        rememberRefreshTarget(env, {
          key: dashboardCacheKey({
            owner: installation.accountLogin,
            includeForks: false,
            includeArchived: false,
            includeUnreleased: true,
            includeReleaseData: true,
            schemaVersion: dashboardSchemaVersion,
          }),
          owner: installation.accountLogin,
          owners: [installation.accountLogin],
          repos: [],
          includeReleaseData: true,
          path: `/${installation.accountLogin}`,
          priority: 80,
        }),
      ),
  );
}

async function readInstallationRegistry(
  env: Env,
  accountLogin: string,
): Promise<StoredInstallationRecord | null> {
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  const raw = await env.DASHBOARD_CACHE?.get(installationRegistryKey(account));
  if (!raw) return null;
  return safeJsonParse(storedInstallationSchema, raw, `app installation ${account}`);
}

function auditGitHubTokenUse(
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
): void {
  console.log(
    JSON.stringify({
      event: "github_token_use",
      area,
      path,
      status,
      quota: {
        source: quota.source,
        account: quota.account,
        remaining: quota.remaining,
        limit: quota.limit,
        resetAt: quota.resetAt,
        resource: quota.resource,
      },
    }),
  );
}

function githubPathBucket(path: string): string {
  const url = new URL(path, "https://api.github.com");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/graphql") {
    const operation = url.searchParams.get("operation");
    return operation ? `graphql/${operation}` : "graphql";
  }
  if (parts[0] === "users" && parts[2] === "repos") return "users/:owner/repos";
  if (parts[0] === "orgs" && parts[2] === "repos") return "orgs/:owner/repos";
  if (parts[0] === "users" && parts.length === 2) return "users/:owner";
  if (parts[0] === "repos" && parts.length >= 3) {
    const suffix = parts.slice(3);
    if (suffix[0] === "releases") return "repos/:owner/:repo/releases";
    if (suffix[0] === "compare") return "repos/:owner/:repo/compare";
    if (suffix[0] === "commits" && suffix[2] === "check-runs") {
      return "repos/:owner/:repo/commits/:ref/check-runs";
    }
    if (suffix[0] === "commits") return "repos/:owner/:repo/commits/:ref";
    if (suffix[0] === "pulls") return "repos/:owner/:repo/pulls";
    if (suffix[0] === "stats") return `repos/:owner/:repo/stats/${suffix[1] ?? ""}`;
    if (suffix[0]) return `repos/:owner/:repo/${suffix[0]}`;
    return "repos/:owner/:repo";
  }
  if (parts[0] === "search") return `search/${parts[1] ?? ""}`;
  return url.pathname;
}

function githubAccessCounterKey(shard: number): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `${githubAccessPrefix}${hour}:${shard}`;
}

type SharedQuotaCooldown = {
  active: boolean;
  resource: string | null;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  reason: string | null;
};

function sharedQuotaThreshold(resource: string | null): number {
  return sharedQuotaMinimumRemaining[resource ?? "_"] ?? sharedQuotaMinimumRemaining._;
}

function sharedQuotaBudgetKey(resource: string | null): string {
  return `${githubSharedBudgetPrefix}${resource ?? "_"}`;
}

function sharedQuotaCooldownTtlSeconds(resetAt: string | null): number {
  const resetMs = resetAt ? Date.parse(resetAt) - Date.now() : 0;
  if (Number.isFinite(resetMs) && resetMs > 0) {
    return Math.max(60, Math.min(2 * 60 * 60, Math.ceil(resetMs / 1000)));
  }
  return sharedQuotaCooldownFallbackSeconds;
}

async function markSharedQuotaCooldown(
  env: Env | undefined,
  quota: ApiQuota,
  reason: string,
): Promise<void> {
  if (!env?.DASHBOARD_CACHE || quota.source !== "shared") return;
  const resetAt =
    quota.resetAt ?? new Date(Date.now() + sharedQuotaCooldownFallbackSeconds * 1000).toISOString();
  const item: SharedQuotaCooldown = {
    active: true,
    resource: quota.resource,
    remaining: quota.remaining,
    limit: quota.limit,
    resetAt,
    reason,
  };
  const ttl = sharedQuotaCooldownTtlSeconds(resetAt);
  await Promise.all([
    env.DASHBOARD_CACHE.put(sharedQuotaBudgetKey(null), JSON.stringify(item), {
      expirationTtl: ttl,
    }),
    env.DASHBOARD_CACHE.put(sharedQuotaBudgetKey(quota.resource), JSON.stringify(item), {
      expirationTtl: ttl,
    }),
  ]);
}

async function sharedQuotaCooldown(
  env: Env,
  resource: string | null = null,
): Promise<SharedQuotaCooldown> {
  const empty: SharedQuotaCooldown = {
    active: false,
    resource: null,
    remaining: null,
    limit: null,
    resetAt: null,
    reason: null,
  };
  const keys = new Set(
    resource
      ? [sharedQuotaBudgetKey(resource), sharedQuotaBudgetKey(null)]
      : [sharedQuotaBudgetKey(null)],
  );
  if (!resource && env.DASHBOARD_CACHE?.list) {
    let cursor: string | undefined;
    do {
      const page = await env.DASHBOARD_CACHE.list({
        prefix: githubSharedBudgetPrefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const key of page.keys) keys.add(key.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  let selected: SharedQuotaCooldown | null = null;
  let selectedUntil = 0;
  for (const key of keys) {
    const raw = await env.DASHBOARD_CACHE?.get(key);
    if (!raw) continue;
    const parsed = tryJsonParse<SharedQuotaCooldown>(raw, `shared quota cooldown ${key}`);
    if (!parsed?.active) continue;
    const reset = parsed.resetAt ? Date.parse(parsed.resetAt) : 0;
    if (Number.isFinite(reset) && reset > 0 && reset <= Date.now()) {
      await env.DASHBOARD_CACHE?.delete?.(key).catch(() => undefined);
      continue;
    }
    const until = Date.parse(sharedQuotaDeferUntil(parsed));
    if (!selected || until > selectedUntil) {
      selected = parsed;
      selectedUntil = until;
    }
  }
  return selected ?? empty;
}

function sharedQuotaDeferUntil(cooldown: SharedQuotaCooldown): string {
  const reset = cooldown.resetAt ? Date.parse(cooldown.resetAt) : 0;
  const next = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 30 * 60 * 1000;
  return new Date(next).toISOString();
}

function githubGraphqlOperation(init?: RequestInit): string {
  if (typeof init?.body !== "string") return "unknown";
  const payload = tryJsonParse<{
    query?: unknown;
    variables?: { includeReleases?: unknown };
  }>(init.body, "GitHub GraphQL request");
  if (typeof payload?.query !== "string") return "unknown";
  const name = payload.query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!name) return "anonymous";
  if (name === "ReleaseBarOwnerRepos") {
    return payload.variables?.includeReleases
      ? githubGraphqlOwnerReleaseOperation
      : "ReleaseBarOwnerRepos.metadata";
  }
  return name;
}

function githubGraphqlAuditPath(operation: string): string {
  return `/graphql?operation=${encodeURIComponent(operation)}`;
}

function githubGraphqlBackoffKey(
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
): string {
  return `${githubGraphqlBackoffPrefix}${source}:${account ?? "_"}:${operation}`;
}

async function graphqlBackoffActive(
  env: Env | undefined,
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
): Promise<boolean> {
  return Boolean(
    await env?.DASHBOARD_CACHE?.get(githubGraphqlBackoffKey(source, account, operation)),
  );
}

async function markGraphqlBackoff(
  env: Env | undefined,
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
  status: number,
): Promise<void> {
  await env?.DASHBOARD_CACHE?.put(
    githubGraphqlBackoffKey(source, account, operation),
    JSON.stringify({
      active: true,
      status,
      source,
      account,
      operation,
      at: new Date().toISOString(),
    }),
    { expirationTtl: githubGraphqlBackoffSeconds },
  );
}

function githubGraphqlBackoffDeferUntil(): string {
  return new Date(Date.now() + githubGraphqlBackoffSeconds * 1000).toISOString();
}

async function recordGitHubAccessCounter(
  env: Env | undefined,
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
): Promise<void> {
  if (!env?.DASHBOARD_CACHE) return;
  const route = githubPathBucket(path);
  const routeKey = `${area}:${status}:${quota.source}:${quota.account ?? "_"}:${quota.resource ?? "_"}:${route}`;
  const key = githubAccessCounterKey(Math.floor(Math.random() * githubAccessShardCount));
  const raw = await env.DASHBOARD_CACHE.get(key);
  const current = raw ? tryJsonParse<StoredGitHubAccessShard>(raw, `github access ${key}`) : null;
  const routes = { ...current?.routes };
  const existing = routes[routeKey];
  const lastAt = new Date().toISOString();
  routes[routeKey] = {
    key: routeKey,
    area,
    route,
    status,
    source: quota.source,
    account: quota.account,
    resource: quota.resource,
    count: (existing?.count ?? 0) + 1,
    lastPath: path.slice(0, 240),
    lastAt,
  };
  await env.DASHBOARD_CACHE.put(
    key,
    JSON.stringify({
      count: (current?.count ?? 0) + 1,
      lastAt,
      routes,
    }),
    { expirationTtl: githubAccessTtlSeconds },
  );
  if (sharedQuotaPressure(status, quota, false)) {
    await markSharedQuotaCooldown(env, quota, sharedQuotaCooldownReason(status, quota, false));
  }
}

function sharedQuotaPressure(status: number, quota: ApiQuota, rateLimited = false): boolean {
  return (
    quota.source === "shared" &&
    ((quota.remaining !== null && quota.remaining <= sharedQuotaThreshold(quota.resource)) ||
      status === 429 ||
      rateLimited)
  );
}

function sharedQuotaCooldownReason(status: number, quota: ApiQuota, rateLimited = false): string {
  if (rateLimited) return `rate limited status ${status}`;
  if (quota.remaining !== null && quota.remaining <= sharedQuotaThreshold(quota.resource)) {
    return `remaining ${quota.remaining} <= ${sharedQuotaThreshold(quota.resource)}`;
  }
  return `status ${status}`;
}

async function recordAuditedGitHubAccess(
  env: Env | undefined,
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
  rateLimited = false,
  forceWait = false,
  context?: ExecutionContext,
): Promise<void> {
  auditGitHubTokenUse(area, path, status, quota);
  const write = () =>
    recordGitHubAccessCounter(env, area, path, status, quota)
      .then(() =>
        sharedQuotaPressure(status, quota, rateLimited)
          ? markSharedQuotaCooldown(
              env,
              quota,
              sharedQuotaCooldownReason(status, quota, rateLimited),
            )
          : undefined,
      )
      .catch(() => undefined);
  const mustWait = forceWait || sharedQuotaPressure(status, quota, rateLimited);
  if (context) {
    const previous = githubAccessWriteChains.get(context) ?? Promise.resolve();
    const chained = previous.then(write, write);
    githubAccessWriteChains.set(context, chained);
    if (mustWait) {
      await chained;
    } else {
      context.waitUntil(chained);
    }
  } else {
    await write();
  }
}

async function responseRateLimitSignal(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  const message = body && typeof body.message === "string" ? body.message : "";
  return isRateLimitResponse(response, message);
}

function auditGitHubFetch(
  area: GitHubAuditArea,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  env?: Env,
  context?: ExecutionContext,
  signal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const graphqlOperation =
      url.hostname === "api.github.com" && url.pathname === "/graphql"
        ? githubGraphqlOperation(init)
        : null;
    if (
      graphqlOperation &&
      (await graphqlBackoffActive(env, quotaSource, quotaAccount, graphqlOperation))
    ) {
      console.log(
        JSON.stringify({
          event: "github_graphql_backoff_skip",
          area,
          source: quotaSource,
          account: quotaAccount,
          operation: graphqlOperation,
        }),
      );
      const hardBackoff = quotaSource === "shared";
      return jsonResponse(
        { message: "GitHub GraphQL temporarily paused after upstream errors" },
        503,
        {
          "cache-control": "no-store",
          ...(hardBackoff ? { "x-releasebar-github-backoff": "graphql" } : {}),
        },
      );
    }
    const response = await workerFetch(input, signal ? { ...init, signal } : init);
    if (url.hostname === "api.github.com") {
      const path = graphqlOperation
        ? githubGraphqlAuditPath(graphqlOperation)
        : `${url.pathname}${url.search}`;
      const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
      const rateLimited =
        quota.source === "shared" ? await responseRateLimitSignal(response) : false;
      const isGraphqlServerError =
        url.pathname === "/graphql" && response.status >= 500 && response.status < 600;
      const shouldWaitAccess =
        sharedQuotaPressure(response.status, quota, rateLimited) ||
        (quotaSource === "shared" && isGraphqlServerError);
      const accessRecord = recordAuditedGitHubAccess(
        env,
        area,
        path,
        response.status,
        quota,
        rateLimited,
        shouldWaitAccess,
        context,
      );
      if (isGraphqlServerError) {
        const backoffWrite = markGraphqlBackoff(
          env,
          quotaSource,
          quotaAccount,
          graphqlOperation ?? "unknown",
          response.status,
        );
        if (quotaSource === "shared") {
          await Promise.all([accessRecord, backoffWrite.catch(() => undefined)]);
          return jsonResponse(
            { message: "GitHub GraphQL temporarily paused after upstream errors" },
            503,
            { "cache-control": "no-store", "x-releasebar-github-backoff": "graphql" },
          );
        }
        const durableBackoffWrite = backoffWrite.catch(() => undefined);
        if (context) {
          context.waitUntil(durableBackoffWrite);
        } else {
          await durableBackoffWrite;
        }
      }
      if (shouldWaitAccess || !context) await accessRecord;
    }
    return response;
  };
}

type TokenSources = {
  owners: string[];
  repos: string[];
};

type InitialPageData =
  | { route: "dashboard"; payload: DashboardPayload }
  | { route: "repo"; payload: RepoDetailPayload };

function shouldServeAppShell(url: URL): boolean {
  if (url.pathname.split("/").filter(Boolean)[0] === "-" && repoFullNameFromPath(url.pathname)) {
    return true;
  }
  if (url.pathname.endsWith("/")) return true;
  const leaf = url.pathname.split("/").pop() ?? "";
  return !leaf.includes(".");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function injectInitialPageData(html: string, data: InitialPageData | null): string {
  if (!data) return html;
  const script = `<script id="releasebar-initial-data" type="application/json">${escapeJsonForHtml(data)}</script>`;
  return html.includes('<script type="module"')
    ? html.replace('<script type="module"', `${script}<script type="module"`)
    : html.replace("</head>", `${script}</head>`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function signedJson(secret: string, value: unknown): Promise<string> {
  const payload = base64UrlJson(value);
  return `${payload}.${await hmac(secret, payload)}`;
}

async function verifySignedJson<T>(secret: string, token: string): Promise<T | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(signature, expected)) return null;
  return decodeBase64UrlJson<T>(payload);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function safeReturnTo(value: string | null, origin: string): string {
  if (!value || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function parseCookies(request: Request): Map<string, string> {
  return new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...parts] = cookie.split("=");
        return [name ?? "", parts.join("=")] as const;
      }),
  );
}

function authConfigured(env: Env): boolean {
  return Boolean(
    env.AUTH_COOKIE_SECRET &&
    env.DASHBOARD_CACHE &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET,
  );
}

function appSlug(env: Env): string {
  return env.GITHUB_APP_SLUG || "releasebar-app";
}

function cookie(name: string, value: string, maxAge = sessionMaxAgeSeconds): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function authCookie(value: string, maxAge = sessionMaxAgeSeconds): string {
  return cookie(sessionCookie, value, maxAge);
}

function installReturnCookieValue(value: string, maxAge = stateMaxAgeSeconds): string {
  return cookie(installReturnCookie, value, maxAge);
}

function oauthStateCookieName(nonce: string): string {
  return `${oauthStateCookiePrefix}${nonce}`;
}

async function oauthStateBinding(secret: string, nonce: string): Promise<string> {
  return hmac(secret, `oauth-state:${nonce}`);
}

function oauthStateCookieValue(nonce: string, value: string, maxAge = stateMaxAgeSeconds): string {
  return cookie(oauthStateCookieName(nonce), value, maxAge);
}

function authUrls(
  url: URL,
  env: Env,
): Pick<AuthPayload, "loginUrl" | "logoutUrl" | "installUrl" | "appUrl"> {
  return {
    loginUrl: `${url.origin}/api/auth/login`,
    logoutUrl: `${url.origin}/api/auth/logout`,
    installUrl: `${url.origin}/api/auth/install`,
    appUrl: `https://github.com/apps/${appSlug(env)}`,
  };
}

async function currentSession(request: Request, env: Env): Promise<StoredAuthSession | null> {
  const record = await currentSessionRecord(request, env);
  return record?.session ?? null;
}

async function currentSessionRecord(
  request: Request,
  env: Env,
): Promise<{ id: string | null; session: StoredAuthSession } | null> {
  if (!env.AUTH_COOKIE_SECRET) return null;
  const token = parseCookies(request).get(sessionCookie);
  if (!token) return null;
  const pointer = await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token);
  if (!pointer || pointer.exp < Math.floor(Date.now() / 1000)) return null;

  const stored = await env.DASHBOARD_CACHE?.get(`auth:session:${pointer.id}`);
  if (stored) {
    const session = safeJsonParse(storedAuthSessionSchema, stored, "auth session");
    if (!session) return null;
    return session.exp < Math.floor(Date.now() / 1000) ? null : { id: pointer.id, session };
  }

  const legacy = pointer as unknown as StoredAuthSession;
  return legacy.user && legacy.exp >= Math.floor(Date.now() / 1000)
    ? { id: null, session: legacy }
    : null;
}

function ownerListFromUrl(url: URL, primaryOwner?: string): string[] {
  const primary = primaryOwner ? slugOwner(primaryOwner) : null;
  return [
    ...new Set(
      (url.searchParams.get("owners") ?? "")
        .split(",")
        .map((value) => slugOwner(value))
        .filter((value) => validOwnerSlug(value) && value !== primary),
    ),
  ];
}

function repoListFromUrl(url: URL): string[] {
  return [
    ...new Set(
      (url.searchParams.get("repos") ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
  ];
}

function ownerCacheKey(login: string): string {
  return `${ownerCachePrefix}${slugOwner(login)}`;
}

function isCachedOwner(value: unknown): value is Owner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<Owner>;
  return (
    (owner.type === "user" || owner.type === "org") &&
    typeof owner.login === "string" &&
    validOwnerSlug(owner.login)
  );
}

async function readCachedOwner(env: Env, login: string): Promise<Owner | null> {
  const raw = await env.DASHBOARD_CACHE?.get(ownerCacheKey(login));
  if (!raw) return null;
  const parsed = tryJsonParse<Owner>(raw, `owner ${login}`);
  return isCachedOwner(parsed) ? parsed : null;
}

async function writeCachedOwner(env: Env, owner: Owner): Promise<void> {
  await env.DASHBOARD_CACHE?.put(ownerCacheKey(owner.login), JSON.stringify(owner), {
    expirationTtl: ownerCacheTtlSeconds,
  });
}

function repoFullNameFromPath(pathname: string): string | null {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const escaped = parts[0] === "-";
  if ((!escaped && parts.length !== 2) || (escaped && parts.length !== 3)) return null;
  const owner = slugOwner(escaped ? (parts[1] ?? "") : (parts[0] ?? ""));
  const repo = (escaped ? (parts[2] ?? "") : (parts[1] ?? "")).trim().toLowerCase();
  const fullName = `${owner}/${repo}`;
  return validRepoSlug(fullName) ? fullName : null;
}

function ownerFromPagePath(pathname: string): string | null {
  if (repoFullNameFromPath(pathname)) return null;
  const owner = slugOwner(pathname.split("/").filter(Boolean)[0] ?? "");
  return validOwnerSlug(owner) ? owner : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function dashboardSubtitle(owners: Owner[], repos: string[]): string {
  const sourceCount = owners.length + repos.length;
  if (sourceCount === 0) {
    return "Release freshness for public GitHub projects.";
  }
  if (sourceCount === 1 && owners[0]) {
    return `Release freshness for @${owners[0].login}.`;
  }
  return `Release freshness across ${sourceCount} public GitHub sources.`;
}

async function resolveOwners(
  ownerSlugs: string[],
  env: Env,
  token?: string | null,
  quotaSource: ApiQuota["source"] = token || env.GITHUB_TOKEN ? "shared" : "anonymous",
  quotaAccount: string | null = null,
  signal?: AbortSignal,
  context?: ExecutionContext,
): Promise<Owner[] | null> {
  const owners: Owner[] = [];
  for (const owner of ownerSlugs) {
    const cached = await readCachedOwner(env, owner);
    if (cached) {
      owners.push(cached);
      continue;
    }
    const resolved = await resolveOwnerType(owner, {
      fetch: auditGitHubFetch("dashboard", quotaSource, quotaAccount, env, context, signal),
      token: token ?? env.GITHUB_TOKEN,
    });
    if (!resolved) {
      return null;
    }
    const write = writeCachedOwner(env, resolved).catch(() => undefined);
    if (context) {
      context.waitUntil(write);
    } else {
      await write;
    }
    owners.push(resolved);
  }
  return owners;
}

async function initialPageData(
  request: Request,
  url: URL,
  env: Env,
): Promise<InitialPageData | null> {
  if (url.pathname === "/_admin") return null;
  const repo = repoFullNameFromPath(url.pathname);
  if (repo) return cachedRepoInitialData(env, repo);

  const primaryOwner = ownerFromPagePath(url.pathname);
  const custom =
    ownerListFromUrl(url, primaryOwner ?? undefined).length > 0 || repoListFromUrl(url).length > 0;
  if (primaryOwner || custom) {
    return cachedDashboardInitialData(request, env, url, primaryOwner);
  }
  if ((url.searchParams.get("period") ?? "").toLowerCase() === "releasebar") {
    return cachedHotInitialData(env);
  }
  return cachedDiscoverInitialData(env, url);
}

async function assetResponse(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const url = new URL(request.url);
  if (shouldServeAppShell(url)) {
    url.pathname = "/index.html";
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (!response.ok) {
      return response;
    }
    const originalUrl = new URL(request.url);
    const label = socialLabel(originalUrl);
    const title = socialPreviewTitle(label);
    const image = `${originalUrl.origin}/og/${encodeURIComponent(label)}.png`;
    const initialData = await initialPageData(request, originalUrl, env).catch(() => null);
    const html = injectInitialPageData(
      (await response.text())
        .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)} · release.bar</title>`)
        .replace(
          /<meta property="og:title" content="[^"]*" \/>/,
          `<meta property="og:title" content="${escapeHtml(title)}" />`,
        )
        .replace(
          /<meta property="og:url" content="[^"]*" \/>/,
          `<meta property="og:url" content="${escapeHtml(originalUrl.href)}" />`,
        )
        .replace(
          /<meta property="og:image" content="[^"]*" \/>/,
          `<meta property="og:image" content="${escapeHtml(image)}" />`,
        )
        .replace(
          /<meta name="twitter:title" content="[^"]*" \/>/,
          `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        )
        .replace(
          /<meta name="twitter:image" content="[^"]*" \/>/,
          `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
        ),
      initialData,
    );
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("content-type", "text/html; charset=utf-8");
    for (const [name, value] of Object.entries(authDependentAppShellHeaders(request, env))) {
      headers.set(name, value);
    }
    return new Response(html, {
      status: response.status,
      headers,
    });
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    return asset;
  }

  return asset;
}

function socialLabel(url: URL): string {
  if (url.pathname === "/_admin") return "ReleaseBar Admin";
  const repo = repoFullNameFromPath(url.pathname);
  if (repo) return repo;
  const owner = slugOwner(url.pathname.split("/").filter(Boolean)[0] ?? "");
  if (validOwnerSlug(owner)) {
    const extra = ownerListFromUrl(url, owner).length + repoListFromUrl(url).length;
    return extra > 0 ? `@${owner} +${extra}` : `@${owner}`;
  }
  const owners = ownerListFromUrl(url);
  const repos = repoListFromUrl(url);
  if (owners[0]) {
    const extra = owners.length - 1 + repos.length;
    return extra > 0 ? `@${owners[0]} +${extra}` : `@${owners[0]}`;
  }
  if (repos.length === 1) {
    return repos[0] ?? "custom deck";
  }
  return repos.length > 1 ? `custom deck +${repos.length}` : "ReleaseBar Hot";
}

function socialPreviewTitle(label: string): string {
  return `ReleaseBar release freshness dashboard for ${label}`;
}

type SocialCard = {
  title: string;
  avatarUrl: string | null;
  detail: string;
  metric: string;
};

const socialNumberFormat = new Intl.NumberFormat("en", { notation: "compact" });
const socialAvatarMaxBytes = 256 * 1024;
const socialAvatarTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const socialRendererWasmAsset = "/resvg.wasm";
const socialRendererFontAssets = [
  "/jetbrains-mono-latin-400-normal.woff2",
  "/jetbrains-mono-latin-700-normal.woff2",
] as const;
let socialRendererReady: Promise<Uint8Array[]> | null = null;

function ownerAvatarUrl(owner: string, size = 240): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;
}

function socialOwnerFromLabel(label: string): string | null {
  const repo = validRepoSlug(label) ? label.split("/")[0] : null;
  if (repo) return repo;
  const owner = label.match(/^@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)/i)?.[1];
  return owner ? slugOwner(owner) : null;
}

function socialRepoMetric(project: Project | null): string {
  if (!project) return "release freshness dashboard";
  const commits =
    project.commitsSinceRelease === null
      ? "commits n/a"
      : `${socialNumberFormat.format(project.commitsSinceRelease)} commits since release`;
  return `${project.version} · ${commits}`;
}

function socialLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function socialAvatarInitials(title: string): string {
  const normalized = title.replace(/^@/, "").replaceAll("/", " ").trim();
  const initials = normalized
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "RB";
}

async function socialAvatarDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await workerFetch(url, {
      headers: { "user-agent": "ReleaseBar" },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !socialAvatarTypes.has(contentType)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > socialAvatarMaxBytes) return null;
    return `data:${contentType};base64,${base64(bytes)}`;
  } catch {
    return null;
  }
}

function socialRepoCacheKey(owner: string, repo: string): string {
  return `${socialRepoCachePrefix}${slugOwner(owner)}/${repo.toLowerCase()}`;
}

function socialRepoAgeMs(entry: StoredSocialRepo | null): number {
  if (!entry) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(entry.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readSocialRepo(
  env: Env,
  owner: string,
  repo: string,
): Promise<StoredSocialRepo | null> {
  const raw = await env.DASHBOARD_CACHE?.get(socialRepoCacheKey(owner, repo));
  const parsed = raw ? tryJsonParse<StoredSocialRepo>(raw, `social repo ${owner}/${repo}`) : null;
  return parsed?.project?.fullName?.toLowerCase() === `${slugOwner(owner)}/${repo.toLowerCase()}`
    ? parsed
    : null;
}

async function writeSocialRepo(env: Env, project: Project): Promise<void> {
  await env.DASHBOARD_CACHE?.put(
    socialRepoCacheKey(project.owner, project.name),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      project,
    } satisfies StoredSocialRepo),
    { expirationTtl: dashboardStorageTtlSeconds },
  );
}

async function refreshSocialRepo(
  owner: string,
  repo: string,
  request: Request,
  env: Env,
): Promise<void> {
  const project = await buildSocialRepoProject(owner, repo, request, env);
  if (project) {
    await writeSocialRepo(env, project);
  }
}

async function buildSocialRepoProject(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<Project | null> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = (_quota: ApiQuota) => undefined;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository social card",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
    undefined,
    env,
  );
  if (repo.private) return null;
  const releases = await detailGitHubJson(
    `${path}/releases?per_page=5`,
    v.array(gitHubReleaseSchema),
    "repository social card releases",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
    undefined,
    env,
  );
  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        detailGitHubJson(
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "repository social card compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          "social-card",
          undefined,
          env,
        ),
        null,
      )
    : null;
  const project = releaseProject(repo);
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  return project;
}

async function socialRepoProject(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Project | null> {
  if (!validRepoSlug(label)) return null;
  const [owner, repo] = label.split("/");
  if (!owner || !repo) return null;
  const barrier = await repositoryPublicCacheBarrier(env, label);
  if (barrier === "blocked") return null;
  const key = repoDetailCacheKey(owner, repo);
  const cached = barrier === "clear" ? await readRepoDetail(env, key) : null;
  const allowRefresh = allowRequestRefresh(request);
  const ageMs = repoDetailAgeMs(cached);
  if (cached && ageMs > repoDetailCacheTtlMs && allowRefresh) {
    context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
  }
  if (cached && ageMs <= maxDisplayStaleMs) return cached.project;
  const social = barrier === "clear" ? await readSocialRepo(env, owner, repo) : null;
  const socialAgeMs = socialRepoAgeMs(social);
  if (social && socialAgeMs > repoDetailCacheTtlMs && allowRefresh) {
    context.waitUntil(refreshSocialRepo(owner, repo, request, env).catch(() => undefined));
  }
  if (social && socialAgeMs <= maxDisplayStaleMs) return social.project;
  try {
    const project = await buildSocialRepoProject(owner, repo, request, env);
    if (project) {
      await writeSocialRepo(env, project);
    }
    return project;
  } catch {
    return null;
  }
}

async function socialCardForLabel(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<SocialCard> {
  const project = await socialRepoProject(label, request, env, context);
  const owner = project?.owner ?? socialOwnerFromLabel(label);
  return {
    title: label,
    avatarUrl: owner ? ownerAvatarUrl(owner) : null,
    detail: project?.description ?? "Open source release freshness",
    metric: socialRepoMetric(project),
  };
}

async function socialSvg(card: SocialCard): Promise<string> {
  const title = escapeHtml(socialLine(card.title, 42));
  const detail = escapeHtml(socialLine(card.detail, 68));
  const metric = escapeHtml(socialLine(card.metric, 58));
  const avatar = await socialAvatarDataUrl(card.avatarUrl);
  const initials = escapeHtml(socialAvatarInitials(card.title));
  const titleSize =
    card.title.length > 34 ? 54 : card.title.length > 24 ? 66 : card.title.length > 17 ? 82 : 104;
  const titleX = card.avatarUrl ? 276 : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	  <defs>
	    <clipPath id="avatarClip"><rect x="96" y="198" width="148" height="148" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#080908"/>
  <path d="M0 124H1200M0 248H1200M0 372H1200M0 496H1200M160 0V630M400 0V630M640 0V630M880 0V630M1120 0V630" stroke="#182014" stroke-width="1"/>
	  <rect x="72" y="70" width="1056" height="490" rx="0" fill="none" stroke="#8cff4b" stroke-width="2"/>
	  <text x="96" y="148" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="38" letter-spacing="0">ReleaseBar</text>
	  ${
      card.avatarUrl
        ? `<rect x="96" y="198" width="148" height="148" rx="28" fill="#121b0f" stroke="#8cff4b" stroke-width="2"/>
	  ${
      avatar
        ? `<image x="96" y="198" width="148" height="148" href="${avatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
        : `<text x="170" y="289" text-anchor="middle" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="54" font-weight="700" letter-spacing="0">${initials}</text>`
    }`
        : ""
    }
  <text x="${titleX}" y="318" fill="#f2ffe9" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="${titleSize}" font-weight="700" letter-spacing="0">${title}</text>
  <text x="96" y="424" fill="#a8ff6b" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="34" font-weight="700" letter-spacing="0">${metric}</text>
  <text x="96" y="474" fill="#8f9b89" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="28" letter-spacing="0">${detail}</text>
  <text x="96" y="506" fill="#52604d" font-family="JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="24" letter-spacing="0">release.bar</text>
</svg>`;
}

async function socialImage(card: SocialCard): Promise<Response> {
  const svg = await socialSvg(card);
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

async function socialRendererBytes(request: Request, env: Env): Promise<Uint8Array[]> {
  if (!env.ASSETS) throw new Error("missing assets binding");
  if (socialRendererReady) return socialRendererReady;
  socialRendererReady = (async () => {
    const fetchAsset = async (pathname: string) => {
      const url = new URL(request.url);
      url.pathname = pathname;
      url.search = "";
      const response = await env.ASSETS!.fetch(new Request(url, request));
      if (!response.ok) throw new Error(`missing social renderer asset ${pathname}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);
    const wasm = isNode
      ? await fetchAsset(socialRendererWasmAsset)
      : (await import("@resvg/resvg-wasm/index_bg.wasm")).default;
    const fontBuffers = await Promise.all(socialRendererFontAssets.map(fetchAsset));
    await initWasm(wasm);
    return fontBuffers;
  })().catch((error) => {
    socialRendererReady = null;
    throw error;
  });
  return socialRendererReady;
}

async function socialPng(card: SocialCard, request: Request, env: Env): Promise<Response> {
  const fontBuffers = await socialRendererBytes(request, env);
  const svg = await socialSvg(card);
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      defaultFontFamily: "JetBrains Mono",
      monospaceFamily: "JetBrains Mono",
      fontBuffers,
    },
  });
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
    },
  });
}

function socialRouteLabel(pathname: string): { label: string; extension: string } {
  const raw = decodeURIComponent(pathname.replace(/^\/og\//, ""));
  const match = raw.match(/\.(svg|png)$/i);
  const label = match ? raw.slice(0, -match[0].length) : raw;
  return { label, extension: match?.[1]?.toLowerCase() ?? "svg" };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      ...corsHeaders,
      ...headers,
    },
  });
}

function openApiSpec(origin: string): Record<string, unknown> {
  const cacheState = {
    type: "object",
    required: ["state", "stale", "generatedAt"],
    properties: {
      state: { enum: ["fresh", "stale", "partial", "warming", "error"] },
      stale: { type: "boolean" },
      generatedAt: { type: "string", format: "date-time" },
      countsUpdatedAt: { type: ["string", "null"], format: "date-time" },
      projectCountsUpdatedAt: {
        type: "object",
        additionalProperties: { type: "string", format: "date-time" },
      },
      releasesUpdatedAt: { type: ["string", "null"], format: "date-time" },
      ciUpdatedAt: { type: ["string", "null"], format: "date-time" },
      message: { type: "string" },
      quota: {
        type: "object",
        properties: {
          source: { enum: ["app", "shared", "anonymous"] },
          account: { type: ["string", "null"] },
          remaining: { type: ["number", "null"] },
          limit: { type: ["number", "null"] },
          resetAt: { type: ["string", "null"], format: "date-time" },
          resource: { type: ["string", "null"] },
        },
      },
    },
  };
  const trustFactor = {
    type: "object",
    required: [
      "key",
      "label",
      "value",
      "maxValue",
      "weight",
      "weightedValue",
      "detail",
      "sentiment",
    ],
    properties: {
      key: { enum: ["age", "profile", "orgs", "reach", "builder", "recency", "risk"] },
      label: { type: "string" },
      value: { type: "number" },
      maxValue: { type: "number" },
      weight: { type: "number" },
      weightedValue: { type: "number" },
      detail: { type: "string" },
      sentiment: { enum: ["positive", "neutral", "negative"] },
    },
  };
  const trustDimensions = {
    type: "object",
    required: ["trust", "influence", "builder", "recency", "risk"],
    properties: {
      trust: { type: "number", minimum: 0, maximum: 100 },
      influence: { type: "number", minimum: 0, maximum: 100 },
      builder: { type: "number", minimum: 0, maximum: 100 },
      recency: { type: "number", minimum: 0, maximum: 100 },
      risk: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: "Account safety score. 100 means no obvious public-account risk signals.",
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "ReleaseBar Public API",
      version: "0.1.0",
      description:
        "Cached public GitHub release, people trust, org signal, and stargazer audience context for dashboards and PR-triage agents.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/users/{login}/trust": {
        get: {
          summary: "Get cached public people trust or org signal context for one GitHub profile",
          parameters: [{ name: "login", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "People trust or org signal profile",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/TrustProfile" } },
              },
            },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience": {
        get: {
          summary: "Get cached recent stargazer audience percentages and scored users",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
            { name: "range", in: "query", schema: { enum: ["week", "month"], default: "month" } },
          ],
          responses: {
            "200": {
              description: "Repository audience",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RepoAudience" } },
              },
            },
            "403": { description: "GitHub App quota required for cold audience builds" },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience/backfill": {
        post: {
          summary: "Warm week and month audience caches with GitHub App quota",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Backfill state",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RepoAudienceBackfill" },
                },
              },
            },
            "403": { description: "GitHub App quota required" },
          },
        },
      },
    },
    components: {
      schemas: {
        CacheState: cacheState,
        TrustDimensions: trustDimensions,
        TrustFactor: trustFactor,
        TrustProfile: {
          type: "object",
          required: [
            "login",
            "type",
            "profileKind",
            "scoreLabel",
            "score",
            "tier",
            "dimensions",
            "factors",
            "cache",
          ],
          properties: {
            login: { type: "string" },
            type: { enum: ["user", "org"] },
            profileKind: { enum: ["user_trust", "org_signal"] },
            scoreLabel: { enum: ["trust score", "org signal"] },
            score: { type: "number", minimum: 0, maximum: 100 },
            tier: { enum: ["high", "medium", "low", "bot"] },
            accountAgeDays: { type: ["number", "null"] },
            reasons: { type: "array", items: { type: "string" } },
            dimensions: { $ref: "#/components/schemas/TrustDimensions" },
            factors: { type: "array", items: { $ref: "#/components/schemas/TrustFactor" } },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudience: {
          type: "object",
          required: ["fullName", "range", "totals", "users", "cache"],
          properties: {
            fullName: { type: "string" },
            range: { enum: ["week", "month"] },
            totals: {
              type: "object",
              required: [
                "stargazers",
                "stargazersSampled",
                "highSignalPercent",
                "mediumSignalPercent",
                "lowSignalPercent",
                "botPercent",
              ],
              properties: {
                stargazers: { type: "number" },
                stargazersSampled: { type: "number" },
                highSignal: { type: "number" },
                mediumSignal: { type: "number" },
                lowSignal: { type: "number" },
                bots: { type: "number" },
                highSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                mediumSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                lowSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                botPercent: { type: "number", minimum: 0, maximum: 100 },
              },
            },
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  login: { type: "string" },
                  score: { type: "number" },
                  tier: { enum: ["high", "medium", "low", "bot"] },
                  trustScore: { type: "number" },
                  trustTier: { enum: ["high", "medium", "low", "bot"] },
                  dimensions: { $ref: "#/components/schemas/TrustDimensions" },
                },
              },
            },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudienceBackfill: {
          type: "object",
          required: ["fullName", "ranges", "quota", "message"],
          properties: {
            fullName: { type: "string" },
            ranges: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  range: { enum: ["week", "month"] },
                  state: { enum: ["busy", "fresh", "rebuilt"] },
                  users: { type: "number" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              },
            },
            quota: { type: "object" },
            message: { type: "string" },
          },
        },
      },
    },
  };
}

function redirectResponse(
  location: string,
  headers: Record<string, string | string[]> = {},
): Response {
  const responseHeaders = new Headers({
    location,
    "cache-control": "no-store",
  });
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
    } else {
      responseHeaders.set(key, value);
    }
  }
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

async function meResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const record = await currentSessionRecord(request, env);
  const session = record?.session ?? null;
  const liveInstallations = session
    ? await githubInstallations(session.accessToken).catch(() => null)
    : null;
  const acknowledgedInstallations = session
    ? fallbackInstallations(session, liveInstallations)
    : [];
  const installations = session
    ? await resolvedInstallations(env, session, liveInstallations, acknowledgedInstallations)
    : [];
  if (record && liveInstallations && liveInstallations.length > 0) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations,
      installationsUpdatedAt:
        acknowledgedInstallations.length > 0
          ? record.session.installationsUpdatedAt
          : new Date().toISOString(),
    });
  } else if (
    record &&
    installations.length > 0 &&
    JSON.stringify(record.session.installations ?? []) !== JSON.stringify(installations)
  ) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations,
      installationsUpdatedAt: new Date().toISOString(),
    });
  } else if (
    record &&
    liveInstallations &&
    installations.length === 0 &&
    (record.session.installations?.length ?? 0) > 0
  ) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations: [],
      installationsUpdatedAt: new Date().toISOString(),
    });
  }
  const coverage = session
    ? sourceCoverage(
        installations,
        currentReturnTo(url),
        url.origin,
        appTokenConfigured(env),
        session.user.login,
      )
    : { needed: false, reason: null };
  const body: AuthPayload = {
    configured: authConfigured(env),
    quotaConfigured: appTokenConfigured(env),
    user: session?.user ?? null,
    installations,
    installNeeded: Boolean(session && coverage.needed),
    installReason: session ? coverage.reason : null,
    ...authUrls(url, env),
  };
  return jsonResponse(body, 200, { "cache-control": "no-store" });
}

function currentReturnTo(url: URL): string {
  const value = url.searchParams.get("returnTo");
  return safeReturnTo(value, url.origin) || "/";
}

async function loginResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET || !env.GITHUB_APP_CLIENT_ID) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  const requestedReturnTo = safeReturnTo(url.searchParams.get("returnTo"), url.origin);
  // Keep the GitHub authorize request below common request-line limits.
  const returnTo = requestedReturnTo.length <= oauthReturnToMaxLength ? requestedReturnTo : "/";
  const nonce = randomNonce();
  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo,
    iat: Math.floor(Date.now() / 1000),
    nonce,
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
  github.searchParams.set("state", state);
  return redirectResponse(github.toString(), {
    "set-cookie": oauthStateCookieValue(
      nonce,
      await oauthStateBinding(env.AUTH_COOKIE_SECRET, nonce),
    ),
  });
}

async function exchangeCode(url: URL, env: Env): Promise<string> {
  const code = url.searchParams.get("code");
  if (!code) throw new Error("missing OAuth code");
  const response = await workerFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  const token = parseGitHubResponse(gitHubOAuthTokenSchema, await response.json(), "oauth token");
  if (!response.ok || !token.access_token) {
    throw new Error(token.error_description || token.error || "GitHub OAuth exchange failed");
  }
  return token.access_token;
}

async function githubUser(accessToken: string): Promise<AuthUser> {
  const response = await workerFetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }
  const user = parseGitHubResponse(gitHubOAuthUserSchema, await response.json(), "oauth user");
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    url: user.html_url,
  };
}

async function githubJson<TSchema extends GenericSchema>(
  accessToken: string,
  pathname: string,
  schema: TSchema,
  context: string,
  signal?: AbortSignal,
): Promise<InferOutput<TSchema>> {
  const response = await workerFetch(`https://api.github.com${pathname}`, {
    signal,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }
  return parseGitHubResponse(schema, await response.json(), context);
}

async function githubInstallations(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  const result = await githubJson(
    accessToken,
    "/user/installations?per_page=100",
    gitHubInstallationListSchema,
    "installation list",
    signal,
  );
  const installations = result.installations ?? [];
  return Promise.all(
    installations
      .filter((installation) => installation.account)
      .map(async (installation) => {
        const account = installation.account;
        if (!account) {
          throw new Error("missing installation account");
        }
        const repositories =
          installation.repository_selection === "selected"
            ? await githubInstallationRepositories(accessToken, installation.id, signal)
            : [];
        return {
          id: installation.id,
          accountLogin: account.login.toLowerCase(),
          accountType: account.type === "Organization" ? "org" : "user",
          accountUrl: account.html_url,
          avatarUrl: account.avatar_url,
          repositorySelection: installation.repository_selection,
          repositories,
        };
      }),
  );
}

async function githubAppInstallations(
  env: Env,
  accountFilter: string | null = null,
  strict = false,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  if (!appTokenConfigured(env)) {
    if (strict) throw new Error("GitHub App credentials are not configured");
    return [];
  }
  const jwt = await githubAppJwt(env);
  const normalizedAccountFilter = accountFilter ? slugOwner(accountFilter) : null;
  const installations: AuthInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      if (strict) throw new Error(`GitHub App installation list failed: ${response.status}`);
      break;
    }
    const result = parseGitHubResponse(
      v.array(gitHubInstallationSchema),
      await response.json(),
      "app installation list",
    );
    const batch = result;
    for (const installation of batch) {
      const account = installation.account;
      const accountLogin = account ? slugOwner(account.login) : "";
      if (!account || !validOwnerSlug(accountLogin)) continue;
      if (normalizedAccountFilter && accountLogin !== normalizedAccountFilter) continue;
      const repositories =
        installation.repository_selection === "selected"
          ? await githubAppInstallationRepositories(env, installation.id, strict, signal)
          : [];
      installations.push({
        id: installation.id,
        accountLogin,
        accountType: account.type === "Organization" ? "org" : "user",
        accountUrl: account.html_url,
        avatarUrl: account.avatar_url,
        repositorySelection: installation.repository_selection,
        repositories,
      });
    }
    if (batch.length < 100) break;
    if (strict && page === 10) {
      throw new Error("GitHub App installation list exceeded sync page limit");
    }
  }
  return installations;
}

async function githubAppInstallationsForSession(
  env: Env,
  session: StoredAuthSession,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  return githubAppInstallations(env, session.user.login, false, signal);
}

async function syncGithubAppInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  const installations = await githubAppInstallations(env, null, true);
  const freshAccounts = new Set(installations.map((installation) => installation.accountLogin));
  const existing = await listStoredInstallations(env);
  await Promise.all(
    existing
      .filter((installation) => !freshAccounts.has(installation.accountLogin))
      .map(async (installation) => {
        await env.DASHBOARD_CACHE?.delete?.(installationRegistryKey(installation.accountLogin));
        await recordAuthFunnelEvent(env, {
          event: "install_removed",
          account: installation.accountLogin,
          installationId: installation.id,
          repositorySelection: installation.repositorySelection,
          status: "sync_absent",
          detail: null,
        });
      }),
  );
  await writeInstallationRegistry(env, installations);
  await recordAuthFunnelEvent(env, {
    event: "install_sync",
    account: null,
    installationId: null,
    repositorySelection: null,
    status: "ok",
    detail: `installations=${installations.length}`,
  });
  return listStoredInstallations(env);
}

async function githubInstallationRepositories(
  accessToken: string,
  installationId: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(
      accessToken,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      gitHubInstallationRepositoryListSchema,
      "installation repositories",
      signal,
    );
    const batch = result.repositories ?? [];
    repositories.push(
      ...batch.filter(isPublicInstallationRepository).map((repo) => repo.full_name.toLowerCase()),
    );
    if (batch.length < 100) break;
  }
  return repositories;
}

function mergeInstallations(
  liveInstallations: AuthInstallation[],
  acknowledgedInstallations: AuthInstallation[] = [],
): AuthInstallation[] {
  const merged = new Map<number, AuthInstallation>();
  for (const installation of acknowledgedInstallations) {
    merged.set(installation.id, installation);
  }
  for (const installation of liveInstallations) {
    merged.set(installation.id, installation);
  }
  return [...merged.values()];
}

function fallbackInstallations(
  session: StoredAuthSession,
  liveInstallations: AuthInstallation[] | null,
): AuthInstallation[] {
  const acknowledged = session.installations ?? [];
  if (acknowledged.length === 0) return [];
  if (!liveInstallations) return acknowledged;
  const acknowledgedAt = Date.parse(session.installationsUpdatedAt ?? "");
  const recentlyAcknowledged =
    Number.isFinite(acknowledgedAt) &&
    Date.now() - acknowledgedAt <= installationAcknowledgementGraceMs;
  return recentlyAcknowledged
    ? acknowledged.filter(
        (installation) => !liveInstallations.some((live) => live.id === installation.id),
      )
    : [];
}

async function resolvedInstallations(
  env: Env,
  session: StoredAuthSession,
  liveInstallations: AuthInstallation[] | null,
  acknowledgedInstallations = fallbackInstallations(session, liveInstallations),
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  const appInstallations =
    liveInstallations &&
    liveInstallations.some(
      (installation) => installation.accountLogin === session.user.login.toLowerCase(),
    )
      ? []
      : ((await nullOnNonAbortError(githubAppInstallationsForSession(env, session, signal))) ?? []);
  const installations = mergeInstallations(liveInstallations ?? [], [
    ...acknowledgedInstallations,
    ...appInstallations,
  ]);
  await writeInstallationRegistry(env, installations);
  return installations;
}

function inferredInstallation(
  installationId: number,
  returnTo: string,
  origin: string,
  session: StoredAuthSession,
): AuthInstallation {
  const sources = returnToSources(returnTo, origin);
  const accounts = sourceAccounts(sources);
  const accountLogin = (accounts[0] ?? session.user.login).toLowerCase();
  return {
    id: installationId,
    accountLogin,
    accountType: accountLogin === session.user.login.toLowerCase() ? "user" : "org",
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: accountLogin === session.user.login.toLowerCase() ? session.user.avatarUrl : "",
    repositorySelection: "selected",
    repositories: sources.repos.filter((repo) => repo.split("/")[0] === accountLogin),
  };
}

async function githubAppInstallation(
  env: Env,
  installationId: number,
): Promise<AuthInstallation | null> {
  if (!appTokenConfigured(env)) return null;
  const jwt = await githubAppJwt(env);
  const response = await workerFetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return null;
  const installation = parseGitHubResponse(
    gitHubInstallationSchema,
    await response.json(),
    "app installation",
  );
  const account = installation.account;
  if (!account) return null;
  const repositories =
    installation.repository_selection === "selected"
      ? await githubAppInstallationRepositories(env, installationId)
      : [];
  return {
    id: installation.id,
    accountLogin: account.login.toLowerCase(),
    accountType: account.type === "Organization" ? "org" : "user",
    accountUrl: account.html_url,
    avatarUrl: account.avatar_url,
    repositorySelection: installation.repository_selection,
    repositories,
  };
}

async function githubAppInstallationForAccount(
  env: Env,
  accountLogin: string,
  signal?: AbortSignal,
): Promise<AuthInstallation | null> {
  if (!appTokenConfigured(env) || !env.DASHBOARD_CACHE) return null;
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  if (await env.DASHBOARD_CACHE.get(installationMissKey(account))) return null;
  const jwt = await githubAppJwt(env);
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub App installation discovery failed: ${response.status}`);
    }
    const result = parseGitHubResponse(
      v.array(gitHubInstallationSchema),
      await response.json(),
      "app installation list",
    );
    for (const installation of result) {
      const installationAccount = installation.account;
      if (!installationAccount || installationAccount.login.toLowerCase() !== account) continue;
      const repositories =
        installation.repository_selection === "selected"
          ? await githubAppInstallationRepositories(env, installation.id, false, signal)
          : [];
      const record: AuthInstallation = {
        id: installation.id,
        accountLogin: account,
        accountType: installationAccount.type === "Organization" ? "org" : "user",
        accountUrl: installationAccount.html_url,
        avatarUrl: installationAccount.avatar_url,
        repositorySelection: installation.repository_selection,
        repositories,
      };
      await writeInstallationRegistry(env, [record]);
      return record;
    }
    if (result.length < 100) break;
  }
  await Promise.all([
    env.DASHBOARD_CACHE.delete?.(installationRegistryKey(account)),
    env.DASHBOARD_CACHE.put(installationMissKey(account), new Date().toISOString(), {
      expirationTtl: 10 * 60,
    }),
  ]);
  return null;
}

async function githubAppInstallationRepositories(
  env: Env,
  installationId: number,
  strict = false,
  signal?: AbortSignal,
): Promise<string[]> {
  const token = await cachedInstallationToken(env, installationId, signal);
  if (!token) {
    if (strict) throw new Error(`GitHub App installation token unavailable: ${installationId}`);
    return [];
  }
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      if (strict) {
        throw new Error(`GitHub App installation repositories failed: ${response.status}`);
      }
      break;
    }
    const result = parseGitHubResponse(
      gitHubInstallationRepositoryListSchema,
      await response.json(),
      "app installation repositories",
    );
    const batch = result.repositories ?? [];
    repositories.push(
      ...batch.filter(isPublicInstallationRepository).map((repo) => repo.full_name.toLowerCase()),
    );
    if (batch.length < 100) break;
    if (strict && page === 10) {
      throw new Error("GitHub App installation repositories exceeded sync page limit");
    }
  }
  return repositories;
}

async function writeSessionRecord(
  env: Env,
  id: string | null,
  session: StoredAuthSession,
): Promise<void> {
  if (!id || !env.DASHBOARD_CACHE) return;
  const ttl = Math.max(1, session.exp - Math.floor(Date.now() / 1000));
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

async function acknowledgedInstallations(
  request: Request,
  env: Env,
  returnTo: string,
  installationId: number | null,
): Promise<AuthInstallation[]> {
  const record = await currentSessionRecord(request, env);
  const acknowledged: AuthInstallation[] = [];
  const appInstallation = installationId
    ? await githubAppInstallation(env, installationId).catch(() => null)
    : null;
  if (!record) {
    if (appInstallation) {
      await writeInstallationRegistry(env, [appInstallation]);
      return [appInstallation];
    }
    return [];
  }
  const liveInstallations = await githubInstallations(record.session.accessToken).catch(() => []);
  if (
    installationId &&
    !liveInstallations.some((installation) => installation.id === installationId)
  ) {
    acknowledged.push(
      appInstallation ??
        inferredInstallation(installationId, returnTo, new URL(request.url).origin, record.session),
    );
  }
  const installations = mergeInstallations(liveInstallations, [
    ...(record.session.installations ?? []),
    ...acknowledged,
  ]);
  await writeInstallationRegistry(env, installations);
  await writeSessionRecord(env, record.id, {
    ...record.session,
    installations,
    installationsUpdatedAt: new Date().toISOString(),
  });
  return installations;
}

function appTokenConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

async function dashboardReleaseDataAllowed(
  request: Request,
  env: Env,
  sources: TokenSources,
  token: RequestToken | null | undefined,
  options: { sourceAppCovered?: boolean } = {},
): Promise<boolean> {
  if (!appTokenConfigured(env) || token?.quotaSource === "app" || options.sourceAppCovered) {
    return true;
  }
  if (sourceAccounts(sources).length <= 1) return false;
  return Boolean(await currentSession(request, env));
}

function authDependentDashboardHeaders(env: Env): Record<string, string> {
  return appTokenConfigured(env) ? { "cache-control": "private, no-store", vary: "cookie" } : {};
}

function authDependentAppShellHeaders(request: Request, env: Env): Record<string, string> {
  return appTokenConfigured(env) && parseCookies(request).has(sessionCookie)
    ? { "cache-control": "private, no-store", vary: "cookie" }
    : { "cache-control": "public, max-age=300" };
}

function isAdminLogin(login: string): boolean {
  return login.toLowerCase() === "steipete";
}

async function requireAdmin(request: Request, env: Env): Promise<StoredAuthSession | Response> {
  const session = await currentSession(request, env);
  if (!session) {
    return jsonResponse({ error: "login required" }, 401, { "cache-control": "no-store" });
  }
  if (!isAdminLogin(session.user.login)) {
    return jsonResponse({ error: "admin required" }, 403, { "cache-control": "no-store" });
  }
  return session;
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(body.length), body);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pkcs1RsaToPkcs8(pkcs1: Uint8Array): ArrayBuffer {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryption = new Uint8Array([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  ]);
  const algorithm = der(0x30, concatBytes(rsaEncryption, new Uint8Array([0x05, 0x00])));
  const privateKey = der(0x04, pkcs1);
  return arrayBuffer(der(0x30, concatBytes(version, algorithm, privateKey)));
}

function pemToPkcs8ArrayBuffer(pem: string): ArrayBuffer {
  const normalized = normalizePrivateKey(pem);
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(normalized)) {
    throw new Error("Encrypted GitHub App private keys are not supported");
  }
  const isPkcs1Rsa = /BEGIN RSA PRIVATE KEY/.test(normalized);
  const base64 = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return isPkcs1Rsa ? pkcs1RsaToPkcs8(bytes) : arrayBuffer(bytes);
}

async function githubAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID,
  };
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8ArrayBuffer(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function githubInstallationToken(
  env: Env,
  installationId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const jwt = await githubAppJwt(env);
  const response = await workerFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "ReleaseBar",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const result = parseGitHubResponse(
    gitHubInstallationTokenSchema,
    await response.json(),
    "installation token",
  );
  if (!response.ok || !result.token) {
    console.log(
      JSON.stringify({
        event: "github_installation_token",
        installationId,
        status: response.status,
        ok: false,
      }),
    );
    throw new Error(result.message || `GitHub installation token failed: ${response.status}`);
  }
  console.log(
    JSON.stringify({
      event: "github_installation_token",
      installationId,
      status: response.status,
      ok: true,
    }),
  );
  return result.token;
}

function installationCoversSources(installation: AuthInstallation, sources: TokenSources): boolean {
  if (sources.owners.length > 0) {
    return (
      sources.owners.every((owner) => owner === installation.accountLogin) &&
      sources.repos.every((repo) => repo.split("/")[0] === installation.accountLogin) &&
      installation.repositorySelection === "all"
    );
  }

  if (sources.repos.length === 0) {
    return true;
  }

  return sources.repos.every((repo) => {
    const owner = repo.split("/")[0] ?? "";
    return (
      owner === installation.accountLogin &&
      (installation.repositorySelection === "all" || installation.repositories.includes(repo))
    );
  });
}

function matchingInstallation(
  installations: AuthInstallation[],
  sources: TokenSources,
): AuthInstallation | null {
  return (
    installations.find((installation) => installationCoversSources(installation, sources)) ?? null
  );
}

async function cachedInstallationToken(
  env: Env,
  installationId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const cacheKey = `auth:installation-token:${installationId}`;
  const cached = await env.DASHBOARD_CACHE?.get(cacheKey);
  if (cached) return cached;
  const token = await githubInstallationToken(env, installationId, signal);
  if (token) {
    await env.DASHBOARD_CACHE?.put(cacheKey, token, {
      expirationTtl: installationTokenTtlSeconds,
    });
  }
  return token;
}

async function sourceInstallationToken(
  env: Env,
  sources: TokenSources,
  options: { discover?: boolean; maxRegistryAgeMs?: number; signal?: AbortSignal } = {},
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const accounts = sourceAccounts(sources);
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  const registryInstallation = await readInstallationRegistry(env, account);
  let installation = registryInstallation;
  let registryStale = false;
  if (installation && options.maxRegistryAgeMs !== undefined) {
    const updatedAt = Date.parse(installation.updatedAt ?? "");
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > options.maxRegistryAgeMs) {
      registryStale = true;
      installation = null;
    }
  }
  if (!installation && options.discover !== false) {
    installation =
      (await nullOnNonAbortError(githubAppInstallationForAccount(env, account, options.signal))) ??
      null;
    if (
      !installation &&
      registryStale &&
      registryInstallation &&
      !(await env.DASHBOARD_CACHE?.get(installationMissKey(account)))
    ) {
      installation = registryInstallation;
    }
  }
  if (!installation || !installationCoversSources(installation, sources)) return null;
  const token = await cachedInstallationToken(env, installation.id, options.signal);
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation.accountLogin,
      }
    : null;
}

async function sourceInstallationRegistryCovers(env: Env, sources: TokenSources): Promise<boolean> {
  if (!appTokenConfigured(env)) return false;
  const accounts = sourceAccounts(sources);
  if (accounts.length !== 1) return false;
  const installation = await readInstallationRegistry(env, accounts[0]!);
  return Boolean(installation && installationCoversSources(installation, sources));
}

async function requestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
  signal?: AbortSignal,
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const session = await currentSession(request, env);
  if (!session) return null;
  const liveInstallations =
    (await nullOnNonAbortError(githubInstallations(session.accessToken, signal))) ?? null;
  const installations = await resolvedInstallations(
    env,
    session,
    liveInstallations,
    undefined,
    signal,
  );
  const installation = matchingInstallation(installations, sources);
  const token = installation ? await cachedInstallationToken(env, installation.id, signal) : null;
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation?.accountLogin ?? null,
      }
    : null;
}

async function bestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
  options: { discoverSourceInstallations?: boolean; signal?: AbortSignal } = {},
): Promise<RequestToken | null> {
  return (
    (await nullOnNonAbortError(
      sourceInstallationToken(env, sources, {
        discover: false,
        maxRegistryAgeMs: installationRegistryFastPathMaxAgeMs,
        signal: options.signal,
      }),
    )) ??
    (await nullOnNonAbortError(requestInstallationToken(request, env, sources, options.signal))) ??
    (options.discoverSourceInstallations === false
      ? null
      : await nullOnNonAbortError(
          sourceInstallationToken(env, sources, {
            discover: true,
            maxRegistryAgeMs: installationRegistryFastPathMaxAgeMs,
            signal: options.signal,
          }),
        ))
  );
}

async function nullOnNonAbortError<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

function sourceAccounts(sources: TokenSources): string[] {
  return [
    ...new Set([
      ...sources.owners,
      ...sources.repos.map((repo) => repo.split("/")[0] ?? "").filter(Boolean),
    ]),
  ];
}

function returnToSources(returnTo: string, origin: string): { owners: string[]; repos: string[] } {
  const url = new URL(returnTo, origin);
  const pathRepo = repoFullNameFromPath(url.pathname);
  if (pathRepo) {
    return {
      owners: ownerListFromUrl(url),
      repos: [...new Set([pathRepo, ...repoListFromUrl(url)])],
    };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const rawOwner = slugOwner(parts[0] ?? "");
  const primaryOwner = validOwnerSlug(rawOwner) ? rawOwner : null;
  return {
    owners: [
      ...new Set([
        ...(primaryOwner ? [primaryOwner] : []),
        ...ownerListFromUrl(url, primaryOwner ?? undefined),
      ]),
    ],
    repos: repoListFromUrl(url),
  };
}

function sourceCoverage(
  installations: AuthInstallation[],
  returnTo: string,
  origin: string,
  quotaConfigured: boolean,
  viewerLogin?: string,
): { needed: boolean; reason: string | null } {
  const sources = returnToSources(returnTo, origin);
  if (!quotaConfigured) {
    return {
      needed: false,
      reason: "Dedicated app quota is not configured on this deployment.",
    };
  }
  if (matchingInstallation(installations, sources)) {
    return { needed: false, reason: null };
  }
  if (sources.owners.length === 0 && sources.repos.length === 0) {
    return installations.length === 0
      ? { needed: true, reason: "Install the GitHub App for dedicated API quota." }
      : { needed: false, reason: null };
  }

  if (sourceAccounts(sources).length > 1) {
    return {
      needed: false,
      reason:
        "Mixed-account dashboards use shared API quota; use one installed account per dashboard for dedicated quota.",
    };
  }

  const uncoveredOwners = sources.owners.filter(
    (owner) =>
      !installations.some(
        (installation) =>
          installation.accountLogin === owner && installation.repositorySelection === "all",
      ),
  );
  const uncoveredRepos = sources.repos.filter(
    (repo) =>
      !installations.some((installation) => {
        const owner = repo.split("/")[0] ?? "";
        return (
          installation.accountLogin === owner &&
          (installation.repositorySelection === "all" || installation.repositories.includes(repo))
        );
      }),
  );

  if (uncoveredOwners.length > 0 || uncoveredRepos.length > 0) {
    const target = uncoveredOwners[0] ? `@${uncoveredOwners[0]}` : uncoveredRepos[0];
    const account = (uncoveredOwners[0] ?? uncoveredRepos[0]?.split("/")[0] ?? "").toLowerCase();
    if (uncoveredOwners.length === 0 && viewerLogin && account !== viewerLogin.toLowerCase()) {
      return {
        needed: false,
        reason: `This dashboard uses shared API quota unless ${target} installs the GitHub App.`,
      };
    }
    return {
      needed: true,
      reason: `Install the GitHub App for ${target} to use dedicated API quota.`,
    };
  }

  return { needed: false, reason: null };
}

async function storedSessionCookie(env: Env, session: StoredAuthSession): Promise<string> {
  if (!env.AUTH_COOKIE_SECRET) {
    throw new Error("missing auth cookie secret");
  }
  if (!env.DASHBOARD_CACHE) {
    throw new Error("missing auth session storage");
  }
  const id = randomNonce();
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(session), {
    expirationTtl: sessionMaxAgeSeconds,
  });
  const token = await signedJson(env.AUTH_COOKIE_SECRET, { id, exp: session.exp });
  return authCookie(token);
}

async function callbackResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  let validatedState = false;
  let stateCookieName: string | null = null;
  try {
    const stateToken = url.searchParams.get("state") ?? "";
    const state = await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, stateToken);
    const stateNow = Math.floor(Date.now() / 1000);
    if (
      !state ||
      typeof state.returnTo !== "string" ||
      typeof state.iat !== "number" ||
      typeof state.nonce !== "string" ||
      state.iat > stateNow ||
      stateNow - state.iat > stateMaxAgeSeconds
    ) {
      throw new Error("invalid OAuth state");
    }
    stateCookieName = oauthStateCookieName(state.nonce);
    const browserBinding = parseCookies(request).get(stateCookieName);
    const expectedBinding = await oauthStateBinding(env.AUTH_COOKIE_SECRET, state.nonce);
    if (!browserBinding || !timingSafeEqual(browserBinding, expectedBinding)) {
      throw new Error("invalid OAuth state");
    }
    validatedState = true;
    const accessToken = await exchangeCode(url, env);
    const user = await githubUser(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const session: StoredAuthSession = {
      user,
      accessToken,
      iat: now,
      exp: now + sessionMaxAgeSeconds,
    };
    const liveInstallations = await githubInstallations(accessToken).catch(() => null);
    const installations = await resolvedInstallations(env, session, liveInstallations);
    if (installations.length > 0) {
      session.installations = installations;
      session.installationsUpdatedAt = new Date().toISOString();
    }
    const sessionCookieValue = await storedSessionCookie(env, session);
    const coverage = sourceCoverage(
      installations,
      state.returnTo,
      url.origin,
      appTokenConfigured(env),
      user.login,
    );
    await recordAuthFunnelEvent(env, {
      event: "login_success",
      account: user.login,
      installationId: null,
      repositorySelection: null,
      status: installations.length > 0 ? "installed" : "no_install",
      detail: `installations=${installations.length}`,
    });
    if (coverage.needed) {
      const installReturn = await signedJson(env.AUTH_COOKIE_SECRET, {
        returnTo: state.returnTo,
        iat: Math.floor(Date.now() / 1000),
        nonce: randomNonce(),
      });
      return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`, {
        "set-cookie": [
          sessionCookieValue,
          installReturnCookieValue(installReturn),
          oauthStateCookieValue(state.nonce, "", 0),
        ],
      });
    }
    return redirectResponse(state.returnTo, {
      "set-cookie": [sessionCookieValue, oauthStateCookieValue(state.nonce, "", 0)],
    });
  } catch (error) {
    if (validatedState) {
      await recordAuthFunnelEvent(env, {
        event: "login_failed",
        account: null,
        installationId: null,
        repositorySelection: null,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, {
      "cache-control": "no-store",
      ...(stateCookieName ? { "set-cookie": cookie(stateCookieName, "", 0) } : {}),
    });
  }
}

async function logoutResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.AUTH_COOKIE_SECRET) {
    const token = parseCookies(request).get(sessionCookie);
    const session = token
      ? await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token)
      : null;
    if (session?.id) {
      await env.DASHBOARD_CACHE?.delete?.(`auth:session:${session.id}`);
    }
  }
  return redirectResponse(safeReturnTo(url.searchParams.get("returnTo"), url.origin), {
    "set-cookie": authCookie("", 0),
  });
}

async function installResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.AUTH_COOKIE_SECRET) {
    return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`);
  }

  if (url.searchParams.has("installation_id") || url.searchParams.has("setup_action")) {
    const token = parseCookies(request).get(installReturnCookie);
    const state = token ? await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, token) : null;
    const stateIsFresh =
      state !== null && Math.floor(Date.now() / 1000) - state.iat <= stateMaxAgeSeconds;
    const returnTo = stateIsFresh ? state.returnTo : "/";
    const installationId = Number(url.searchParams.get("installation_id"));
    const validInstallationId = Number.isFinite(installationId) ? installationId : null;
    const canVerifyCallback = stateIsFresh || !(await authInstallCallbackRateLimited(request, env));
    const appInstallation =
      validInstallationId && canVerifyCallback
        ? await githubAppInstallation(env, validInstallationId).catch(() => null)
        : null;
    if (stateIsFresh || appInstallation) {
      await recordAuthFunnelEvent(env, {
        event: "install_callback",
        account: appInstallation?.accountLogin ?? null,
        installationId: validInstallationId,
        repositorySelection: appInstallation?.repositorySelection ?? null,
        status: stateIsFresh ? "fresh_state" : state ? "stale_state" : "missing_state",
        detail: returnTo,
      });
    }
    if (appInstallation) {
      await writeInstallationRegistry(env, [appInstallation]);
      await recordAuthFunnelEvent(env, {
        event: "install_recorded",
        account: appInstallation.accountLogin,
        installationId: appInstallation.id,
        repositorySelection: appInstallation.repositorySelection,
        status: stateIsFresh ? "fresh_state" : "server_verified",
        detail:
          appInstallation.repositorySelection === "selected"
            ? `repos=${appInstallation.repositories.length}`
            : "repos=all",
      });
    }
    if (stateIsFresh) {
      await acknowledgedInstallations(request, env, returnTo, validInstallationId);
    }
    return redirectResponse(returnTo, {
      "set-cookie": installReturnCookieValue("", 0),
    });
  }

  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo: safeReturnTo(url.searchParams.get("returnTo"), url.origin),
    iat: Math.floor(Date.now() / 1000),
    nonce: randomNonce(),
  });
  return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`, {
    "set-cookie": installReturnCookieValue(state),
  });
}

async function authResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") return loginResponse(request, env);
  if (url.pathname === "/api/auth/callback") return callbackResponse(request, env);
  if (url.pathname === "/api/auth/logout") return logoutResponse(request, env);
  if (url.pathname === "/api/auth/install") {
    return installResponse(request, env);
  }
  return jsonResponse({ error: "not found" }, 404);
}

function withCacheState(
  payload: DashboardPayload,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message?: string,
): DashboardPayload {
  const cacheMessage = message ?? payload.cache?.message;
  return {
    ...payload,
    cache: {
      state,
      stale: state !== "fresh",
      capped: payload.cache?.capped ?? false,
      repoLimit: payload.cache ? payload.cache.repoLimit : repoLimit,
      generatedAt: payload.generatedAt,
      countsUpdatedAt: payload.cache?.countsUpdatedAt ?? null,
      projectCountsUpdatedAt: payload.cache?.projectCountsUpdatedAt ?? {},
      releasesUpdatedAt: payload.cache?.releasesUpdatedAt ?? null,
      ciUpdatedAt: payload.cache?.ciUpdatedAt ?? null,
      ...(payload.cache?.quota ? { quota: payload.cache.quota } : {}),
      ...(payload.cache?.progress ? { progress: payload.cache.progress } : {}),
      ...(cacheMessage ? { message: cacheMessage } : {}),
    },
  };
}

function quotaForDashboard(dashboard: DashboardRequest, env: Env): ApiQuota {
  return {
    source: dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
    account: dashboard.quotaAccount ?? null,
    remaining: null,
    limit: null,
    resetAt: null,
    resource: null,
  };
}

function optionsFromUrl(url: URL) {
  return {
    includeForks: url.searchParams.get("forks") === "true",
    includeArchived: url.searchParams.get("archived") === "true",
    includeUnreleased: url.searchParams.get("unreleased") !== "false",
  };
}

function hydrationOptionsFromUrl(
  url: URL,
): Pick<DashboardRequest, "hydrateSort" | "hydrateDirection"> {
  const sort = url.searchParams.get("sort");
  return {
    hydrateSort: sort === "issues" || sort === "prs" ? sort : null,
    hydrateDirection: url.searchParams.get("dir") === "asc" ? "asc" : "desc",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitHubRateLimit(error: unknown): boolean {
  if (error instanceof GitHubRateLimitError) return true;
  return /rate limit|secondary rate|api rate limit exceeded|shared api quota|quota .*exhausted/i.test(
    errorMessage(error),
  );
}

function retryAfterSeconds(error: unknown): number | null {
  return error instanceof GitHubRateLimitError ? error.retryAfterSeconds : null;
}

function retryAfterHeaders(error: unknown): Record<string, string> {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? { "cache-control": "no-store" }
    : { "cache-control": "no-store", "retry-after": String(seconds) };
}

function dashboardErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub shared API quota is exhausted. Connect GitHub and install the app for this account to use dedicated quota, or try again after the shared quota resets.";
  }

  const message = errorMessage(error);
  const githubMatch = message.match(/^GitHub API (\d+) for ([^:]+):/);
  if (githubMatch) {
    return `GitHub API ${githubMatch[1]} while loading ${githubMatch[2]}.`;
  }
  return message;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorStatus(error: unknown): number {
  const message = errorMessage(error);
  const githubStatus = message.match(/^GitHub API (\d+)/)?.[1];
  if (githubStatus === "404") return 404;
  return isGitHubRateLimit(error) ? 429 : 502;
}

function ownerMetadataKey(owner: string): string {
  return `${ownerMetadataPrefix}${slugOwner(owner)}`;
}

function dashboardWithVisibleProjects(payload: DashboardPayload): DashboardPayload {
  if (payload.options?.includeArchived) return payload;
  const projects = payload.projects.filter((project) => !project.archived);
  if (projects.length === payload.projects.length) return payload;
  return {
    ...payload,
    totals: dashboardTotals(projects),
    projects,
  };
}

async function readCachedRaw(env: Env, key: string): Promise<DashboardPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`) : null;
}

async function readCached(env: Env, key: string): Promise<DashboardPayload | null> {
  const payload = await readCachedRaw(env, key);
  return payload ? dashboardWithVisibleProjects(payload) : null;
}

function cacheAgeMs(payload: DashboardPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function canDisplayCached(payload: DashboardPayload | null): payload is DashboardPayload {
  return cacheAgeMs(payload) <= maxDisplayStaleMs;
}

function canDisplayOwnerMetadata(snapshot: OwnerMetadataSnapshot): boolean {
  return Date.now() - safeIso(snapshot.metadataUpdatedAt) <= maxDisplayStaleMs;
}

function canDisplayOwnerProjectMetadata(
  snapshot: OwnerMetadataSnapshot,
  fullName: string,
): boolean {
  return (
    Date.now() - safeIso(snapshot.projectMetadataUpdatedAt[fullName.toLowerCase()]) <=
    maxDisplayStaleMs
  );
}

function canDisplayOwnerProjectCounts(snapshot: OwnerMetadataSnapshot, fullName: string): boolean {
  return (
    Date.now() - safeIso(snapshot.projectCountsUpdatedAt[fullName.toLowerCase()]) <=
    maxDisplayStaleMs
  );
}

function canDisplayOwnerCounts(snapshot: OwnerMetadataSnapshot): boolean {
  return Date.now() - safeIso(snapshot.countsUpdatedAt) <= maxDisplayStaleMs;
}

async function manualRefreshCooldownKey(key: string): Promise<string> {
  return `${manualRefreshCooldownPrefix}${(await sha256Base64Url(key)).slice(0, 32)}`;
}

async function manualRefreshCooldownActive(env: Env, key: string): Promise<boolean> {
  return Boolean(await env.DASHBOARD_CACHE?.get(await manualRefreshCooldownKey(key)));
}

async function markManualRefreshCooldown(env: Env, key: string): Promise<void> {
  await env.DASHBOARD_CACHE?.put(await manualRefreshCooldownKey(key), new Date().toISOString(), {
    expirationTtl: manualRefreshCooldownSeconds,
  });
}

function profileKey(owner: string): string {
  return `profile:v1:${slugOwner(owner)}`;
}

function profileSnapshotStorageKey(profile: DashboardProfile): string {
  return `${refreshProfileSnapshotPrefix}${slugOwner(profile.owner)}:${encodeURIComponent(profile.updatedAt)}`;
}

async function readProfile(env: Env, owner: string): Promise<DashboardProfile | null> {
  const raw = await env.DASHBOARD_CACHE?.get(profileKey(owner));
  if (!raw) return null;
  const parsed = tryJsonParse<DashboardProfile>(raw, `profile ${owner}`);
  return parsed?.owner === slugOwner(owner) ? parsed : null;
}

async function readProfileSnapshot(env: Env, key: string): Promise<DashboardProfile | null> {
  if (!key.startsWith(refreshProfileSnapshotPrefix)) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  if (!raw) return null;
  const parsed = tryJsonParse<DashboardProfile>(raw, `profile snapshot ${key}`);
  return parsed?.owner ? parsed : null;
}

async function ensureProfileSnapshot(env: Env, profile: DashboardProfile): Promise<string> {
  const key = profileSnapshotStorageKey(profile);
  if (!(await env.DASHBOARD_CACHE?.get(key))) {
    await env.DASHBOARD_CACHE?.put(key, JSON.stringify(profile), {
      expirationTtl: dashboardStorageTtlSeconds,
    });
  }
  return key;
}

async function writeProfile(env: Env, profile: DashboardProfile): Promise<void> {
  await Promise.all([
    env.DASHBOARD_CACHE?.put(profileKey(profile.owner), JSON.stringify(profile)),
    env.DASHBOARD_CACHE?.put(profileSnapshotStorageKey(profile), JSON.stringify(profile), {
      expirationTtl: dashboardStorageTtlSeconds,
    }),
  ]);
}

async function deleteProfile(env: Env, owner: string): Promise<void> {
  await env.DASHBOARD_CACHE?.delete?.(profileKey(owner));
}

async function writeCached(
  env: Env,
  key: string,
  payload: DashboardPayload,
  ttlSeconds = dashboardStorageTtlSeconds,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
}

function normalizeOwnerObservationMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && safeIso(entry[1]) > 0,
      )
      .map(([repo, observedAt]) => [repo.toLowerCase(), observedAt]),
  );
}

function isOwnerRepoCount(value: unknown): value is OwnerRepoCount {
  const count = value as OwnerRepoCount | null;
  return Boolean(
    count &&
    validRepoSlug(count.fullName.toLowerCase()) &&
    Number.isFinite(count.openIssues) &&
    Number.isFinite(count.openPullRequests) &&
    typeof count.archived === "boolean" &&
    typeof count.fork === "boolean" &&
    typeof count.private === "boolean",
  );
}

function normalizeOwnerCountOverlays(
  value: unknown,
  projects: Project[],
  projectCountsUpdatedAt: Record<string, string>,
): Record<string, OwnerRepoCount> {
  const overlays =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([fullName, count]) =>
            isOwnerRepoCount(count)
              ? [[fullName.toLowerCase(), { ...count, fullName: count.fullName.toLowerCase() }]]
              : [],
          ),
        )
      : {};
  for (const project of projects) {
    const fullName = project.fullName.toLowerCase();
    if (
      overlays[fullName] ||
      !projectCountsUpdatedAt[fullName] ||
      project.openIssues === null ||
      project.openPullRequests === null
    ) {
      continue;
    }
    overlays[fullName] = {
      fullName,
      openIssues: project.openIssues,
      openPullRequests: project.openPullRequests,
      archived: project.archived,
      fork: project.fork === true,
      private: false,
      pushedAt: project.pushedAt,
      updatedAt: project.updatedAt,
    };
  }
  return overlays;
}

function normalizeOwnerMetadataSnapshot(
  owner: string,
  value: unknown,
): OwnerMetadataSnapshot | null {
  const snapshot = value as OwnerMetadataSnapshot | null;
  if (snapshot?.owner !== slugOwner(owner) || !Array.isArray(snapshot.projects)) return null;
  const hasMetadataClocks =
    snapshot.projectMetadataUpdatedAt &&
    typeof snapshot.projectMetadataUpdatedAt === "object" &&
    !Array.isArray(snapshot.projectMetadataUpdatedAt);
  const hasCountClocks =
    snapshot.projectCountsUpdatedAt &&
    typeof snapshot.projectCountsUpdatedAt === "object" &&
    !Array.isArray(snapshot.projectCountsUpdatedAt);
  const projectCountsUpdatedAt = hasCountClocks
    ? normalizeOwnerObservationMap(snapshot.projectCountsUpdatedAt)
    : Object.fromEntries(
        snapshot.countsUpdatedAt
          ? snapshot.projects.map((project) => [
              project.fullName.toLowerCase(),
              snapshot.countsUpdatedAt!,
            ])
          : [],
      );
  return {
    ...snapshot,
    countsAttemptedAt: snapshot.countsAttemptedAt ?? snapshot.countsUpdatedAt ?? null,
    releaseDataComplete: snapshot.releaseDataComplete === true,
    knownRepos: Array.isArray(snapshot.knownRepos)
      ? snapshot.knownRepos.map((repo) => repo.toLowerCase())
      : null,
    privateRepos: normalizeOwnerObservationMap(snapshot.privateRepos),
    removedRepos: normalizeOwnerObservationMap(snapshot.removedRepos),
    projectMetadataUpdatedAt: hasMetadataClocks
      ? normalizeOwnerObservationMap(snapshot.projectMetadataUpdatedAt)
      : Object.fromEntries(
          snapshot.projects.map((project) => [
            project.fullName.toLowerCase(),
            snapshot.metadataUpdatedAt,
          ]),
        ),
    projectCountsUpdatedAt,
    countOverlays: normalizeOwnerCountOverlays(
      snapshot.countOverlays,
      snapshot.projects,
      projectCountsUpdatedAt,
    ),
  };
}

function newestOwnerTimestamp(...values: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  for (const value of values) {
    if (value && safeIso(value) >= safeIso(newest)) newest = value;
  }
  return newest;
}

function ownerSnapshotIsNewer(
  candidate: OwnerMetadataSnapshot,
  current: OwnerMetadataSnapshot,
): boolean {
  for (const field of ["countsUpdatedAt", "metadataUpdatedAt", "generatedAt"] as const) {
    const candidateTime = safeIso(candidate[field]);
    const currentTime = safeIso(current[field]);
    if (candidateTime !== currentTime) return candidateTime > currentTime;
  }
  return true;
}

function reconcileOwnerMetadataSnapshots(
  owner: string,
  storedValue: unknown,
  cachedValue: unknown,
  durablePrivacy = false,
): OwnerMetadataSnapshot | null {
  const stored = normalizeOwnerMetadataSnapshot(owner, storedValue);
  const cached = normalizeOwnerMetadataSnapshot(owner, cachedValue);
  const snapshots = [stored, cached].filter(
    (snapshot): snapshot is OwnerMetadataSnapshot => snapshot !== null,
  );
  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) return snapshots[0]!;

  const authority = snapshots.reduce((current, candidate) =>
    ownerSnapshotIsNewer(candidate, current) ? candidate : current,
  );
  const names = new Set<string>();
  for (const snapshot of [authority, ...snapshots]) {
    for (const project of snapshot.projects) names.add(project.fullName.toLowerCase());
    for (const name of snapshot.knownRepos ?? []) names.add(name);
    for (const name of Object.keys(snapshot.privateRepos)) names.add(name);
    for (const name of Object.keys(snapshot.removedRepos)) names.add(name);
    for (const name of Object.keys(snapshot.projectMetadataUpdatedAt)) names.add(name);
    for (const name of Object.keys(snapshot.projectCountsUpdatedAt)) names.add(name);
    for (const name of Object.keys(snapshot.countOverlays)) names.add(name);
  }

  const privateRepos =
    durablePrivacy && stored
      ? { ...stored.privateRepos }
      : Object.fromEntries(
          [...names].flatMap((fullName) => {
            const privatizedAt = newestOwnerTimestamp(
              ...snapshots.map((snapshot) => snapshot.privateRepos[fullName]),
            );
            return privatizedAt ? [[fullName, privatizedAt]] : [];
          }),
        );
  const removedRepos: Record<string, string> = {};
  const projectMetadataUpdatedAt: Record<string, string> = {};
  const projectCountsUpdatedAt: Record<string, string> = {};
  const countOverlays: Record<string, OwnerRepoCount> = {};
  const projects: Project[] = [];
  const authoritativeRepos = authority.knownRepos === null ? null : new Set(authority.knownRepos);

  for (const fullName of names) {
    const privatizedAt = privateRepos[fullName];
    const removedAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.removedRepos[fullName]),
    );
    const metadataAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.projectMetadataUpdatedAt[fullName]),
    );
    const countsAt = newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.projectCountsUpdatedAt[fullName]),
    );
    if (metadataAt) projectMetadataUpdatedAt[fullName] = metadataAt;
    if (countsAt) projectCountsUpdatedAt[fullName] = countsAt;
    const countOverlay = snapshots
      .map((snapshot) => ({
        count: snapshot.countOverlays[fullName],
        observedAt: snapshot.projectCountsUpdatedAt[fullName],
      }))
      .filter((candidate): candidate is { count: OwnerRepoCount; observedAt: string } =>
        Boolean(candidate.count && candidate.observedAt),
      )
      .sort((left, right) => safeIso(right.observedAt) - safeIso(left.observedAt))[0];
    if (countOverlay) countOverlays[fullName] = countOverlay.count;
    if (privatizedAt) {
      removedRepos[fullName] = newestOwnerTimestamp(privatizedAt, removedAt)!;
      continue;
    }

    let metadataSource: { project: Project; observedAt: string | null } | null = null;
    let countSource: { project: Project; observedAt: string | null } | null = null;
    for (const snapshot of snapshots) {
      const project = snapshot.projects.find(
        (candidate) => candidate.fullName.toLowerCase() === fullName,
      );
      if (!project) continue;
      const projectMetadataAt =
        snapshot.projectMetadataUpdatedAt[fullName] ?? snapshot.metadataUpdatedAt;
      if (!metadataSource || safeIso(projectMetadataAt) >= safeIso(metadataSource.observedAt)) {
        metadataSource = { project, observedAt: projectMetadataAt };
      }
      const projectCountsAt = snapshot.projectCountsUpdatedAt[fullName] ?? snapshot.countsUpdatedAt;
      if (!countSource || safeIso(projectCountsAt) >= safeIso(countSource.observedAt)) {
        countSource = { project, observedAt: projectCountsAt };
      }
    }

    const publicMetadataAt = metadataSource?.observedAt ?? null;
    if (removedAt && safeIso(removedAt) >= safeIso(publicMetadataAt)) {
      removedRepos[fullName] = removedAt;
      continue;
    }
    if (!metadataSource) continue;
    if (
      authoritativeRepos &&
      !authoritativeRepos.has(fullName) &&
      safeIso(publicMetadataAt) <= safeIso(authority.countsUpdatedAt)
    ) {
      continue;
    }

    let project = metadataSource.project;
    if (countSource) {
      project =
        safeIso(countSource.observedAt) > safeIso(publicMetadataAt)
          ? mergeProjectCountFields(project, countSource.project)
          : mergeProjectIssuePullCounts(project, countSource.project);
    }
    projects.push(project);
  }

  const knownRepos =
    authority.knownRepos === null
      ? null
      : [
          ...new Set([
            ...authority.knownRepos,
            ...projects
              .filter(
                (project) =>
                  safeIso(projectMetadataUpdatedAt[project.fullName.toLowerCase()]) >
                  safeIso(authority.countsUpdatedAt),
              )
              .map((project) => project.fullName.toLowerCase()),
          ]),
        ].filter((fullName) => !removedRepos[fullName]);

  return {
    owner,
    generatedAt: newestOwnerTimestamp(...snapshots.map((snapshot) => snapshot.generatedAt))!,
    metadataUpdatedAt: newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.metadataUpdatedAt),
    )!,
    countsUpdatedAt: newestOwnerTimestamp(...snapshots.map((snapshot) => snapshot.countsUpdatedAt)),
    countsAttemptedAt: newestOwnerTimestamp(
      ...snapshots.map((snapshot) => snapshot.countsAttemptedAt),
    ),
    releaseDataComplete: snapshots.some((snapshot) => snapshot.releaseDataComplete),
    knownRepos,
    privateRepos,
    removedRepos,
    projectMetadataUpdatedAt,
    projectCountsUpdatedAt,
    countOverlays,
    projects,
  };
}

async function readOwnerMetadataKv(env: Env, owner: string): Promise<OwnerMetadataSnapshot | null> {
  const raw = await env.DASHBOARD_CACHE?.get(ownerMetadataKey(owner));
  if (!raw) return null;
  return normalizeOwnerMetadataSnapshot(
    owner,
    tryJsonParse<OwnerMetadataSnapshot>(raw, `owner metadata ${owner}`),
  );
}

async function readDurableOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const normalizedOwner = slugOwner(owner);
  if (!env.DASHBOARD_LOCKS) return readOwnerMetadataKv(env, normalizedOwner);
  const id = env.DASHBOARD_LOCKS.idFromName(`owner-metadata:${normalizedOwner}`);
  const response = await env.DASHBOARD_LOCKS.get(id).fetch(
    new Request("https://releasebar.internal/owner-metadata/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: normalizedOwner }),
    }),
  );
  if (response.status === 404 || response.status === 409) {
    return readOwnerMetadataKv(env, normalizedOwner);
  }
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`owner metadata read returned ${response.status}`);
  }
  return normalizeOwnerMetadataSnapshot(normalizedOwner, await response.json());
}

async function readOwnerMetadata(env: Env, owner: string): Promise<OwnerMetadataSnapshot | null> {
  return readOwnerMetadataKv(env, owner);
}

type PublicCacheBarrier = "clear" | "blocked" | "unknown";

async function repositoryPublicCacheBarrier(
  env: Env,
  fullName: string,
): Promise<PublicCacheBarrier> {
  const normalized = fullName.toLowerCase();
  const owner = normalized.split("/")[0];
  if (!owner) return "blocked";
  try {
    const snapshot = await readDurableOwnerMetadata(env, owner);
    return snapshot?.removedRepos[normalized] || snapshot?.privateRepos[normalized]
      ? "blocked"
      : "clear";
  } catch {
    return "unknown";
  }
}

async function privateRepositoryNames(env: Env, fullNames: string[]): Promise<Set<string> | null> {
  const normalized = [...new Set(fullNames.map((fullName) => fullName.toLowerCase()))];
  const owners = [
    ...new Set(
      normalized
        .map((fullName) => fullName.split("/")[0] ?? "")
        .filter((owner) => validOwnerSlug(owner)),
    ),
  ];
  try {
    const snapshots = await mapConcurrent(
      owners,
      8,
      async (owner) => [owner, await readDurableOwnerMetadata(env, owner)] as const,
    );
    const byOwner = new Map(snapshots);
    return new Set(
      normalized.filter((fullName) => {
        const owner = fullName.split("/")[0] ?? "";
        return Boolean(byOwner.get(owner)?.privateRepos[fullName]);
      }),
    );
  } catch {
    return null;
  }
}

async function writeOwnerMetadata(env: Env, snapshot: OwnerMetadataSnapshot): Promise<void> {
  await env.DASHBOARD_CACHE?.put(ownerMetadataKey(snapshot.owner), JSON.stringify(snapshot), {
    expirationTtl: ownerMetadataTtlSeconds,
  });
}

function mergeProjectMetadata(project: Project, metadata: Project): Project {
  return {
    ...project,
    owner: metadata.owner,
    name: metadata.name,
    fullName: metadata.fullName,
    description: metadata.description,
    url: metadata.url,
    defaultBranch: metadata.defaultBranch,
    language: metadata.language,
    topics: metadata.topics,
    stars: metadata.stars,
    forks: metadata.forks,
    issuesUrl: metadata.issuesUrl,
    pullRequestsUrl: metadata.pullRequestsUrl,
    archived: metadata.archived,
    fork: metadata.fork,
    pushedAt: metadata.pushedAt,
    updatedAt: metadata.updatedAt,
  };
}

function projectWithoutReleaseData(project: Project): Project {
  return {
    ...project,
    openIssues: null,
    openPullRequests: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `${project.url}/releases`,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  };
}

function mergeProjectCountFields(project: Project, counts: Project | OwnerRepoCount): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
    archived: counts.archived,
    fork: counts.fork,
    pushedAt: counts.pushedAt,
    updatedAt: counts.updatedAt,
  };
}

function mergeProjectIssuePullCounts(project: Project, counts: Project | OwnerRepoCount): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
  };
}

function ownerSnapshotWithCounts(
  snapshot: OwnerMetadataSnapshot,
  counts: OwnerRepoCount[],
  updatedAt: string,
  complete: boolean,
): OwnerMetadataSnapshot {
  if (safeIso(updatedAt) < safeIso(snapshot.countsAttemptedAt)) {
    return snapshot;
  }
  const byName = new Map(counts.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const publicNames = new Set(
    counts.filter((repo) => !repo.private).map((repo) => repo.fullName.toLowerCase()),
  );
  const privateNames = counts
    .filter((repo) => repo.private)
    .map((repo) => repo.fullName.toLowerCase());
  const newerMetadataNames = new Set(
    Object.entries(snapshot.projectMetadataUpdatedAt)
      .filter(([, metadataUpdatedAt]) => safeIso(metadataUpdatedAt) > safeIso(updatedAt))
      .map(([fullName]) => fullName),
  );
  const removedRepos = { ...snapshot.removedRepos };
  const projectCountsUpdatedAt = { ...snapshot.projectCountsUpdatedAt };
  const countOverlays = { ...snapshot.countOverlays };
  for (const fullName of publicNames) {
    if (snapshot.privateRepos[fullName]) continue;
    if (safeIso(updatedAt) > safeIso(removedRepos[fullName])) {
      delete removedRepos[fullName];
    }
  }
  for (const fullName of privateNames) {
    if (newerMetadataNames.has(fullName)) continue;
    if (safeIso(updatedAt) >= safeIso(removedRepos[fullName])) {
      removedRepos[fullName] = updatedAt;
    }
    delete countOverlays[fullName];
  }
  if (complete) {
    for (const fullName of Object.keys(countOverlays)) {
      if (!publicNames.has(fullName) && !newerMetadataNames.has(fullName)) {
        delete countOverlays[fullName];
      }
    }
  }
  for (const count of counts) {
    const fullName = count.fullName.toLowerCase();
    if (count.private || newerMetadataNames.has(fullName)) continue;
    countOverlays[fullName] = { ...count, fullName };
    if (safeIso(updatedAt) >= safeIso(projectCountsUpdatedAt[fullName])) {
      projectCountsUpdatedAt[fullName] = updatedAt;
    }
  }
  return {
    ...snapshot,
    countsUpdatedAt: complete ? updatedAt : snapshot.countsUpdatedAt,
    countsAttemptedAt: updatedAt,
    knownRepos: complete
      ? [
          ...new Set([
            ...publicNames,
            ...(snapshot.knownRepos ?? []).filter((fullName) => newerMetadataNames.has(fullName)),
            ...snapshot.projects
              .map((project) => project.fullName.toLowerCase())
              .filter((fullName) => newerMetadataNames.has(fullName)),
          ]),
        ]
      : (snapshot.knownRepos ?? null),
    removedRepos,
    countOverlays,
    projects: snapshot.projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      if (snapshot.privateRepos[fullName]) return [];
      const count = byName.get(fullName);
      const preserveNewerMetadata = newerMetadataNames.has(fullName);
      if (!count) return complete && !preserveNewerMetadata ? [] : [project];
      if (count.private) return preserveNewerMetadata ? [project] : [];
      return [
        {
          ...project,
          openIssues: count.openIssues,
          openPullRequests: count.openPullRequests,
          archived: preserveNewerMetadata ? project.archived : count.archived,
          fork: preserveNewerMetadata ? project.fork : count.fork,
          pushedAt: preserveNewerMetadata ? project.pushedAt : count.pushedAt,
          updatedAt: preserveNewerMetadata ? project.updatedAt : count.updatedAt,
        },
      ];
    }),
    projectCountsUpdatedAt,
  };
}

function applyOwnerMetadataMutation(
  owner: string,
  existing: OwnerMetadataSnapshot | null,
  mutation: OwnerMetadataMutation,
): OwnerMetadataSnapshot | null {
  if (mutation.kind === "counts") {
    return existing
      ? ownerSnapshotWithCounts(existing, mutation.counts, mutation.updatedAt, mutation.complete)
      : null;
  }

  if (mutation.kind === "visibility") {
    if (!existing) return null;
    const latestObservation = Math.max(
      safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]),
      safeIso(existing.projectCountsUpdatedAt[mutation.fullName]),
      safeIso(existing.removedRepos[mutation.fullName]),
    );
    if (safeIso(mutation.observedAt) < latestObservation) {
      return existing;
    }
    return {
      ...existing,
      generatedAt:
        safeIso(existing.generatedAt) > safeIso(mutation.observedAt)
          ? existing.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing.metadataUpdatedAt
          : mutation.observedAt,
      projectMetadataUpdatedAt: {
        ...existing.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
      countOverlays: existing.countOverlays[mutation.fullName]
        ? {
            ...existing.countOverlays,
            [mutation.fullName]: {
              ...existing.countOverlays[mutation.fullName]!,
              archived: mutation.archived,
              updatedAt:
                safeIso(mutation.repositoryUpdatedAt) >=
                safeIso(existing.countOverlays[mutation.fullName]!.updatedAt)
                  ? mutation.repositoryUpdatedAt
                  : existing.countOverlays[mutation.fullName]!.updatedAt,
            },
          }
        : existing.countOverlays,
      projects: existing.projects.map((project) =>
        project.fullName.toLowerCase() === mutation.fullName &&
        safeIso(mutation.observedAt) >=
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName])
          ? {
              ...project,
              archived: mutation.archived,
              updatedAt:
                safeIso(mutation.repositoryUpdatedAt) >= safeIso(project.updatedAt)
                  ? (mutation.repositoryUpdatedAt ?? project.updatedAt)
                  : project.updatedAt,
            }
          : project,
      ),
    };
  }

  if (mutation.kind === "remove") {
    const project = existing?.projects.find(
      (candidate) => candidate.fullName.toLowerCase() === mutation.fullName,
    );
    const latestRepositoryObservation = Math.max(
      safeIso(existing?.projectMetadataUpdatedAt?.[mutation.fullName]),
      safeIso(existing?.removedRepos?.[mutation.fullName]),
      safeIso(project?.updatedAt),
    );
    if (safeIso(mutation.observedAt) < latestRepositoryObservation) {
      return existing;
    }
    return {
      owner,
      generatedAt:
        safeIso(existing?.generatedAt) > safeIso(mutation.observedAt)
          ? existing!.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing?.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing!.metadataUpdatedAt
          : mutation.observedAt,
      countsUpdatedAt: existing?.countsUpdatedAt ?? null,
      countsAttemptedAt: existing?.countsAttemptedAt ?? null,
      releaseDataComplete: existing?.releaseDataComplete === true,
      knownRepos: existing?.knownRepos?.filter((repo) => repo !== mutation.fullName) ?? null,
      privateRepos: {
        ...existing?.privateRepos,
        [mutation.fullName]:
          safeIso(existing?.privateRepos?.[mutation.fullName]) > safeIso(mutation.observedAt)
            ? existing!.privateRepos[mutation.fullName]!
            : mutation.observedAt,
      },
      removedRepos: {
        ...existing?.removedRepos,
        [mutation.fullName]:
          safeIso(existing?.removedRepos?.[mutation.fullName]) > safeIso(mutation.observedAt)
            ? existing!.removedRepos[mutation.fullName]!
            : mutation.observedAt,
      },
      projectMetadataUpdatedAt: {
        ...existing?.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing?.projectMetadataUpdatedAt?.[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing!.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
      projectCountsUpdatedAt: {
        ...existing?.projectCountsUpdatedAt,
      },
      countOverlays: Object.fromEntries(
        Object.entries(existing?.countOverlays ?? {}).filter(
          ([fullName]) => fullName !== mutation.fullName,
        ),
      ),
      projects: (existing?.projects ?? []).filter(
        (project) => project.fullName.toLowerCase() !== mutation.fullName,
      ),
    };
  }

  if (mutation.kind === "restore") {
    if (!existing) return null;
    const removedRepos = { ...existing.removedRepos };
    const privateRepos = { ...existing.privateRepos };
    const accepted = safeIso(mutation.observedAt) >= safeIso(privateRepos[mutation.fullName]);
    if (accepted) {
      delete privateRepos[mutation.fullName];
      delete removedRepos[mutation.fullName];
    }
    return {
      ...existing,
      generatedAt:
        safeIso(existing.generatedAt) > safeIso(mutation.observedAt)
          ? existing.generatedAt
          : mutation.observedAt,
      metadataUpdatedAt:
        safeIso(existing.metadataUpdatedAt) > safeIso(mutation.observedAt)
          ? existing.metadataUpdatedAt
          : mutation.observedAt,
      knownRepos:
        accepted && existing.knownRepos
          ? [...new Set([...existing.knownRepos, mutation.fullName])]
          : existing.knownRepos,
      privateRepos,
      removedRepos,
      projectMetadataUpdatedAt: {
        ...existing.projectMetadataUpdatedAt,
        [mutation.fullName]:
          safeIso(existing.projectMetadataUpdatedAt[mutation.fullName]) >
          safeIso(mutation.observedAt)
            ? existing.projectMetadataUpdatedAt[mutation.fullName]!
            : mutation.observedAt,
      },
    };
  }

  const projects = new Map(
    (existing?.projects ?? []).map((project) => [project.fullName.toLowerCase(), project]),
  );
  const projectMetadataUpdatedAt = { ...existing?.projectMetadataUpdatedAt };
  const projectCountsUpdatedAt = { ...existing?.projectCountsUpdatedAt };
  const countOverlays = { ...existing?.countOverlays };
  const privateRepos = { ...existing?.privateRepos };
  const removedRepos = { ...existing?.removedRepos };
  const incomingNames = new Set(mutation.projects.map((project) => project.fullName.toLowerCase()));
  const removedNames = new Set(mutation.removedRepos);
  const acceptedRemovedNames = new Set<string>();
  const coversExistingProjects = (existing?.projects ?? []).every(
    (project) =>
      incomingNames.has(project.fullName.toLowerCase()) ||
      removedNames.has(project.fullName.toLowerCase()),
  );
  const incomingCountsUpdatedAt =
    mutation.countsComplete &&
    coversExistingProjects &&
    mutation.projects.every(
      (project) => project.openIssues !== null && project.openPullRequests !== null,
    )
      ? mutation.countsUpdatedAt
      : (existing?.countsUpdatedAt ?? null);
  for (const fullName of mutation.removedRepos) {
    if (
      safeIso(mutation.observedAt) >= safeIso(projectMetadataUpdatedAt[fullName]) &&
      fullName.startsWith(`${owner}/`)
    ) {
      projects.delete(fullName);
      delete countOverlays[fullName];
      projectMetadataUpdatedAt[fullName] = mutation.observedAt;
      removedRepos[fullName] = mutation.observedAt;
      acceptedRemovedNames.add(fullName);
    }
  }
  for (const project of mutation.projects) {
    const fullName = project.fullName.toLowerCase();
    if (privateRepos[fullName]) {
      projects.delete(fullName);
      delete countOverlays[fullName];
      continue;
    }
    if (safeIso(mutation.observedAt) <= safeIso(removedRepos[fullName])) {
      continue;
    }
    if (
      existing?.knownRepos &&
      !existing.knownRepos.includes(fullName) &&
      safeIso(existing.countsUpdatedAt) > safeIso(mutation.observedAt)
    ) {
      continue;
    }
    const current = projects.get(fullName);
    const incomingMetadataIsNewer =
      safeIso(mutation.observedAt) >= safeIso(projectMetadataUpdatedAt[fullName]);
    const incomingHasCounts =
      project.openIssues !== null &&
      project.openPullRequests !== null &&
      Boolean(mutation.countsUpdatedAt);
    const incomingProjectCountsAreNewer =
      incomingHasCounts &&
      safeIso(mutation.countsUpdatedAt) > safeIso(projectCountsUpdatedAt[fullName]);
    const preserveCurrentCounts =
      Boolean(current) &&
      (!incomingHasCounts ||
        safeIso(projectCountsUpdatedAt[fullName]) >= safeIso(mutation.countsUpdatedAt));
    if (safeIso(mutation.observedAt) > safeIso(removedRepos[fullName])) {
      delete removedRepos[fullName];
    }
    let merged = project;
    if (current && mutation.mode === "metadata" && incomingMetadataIsNewer) {
      merged = mergeProjectMetadata(current, project);
    } else if (current && !incomingMetadataIsNewer) {
      merged = incomingProjectCountsAreNewer ? mergeProjectCountFields(current, project) : current;
    }
    if (current && preserveCurrentCounts) {
      merged = mergeProjectIssuePullCounts(merged, current);
    }
    projects.set(fullName, merged);
    if (incomingMetadataIsNewer) {
      projectMetadataUpdatedAt[fullName] = mutation.observedAt;
    }
    if (
      incomingHasCounts &&
      !preserveCurrentCounts &&
      safeIso(mutation.countsUpdatedAt) >= safeIso(projectCountsUpdatedAt[fullName])
    ) {
      projectCountsUpdatedAt[fullName] = mutation.countsUpdatedAt!;
      countOverlays[fullName] = {
        fullName,
        openIssues: project.openIssues!,
        openPullRequests: project.openPullRequests!,
        archived: project.archived,
        fork: project.fork === true,
        private: false,
        pushedAt: project.pushedAt,
        updatedAt: project.updatedAt,
      };
    }
  }
  return {
    owner,
    generatedAt:
      safeIso(existing?.generatedAt) > safeIso(mutation.generatedAt)
        ? existing!.generatedAt
        : mutation.generatedAt,
    metadataUpdatedAt:
      safeIso(existing?.metadataUpdatedAt) > safeIso(mutation.observedAt)
        ? existing!.metadataUpdatedAt
        : mutation.observedAt,
    countsUpdatedAt:
      safeIso(existing?.countsUpdatedAt) > safeIso(incomingCountsUpdatedAt)
        ? existing!.countsUpdatedAt
        : incomingCountsUpdatedAt,
    countsAttemptedAt: newestOwnerTimestamp(existing?.countsAttemptedAt, mutation.countsUpdatedAt),
    releaseDataComplete: existing?.releaseDataComplete === true || mutation.releaseDataComplete,
    knownRepos:
      existing?.knownRepos?.filter((fullName) => !acceptedRemovedNames.has(fullName)) ?? null,
    privateRepos,
    removedRepos,
    projectMetadataUpdatedAt,
    projectCountsUpdatedAt,
    countOverlays,
    projects: [...projects.values()],
  };
}

function isOwnerMetadataMutation(value: unknown): value is OwnerMetadataMutation {
  const mutation = value as OwnerMetadataMutation | null;
  if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string") return false;
  if (mutation.kind === "merge") {
    return (
      typeof mutation.generatedAt === "string" &&
      typeof mutation.observedAt === "string" &&
      (mutation.countsUpdatedAt === null || typeof mutation.countsUpdatedAt === "string") &&
      typeof mutation.countsComplete === "boolean" &&
      typeof mutation.releaseDataComplete === "boolean" &&
      (mutation.mode === "metadata" || mutation.mode === "hydrated") &&
      Array.isArray(mutation.projects) &&
      Array.isArray(mutation.removedRepos)
    );
  }
  if (mutation.kind === "counts") {
    return (
      typeof mutation.updatedAt === "string" &&
      typeof mutation.complete === "boolean" &&
      Array.isArray(mutation.counts)
    );
  }
  return (
    (mutation.kind === "visibility" &&
      typeof mutation.fullName === "string" &&
      typeof mutation.archived === "boolean" &&
      typeof mutation.observedAt === "string" &&
      (mutation.repositoryUpdatedAt === null ||
        typeof mutation.repositoryUpdatedAt === "string")) ||
    ((mutation.kind === "remove" || mutation.kind === "restore") &&
      typeof mutation.fullName === "string" &&
      typeof mutation.observedAt === "string")
  );
}

async function mutateOwnerMetadataSnapshot(
  env: Env,
  owner: string,
  mutation: OwnerMetadataMutation,
): Promise<OwnerMetadataSnapshot | null> {
  const normalizedOwner = slugOwner(owner);
  const requireDurablePrivacy = mutation.kind === "remove" || mutation.kind === "restore";
  if (env.DASHBOARD_LOCKS) {
    try {
      const id = env.DASHBOARD_LOCKS.idFromName(`owner-metadata:${normalizedOwner}`);
      const response = await env.DASHBOARD_LOCKS.get(id).fetch(
        new Request("https://releasebar.internal/owner-metadata/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: normalizedOwner, mutation }),
        }),
      );
      if (response.status === 204) return null;
      if (response.ok) return (await response.json()) as OwnerMetadataSnapshot;
      if (requireDurablePrivacy) {
        throw new Error(`owner metadata mutation returned ${response.status}`);
      }
    } catch (error) {
      if (requireDurablePrivacy) throw error;
      // KV fallback keeps preview and degraded Durable Object paths operational.
    }
  }
  const existing = await readOwnerMetadataKv(env, normalizedOwner);
  const updated = applyOwnerMetadataMutation(normalizedOwner, existing, mutation);
  if (updated) await writeOwnerMetadata(env, updated);
  return updated;
}

async function mergeOwnerMetadata(
  env: Env,
  payload: DashboardPayload,
  observedAt = payload.generatedAt,
): Promise<DashboardPayload> {
  const owners = [
    ...new Set([
      ...payload.owners.map((owner) => slugOwner(owner.login)),
      ...payload.projects.map((project) => slugOwner(project.owner)),
    ]),
  ];
  if (owners.length === 0) return dashboardWithVisibleProjects(payload);
  const snapshots = (
    await Promise.all(owners.map((owner) => readDurableOwnerMetadata(env, owner)))
  ).filter((snapshot): snapshot is OwnerMetadataSnapshot => Boolean(snapshot));
  if (snapshots.length === 0) return dashboardWithVisibleProjects(payload);
  const snapshotByOwner = new Map(snapshots.map((snapshot) => [snapshot.owner, snapshot]));
  const payloadObservedAt = safeIso(observedAt);
  const payloadProjectCountClocks = payload.cache?.projectCountsUpdatedAt ?? {};
  const payloadCountClock = (fullName: string) =>
    safeIso(
      payloadProjectCountClocks[fullName] ??
        (owners.length === 1 ? payload.cache?.countsUpdatedAt : observedAt),
    );
  const payloadOwnerCountClock = (owner: string) => {
    const ownerProjects = payload.projects.filter((project) => slugOwner(project.owner) === owner);
    const clocks = ownerProjects.map(
      (project) => payloadProjectCountClocks[project.fullName.toLowerCase()],
    );
    if (clocks.length > 0 && clocks.every(Boolean)) {
      return Math.min(...clocks.map((clock) => safeIso(clock)));
    }
    return safeIso(owners.length === 1 ? payload.cache?.countsUpdatedAt : observedAt);
  };
  const countSnapshotNewer = (snapshot: OwnerMetadataSnapshot) =>
    canDisplayOwnerCounts(snapshot) &&
    safeIso(snapshot.countsUpdatedAt) > payloadOwnerCountClock(snapshot.owner);
  const metadataByRepo = new Map(
    snapshots.flatMap((snapshot) =>
      canDisplayOwnerMetadata(snapshot)
        ? snapshot.projects.flatMap((project) => {
            const fullName = project.fullName.toLowerCase();
            return canDisplayOwnerProjectMetadata(snapshot, fullName) &&
              safeIso(snapshot.projectMetadataUpdatedAt[fullName]) > payloadObservedAt
              ? [[fullName, project] as const]
              : [];
          })
        : [],
    ),
  );
  const countsByRepo = new Map(
    snapshots.flatMap((snapshot) =>
      Object.entries(snapshot.countOverlays).flatMap(([fullName, count]) => {
        return canDisplayOwnerProjectCounts(snapshot, fullName) &&
          safeIso(snapshot.projectCountsUpdatedAt[fullName]) > payloadCountClock(fullName) &&
          !count.private
          ? [[fullName, count] as const]
          : [];
      }),
    ),
  );
  const projects = payload.projects.flatMap((project) => {
    const snapshot = snapshotByOwner.get(slugOwner(project.owner));
    if (snapshot?.removedRepos[project.fullName.toLowerCase()]) {
      return [];
    }
    if (
      snapshot &&
      countSnapshotNewer(snapshot) &&
      snapshot.knownRepos &&
      !snapshot.knownRepos.includes(project.fullName.toLowerCase())
    ) {
      return [];
    }
    const metadata = metadataByRepo.get(project.fullName.toLowerCase());
    const counts = countsByRepo.get(project.fullName.toLowerCase());
    const merged = metadata ? mergeProjectMetadata(project, metadata) : project;
    if (!counts) return [merged];
    const fullName = project.fullName.toLowerCase();
    const metadataClock = metadata
      ? safeIso(snapshot?.projectMetadataUpdatedAt[fullName])
      : payloadObservedAt;
    const countClock = safeIso(snapshot?.projectCountsUpdatedAt[fullName]);
    return [
      countClock >= metadataClock
        ? mergeProjectCountFields(merged, counts)
        : mergeProjectIssuePullCounts(merged, counts),
    ];
  });
  const countsUpdatedAt =
    owners.every((owner) => {
      const snapshot = snapshotByOwner.get(owner);
      return snapshot?.countsUpdatedAt && countSnapshotNewer(snapshot);
    }) && projects.every((project) => countsByRepo.has(project.fullName.toLowerCase()))
      ? snapshots
          .map((snapshot) => snapshot.countsUpdatedAt)
          .filter((value): value is string => Boolean(value))
          .sort()[0]
      : (payload.cache?.countsUpdatedAt ?? null);
  const projectCountsUpdatedAt = Object.fromEntries(
    projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      const snapshot = countsByRepo.get(fullName);
      const updatedAt = snapshot
        ? snapshotByOwner.get(slugOwner(project.owner))?.projectCountsUpdatedAt[fullName]
        : payloadProjectCountClocks[fullName];
      return updatedAt ? [[fullName, updatedAt]] : [];
    }),
  );
  return dashboardWithVisibleProjects({
    ...payload,
    cache: payload.cache
      ? {
          ...payload.cache,
          countsUpdatedAt: countsUpdatedAt ?? payload.cache.countsUpdatedAt ?? null,
          projectCountsUpdatedAt,
        }
      : payload.cache,
    totals: dashboardTotals(projects),
    projects,
  });
}

async function readCachedWithOwnerMetadata(
  env: Env,
  key: string,
): Promise<DashboardPayload | null> {
  const payload = await readCachedRaw(env, key);
  if (!payload) return null;
  try {
    return await mergeOwnerMetadata(env, payload);
  } catch {
    // Never serve cached public metadata when its durable privacy barrier is unavailable.
    return null;
  }
}

async function rememberOwnerMetadata(
  env: Env,
  payload: DashboardPayload,
  mode: "metadata" | "hydrated",
  removedRepos: Iterable<string> = [],
  observedAt = payload.generatedAt,
): Promise<void> {
  const removed = new Set([...removedRepos].map((repo) => repo.toLowerCase()));
  const owners = [
    ...new Set([
      ...payload.owners.map((owner) => slugOwner(owner.login)),
      ...payload.projects.map((project) => slugOwner(project.owner)),
    ]),
  ];
  await Promise.all(
    owners.map(async (owner) => {
      const incoming = payload.projects.filter((project) => slugOwner(project.owner) === owner);
      const countsUpdatedAt = payload.cache?.countsUpdatedAt ?? null;
      await mutateOwnerMetadataSnapshot(env, owner, {
        kind: "merge",
        generatedAt: payload.generatedAt,
        observedAt,
        countsUpdatedAt,
        countsComplete: payload.cache?.progress?.done !== false,
        releaseDataComplete: mode === "hydrated" && payload.cache?.progress?.done !== false,
        mode,
        projects: incoming,
        removedRepos: [...removed],
      });
    }),
  );
}

function safeIso(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCrawlerRequest(request: Request): boolean {
  const cf = (request as Request & { cf?: RequestCf }).cf;
  if (cf?.verifiedBotCategory || cf?.botManagement?.verifiedBot) return true;
  return crawlerUserAgentPattern.test(request.headers.get("user-agent") ?? "");
}

function allowRequestRefresh(request: Request): boolean {
  return !isCrawlerRequest(request);
}

function crawlerCacheOnlyResponse(message: string, status = 202): Response {
  return jsonResponse(
    {
      error: message,
      cache: {
        state: "warming",
        stale: true,
        generatedAt: new Date().toISOString(),
        message,
      },
    },
    status,
    { "cache-control": "no-store" },
  );
}

function refreshTargetStorageKey(key: string): string {
  return `${refreshTargetPrefix}${key}`;
}

function refreshTargetIndexSource(kind: "owner" | "repo", source: string): string {
  return `${refreshTargetIndexPrefix}${kind}:${encodeURIComponent(source.toLowerCase())}:`;
}

function refreshTargetSources(target: RefreshTarget): Array<{
  kind: "owner" | "repo";
  value: string;
}> {
  return [
    ...new Set([
      ...target.owners.map((owner) => `owner:${slugOwner(owner)}`),
      ...(target.owner && target.owner !== "custom" ? [`owner:${slugOwner(target.owner)}`] : []),
      ...target.repos.map((repo) => `repo:${repo.toLowerCase()}`),
    ]),
  ].map((source) => {
    const separator = source.indexOf(":");
    return {
      kind: source.slice(0, separator) as "owner" | "repo",
      value: source.slice(separator + 1),
    };
  });
}

type RefreshTargetIndexWrite = "accepted" | "rejected" | "unavailable";

async function writeDurableRefreshTargetIndexes(
  env: Env,
  target: RefreshTarget,
): Promise<RefreshTargetIndexWrite> {
  if (!env.DASHBOARD_LOCKS) return "unavailable";
  try {
    const writes = await Promise.all(
      refreshTargetSources(target).map(async ({ kind, value }) => {
        const id = env.DASHBOARD_LOCKS!.idFromName(`refresh-target-index:${kind}:${value}`);
        const stub = env.DASHBOARD_LOCKS!.get(id);
        const response = await stub
          .fetch(
            new Request("https://releasebar.internal/target-index/upsert", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(target),
            }),
          )
          .catch(() => null);
        return { response, stub };
      }),
    );
    if (writes.every(({ response }) => response?.ok)) return "accepted";
    await Promise.allSettled(
      writes
        .filter(({ response }) => response?.headers.get("x-refresh-target-created") === "true")
        .map(({ stub }) =>
          stub.fetch(
            new Request("https://releasebar.internal/target-index/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: target.key }),
            }),
          ),
        ),
    );
    return writes.some(({ response }) => response?.status === 429) ? "rejected" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function writeRefreshTargetIndexes(
  env: Env,
  target: RefreshTarget,
): Promise<RefreshTargetIndexWrite> {
  const sources = refreshTargetSources(target);
  const hash = (await sha256Base64Url(target.key)).slice(0, 32);
  const durableIndex = await writeDurableRefreshTargetIndexes(env, target);
  if (durableIndex === "rejected") return durableIndex;
  await Promise.all(
    env.DASHBOARD_CACHE
      ? sources.map(({ kind, value }) =>
          env.DASHBOARD_CACHE!.put(
            `${refreshTargetIndexSource(kind, value)}${hash}`,
            JSON.stringify(target.key),
            { expirationTtl: dashboardStorageTtlSeconds },
          ),
        )
      : [],
  );
  return durableIndex;
}

async function persistRefreshTargetWithIndexes(
  env: Env,
  target: RefreshTarget,
  options: { requireAdmission?: boolean } = {},
): Promise<{ target: RefreshTarget; persisted: boolean }> {
  const indexed = { ...target, indexVersion: refreshTargetIndexVersion };
  const indexWrite = await writeRefreshTargetIndexes(env, indexed);
  const admissionFailed =
    indexWrite === "rejected" ||
    (options.requireAdmission === true &&
      indexWrite === "unavailable" &&
      Boolean(env.DASHBOARD_LOCKS));
  if (admissionFailed) {
    await env.DASHBOARD_CACHE?.delete?.(refreshTargetStorageKey(target.key));
    return { target: { ...target, indexVersion: undefined }, persisted: false };
  }
  const persisted = indexWrite === "accepted" ? indexed : { ...target, indexVersion: undefined };
  await writeRefreshTarget(env, persisted);
  return { target: persisted, persisted: true };
}

function currentDashboardCacheKey(key: string): boolean {
  return key.startsWith(dashboardCachePrefix);
}

function refreshJobStorageKey(id: string): string {
  return `${refreshJobPrefix}${id}`;
}

function refreshJobIndexStorageKey(job: Pick<RefreshJob, "id" | "createdAt">): string {
  const timestamp = safeIso(job.createdAt) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${refreshJobIndexPrefix}${reverseTimestamp}:${job.id}`;
}

function refreshJobDeliveryStorageKey(job: RefreshJob): string {
  const timestamp = safeIso(job.updatedAt) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${refreshJobDeliveryPrefix}${reverseTimestamp}:${job.id}:${job.attempts}`;
}

function jitterMs(seed: string, windowMs: number): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % Math.max(1, windowMs);
}

function nextRefreshAt(target: RefreshTarget, success: boolean): string {
  const now = Date.now();
  if (!success) {
    const failureDelay = schedulerRetryBaseMs * Math.max(1, Math.min(target.failureCount + 1, 8));
    return new Date(now + failureDelay + jitterMs(target.key, 15 * 60 * 1000)).toISOString();
  }
  const recentlyViewed = now - safeIso(target.lastSeenAt) < schedulerRecentViewMs;
  const base = recentlyViewed ? schedulerActiveRefreshMs : schedulerDormantRefreshMs;
  return new Date(now + base + jitterMs(target.key, Math.floor(base / 3))).toISOString();
}

function isRefreshTarget(value: unknown): value is RefreshTarget {
  const target = value as RefreshTarget | null;
  return Boolean(
    target &&
    target.kind === "dashboard" &&
    typeof target.key === "string" &&
    typeof target.owner === "string" &&
    Array.isArray(target.owners) &&
    Array.isArray(target.repos) &&
    typeof target.path === "string" &&
    typeof target.nextDueAt === "string",
  );
}

function isRefreshTargetMutation(value: unknown): value is RefreshTargetMutation {
  const mutation = value as RefreshTargetMutation | null;
  if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string") return false;
  if (mutation.kind === "observe") {
    return Boolean(
      mutation.input &&
      typeof mutation.input.key === "string" &&
      typeof mutation.observedAt === "string" &&
      typeof mutation.profileProvided === "boolean",
    );
  }
  if (mutation.kind === "defer") {
    return (
      typeof mutation.at === "string" &&
      typeof mutation.nextDueAt === "string" &&
      typeof mutation.message === "string"
    );
  }
  if (mutation.kind === "success") {
    return typeof mutation.at === "string";
  }
  return (
    mutation.kind === "failure" &&
    typeof mutation.at === "string" &&
    typeof mutation.message === "string" &&
    typeof mutation.terminal === "boolean"
  );
}

function isRefreshJob(value: unknown): value is RefreshJob {
  const job = value as RefreshJob | null;
  return Boolean(
    job &&
    job.kind === "dashboard" &&
    typeof job.id === "string" &&
    typeof job.targetKey === "string" &&
    typeof job.status === "string",
  );
}

function isGitHubWebhookJob(value: unknown): value is GitHubWebhookJob {
  const job = value as GitHubWebhookJob | null;
  return Boolean(
    job &&
    job.kind === "github-webhook" &&
    typeof job.id === "string" &&
    typeof job.event === "string" &&
    typeof job.delivery === "string" &&
    (job.attempts === undefined || typeof job.attempts === "number") &&
    job.payload &&
    typeof job.payload === "object",
  );
}

function isGitHubWebhookFanoutJob(value: unknown): value is GitHubWebhookFanoutJob {
  const job = value as GitHubWebhookFanoutJob | null;
  return Boolean(
    job &&
    job.kind === "github-webhook-fanout" &&
    typeof job.id === "string" &&
    typeof job.event === "string" &&
    typeof job.delivery === "string" &&
    typeof job.createdAt === "string" &&
    (job.source === "indexed" ||
      job.source === "owner" ||
      job.source === "repo" ||
      job.source === "kv-owner" ||
      job.source === "kv-repo" ||
      job.source === "legacy") &&
    job.payload &&
    typeof job.payload === "object" &&
    job.action &&
    typeof job.action.reason === "string" &&
    typeof job.action.includeReleaseDataOnly === "boolean" &&
    typeof job.action.invalidateDashboard === "boolean" &&
    (job.priorityBatchStartedAt === undefined || typeof job.priorityBatchStartedAt === "string") &&
    (job.action.prioritizedTargetKeys === undefined ||
      (Array.isArray(job.action.prioritizedTargetKeys) &&
        job.action.prioritizedTargetKeys.length <= webhookPriorityTargetLimit &&
        job.action.prioritizedTargetKeys.every((key) => typeof key === "string"))),
  );
}

function refreshJobActive(job: RefreshJob, now = Date.now()): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    now - safeIso(job.updatedAt) <= refreshJobReservationTtlMs + refreshJobActiveGraceMs
  );
}

function localRefreshJobReservationStore(env: Env): Map<string, StoredRefreshJobReservation> {
  const scope =
    (env.DASHBOARD_CACHE as object | undefined) ??
    (env.DASHBOARD_LOCKS as object | undefined) ??
    localRefreshReservationFallbackScope;
  const existing = localRefreshJobReservations.get(scope);
  if (existing) return existing;
  const created = new Map<string, StoredRefreshJobReservation>();
  localRefreshJobReservations.set(scope, created);
  return created;
}

function localRefreshDirtyMarkerStore(env: Env): Map<string, StoredRefreshDirty> {
  const scope =
    (env.DASHBOARD_CACHE as object | undefined) ??
    (env.DASHBOARD_LOCKS as object | undefined) ??
    localRefreshReservationFallbackScope;
  const existing = localRefreshDirtyMarkers.get(scope);
  if (existing) return existing;
  const created = new Map<string, StoredRefreshDirty>();
  localRefreshDirtyMarkers.set(scope, created);
  return created;
}

function recordLocalRefreshDirty(env: Env, targetKey: string, dirty: StoredRefreshDirty): void {
  const markers = localRefreshDirtyMarkerStore(env);
  const existing = markers.get(targetKey);
  if (!existing || safeIso(dirty.observedAt) >= safeIso(existing.observedAt)) {
    markers.set(targetKey, dirty);
  }
}

function takeLocalRefreshDirty(env: Env, targetKey: string): StoredRefreshDirty | null {
  const markers = localRefreshDirtyMarkerStore(env);
  const dirty = markers.get(targetKey);
  if (!dirty) return null;
  markers.delete(targetKey);
  return dirty;
}

function isAuditEvent(value: unknown): value is SchedulerAuditEvent {
  const event = value as SchedulerAuditEvent | null;
  return Boolean(event && typeof event.id === "string" && typeof event.event === "string");
}

async function readRefreshTarget(env: Env, key: string): Promise<RefreshTarget | null> {
  const raw = await env.DASHBOARD_CACHE?.get(refreshTargetStorageKey(key));
  if (!raw) return null;
  const parsed = tryJsonParse<RefreshTarget>(raw, `refresh target ${key}`);
  return isRefreshTarget(parsed) ? parsed : null;
}

async function writeRefreshTarget(env: Env, target: RefreshTarget): Promise<void> {
  await env.DASHBOARD_CACHE?.put(refreshTargetStorageKey(target.key), JSON.stringify(target), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function newerIso<T extends string | null>(left: T, right: T): T {
  return safeIso(right) > safeIso(left) ? right : left;
}

function mergeRefreshTargetState(
  snapshot: RefreshTarget,
  current: RefreshTarget | null,
): RefreshTarget {
  if (!current) return snapshot;
  return {
    ...current,
    lastSeenAt: newerIso(snapshot.lastSeenAt, current.lastSeenAt),
    lastAttemptAt: newerIso(snapshot.lastAttemptAt, current.lastAttemptAt),
    lastSuccessAt: newerIso(snapshot.lastSuccessAt, current.lastSuccessAt),
  };
}

function applyRefreshTargetMutation(
  snapshot: RefreshTarget | null,
  current: RefreshTarget | null,
  mutation: RefreshTargetMutation,
): RefreshTarget {
  if (mutation.kind === "observe") {
    const existing = current ?? snapshot;
    return {
      ...mutation.input,
      kind: "dashboard",
      profileSnapshotKey: mutation.profileProvided
        ? mutation.profileSnapshotKey
        : existing?.profileSnapshotKey,
      lastSeenAt: mutation.observedAt,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      nextDueAt:
        existing?.nextDueAt ??
        new Date(Date.now() + jitterMs(mutation.input.key, 60 * 60 * 1000)).toISOString(),
      failureCount: existing?.failureCount ?? 0,
      terminalBackoffUntil: existing?.terminalBackoffUntil ?? null,
      message: existing?.message,
    };
  }
  if (!snapshot) {
    throw new Error("refresh target snapshot required");
  }
  const target = mergeRefreshTargetState(snapshot, current);
  if (mutation.kind === "defer") {
    return {
      ...target,
      lastAttemptAt: mutation.at,
      nextDueAt: mutation.nextDueAt,
      message: mutation.message,
    };
  }
  if (mutation.kind === "success") {
    return {
      ...target,
      lastAttemptAt: mutation.at,
      lastSuccessAt: mutation.at,
      nextDueAt: nextRefreshAt(target, true),
      failureCount: 0,
      terminalBackoffUntil: null,
      message: mutation.message,
    };
  }
  const nextDueAt = nextRefreshAt(target, false);
  return {
    ...target,
    lastAttemptAt: mutation.at,
    nextDueAt,
    failureCount: target.failureCount + 1,
    terminalBackoffUntil: mutation.terminal ? nextDueAt : target.terminalBackoffUntil,
    message: mutation.message,
  };
}

async function mutateRefreshTargetState(
  env: Env,
  snapshot: RefreshTarget | null,
  mutation: RefreshTargetMutation,
): Promise<RefreshTarget | null> {
  const key = mutation.kind === "observe" ? mutation.input.key : snapshot?.key;
  if (!key) {
    throw new Error("refresh target key required");
  }
  const observedCurrent = mutation.kind === "observe" ? await readRefreshTarget(env, key) : null;
  const requireAdmission = mutation.kind === "observe" && observedCurrent === null;
  if (env.DASHBOARD_LOCKS) {
    try {
      const id = env.DASHBOARD_LOCKS.idFromName(key);
      const response = await env.DASHBOARD_LOCKS.get(id).fetch(
        new Request("https://releasebar.internal/target/mutate", {
          method: "POST",
          body: JSON.stringify({ snapshot, mutation }),
        }),
      );
      if (response.ok) {
        const updated = (await response.json()) as RefreshTarget;
        if (isRefreshTarget(updated)) {
          const persisted = await persistRefreshTargetWithIndexes(env, updated, {
            requireAdmission,
          });
          return persisted.persisted ? persisted.target : null;
        }
      }
    } catch {
      // KV fallback keeps preview and degraded Durable Object paths operational.
    }
  }
  const current = mutation.kind === "observe" ? observedCurrent : await readRefreshTarget(env, key);
  const updated = applyRefreshTargetMutation(snapshot, current, mutation);
  const persisted = await persistRefreshTargetWithIndexes(env, updated, {
    requireAdmission,
  });
  return persisted.persisted ? persisted.target : null;
}

async function rememberRefreshTarget(
  env: Env,
  input: Pick<
    RefreshTarget,
    "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
  > & { profile?: DashboardProfile | null },
): Promise<RefreshTarget | null> {
  if (!env.DASHBOARD_CACHE) return null;
  if (new TextEncoder().encode(input.path).byteLength > durableRefreshTargetEntryLimitBytes) {
    return null;
  }
  const now = new Date().toISOString();
  const { profile, ...targetInput } = input;
  const profileSnapshotKey =
    profile === undefined ? undefined : profile ? await ensureProfileSnapshot(env, profile) : null;
  return mutateRefreshTargetState(env, null, {
    kind: "observe",
    input: targetInput,
    observedAt: now,
    profileProvided: profile !== undefined,
    profileSnapshotKey,
  });
}

async function refreshTargetProfile(
  env: Env,
  target: RefreshTarget,
  cached: DashboardPayload | null,
): Promise<DashboardProfile | null | undefined> {
  if (target.profileSnapshotKey === null) return null;
  if (!target.profileSnapshotKey) return cached?.profile ?? null;
  const snapshot = await readProfileSnapshot(env, target.profileSnapshotKey);
  if (snapshot) return snapshot;
  const current = await readProfile(env, target.owner);
  if (current && profileSnapshotStorageKey(current) === target.profileSnapshotKey) {
    await ensureProfileSnapshot(env, current).catch(() => undefined);
    return current;
  }
  return undefined;
}

async function listRefreshTargets(
  env: Env,
  limit = refreshTargetListLimit,
): Promise<RefreshTarget[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const targets: RefreshTarget[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: refreshTargetPrefix,
      limit: Math.min(1000, limit - targets.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const target = tryJsonParse<RefreshTarget>(raw, `refresh target ${key.name}`);
      if (isRefreshTarget(target) && currentDashboardCacheKey(target.key)) targets.push(target);
      if (targets.length >= limit) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && targets.length < limit);
  return targets;
}

async function backfillRefreshTargetIndexes(env: Env, targets: RefreshTarget[]): Promise<void> {
  if (!env.DASHBOARD_CACHE) return;
  const pending = targets.filter((target) => target.indexVersion !== refreshTargetIndexVersion);
  const batch = pending.slice(0, refreshTargetIndexBackfillLimit);
  await mapConcurrent(batch, 4, (target) => persistRefreshTargetWithIndexes(env, target));
}

async function readStringList(env: Env, key: string): Promise<string[]> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  if (!raw) return [];
  const parsed = tryJsonParse<string[]>(raw, key);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

async function writeRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE?.put(refreshJobStorageKey(job.id), JSON.stringify(job), {
    expirationTtl: 14 * 24 * 60 * 60,
  });
}

async function writeRefreshJobDelivery(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE?.put(refreshJobDeliveryStorageKey(job), JSON.stringify(job), {
    expirationTtl: 14 * 24 * 60 * 60,
  });
}

async function indexRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE?.put(refreshJobIndexStorageKey(job), JSON.stringify(job), {
    expirationTtl: 14 * 24 * 60 * 60,
  });
}

async function readRefreshJobSnapshot(env: Env, key: string): Promise<RefreshJob | null> {
  if (!key.startsWith(refreshJobIndexPrefix)) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  if (!raw) return null;
  const parsed = tryJsonParse<RefreshJob>(raw, `refresh job snapshot ${key}`);
  return isRefreshJob(parsed) ? parsed : null;
}

async function readRefreshJob(env: Env, id: string): Promise<RefreshJob | null> {
  const raw = await env.DASHBOARD_CACHE?.get(refreshJobStorageKey(id));
  if (!raw) return null;
  const parsed = tryJsonParse<RefreshJob>(raw, `refresh job ${id}`);
  return isRefreshJob(parsed) ? parsed : null;
}

async function listRefreshJobs(env: Env): Promise<RefreshJob[]> {
  const jobs = new Map<string, RefreshJob>();
  if (env.DASHBOARD_CACHE?.list) {
    const [page, deliveryPage] = await Promise.all([
      env.DASHBOARD_CACHE.list({
        prefix: refreshJobIndexPrefix,
        limit: refreshJobListLimit,
      }),
      env.DASHBOARD_CACHE.list({
        prefix: refreshJobDeliveryPrefix,
        limit: refreshJobListLimit,
      }),
    ]);
    await Promise.all(
      page.keys.slice(0, refreshJobListLimit).map(async (key) => {
        const indexedRaw = await env.DASHBOARD_CACHE?.get(key.name);
        if (!indexedRaw) return;
        const indexed = tryJsonParse<RefreshJob>(indexedRaw, `refresh job index ${key.name}`);
        if (!isRefreshJob(indexed)) return;
        jobs.set(indexed.id, (await readRefreshJob(env, indexed.id)) ?? indexed);
      }),
    );
    await Promise.all(
      deliveryPage.keys.slice(0, refreshJobListLimit).map(async (key) => {
        const raw = await env.DASHBOARD_CACHE?.get(key.name);
        if (!raw) return;
        const delivery = tryJsonParse<RefreshJob>(raw, `refresh job delivery ${key.name}`);
        if (!isRefreshJob(delivery)) return;
        const current = jobs.get(delivery.id);
        if (!current || safeIso(delivery.updatedAt) > safeIso(current.updatedAt)) {
          jobs.set(delivery.id, delivery);
        }
      }),
    );
  }
  if (jobs.size < refreshJobListLimit) {
    const legacyIds = await readStringList(env, legacyRefreshJobIndexKey);
    await Promise.all(
      legacyIds.slice(0, refreshJobListLimit - jobs.size).map(async (id) => {
        const job = await readRefreshJob(env, id);
        if (job) jobs.set(job.id, job);
      }),
    );
  }
  return [...jobs.values()]
    .sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt))
    .slice(0, refreshJobListLimit);
}

async function auditScheduler(
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): Promise<void> {
  const item: SchedulerAuditEvent = {
    id: randomNonce(),
    at: new Date().toISOString(),
    ...event,
  };
  console.log(JSON.stringify({ area: "scheduler", ...item }));
  await env.DASHBOARD_CACHE?.put(refreshAuditStorageKey(item), JSON.stringify(item), {
    expirationTtl: 14 * 24 * 60 * 60,
  });
}

function dashboardSyncDetail(payload: DashboardPayload | null, extra = ""): string {
  const cache = payload?.cache;
  const progress = cache?.progress;
  return [
    cache?.state ? `state=${cache.state}` : "state=missing",
    `projects=${payload?.projects.length ?? 0}`,
    progress ? `scanned=${progress.scanned}/${progress.limit}` : "",
    progress ? `done=${progress.done}` : "",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

function auditDashboardSync(
  context: ExecutionContext,
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): void {
  context.waitUntil(auditSyncEvent(env, event));
}

async function auditSyncEvent(
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): Promise<void> {
  await auditScheduler(env, event).catch(() => undefined);
}

function timingNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 10 * 60 * 1000) return undefined;
  return Math.round(value);
}

function timingText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 160) : fallback;
}

function timingPath(value: unknown): string {
  const path = timingText(value, "/");
  return path.startsWith("/") ? path.slice(0, 160) : "/";
}

function timingBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timingDetail(input: Record<string, unknown>): string {
  const pairs: Array<[string, string | number | boolean | null | undefined]> = [
    ["source", timingText(input.source, "unknown")],
    ["path", timingPath(input.path)],
    ["api", timingPath(input.apiPath)],
    ["route", timingText(input.route)],
    ["attempt", timingNumber(input.attempt)],
    ["http", timingNumber(input.httpStatus)],
    ["cache", timingText(input.cacheState)],
    ["headerMs", timingNumber(input.headerMs)],
    ["bodyMs", timingNumber(input.bodyMs)],
    ["renderMs", timingNumber(input.renderMs)],
    ["streamMs", timingNumber(input.streamMs)],
    ["totalMs", timingNumber(input.totalMs)],
    ["navTtfbMs", timingNumber(input.navigationTtfbMs)],
    ["navInteractiveMs", timingNumber(input.navigationInteractiveMs)],
  ];
  return pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

async function clientTimingRateLimited(request: Request, env: Env): Promise<boolean> {
  if (!env.DASHBOARD_CACHE) return false;
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client =
    request.headers.get("cf-connecting-ip") ??
    forwardedFor ??
    request.headers.get("user-agent") ??
    "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const id = (await sha256Base64Url(client)).slice(0, 16);
  const key = `client:timing:rate:v1:${id}:${minute}`;
  const current = Number.parseInt((await env.DASHBOARD_CACHE.get(key)) ?? "0", 10);
  if (Number.isFinite(current) && current >= 30) return true;
  await env.DASHBOARD_CACHE.put(key, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: 120,
  });
  return false;
}

async function authInstallCallbackRateLimited(request: Request, env: Env): Promise<boolean> {
  if (!env.DASHBOARD_CACHE) return true;
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client =
    request.headers.get("cf-connecting-ip") ??
    forwardedFor ??
    request.headers.get("user-agent") ??
    "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const id = (await sha256Base64Url(client)).slice(0, 16);
  const key = `auth:install-callback:rate:v1:${id}:${minute}`;
  const current = Number.parseInt((await env.DASHBOARD_CACHE.get(key)) ?? "0", 10);
  if (Number.isFinite(current) && current >= 6) return true;
  await env.DASHBOARD_CACHE.put(key, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: 120,
  });
  return false;
}

async function clientTimingResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ error: "forbidden" }, 403, { "cache-control": "no-store" });
  }
  if (await clientTimingRateLimited(request, env)) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  const raw = await request.text().catch(() => "");
  if (raw.length > 2048) {
    return jsonResponse({ error: "payload too large" }, 413, { "cache-control": "no-store" });
  }
  const input = tryJsonParse<Record<string, unknown>>(raw, "client timing");
  if (!input || typeof input !== "object") {
    return jsonResponse({ error: "invalid timing" }, 400, { "cache-control": "no-store" });
  }
  const cacheState = timingText(input.cacheState, "ok");
  auditDashboardSync(context, env, {
    event: "client_dashboard_timing",
    status: cacheState,
    source: "browser",
    reason: timingText(input.source, "unknown"),
    durationMs: timingNumber(input.totalMs),
    projects: timingNumber(input.projects),
    scanned: timingNumber(input.scanned),
    limit: timingNumber(input.limit),
    done: timingBool(input.done),
    detail: timingDetail(input),
  });
  return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
}

function refreshAuditStorageKey(event: Pick<SchedulerAuditEvent, "id" | "at">): string {
  const timestamp = safeIso(event.at) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${refreshAuditPrefix}${reverseTimestamp}:${event.id}`;
}

async function listCurrentAuditEvents(env: Env): Promise<SchedulerAuditEvent[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const events: SchedulerAuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: refreshAuditPrefix,
      limit: Math.min(1000, refreshAuditListLimit - events.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const parsed = tryJsonParse<SchedulerAuditEvent>(raw, `refresh audit ${key.name}`);
      if (isAuditEvent(parsed)) events.push(parsed);
      if (events.length >= refreshAuditListLimit) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && events.length < refreshAuditListLimit);
  return events;
}

async function listAuditEvents(env: Env): Promise<SchedulerAuditEvent[]> {
  return (await listCurrentAuditEvents(env))
    .filter((event): event is SchedulerAuditEvent => Boolean(event))
    .sort((a, b) => safeIso(b.at) - safeIso(a.at))
    .slice(0, refreshAuditListLimit);
}

type StoredGitHubAccessCounter = GitHubAccessRouteSummary & {
  remaining?: number | null;
  limit?: number | null;
  resetAt?: string | null;
};

type StoredGitHubAccessShard = {
  count?: number;
  lastAt?: string | null;
  routes?: Record<string, GitHubAccessRouteSummary>;
};

function githubAccessHours(hours: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index <= hours; index += 1) {
    const hour = new Date(Date.now() - index * 60 * 60 * 1000).toISOString().slice(0, 13);
    if (!seen.has(hour)) {
      seen.add(hour);
      result.push(hour);
    }
  }
  return result;
}

function incrementSummary(map: Map<string, number>, key: string, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function summaryRows(map: Map<string, number>): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

async function githubAccessSummary(
  env: Env,
  hours = githubAccessAdminHours,
): Promise<GitHubAccessSummary> {
  const cooldown = await sharedQuotaCooldown(env);
  if (!env.DASHBOARD_CACHE?.list) {
    return {
      generatedAt: new Date().toISOString(),
      hours,
      buckets: 0,
      total: 0,
      cooldown,
      byArea: [],
      bySource: [],
      byStatus: [],
      topRoutes: [],
    };
  }
  const pages = await Promise.all(
    githubAccessHours(hours).map((hour) =>
      env.DASHBOARD_CACHE!.list!({
        prefix: `${githubAccessPrefix}${hour}:`,
        limit: 1000,
      }),
    ),
  );
  const keys = pages.flatMap((page) => page.keys.map((key) => key.name));

  const counters = await Promise.all(
    keys.map(async (key): Promise<GitHubAccessRouteSummary[]> => {
      const raw = await env.DASHBOARD_CACHE?.get(key);
      if (!raw) return [];
      const parsed = tryJsonParse<StoredGitHubAccessShard | StoredGitHubAccessCounter>(
        raw,
        `github access ${key}`,
      );
      if (!parsed) return [];
      if ("routes" in parsed && parsed.routes) {
        return Object.values(parsed.routes).map((route) => ({
          ...route,
          account: route.account ?? null,
          resource: route.resource ?? null,
          lastAt: route.lastAt ?? null,
          lastPath: route.lastPath ?? null,
        }));
      }
      const counter = parsed as StoredGitHubAccessCounter;
      if (typeof counter.count !== "number" || !counter.route) return [];
      return [
        {
          ...counter,
          key,
          account: counter.account ?? null,
          resource: counter.resource ?? null,
          lastAt: counter.lastAt ?? null,
          lastPath: counter.lastPath ?? null,
        },
      ];
    }),
  );

  const byArea = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const routeCounts = new Map<string, GitHubAccessRouteSummary>();
  let total = 0;
  for (const counter of counters.flat()) {
    const count = counter.count;
    total += count;
    incrementSummary(byArea, counter.area, count);
    incrementSummary(bySource, `${counter.source}:${counter.account ?? "_"}`, count);
    incrementSummary(
      byStatus,
      `${counter.status}:${counter.resource ?? "_"}:${counter.area}`,
      count,
    );
    const routeKey = `${counter.area}:${counter.status}:${counter.source}:${counter.account ?? "_"}:${counter.resource ?? "_"}:${counter.route}`;
    const existing = routeCounts.get(routeKey);
    routeCounts.set(routeKey, {
      key: routeKey,
      area: counter.area,
      route: counter.route,
      status: counter.status,
      source: counter.source,
      account: counter.account ?? null,
      resource: counter.resource ?? null,
      count: (existing?.count ?? 0) + count,
      lastAt:
        !existing?.lastAt || (counter.lastAt && safeIso(counter.lastAt) > safeIso(existing.lastAt))
          ? counter.lastAt
          : existing.lastAt,
      lastPath:
        !existing?.lastAt || (counter.lastAt && safeIso(counter.lastAt) > safeIso(existing.lastAt))
          ? counter.lastPath
          : existing.lastPath,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    hours,
    buckets: keys.length,
    total,
    cooldown,
    byArea: summaryRows(byArea),
    bySource: summaryRows(bySource),
    byStatus: summaryRows(byStatus),
    topRoutes: [...routeCounts.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, githubAccessAdminRouteLimit),
  };
}

function refreshJob(target: RefreshTarget, reason: string): RefreshJob {
  const now = new Date().toISOString();
  const job: RefreshJob = {
    id: randomNonce(),
    targetKey: target.key,
    target,
    kind: target.kind,
    status: "queued",
    reason,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  job.targetSnapshotKey = refreshJobIndexStorageKey(job);
  return job;
}

function refreshQueueMessage(job: RefreshJob): RefreshJob {
  const { target: _target, ...message } = job;
  return message;
}

async function reserveRefreshJob(
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

async function releaseRefreshJobReservation(
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

async function enqueueRefreshJob(
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

async function finishRefreshJobReservation(
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

function refreshTargetDue(
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

function refreshTargetBackoffActive(target: RefreshTarget, now = Date.now()): boolean {
  return now < safeIso(target.terminalBackoffUntil ?? "");
}

function refreshReason(target: RefreshTarget, cached: DashboardPayload | null): string {
  if (sharedQuotaDeferredTarget(target)) return "app-quota";
  if (!cached) return "missing-cache";
  if (!canDisplayCached(cached)) return "expired-cache";
  if (cached.cache?.state === "error") return "error-cache";
  if (cached.cache?.progress?.done === false) return "partial-cache";
  return Date.now() >= safeIso(target.nextDueAt) ? "scheduled" : "not-due";
}

function sharedQuotaDeferredTarget(target: RefreshTarget): boolean {
  return (
    typeof target.message === "string" &&
    target.message.startsWith("shared GitHub quota paused until ") &&
    Date.now() < safeIso(target.nextDueAt)
  );
}

type SchedulerDueOptions = {
  sharedQuotaPaused: boolean;
  sharedGraphqlPausedOperations: ReadonlySet<string>;
  now: number;
};

function refreshTargetGraphqlOperations(target: RefreshTarget): string[] {
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

function dormantSharedTargetDue(target: RefreshTarget, now: number): boolean {
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

async function schedulerTargetDue(
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

async function schedulerDueOptions(env: Env): Promise<SchedulerDueOptions> {
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

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

async function refreshOwnerCounts(
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
  await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
  const exact = requiredRepo
    ? result.repos.find((repo) => repo.fullName.toLowerCase() === requiredRepo.toLowerCase())
    : undefined;
  if (requiredRepo && !exact) return { status: "missing-repo" };
  return { status: "refreshed", exact };
}

async function refreshDueOwnerCounts(
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

async function schedulerTick(
  env: Env,
  context: ExecutionContext,
  cause: string,
  limit = schedulerBatchLimit,
): Promise<{ enqueued: number; considered: number; due: number }> {
  const [targets, jobs, dueOptions] = await Promise.all([
    listRefreshTargets(env),
    listRefreshJobs(env),
    schedulerDueOptions(env),
  ]);
  await backfillRefreshTargetIndexes(env, targets);
  const countRefresh = await refreshDueOwnerCounts(env, context, targets, dueOptions.now);
  const activeTargetKeys = new Set(
    jobs.filter((job) => refreshJobActive(job)).map((job) => job.targetKey),
  );
  const pairs = await Promise.all(
    targets.map(async (target) => ({ target, cached: await readCached(env, target.key) })),
  );
  const duePairs = await Promise.all(
    pairs.map(async (pair) => ({
      ...pair,
      due: await schedulerTargetDue(env, pair.target, pair.cached, dueOptions),
    })),
  );
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

async function processRefreshJob(
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

async function failExhaustedRefreshJob(
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

async function processRefreshJobFallback(input: RefreshJob, env: Env): Promise<RefreshJob> {
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

async function schedulerAdminPayload(env: Env): Promise<SchedulerAdminPayload> {
  const [targets, jobs, events, stateRaw, access, auth, dueOptions] = await Promise.all([
    listRefreshTargets(env, refreshTargetListLimit),
    listRefreshJobs(env),
    listAuditEvents(env),
    env.DASHBOARD_CACHE?.get(refreshStateKey),
    githubAccessSummary(env),
    authFunnelSummary(env),
    schedulerDueOptions(env),
  ]);
  const state = stateRaw ? tryJsonParse<{ lastTickAt?: string }>(stateRaw, "refresh state") : null;
  const activeTargetKeys = new Set(
    jobs.filter((job) => refreshJobActive(job)).map((job) => job.targetKey),
  );
  const activeJobs = jobs.filter((job) => refreshJobActive(job));
  const targetStates = await Promise.all(
    targets.map(async (target) => ({ target, cached: await readCached(env, target.key) })),
  );
  const dueTargetStates = await Promise.all(
    targetStates.map(async (state) => ({
      ...state,
      due: await schedulerTargetDue(env, state.target, state.cached, dueOptions),
    })),
  );
  const dueTargets = dueTargetStates.filter(
    ({ target, due }) => due && !activeTargetKeys.has(target.key),
  ).length;
  return {
    generatedAt: new Date().toISOString(),
    authorized: true,
    status: {
      targets: targets.length,
      dueTargets,
      queuedJobs: activeJobs.filter((job) => job.status === "queued").length,
      runningJobs: activeJobs.filter((job) => job.status === "running").length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
      lastTickAt: state?.lastTickAt ?? null,
      nextDueAt:
        targets
          .map((target) => target.nextDueAt)
          .filter((value) => safeIso(value) > 0)
          .sort()[0] ?? null,
      queueConfigured: Boolean(env.REFRESH_QUEUE),
    },
    targets: targets.sort((a, b) => safeIso(a.nextDueAt) - safeIso(b.nextDueAt)).slice(0, 120),
    jobs,
    events,
    githubAccess: access,
    auth,
  };
}

function progressKey(key: string): string {
  return `progress:v1:${key}`;
}

function progressTombstoneKey(key: string): string {
  return `progress:tombstone:v1:${key}`;
}

function isStoredBuildProgress(value: unknown): value is StoredBuildProgress {
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

function isStoredBuildProgressTombstone(value: unknown): value is StoredBuildProgressTombstone {
  const tombstone = value as StoredBuildProgressTombstone | null;
  return Boolean(
    tombstone && typeof tombstone.clearedAt === "string" && safeIso(tombstone.clearedAt),
  );
}

function storedBuildProgressExpired(progress: StoredBuildProgress): boolean {
  return Date.now() - safeIso(progress.updatedAt) > progressTtlSeconds * 1000;
}

async function readFallbackProgress(
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

async function readProgressTombstone(
  env: Env,
  key: string,
): Promise<StoredBuildProgressTombstone | null> {
  const raw = await env.DASHBOARD_CACHE?.get(progressTombstoneKey(key));
  if (!raw) return null;
  const stored = tryJsonParse<unknown>(raw, `progress tombstone ${key}`);
  return isStoredBuildProgressTombstone(stored) ? stored : null;
}

function latestProgressTombstone(
  fallback: StoredBuildProgress | StoredBuildProgressTombstone | null,
  tombstone: StoredBuildProgressTombstone | null,
): StoredBuildProgressTombstone | null {
  const legacy = isStoredBuildProgressTombstone(fallback) ? fallback : null;
  if (!legacy) return tombstone;
  if (!tombstone) return legacy;
  return safeIso(legacy.clearedAt) >= safeIso(tombstone.clearedAt) ? legacy : tombstone;
}

function progressCleared(
  progress: StoredBuildProgress,
  tombstone: StoredBuildProgressTombstone | null,
): boolean {
  const generationStartedAt = progress.generationStartedAt ?? progress.updatedAt;
  return Boolean(tombstone && safeIso(tombstone.clearedAt) >= safeIso(generationStartedAt));
}

function progressGenerationStartedAt(
  tombstone: StoredBuildProgressTombstone | null,
  now = Date.now(),
): string {
  const clearedAt = tombstone ? safeIso(tombstone.clearedAt) : 0;
  return new Date(
    clearedAt > 0 && clearedAt <= now ? Math.max(now, clearedAt + 1) : now,
  ).toISOString();
}

async function beginProgressGeneration(env: Env, key: string): Promise<string> {
  return progressGenerationStartedAt(await readProgressTombstone(env, key));
}

async function durableProgressResponse(
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

function durableProgressSupported(response: Response | null): response is Response {
  return response?.headers.get("x-releasebar-progress") === "durable";
}

async function readProgress(env: Env, key: string): Promise<StoredBuildProgress | null> {
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

async function writeProgress(env: Env, key: string, progress: StoredBuildProgress): Promise<void> {
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

async function writeProgressTombstone(
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

async function deleteProgress(env: Env, key: string): Promise<StoredBuildProgressTombstone> {
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

function projectActivityDate(project: Project): string | null {
  return project.latestCommitDate || project.pushedAt || project.updatedAt;
}

function daysSince(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

function hotScore(project: Project): number {
  const commits = project.commitsSinceRelease ?? 0;
  const stars = Math.log1p(project.stars) * 6;
  const activityDays = daysSince(projectActivityDate(project));
  const recency =
    activityDays === null ? 0 : (Math.max(0, 30 - Math.min(activityDays, 30)) / 30) * 20;
  const prs = Math.log1p(project.openPullRequests ?? 0) * 2;
  const ci = project.ciState === "failure" ? 15 : project.ciState === "running" ? 5 : 0;
  return commits * 4 + stars + recency + prs + ci;
}

function withProfile(
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

function dashboardTotals(projects: Project[]): DashboardPayload["totals"] {
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

async function partialDashboardPayload(
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

async function readCachedDashboards(env: Env): Promise<DashboardPayload[]> {
  if (!env.DASHBOARD_CACHE) return [];

  const dashboards: DashboardPayload[] = [];
  let keys = await readHotIndex(env);
  if (keys.length < hotSourceLimit && env.DASHBOARD_CACHE.list) {
    for (const prefix of dashboardCachePrefixes) {
      if (keys.length >= hotSourceLimit) break;
      const page = await env.DASHBOARD_CACHE.list({
        prefix,
        limit: hotSourceLimit,
      });
      keys = [...new Set([...keys, ...page.keys.map((key) => key.name)])];
    }
  }

  for (const key of keys.slice(0, hotSourceLimit)) {
    const raw = await env.DASHBOARD_CACHE.get(key);
    if (!raw) continue;
    const rawPayload = tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`);
    if (!canDisplayCached(rawPayload)) continue;
    const payload = await mergeOwnerMetadata(env, rawPayload);
    if (
      payload.cache?.state === "error" ||
      payload.options?.includeForks ||
      payload.projects.length === 0
    ) {
      continue;
    }
    dashboards.push(payload);
  }

  return dashboards;
}

async function readHotIndex(env: Env): Promise<string[]> {
  const raw = await env.DASHBOARD_CACHE?.get(hotIndexKey);
  if (!raw) return [];
  const keys = safeJsonParse(hotIndexSchema, raw, "hot index");
  return keys
    ? keys.filter((key) => dashboardCachePrefixes.some((prefix) => key.startsWith(prefix)))
    : [];
}

async function rememberHotDashboard(
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

function canContributeToHotDashboard(project: Project): boolean {
  return !project.archived && Boolean(project.releaseDate) && project.commitsSinceRelease !== null;
}

function hotDashboardPayload(
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

async function hotResponse(env: Env): Promise<Response> {
  const cached = await readCachedWithOwnerMetadata(env, hotCacheKey);
  const ageMs = cacheAgeMs(cached);
  if (cached && canDisplayCached(cached) && ageMs < hotCacheTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  const payload = hotDashboardPayload(await readCachedDashboards(env), env);
  await writeCached(env, hotCacheKey, payload);
  return jsonResponse(payload);
}

async function cachedHotInitialData(env: Env): Promise<InitialPageData | null> {
  const cached = await readCachedWithOwnerMetadata(env, hotCacheKey);
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  return {
    route: "dashboard",
    payload: withCacheState(cached, cacheAgeMs(cached) < hotCacheTtlMs ? "fresh" : "stale"),
  };
}

type DiscoverPeriod = "day" | "week" | "month" | "year";

const discoverPeriods = new Set<DiscoverPeriod>(["day", "week", "month", "year"]);

function discoverPeriod(url: URL): DiscoverPeriod {
  const raw = (url.searchParams.get("period") ?? "week").toLowerCase();
  if (raw === "today") return "day";
  return discoverPeriods.has(raw as DiscoverPeriod) ? (raw as DiscoverPeriod) : "week";
}

function discoverLanguage(url: URL): string {
  const raw = (url.searchParams.get("lang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

function discoverPageLanguage(url: URL): string {
  const raw = (url.searchParams.get("hotLang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

function discoverCacheKey(period: DiscoverPeriod, language: string): string {
  return `discover:v${discoverCacheSchemaVersion}:${period}:${language.trim().toLowerCase() || "all"}`;
}

function discoverSince(period: DiscoverPeriod): string {
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  const date = new Date(Date.now() - days * 86400000);
  return date.toISOString().slice(0, 10);
}

function discoverPeriodLabel(period: DiscoverPeriod): string {
  return period === "day" ? "today" : `this ${period}`;
}

function discoverSearchQuery(period: DiscoverPeriod, language: string): string {
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

function quotaFromResponse(response: Response, env: Env): ApiQuota {
  const remaining = parseHeaderInt(response.headers.get("x-ratelimit-remaining"));
  const limit = parseHeaderInt(response.headers.get("x-ratelimit-limit"));
  const reset = parseHeaderInt(response.headers.get("x-ratelimit-reset"));
  return {
    source: env.GITHUB_TOKEN ? "shared" : "anonymous",
    account: null,
    remaining,
    limit,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: response.headers.get("x-ratelimit-resource"),
  };
}

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRateLimitResponse(response: Response, message: string): boolean {
  return (
    response.status === 429 ||
    /rate limit|secondary rate|abuse detection/i.test(message) ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  );
}

function quotaFromGitHubResponse(
  response: Response,
  source: ApiQuota["source"],
  account: string | null,
): ApiQuota {
  const quota = quotaFromResponse(response, {
    GITHUB_TOKEN: source === "anonymous" ? undefined : "token",
  } as Env);
  return { ...quota, source, account };
}

async function detailGitHubJson<TSchema extends GenericSchema>(
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
  return data;
}

async function detailGitHubJsonWithHeaders<TSchema extends GenericSchema>(
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
): Promise<{ data: InferOutput<TSchema>; headers: Headers }> {
  const requestOptions = githubRequestOptions(acceptOrAuditArea, auditArea);
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: requestOptions.accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
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
  return { data: parseGitHubResponse(schema, body, context), headers: response.headers };
}

type RepoDetailAuxCacheRecord<T> = {
  generatedAt: string;
  data: T;
};

function repoDetailAuxCacheKey(kind: string, id: string): string {
  return `repo-detail:aux:v${repoDetailAuxCacheVersion}:${kind}:${encodeURIComponent(id.toLowerCase())}`;
}

function repoStatsBackoffCacheKeys(path: string): string[] {
  const repoPath = path.replace(/\/stats\/[^/?]+(\?.*)?$/, "/stats");
  return [
    repoDetailAuxCacheKey("stats-backoff", path),
    repoDetailAuxCacheKey("stats-backoff", repoPath),
  ];
}

async function readRepoDetailAux<T>(
  env: Env | undefined,
  key: string,
  maxAgeMs: number,
): Promise<T | null> {
  const raw = await env?.DASHBOARD_CACHE?.get(key);
  if (!raw) return null;
  const record = tryJsonParse<RepoDetailAuxCacheRecord<T>>(raw, `repo detail aux ${key}`);
  const generatedAt = Date.parse(record?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > maxAgeMs) return null;
  return record?.data ?? null;
}

async function writeRepoDetailAux<T>(
  env: Env | undefined,
  key: string,
  data: T,
  ttlSeconds = repoDetailAuxTtlSeconds,
): Promise<void> {
  await env?.DASHBOARD_CACHE?.put(
    key,
    JSON.stringify({ generatedAt: new Date().toISOString(), data }),
    { expirationTtl: ttlSeconds },
  );
}

async function cachedDetailGitHubJson<TSchema extends GenericSchema>(
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
): Promise<InferOutput<TSchema>> {
  const cacheKey = repoDetailAuxCacheKey(cacheKind, path);
  const cached = await readRepoDetailAux<InferOutput<TSchema>>(env, cacheKey, maxAgeMs);
  if (cached !== null) return cached;
  const data = await detailGitHubJson(
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
  await writeRepoDetailAux(env, cacheKey, data, Math.floor(maxAgeMs / 1000));
  return data;
}

async function cachedDetailGitHubCount(
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
  const cacheKey = repoDetailAuxCacheKey(cacheKind, path);
  const cached = await readRepoDetailAux<number>(env, cacheKey, maxAgeMs);
  if (cached !== null) return cached;
  const count = await detailGitHubCount(
    path,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    env,
  );
  await writeRepoDetailAux(env, cacheKey, count, Math.floor(maxAgeMs / 1000));
  return count;
}

async function detailGitHubStats<TSchema extends GenericSchema>(
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
  const statsCacheKey = repoDetailAuxCacheKey("stats", path);
  const cached = await readRepoDetailAux<StatsResult>(
    env,
    statsCacheKey,
    repoDetailStatsCacheTtlMs,
  );
  if (cached) return cached;
  const backoffKeys = repoStatsBackoffCacheKeys(path);
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

async function detailGitHubCount(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<number> {
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
  if (lastPage !== null) return lastPage;
  return Array.isArray(body) ? body.length : 0;
}

async function detailGitHubSearchCount(
  query: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
  env?: Env,
): Promise<number> {
  const cacheKey = repoDetailAuxCacheKey("search-count", query);
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

async function buildWorkTrend(
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
  const [issuesOpened30d, issuesClosed30d, pullRequestsOpened30d, pullRequestsClosed30d] =
    await Promise.all([
      detailGitHubSearchCount(
        `${repoQuery} is:issue created:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
        env,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:issue closed:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
        env,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:pr created:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
        env,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:pr closed:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
        env,
      ),
    ]);
  return {
    since,
    issuesOpened30d,
    issuesClosed30d,
    pullRequestsOpened30d,
    pullRequestsClosed30d,
  };
}

function activityRangeFromUrl(url: URL): ActivityRange {
  const value = url.searchParams.get("range")?.toLowerCase();
  return value === "day" || value === "month" ? value : "week";
}

function activityRangeMs(range: ActivityRange): number {
  if (range === "day") return 24 * 60 * 60 * 1000;
  if (range === "month") return 30 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function activityCacheTtlMs(range: ActivityRange): number {
  if (range === "day") return 10 * 60 * 1000;
  if (range === "month") return 6 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function ownerActivityCacheKey(owner: string, range: ActivityRange): string {
  return `owner-activity:v1:${slugOwner(owner)}:${range}`;
}

function ownerActivitySummaryCacheKey(
  owner: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `owner-activity-summary:v${activitySummaryPromptVersion}`,
    slugOwner(owner),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

function repoActivityCacheKey(owner: string, repo: string, range: ActivityRange): string {
  return `repo-activity:v1:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

function repoActivitySummaryCacheKey(
  fullName: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `repo-activity-summary:v${activitySummaryPromptVersion}`,
    fullName.toLowerCase(),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

function ownerActivityAgeMs(payload: OwnerActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readOwnerActivity(env: Env, key: string): Promise<OwnerActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivityPayload>(raw, `owner activity ${key}`) : null;
}

async function writeOwnerActivity(
  env: Env,
  key: string,
  payload: OwnerActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readRepoActivity(env: Env, key: string): Promise<RepoDetailActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailActivityPayload>(raw, `repo activity ${key}`) : null;
}

async function writeRepoActivity(
  env: Env,
  key: string,
  payload: RepoDetailActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readOwnerActivitySummary(
  env: Env,
  key: string,
): Promise<OwnerActivitySummary | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivitySummary>(raw, `owner activity summary ${key}`) : null;
}

async function writeOwnerActivitySummary(
  env: Env,
  key: string,
  summary: OwnerActivitySummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function payloadString(value: unknown, key: string): string | null {
  const result = payloadRecord(value)[key];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return payloadRecord(payloadRecord(value)[key]);
}

function nestedString(value: unknown, key: string, nestedKey: string): string | null {
  const result = nestedRecord(value, key)[nestedKey];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

function activityRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function normalizeActivityEvent(event: GitHubPublicEvent): OwnerActivityEvent | null {
  if (event.public === false) return null;
  const repo = event.repo?.name?.trim() ?? "";
  const payload = event.payload;
  const createdAt = event.created_at;
  if (!repo || !createdAt) return null;
  const repoUrl = activityRepoUrl(repo);

  if (event.type === "PushEvent") {
    const payloadData = payloadRecord(payload);
    const commits = payloadData.commits;
    const commitList = Array.isArray(commits) ? commits : [];
    const titles = commitList
      .map((commit) => commitTitle(payloadString(commit, "message") ?? ""))
      .filter(Boolean);
    const size = Number(payloadData.size ?? 0);
    const count = Math.max(1, titles.length, Number.isFinite(size) ? size : 0);
    return {
      id: event.id,
      kind: "commit",
      title:
        titles[0] && count > 1
          ? `${titles[0]} +${count - 1} commits`
          : (titles[0] ?? `${count} commit${count === 1 ? "" : "s"}`),
      repo,
      url: repoUrl,
      createdAt,
      count,
    };
  }

  if (event.type === "PullRequestEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} PR: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "PullRequestReviewEvent") {
    const action = payloadString(payload, "action") ?? "reviewed";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} review: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssuesEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "issue",
      title: `${action} issue: ${title}`,
      repo,
      url: nestedString(payload, "issue", "html_url") ?? `${repoUrl}/issues`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssueCommentEvent") {
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "comment",
      title: `commented on: ${title}`,
      repo,
      url:
        nestedString(payload, "comment", "html_url") ?? nestedString(payload, "issue", "html_url"),
      createdAt,
      count: 1,
    };
  }

  if (event.type === "ReleaseEvent") {
    const action = payloadString(payload, "action") ?? "published";
    const tag = nestedString(payload, "release", "tag_name");
    const name = nestedString(payload, "release", "name");
    return {
      id: event.id,
      kind: "release",
      title: `${action} release: ${name || tag || repo}`,
      repo,
      url: nestedString(payload, "release", "html_url") ?? `${repoUrl}/releases`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "CreateEvent") {
    const refType = payloadString(payload, "ref_type") ?? "thing";
    const ref = payloadString(payload, "ref");
    return {
      id: event.id,
      kind: "repository",
      title: `created ${refType}${ref ? ` ${ref}` : ""}`,
      repo,
      url: repoUrl,
      createdAt,
      count: 1,
    };
  }

  return {
    id: event.id,
    kind: "other",
    title: event.type
      .replace(/Event$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase(),
    repo,
    url: repoUrl,
    createdAt,
    count: 1,
  };
}

async function fetchOwnerActivityEvents(
  owner: Owner,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  const base =
    owner.type === "org"
      ? `/orgs/${encodeURIComponent(owner.login)}/events`
      : `/users/${encodeURIComponent(owner.login)}/events/public`;
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${base}?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "owner public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "owner-activity",
      undefined,
      env,
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function fetchRepoActivityEvents(
  path: string,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${path}/events?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "repository public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "repo-activity",
      undefined,
      env,
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function activityRepositories(events: OwnerActivityEvent[]): OwnerActivityRepository[] {
  const repos = new Map<string, OwnerActivityRepository>();
  for (const event of events) {
    const existing = repos.get(event.repo) ?? {
      fullName: event.repo,
      url: activityRepoUrl(event.repo),
      events: 0,
      commits: 0,
      lastActiveAt: event.createdAt,
    };
    existing.events += 1;
    existing.commits += event.kind === "commit" ? event.count : 0;
    if (Date.parse(event.createdAt) > Date.parse(existing.lastActiveAt)) {
      existing.lastActiveAt = event.createdAt;
    }
    repos.set(event.repo, existing);
  }
  return [...repos.values()].sort(
    (a, b) =>
      b.events - a.events ||
      Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) ||
      a.fullName.localeCompare(b.fullName),
  );
}

function activityTotals(events: OwnerActivityEvent[]): OwnerActivityPayload["totals"] {
  return {
    events: events.reduce((sum, event) => sum + event.count, 0),
    commits: events
      .filter((event) => event.kind === "commit")
      .reduce((sum, event) => sum + event.count, 0),
    pullRequests: events.filter((event) => event.kind === "pull_request").length,
    issues: events.filter((event) => event.kind === "issue").length,
    comments: events.filter((event) => event.kind === "comment").length,
    releases: events.filter((event) => event.kind === "release").length,
    repositories: new Set(events.map((event) => event.repo)).size,
  };
}

async function publicOwnerActivity(
  env: Env,
  payload: OwnerActivityPayload,
): Promise<OwnerActivityPayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    payload.events.map((event) => event.repo),
  );
  if (!privateNames) return null;
  if (privateNames.size === 0) return payload;
  const events = payload.events.filter((event) => !privateNames.has(event.repo.toLowerCase()));
  return {
    ...payload,
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
    summary: unavailableActivitySummary(
      activitySummaryModel(env),
      null,
      "Private repository activity was removed.",
    ),
  };
}

function activitySummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

type ActivitySummaryPayload = Pick<OwnerActivityPayload, "events" | "repositories">;

function activitySummaryEvents(payload: ActivitySummaryPayload): OwnerActivityEvent[] {
  return payload.events.slice(0, activitySummaryInputLimit);
}

function activitySummaryInput(payload: ActivitySummaryPayload): string {
  const summaryEvents = activitySummaryEvents(payload);
  if (summaryEvents.length === 0) return "";
  const topRepos = payload.repositories
    .slice(0, 8)
    .map((repo) => `${repo.fullName} (${repo.events} events, ${repo.commits} commits)`)
    .join(", ");
  const events = summaryEvents
    .map((event, index) =>
      [
        `${index + 1}. ${event.kind}`,
        event.repo,
        event.createdAt,
        event.count > 1 ? `${event.count} items` : "1 item",
        event.title,
      ].join(" · "),
    )
    .join("\n");
  return [`Top repositories: ${topRepos || "none"}`, "", events].join("\n");
}

function unavailableActivitySummary(
  model: string | null,
  inputHash: string | null,
  message: string,
): OwnerActivitySummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed: 0,
    promptVersion: activitySummaryPromptVersion,
    message,
  };
}

async function activitySummaryState(
  payload: ActivitySummaryPayload & Pick<OwnerActivityPayload, "owner" | "range">,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = ownerActivitySummaryCacheKey(
    payload.owner.login,
    payload.range,
    model,
    inputHash,
  );
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

function activitySummaryInstructions(): string {
  return [
    "You write the working-on paragraph for ReleaseBar owner dashboards.",
    "The UI already says this is a GitHub dashboard, shows the selected time range, and lists commit/PR/issue totals, so do not restate those facts.",
    "Do not use filler like public GitHub activity, recent activity, events, commits, PRs, has been working on, centered on, or touched repositories.",
    "Start with concrete work: systems, fixes, releases, docs, integrations, repo names, and themes that are directly supported by the event titles.",
    "Write 2-3 useful sentences, no bullets, no markdown, no hype.",
    "Do not infer private work, intentions, employers, or impact beyond the event titles.",
  ].join(" ");
}

function polishActivitySummaryText(text: string): string {
  return text
    .replace(/\bpublic GitHub activity\b/gi, "work")
    .replace(/\bGitHub activity\b/gi, "work")
    .replace(/\bpublic activity\b/gi, "work")
    .replace(/\brecent activity\b/gi, "work")
    .replace(/\bActivity also touched\b/g, "Also touched")
    .replace(/\s+/g, " ")
    .trim();
}

async function summarizeOwnerActivity(
  payload: OwnerActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 420,
      instructions: activitySummaryInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Owner: @${payload.owner.login}`,
                `Owner type: ${payload.owner.type}`,
                `Range: ${payload.range}`,
                `Events included: ${eventsUsed}`,
                "",
                input,
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include activity summary text");
  const summary = {
    state: "ready",
    text: polishActivitySummaryText(text),
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    ownerActivitySummaryCacheKey(payload.owner.login, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

async function buildOwnerActivity(
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<OwnerActivityPayload> {
  const requestToken = await bestInstallationToken(request, env, {
    owners: [ownerSlug],
    repos: [],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const owner = await resolveOwnerType(ownerSlug, {
    token: token ?? undefined,
    fetch: auditGitHubFetch("owner-activity", quotaSource, quotaAccount, env),
  });
  if (!owner) {
    throw new Error(`owner not found: ${ownerSlug}`);
  }
  const since = Date.now() - activityRangeMs(range);
  const events = await fetchOwnerActivityEvents(
    owner,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await activitySummaryState(payload, env),
  };
}

async function repoActivitySummaryState(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash);
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

async function summarizeRepoActivity(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 420,
      instructions: activitySummaryInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Repository: ${payload.fullName}`,
                `Range: ${payload.range}`,
                `Events included: ${eventsUsed}`,
                "",
                input,
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include activity summary text");
  const summary = {
    state: "ready",
    text: polishActivitySummaryText(text),
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

async function buildRepoActivity(
  owner: string,
  repoName: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<RepoDetailActivityPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository detail",
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
  const since = Date.now() - activityRangeMs(range);
  const events = await fetchRepoActivityEvents(
    path,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailActivityPayload = {
    fullName: repo.full_name,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await repoActivitySummaryState(payload, env),
  };
}

function withOwnerActivityState(
  payload: OwnerActivityPayload,
  state: OwnerActivityPayload["cache"]["state"],
  message = payload.cache.message,
): OwnerActivityPayload {
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

function ownerActivitySummaryNeedsRefresh(payload: OwnerActivityPayload | null, env: Env): boolean {
  return (
    payload?.summary?.state === "warming" ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

async function refreshOwnerActivitySummary(
  key: string,
  payload: OwnerActivityPayload,
  env: Env,
): Promise<void> {
  if (!ownerActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeOwnerActivity(payload, env);
    const latest = await publicOwnerActivity(env, (await readOwnerActivity(env, key)) ?? payload);
    if (!latest) return;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeOwnerActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = await publicOwnerActivity(env, (await readOwnerActivity(env, key)) ?? payload);
    if (!latest) return;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    await writeOwnerActivity(env, key, {
      ...latest,
      summary: {
        ...(latest.summary ?? payload.summary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function refreshOwnerActivity(
  key: string,
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await publicOwnerActivity(
      env,
      await buildOwnerActivity(ownerSlug, range, request, env),
    );
    if (!payload) return;
    await writeOwnerActivity(env, key, payload);
    if (ownerActivitySummaryNeedsRefresh(payload, env)) {
      await refreshOwnerActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

async function ownerActivityResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const ownerSlug = slugOwner(url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(ownerSlug)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }
  const range = activityRangeFromUrl(url);
  const key = ownerActivityCacheKey(ownerSlug, range);
  const rawCached = await readOwnerActivity(env, key);
  const cached = rawCached ? await publicOwnerActivity(env, rawCached) : null;
  const age = ownerActivityAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && age < activityCacheTtlMs(range)) {
    if (allowRefresh && ownerActivitySummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshOwnerActivitySummary(key, cached, env).catch(() => undefined));
    }
    return jsonResponse(cached, cached.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(
        refreshOwnerActivity(key, ownerSlug, range, request, env).catch(() => undefined),
      );
    }
    return jsonResponse(
      withOwnerActivityState(
        cached,
        "stale",
        allowRefresh ? "showing cached work while refreshing" : "showing cached work",
      ),
      200,
      { "cache-control": "no-store" },
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached owner activity unavailable for crawler");
  }

  try {
    const payload = await publicOwnerActivity(
      env,
      await buildOwnerActivity(ownerSlug, range, request, env),
    );
    if (!payload) {
      throw new Error("repository privacy metadata unavailable");
    }
    await writeOwnerActivity(env, key, payload);
    if (allowRefresh && ownerActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshOwnerActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withOwnerActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

function repoActivityAgeMs(payload: RepoDetailActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function withRepoActivityState(
  payload: RepoDetailActivityPayload,
  state: RepoDetailActivityPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailActivityPayload {
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

function repoActivitySummaryNeedsRefresh(
  payload: RepoDetailActivityPayload | null,
  env: Env,
): boolean {
  return (
    payload?.summary?.state === "warming" ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

async function refreshRepoActivitySummary(
  key: string,
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<void> {
  if (!repoActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeRepoActivity(payload, env);
    const latest = (await readRepoActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeRepoActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = (await readRepoActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    await writeRepoActivity(env, key, {
      ...latest,
      summary: {
        ...(latest.summary ?? payload.summary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function refreshRepoActivity(
  key: string,
  owner: string,
  repo: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (repoActivitySummaryNeedsRefresh(payload, env)) {
      await refreshRepoActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

async function repoActivityResponse(
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
  const range = activityRangeFromUrl(url);
  const key = repoActivityCacheKey(owner, repo, range);
  const cached = barrier === "clear" ? await readRepoActivity(env, key) : null;
  const age = repoActivityAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && age < activityCacheTtlMs(range)) {
    if (allowRefresh && repoActivitySummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, cached, env).catch(() => undefined));
    }
    return jsonResponse(cached, cached.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(
        refreshRepoActivity(key, owner, repo, range, request, env).catch(() => undefined),
      );
    }
    return jsonResponse(
      withRepoActivityState(
        cached,
        "stale",
        allowRefresh ? "showing cached work while refreshing" : "showing cached work",
      ),
      200,
      { "cache-control": "no-store" },
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached repository activity unavailable for crawler");
  }

  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (allowRefresh && repoActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withRepoActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

function lastPageFromLink(link: string | null): number | null {
  if (!link) return null;
  const last = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel="last"/.test(part));
  const match = last?.match(/[?&]page=(\d+)/);
  if (!match?.[1]) return null;
  const page = Number.parseInt(match[1], 10);
  return Number.isFinite(page) ? page : null;
}

function releaseProject(repo: InferOutput<typeof gitHubRepositorySchema>): Project {
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    language: repo.language,
    topics: repo.topics ?? [],
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    openPullRequests: 0,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived ?? false,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "unreleased",
    releaseName: null,
    releaseUrl: repo.html_url,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  };
}

function audienceRangeFromUrl(url: URL): AudienceRange {
  return url.searchParams.get("range")?.toLowerCase() === "week" ? "week" : "month";
}

function audienceRangeMs(range: AudienceRange): number {
  return range === "week" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

function repoAudienceCacheKey(owner: string, repo: string, range: AudienceRange): string {
  return `repo-audience:v5:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

function repoAudienceUserKey(login: string): string {
  return `audience-user:v1:${slugOwner(login)}`;
}

function repoAudienceUserOrgsKey(login: string): string {
  return `audience-user-orgs:v1:${slugOwner(login)}`;
}

function repoAudienceUserReposKey(login: string): string {
  return `audience-user-repos:v2:${slugOwner(login)}`;
}

function repoAudienceAgeMs(payload: RepoAudiencePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readRepoAudience(env: Env, key: string): Promise<RepoAudiencePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  const payload = raw ? tryJsonParse<RepoAudiencePayload>(raw, `repo audience ${key}`) : null;
  return payload ? publicRepoAudience(env, payload) : null;
}

async function writeRepoAudience(
  env: Env,
  key: string,
  payload: RepoAudiencePayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readAudienceUser(env: Env, login: string): Promise<GitHubUserProfile | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserKey(login));
  return raw ? safeJsonParse(gitHubUserProfileSchema, raw, `audience user ${login}`) : null;
}

async function writeAudienceUser(env: Env, user: GitHubUserProfile): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserKey(user.login), JSON.stringify(user), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function readAudienceUserOrgs(
  env: Env,
  login: string,
): Promise<GitHubUserOrganization[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserOrgsKey(login));
  return raw
    ? safeJsonParse(gitHubUserOrganizationListSchema, raw, `audience user orgs ${login}`)
    : null;
}

async function writeAudienceUserOrgs(
  env: Env,
  login: string,
  orgs: GitHubUserOrganization[],
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserOrgsKey(login), JSON.stringify(orgs), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function readAudienceUserRepos(
  env: Env,
  login: string,
): Promise<GitHubUserRepository[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserReposKey(login));
  const repos = raw
    ? safeJsonParse(gitHubUserRepositoryListSchema, raw, `audience user repos ${login}`)
    : null;
  return repos ? publicAudienceRepositories(env, repos) : null;
}

async function writeAudienceUserRepos(
  env: Env,
  login: string,
  repos: GitHubUserRepository[],
): Promise<void> {
  const publicRepos = await publicAudienceRepositories(env, repos);
  if (!publicRepos) return;
  await env.DASHBOARD_CACHE?.put(repoAudienceUserReposKey(login), JSON.stringify(publicRepos), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function audienceUserProfile(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserProfile | null> {
  const cached = await readAudienceUser(env, login);
  if (cached) return cached;
  const user = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}`,
    gitHubUserProfileSchema,
    "audience user profile",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  await writeAudienceUser(env, user);
  return user;
}

async function recentRepoStargazers(
  owner: string,
  repo: string,
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[]> {
  const graphql = await recentRepoStargazersGraphql(
    owner,
    repo,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (graphql) return graphql;
  return recentRepoStargazersRest(path, token, quotaSource, quotaAccount, onQuota, env);
}

async function recentRepoStargazersRest(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[]> {
  const firstPath = `${path}/stargazers?per_page=${repoAudienceStargazerLimit}`;
  const firstPage = await detailGitHubJsonWithHeaders(
    firstPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  const lastPage = lastPageFromLink(firstPage.headers.get("link"));
  if (!lastPage || lastPage <= 1) return firstPage.data;
  const lastPath = `${firstPath}&page=${lastPage}`;
  const last = await detailGitHubJson(
    lastPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  if (last.length >= repoAudienceStargazerLimit) return last;
  const previous = await detailGitHubJson(
    `${firstPath}&page=${lastPage - 1}`,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
    undefined,
    env,
  );
  return [...previous, ...last].slice(-repoAudienceStargazerLimit);
}

type GraphQLStargazerEdge = {
  starredAt: string | null;
  node: {
    login: string;
    avatarUrl: string;
    url: string;
    __typename?: string;
  } | null;
};

type GraphQLStargazerResponse = {
  data?: {
    repository?: {
      stargazers?: {
        edges?: GraphQLStargazerEdge[];
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

const repoStargazersQuery = /* GraphQL */ `
  query ReleaseBarRepoStargazers($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      stargazers(first: $first, orderBy: { field: STARRED_AT, direction: DESC }) {
        edges {
          starredAt
          node {
            __typename
            login
            avatarUrl
            url
          }
        }
      }
    }
  }
`;

async function recentRepoStargazersGraphql(
  owner: string,
  repo: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<GitHubStargazer[] | null> {
  if (!token) return null;
  if (
    await graphqlBackoffActive(env, quotaSource, quotaAccount, githubGraphqlRepoStargazersOperation)
  ) {
    if (quotaSource === "shared") {
      throw new GitHubRateLimitError("GitHub GraphQL backoff active", githubGraphqlBackoffSeconds);
    }
    return null;
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
    body: JSON.stringify({
      query: repoStargazersQuery,
      variables: { owner, name: repo, first: repoAudienceStargazerLimit },
    }),
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  const rateLimited = quota.source === "shared" ? await responseRateLimitSignal(response) : false;
  await recordAuditedGitHubAccess(
    env,
    "repo-audience",
    githubGraphqlAuditPath(githubGraphqlRepoStargazersOperation),
    response.status,
    quota,
    rateLimited,
  );
  if (response.status >= 500 && response.status < 600) {
    await markGraphqlBackoff(
      env,
      quota.source,
      quota.account,
      githubGraphqlRepoStargazersOperation,
      response.status,
    );
    if (quota.source === "shared") {
      throw new GitHubRateLimitError(
        "GitHub GraphQL temporarily unavailable",
        githubGraphqlBackoffSeconds,
      );
    }
    return null;
  }
  const body = (await response.json().catch(() => null)) as GraphQLStargazerResponse | null;
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
  if (!response.ok || body?.errors?.length) return null;
  const edges = body?.data?.repository?.stargazers?.edges ?? [];
  return edges
    .filter(
      (edge): edge is GraphQLStargazerEdge & { node: NonNullable<GraphQLStargazerEdge["node"]> } =>
        Boolean(edge.node?.login),
    )
    .map((edge) => ({
      starred_at: edge.starredAt,
      user: {
        login: edge.node.login,
        avatar_url: edge.node.avatarUrl,
        html_url: edge.node.url,
        type: edge.node.__typename,
      },
    }));
}

async function audienceUserOrgs(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserOrganization[]> {
  const cached = await readAudienceUserOrgs(env, login);
  if (cached) return cached;
  const orgs = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}/orgs?per_page=20`,
    gitHubUserOrganizationListSchema,
    "audience user orgs",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  await writeAudienceUserOrgs(env, login, orgs);
  return orgs;
}

async function audienceUserRepos(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserRepository[]> {
  const cached = await readAudienceUserRepos(env, login);
  if (cached) return cached;
  const reposPath =
    profileType === "Organization"
      ? `/orgs/${encodeURIComponent(login)}/repos?sort=updated&type=public&per_page=${repoAudienceUserRepoLimit}`
      : `/users/${encodeURIComponent(login)}/repos?sort=updated&type=owner&per_page=${repoAudienceUserRepoLimit}`;
  const repos = await detailGitHubJson(
    reposPath,
    gitHubUserRepositoryListSchema,
    "audience user repositories",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
    undefined,
    env,
  );
  const publicRepos = await publicAudienceRepositories(
    env,
    repos.filter(isPublicAudienceRepository),
  );
  if (!publicRepos) {
    throw new Error("repository privacy metadata unavailable");
  }
  await writeAudienceUserRepos(env, login, publicRepos);
  return publicRepos;
}

function isPublicAudienceRepository(repo: GitHubUserRepository): boolean {
  if (repo.private === true) return false;
  if (repo.visibility && repo.visibility !== "public") return false;
  return true;
}

async function publicAudienceRepositories(
  env: Env,
  repos: GitHubUserRepository[],
): Promise<GitHubUserRepository[] | null> {
  const privateNames = await privateRepositoryNames(
    env,
    repos.map((repo) => repo.full_name),
  );
  return privateNames
    ? repos.filter((repo) => !privateNames.has(repo.full_name.toLowerCase()))
    : null;
}

async function audienceUserInsights(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<{ orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] }> {
  const [orgs, repos] = await Promise.all([
    profileType === "Organization"
      ? Promise.resolve([])
      : audienceUserOrgs(login, env, token, quotaSource, quotaAccount, onQuota, auditArea).catch(
          (error) => {
            if (isGitHubRateLimit(error)) throw error;
            return [];
          },
        ),
    audienceUserRepos(
      login,
      env,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      profileType,
      auditArea,
    ).catch((error) => {
      if (isGitHubRateLimit(error)) throw error;
      return [];
    }),
  ]);
  return { orgs, repos };
}

function audienceOrgSignals(orgs: GitHubUserOrganization[]): AudienceOrgSignal[] {
  return orgs.slice(0, 8).map((org) => ({
    login: org.login,
    description: org.description,
  }));
}

function audienceRepoSignals(repos: GitHubUserRepository[]): AudienceRepoSignal[] {
  return repos
    .filter((repo) => !repo.archived && !repo.fork)
    .slice(0, repoAudienceUserRepoLimit)
    .map((repo) => ({
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
      topics: repo.topics ?? [],
    }));
}

function audienceUser(
  stargazer: GitHubStargazer,
  profile: GitHubUserProfile | null,
  insights: { orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] } | null,
  targetLanguage: string | null,
  targetTopics: string[],
): RepoAudienceUser {
  const login = profile?.login ?? stargazer.user.login;
  const orgs = audienceOrgSignals(insights?.orgs ?? []);
  const repos = audienceRepoSignals(insights?.repos ?? []);
  const score = calculateAudienceScore({
    login,
    accountType: profile?.type ?? stargazer.user.type ?? null,
    followers: profile?.followers ?? 0,
    following: profile?.following ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    publicGists: profile?.public_gists ?? 0,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    blog: profile?.blog ?? null,
    twitterUsername: profile?.twitter_username ?? null,
    accountCreatedAt: profile?.created_at ?? null,
    accountUpdatedAt: profile?.updated_at ?? null,
    starredAt: stargazer.starred_at,
    targetLanguage,
    targetTopics,
    orgs,
    repos,
  });
  return {
    login,
    avatarUrl: profile?.avatar_url ?? stargazer.user.avatar_url,
    url: profile?.html_url ?? stargazer.user.html_url,
    name: profile?.name ?? null,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    followers: profile?.followers ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    starredAt: stargazer.starred_at,
    score: score.score,
    tier: score.tier,
    reasons: score.reasons,
    dimensions: score.dimensions,
    factors: score.factors,
    orgs,
    topRepositories: repos
      .sort(
        (a, b) => b.stars - a.stars || b.forks - a.forks || a.fullName.localeCompare(b.fullName),
      )
      .slice(0, 3)
      .map((repo) => ({
        fullName: repo.fullName,
        url: repo.url,
        description: repo.description,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        updatedAt: repo.pushedAt ?? repo.updatedAt,
      })),
    accountCreatedAt: profile?.created_at ?? null,
  };
}

async function publicRepoAudience(
  env: Env,
  payload: RepoAudiencePayload,
): Promise<RepoAudiencePayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    payload.users.flatMap((user) => (user.topRepositories ?? []).map((repo) => repo.fullName)),
  );
  if (!privateNames) return null;
  if (privateNames.size === 0) return payload;
  return {
    ...payload,
    users: payload.users.map((user) => ({
      ...user,
      topRepositories: (user.topRepositories ?? []).filter(
        (repo) => !privateNames.has(repo.fullName.toLowerCase()),
      ),
    })),
  };
}

function roundedPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function audienceTotals(
  users: RepoAudienceUser[],
  totalStargazers: number,
): RepoAudiencePayload["totals"] {
  const count = (tier: AudienceScoreTier) => users.filter((user) => user.tier === tier).length;
  const highSignal = count("high");
  const mediumSignal = count("medium");
  const lowSignal = count("low");
  const bots = count("bot");
  const scored = users.length;
  return {
    stargazers: totalStargazers,
    stargazersSampled: scored,
    highSignal,
    mediumSignal,
    lowSignal,
    bots,
    highSignalPercent: roundedPercent(highSignal, scored),
    mediumSignalPercent: roundedPercent(mediumSignal, scored),
    lowSignalPercent: roundedPercent(lowSignal, scored),
    botPercent: roundedPercent(bots, scored),
  };
}

function trustProfileCacheKey(login: string): string {
  return `trust-profile:v4:${slugOwner(login)}`;
}

function trustProfileAgeMs(payload: TrustProfilePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readTrustProfile(env: Env, key: string): Promise<TrustProfilePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  const payload = raw ? tryJsonParse<TrustProfilePayload>(raw, `trust profile ${key}`) : null;
  return payload ? publicTrustProfile(env, payload) : null;
}

async function publicTrustProfile(
  env: Env,
  payload: TrustProfilePayload,
): Promise<TrustProfilePayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    (payload.topRepositories ?? []).map((repo) => repo.fullName),
  );
  if (!privateNames) return null;
  if (privateNames.size === 0) return payload;
  return {
    ...payload,
    topRepositories: (payload.topRepositories ?? []).filter(
      (repo) => !privateNames.has(repo.fullName.toLowerCase()),
    ),
    stats: {
      ...payload.stats,
      totalStars: 0,
      totalForks: 0,
      recentRepositories: 0,
      activeRepositories: 0,
      languages: [],
      topics: [],
    },
  };
}

function userTrustSignal(profile: TrustProfilePayload | null): UserTrustSignal | null {
  if (!profile || profile.profileKind !== "user_trust") return null;
  return { score: profile.score, tier: profile.tier };
}

async function cachedUserTrustSignals(
  env: Env,
  logins: Array<string | null | undefined>,
): Promise<Map<string, UserTrustSignal>> {
  const signals = new Map<string, UserTrustSignal>();
  if (!env.DASHBOARD_CACHE) return signals;
  const slugs = Array.from(
    new Set(
      logins
        .filter((login): login is string => Boolean(login))
        .map(slugOwner)
        .filter(validOwnerSlug),
    ),
  );
  await Promise.all(
    slugs.map(async (login) => {
      const signal = userTrustSignal(await readTrustProfile(env, trustProfileCacheKey(login)));
      if (signal) signals.set(login, signal);
    }),
  );
  return signals;
}

async function withRepoAudienceTrustProfiles(
  payload: RepoAudiencePayload,
  env: Env,
): Promise<RepoAudiencePayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.users.map((user) => user.login),
  );
  return {
    ...payload,
    users: payload.users.map((user) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = user;
      const signal = signals.get(slugOwner(user.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

async function withRepoDetailContributorTrustProfiles(
  payload: RepoDetailPayload,
  env: Env,
): Promise<RepoDetailPayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.contributors.map((contributor) => contributor.login),
  );
  return {
    ...payload,
    contributors: payload.contributors.map((contributor) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = contributor;
      const signal = signals.get(slugOwner(contributor.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

async function writeTrustProfile(
  env: Env,
  key: string,
  payload: TrustProfilePayload,
): Promise<void> {
  const publicPayload = await publicTrustProfile(env, payload);
  if (!publicPayload) return;
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(publicPayload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function refreshTrustProfile(
  key: string,
  login: string,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await publicTrustProfile(env, await buildTrustProfile(login, request, env));
    if (!payload) return;
    await writeTrustProfile(env, key, payload);
  } finally {
    await lock.release();
  }
}

function signalCounts(
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

function usefulSignalName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function topTrustRepositories(repos: AudienceRepoSignal[]): TrustProfilePayload["topRepositories"] {
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

function clampProfileScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreTier(score: number): AudienceScoreTier {
  return score >= 70 ? "high" : score >= 40 ? "medium" : "low";
}

function retitleFactor(
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

function orgSignalScore(
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

async function buildTrustProfile(
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

function withTrustProfileState(
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

async function trustProfileResponse(
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

function withRepoAudienceState(
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

async function buildRepoAudience(
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

async function refreshRepoAudience(
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

async function repoAudienceResponse(
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

async function repoAudienceBackfillResponse(request: Request, env: Env): Promise<Response> {
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

function repoDetailCacheKey(owner: string, repo: string): string {
  return `repo-detail:v4:${slugOwner(owner)}/${repo.toLowerCase()}`;
}

function releaseSummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

function releaseSummaryCacheKey(project: Project, model: string): string | null {
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return null;
  }
  return [
    `release-summary:v${releaseSummaryPromptVersion}`,
    project.fullName.toLowerCase(),
    encodeURIComponent(project.version),
    project.latestCommitSha,
    encodeURIComponent(model),
  ].join(":");
}

async function readRepoDetail(env: Env, key: string): Promise<RepoDetailPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailPayload>(raw, `repo detail ${key}`) : null;
}

async function writeRepoDetail(env: Env, key: string, payload: RepoDetailPayload): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readReleaseSummary(
  env: Env,
  key: string | null,
): Promise<RepoDetailReleaseSummary | null> {
  if (!key) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailReleaseSummary>(raw, `release summary ${key}`) : null;
}

async function writeReleaseSummary(
  env: Env,
  key: string,
  summary: RepoDetailReleaseSummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function repoDetailAgeMs(payload: RepoDetailPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function withRepoDetailState(
  payload: RepoDetailPayload,
  state: RepoDetailPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailPayload {
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

async function optionalRepoDetail<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isGitHubRateLimit(error)) throw error;
    return fallback;
  }
}

function unavailableReleaseSummary(
  project: Project,
  model: string | null,
  message: string,
): RepoDetailReleaseSummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.releaseDate ? project.version : null,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message,
  };
}

async function releaseSummaryState(project: Project, env: Env): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!project.releaseDate || project.version === "unreleased") {
    return unavailableReleaseSummary(project, model, "No prior release to summarize.");
  }
  if (!project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "Latest commit is unavailable.");
  }
  if (project.commitsSinceRelease === null) {
    return unavailableReleaseSummary(project, model, "Commit comparison is unavailable.");
  }
  if (project.commitsSinceRelease === 0) {
    return {
      state: "ready",
      text: "No commits have landed since the latest release.",
      generatedAt: new Date().toISOString(),
      model,
      releaseTag: project.version,
      headSha: project.latestCommitSha,
      commitCount: 0,
      commitsUsed: 0,
    };
  }
  const key = releaseSummaryCacheKey(project, model);
  const cached = await readReleaseSummary(env, key);
  if (cached?.state === "ready") return cached;
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message: "Summarizing commits since the latest release.",
  };
}

function commitTitle(message: string): string {
  return message.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
}

async function compareCommitTitles(
  path: string,
  releaseTag: string,
  head: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<{ titles: string[]; total: number | null }> {
  const titles: string[] = [];
  let total: number | null = null;
  for (let page = 1; titles.length < releaseSummaryCommitLimit; page += 1) {
    const compare = await detailGitHubJson(
      `${path}/compare/${encodeURIComponent(releaseTag)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      gitHubCompareSchema,
      "release summary compare",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "release-summary",
      undefined,
      env,
    );
    total = compare.total_commits ?? total;
    const pageTitles = (compare.commits ?? [])
      .map((commit) => commitTitle(commit.commit.message))
      .filter(Boolean);
    titles.push(...pageTitles);
    if (pageTitles.length === 0 || (total !== null && titles.length >= total)) break;
  }
  return { titles: titles.slice(0, releaseSummaryCommitLimit), total };
}

function openAIOutputText(body: unknown): string {
  if (body && typeof body === "object" && "output_text" in body) {
    const text = (body as { output_text?: unknown }).output_text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const output = body && typeof body === "object" ? (body as { output?: unknown }).output : null;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => {
      const content =
        item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function summarizeReleaseDelta(
  project: Project,
  path: string,
  request: Request,
  env: Env,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "No comparable release delta is available.");
  }
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [project.fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = () => undefined;
  const { titles, total } = await compareCommitTitles(
    path,
    project.version,
    project.latestCommitSha,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (titles.length === 0) {
    return unavailableReleaseSummary(
      project,
      model,
      "No commit titles were available to summarize.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 450,
      instructions:
        "You summarize public GitHub commit titles for release dashboards. Write 2-4 concise sentences, past tense, no bullets, no hype, no markdown. Mention broad themes and user-visible changes when commit titles support them. Do not invent details beyond the commit titles.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Repository: ${project.fullName}`,
                `Latest release: ${project.version}`,
                `Default branch head: ${project.latestCommitSha}`,
                `Commit titles included: ${titles.length} of ${total ?? project.commitsSinceRelease ?? titles.length}`,
                "",
                titles.map((title, index) => `${index + 1}. ${title}`).join("\n"),
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include summary text");
  return {
    state: "ready",
    text,
    generatedAt: new Date().toISOString(),
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: total ?? project.commitsSinceRelease,
    commitsUsed: titles.length,
  };
}

type ContributorTrustSignal = UserTrustSignal;

async function cachedContributorTrustSignals(
  env: Env,
  contributors: Array<InferOutput<typeof gitHubContributorSchema>>,
): Promise<Map<string, ContributorTrustSignal>> {
  const logins = Array.from(
    new Set(
      contributors
        .map((contributor) => contributor.login)
        .filter((login): login is string => Boolean(login))
        .map(slugOwner),
    ),
  );
  return cachedUserTrustSignals(env, logins);
}

async function buildRepoDetail(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<RepoDetailPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
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
    "repository detail",
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

  const [releases, contributors, languages, latestCommit, openPullRequests] = await Promise.all([
    cachedDetailGitHubJson(
      "releases",
      `${path}/releases?per_page=100`,
      v.array(gitHubReleaseSchema),
      "repository releases",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      undefined,
      undefined,
      env,
      repoDetailReleaseCacheTtlMs,
    ),
    optionalRepoDetail(
      cachedDetailGitHubJson(
        "contributors",
        `${path}/contributors?per_page=12`,
        v.array(gitHubContributorSchema),
        "repository contributors",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        undefined,
        undefined,
        env,
      ),
      [],
    ),
    optionalRepoDetail(
      cachedDetailGitHubJson(
        "languages",
        `${path}/languages`,
        gitHubLanguageSchema,
        "repository languages",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        undefined,
        undefined,
        env,
      ),
      {},
    ),
    optionalRepoDetail(
      cachedDetailGitHubJson(
        "latest-commit",
        `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
        gitHubCommitSchema,
        "latest commit",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        undefined,
        undefined,
        env,
        repoDetailLiveProbeCacheTtlMs,
      ),
      null,
    ),
    cachedDetailGitHubCount(
      "open-pulls",
      `${path}/pulls?state=open&per_page=1`,
      repoDetailLiveProbeCacheTtlMs,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      undefined,
      env,
    ),
  ]);

  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        cachedDetailGitHubJson(
          "compare",
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "release compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          undefined,
          env,
          repoDetailLiveProbeCacheTtlMs,
        ),
        null,
      )
    : null;
  const checks = latestCommit?.sha
    ? await optionalRepoDetail(
        cachedDetailGitHubJson(
          "check-runs",
          `${path}/commits/${encodeURIComponent(latestCommit.sha)}/check-runs?per_page=100`,
          gitHubCheckRunsSchema,
          "repository check runs",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          undefined,
          env,
          repoDetailLiveProbeCacheTtlMs,
        ),
        null,
      )
    : null;

  const [commitActivity, workTrend] = await Promise.all([
    detailGitHubStats(
      `${path}/stats/commit_activity`,
      gitHubCommitActivitySchema,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      undefined,
      env,
    ),
    buildWorkTrend(repo.full_name, token, quotaSource, quotaAccount, onQuota, undefined, env).catch(
      () => null,
    ),
  ]);
  const codeFrequency =
    commitActivity.state === "warming"
      ? {
          state: "warming" as const,
          data: null,
          message: commitActivity.message ?? "GitHub is preparing repository statistics.",
        }
      : await detailGitHubStats(
          `${path}/stats/code_frequency`,
          gitHubCodeFrequencySchema,
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          undefined,
          env,
        );
  const statsWarming = [commitActivity, codeFrequency].some((stat) => stat.state === "warming");
  const project = releaseProject(repo);
  project.openPullRequests = openPullRequests;
  project.openIssues = Math.max(repo.open_issues_count - openPullRequests, 0);
  project.latestCommitSha = latestCommit?.sha.slice(0, 7) ?? null;
  project.latestCommitDate = latestCommit?.commit.committer?.date ?? null;
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  const ci = detailCiDetails(checks?.check_runs ?? []);
  project.ciStatus = ci.ciStatus;
  project.ciConclusion = ci.ciConclusion;
  project.ciWorkflow = ci.ciWorkflow;
  project.ciUrl = ci.ciUrl;
  project.ciRunDate = ci.ciRunDate;
  project.ciState = ci.ciState;
  const [releaseSummary, contributorTrustSignals] = await Promise.all([
    releaseSummaryState(project, env),
    cachedContributorTrustSignals(env, contributors),
  ]);

  const generatedAt = new Date().toISOString();
  return {
    fullName: repo.full_name,
    generatedAt,
    cache: {
      state: statsWarming ? "warming" : "fresh",
      stale: statsWarming,
      generatedAt,
      ...(statsWarming ? { message: "GitHub is preparing repository statistics." } : {}),
      ...(quota ? { quota } : {}),
    },
    stats: {
      commitActivity: {
        state: commitActivity.state,
        ...(commitActivity.message ? { message: commitActivity.message } : {}),
      },
      codeFrequency: {
        state: codeFrequency.state,
        ...(codeFrequency.message ? { message: codeFrequency.message } : {}),
      },
    },
    releaseSummary,
    project,
    releases: releases
      .filter((release) => !release.draft)
      .map((release) => ({
        name: release.name,
        tagName: release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        prerelease: release.prerelease ?? false,
      })),
    contributors: contributors.map((contributor) => {
      const login = contributor.login ?? "anonymous";
      const trustSignal = contributorTrustSignals.get(slugOwner(login));
      return {
        login,
        avatarUrl: contributor.avatar_url ?? null,
        url: contributor.html_url ?? null,
        commits: contributor.contributions,
        ...(trustSignal ? { trustScore: trustSignal.score, trustTier: trustSignal.tier } : {}),
      };
    }),
    commitActivity: (commitActivity.data ?? []).map((week) => ({
      week: new Date(week.week * 1000).toISOString(),
      total: week.total,
      days: week.days,
    })),
    codeFrequency: (codeFrequency.data ?? []).map(([week, additions, deletions]) => ({
      week: new Date(week * 1000).toISOString(),
      additions,
      deletions: Math.abs(deletions),
    })),
    languages: Object.entries(languages)
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    workTrend,
  };
}

function freshnessForDetail(commits: number | null): Project["freshness"] {
  if (commits === 0) return "fresh";
  if (commits !== null && commits <= 5) return "warm";
  if (commits !== null && commits <= 25) return "busy";
  return "hot";
}

type DetailCheckRun = NonNullable<InferOutput<typeof gitHubCheckRunsSchema>["check_runs"]>[number];

function detailCiDetails(
  runs: DetailCheckRun[],
): Pick<Project, "ciState" | "ciStatus" | "ciConclusion" | "ciWorkflow" | "ciUrl" | "ciRunDate"> {
  if (runs.length === 0) {
    return {
      ciState: "unknown",
      ciStatus: null,
      ciConclusion: null,
      ciWorkflow: null,
      ciUrl: null,
      ciRunDate: null,
    };
  }

  const failure = runs.find((run) =>
    ["failure", "timed_out", "action_required"].includes(run.conclusion ?? ""),
  );
  const active = runs.find((run) => run.status && run.status !== "completed");
  const cancelled = runs.find((run) => run.conclusion === "cancelled");
  const successCount = runs.filter((run) => run.conclusion === "success").length;
  const neutralCount = runs.filter((run) => run.conclusion === "neutral").length;
  const skippedCount = runs.filter((run) => run.conclusion === "skipped").length;
  const selected = failure ?? active ?? cancelled ?? runs[0];

  let ciState: Project["ciState"] = "unknown";
  if (failure) {
    ciState = "failure";
  } else if (active) {
    ciState = active.status === "in_progress" ? "running" : "pending";
  } else if (cancelled) {
    ciState = "cancelled";
  } else if (successCount > 0) {
    ciState = "success";
  } else if (neutralCount > 0) {
    ciState = "neutral";
  } else if (skippedCount > 0) {
    ciState = "skipped";
  }

  return {
    ciState,
    ciStatus: selected.status ?? null,
    ciConclusion: selected.conclusion ?? null,
    ciWorkflow:
      ciState === "success" ? `${successCount}/${runs.length} checks` : (selected.name ?? null),
    ciUrl: selected.html_url ?? null,
    ciRunDate: selected.completed_at ?? selected.started_at ?? null,
  };
}

async function refreshRepoDetail(
  key: string,
  owner: string,
  repo: string,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await buildRepoDetail(owner, repo, request, env);
    await writeRepoDetail(env, key, payload);
  } finally {
    await lock.release();
  }
}

function releaseSummaryNeedsRefresh(payload: RepoDetailPayload | null, env: Env): boolean {
  const hasComparableCommits =
    !!payload?.project.releaseDate &&
    payload.project.version !== "unreleased" &&
    !!payload.project.latestCommitSha &&
    payload.project.commitsSinceRelease !== null &&
    payload.project.commitsSinceRelease > 0;
  return (
    payload?.releaseSummary?.state === "warming" ||
    (hasComparableCommits &&
      !!payload?.releaseSummary &&
      payload.releaseSummary.model !== releaseSummaryModel(env))
  );
}

async function refreshReleaseSummary(
  key: string,
  owner: string,
  repo: string,
  payload: RepoDetailPayload,
  request: Request,
  env: Env,
): Promise<void> {
  if (!env.OPENAI_API_KEY || !releaseSummaryNeedsRefresh(payload, env)) return;
  const lock = await acquireBuildLock(env, `${key}:release-summary`);
  if (!lock) return;
  try {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const summary = await summarizeReleaseDelta(payload.project, path, request, env);
    const summaryKey = releaseSummaryCacheKey(
      payload.project,
      summary.model ?? releaseSummaryModel(env),
    );
    if (summaryKey && summary.state === "ready") {
      await writeReleaseSummary(env, summaryKey, summary);
    }
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: summary,
    });
  } catch (error) {
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: {
        ...(latest.releaseSummary ?? payload.releaseSummary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: releaseSummaryModel(env),
        releaseTag: latest.project.releaseDate ? latest.project.version : null,
        headSha: latest.project.latestCommitSha,
        commitCount: latest.project.commitsSinceRelease,
        commitsUsed: 0,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function repoDetailResponse(
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

  const key = repoDetailCacheKey(owner, repo);
  const cached = barrier === "clear" ? await readRepoDetail(env, key) : null;
  const ageMs = repoDetailAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached?.cache.state === "warming" && ageMs < repoDetailWarmingRefreshMs) {
    if (allowRefresh && releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(await withRepoDetailContributorTrustProfiles(cached, env), 202, {
      "cache-control": "no-store",
    });
  }
  if (cached && ageMs < repoDetailCacheTtlMs && cached.cache.state !== "warming") {
    if (allowRefresh && releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(await withRepoDetailContributorTrustProfiles(cached, env));
  }
  if (cached && ageMs <= maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
    }
    if (allowRefresh && releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(
        withRepoDetailState(
          cached,
          "stale",
          allowRefresh
            ? "refreshing repository statistics"
            : "showing cached repository statistics",
        ),
        env,
      ),
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached repository statistics unavailable for crawler");
  }

  try {
    const payload = await buildRepoDetail(owner, repo, request, env);
    await writeRepoDetail(env, key, payload);
    if (allowRefresh && releaseSummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, payload, request, env));
    }
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(payload, env),
      payload.cache.state === "warming" ? 202 : 200,
      {
        "cache-control": payload.cache.state === "warming" ? "no-store" : "public, max-age=60",
      },
    );
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

async function cachedRepoInitialData(env: Env, fullName: string): Promise<InitialPageData | null> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  if ((await repositoryPublicCacheBarrier(env, fullName)) !== "clear") return null;
  const cached = await readRepoDetail(env, repoDetailCacheKey(owner, repo));
  if (!cached || repoDetailAgeMs(cached) > maxDisplayStaleMs) return null;
  const payload =
    repoDetailAgeMs(cached) < repoDetailCacheTtlMs
      ? cached
      : withRepoDetailState(cached, "stale", "refreshing repository statistics");
  return { route: "repo", payload };
}

function discoverFreshness(repo: GitHubSearchRepository): Project["freshness"] {
  const stars = repo.stargazers_count ?? 0;
  const pushedAt = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
  const ageDays = pushedAt ? Math.max(0, (Date.now() - pushedAt) / 86400000) : 365;
  if (stars >= 1000 && ageDays <= 7) return "hot";
  if (stars >= 250 && ageDays <= 30) return "busy";
  return "warm";
}

function discoverProject(repo: GitHubSearchRepository): Project {
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

function isRepositorySearchProject(project: Project): boolean {
  return (
    project.version === "repo search" &&
    project.releaseDate === null &&
    project.commitsSinceRelease === null &&
    project.compareUrl === null
  );
}

function discoverNeedsHydration(payload: DashboardPayload): boolean {
  if (payload.cache?.progress?.done === true) return false;
  return payload.projects.slice(0, discoverHydrateLimit).some(isRepositorySearchProject);
}

function discoverErrorPayload(
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

function discoveryErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub repository search quota is exhausted. Try again after the search quota resets.";
  }
  return dashboardErrorMessage(error);
}

async function discoverPayload(
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

type DiscoverHydratedProject = {
  project: Project;
  quota: ApiQuota | null;
};

async function hydrateDiscoverProject(
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

async function hydrateDiscoverPayload(
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

async function hydrateDiscoverCache(
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

async function discoverResponse(
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

async function cachedDiscoverInitialData(env: Env, url: URL): Promise<InitialPageData | null> {
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

async function dashboardCacheKeyForPage(
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

async function cachedDashboardInitialData(
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

async function dashboardEventParts(request: Request, env: Env): Promise<{ key: string } | null> {
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

function sleep(ms: number): Promise<void> {
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

async function ownerEventsResponse(request: Request, env: Env): Promise<Response> {
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

async function acquireBuildLock(env: Env, key: string): Promise<BuildLock | null> {
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

async function rebuild(
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

async function rebuildWithBuildLock(
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

async function sharedQuotaDashboardCooldown(
  dashboard: DashboardRequest,
  env: Env,
): Promise<SharedQuotaCooldown | null> {
  const source =
    dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous");
  return source === "shared" && env.GITHUB_TOKEN ? sharedQuotaCooldown(env) : null;
}

async function progressiveBuildPausedForSharedQuota(
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

async function continueProgressiveBuild(
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

function scheduleProgressiveBuild(
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

async function refreshDashboardMetadataFirst(
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

function dashboardPayloadFromProgress(
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

function errorPayload(dashboard: DashboardRequest, env: Env, message: string): DashboardPayload {
  return statusPayload(dashboard, env, "error", message, new Date().toISOString());
}

function unresolvedDashboardRequest(
  ownerSlugs: string[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    ownerSlugs.map((login) => ({ type: "user", login })),
    includeRepos,
    profile,
    key,
    url,
    includeReleaseData,
    token,
  );
}

function rebuildingPayload(dashboard: DashboardRequest, env: Env): DashboardPayload {
  return statusPayload(
    dashboard,
    env,
    "rebuilding",
    "dashboard build queued",
    new Date().toISOString(),
  );
}

function statusPayload(
  dashboard: DashboardRequest,
  env: Env,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message: string,
  generatedAt: string,
): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: dashboard.subtitle,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: dashboard.owners,
    ...(dashboard.profile ? { profile: dashboard.profile } : {}),
    options: {
      ...optionsFromUrl(dashboard.url),
      repoLimit,
    },
    cache: {
      state,
      stale: true,
      capped: false,
      repoLimit,
      generatedAt,
      countsUpdatedAt: null,
      projectCountsUpdatedAt: {},
      releasesUpdatedAt: null,
      ciUpdatedAt: null,
      quota: quotaForDashboard(dashboard, env),
      message,
    },
    totals: {
      repos: 0,
      released: 0,
      unreleased: 0,
      commitsSinceRelease: 0,
    },
    projects: [],
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function profileFromInput(owner: string, input: ProfileInput, user: AuthUser): DashboardProfile {
  const normalizedOwner = slugOwner(owner);
  const includeOwners = uniqueSorted(
    stringList(input.includeOwners)
      .map(slugOwner)
      .filter((value) => validOwnerSlug(value) && value !== normalizedOwner),
  );
  const includeRepos = uniqueSorted(
    stringList(input.includeRepos)
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter(validRepoSlug),
  );
  if (includeOwners.length + includeRepos.length > maxCustomSources) {
    throw new Error(`too many custom sources; max ${maxCustomSources}`);
  }
  return {
    owner: normalizedOwner,
    includeOwners,
    includeRepos,
    hiddenOwners: uniqueSorted(
      stringList(input.hiddenOwners).map(slugOwner).filter(validOwnerSlug),
    ),
    hiddenRepos: uniqueSorted(
      stringList(input.hiddenRepos)
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
    updatedAt: new Date().toISOString(),
    updatedBy: user.login,
  };
}

async function profileResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const owner = slugOwner(url.pathname.replace(/^\/api\/profile\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(owner)) {
    return jsonResponse({ error: "invalid owner" }, 400, { "cache-control": "no-store" });
  }
  const session = await currentSession(request, env);
  const canEdit = session?.user.login.toLowerCase() === owner;

  if (request.method === "GET") {
    return jsonResponse({ profile: await readProfile(env, owner), canEdit }, 200, {
      "cache-control": "no-store",
    });
  }
  if (!session) {
    return jsonResponse({ error: "login required" }, 401, { "cache-control": "no-store" });
  }
  if (!canEdit) {
    return jsonResponse({ error: "only the dashboard owner can edit this default" }, 403, {
      "cache-control": "no-store",
    });
  }
  if (request.method === "DELETE") {
    await deleteProfile(env, owner);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile: null, canEdit: true }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405, {
      allow: "GET, POST, DELETE",
      "cache-control": "no-store",
    });
  }

  const input = (await request.json().catch(() => null)) as ProfileInput | null;
  if (!input) {
    return jsonResponse({ error: "invalid profile" }, 400, { "cache-control": "no-store" });
  }
  try {
    const profile = profileFromInput(owner, input, session.user);
    await writeProfile(env, profile);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile, canEdit: true }, 200, { "cache-control": "no-store" });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, { "cache-control": "no-store" });
  }
}

async function adminResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/scheduler" && request.method === "GET") {
    return jsonResponse(await schedulerAdminPayload(env), 200, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/admin/github-access" && request.method === "GET") {
    const hours = Math.max(
      1,
      Math.min(
        72,
        Number.parseInt(url.searchParams.get("hours") ?? "", 10) || githubAccessAdminHours,
      ),
    );
    return jsonResponse(await githubAccessSummary(env, hours), 200, {
      "cache-control": "no-store",
    });
  }
  if (url.pathname === "/api/admin/installations" && request.method === "GET") {
    return jsonResponse(await authFunnelSummary(env), 200, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/admin/installations/sync" && request.method === "POST") {
    try {
      const installations = await syncGithubAppInstallations(env);
      return jsonResponse({ ok: true, installations, count: installations.length }, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: errorMessage(error) }, 400, {
        "cache-control": "no-store",
      });
    }
  }
  if (url.pathname === "/api/admin/scheduler/run" && request.method === "POST") {
    const result = await schedulerTick(
      env,
      context,
      `manual:${admin.user.login}`,
      schedulerBatchLimit,
    );
    return jsonResponse({ ok: true, ...result }, 200, { "cache-control": "no-store" });
  }
  return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
}

async function ownerResponse(
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

function cachedDashboardRequest(
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

function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    profile,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
    includeReleaseData,
    ...hydrationOptionsFromUrl(url),
    ...(token
      ? {
          token: token.token,
          quotaSource: token.quotaSource,
          quotaAccount: token.quotaAccount,
        }
      : {}),
  };
}

export class DashboardBuildLock {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/acquire") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) {
        return new Response(null, { status: 400 });
      }
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing && existing.expiresAt > Date.now()) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: body.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/release") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing?.token === body?.token) {
        await this.state.storage.delete("lock");
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/refresh") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (!existing || existing.token !== body?.token) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: existing.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/target-index/upsert") {
      const target = await request.json().catch(() => null);
      if (!isRefreshTarget(target)) {
        return new Response(null, { status: 400 });
      }
      if (
        new TextEncoder().encode(JSON.stringify(target)).byteLength >
        durableRefreshTargetEntryLimitBytes
      ) {
        return jsonResponse({ error: "refresh target too large" }, 413, {
          "cache-control": "no-store",
        });
      }
      const upsert = async () => {
        const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
        const stored =
          (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
        const targets = new Map(
          stored
            .filter(
              (candidate) => isRefreshTarget(candidate) && safeIso(candidate.lastSeenAt) >= cutoff,
            )
            .map((candidate) => [candidate.key, candidate]),
        );
        const created = !targets.has(target.key);
        if (created && targets.size >= refreshTargetSourceLimit) {
          return jsonResponse({ error: "refresh target source limit reached" }, 429, {
            "cache-control": "no-store",
          });
        }
        targets.set(target.key, target);
        const updated = [...targets.values()]
          .sort((left, right) => safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt))
          .slice(0, durableRefreshTargetIndexLimit);
        if (
          new TextEncoder().encode(JSON.stringify(updated)).byteLength >
          durableRefreshTargetIndexLimitBytes
        ) {
          return jsonResponse({ error: "refresh target source byte limit reached" }, 429, {
            "cache-control": "no-store",
          });
        }
        await this.state.storage.put("refresh-target-index", updated);
        return new Response(null, {
          status: 204,
          headers: { "x-refresh-target-created": String(created) },
        });
      };
      return this.state.blockConcurrencyWhile ? this.state.blockConcurrencyWhile(upsert) : upsert();
    }

    if (url.pathname === "/target-index/delete") {
      const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
      if (typeof body?.key !== "string") {
        return new Response(null, { status: 400 });
      }
      const remove = async () => {
        const stored =
          (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
        const updated = stored.filter(
          (target) => isRefreshTarget(target) && target.key !== body.key,
        );
        if (updated.length === 0) {
          await this.state.storage.delete("refresh-target-index");
        } else if (updated.length !== stored.length) {
          await this.state.storage.put("refresh-target-index", updated);
        }
        return new Response(null, { status: 204 });
      };
      return this.state.blockConcurrencyWhile ? this.state.blockConcurrencyWhile(remove) : remove();
    }

    if (url.pathname === "/target-index/list") {
      const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
      const stored = (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
      const targets = stored
        .filter((target) => isRefreshTarget(target) && safeIso(target.lastSeenAt) >= cutoff)
        .sort(compareWebhookTargets);
      return Response.json(targets.slice(0, durableRefreshTargetIndexLimit));
    }

    if (url.pathname === "/target-index/page") {
      const body = (await request.json().catch(() => null)) as {
        cursor?: unknown;
        limit?: unknown;
      } | null;
      const cursor = typeof body?.cursor === "string" ? body.cursor : "";
      const limit =
        typeof body?.limit === "number"
          ? Math.max(1, Math.min(webhookTargetPageSize, Math.floor(body.limit)))
          : webhookTargetPageSize;
      const cutoff = Date.now() - dashboardStorageTtlSeconds * 1000;
      const stored = (await this.state.storage.get<RefreshTarget[]>("refresh-target-index")) ?? [];
      const targets = stored
        .filter(
          (target) =>
            isRefreshTarget(target) &&
            safeIso(target.lastSeenAt) >= cutoff &&
            (!cursor || target.key > cursor),
        )
        .sort((left, right) => left.key.localeCompare(right.key));
      const page = targets.slice(0, limit);
      return Response.json({
        targets: page,
        nextCursor: page.length < targets.length ? (page.at(-1)?.key ?? null) : null,
      });
    }

    if (url.pathname === "/owner-metadata/read") {
      const body = (await request.json().catch(() => null)) as { owner?: unknown } | null;
      const owner = typeof body?.owner === "string" ? slugOwner(body.owner) : "";
      if (!validOwnerSlug(owner)) {
        return new Response(null, { status: 400 });
      }
      const read = async () => {
        let stored = normalizeOwnerMetadataSnapshot(
          owner,
          await this.state.storage.get<OwnerMetadataSnapshot>("owner-metadata"),
        );
        if (stored && Date.now() - safeIso(stored.generatedAt) > ownerMetadataTtlSeconds * 1000) {
          await this.state.storage.delete("owner-metadata");
          stored = null;
        }
        const cached = await readOwnerMetadataKv(this.env, owner);
        const snapshot = reconcileOwnerMetadataSnapshots(owner, stored, cached, true);
        if (snapshot) {
          await this.state.storage.put("owner-metadata", snapshot);
        }
        return snapshot;
      };
      const snapshot = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(read)
        : await read();
      return snapshot ? Response.json(snapshot) : new Response(null, { status: 204 });
    }

    if (url.pathname === "/target/mutate") {
      const body = (await request.json().catch(() => null)) as {
        snapshot?: unknown;
        mutation?: unknown;
      } | null;
      const snapshot = isRefreshTarget(body?.snapshot) ? body.snapshot : null;
      const mutation = isRefreshTargetMutation(body?.mutation) ? body.mutation : null;
      const key = mutation?.kind === "observe" ? mutation.input.key : snapshot?.key;
      if (!mutation || !key) {
        return new Response(null, { status: 400 });
      }
      const mutate = async () => {
        let current = await this.state.storage.get<RefreshTarget>("refresh-target");
        if (!current && this.env.DASHBOARD_CACHE) {
          const raw = await this.env.DASHBOARD_CACHE.get(refreshTargetStorageKey(key));
          if (raw) {
            const parsed = tryJsonParse<RefreshTarget>(raw, `refresh target ${key}`);
            current = isRefreshTarget(parsed) ? parsed : undefined;
          }
        }
        const updated = applyRefreshTargetMutation(snapshot, current ?? null, mutation);
        await Promise.all([
          this.state.storage.put("refresh-target", updated),
          this.env.DASHBOARD_CACHE?.put(refreshTargetStorageKey(key), JSON.stringify(updated), {
            expirationTtl: dashboardStorageTtlSeconds,
          }),
        ]);
        return updated;
      };
      const updated = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(mutate)
        : await mutate();
      return Response.json(updated);
    }

    if (url.pathname === "/progress/get") {
      const progress = await this.state.storage.get<StoredBuildProgress>("build-progress");
      if (progress && (!isStoredBuildProgress(progress) || storedBuildProgressExpired(progress))) {
        await this.state.storage.delete("build-progress");
        return new Response(null, {
          status: 204,
          headers: { "x-releasebar-progress": "durable" },
        });
      }
      return progress
        ? Response.json(progress, {
            headers: { "x-releasebar-progress": "durable" },
          })
        : new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
    }

    if (url.pathname === "/progress/put") {
      const progress = await request.json().catch(() => null);
      if (!isStoredBuildProgress(progress)) {
        return new Response(null, {
          status: 400,
          headers: { "x-releasebar-progress": "durable" },
        });
      }
      await this.state.storage.put("build-progress", progress);
      return new Response(null, {
        status: 204,
        headers: { "x-releasebar-progress": "durable" },
      });
    }

    if (url.pathname === "/progress/delete") {
      await this.state.storage.delete("build-progress");
      return new Response(null, {
        status: 204,
        headers: { "x-releasebar-progress": "durable" },
      });
    }

    if (url.pathname === "/job/reserve") {
      const body = (await request.json().catch(() => null)) as {
        jobId?: string;
        dirtyOnConflict?: StoredRefreshDirty;
      } | null;
      if (!body?.jobId) {
        return new Response(null, { status: 400 });
      }
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      if (existing && existing.jobId !== body.jobId && existing.expiresAt > Date.now()) {
        const dirty = body.dirtyOnConflict;
        if (dirty && typeof dirty.observedAt === "string" && typeof dirty.reason === "string") {
          const current = await this.state.storage.get<StoredRefreshDirty>("refresh-dirty");
          if (!current || safeIso(dirty.observedAt) >= safeIso(current.observedAt)) {
            await this.state.storage.put("refresh-dirty", dirty);
          }
        }
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("refresh-job", {
        jobId: body.jobId,
        expiresAt: Date.now() + refreshJobReservationTtlMs,
      } satisfies StoredRefreshJobReservation);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/job/release") {
      const body = (await request.json().catch(() => null)) as {
        jobId?: string;
        consumeDirty?: boolean;
      } | null;
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      if (existing?.jobId === body?.jobId) {
        const dirty = await this.state.storage.get<StoredRefreshDirty>("refresh-dirty");
        await Promise.all([
          this.state.storage.delete("refresh-job"),
          ...(dirty && body?.consumeDirty ? [this.state.storage.delete("refresh-dirty")] : []),
        ]);
        if (dirty && body?.consumeDirty) {
          return Response.json(dirty);
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/job/status") {
      const existing = await this.state.storage.get<StoredRefreshJobReservation>("refresh-job");
      const active = Boolean(existing && existing.expiresAt > Date.now());
      if (existing && !active) {
        await this.state.storage.delete("refresh-job");
      }
      return Response.json({ active });
    }

    if (url.pathname === "/owner-metadata/mutate") {
      const body = (await request.json().catch(() => null)) as {
        owner?: unknown;
        mutation?: unknown;
      } | null;
      const owner = typeof body?.owner === "string" ? slugOwner(body.owner) : "";
      const mutation = isOwnerMetadataMutation(body?.mutation) ? body.mutation : null;
      if (!validOwnerSlug(owner) || !mutation) {
        return new Response(null, { status: 400 });
      }
      const mutate = async () => {
        let stored = normalizeOwnerMetadataSnapshot(
          owner,
          await this.state.storage.get<OwnerMetadataSnapshot>("owner-metadata"),
        );
        if (stored && Date.now() - safeIso(stored.generatedAt) > ownerMetadataTtlSeconds * 1000) {
          await this.state.storage.delete("owner-metadata");
          stored = null;
        }
        const cached = await readOwnerMetadataKv(this.env, owner);
        const existing = reconcileOwnerMetadataSnapshots(owner, stored, cached, true);
        const updated = applyOwnerMetadataMutation(owner, existing, mutation);
        if (!updated) return null;
        await Promise.all([
          this.state.storage.put("owner-metadata", updated),
          writeOwnerMetadata(this.env, updated),
        ]);
        return updated;
      };
      const updated = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(mutate)
        : await mutate();
      return updated ? Response.json(updated) : new Response(null, { status: 204 });
    }

    if (
      url.pathname === "/webhook/enqueue" ||
      url.pathname === "/webhook/process" ||
      url.pathname === "/webhook/abandon"
    ) {
      const body = (await request.json().catch(() => null)) as {
        event?: unknown;
        delivery?: unknown;
        payload?: unknown;
        createdAt?: unknown;
      } | null;
      const event = typeof body?.event === "string" ? body.event : "";
      const delivery = typeof body?.delivery === "string" ? body.delivery : "";
      const payload =
        body?.payload && typeof body.payload === "object"
          ? (body.payload as Record<string, unknown>)
          : null;
      if (!delivery || (url.pathname !== "/webhook/abandon" && (!event || !payload))) {
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/webhook/abandon") {
        const abandonDelivery = async () => {
          const [accepted, processed, active] = await Promise.all([
            this.state.storage.get<StoredWebhookDelivery[]>("webhook-accepted"),
            this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries"),
            this.state.storage.get<StoredWebhookProcessing>("webhook-active"),
          ]);
          await Promise.all([
            this.state.storage.put(
              "webhook-accepted",
              (accepted ?? []).filter((item) => item.id !== delivery),
            ),
            this.state.storage.put(
              "webhook-deliveries",
              (processed ?? []).filter((item) => item.id !== delivery),
            ),
            ...(active?.delivery === delivery ? [this.state.storage.delete("webhook-active")] : []),
          ]);
          return new Response(null, { status: 204 });
        };
        return this.state.blockConcurrencyWhile
          ? this.state.blockConcurrencyWhile(abandonDelivery)
          : abandonDelivery();
      }
      if (url.pathname === "/webhook/enqueue") {
        if (!this.env.REFRESH_QUEUE) {
          return jsonResponse({ error: "webhook queue unavailable" }, 503, {
            "cache-control": "no-store",
          });
        }
        const enqueueDelivery = async () => {
          const now = Date.now();
          const deliveries = (
            (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-accepted")) ?? []
          ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
          if (deliveries.some((item) => item.id === delivery)) {
            return jsonResponse({ ok: true, duplicate: true }, 202, {
              "cache-control": "no-store",
            });
          }
          await this.env.REFRESH_QUEUE!.send({
            kind: "github-webhook",
            id: randomNonce(),
            event,
            delivery,
            payload: payload!,
            createdAt: new Date(now).toISOString(),
            attempts: 0,
          });
          deliveries.push({ id: delivery, processedAt: now });
          await this.state.storage.put(
            "webhook-accepted",
            deliveries.slice(-githubWebhookDeliveryLimit),
          );
          return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
        };
        return this.state.blockConcurrencyWhile
          ? this.state.blockConcurrencyWhile(enqueueDelivery)
          : enqueueDelivery();
      }
      const reserveProcessing = async () => {
        const now = Date.now();
        const deliveries = (
          (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries")) ?? []
        ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
        if (deliveries.some((item) => item.id === delivery)) {
          return "duplicate" as const;
        }
        const active = await this.state.storage.get<StoredWebhookProcessing>("webhook-active");
        if (active && active.expiresAt > now) return "busy" as const;
        await this.state.storage.put("webhook-active", {
          delivery,
          expiresAt: now + githubWebhookProcessingLeaseMs,
        } satisfies StoredWebhookProcessing);
        return "reserved" as const;
      };
      const reservation = this.state.blockConcurrencyWhile
        ? await this.state.blockConcurrencyWhile(reserveProcessing)
        : await reserveProcessing();
      if (reservation === "duplicate") {
        return jsonResponse({ ok: true, duplicate: true }, 202, {
          "cache-control": "no-store",
        });
      }
      if (reservation === "busy") {
        return jsonResponse({ error: "webhook processor busy" }, 409, {
          "cache-control": "no-store",
        });
      }
      try {
        const waits: Promise<unknown>[] = [];
        await processGitHubWebhook(
          event,
          delivery,
          payload!,
          typeof body?.createdAt === "string" ? body.createdAt : new Date().toISOString(),
          this.env,
          {
            waitUntil: (promise) => waits.push(promise),
          },
        );
        await Promise.all(waits);
        const completeProcessing = async () => {
          const now = Date.now();
          const deliveries = (
            (await this.state.storage.get<StoredWebhookDelivery[]>("webhook-deliveries")) ?? []
          ).filter((item) => now - item.processedAt < githubWebhookDeliveryTtlMs);
          if (!deliveries.some((item) => item.id === delivery)) {
            deliveries.push({ id: delivery, processedAt: now });
          }
          await Promise.all([
            this.state.storage.put(
              "webhook-deliveries",
              deliveries.slice(-githubWebhookDeliveryLimit),
            ),
            this.state.storage.delete("webhook-active"),
          ]);
        };
        if (this.state.blockConcurrencyWhile) {
          await this.state.blockConcurrencyWhile(completeProcessing);
        } else {
          await completeProcessing();
        }
        return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
      } catch (error) {
        const releaseProcessing = async () => {
          const active = await this.state.storage.get<StoredWebhookProcessing>("webhook-active");
          if (active?.delivery === delivery) {
            await this.state.storage.delete("webhook-active");
          }
        };
        if (this.state.blockConcurrencyWhile) {
          await this.state.blockConcurrencyWhile(releaseProcessing);
        } else {
          await releaseProcessing();
        }
        throw error;
      }
    }

    return new Response(null, { status: 404 });
  }
}

function webhookHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validWebhookSignature(
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

function webhookRepo(payload: Record<string, unknown>): {
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

function compactGitHubWebhookPayload(
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

function releaseWebhookAffectsDashboard(payload: Record<string, unknown>): boolean {
  const release =
    payload.release && typeof payload.release === "object"
      ? (payload.release as Record<string, unknown>)
      : null;
  const action = String(payload.action ?? "");
  if (!release || (release.draft === true && action !== "unpublished")) return false;
  return Boolean(action);
}

type WebhookTargetPage = {
  targets: RefreshTarget[];
  next: Pick<GitHubWebhookFanoutJob, "source" | "cursor" | "backfillFailed"> | null;
  prioritized?: boolean;
};

function compareWebhookTargets(left: RefreshTarget, right: RefreshTarget): number {
  return (
    safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt) ||
    right.priority - left.priority ||
    left.key.localeCompare(right.key)
  );
}

function freshestWebhookTargets(targets: RefreshTarget[]): RefreshTarget[] {
  const freshest = new Map<string, RefreshTarget>();
  for (const target of targets) {
    const current = freshest.get(target.key);
    if (!current || compareWebhookTargets(target, current) < 0) {
      freshest.set(target.key, target);
    }
  }
  return [...freshest.values()];
}

function webhookTargetMatches(target: RefreshTarget, owner: string, fullName: string): boolean {
  return target.owners.includes(owner) || target.repos.includes(fullName) || target.owner === owner;
}

function webhookTargetIndexedByOwner(target: RefreshTarget, owner: string): boolean {
  return (
    slugOwner(target.owner) === owner ||
    target.owners.some((targetOwner) => slugOwner(targetOwner) === owner)
  );
}

async function indexedWebhookTargets(
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

async function kvIndexedWebhookTargets(
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

async function currentWebhookTargets(env: Env, targets: RefreshTarget[]): Promise<RefreshTarget[]> {
  if (!env.DASHBOARD_CACHE) return targets;
  const current = await mapConcurrent(targets, 16, (target) => readRefreshTarget(env, target.key));
  return freshestWebhookTargets([
    ...current.filter((target): target is RefreshTarget => target !== null),
    ...targets,
  ]);
}

async function durableIndexedWebhookTargets(
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

async function prioritizedIndexedWebhookTargets(
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

async function legacyWebhookTargets(
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

async function legacyOwnerWebhookSeedTargets(
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

async function webhookTargetPage(
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

async function mapWebhookTargets<T>(
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

function webhookTargetsForAction(
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

async function invalidateRepoProjectCache(env: Env, fullName: string): Promise<void> {
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

async function deleteCachePrefix(env: Env, prefix: string): Promise<void> {
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

async function invalidatePublicRepoCaches(env: Env, fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;
  await Promise.all([
    invalidateRepoProjectCache(env, fullName),
    env.DASHBOARD_CACHE?.delete?.(repoDetailCacheKey(owner, repo)),
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
    deleteCachePrefix(env, "owner-activity:v1:"),
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

async function invalidateDashboardTargets(env: Env, targets: RefreshTarget[]): Promise<void> {
  await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
  await mapWebhookTargets(targets, async (target) => {
    await Promise.all([env.DASHBOARD_CACHE?.delete?.(target.key), deleteProgress(env, target.key)]);
  });
}

async function prepareGitHubWebhookEvent(
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
      env.DASHBOARD_CACHE?.delete?.(hotCacheKey),
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
  await invalidateRepoProjectCache(env, repo.fullName);
  return {
    reason: `webhook:${event}`,
    includeReleaseDataOnly: true,
    invalidateDashboard: true,
    recentTargetsOnly: true,
  };
}

async function applyWebhookTargetAction(
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

async function enqueueWebhookFanout(
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

async function webhookPriorityBatchActive(env: Env, targetKeys: string[]): Promise<boolean> {
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

async function processGitHubWebhookFanout(
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

async function processGitHubWebhook(
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

function githubWebhookProcessorBusy(error: unknown): boolean {
  const reason = errorMessage(error);
  return reason.includes("webhook processor returned 409") || reason.includes("processor busy");
}

async function githubWebhookRetryDelaySeconds(env: Env, error: unknown): Promise<number> {
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

async function abandonGitHubWebhookDelivery(
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

async function boundedRequestText(request: Request, limit: number): Promise<string | null> {
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

async function githubWebhookResponse(
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

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isHead = request.method === "HEAD";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const profileWrite =
      url.pathname.startsWith("/api/profile/") &&
      (request.method === "POST" || request.method === "DELETE");
    const audienceBackfillWrite =
      isRepoAudienceBackfillApiPath(url.pathname) && request.method === "POST";
    const adminWrite =
      (url.pathname === "/api/admin/scheduler/run" ||
        url.pathname === "/api/admin/installations/sync") &&
      request.method === "POST";
    const ownerRefreshWrite = isOwnerRefreshApiPath(url.pathname) && request.method === "POST";
    const clientTimingWrite = url.pathname === "/api/_client-timing" && request.method === "POST";
    const githubWebhookWrite = url.pathname === "/api/github/webhook" && request.method === "POST";
    if (
      request.method !== "GET" &&
      !isHead &&
      !profileWrite &&
      !audienceBackfillWrite &&
      !adminWrite &&
      !ownerRefreshWrite &&
      !clientTimingWrite &&
      !githubWebhookWrite
    ) {
      return jsonResponse({ error: "method not allowed" }, 405, { allow: "GET" });
    }
    const response = await routeRequest(request, env, context, url);
    if (!isHead) {
      return response;
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
  async scheduled(event: ScheduledEvent, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(schedulerTick(env, context, `cron:${event.cron}`, schedulerBatchLimit));
  },
  async queue(
    batch: MessageBatch<WorkerQueueMessage>,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      if (isGitHubWebhookFanoutJob(message.body)) {
        const fanoutJob = message.body;
        try {
          await processGitHubWebhookFanout(fanoutJob, env, context);
          message.ack();
        } catch (error) {
          const delaySeconds = await githubWebhookRetryDelaySeconds(env, error);
          const attempts = message.attempts ?? 1;
          const expired = Date.now() - safeIso(fanoutJob.createdAt) >= githubWebhookDeliveryTtlMs;
          if (attempts >= refreshQueueMaxAttempts || expired) {
            await abandonGitHubWebhookDelivery(env, fanoutJob.delivery, fanoutJob.payload).catch(
              async (abandonError) =>
                auditSyncEvent(env, {
                  event: "github_webhook_admission_abandon_failed",
                  status: "failed",
                  reason: errorMessage(abandonError),
                  detail: `githubEvent=${fanoutJob.event} delivery=${fanoutJob.delivery} fanout=true`,
                }),
            );
          }
          await auditSyncEvent(env, {
            event: "github_webhook_fanout_failed",
            status: "failed",
            reason: errorMessage(error),
            detail: `githubEvent=${fanoutJob.event} delivery=${fanoutJob.delivery} source=${fanoutJob.source} attempts=${attempts}`,
          }).catch(() => undefined);
          message.retry({ delaySeconds: Math.min(delaySeconds, 5 * 60) });
        }
        continue;
      }
      if (isGitHubWebhookJob(message.body)) {
        const webhookJob = message.body;
        try {
          if (!env.DASHBOARD_LOCKS) throw new Error("webhook processor unavailable");
          const owner = webhookRepo(webhookJob.payload)?.owner ?? webhookJob.delivery;
          const id = env.DASHBOARD_LOCKS.idFromName(`github-webhook-process:${owner}`);
          const response = await env.DASHBOARD_LOCKS.get(id).fetch(
            new Request("https://releasebar.internal/webhook/process", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(webhookJob),
            }),
          );
          if (!response.ok) {
            throw new Error(`webhook processor returned ${response.status}`);
          }
          message.ack();
        } catch (error) {
          const delaySeconds = await githubWebhookRetryDelaySeconds(env, error);
          const attempts = githubWebhookProcessorBusy(error)
            ? (webhookJob.attempts ?? 0)
            : (webhookJob.attempts ?? 0) + 1;
          const expired = Date.now() - safeIso(webhookJob.createdAt) >= githubWebhookDeliveryTtlMs;
          if (attempts > githubWebhookRequeueLimit || expired) {
            await abandonGitHubWebhookDelivery(env, webhookJob.delivery, webhookJob.payload).catch(
              async (abandonError) =>
                auditSyncEvent(env, {
                  event: "github_webhook_admission_abandon_failed",
                  status: "failed",
                  reason: errorMessage(abandonError),
                  detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery}`,
                }),
            );
            await auditSyncEvent(env, {
              event: "github_webhook_failed",
              status: "failed",
              reason: `${errorMessage(error)}; durable requeue limit reached`,
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery} attempts=${attempts}`,
            });
            message.ack();
            continue;
          }
          try {
            if (!env.REFRESH_QUEUE) throw new Error("webhook queue unavailable");
            await env.REFRESH_QUEUE.send(
              {
                ...webhookJob,
                id: randomNonce(),
                attempts,
              },
              { delaySeconds },
            );
            await auditSyncEvent(env, {
              event: "github_webhook_requeued",
              status: "queued",
              reason: errorMessage(error),
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery} delaySeconds=${delaySeconds}`,
            });
            message.ack();
          } catch (requeueError) {
            await auditSyncEvent(env, {
              event: "github_webhook_failed",
              status: "failed",
              reason: `${errorMessage(error)}; requeue failed: ${errorMessage(requeueError)}`,
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery}`,
            });
            message.retry({ delaySeconds: Math.min(delaySeconds, 5 * 60) });
          }
        }
        continue;
      }
      const deliveryAttempts = message.attempts ?? message.body.attempts + 1;
      const exhausted = deliveryAttempts >= refreshQueueMaxAttempts;
      let processedJob: RefreshJob | null = null;
      try {
        const job = await processRefreshJob(message.body, env, !exhausted);
        processedJob = job;
        if (job.status === "queued") {
          const delaySeconds =
            job.error === "dashboard locked" ||
            job.error === "dashboard stalled" ||
            job.error === "dashboard deadline reached" ||
            job.error === "target snapshot unavailable" ||
            job.error === "profile snapshot unavailable"
              ? buildLockRetrySeconds
              : incompleteBuildRetrySeconds;
          if (exhausted) {
            await failExhaustedRefreshJob(job, env, deliveryAttempts);
            await finishRefreshJobReservation(env, context, job);
            message.retry({ delaySeconds });
            continue;
          }
          message.retry({
            delaySeconds,
          });
        } else {
          await finishRefreshJobReservation(env, context, job);
          message.ack();
        }
      } catch (error) {
        if (exhausted) {
          const job =
            processedJob ??
            (await readRefreshJob(env, message.body.id).catch(() => null)) ??
            message.body;
          if (job.status === "queued" || job.status === "running") {
            await failExhaustedRefreshJob(
              { ...job, error: errorMessage(error) },
              env,
              deliveryAttempts,
            ).catch(() => undefined);
          }
          await finishRefreshJobReservation(env, context, job).catch(() => undefined);
        }
        message.retry({ delaySeconds: 300 });
      }
    }
  },
};

async function routeRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname.startsWith("/og/")) {
    const { label, extension } = socialRouteLabel(url.pathname);
    const title =
      label.startsWith("@") || label.includes("/") || !validOwnerSlug(label) ? label : `@${label}`;
    const card = await socialCardForLabel(title, request, env, context);
    if (extension === "png") return await socialPng(card, request, env);
    return await socialImage(card);
  }
  if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
    return jsonResponse(openApiSpec(url.origin));
  }
  if (url.pathname === "/api/swagger.json") {
    return jsonResponse(openApiSpec(url.origin));
  }
  if (url.pathname === "/api/me") {
    return meResponse(request, env);
  }
  if (url.pathname === "/api/_client-timing" && request.method === "POST") {
    return clientTimingResponse(request, env, context);
  }
  if (url.pathname === "/api/github/webhook" && request.method === "POST") {
    return githubWebhookResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return adminResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/profile/")) {
    return profileResponse(request, env);
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return authResponse(request, env);
  }
  if (url.pathname === "/api/_hot") {
    return hotResponse(env);
  }
  if (url.pathname === "/api/_discover") {
    return discoverResponse(request, env, url, context);
  }
  if (isOwnerActivityApiPath(url.pathname)) {
    return ownerActivityResponse(request, env, context);
  }
  if (isRepoActivityApiPath(url.pathname)) {
    return repoActivityResponse(request, env, context);
  }
  if (isTrustProfileApiPath(url.pathname)) {
    return trustProfileResponse(request, env, context);
  }
  if (isRepoAudienceBackfillApiPath(url.pathname)) {
    return repoAudienceBackfillResponse(request, env);
  }
  if (isRepoAudienceApiPath(url.pathname)) {
    return repoAudienceResponse(request, env, context);
  }
  if (isRepoDetailApiPath(url.pathname)) {
    return repoDetailResponse(request, env, context);
  }
  if (isOwnerEventsApiPath(url.pathname)) {
    return ownerEventsResponse(request, env);
  }
  if (isOwnerApiPath(url.pathname)) {
    return ownerResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
  }
  return assetResponse(request, env);
}

import type { RefreshJob } from "../src/types.js";

export type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

export type DurableObjectId = unknown;

export type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

export type Queue<Message = unknown> = {
  send(message: Message, options?: { delaySeconds?: number }): Promise<void>;
};

export type GitHubWebhookJob = {
  kind: "github-webhook";
  id: string;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts?: number;
};

export type StoredWebhookPending = {
  key: string;
  revision: string;
  job: GitHubWebhookJob;
  deliveries: string[];
};

export type WebhookTargetAction = {
  reason: string;
  includeReleaseDataOnly: boolean;
  invalidateDashboard: boolean;
  recentTargetsOnly?: boolean;
  prioritizedTargetKeys?: string[];
};

export type GitHubWebhookFanoutJob = {
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

export type WorkerQueueMessage = RefreshJob | GitHubWebhookJob | GitHubWebhookFanoutJob;

export type MessageBatch<Message = unknown> = {
  messages: Array<{
    body: Message;
    attempts?: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
};

export type DurableObjectState = {
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

export type Env = {
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

export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type ScheduledEvent = {
  cron: string;
  scheduledTime: number;
};

export type RequestCf = {
  verifiedBotCategory?: string;
  botManagement?: {
    verifiedBot?: boolean;
  };
};

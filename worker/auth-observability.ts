import { slugOwner } from "../scripts/lib/dashboard.js";
import type {
  AuthFunnelEvent,
  AuthFunnelSummary,
  AuthInstallation,
  AuthInstallationRecord,
} from "../src/types.js";
import * as v from "valibot";
import { mapConcurrent } from "./concurrency.js";
import { randomNonce } from "./crypto.js";
import type { Env } from "./runtime.js";
import { safeJsonParse, tryJsonParse } from "./schemas.js";

const authFunnelPrefix = `auth:funnel:v1:`;
const authFunnelCounterPrefix = `auth:funnel-counter:v1:`;
const authFunnelListLimit = 80;
const adminInstallationListLimit = 80;
const adminAuthCounterListLimit = 80;
const storageTtlSeconds = 90 * 24 * 60 * 60;

function safeIso(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const storedInstallationSchema = v.object({
  id: v.number(),
  accountLogin: v.string(),
  accountType: v.picklist(["user", "org"]),
  accountUrl: v.string(),
  avatarUrl: v.string(),
  repositorySelection: v.picklist(["all", "selected"]),
  repositories: v.array(v.string()),
  updatedAt: v.optional(v.string()),
});

export type StoredInstallationRecord = AuthInstallation & {
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

export async function recordAuthFunnelEvent(
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
        expirationTtl: storageTtlSeconds,
      }),
      readCounter(env, counterKey).then((count) =>
        env.DASHBOARD_CACHE!.put(counterKey, String(count + 1), {
          expirationTtl: storageTtlSeconds,
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

export async function listStoredInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  if (!env.DASHBOARD_CACHE?.list) return [];
  const records: AuthInstallationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: `auth:installation:v1:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const pageRecords = await mapConcurrent(page.keys, 16, async (key) => {
      const raw = await env.DASHBOARD_CACHE?.get(key.name);
      if (!raw) return null;
      const parsed = safeJsonParse(storedInstallationSchema, raw, `app installation ${key.name}`);
      return parsed ? storedInstallationRecord(parsed) : null;
    });
    records.push(
      ...pageRecords.filter((record): record is AuthInstallationRecord => record !== null),
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records.sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt));
}

async function storedInstallationInventory(
  env: Env,
): Promise<{ total: number; installations: AuthInstallationRecord[] }> {
  if (!env.DASHBOARD_CACHE?.list) return { total: 0, installations: [] };
  const sampleKeys: string[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: `auth:installation:v1:`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      total += 1;
      if (sampleKeys.length < adminInstallationListLimit) {
        sampleKeys.push(key.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const installations = await mapConcurrent(sampleKeys, 16, async (key) => {
    const raw = await env.DASHBOARD_CACHE?.get(key);
    if (!raw) return null;
    const parsed = safeJsonParse(storedInstallationSchema, raw, `app installation ${key}`);
    return parsed ? storedInstallationRecord(parsed) : null;
  });
  return {
    total,
    installations: installations
      .filter((record): record is AuthInstallationRecord => record !== null)
      .sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt)),
  };
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

async function authFunnelCountInventory(
  env: Env,
): Promise<{ total: number; counts: Array<{ key: string; count: number }> }> {
  if (!env.DASHBOARD_CACHE?.list) return { total: 0, counts: [] };
  const sampleKeys: string[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: authFunnelCounterPrefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      total += 1;
      sampleKeys.push(key.name);
      if (sampleKeys.length > adminAuthCounterListLimit) sampleKeys.shift();
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const counts = await mapConcurrent(sampleKeys, 16, async (key) => {
    const count = Number.parseInt((await env.DASHBOARD_CACHE?.get(key)) ?? "0", 10);
    return Number.isFinite(count) && count > 0
      ? { key: key.slice(authFunnelCounterPrefix.length), count }
      : null;
  });
  return {
    total,
    counts: counts
      .filter((count): count is { key: string; count: number } => count !== null)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}

export async function authFunnelSummary(env: Env): Promise<AuthFunnelSummary> {
  const [installationInventory, events, countInventory] = await Promise.all([
    storedInstallationInventory(env),
    listAuthFunnelEvents(env),
    authFunnelCountInventory(env),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    installationCount: installationInventory.total,
    installations: installationInventory.installations,
    events,
    counterCount: countInventory.total,
    counts: countInventory.counts,
  };
}

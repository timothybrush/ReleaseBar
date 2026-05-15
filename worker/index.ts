import {
  buildDashboard,
  dashboardCacheKey,
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
} from "../scripts/lib/dashboard.js";
import type { DashboardPayload, Owner } from "../src/types.js";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type Env = {
  DASHBOARD_CACHE?: KVNamespace;
  GITHUB_TOKEN?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const fullTtlMs = 60 * 60 * 1000;
const staleTtlSeconds = 3 * 24 * 60 * 60;
const coldBuildWaitMs = 15 * 1000;
const repoLimit = 8;
const schemaVersion = 1;
const locks = new Map<string, Promise<DashboardPayload>>();
const buildPending = Symbol("build-pending");
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      ...corsHeaders,
      ...headers,
    },
  });
}

function withCacheState(
  payload: DashboardPayload,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message?: string,
): DashboardPayload {
  return {
    ...payload,
    cache: {
      state,
      stale: state !== "fresh",
      capped: payload.cache?.capped ?? false,
      repoLimit: payload.cache?.repoLimit ?? repoLimit,
      generatedAt: payload.generatedAt,
      ...(message ? { message } : {}),
    },
  };
}

function optionsFromUrl(url: URL) {
  return {
    includeForks: url.searchParams.get("forks") === "true",
    includeArchived: url.searchParams.get("archived") === "true",
    includeUnreleased: url.searchParams.get("unreleased") === "true",
  };
}

async function readCached(env: Env, key: string): Promise<DashboardPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? (JSON.parse(raw) as DashboardPayload) : null;
}

async function writeCached(
  env: Env,
  key: string,
  payload: DashboardPayload,
  ttlSeconds = staleTtlSeconds,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
}

async function rebuild(owner: Owner, env: Env, key: string, url: URL): Promise<DashboardPayload> {
  const existing = locks.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const payload = await buildDashboard({
      title: "ReleaseDeck",
      subtitle: `Release freshness for @${owner.login}.`,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "releasedeck.dev",
      owners: [owner],
      ...optionsFromUrl(url),
      repoLimit,
      token: env.GITHUB_TOKEN,
      fetch: workerFetch,
    });
    await writeCached(env, key, payload);
    return payload;
  })();

  locks.set(key, promise);
  try {
    return await promise;
  } finally {
    locks.delete(key);
  }
}

function errorPayload(owner: Owner, env: Env, url: URL, message: string): DashboardPayload {
  return statusPayload(owner, env, url, "error", message, new Date().toISOString());
}

function rebuildingPayload(owner: Owner, env: Env, url: URL): DashboardPayload {
  return statusPayload(
    owner,
    env,
    url,
    "rebuilding",
    "dashboard build queued",
    new Date().toISOString(),
  );
}

function cacheBuildError(
  owner: Owner,
  env: Env,
  key: string,
  url: URL,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  return writeCached(env, key, errorPayload(owner, env, url, message), 5 * 60);
}

function statusPayload(
  owner: Owner,
  env: Env,
  url: URL,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message: string,
  generatedAt: string,
): DashboardPayload {
  return {
    title: "ReleaseDeck",
    subtitle: `Release freshness for @${owner.login}.`,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "releasedeck.dev",
    generatedAt,
    owners: [owner],
    options: {
      ...optionsFromUrl(url),
      repoLimit,
    },
    cache: {
      state,
      stale: true,
      capped: false,
      repoLimit,
      generatedAt,
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

async function ownerResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const owner = slugOwner(url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(owner)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }

  const options = optionsFromUrl(url);
  const key = dashboardCacheKey({ owner, ...options, schemaVersion });
  const cached = await readCached(env, key);
  const ageMs = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;

  if (cached?.cache?.state === "error") {
    const cachedOwner = cached.owners[0];
    if (cachedOwner) {
      context.waitUntil(
        rebuild(cachedOwner, env, key, url).catch((error) =>
          cacheBuildError(cachedOwner, env, key, url, error),
        ),
      );
    }
    return jsonResponse(cached, 502, {
      "cache-control": "no-store",
    });
  }

  if (cached && ageMs < fullTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  if (cached) {
    const cachedOwner = cached.owners[0];
    if (cachedOwner) {
      context.waitUntil(rebuild(cachedOwner, env, key, url).catch(() => undefined));
    }
    return jsonResponse(withCacheState(cached, "stale"));
  }

  let resolvedOwner: Owner | null;
  try {
    resolvedOwner = await resolveOwnerType(owner, {
      fetch: workerFetch,
      token: env.GITHUB_TOKEN,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 502, {
      "cache-control": "no-store",
    });
  }
  if (!resolvedOwner) {
    return jsonResponse({ error: "owner not found" }, 404, {
      "cache-control": "no-store",
    });
  }

  const build = rebuild(resolvedOwner, env, key, url);
  try {
    const payload = await Promise.race([
      build,
      new Promise<typeof buildPending>((resolve) => {
        setTimeout(() => resolve(buildPending), coldBuildWaitMs);
      }),
    ]);
    if (payload === buildPending) {
      context.waitUntil(
        build.catch((error) => cacheBuildError(resolvedOwner, env, key, url, error)),
      );
      return jsonResponse(rebuildingPayload(resolvedOwner, env, url), 202, {
        "cache-control": "no-store",
      });
    }
    return jsonResponse(payload);
  } catch (error) {
    const payload = errorPayload(
      resolvedOwner,
      env,
      url,
      error instanceof Error ? error.message : String(error),
    );
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, 502, {
      "cache-control": "no-store",
    });
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405, { allow: "GET" });
    }
    if (url.pathname.startsWith("/api/")) {
      return ownerResponse(request, env, context);
    }
    return jsonResponse({ error: "not found" }, 404);
  },
};

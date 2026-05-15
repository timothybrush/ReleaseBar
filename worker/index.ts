import {
  buildDashboard,
  dashboardCacheKey,
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import type { AuthPayload, AuthUser, DashboardPayload, Owner } from "../src/types.js";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type Env = {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AUTH_COOKIE_SECRET?: string;
  DASHBOARD_CACHE?: KVNamespace;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
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
const maxCustomSources = 8;
const schemaVersion = 1;
const sessionCookie = "rd_session";
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const stateMaxAgeSeconds = 10 * 60;
const locks = new Map<string, Promise<DashboardPayload>>();
const buildPending = Symbol("build-pending");
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

type DashboardRequest = {
  owners: Owner[];
  includeRepos: string[];
  subtitle: string;
  key: string;
  url: URL;
};

type AuthState = {
  returnTo: string;
  iat: number;
  nonce: string;
};

type AuthSession = {
  user: AuthUser;
  iat: number;
  exp: number;
};

type GitHubOAuthToken = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GitHubOAuthUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
};

function shouldServeAppShell(url: URL): boolean {
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

function safeReturnTo(value: string | null): string {
  if (!value || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://releasedeck.dev");
    if (url.origin !== "https://releasedeck.dev") return "/";
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
    env.AUTH_COOKIE_SECRET && env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET,
  );
}

function appSlug(env: Env): string {
  return env.GITHUB_APP_SLUG || "releasedeck";
}

function authCookie(value: string, maxAge = sessionMaxAgeSeconds): string {
  return `${sessionCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function authUrls(url: URL, env: Env): Omit<AuthPayload, "configured" | "user"> {
  return {
    loginUrl: `${url.origin}/api/auth/login`,
    logoutUrl: `${url.origin}/api/auth/logout`,
    installUrl: `https://github.com/apps/${appSlug(env)}/installations/new`,
    appUrl: `https://github.com/apps/${appSlug(env)}`,
  };
}

async function currentUser(request: Request, env: Env): Promise<AuthUser | null> {
  if (!env.AUTH_COOKIE_SECRET) return null;
  const token = parseCookies(request).get(sessionCookie);
  if (!token) return null;
  const session = await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token);
  if (!session || session.exp < Math.floor(Date.now() / 1000)) return null;
  return session.user;
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

async function resolveOwners(ownerSlugs: string[], env: Env): Promise<Owner[] | null> {
  const owners: Owner[] = [];
  for (const owner of ownerSlugs) {
    const resolved = await resolveOwnerType(owner, {
      fetch: workerFetch,
      token: env.GITHUB_TOKEN,
    });
    if (!resolved) {
      return null;
    }
    owners.push(resolved);
  }
  return owners;
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
    const image = `${originalUrl.origin}/og/${encodeURIComponent(label)}.svg`;
    const html = (await response.text())
      .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(label)} · ReleaseDeck</title>`)
      .replace(
        /<meta property="og:title" content="[^"]*" \/>/,
        `<meta property="og:title" content="${escapeHtml(label)} · ReleaseDeck" />`,
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
        `<meta name="twitter:title" content="${escapeHtml(label)} · ReleaseDeck" />`,
      )
      .replace(
        /<meta name="twitter:image" content="[^"]*" \/>/,
        `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
      );
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("cache-control", "public, max-age=300");
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
  return repos.length > 1 ? `custom deck +${repos.length}` : "@steipete";
}

function socialImage(label: string): Response {
  const title = escapeHtml(label);
  const titleSize = label.length > 24 ? 64 : label.length > 17 ? 82 : label.length > 12 ? 100 : 118;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080908"/>
  <path d="M0 124H1200M0 248H1200M0 372H1200M0 496H1200M160 0V630M400 0V630M640 0V630M880 0V630M1120 0V630" stroke="#182014" stroke-width="1"/>
  <rect x="72" y="70" width="1056" height="490" rx="0" fill="none" stroke="#8cff4b" stroke-width="2"/>
  <text x="96" y="148" fill="#a8ff6b" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="38" letter-spacing="0">ReleaseDeck</text>
  <text x="92" y="354" fill="#f2ffe9" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="${titleSize}" font-weight="700" letter-spacing="0">${title}</text>
  <text x="96" y="444" fill="#8f9b89" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="34" letter-spacing="0">release freshness dashboard</text>
  <text x="96" y="506" fill="#52604d" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="24" letter-spacing="0">releasedeck.dev</text>
</svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

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

function redirectResponse(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function meResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const body: AuthPayload = {
    configured: authConfigured(env),
    user: await currentUser(request, env),
    ...authUrls(url, env),
  };
  return jsonResponse(body, 200, { "cache-control": "no-store" });
}

async function loginResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET || !env.GITHUB_APP_CLIENT_ID) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo: safeReturnTo(url.searchParams.get("returnTo")),
    iat: Math.floor(Date.now() / 1000),
    nonce: randomNonce(),
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
  github.searchParams.set("state", state);
  return redirectResponse(github.toString());
}

async function exchangeCode(url: URL, env: Env): Promise<string> {
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken || !env.AUTH_COOKIE_SECRET) {
    throw new Error("missing OAuth code or state");
  }
  const state = await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, stateToken);
  const now = Math.floor(Date.now() / 1000);
  if (!state || now - state.iat > stateMaxAgeSeconds) {
    throw new Error("invalid OAuth state");
  }
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
  const token = (await response.json()) as GitHubOAuthToken;
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
      "user-agent": "ReleaseDeck",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }
  const user = (await response.json()) as GitHubOAuthUser;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    url: user.html_url,
  };
}

async function callbackResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  try {
    const state = await verifySignedJson<AuthState>(
      env.AUTH_COOKIE_SECRET,
      url.searchParams.get("state") ?? "",
    );
    if (!state || Math.floor(Date.now() / 1000) - state.iat > stateMaxAgeSeconds) {
      throw new Error("invalid OAuth state");
    }
    const accessToken = await exchangeCode(url, env);
    const user = await githubUser(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const session = await signedJson(env.AUTH_COOKIE_SECRET, {
      user,
      iat: now,
      exp: now + sessionMaxAgeSeconds,
    });
    return redirectResponse(state.returnTo, {
      "set-cookie": authCookie(session),
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, {
      "cache-control": "no-store",
    });
  }
}

function logoutResponse(request: Request): Response {
  const url = new URL(request.url);
  return redirectResponse(safeReturnTo(url.searchParams.get("returnTo")), {
    "set-cookie": authCookie("", 0),
  });
}

async function authResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") return loginResponse(request, env);
  if (url.pathname === "/api/auth/callback") return callbackResponse(request, env);
  if (url.pathname === "/api/auth/logout") return logoutResponse(request);
  if (url.pathname === "/api/auth/install") {
    return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`);
  }
  return jsonResponse({ error: "not found" }, 404);
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

async function rebuild(dashboard: DashboardRequest, env: Env): Promise<DashboardPayload> {
  const existing = locks.get(dashboard.key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const payload = await buildDashboard({
      title: "ReleaseDeck",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "releasedeck.dev",
      owners: dashboard.owners,
      includeRepos: dashboard.includeRepos,
      ...optionsFromUrl(dashboard.url),
      repoLimit,
      token: env.GITHUB_TOKEN,
      fetch: workerFetch,
    });
    await writeCached(env, dashboard.key, payload);
    return payload;
  })();

  locks.set(dashboard.key, promise);
  try {
    return await promise;
  } finally {
    locks.delete(dashboard.key);
  }
}

function errorPayload(dashboard: DashboardRequest, env: Env, message: string): DashboardPayload {
  return statusPayload(dashboard, env, "error", message, new Date().toISOString());
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

function cacheBuildError(dashboard: DashboardRequest, env: Env, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  return writeCached(env, dashboard.key, errorPayload(dashboard, env, message), 5 * 60);
}

function statusPayload(
  dashboard: DashboardRequest,
  env: Env,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message: string,
  generatedAt: string,
): DashboardPayload {
  return {
    title: "ReleaseDeck",
    subtitle: dashboard.subtitle,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "releasedeck.dev",
    generatedAt,
    owners: dashboard.owners,
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
  const rawOwner = url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "";
  const primaryOwner = rawOwner === "dashboard" ? null : slugOwner(rawOwner);
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }

  const options = optionsFromUrl(url);
  const extraOwnerSlugs = ownerListFromUrl(url, primaryOwner ?? undefined);
  const includeRepos = repoListFromUrl(url);
  if (extraOwnerSlugs.length + includeRepos.length > maxCustomSources) {
    return jsonResponse({ error: `too many custom sources; max ${maxCustomSources}` }, 400, {
      "cache-control": "no-store",
    });
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return jsonResponse({ error: "at least one owner or repo is required" }, 400);
  }
  const ownerSlugs = primaryOwner ? [primaryOwner, ...extraOwnerSlugs] : extraOwnerSlugs;
  const key = dashboardCacheKey({
    owner: primaryOwner ?? "custom",
    owners: extraOwnerSlugs,
    repos: includeRepos,
    ...options,
    schemaVersion,
  });
  const cached = await readCached(env, key);
  const ageMs = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;

  if (cached?.cache?.state === "error") {
    const dashboard = cachedDashboardRequest(cached, includeRepos, key, url);
    context.waitUntil(
      rebuild(dashboard, env).catch((error) => cacheBuildError(dashboard, env, error)),
    );
    return jsonResponse(cached, 502, {
      "cache-control": "no-store",
    });
  }

  if (cached && ageMs < fullTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  if (cached) {
    const dashboard = cachedDashboardRequest(cached, includeRepos, key, url);
    context.waitUntil(rebuild(dashboard, env).catch(() => undefined));
    return jsonResponse(withCacheState(cached, "stale"));
  }

  let owners: Owner[] | null;
  try {
    owners = await resolveOwners(ownerSlugs, env);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 502, {
      "cache-control": "no-store",
    });
  }
  if (!owners) {
    return jsonResponse({ error: "owner not found" }, 404, {
      "cache-control": "no-store",
    });
  }

  const dashboard = dashboardRequest(owners, includeRepos, key, url);
  const build = rebuild(dashboard, env);
  try {
    const payload = await Promise.race([
      build,
      new Promise<typeof buildPending>((resolve) => {
        setTimeout(() => resolve(buildPending), coldBuildWaitMs);
      }),
    ]);
    if (payload === buildPending) {
      context.waitUntil(build.catch((error) => cacheBuildError(dashboard, env, error)));
      return jsonResponse(rebuildingPayload(dashboard, env), 202, {
        "cache-control": "no-store",
      });
    }
    return jsonResponse(payload);
  } catch (error) {
    const payload = errorPayload(
      dashboard,
      env,
      error instanceof Error ? error.message : String(error),
    );
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, 502, {
      "cache-control": "no-store",
    });
  }
}

function cachedDashboardRequest(
  payload: DashboardPayload,
  includeRepos: string[],
  key: string,
  url: URL,
): DashboardRequest {
  return dashboardRequest(payload.owners, includeRepos, key, url);
}

function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  key: string,
  url: URL,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
  };
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isHead = request.method === "HEAD";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "GET" && !isHead) {
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
};

async function routeRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname.startsWith("/og/")) {
    const label = decodeURIComponent(url.pathname.replace(/^\/og\//, "").replace(/\.svg$/, ""));
    const title =
      label.startsWith("@") || label.includes("/") || !validOwnerSlug(label) ? label : `@${label}`;
    return socialImage(title);
  }
  if (url.pathname === "/api/me") {
    return meResponse(request, env);
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return authResponse(request, env);
  }
  if (url.pathname.startsWith("/api/")) {
    return ownerResponse(request, env, context);
  }
  return assetResponse(request, env);
}

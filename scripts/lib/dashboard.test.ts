import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateAudienceScore, isLikelyBot } from "./audience.js";
import {
  buildDashboard,
  dashboardCacheKey,
  fetchOwnerRepoCounts,
  filterRepo,
  freshness,
  GitHubRateLimitError,
  normalizeBuildOptions,
  resolveOwnerType,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard.js";
import {
  dashboardRoute,
  ownerActivityFromPath,
  ownerActivityPath,
  ownerDashboardPath,
  optionsFromSearch,
  ownerFromPath,
  fallbackApiOrigin,
  repoDetailPath,
  repoFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../src/routing.js";
import {
  attentionReasons,
  matchesProjectSearch,
  needsAttention,
  parseViewState,
  releaseDebtText,
  showCodeChurn,
  sortProjects,
  viewStateSearch,
  type DashboardViewState,
} from "../../src/dashboard-view.js";
import { isGitHubRateLimit } from "../../src/rate-limit.js";
import type {
  AuthFunnelSummary,
  DashboardPayload,
  GitHubAccessSummary,
  OwnerActivityPayload,
  Project,
  AudienceRange,
  RepoAudiencePayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
  RefreshJob,
  RefreshTarget,
  SchedulerAdminPayload,
  SchedulerAuditEvent,
  TrustProfilePayload,
} from "../../src/types.js";
import worker, {
  DashboardBuildLock,
  dashboardStreamSignature,
  dashboardStreamState,
} from "../../worker/index.js";

const textEncoder = new TextEncoder();
const systemDate = Date;
const testClockStartedAt = systemDate.now();
const testClockEpoch = systemDate.parse("2026-06-13T12:00:00Z");

// Keep calendar-based cache fixtures stable while preserving real elapsed time.
class TestDate extends systemDate {
  constructor(value?: string | number) {
    super(value === undefined ? TestDate.now() : value);
  }

  static override now(): number {
    return testClockEpoch + systemDate.now() - testClockStartedAt;
  }
}

globalThis.Date = TestDate as DateConstructor;

test("browser rate-limit detection covers HTTP and cached GitHub quota failures", () => {
  assert.equal(isGitHubRateLimit(429), true);
  assert.equal(isGitHubRateLimit(403, "API rate limit exceeded"), true);
  assert.equal(isGitHubRateLimit(200, "shared GitHub quota paused until reset"), true);
  assert.equal(
    isGitHubRateLimit(200, "Repository detail is cache-only while shared GitHub quota recovers."),
    true,
  );
  assert.equal(isGitHubRateLimit(500, "dashboard fetch failed"), false);
  assert.equal(isGitHubRateLimit(200, "shared quota · 4,812 left"), false);
});

async function socialRenderAsset(request: Request, paths?: string[]): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  paths?.push(pathname);
  const assets: Record<string, string> = {
    "/resvg.wasm": "node_modules/@resvg/resvg-wasm/index_bg.wasm",
    "/jetbrains-mono-latin-400-normal.woff2":
      "node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
    "/jetbrains-mono-latin-700-normal.woff2":
      "node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2",
  };
  const file = assets[pathname];
  return file
    ? new Response(await readFile(file))
    : new Response("not found", {
        status: 404,
      });
}

function kvStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const names = [...values.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .sort();
      const start = Number.parseInt(options.cursor ?? "0", 10) || 0;
      const limit = options.limit ?? names.length;
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= names.length,
        ...(next < names.length ? { cursor: String(next) } : {}),
      };
    },
  };
}

function durableLocks(env: ConstructorParameters<typeof DashboardBuildLock>[1]) {
  const stubs = new Map<string, { fetch(request: Request): Promise<Response> }>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      const existing = stubs.get(id);
      if (existing) return existing;
      const values = new Map<string, unknown>();
      let chain = Promise.resolve();
      const state = {
        storage: {
          async get<T>(key: string) {
            return values.get(key) as T | undefined;
          },
          async put<T>(key: string, value: T) {
            values.set(key, value);
          },
          async delete(key: string) {
            return values.delete(key);
          },
        },
        blockConcurrencyWhile<T>(callback: () => Promise<T>) {
          const result = chain.then(callback, callback);
          chain = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      };
      const object = new DashboardBuildLock(state, env);
      const stub = { fetch: (request: Request) => object.fetch(request) };
      stubs.set(id, stub);
      return stub;
    },
  };
}

async function refreshAuditEvents(
  cache: ReturnType<typeof kvStore>,
): Promise<SchedulerAuditEvent[]> {
  const current = await cache.list({ prefix: "refresh:audit:v2:" });
  return (
    await Promise.all(
      current.keys.map(
        async (key) => JSON.parse((await cache.get(key.name)) ?? "{}") as SchedulerAuditEvent,
      ),
    )
  )
    .filter((event) => event.event)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

async function githubAccessRouteRecords(cache: ReturnType<typeof kvStore>): Promise<
  Array<{
    area?: string;
    route?: string;
    source?: string;
    resource?: string | null;
    status?: number;
  }>
> {
  const accessKeys = await cache.list({ prefix: "github:access:v1:" });
  const records = await Promise.all(
    accessKeys.keys.map(async (key) => JSON.parse((await cache.get(key.name)) ?? "{}")),
  );
  return records.flatMap((record) =>
    record.routes && typeof record.routes === "object" ? Object.values(record.routes) : [record],
  );
}

test("worker records client dashboard timing beacons in audit log", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const response = await worker.fetch(
    new Request("https://release.bar/api/_client-timing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: "dashboard",
        source: "fetch",
        path: "/steipete",
        apiPath: "/api/steipete",
        attempt: 0,
        httpStatus: 200,
        cacheState: "stale",
        headerMs: 42.4,
        bodyMs: 3.2,
        renderMs: 17.8,
        totalMs: 63.4,
        navigationTtfbMs: 91.2,
        projects: 58,
        scanned: 12,
        limit: 200,
        done: false,
      }),
    }),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );

  assert.equal(response.status, 202);
  await Promise.all(waits);
  const [event] = await refreshAuditEvents(cache);
  assert.equal(event?.event, "client_dashboard_timing");
  assert.equal(event?.source, "browser");
  assert.equal(event?.reason, "fetch");
  assert.equal(event?.status, "stale");
  assert.equal(event?.durationMs, 63);
  assert.equal(event?.projects, 58);
  assert.equal(event?.scanned, 12);
  assert.equal(event?.limit, 200);
  assert.equal(event?.done, false);
  assert.match(event?.detail ?? "", /path=\/steipete/);
  assert.match(event?.detail ?? "", /headerMs=42/);
  assert.match(event?.detail ?? "", /navTtfbMs=91/);
});

test("worker stores GitHub access counters and cached owner identity", async () => {
  const backingCache = kvStore();
  let releaseAuditWrites: () => void = () => undefined;
  const auditWriteGate = new Promise<void>((resolve) => {
    releaseAuditWrites = resolve;
  });
  const cache = {
    ...backingCache,
    async put(key: string, value: string) {
      if (key.startsWith("github:access:")) await auditWriteGate;
      await backingCache.put(key, value);
    },
  };
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const waits: Array<Promise<unknown>> = [];
  try {
    Math.random = () => 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/owner") {
        return Response.json(
          {
            login: "owner",
            type: "User",
            avatar_url: "https://github.com/owner.png",
            html_url: "https://github.com/owner",
          },
          {
            headers: {
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-resource": "core",
            },
          },
        );
      }
      if (url.pathname === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    let foregroundTimeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      worker.fetch(
        new Request("https://release.bar/api/owner"),
        { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "token" },
        { waitUntil: (promise) => waits.push(promise) },
      ),
      new Promise<never>((_resolve, reject) => {
        foregroundTimeout = setTimeout(
          () => reject(new Error("foreground response waited for GitHub audit KV")),
          1000,
        );
      }),
    ]);
    if (foregroundTimeout) clearTimeout(foregroundTimeout);

    assert.equal(response.status, 200);
    releaseAuditWrites();
    await Promise.all(waits);
    const owner = JSON.parse((await cache.get("owner:v1:owner")) ?? "{}") as {
      login?: string;
    };
    assert.equal(owner.login, "owner");
    const records = await githubAccessRouteRecords(cache);
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" &&
          record.source === "shared" &&
          record.route === "users/:owner",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" &&
          record.source === "shared" &&
          record.route === "graphql/ReleaseBarOwnerRepos.metadata",
      ),
    );
  } finally {
    releaseAuditWrites();
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signedJson(secret: string, value: unknown): Promise<string> {
  const payload = base64Url(textEncoder.encode(JSON.stringify(value)));
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function webhookSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(body)));
  return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function crawlerRequest(
  url: string,
  userAgent = "Mozilla/5.0 (Linux; Android 6.0.1) AppleWebKit/537.36 Chrome/148.0 Mobile Safari/537.36 (compatible; GoogleOther)",
  cf: Record<string, unknown> | null = { verifiedBotCategory: "AI Crawler" },
): Request {
  const request = new Request(url, {
    headers: {
      "user-agent": userAgent,
    },
  });
  if (cf) {
    Object.defineProperty(request, "cf", {
      value: cf,
    });
  }
  return request;
}

function testProject(overrides: Partial<Project> & Pick<Project, "owner" | "name">): Project {
  const { owner, name, ...rest } = overrides;
  const fullName = `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    description: null,
    url: `https://github.com/${fullName}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 1,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/${fullName}/issues`,
    pullRequestsUrl: `https://github.com/${fullName}/pulls`,
    archived: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    latestCommitSha: "abcdef1",
    latestCommitDate: "2026-05-15T00:00:00Z",
    version: "v1.0.0",
    releaseName: null,
    releaseUrl: `https://github.com/${fullName}/releases/tag/v1.0.0`,
    releaseDate: "2026-05-01T00:00:00Z",
    commitsSinceRelease: 0,
    compareUrl: `https://github.com/${fullName}/compare/v1.0.0...main`,
    ciState: "success",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "fresh",
    ...rest,
  };
}

function testDashboard(owner: string, projects: Project[]): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: `Release freshness for @${owner}.`,
    canonicalDomain: "release.bar",
    generatedAt: "2026-05-15T12:00:00Z",
    owners: [{ type: "user", login: owner }],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: false,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: "2026-05-15T12:00:00Z",
    },
    totals: {
      repos: projects.length,
      released: projects.filter((project) => project.releaseDate).length,
      unreleased: projects.filter((project) => !project.releaseDate).length,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease ?? 0),
        0,
      ),
    },
    projects,
  };
}

test("owner route parsing keeps root hot board and owners API-backed", () => {
  assert.equal(ownerFromPath("/"), null);
  assert.equal(ownerFromPath("/index.html"), null);
  assert.equal(ownerFromPath("/OpenClaw"), "OpenClaw");
  assert.equal(ownerFromPath("/bad_owner"), null);
  assert.equal(ownerDashboardPath("@Steipete"), "/steipete");
  assert.deepEqual(repoFromPath("/OpenClaw/Peekaboo"), {
    owner: "openclaw",
    repo: "peekaboo",
    fullName: "openclaw/peekaboo",
    apiPath: `${workerApiOrigin}/api/repos/openclaw/peekaboo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/openclaw/peekaboo`,
  });
  assert.equal(repoFromPath("/openclaw"), null);
  assert.equal(repoDetailPath("OpenClaw/Peekaboo"), "/openclaw/peekaboo");
  assert.equal(repoDetailPath("OpenClaw/react.dev"), "/-/openclaw/react.dev");
  assert.equal(repoFromPath("/acme/activity"), null);
  assert.equal(repoDetailPath("acme/activity"), "/-/acme/activity");
  assert.deepEqual(ownerActivityFromPath("/Steipete/activity"), {
    owner: "steipete",
    apiPath: `${workerApiOrigin}/api/steipete/activity`,
    fallbackApiPath: `${workersDevApiOrigin}/api/steipete/activity`,
  });
  assert.equal(ownerActivityFromPath("/api/activity"), null);
  assert.deepEqual(ownerActivityFromPath("/-/owners/api/activity"), {
    owner: "api",
    apiPath: `${workerApiOrigin}/api/api/activity`,
    fallbackApiPath: `${workersDevApiOrigin}/api/api/activity`,
  });
  assert.equal(ownerActivityFromPath("/steipete/activity/extra"), null);
  assert.equal(ownerActivityPath("@Steipete"), "/steipete/activity");
  assert.equal(ownerActivityPath("@Steipete", "day"), "/steipete/activity?range=day");
  assert.equal(ownerActivityPath("@Steipete", "month"), "/steipete/activity?range=month");
  assert.equal(ownerActivityPath("@api"), "/-/owners/api/activity");
  assert.equal(ownerActivityPath("@og", "month"), "/-/owners/og/activity?range=month");
  assert.deepEqual(repoFromPath("/-/og/foo"), {
    owner: "og",
    repo: "foo",
    fullName: "og/foo",
    apiPath: `${workerApiOrigin}/api/repos/og/foo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/og/foo`,
  });
  assert.equal(repoDetailPath("og/foo"), "/-/og/foo");

  assert.deepEqual(dashboardRoute("/", "").isDefault, true);
  assert.equal(dashboardRoute("/", "").apiPath, `${workerApiOrigin}/api/_discover`);
  assert.equal(dashboardRoute("/", "").fallbackApiPath, `${workersDevApiOrigin}/api/_discover`);
  assert.equal(dashboardRoute("/", "").discoverPeriod, "week");
  assert.equal(
    dashboardRoute("/", "?period=day&hotLang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_discover?period=day&lang=TypeScript`,
  );
  assert.equal(
    dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_hot`,
  );
  assert.equal(dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").discoverLanguage, "");
  assert.equal(
    dashboardRoute("/", "?period=day&lang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_discover?period=day`,
  );
  assert.equal(dashboardRoute("/openclaw", "").apiPath, `${workerApiOrigin}/api/openclaw`);
  assert.equal(
    dashboardRoute("/openclaw", "?forks=true&archived=true&unreleased=true").apiPath,
    `${workerApiOrigin}/api/openclaw?forks=true&archived=true`,
  );
  assert.equal(
    dashboardRoute("/openclaw", "?unreleased=false").apiPath,
    `${workerApiOrigin}/api/openclaw?unreleased=false`,
  );
  assert.equal(
    dashboardRoute("/openclaw", "?owners=steipete,openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/openclaw?owners=steipete&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/dashboard?owners=openclaw&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw").fallbackApiPath,
    `${workersDevApiOrigin}/api/dashboard?owners=openclaw`,
  );
  assert.equal(
    fallbackApiOrigin({ protocol: "http:", hostname: "127.0.0.1", port: "5174" }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    fallbackApiOrigin({ protocol: "http:", hostname: "localhost", port: "8787" }),
    workersDevApiOrigin,
  );
  assert.equal(
    dashboardRoute(
      "/openclaw",
      "?q=codex&lang=Swift&filter=attention&sort=issues&dir=desc&dev=true",
    ).apiPath,
    `${workerApiOrigin}/api/openclaw`,
  );
});

test("owner activity event logs are collapsed by default", async () => {
  const source = await readFile("src/App.svelte", "utf8");
  assert.match(source, /<details class="activity-event-details">/);
  assert.doesNotMatch(source, /<details class="activity-event-details"[^>]*\bopen(?:=|\s|>)/);
});

test("dashboard view state restores search, filters, sorting, and dev columns", () => {
  assert.deepEqual(
    parseViewState("?q=CodexBar&lang=Swift&filter=attention&sort=issues&dir=asc", false),
    {
      query: "CodexBar",
      language: "Swift",
      filter: "attention",
      sortKey: "issues",
      sortDirection: "asc",
      devMode: true,
    },
  );
  assert.deepEqual(parseViewState("?filter=nope&sort=nope&dir=sideways", true), {
    query: "",
    language: "",
    filter: "all",
    sortKey: "since",
    sortDirection: "desc",
    devMode: false,
  });
  assert.deepEqual(parseViewState("?sort=version&dir=asc", false), {
    query: "",
    language: "",
    filter: "all",
    sortKey: "activity",
    sortDirection: "desc",
    devMode: false,
  });

  const state: DashboardViewState = {
    query: "repo",
    language: "Go",
    filter: "hot",
    sortKey: "prs",
    sortDirection: "desc",
    devMode: true,
  };
  assert.equal(
    viewStateSearch("?owners=openclaw&q=old", state, false),
    "?owners=openclaw&q=repo&lang=Go&filter=hot&sort=prs&dir=desc&dev=true",
  );
  assert.equal(
    viewStateSearch(
      "?owners=openclaw&q=repo&filter=all&sort=activity&dir=desc&dev=true",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
    "?owners=openclaw",
  );
  assert.equal(
    viewStateSearch(
      "?period=day&hotLang=TypeScript&lang=Swift",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
    "?period=day&hotLang=TypeScript",
  );
});

test("dashboard project sorting handles dev issue and pull request counts numerically", () => {
  const projects = [
    testProject({ owner: "owner", name: "zero", openIssues: 0, openPullRequests: 0 }),
    testProject({ owner: "owner", name: "many", openIssues: 37, openPullRequests: 3 }),
    testProject({ owner: "owner", name: "some", openIssues: 4, openPullRequests: 12 }),
    testProject({ owner: "owner", name: "unknown", openIssues: null, openPullRequests: null }),
  ];

  assert.deepEqual(
    sortProjects(projects, "issues", "desc").map((project) => project.name),
    ["many", "some", "zero", "unknown"],
  );
  assert.deepEqual(
    sortProjects(projects, "prs", "desc").map((project) => project.name),
    ["some", "many", "zero", "unknown"],
  );
  assert.deepEqual(
    sortProjects(
      [
        testProject({ owner: "owner", name: "small", stars: 10 }),
        testProject({ owner: "owner", name: "large", stars: 1000 }),
      ],
      "stars",
      "desc",
    ).map((project) => project.name),
    ["large", "small"],
  );
});

test("dashboard project search matches independent metadata terms", () => {
  const project = testProject({
    owner: "owner",
    name: "releasebar",
    description: "Manual refresh dashboard",
    language: "TypeScript",
    topics: ["cloudflare", "worker"],
    version: "v1.2.3",
    releaseName: "Ship dashboard search",
    ciState: "failure",
    ciWorkflow: "CI",
  });

  assert.equal(matchesProjectSearch(project, ""), true);
  assert.equal(matchesProjectSearch(project, "typescript v1.2.3"), true);
  assert.equal(matchesProjectSearch(project, "owner worker ci"), true);
  assert.equal(matchesProjectSearch(project, "ship failure"), true);
  assert.equal(matchesProjectSearch(project, "typescript swift"), false);
});

test("dashboard stream signature changes when dev sort counts change", () => {
  const payload = testDashboard("owner", [
    testProject({ owner: "owner", name: "one", openIssues: 1, openPullRequests: 2 }),
  ]);
  payload.generatedAt = "2026-05-22T00:00:00.000Z";
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 16, limit: 200, done: false },
  };
  const next = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  next.projects[0]!.openPullRequests = 9;

  assert.notEqual(
    dashboardStreamSignature(payload, "partial"),
    dashboardStreamSignature(next, "partial"),
  );
  const archived = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  archived.projects[0]!.archived = true;
  assert.notEqual(
    dashboardStreamSignature(payload, "partial"),
    dashboardStreamSignature(archived, "partial"),
  );
  const fresher = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  fresher.cache!.countsUpdatedAt = "2026-05-22T00:01:00.000Z";
  assert.notEqual(
    dashboardStreamSignature(payload, "partial"),
    dashboardStreamSignature(fresher, "partial"),
  );
});

test("dashboard stream state preserves explicit webhook invalidation", () => {
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  payload.generatedAt = new Date().toISOString();
  payload.cache = {
    state: "stale",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
  };
  assert.equal(dashboardStreamState(payload), "stale");
});

test("repository detail hides unavailable code churn", () => {
  const base: RepoDetailPayload = {
    fullName: "owner/repo",
    generatedAt: "2026-05-18T00:00:00Z",
    cache: {
      state: "fresh",
      stale: false,
      generatedAt: "2026-05-18T00:00:00Z",
    },
    stats: {
      commitActivity: { state: "ready" },
      codeFrequency: {
        state: "unavailable",
        message: "repository must have fewer than 10000 commits",
      },
    },
    project: testProject({ owner: "owner", name: "repo" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };

  assert.equal(showCodeChurn(base), false);
  assert.equal(
    showCodeChurn({
      ...base,
      stats: {
        commitActivity: base.stats?.commitActivity ?? { state: "ready" },
        codeFrequency: { state: "warming", message: "GitHub is preparing repository statistics." },
      },
    }),
    true,
  );
  assert.equal(
    showCodeChurn({
      ...base,
      codeFrequency: [{ week: "2026-05-18T00:00:00Z", additions: 10, deletions: 3 }],
    }),
    true,
  );
});

test("audience scoring uses only public profile and stargazer signals", () => {
  assert.equal(isLikelyBot("dependabot"), true);
  const bot = calculateAudienceScore({
    login: "github-actions[bot]",
    followers: 100000,
    following: 0,
    publicRepos: 100,
    publicGists: 0,
    company: "GitHub",
    bio: "Automation",
    location: "CI",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2018-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  assert.equal(bot.score, 0);
  assert.equal(bot.tier, "bot");
  assert.deepEqual(bot.reasons, ["automation account"]);
  assert.deepEqual(bot.dimensions, {
    trust: 0,
    influence: 0,
    builder: 0,
    recency: 0,
    risk: 0,
  });
  assert.equal(bot.factors[0]?.key, "risk");
  assert.equal(bot.factors[0]?.label, "account safety");
  assert.equal(bot.factors[0]?.sentiment, "negative");

  const high = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: new Date().toISOString(),
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  assert.equal(high.tier, "high");
  assert.ok(high.score >= 70);
  assert.ok(high.reasons.includes("known tech company"));
  assert.ok(high.reasons.includes("notable org: github"));
  assert.ok(high.dimensions.trust >= 80);
  assert.equal(high.dimensions.risk, 100);
  assert.equal(high.factors.find((factor) => factor.key === "age")?.label, "account age");
  assert.deepEqual(
    high.factors.map((factor) => factor.key),
    ["age", "profile", "orgs", "reach", "builder", "recency", "risk"],
  );
  assert.ok((high.factors.find((factor) => factor.key === "builder")?.weightedValue ?? 0) > 0);
  const profileOnly = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: null,
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  assert.equal(profileOnly.factors.find((factor) => factor.key === "recency")?.weight, 0);
  assert.equal(profileOnly.tier, "high");
  assert.equal(
    Math.round(profileOnly.factors.reduce((sum, factor) => sum + factor.weightedValue, 0)),
    profileOnly.score,
  );

  const low = calculateAudienceScore({
    login: "quiet-user",
    followers: 2,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    company: null,
    bio: null,
    location: null,
    starredAt: null,
  });
  assert.equal(low.tier, "low");
  assert.ok(low.score < 40);
  assert.equal(low.factors.find((factor) => factor.key === "risk")?.sentiment, "negative");
});

test("isLikelyBot uses account type before narrow login fallbacks", () => {
  // GitHub account metadata is authoritative when it is available.
  for (const login of ["cabot", "crawlerbot", "robot", "gpt4bot"]) {
    assert.equal(isLikelyBot(login, "Bot"), true, `${login} with Bot type should be a bot`);
    assert.equal(isLikelyBot(login, "App"), true, `${login} with App type should be a bot`);
    assert.equal(isLikelyBot(login, "User"), false, `${login} with User type should be human`);
  }

  // Narrow lexical fallback for callers that do not have account type metadata.
  for (const login of [
    "dependabot",
    "renovate",
    "github-actions",
    "github-actions[bot]",
    "my-bot",
    "ci.bot",
    "bot-ci",
    "foo[bot]",
    "bot",
  ]) {
    assert.equal(isLikelyBot(login), true, `${login} should be detected as a bot`);
  }

  for (const login of ["renovate-bot", "bot-ci", "foo[bot]", "github-actions"]) {
    assert.equal(
      isLikelyBot(login, "User"),
      true,
      `${login} should keep explicit bot fallback with User metadata`,
    );
  }

  // No-separator *bot names are ambiguous without metadata, so do not guess.
  for (const login of [
    "cabot",
    "talbot",
    "abbot",
    "wilbot",
    "arbot",
    "crawlerbot",
    "robot",
    "gpt4bot",
  ]) {
    assert.equal(isLikelyBot(login), false, `${login} should require metadata before bot tier`);
  }

  // A strong human profile whose login ends in "bot" is scored, not zeroed out.
  const human = calculateAudienceScore({
    login: "cabot",
    accountType: "User",
    followers: 5000,
    following: 50,
    publicRepos: 80,
    publicGists: 2,
    company: "GitHub",
    bio: "Principal engineer",
    location: "SF",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2015-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  assert.notEqual(human.tier, "bot");
  assert.ok(human.score > 0);

  const typedBot = calculateAudienceScore({
    login: "octocat",
    accountType: "Bot",
    followers: 5000,
    following: 50,
    publicRepos: 80,
    publicGists: 2,
    company: "GitHub",
    bio: "Automation",
    location: "CI",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2015-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  assert.equal(typedBot.score, 0);
  assert.equal(typedBot.tier, "bot");
  assert.deepEqual(typedBot.reasons, ["automation account"]);
});

test("need attention explains release debt, stale releases, CI, and open work", () => {
  const stale = testProject({
    owner: "owner",
    name: "stale",
    releaseDate: "2026-01-01T00:00:00Z",
  });
  const pressured = testProject({
    owner: "owner",
    name: "pressure",
    commitsSinceRelease: 42,
    freshness: "hot",
    ciState: "failure",
    openPullRequests: 12,
    openIssues: 120,
  });
  const releaseDebt = testProject({
    owner: "owner",
    name: "release-debt",
    commitsSinceRelease: 201,
    freshness: "hot",
    releaseDate: "2026-05-01T00:00:00Z",
  });

  assert.equal(needsAttention(stale), true);
  assert.deepEqual(attentionReasons(stale, Date.parse("2026-05-15T00:00:00Z")), [
    "last release 134 days ago",
  ]);
  assert.equal(needsAttention(pressured), true);
  assert.deepEqual(attentionReasons(pressured), ["CI failing", "12 open PRs", "120 open issues"]);
  assert.equal(needsAttention(releaseDebt), true);
  assert.equal(needsAttention({ ...pressured, archived: true }), false);
  assert.equal(releaseDebtText({ ...releaseDebt, archived: true }), null);
  assert.deepEqual(attentionReasons({ ...pressured, archived: true }), []);
  assert.deepEqual(attentionReasons(releaseDebt, Date.parse("2026-05-15T00:00:00Z")), [
    "201 commits since release",
  ]);
  assert.equal(
    attentionReasons(
      testProject({ owner: "owner", name: "fresh" }),
      Date.parse("2026-05-15T00:00:00Z"),
    ).length,
    0,
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "warm",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "hot-placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "unreleased",
        version: "unreleased",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
});

test("worker builds root hot dashboard from cached dashboards", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const forksKey = dashboardCacheKey({ owner: "forks", includeForks: true, schemaVersion: 6 });
  const legacyKey = dashboardCacheKey({ owner: "legacy", schemaVersion: 5 });
  const env = {
    DASHBOARD_CACHE: kvStore({
      "hot:index:v3": JSON.stringify([alphaKey, legacyKey]),
      [alphaKey]: JSON.stringify(
        testDashboard("alpha", [
          testProject({
            owner: "alpha",
            name: "hot",
            commitsSinceRelease: 100,
            freshness: "hot",
          }),
          testProject({ owner: "alpha", name: "second", commitsSinceRelease: 80 }),
          testProject({ owner: "alpha", name: "third", commitsSinceRelease: 60 }),
          testProject({ owner: "alpha", name: "fourth", commitsSinceRelease: 40 }),
          testProject({
            owner: "alpha",
            name: "archived",
            archived: true,
            commitsSinceRelease: 120,
          }),
        ]),
      ),
      [betaKey]: JSON.stringify(
        testDashboard("beta", [
          testProject({
            owner: "beta",
            name: "popular",
            stars: 500,
            commitsSinceRelease: 20,
          }),
          testProject({
            owner: "beta",
            name: "unreleased",
            releaseDate: null,
            commitsSinceRelease: null,
          }),
        ]),
      ),
      [forksKey]: JSON.stringify({
        ...testDashboard("forks", [
          testProject({
            owner: "forks",
            name: "cached-fork",
            commitsSinceRelease: 500,
            freshness: "hot",
          }),
        ]),
        options: {
          includeForks: true,
          includeArchived: false,
          includeUnreleased: false,
          repoLimit: 200,
        },
      }),
      [legacyKey]: JSON.stringify(
        testDashboard("legacy", [
          testProject({
            owner: "legacy",
            name: "estimated-counts",
            stars: 10_000,
            openIssues: 500,
            openPullRequests: 100,
          }),
        ]),
      ),
      [dashboardCacheKey({ owner: "gamma", schemaVersion: 6 })]: JSON.stringify(
        testDashboard("gamma", [
          testProject({
            owner: "gamma",
            name: "from-list",
            commitsSinceRelease: 30,
          }),
        ]),
      ),
      "owner-metadata:v1:alpha": JSON.stringify({
        owner: "alpha",
        generatedAt: new Date().toISOString(),
        metadataUpdatedAt: new Date().toISOString(),
        countsUpdatedAt: new Date().toISOString(),
        releaseDataComplete: true,
        projects: [
          testProject({ owner: "alpha", name: "hot", openIssues: 99 }),
          testProject({ owner: "alpha", name: "second", archived: true }),
        ],
      }),
    }),
  };

  const response = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.title, "ReleaseBar Hot");
  assert.deepEqual(body.owners, []);
  assert.equal(body.projects[0]?.fullName, "alpha/hot");
  assert.equal(body.projects[0]?.openIssues, 99);
  assert.equal(
    body.projects.some((project) => project.fullName === "alpha/second"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "alpha/archived"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "beta/unreleased"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "legacy/estimated-counts"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "forks/cached-fork"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "gamma/from-list"),
    true,
  );
  assert.equal(body.projects.filter((project) => project.owner === "alpha").length <= 3, true);
  assert.match(body.cache?.message ?? "", /cached dashboards/);

  const cachedResponse = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });
  const cachedBody = (await cachedResponse.json()) as DashboardPayload;
  assert.equal(cachedBody.cache?.repoLimit, null);
  assert.match(cachedBody.cache?.message ?? "", /cached dashboards/);
});

test("worker serves stale hot dashboards while one background rebuild refreshes the cache", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const staleAt = new Date().toISOString();
  const staleHot: DashboardPayload = {
    ...testDashboard("stale", [
      testProject({ owner: "stale", name: "cached", commitsSinceRelease: 5 }),
    ]),
    title: "ReleaseBar Hot",
    generatedAt: staleAt,
    owners: [],
    cache: {
      state: "stale",
      stale: true,
      capped: false,
      repoLimit: null,
      generatedAt: staleAt,
    },
  };
  const cache = kvStore({
    "hot:v3": JSON.stringify(staleHot),
    "hot:index:v3": JSON.stringify([alphaKey]),
    [alphaKey]: JSON.stringify(
      testDashboard("alpha", [
        testProject({ owner: "alpha", name: "fresh", commitsSinceRelease: 50 }),
      ]),
    ),
  });
  const waits: Array<Promise<unknown>> = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/_hot"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );
  const body = (await response.json()) as DashboardPayload;

  assert.equal(response.status, 200);
  assert.equal(body.cache?.state, "stale");
  assert.match(body.cache?.message ?? "", /while it refreshes/);
  assert.equal(body.projects[0]?.fullName, "stale/cached");

  await Promise.all(waits);
  const refreshed = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  assert.equal(refreshed.cache?.state, "fresh");
  assert.equal(refreshed.projects[0]?.fullName, "alpha/fresh");
});

test("worker keeps hot owner route distinct from root hot API", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/hot") {
      return Response.json({ login: "hot", type: "User" });
    }
    if (url.pathname === "/users/hot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/hot"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: (promise) => waits.push(promise) },
    );
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(response.status, 200);
    assert.equal(body.owners[0]?.login, "hot");
    assert.notEqual(body.title, "ReleaseBar Hot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves escaped dotted repository detail paths as app shell", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/-/openclaw/react.dev"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ReleaseBar release freshness dashboard for openclaw\/react\.dev/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
});

test("worker reserves owner activity pages while escaped activity repositories remain available", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/acme/activity"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /@acme activity/);
  assert.doesNotMatch(html, /id="releasebar-initial-data"/);

  const escaped = await worker.fetch(
    new Request("https://release.bar/-/acme/activity"),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );
  assert.equal(escaped.status, 200);
  assert.match(await escaped.text(), /acme\/activity/);

  for (const owner of ["api", "og"]) {
    const reserved = await worker.fetch(
      new Request(`https://release.bar/-/owners/${owner}/activity`),
      {
        ASSETS: {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, "/index.html");
            return new Response(
              '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
              { headers: { "content-type": "text/html" } },
            );
          },
        },
        DASHBOARD_CACHE: kvStore(),
      },
      { waitUntil: () => undefined },
    );
    assert.equal(reserved.status, 200);
    assert.match(await reserved.text(), new RegExp(`@${owner} activity`));
  }
});

test("worker preserves API and social namespaces beside escaped reserved-owner activity pages", async () => {
  const generatedAt = new Date().toISOString();
  const dashboard = testDashboard("activity", []);
  dashboard.generatedAt = generatedAt;
  if (dashboard.cache && dashboard.options) {
    dashboard.cache.generatedAt = generatedAt;
    dashboard.options.includeUnreleased = true;
  }
  const key = dashboardCacheKey({
    owner: "activity",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/activity"),
    {
      ASSETS: {
        fetch: async () => {
          throw new Error("API namespace must not reach app assets");
        },
      },
      DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    },
    { waitUntil: () => undefined },
  );
  assert.equal(apiResponse.status, 200);
  assert.match(apiResponse.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(((await apiResponse.json()) as DashboardPayload).owners[0]?.login, "activity");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const socialResponse = await worker.fetch(
      new Request("https://release.bar/og/activity"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(socialResponse.status, 200);
    assert.match(socialResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    assert.match(await socialResponse.text(), /@activity/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached public dashboard data in the app shell", async () => {
  const payload = testDashboard("hot", [testProject({ owner: "acme", name: "releasebar" })]);
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"dashboard"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for ReleaseBar Hot"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/ReleaseBar%20Hot\.png"/,
  );
  assert.ok(html.indexOf('id="releasebar-initial-data"') < html.indexOf('<script type="module"'));
});

test("worker embeds cached metadata-only owner dashboard data in the app shell", async () => {
  const payload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.options = { ...payload.options!, includeUnreleased: true };
  payload.cache = {
    ...payload.cache!,
    message: "release scan skipped until GitHub App quota is available",
  };
  const metadataKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = {
    ...payload,
    projects: [
      testProject({
        owner: "owner",
        name: "repo",
        version: "v9.9.9",
        releaseName: "hydrated release cache",
      }),
    ],
  } satisfies DashboardPayload;
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        [metadataKey]: JSON.stringify(payload),
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "cookie");
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /owner\\u002frepo|owner\/repo/);
  assert.match(html, /release scan skipped/);
  assert.doesNotMatch(html, /hydrated release cache/);
});

test("worker does not embed a release-only cache for an unsynced owner dashboard", async () => {
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "v9.9.9",
      releaseName: "hydrated release cache",
    }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore({
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /hydrated release cache/);
  assert.doesNotMatch(html, /id="releasebar-initial-data"/);
});

test("signed-in mixed-account fast paths preserve release dashboards", async () => {
  const sessionId = "session-mixed-cache";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const generatedAt = new Date().toISOString();
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const keyInput = {
    owner: "openclaw",
    owners: ["steipete"],
    includeUnreleased: true,
    schemaVersion: 6,
  };
  const metadataKey = dashboardCacheKey({ ...keyInput, includeReleaseData: false });
  const releaseKey = dashboardCacheKey({ ...keyInput, includeReleaseData: true });
  const metadataPayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "repo search",
      releaseName: "metadata cache",
    }),
  ]);
  metadataPayload.generatedAt = generatedAt;
  metadataPayload.cache = { ...metadataPayload.cache!, generatedAt };
  const releasePayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "v1.2.3",
      releaseName: "hydrated release cache",
    }),
  ]);
  releasePayload.generatedAt = generatedAt;
  releasePayload.cache = { ...releasePayload.cache!, generatedAt };
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    ASSETS: {
      fetch: async () =>
        new Response(
          '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
          { headers: { "content-type": "text/html" } },
        ),
    },
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
      [metadataKey]: JSON.stringify(metadataPayload),
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const requestHeaders = { cookie: `rd_session=${authCookie}` };

  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(apiResponse.status, 200);
  const apiPayload = (await apiResponse.json()) as DashboardPayload;
  assert.equal(apiPayload.projects[0]?.releaseName, "hydrated release cache");

  const pageResponse = await worker.fetch(
    new Request("https://release.bar/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /hydrated release cache/);
  assert.doesNotMatch(html, /metadata cache/);
});

test("worker embeds cached crawler dashboard shells without discovering app installs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  let installationListCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([]);
    }
    throw new Error(`crawler shell should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/owner", "Googlebot/2.1", null),
      {
        ASSETS: {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, "/index.html");
            return new Response(
              '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
              { headers: { "content-type": "text/html" } },
            );
          },
        },
        DASHBOARD_CACHE: kvStore({
          [key]: JSON.stringify(payload),
        }),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );

    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="releasebar-initial-data"/);
    assert.match(html, /owner\\u002frepo|owner\/repo/);
    assert.equal(installationListCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached language-filtered discover data in the app shell", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&hotLang=TypeScript"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /typedbar/);
  assert.doesNotMatch(html, /allbar/);
});

test("worker preserves partial discover state in embedded app shell data", async () => {
  const payload = testDashboard("all", [
    testProject({
      owner: "acme",
      name: "placeholder",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 0, limit: 1, done: false },
  };
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"state":"partial"/);
  assert.match(html, /"done":false/);
});

test("worker does not treat view language filters as discover cache selectors", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&lang=TypeScript"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /allbar/);
  assert.doesNotMatch(html, /typedbar/);
});

test("worker embeds cached public repository detail data in the app shell", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({ owner: "acme", name: "releasebar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const response = await worker.fetch(
    new Request("https://release.bar/acme/releasebar"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"repo"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for acme\/releasebar"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/acme%2Freleasebar\.png"/,
  );
});

test("worker social cards include owner avatars and repository release metrics", async () => {
  const generatedAt = new Date().toISOString();
  const repoPayload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      description: "Release freshness for maintainers",
      version: "v2.0.0",
      commitsSinceRelease: 42,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "repo-detail:v4:acme/releasebar": JSON.stringify(repoPayload),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && ["/acme.png", "/openclaw.png"].includes(url.pathname)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };

  try {
    const repoResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.svg"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoResponse.status, 200);
    const repoSvg = await repoResponse.text();
    assert.match(repoSvg, /acme\/releasebar/);
    assert.match(repoSvg, /v2\.0\.0 · 42 commits since release/);
    assert.match(repoSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(repoSvg, /https:\/\/github\.com\/acme\.png\?size=240/);

    const ownerResponse = await worker.fetch(
      new Request("https://release.bar/og/openclaw.svg"),
      env,
      { waitUntil: () => undefined },
    );
    const ownerSvg = await ownerResponse.text();
    assert.match(ownerSvg, /@openclaw/);
    assert.match(ownerSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(ownerSvg, /https:\/\/github\.com\/openclaw\.png\?size=240/);

    const pngAssetPaths: string[] = [];
    const pngResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.png"),
      {
        ...env,
        ASSETS: {
          fetch: (request: Request) => socialRenderAsset(request, pngAssetPaths),
        },
      },
      { waitUntil: () => undefined },
    );
    assert.equal(pngResponse.status, 200);
    assert.equal(pngResponse.headers.get("content-type"), "image/png");
    const pngBytes = new Uint8Array(await pngResponse.arrayBuffer());
    assert.deepEqual(Array.from(pngBytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(pngBytes.byteLength > 1_000);
    assert.deepEqual(pngAssetPaths, [
      "/resvg.wasm",
      "/jetbrains-mono-latin-400-normal.woff2",
      "/jetbrains-mono-latin-700-normal.woff2",
    ]);
    assert.notEqual(pngAssetPaths[0], "/og-card.png");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const coldStore = kvStore();
  const coldCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/cold.png") {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/png" },
      });
    }
    coldCalls.push(url.pathname);
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
    if (url.pathname === "/repos/cold/repo") {
      return Response.json({
        owner: { login: "cold" },
        name: "repo",
        full_name: "cold/repo",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/cold/repo",
        description: "Cold social repository",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/repos/cold/repo/releases") {
      return Response.json([
        {
          tag_name: "v3.0.0",
          name: "v3",
          html_url: "https://github.com/cold/repo/releases/tag/v3.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-16T12:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/repos/cold/repo/compare/v3.0.0...main") {
      return Response.json({
        total_commits: 9,
        html_url: "https://github.com/cold/repo/compare/v3.0.0...main",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/og/cold%2Frepo.svg"),
      { DASHBOARD_CACHE: coldStore, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const coldSvg = await coldResponse.text();
    assert.match(coldSvg, /v3\.0\.0 · 9 commits since release/);
    assert.match(coldSvg, /data:image\/png;base64,BAUG/);
    assert.deepEqual(coldCalls, [
      "/repos/cold/repo",
      "/repos/cold/repo/releases",
      "/repos/cold/repo/compare/v3.0.0...main",
    ]);
    assert.notEqual(await coldStore.get("social-repo:v3:cold/repo"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stalePayload: RepoDetailPayload = {
    ...repoPayload,
    fullName: "stale/repo",
    generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    project: testProject({
      owner: "stale",
      name: "repo",
      version: "v9.9.9",
      commitsSinceRelease: 7,
    }),
  };
  const queued: Promise<unknown>[] = [];
  let backgroundCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/stale.png") {
      return new Response("not an image", { headers: { "content-type": "text/plain" } });
    }
    backgroundCalls += 1;
    throw new Error("queued refresh only");
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/og/stale%2Frepo.svg"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:stale/repo": JSON.stringify(stalePayload),
        }),
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    const staleSvg = await staleResponse.text();
    assert.match(staleSvg, /v9\.9\.9 · 7 commits since release/);
    assert.match(staleSvg, />SR<\/text>/);
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    assert.equal(backgroundCalls > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cached GitHub discovery dashboards from repository search", async () => {
  const originalFetch = globalThis.fetch;
  const searchItems = Array.from({ length: 13 }, (_, index) => {
    const name = index === 0 ? "releasebar" : `releasebar-${index + 1}`;
    return {
      name,
      full_name: `acme/${name}`,
      private: false,
      fork: false,
      archived: false,
      html_url: `https://github.com/acme/${name}`,
      description: "Release dashboard",
      default_branch: "main",
      language: "TypeScript",
      topics: ["releases", "dashboard"],
      stargazers_count: 1200 - index,
      forks_count: 42,
      open_issues_count: 7,
      pushed_at: "2026-05-16T12:00:00Z",
      updated_at: "2026-05-16T12:00:00Z",
      owner: { login: "acme" },
    };
  });
  let searchCalls = 0;
  const hydratedPaths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      searchCalls += 1;
      assert.match(url.searchParams.get("q") ?? "", /language:"TypeScript"/);
      assert.match(url.searchParams.get("q") ?? "", /pushed:>=/);
      assert.equal(url.searchParams.get("sort"), "stars");
      assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
      return Response.json(
        {
          total_count: searchItems.length,
          incomplete_results: false,
          items: searchItems,
        },
        {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1770000000",
            "x-ratelimit-resource": "search",
          },
        },
      );
    }
    hydratedPaths.push(url.pathname);
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/releases$/)) {
      if (url.pathname === "/repos/acme/releasebar-13/releases") {
        return Response.json([]);
      }
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          published_at: "2026-05-15T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const first = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = (await first.json()) as DashboardPayload;
    assert.equal(body.title, "GitHub Hot");
    assert.equal(body.projects[0]?.fullName, "acme/releasebar");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.deepEqual(body.projects[0]?.topics, ["releases", "dashboard"]);
    assert.equal(body.projects[0]?.openIssues, 7);
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.equal(body.cache?.progress?.limit, searchItems.length);
    assert.equal(body.cache?.quota?.remaining, 4999);
    assert.match(body.cache?.message ?? "", /repository search/);

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(second.status, 200);
    const firstBatch = (await second.json()) as DashboardPayload;
    assert.equal(firstBatch.cache?.state, "partial");
    assert.equal(firstBatch.cache?.progress?.done, false);
    assert.equal(firstBatch.cache?.progress?.scanned, 8);
    assert.equal(
      firstBatch.projects.filter((project) => project.version === "repo search").length,
      5,
    );

    await Promise.all(waitUntil.splice(0));

    const third = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(third.status, 200);
    const hydrated = (await third.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.cache?.progress?.done, true);
    assert.equal(hydrated.cache?.progress?.scanned, searchItems.length);
    assert.equal(
      hydrated.projects.filter((project) => project.version === "repo search").length,
      0,
    );
    assert.equal(hydrated.projects[0]?.version, "v1.2.3");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, null);
    assert.equal(hydrated.projects[0]?.openPullRequests, 0);
    assert.equal(hydrated.projects[12]?.version, "unreleased");
    assert.equal(hydrated.projects[12]?.releaseDate, null);
    assert.equal(searchCalls, 1);
    assert.equal(hydratedPaths.length, searchItems.length);
    assert.equal(
      hydratedPaths.every((path) => /^\/repos\/acme\/[^/]+\/releases$/.test(path)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not rehydrate completed GitHub discovery cache", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date().toISOString(),
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: new Date().toISOString(),
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async () => {
    throw new Error("discovery cache should not fetch");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale discovery caches to crawlers without searching GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const waits: Array<Promise<unknown>> = [];
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: "2026-05-15T12:00:00Z",
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: "2026-05-15T12:00:00Z",
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh discovery ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/_discover?period=week", "SemrushBot/7~bl", null),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.cache?.message, "showing cached discovery results");
    assert.equal(waits.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds cached repository detail with releases and stats", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json(
        {
          owner: { login: "acme" },
          name: "releasebar",
          full_name: "acme/releasebar",
          private: false,
          fork: false,
          archived: false,
          html_url: "https://github.com/acme/releasebar",
          description: "Release dashboard",
          default_branch: "main",
          language: "TypeScript",
          topics: ["release-health"],
          stargazers_count: 1234,
          forks_count: 45,
          open_issues_count: 9,
          pushed_at: "2026-05-16T12:00:00Z",
          updated_at: "2026-05-16T12:00:00Z",
        },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "3000",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    if (path === "/repos/acme/releasebar/releases") {
      assert.equal(url.searchParams.get("per_page"), "100");
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T00:00:00Z",
        },
        {
          tag_name: "v1.2.2",
          name: "Release 1.2.2",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.2",
          draft: false,
          prerelease: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/contributors") {
      return Response.json([
        {
          login: "octo",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/octo",
          contributions: 42,
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/languages") {
      return Response.json({ TypeScript: 900, CSS: 100 });
    }
    if (path === "/repos/acme/releasebar/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/releasebar/pulls") {
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/releasebar/compare/v1.2.3...main") {
      return Response.json({
        total_commits: 6,
        html_url: "https://github.com/acme/releasebar/compare/v1.2.3...main",
      });
    }
    if (path === "/repos/acme/releasebar/commits/abcdef123456/check-runs") {
      return Response.json({
        check_runs: [
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/1",
            status: "completed",
            conclusion: "success",
            name: "CI",
            completed_at: "2026-05-16T12:30:00Z",
          },
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/2",
            status: "completed",
            conclusion: "failure",
            name: "Lint",
            completed_at: "2026-05-16T12:20:00Z",
          },
        ],
      });
    }
    if (path === "/repos/acme/releasebar/stats/commit_activity") {
      return Response.json([{ week: 1778889600, total: 7, days: [0, 1, 2, 0, 3, 1, 0] }]);
    }
    if (path === "/repos/acme/releasebar/stats/code_frequency") {
      return Response.json([[1778889600, 120, -20]]);
    }
    if (path === "/graphql") {
      const payload = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: Record<string, string>;
      };
      assert.match(payload.query ?? "", /ReleaseBarRepoWorkTrend/);
      assert.match(payload.variables?.issuesOpened30d ?? "", /is:issue created:>=/);
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 5 },
          issuesClosed30d: { issueCount: 3 },
          pullRequestsOpened30d: { issueCount: 4 },
          pullRequestsClosed30d: { issueCount: 2 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:octo": JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 73,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.fullName, "acme/releasebar");
    assert.equal(body.project.version, "v1.2.3");
    assert.equal(body.project.commitsSinceRelease, 6);
    assert.equal(body.project.openIssues, 7);
    assert.equal(body.project.openPullRequests, 2);
    assert.equal(body.project.ciState, "failure");
    assert.equal(body.project.ciWorkflow, "Lint");
    assert.equal(body.releases.length, 2);
    assert.equal(body.contributors[0]?.login, "octo");
    assert.equal(body.contributors[0]?.trustScore, 73);
    assert.equal(body.contributors[0]?.trustTier, "high");
    assert.equal(body.commitActivity[0]?.total, 7);
    assert.equal(body.codeFrequency[0]?.additions, 120);
    assert.equal(body.codeFrequency[0]?.deletions, 20);
    assert.equal(body.stats?.commitActivity.state, "ready");
    assert.equal(body.stats?.codeFrequency.state, "ready");
    assert.equal(body.workTrend?.issuesOpened30d, 5);
    assert.equal(body.workTrend?.pullRequestsClosed30d, 2);
    assert.deepEqual(
      body.languages.map((language) => language.name),
      ["TypeScript", "CSS"],
    );
    const accessRecords = await githubAccessRouteRecords(env.DASHBOARD_CACHE);
    assert.ok(
      accessRecords.some(
        (record) =>
          record.area === "repo-detail" &&
          record.source === "shared" &&
          record.resource === "core" &&
          record.status === 200,
      ),
    );
    assert.equal(await env.DASHBOARD_CACHE.get("github:budget:v1:shared:core"), null);

    await env.DASHBOARD_CACHE.put(
      "trust-profile:v4:octo",
      JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 62,
        tier: "medium",
        generatedAt: "2026-05-16T12:05:00Z",
      }),
    );
    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    const cachedBody = (await cached.json()) as RepoDetailPayload;
    assert.equal(cachedBody.contributors[0]?.trustScore, 62);
    assert.equal(cachedBody.contributors[0]?.trustTier, "medium");
    assert.equal(calls, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker revalidates stale repository metadata with ETags", async () => {
  const fullName = "acme/etag";
  const repoPath = "/repos/acme/etag";
  const auxKey = `repo-detail:aux:v2:${encodeURIComponent(fullName)}:repository:${encodeURIComponent(repoPath)}`;
  const env = {
    DASHBOARD_CACHE: kvStore({
      [auxKey]: JSON.stringify({
        generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        etag: '"repo-etag"',
        data: {
          owner: { login: "acme" },
          name: "etag",
          full_name: fullName,
          private: false,
          fork: false,
          archived: false,
          html_url: `https://github.com/${fullName}`,
          description: "ETag repository",
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 0,
          pushed_at: "2026-06-12T12:00:00Z",
          updated_at: "2026-06-12T12:00:00Z",
        },
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  let repositoryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === repoPath) {
      repositoryCalls += 1;
      assert.equal(new Headers(init?.headers).get("if-none-match"), '"repo-etag"');
      return new Response(null, { status: 304, headers: { etag: '"repo-etag"' } });
    }
    if (path === `${repoPath}/releases`) return Response.json([]);
    if (path === `${repoPath}/commits/main`) {
      return Response.json({ message: "Git Repository is empty." }, { status: 409 });
    }
    if (path === `${repoPath}/pulls`) return Response.json([]);
    if (path === `${repoPath}/contributors`) return Response.json([]);
    if (path === `${repoPath}/languages`) return Response.json({});
    if (path === `${repoPath}/stats/commit_activity`) return Response.json([]);
    if (path === `${repoPath}/stats/code_frequency`) return Response.json([]);
    if (path === "/graphql") {
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(`https://release.bar/api/repos/${fullName}`),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.description, "ETag repository");
    assert.equal(repositoryCalls, 1);
    const refreshed = JSON.parse((await env.DASHBOARD_CACHE.get(auxKey)) ?? "{}") as {
      generatedAt?: string;
      etag?: string;
    };
    assert.equal(refreshed.etag, '"repo-etag"');
    assert.ok(Date.parse(refreshed.generatedAt ?? "") > Date.now() - 60_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker bundles App-backed repository core data through GraphQL", async () => {
  const account = "acme";
  const env = {
    DASHBOARD_CACHE: kvStore({
      [`auth:installation:v1:${account}`]: JSON.stringify({
        id: 1,
        accountLogin: account,
        accountType: "org",
        accountUrl: `https://github.com/${account}`,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        repositorySelection: "all",
        repositories: [],
        updatedAt: new Date().toISOString(),
      }),
      "auth:installation-token:1": "installation-token",
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "unused",
  };
  const originalFetch = globalThis.fetch;
  let coreCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer installation-token");
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: { name?: string };
      };
      if (body.query?.includes("ReleaseBarRepoDetailCore")) {
        coreCalls += 1;
        const name = body.variables?.name ?? "graphql";
        const statusContext =
          name === "pending"
            ? {
                __typename: "StatusContext",
                context: "Deploy",
                state: "PENDING",
                targetUrl: "https://github.com/acme/pending/actions",
                createdAt: "2026-06-13T12:25:00Z",
              }
            : {
                __typename: "StatusContext",
                context: "Legacy CI",
                state: "ERROR",
                targetUrl: "https://github.com/acme/graphql/actions",
                createdAt: "2026-06-13T12:25:00Z",
              };
        return Response.json({
          data: {
            repository: {
              owner: { login: account },
              name,
              nameWithOwner: `${account}/${name}`,
              url: `https://github.com/${account}/${name}`,
              description: "Bundled repository detail",
              isPrivate: false,
              isFork: false,
              isArchived: false,
              primaryLanguage: { name: "TypeScript" },
              repositoryTopics: { nodes: [] },
              stargazerCount: 42,
              forkCount: 3,
              issues: { totalCount: 2 },
              pullRequests: { totalCount: 1 },
              pushedAt: "2026-06-13T12:00:00Z",
              updatedAt: "2026-06-13T12:00:00Z",
              defaultBranchRef: {
                name: "main",
                target: {
                  oid: "abcdef123456",
                  committedDate: "2026-06-13T12:00:00Z",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        statusContext,
                        {
                          __typename: "CheckRun",
                          name: "CI",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "https://github.com/acme/graphql/actions/runs/1",
                          completedAt: "2026-06-13T12:30:00Z",
                          startedAt: "2026-06-13T12:20:00Z",
                        },
                      ],
                    },
                  },
                },
              },
              releases: { nodes: [] },
            },
          },
        });
      }
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    if (url.pathname.endsWith("/contributors")) return Response.json([]);
    if (url.pathname.endsWith("/languages")) return Response.json({});
    if (url.pathname.endsWith("/stats/commit_activity")) return Response.json([]);
    if (url.pathname.endsWith("/stats/code_frequency")) return Response.json([]);
    throw new Error(`unexpected REST core fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/graphql"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(coreCalls, 1);
    assert.equal(body.project.openIssues, 2);
    assert.equal(body.project.openPullRequests, 1);
    assert.equal(body.project.latestCommitSha, "abcdef1");
    assert.equal(body.project.ciState, "failure");
    assert.equal(body.cache.quota?.source, "app");
    assert.equal(body.cache.quota?.account, account);

    const pendingResponse = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/pending"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(pendingResponse.status, 200);
    const pending = (await pendingResponse.json()) as RepoDetailPayload;
    assert.equal(coreCalls, 2);
    assert.equal(pending.project.ciState, "running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache private App-backed repository core data", async () => {
  const account = "acme";
  const cache = kvStore({
    [`auth:installation:v1:${account}`]: JSON.stringify({
      id: 1,
      accountLogin: account,
      accountType: "org",
      accountUrl: `https://github.com/${account}`,
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:1": "installation-token",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/graphql");
    return Response.json({
      data: {
        repository: {
          owner: { login: account },
          name: "private",
          nameWithOwner: `${account}/private`,
          url: `https://github.com/${account}/private`,
          description: null,
          isPrivate: true,
          isFork: false,
          isArchived: false,
          primaryLanguage: null,
          repositoryTopics: { nodes: [] },
          stargazerCount: 0,
          forkCount: 0,
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          pushedAt: "2026-06-13T12:00:00Z",
          updatedAt: "2026-06-13T12:00:00Z",
          defaultBranchRef: {
            name: "main",
            target: null,
          },
          releases: { nodes: [] },
        },
      },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/private"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 502);
    assert.equal(
      await cache.get(
        `repo-detail:aux:v2:${encodeURIComponent("acme/private")}:core-graphql:${encodeURIComponent("acme/private")}`,
      ),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker coalesces concurrent cold repository detail builds", async () => {
  const originalFetch = globalThis.fetch;
  let repositoryCalls = 0;
  let releaseRepository: (() => void) | undefined;
  const repositoryGate = new Promise<void>((resolve) => {
    releaseRepository = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/coalesced") {
      repositoryCalls += 1;
      await repositoryGate;
      return Response.json({
        owner: { login: "acme" },
        name: "coalesced",
        full_name: "acme/coalesced",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/coalesced",
        description: "Coalesced detail",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-06-13T12:00:00Z",
        updated_at: "2026-06-13T12:00:00Z",
      });
    }
    if (path === "/repos/acme/coalesced/releases") return Response.json([]);
    if (path === "/repos/acme/coalesced/commits/main") {
      return Response.json({ message: "Git Repository is empty." }, { status: 409 });
    }
    if (path === "/repos/acme/coalesced/pulls") return Response.json([]);
    if (path === "/repos/acme/coalesced/contributors") return Response.json([]);
    if (path === "/repos/acme/coalesced/languages") return Response.json({});
    if (path === "/repos/acme/coalesced/stats/commit_activity") return Response.json([]);
    if (path === "/repos/acme/coalesced/stats/code_frequency") return Response.json([]);
    if (path === "/graphql") {
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 0 },
          issuesClosed30d: { issueCount: 0 },
          pullRequestsOpened30d: { issueCount: 0 },
          pullRequestsClosed30d: { issueCount: 0 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const request = () =>
      worker.fetch(new Request("https://release.bar/api/repos/acme/coalesced"), env, {
        waitUntil: () => undefined,
      });
    const first = request();
    await Promise.resolve();
    const second = request();
    releaseRepository?.();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(repositoryCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds cached repository audience from public stargazers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { owner?: string; name?: string; first?: number };
      };
      assert.equal(body.variables?.owner, "acme");
      assert.equal(body.variables?.name, "releasebar");
      assert.equal(body.variables?.first, 30);
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "cabot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/13",
                    url: "https://github.com/cabot",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "quiet",
                    avatarUrl: "https://avatars.githubusercontent.com/u/11",
                    url: "https://github.com/quiet",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "Bot",
                    login: "renovate-bot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/12",
                    url: "https://github.com/renovate-bot",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/repos/acme/releasebar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers instanceof Headers, false);
      assert.match(String(headers?.accept), /star\+json/);
      if (url.searchParams.get("page") !== "3") {
        return Response.json(
          [
            {
              starred_at: "2020-01-01T00:00:00Z",
              user: {
                login: "old",
                avatar_url: "https://avatars.githubusercontent.com/u/9",
                html_url: "https://github.com/old",
              },
            },
          ],
          {
            headers: {
              link: '<https://api.github.com/repos/acme/releasebar/stargazers?per_page=30&page=3>; rel="last"',
            },
          },
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "principal",
            avatar_url: "https://avatars.githubusercontent.com/u/10",
            html_url: "https://github.com/principal",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "quiet",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/quiet",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "renovate-bot",
            avatar_url: "https://avatars.githubusercontent.com/u/12",
            html_url: "https://github.com/renovate-bot",
          },
        },
      ]);
    }
    if (path === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/cabot") {
      return Response.json({
        login: "cabot",
        avatar_url: "https://avatars.githubusercontent.com/u/13",
        html_url: "https://github.com/cabot",
        type: "User",
        name: "C. Abot",
        company: "GitHub",
        bio: "Principal engineer building developer tools",
        location: "San Francisco",
        blog: "https://cabot.dev",
        twitter_username: "cabot",
        followers: 5000,
        following: 50,
        public_repos: 80,
        public_gists: 2,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/cabot/orgs") {
      return Response.json([]);
    }
    if (path === "/users/cabot/repos") {
      return Response.json([]);
    }
    if (path === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
        {
          login: "acme",
          avatar_url: "https://avatars.githubusercontent.com/u/20",
          description: "Developer tools",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    if (path === "/users/quiet") {
      return Response.json({
        login: "quiet",
        avatar_url: "https://avatars.githubusercontent.com/u/11",
        html_url: "https://github.com/quiet",
        type: "User",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 2,
        following: 0,
        public_repos: 1,
        public_gists: 0,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/quiet/orgs") {
      return Response.json([]);
    }
    if (path === "/users/quiet/repos") {
      return Response.json([]);
    }
    if (path === "/users/renovate-bot") {
      return Response.json({
        login: "renovate-bot",
        avatar_url: "https://avatars.githubusercontent.com/u/12",
        html_url: "https://github.com/renovate-bot",
        type: "Bot",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 1000,
        following: 0,
        public_repos: 100,
        public_gists: 0,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:principal": JSON.stringify({
        login: "principal",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 88,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.equal(body.fullName, "acme/releasebar");
    assert.equal(body.range, "month");
    assert.equal(body.users[0]?.login, "principal");
    assert.equal(body.users[0]?.tier, "high");
    assert.equal(body.users[0]?.trustScore, 88);
    assert.equal(body.users[0]?.trustTier, "high");
    assert.ok((body.users[0]?.dimensions.trust ?? 0) >= 80);
    assert.equal(body.users[0]?.orgs[0]?.login, "github");
    assert.equal(body.users[0]?.topRepositories[0]?.fullName, "principal/release-tools");
    assert.match(body.users[0]?.reasons.join(" ") ?? "", /notable org: github/);
    const cabot = body.users.find((user) => user.login === "cabot");
    assert.notEqual(cabot?.tier, "bot");
    assert.ok((cabot?.score ?? 0) > 0);
    assert.equal(body.totals.stargazers, 1234);
    assert.equal(body.totals.highSignal, 1);
    assert.equal(body.totals.mediumSignal, 1);
    assert.equal(body.totals.bots, 1);
    assert.equal(body.totals.highSignalPercent, 25);
    assert.equal(body.totals.mediumSignalPercent, 25);
    assert.equal(body.totals.lowSignalPercent, 25);
    assert.equal(body.totals.botPercent, 25);
    assert.equal(body.cache.quota?.source, "shared");

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.equal(calls, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker REST stargazer fallback samples newest stargazers", async () => {
  const originalFetch = globalThis.fetch;
  const stargazerPages: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/restbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "restbar",
        full_name: "acme/restbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/restbar",
        description: "REST fallback",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 31,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/restbar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.match(String(headers?.accept), /star\+json/);
      stargazerPages.push(url.searchParams.get("page") ?? "first");
      if (url.searchParams.get("page") !== "2") {
        return Response.json(
          [
            {
              starred_at: new Date().toISOString(),
              user: {
                login: "previous",
                avatar_url: "https://avatars.githubusercontent.com/u/10",
                html_url: "https://github.com/previous",
              },
            },
          ],
          !url.searchParams.has("page")
            ? {
                headers: {
                  link: '<https://api.github.com/repos/acme/restbar/stargazers?per_page=30&page=2>; rel="last"',
                },
              }
            : undefined,
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "newest",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/newest",
          },
        },
      ]);
    }
    const user = path.match(/^\/users\/([^/]+)$/)?.[1];
    if (user === "previous" || user === "newest") {
      return Response.json({
        login: user,
        avatar_url: `https://avatars.githubusercontent.com/u/${user === "previous" ? "10" : "11"}`,
        html_url: `https://github.com/${user}`,
        type: "User",
        name: user,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: user === "newest" ? 20 : 10,
        following: 1,
        public_repos: 2,
        public_gists: 0,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/previous/orgs" || path === "/users/newest/orgs") {
      return Response.json([]);
    }
    if (path === "/users/previous/repos" || path === "/users/newest/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/restbar/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.deepEqual(stargazerPages, ["first", "2", "1"]);
    assert.deepEqual(body.users.map((user) => user.login).sort(), ["newest", "previous"]);
    assert.equal(body.totals.stargazers, 31);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository audience caches to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const cache = kvStore({
    "repo-audience:v5:acme/releasebar:month": JSON.stringify({
      fullName: "acme/releasebar",
      range: "month",
      generatedAt,
      cache: {
        state: "fresh",
        stale: false,
        generatedAt,
      },
      totals: {
        stargazers: 10,
        stargazersSampled: 1,
        highSignal: 1,
        mediumSignal: 0,
        lowSignal: 0,
        bots: 0,
        highSignalPercent: 100,
        mediumSignalPercent: 0,
        lowSignalPercent: 0,
        botPercent: 0,
      },
      users: [],
    } satisfies RepoAudiencePayload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler stale audience cache should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/releasebar/audience"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "showing cached repository audience signals");
    assert.equal(body.totals.stargazers, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves OpenAPI spec aliases for Swagger tooling", async () => {
  const env = { DASHBOARD_CACHE: kvStore() };
  for (const path of ["/openapi.json", "/api/openapi.json", "/api/swagger.json"]) {
    const response = await worker.fetch(new Request(`https://release.bar${path}`), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      openapi?: string;
      info?: { version?: string };
      paths?: Record<string, unknown>;
      components?: {
        schemas?: {
          CacheState?: {
            properties?: Record<string, unknown>;
          };
          OwnerActivity?: unknown;
        };
      };
    };
    assert.equal(body.openapi, "3.1.0");
    assert.equal(body.info?.version, "0.2.0");
    assert.ok(body.paths?.["/api/{owner}/activity"]);
    assert.ok(body.paths?.["/api/users/{login}/trust"]);
    assert.ok(body.paths?.["/api/repos/{owner}/{repo}/audience"]);
    assert.ok(body.components?.schemas?.OwnerActivity);
    assert.ok(body.components?.schemas?.CacheState?.properties?.countsUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.releasesUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.ciUpdatedAt);
  }
});

test("worker rejects malformed nested owner API paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw/openclaw/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "not found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured audience GETs off shared quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "private-key",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /GitHub App/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only backfills repository audience caches with GitHub App quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const denied = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
      }),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(denied.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "audience-backfill";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  let appCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const authorization = new Headers(init?.headers).get("authorization");
    if (path === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "acme",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/acme",
            },
            html_url: "https://github.com/organizations/acme/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (path === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (path === "/repos/acme/releasebar") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: ["developer-tools"],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/users/principal") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/principal/orgs") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      fullName: string;
      ranges: Array<{ range: AudienceRange; state: string; users: number }>;
      quota: { source: string; account: string | null };
    };
    assert.equal(body.fullName, "acme/releasebar");
    assert.deepEqual(
      body.ranges.map((range) => `${range.range}:${range.state}:${range.users}`),
      ["week:rebuilt:1", "month:rebuilt:1"],
    );
    assert.deepEqual(body.quota, { source: "app", account: "acme" });
    assert.ok(appCalls > 0);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience?range=week"),
      env,
      { waitUntil: () => undefined },
    );
    const audience = (await cached.json()) as RepoAudiencePayload;
    assert.equal(audience.cache.quota?.source, "app");
    assert.equal(audience.users[0]?.factors.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds bounded trust profiles for people pages", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "principal/trust-map",
          html_url: "https://github.com/principal/trust-map",
          description: "Trust signals",
          language: "TypeScript",
          stargazers_count: 10,
          forks_count: 2,
          fork: false,
          archived: false,
          topics: ["trust", "developer-tools"],
          pushed_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
    assert.equal(body.login, "principal");
    assert.equal(body.type, "user");
    assert.equal(body.profileKind, "user_trust");
    assert.equal(body.scoreLabel, "trust score");
    assert.equal(body.tier, "high");
    assert.ok((body.accountAgeDays ?? 0) > 3650);
    assert.ok(body.dimensions.trust >= 80);
    assert.equal(body.stats.totalStars, 130);
    assert.equal(body.stats.activeRepositories, 2);
    assert.equal(body.stats.languages[0]?.name, "typescript");
    assert.equal(body.stats.topics[0]?.name, "developer-tools");
    assert.equal(body.orgs[0]?.login, "github");
    assert.equal(body.topRepositories[0]?.fullName, "principal/release-tools");
    assert.equal(body.factors.find((factor) => factor.key === "age")?.label, "account age");
    assert.match(
      body.factors.find((factor) => factor.key === "builder")?.detail ?? "",
      /recent repos scanned/,
    );
    assert.match(body.reasons.join(" "), /notable org: github/);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker preserves bot tier for typed trust profiles", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/crawlerbot") {
      return Response.json({
        login: "crawlerbot",
        avatar_url: "https://avatars.githubusercontent.com/u/99",
        html_url: "https://github.com/crawlerbot",
        type: "Bot",
        name: null,
        company: "GitHub",
        bio: "Automation",
        location: "CI",
        blog: null,
        twitter_username: null,
        followers: 5000,
        following: 0,
        public_repos: 80,
        public_gists: 0,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/crawlerbot/orgs") {
      return Response.json([]);
    }
    if (url.pathname === "/users/crawlerbot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/crawlerbot/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.login, "crawlerbot");
    assert.equal(body.tier, "bot");
    assert.equal(body.score, 0);
    assert.deepEqual(body.reasons, ["automation account"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered app quota for anonymous trust profiles", async () => {
  const cache = kvStore({
    "auth:installation:v1:principal": JSON.stringify({
      id: 42,
      accountLogin: "principal",
      accountType: "user",
      accountUrl: "https://github.com/principal",
      avatarUrl: "https://avatars.githubusercontent.com/u/10",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer installation-token");
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.quota?.source, "app");
    assert.equal(body.cache.quota?.account, "principal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns org signal profiles for organization accounts", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/openclaw") {
      return Response.json({
        login: "openclaw",
        avatar_url: "https://avatars.githubusercontent.com/u/20",
        html_url: "https://github.com/openclaw",
        type: "Organization",
        name: "OpenClaw",
        company: null,
        bio: "Open source agent tooling",
        location: "Internet",
        blog: "https://openclaw.dev",
        twitter_username: null,
        followers: 1200,
        following: 0,
        public_repos: 42,
        public_gists: 0,
        created_at: "2018-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      assert.equal(url.searchParams.get("type"), "public");
      return Response.json([
        {
          full_name: "openclaw/openclaw",
          html_url: "https://github.com/openclaw/openclaw",
          description: "Agent runtime",
          language: "TypeScript",
          stargazers_count: 900,
          forks_count: 80,
          private: false,
          visibility: "public",
          fork: false,
          archived: false,
          topics: ["agents", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "openclaw/private-signals",
          html_url: "https://github.com/openclaw/private-signals",
          description: "Should never leak",
          language: "TypeScript",
          stargazers_count: 9999,
          forks_count: 0,
          private: true,
          visibility: "private",
          fork: false,
          archived: false,
          topics: ["private"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/openclaw/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, ["/users/openclaw", "/orgs/openclaw/repos"]);
    assert.equal(body.type, "org");
    assert.equal(body.profileKind, "org_signal");
    assert.equal(body.scoreLabel, "org signal");
    assert.equal(body.stats.totalStars, 900);
    assert.deepEqual(
      body.topRepositories.map((repo) => repo.fullName),
      ["openclaw/openclaw"],
    );
    assert.equal(body.orgs.length, 0);
    assert.ok(body.reasons.includes("organization account"));
    assert.equal(
      body.factors.find((factor) => factor.key === "orgs"),
      undefined,
    );
    assert.equal(
      body.factors.find((factor) => factor.key === "builder")?.label,
      "repository footprint",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes stale trust profiles in the background", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const staleProfile: TrustProfilePayload = {
    login: "principal",
    type: "user",
    profileKind: "user_trust",
    scoreLabel: "trust score",
    avatarUrl: "https://avatars.githubusercontent.com/u/10",
    url: "https://github.com/principal",
    name: "Old Principal",
    company: null,
    bio: null,
    location: null,
    blog: null,
    twitterUsername: null,
    followers: 1,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    accountCreatedAt: "2020-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-16T12:00:00Z",
    accountAgeDays: 1000,
    score: 10,
    tier: "low",
    reasons: [],
    dimensions: { trust: 0, influence: 0, builder: 0, recency: 0, risk: 100 },
    factors: [],
    orgs: [],
    topRepositories: [],
    stats: {
      totalStars: 0,
      totalForks: 0,
      recentRepositories: 0,
      activeRepositories: 0,
      publicOrganizations: 0,
      languages: [],
      topics: [],
    },
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "bounded public GitHub profile signals",
    },
  };
  const cache = kvStore({
    "trust-profile:v4:principal": JSON.stringify(staleProfile),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "New Principal",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "refreshing trust profile");
    assert.equal(body.name, "Old Principal");
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    const refreshed = JSON.parse(
      (await cache.get("trust-profile:v4:principal")) ?? "{}",
    ) as TrustProfilePayload;
    assert.equal(refreshed.name, "New Principal");
    assert.equal(refreshed.cache.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker throttles cached warming repository detail refreshes", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "warming");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached warming repository detail after short grace window", async () => {
  const generatedAt = new Date(Date.now() - 31_000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("queued refresh");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "refreshing repository statistics");
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository detail to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "showing cached repository statistics");
    assert.equal(waitUntilPromises.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps crawler-only auxiliary API misses off GitHub", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler auxiliary cache miss should not call GitHub ${String(input)}`);
  };
  try {
    for (const url of [
      "https://release.bar/api/kvark/activity?range=week",
      "https://release.bar/api/users/kvark/trust",
      "https://release.bar/api/repos/acme/coldbar/activity?range=week",
      "https://release.bar/api/repos/acme/coldbar",
    ]) {
      const response = await worker.fetch(
        crawlerRequest(url),
        { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
        { waitUntil: () => undefined },
      );
      assert.equal(response.status, 202, url);
      const body = (await response.json()) as { cache?: { state?: string; message?: string } };
      assert.equal(body.cache?.state, "warming");
      assert.match(body.cache?.message ?? "", /crawler/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes commits since release in the background", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "refreshing repository statistics",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 2,
      commitsUsed: 0,
      message: "Summarizing commits since the latest release.",
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 2,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = kvStore({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("page"), "1");
      return Response.json({
        total_commits: 2,
        commits: [
          { commit: { message: "Add release summary panel\n\nLong body" } },
          { commit: { message: "Fix summary cache key" } },
        ],
      });
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.match(JSON.stringify(body.input), /Add release summary panel/);
      return Response.json({
        output_text: "",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "ReleaseBar added an AI summary panel and tightened the cache key for generated summaries.",
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.releaseSummary?.state, "warming");
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    assert.equal(cached.releaseSummary?.state, "ready");
    assert.equal(cached.releaseSummary?.model, "chat-latest");
    assert.match(cached.releaseSummary?.text ?? "", /AI summary panel/);
    assert.equal(cached.releaseSummary?.commitsUsed, 2);
    assert.equal(cached.generatedAt, generatedAt);
    assert.equal(cached.cache.state, "warming");
    assert.equal(cached.cache.generatedAt, generatedAt);
    assert.notEqual(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:chat-latest"),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes recent repository activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased") {
      return Response.json({
        owner: { login: "acme" },
        name: "unreleased",
        full_name: "acme/unreleased",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/unreleased",
        description: "Unreleased repo",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 12,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: now,
        updated_at: now,
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased/events") {
      if (url.searchParams.get("page") !== "1") return Response.json([]);
      return Response.json([
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            size: 2,
            commits: [
              { message: "Add repository activity summary" },
              { message: "Polish unreleased project copy" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            action: "merged",
            pull_request: {
              title: "Wire recent work panel",
              html_url: "https://github.com/acme/unreleased/pull/1",
            },
          },
        },
      ]);
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.match(JSON.stringify(body.input), /Repository: acme\/unreleased/);
      assert.match(JSON.stringify(body.input), /Add repository activity summary/);
      return Response.json({
        output_text:
          "acme/unreleased added a recent-work panel for unreleased projects and polished the copy around that flow.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/unreleased/activity?range=month"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailActivityPayload;
    assert.equal(body.fullName, "acme/unreleased");
    assert.equal(body.range, "month");
    assert.equal(body.summary?.state, "warming");
    assert.equal(body.totals.commits, 2);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-activity:v1:acme/unreleased:month")) ?? "{}",
    ) as RepoDetailActivityPayload;
    assert.equal(cached.summary?.state, "ready", cached.summary?.message ?? "");
    assert.equal(cached.summary?.model, "chat-latest");
    assert.match(cached.summary?.text ?? "", /recent-work panel/);
    assert.equal(cached.summary?.promptVersion, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker hides activity from forks of repositories owned by the profile", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  const generatedAt = new Date().toISOString();
  let graphqlCalls = 0;
  const externalRepoCount = 101;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme") {
      return Response.json({
        login: "acme",
        type: "User",
        avatar_url: "https://github.com/acme.png",
        html_url: "https://github.com/acme",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme/events/public") {
      const externalEvents = Array.from({ length: externalRepoCount }, (_, index) => ({
        id: `external-${index}`,
        type: "PushEvent",
        public: true,
        created_at: generatedAt,
        repo: { name: `upstream/other-${index}` },
        payload: { size: 1, commits: [{ message: `Update unrelated project ${index}` }] },
      }));
      if (url.searchParams.get("page") === "1") {
        return Response.json([
          {
            id: "own",
            type: "PushEvent",
            public: true,
            created_at: generatedAt,
            repo: { name: "acme/tool" },
            payload: { size: 1, commits: [{ message: "Update owned project" }] },
          },
          ...externalEvents.slice(0, 99),
        ]);
      }
      if (url.searchParams.get("page") === "2") {
        return Response.json([
          ...externalEvents.slice(99),
          {
            id: "fork",
            type: "PushEvent",
            public: true,
            created_at: generatedAt,
            repo: { name: "contributor/tool" },
            payload: { size: 1, commits: [{ message: "Update contributor fork" }] },
          },
        ]);
      }
      return Response.json([]);
    }
    if (url.hostname === "api.github.com" && url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, string>;
      };
      assert.match(body.query ?? "", /query ReleaseBarActivityForkOrigins/);
      const data: Record<string, unknown> = {};
      for (let index = 0; body.variables?.[`owner${index}`]; index += 1) {
        data[`repo${index}`] =
          body.variables[`owner${index}`] === "contributor"
            ? {
                isFork: true,
                parent: { owner: { login: "acme" } },
              }
            : index === 0 && graphqlCalls === 1
              ? null
              : {
                  isFork: false,
                  parent: null,
                };
      }
      return Response.json({
        data,
        ...(graphqlCalls === 1
          ? { errors: [{ message: "Could not resolve repository upstream/other-0" }] }
          : {}),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as OwnerActivityPayload;
    assert.equal(graphqlCalls, 3);
    assert.equal(
      body.events.some((event) => event.repo === "contributor/tool"),
      false,
    );
    assert.equal(
      body.events.some((event) => event.repo === "upstream/other-100"),
      true,
    );
    assert.equal(body.totals.events, externalRepoCount + 1);
    assert.equal(body.totals.commits, externalRepoCount + 1);
    assert.equal(body.totals.repositories, externalRepoCount + 1);
    assert.equal(await cache.get("owner-activity:v1:acme:week"), null);
    assert.notEqual(await cache.get("owner-activity:v2:acme:week"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes public owner activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const generatedAt = new Date().toISOString();
  let openAICalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme") {
      return Response.json({
        login: "acme",
        type: "User",
        avatar_url: "https://github.com/acme.png",
        html_url: "https://github.com/acme",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme/events/public") {
      assert.equal(url.searchParams.get("per_page"), "100");
      if (url.searchParams.get("page") !== "1") {
        return Response.json([]);
      }
      const events: unknown[] = [
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            size: 4,
            commits: [
              { message: "Add owner activity panel\n\nLong body" },
              { message: "Cache activity summaries" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            action: "opened",
            pull_request: {
              title: "Polish working-on copy",
              html_url: "https://github.com/acme/releasebar/pull/1",
            },
          },
        },
        {
          id: "other-repo",
          type: "IssuesEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/other" },
          payload: {
            action: "closed",
            issue: {
              title: "Remove a redundant refresh path",
              html_url: "https://github.com/acme/other/issues/1",
            },
          },
        },
        {
          id: "repo-missing",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: {},
          payload: {
            size: 1,
            commits: [{ message: "This malformed event should be ignored" }],
          },
        },
        {
          id: "3",
          type: "PushEvent",
          public: false,
          created_at: generatedAt,
          repo: { name: "acme/private" },
          payload: { commits: [{ message: "private work" }] },
        },
      ];
      for (let index = 4; index <= 125; index += 1) {
        events.push({
          id: String(index),
          type: "IssueCommentEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            issue: {
              title: `Activity thread ${index}`,
              html_url: `https://github.com/acme/releasebar/issues/${index}`,
            },
          },
        });
      }
      return Response.json(events);
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      openAICalls += 1;
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.equal(body.max_output_tokens, 2200);
      assert.equal(body.text?.format?.type, "json_schema");
      assert.equal(body.text?.format?.schema?.properties?.repositories?.minItems, 2);
      assert.match(body.instructions, /do not restate those facts/i);
      assert.match(body.instructions, /one or two short sentences/i);
      assert.doesNotMatch(body.instructions, /Say this is public activity/i);
      const inputText = JSON.stringify(body.input);
      assert.match(inputText, /Repository: acme\/releasebar/);
      assert.match(inputText, /Summary target: yes/);
      assert.match(inputText, /Totals: 127 items; 4 commits; 1 PR; 122 comments/);
      assert.match(inputText, /Repository: acme\/other/);
      assert.match(inputText, /Remove a redundant refresh path/);
      assert.match(inputText, /Add owner activity panel/);
      assert.match(inputText, /Events included: 125/);
      assert.equal(inputText.match(/Repository: acme\/releasebar/g)?.length, 1);
      return Response.json({
        output_text: JSON.stringify({
          summary:
            "ReleaseBar activity summaries, cache behavior, and dashboard copy moved forward together. A second repository removed a redundant refresh path.",
          repositories: [
            {
              fullName: "acme/releasebar",
              summary:
                "ReleaseBar gained grouped activity summaries and refined dashboard copy. The cache path now keeps that generated work reusable.",
            },
            {
              fullName: "acme/other",
              summary: "Closed an issue after removing a redundant refresh path.",
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as OwnerActivityPayload;
    assert.equal(body.owner.login, "acme");
    assert.equal(body.range, "week");
    assert.equal(body.totals.commits, 4);
    assert.equal(body.totals.pullRequests, 1);
    assert.equal(body.totals.issues, 1);
    assert.equal(body.totals.repositories, 2);
    assert.equal(body.repositories[0]?.events, 127);
    assert.equal(body.repositories[0]?.commits, 4);
    assert.equal(body.repositories[0]?.pullRequests, 1);
    assert.equal(body.repositories[0]?.comments, 122);
    const commitEvent = body.events.find((event) => event.kind === "commit");
    assert.match(commitEvent?.title ?? "", /\+3 commits/);
    assert.equal(
      body.events.some((event) => event.repo === "acme/private"),
      false,
    );
    assert.equal(body.summary?.state, "warming");
    await Promise.all(queued);
    assert.equal(openAICalls, 1);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "ready", cached.summary?.message ?? "");
    assert.match(cached.summary?.text ?? "", /activity summaries/);
    assert.match(cached.summary?.repositories?.[0]?.text ?? "", /grouped activity summaries/);
    assert.match(cached.summary?.repositories?.[0]?.text ?? "", /cache path/);
    assert.match(cached.summary?.repositories?.[1]?.text ?? "", /redundant refresh path/);
    assert.doesNotMatch(cached.summary?.text ?? "", /GitHub activity|public activity/i);
    assert.notEqual(cached.summary?.inputHash, null);
    assert.equal(cached.summary?.eventsUsed, 125);
    assert.equal(cached.summary?.promptVersion, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker includes lower-ranked repositories in the overall activity summary batch", async () => {
  const generatedAt = new Date().toISOString();
  const repositories = Array.from({ length: 31 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      fullName: `acme/repo-${suffix}`,
      url: `https://github.com/acme/repo-${suffix}`,
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      lastActiveAt: generatedAt,
    };
  });
  const events = repositories.map((repository, index) => ({
    id: `event-${index + 1}`,
    kind: "commit" as const,
    title: `Improve repository ${index + 1}`,
    repo: repository.fullName,
    url: repository.url,
    createdAt: generatedAt,
    count: 1,
  }));
  const payload = {
    owner: {
      type: "user" as const,
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week" as const,
    generatedAt,
    cache: {
      state: "fresh" as const,
      stale: false,
      generatedAt,
    },
    totals: {
      events: 31,
      commits: 31,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 31,
    },
    repositories,
    events,
    summary: {
      state: "ready" as const,
      text: "Old summary.",
      generatedAt,
      model: "chat-latest",
      inputHash: "old-hash",
      eventsUsed: 31,
      promptVersion: 3,
    },
  } satisfies OwnerActivityPayload;
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  let openAICalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      openAICalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const inputText = JSON.stringify(body.input);
      assert.equal(body.max_output_tokens, 3050);
      assert.match(inputText, /Repository: acme\/repo-31\\nSummary target: no \(overall only\)/);
      assert.equal(inputText.match(/Summary target: yes/g)?.length, 30);
      assert.equal(inputText.match(/Summary target: no \(overall only\)/g)?.length, 1);
      const targetNames = body.text.format.schema.properties.repositories.items.properties.fullName
        .enum as string[];
      assert.equal(targetNames.length, 30);
      assert.equal(targetNames.includes("acme/repo-31"), false);
      return Response.json({
        output_text: JSON.stringify({
          summary:
            "Work spanned all 31 repositories, including the lower-ranked improvements in acme/repo-31.",
          repositories: targetNames.map((fullName) => ({
            fullName,
            summary: `Improved ${fullName}.`,
          })),
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    assert.equal(openAICalls, 1);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "ready", cached.summary?.message ?? "");
    assert.equal(cached.summary?.eventsUsed, 31);
    assert.equal(cached.summary?.repositories?.length, 30);
    assert.match(cached.summary?.text ?? "", /repo-31/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker trims expired events from cached owner activity", async () => {
  const generatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "expired",
        kind: "commit",
        title: "Old cached work",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "Acme worked on an old cached change.",
      generatedAt,
      model: "chat-latest",
      inputHash: "expired-hash",
      eventsUsed: 1,
      promptVersion: 4,
    },
  };
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/acme/activity?range=week", {
      headers: { "user-agent": "Googlebot" },
    }),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as OwnerActivityPayload;
  assert.equal(body.cache.state, "stale");
  assert.equal(body.totals.events, 0);
  assert.equal(body.totals.repositories, 0);
  assert.deepEqual(body.repositories, []);
  assert.deepEqual(body.events, []);
  assert.equal(body.summary?.state, "unavailable");
  assert.equal(body.summary?.text, null);
});

test("worker trims expired events from cached repository activity", async () => {
  const generatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const payload: RepoDetailActivityPayload = {
    fullName: "acme/releasebar",
    range: "day",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "expired",
        kind: "commit",
        title: "Old cached work",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "ReleaseBar had an old cached change.",
      generatedAt,
      model: "chat-latest",
      inputHash: "expired-hash",
      eventsUsed: 1,
      promptVersion: 4,
    },
  };
  const cache = kvStore({
    "repo-activity:v1:acme/releasebar:day": JSON.stringify(payload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/acme/releasebar/activity?range=day", {
      headers: { "user-agent": "Googlebot" },
    }),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as RepoDetailActivityPayload;
  assert.equal(body.cache.state, "stale");
  assert.equal(body.totals.events, 0);
  assert.equal(body.totals.repositories, 0);
  assert.deepEqual(body.repositories, []);
  assert.deepEqual(body.events, []);
  assert.equal(body.summary?.state, "unavailable");
  assert.equal(body.summary?.text, null);
});

test("worker skips stale public owner activity summaries when events changed", async () => {
  const generatedAt = new Date().toISOString();
  const oldPayload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "old",
        kind: "commit",
        title: "Add old activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "old-hash",
      eventsUsed: 1,
    },
  };
  const newPayload: OwnerActivityPayload = {
    ...oldPayload,
    events: [
      {
        id: "new",
        kind: "commit",
        title: "Add new activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "new-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(oldPayload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      await cache.put("owner-activity:v2:acme:week", JSON.stringify(newPayload));
      return Response.json({
        output_text: "Acme worked on old activity.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.events[0]?.id, "new");
    assert.equal(cached.summary?.state, "warming");
    assert.equal(cached.summary?.inputHash, "new-hash");
    assert.equal(cached.summary?.text, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached owner activity summaries from older prompt versions", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "event",
        kind: "commit",
        title: "Improve working-on summaries",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "@acme's public GitHub activity has centered on ReleaseBar.",
      generatedAt,
      model: "gpt-5.5",
      inputHash: "old-prompt-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      return Response.json({
        output_text: JSON.stringify({
          summary: "@acme's public GitHub activity refined working-on summaries.",
          repositories: [
            {
              fullName: "acme/releasebar",
              summary: "ReleaseBar refined its working-on summaries.",
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as OwnerActivityPayload;
    assert.equal(responseBody.summary?.state, "warming");
    assert.equal(responseBody.summary?.text, null);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "ready");
    assert.equal(cached.summary?.promptVersion, 4);
    assert.equal(cached.summary?.model, "chat-latest");
    assert.notEqual(cached.summary?.inputHash, "old-prompt-hash");
    assert.equal(cached.summary?.text, "@acme's work refined working-on summaries.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not summarize empty owner activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 0,
      commits: 0,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 0,
    },
    repositories: [],
    events: [],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "empty-hash",
      eventsUsed: 0,
    },
  };
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "unavailable");
    assert.equal(cached.summary?.message, "Not enough recent work to summarize.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects incomplete structured owner activity summaries", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "event",
        kind: "commit",
        title: "Add activity summary",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "activity-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      return Response.json({
        output_text: JSON.stringify({
          summary: "ReleaseBar added activity summaries.",
          repositories: [],
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "unavailable");
    assert.equal(cached.summary?.model, "chat-latest");
    assert.match(cached.summary?.message ?? "", /complete structured activity summaries/);
    assert.notEqual(cached.summary?.inputHash, "activity-hash");
    assert.equal(cached.summary?.promptVersion, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail routes for repositories named activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/activity",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "activity",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = kvStore({
    "repo-detail:v4:acme/activity": JSON.stringify(payload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/activity"),
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.fullName, "acme/activity");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker skips stale release summaries when repository detail changed", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 1,
      commitsUsed: 0,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const latestPayload: RepoDetailPayload = {
    ...payload,
    project: {
      ...payload.project,
      version: "v1.0.1",
      latestCommitSha: "fedcba9",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.1",
      headSha: "fedcba9",
      commitCount: 1,
      commitsUsed: 0,
    },
  };
  const cache = kvStore({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      return Response.json({
        total_commits: 1,
        commits: [{ commit: { message: "Add stale summary guard" } }],
      });
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      await cache.put("repo-detail:v4:acme/releasebar", JSON.stringify(latestPayload));
      return Response.json({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "ReleaseBar added a stale summary guard.",
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    assert.equal(cached.project.version, "v1.0.1");
    assert.equal(cached.project.latestCommitSha, "fedcba9");
    assert.equal(cached.releaseSummary?.releaseTag, "v1.0.1");
    assert.equal(cached.releaseSummary?.text, null);
    assert.notEqual(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:chat-latest"),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects private repository detail payloads", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/private") {
      return Response.json({
        owner: { login: "acme" },
        name: "private",
        full_name: "acme/private",
        private: true,
        html_url: "https://github.com/acme/private",
        description: null,
        default_branch: "main",
        language: null,
        topics: [],
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/private"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const body = (await response.json()) as { error?: string };
    assert.equal(response.status, 502);
    assert.match(body.error ?? "", /private repositories are not visible/);
    assert.equal(
      await cache.get(
        `repo-detail:aux:v2:${encodeURIComponent("acme/private")}:repository:${encodeURIComponent("/repos/acme/private")}`,
      ),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when pull request count fails", async () => {
  const originalFetch = globalThis.fetch;
  let failPulls = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/retrybar") {
      return Response.json({
        owner: { login: "acme" },
        name: "retrybar",
        full_name: "acme/retrybar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/retrybar",
        description: "Retry dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/retrybar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/retrybar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/retrybar/pulls") {
      if (failPulls) {
        return Response.json(
          { message: "rate limit exceeded", documentation_url: "https://docs.github.com/rest" },
          { status: 403, headers: { "retry-after": "60" } },
        );
      }
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/2/pulls?state=open&per_page=1&page=3>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/retrybar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/retrybar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/stats/code_frequency") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const failed = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(failed.status, 429);

    failPulls = false;
    await Promise.all([
      env.DASHBOARD_CACHE.delete("github:budget:v1:shared:_"),
      env.DASHBOARD_CACHE.delete("github:budget:v1:shared:core"),
    ]);
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.openPullRequests, 3);
    assert.equal(body.project.openIssues, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns 404 for missing repository detail pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/missing") {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/missing"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 404);
    assert.match(await response.text(), /GitHub API 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores optional repository detail permission gaps", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/limitedbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "limitedbar",
        full_name: "acme/limitedbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/limitedbar",
        description: "Limited dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/limitedbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/limitedbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/limitedbar/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/commits/1234567890/check-runs") {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (path === "/repos/acme/limitedbar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/stats/code_frequency") {
      return Response.json(
        { message: "repository must have fewer than 10000 commits" },
        { status: 422 },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/limitedbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.ciState, "unknown");
    assert.equal(body.cache.state, "fresh");
    assert.equal(body.stats?.codeFrequency.state, "unavailable");
    assert.match(body.stats?.codeFrequency.message ?? "", /fewer than 10000 commits/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker backs off repository stats per repo after one warming response", async () => {
  const originalFetch = globalThis.fetch;
  let codeFrequencyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/warmstats") {
      return Response.json({
        owner: { login: "acme" },
        name: "warmstats",
        full_name: "acme/warmstats",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/warmstats",
        description: "Stats warming",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/warmstats/releases") return Response.json([]);
    if (path === "/repos/acme/warmstats/contributors") return Response.json([]);
    if (path === "/repos/acme/warmstats/languages") return Response.json({});
    if (path === "/repos/acme/warmstats/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/warmstats/pulls") return Response.json([]);
    if (path === "/repos/acme/warmstats/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/warmstats/stats/commit_activity") {
      return new Response(null, { status: 202 });
    }
    if (path === "/repos/acme/warmstats/stats/code_frequency") {
      codeFrequencyCalls += 1;
      return Response.json([]);
    }
    if (path === "/search/issues") {
      return Response.json({ total_count: 0 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmstats"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "warming");
    assert.equal(body.stats?.commitActivity.state, "warming");
    assert.equal(body.stats?.codeFrequency.state, "warming");
    assert.equal(codeFrequencyCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when optional calls are rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/slowbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "slowbar",
        full_name: "acme/slowbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/slowbar",
        description: "Slow dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/slowbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/slowbar/contributors") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "retry-after": "60" } },
      );
    }
    if (path === "/repos/acme/slowbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/slowbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/slowbar/pulls") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/slowbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail when work trend GraphQL is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/trendbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "trendbar",
        full_name: "acme/trendbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/trendbar",
        description: "Trend dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/trendbar/releases") return Response.json([]);
    if (path === "/repos/acme/trendbar/contributors") return Response.json([]);
    if (path === "/repos/acme/trendbar/languages") return Response.json({});
    if (path === "/repos/acme/trendbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/trendbar/pulls") return Response.json([]);
    if (path === "/repos/acme/trendbar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/trendbar/stats/commit_activity") return Response.json([]);
    if (path === "/repos/acme/trendbar/stats/code_frequency") return Response.json([]);
    if (path === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/trendbar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.workTrend, null);
    assert.notEqual(await cache.get("repo-detail:v4:acme/trendbar"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reuses repository detail auxiliary caches across rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/cachebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "cachebar",
        full_name: "acme/cachebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/cachebar",
        description: "Cached detail dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/cachebar/releases") {
      count("releases");
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: "v1.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T12:00:00Z",
          html_url: "https://github.com/acme/cachebar/releases/tag/v1.0.0",
        },
      ]);
    }
    if (path === "/repos/acme/cachebar/commits/main") {
      count("latest_commit");
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/cachebar/pulls") {
      count("open_pulls");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/compare/v1.0.0...main") {
      count("compare");
      return Response.json({
        html_url: "https://github.com/acme/cachebar/compare/v1.0.0...main",
        ahead_by: 0,
        total_commits: 0,
        commits: [],
      });
    }
    if (path === "/repos/acme/cachebar/commits/1234567890/check-runs") {
      count("check_runs");
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/cachebar/contributors") {
      count("contributors");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/languages") {
      count("languages");
      return Response.json({ TypeScript: 100 });
    }
    if (path === "/repos/acme/cachebar/stats/commit_activity") {
      count("commit_activity");
      return new Response("", { status: 202 });
    }
    if (path === "/repos/acme/cachebar/stats/code_frequency") {
      count("code_frequency");
      return new Response("", { status: 202 });
    }
    if (path === "/graphql") {
      const payload = JSON.parse(String(init?.body)) as { query?: string };
      assert.match(payload.query ?? "", /ReleaseBarRepoWorkTrend/);
      count("work_trend");
      return Response.json({
        data: {
          issuesOpened30d: { issueCount: 1 },
          issuesClosed30d: { issueCount: 1 },
          pullRequestsOpened30d: { issueCount: 1 },
          pullRequestsClosed30d: { issueCount: 1 },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const request = new Request("https://release.bar/api/repos/acme/cachebar");
    const first = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(first.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal(calls.get("work_trend"), 1);

    await cache.delete("repo-detail:v4:acme/cachebar");

    const second = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(second.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal(calls.get("work_trend"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns metadata before release hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const repoNode = (issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: "Manual refresh repo",
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [] },
    stargazerCount: 42,
    forkCount: 2,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    releases: {
      nodes: [
        {
          tagName: "v1.0.0",
          name: null,
          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          isDraft: false,
          publishedAt: "2026-05-01T00:00:00Z",
        },
      ],
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      assert.equal(body.variables?.first, 100);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode(9, 4)],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.match(body.cache?.message ?? "", /repository metadata refreshed/);
    assert.equal(body.projects[0]?.openIssues, 9);
    assert.equal(body.projects[0]?.openPullRequests, 4);
    assert.equal(body.projects[0]?.version, "repo search");

    const repeated = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(repeated.status, 202);
    const repeatedBody = (await repeated.json()) as DashboardPayload;
    assert.match(repeatedBody.cache?.message ?? "", /manual refresh recently started/);
    assert.equal(repeatedBody.projects[0]?.openIssues, 9);

    await Promise.all(waits);
    const cached = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.projects[0]?.version, "v1.0.0");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual refreshes merge owner removals observed during the build before caching", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] & {
    GITHUB_TOKEN: string;
    REFRESH_QUEUE: { send(): Promise<void> };
  } = {
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: { send: async () => undefined },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  let removalRecorded = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
    }
    if (url.pathname === "/graphql") {
      if (!removalRecorded) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const stub = env.DASHBOARD_LOCKS!.get(
          env.DASHBOARD_LOCKS!.idFromName("owner-metadata:owner"),
        );
        const removed = await stub.fetch(
          new Request("https://releasebar.internal/owner-metadata/mutate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: "owner",
              mutation: {
                kind: "remove",
                fullName: "owner/repo",
                observedAt: new Date().toISOString(),
              },
            }),
          }),
        );
        assert.equal(removed.ok, true);
        removalRecorded = true;
      }
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "removed during build",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 1,
                  forkCount: 0,
                  issues: { totalCount: 1 },
                  pullRequests: { totalCount: 0 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T00:00:00Z",
                  releases: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 0);
    const cached = JSON.parse(
      (await cache.get(
        dashboardCacheKey({
          owner: "owner",
          includeUnreleased: true,
          includeReleaseData: true,
          schemaVersion: 6,
        }),
      )) ?? "{}",
    ) as DashboardPayload;
    assert.equal(cached.projects.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves repository cap metadata", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const offset = body.variables?.after ? 100 : 0;
      const nodes = Array.from({ length: 100 }, (_, index) => {
        const number = offset + index + 1;
        const name = `repo-${number}`;
        return {
          owner: { login: "wide", __typename: "User" },
          name,
          nameWithOwner: `wide/${name}`,
          description: null,
          url: `https://github.com/wide/${name}`,
          defaultBranchRef: { name: "main" },
          primaryLanguage: null,
          repositoryTopics: { nodes: [] },
          stargazerCount: 0,
          forkCount: 0,
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          isArchived: false,
          isFork: false,
          isPrivate: false,
          pushedAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:00Z",
        };
      });
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: {
                hasNextPage: true,
                endCursor: offset === 0 ? "page-2" : "page-3",
              },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide", { method: "POST" }),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(graphqlCalls, 2);
    assert.equal(body.projects.length, 200);
    assert.equal(body.cache?.capped, true);
    assert.equal(body.cache?.repoLimit, 200);
    assert.equal(sentJobs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker limits cold metadata to one small page before queue hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  const nodes = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${index + 1}`;
    return {
      owner: { login: "wide", __typename: "User" },
      name,
      nameWithOwner: `wide/${name}`,
      description: null,
      url: `https://github.com/wide/${name}`,
      defaultBranchRef: { name: "main" },
      primaryLanguage: { name: "TypeScript" },
      repositoryTopics: { nodes: [] },
      stargazerCount: index,
      forkCount: 0,
      issues: { totalCount: index + 1 },
      pullRequests: { totalCount: index },
      isArchived: false,
      isFork: index === 0,
      isPrivate: false,
      pushedAt: "2026-05-15T00:00:00Z",
      updatedAt: "2026-05-15T00:00:00Z",
    };
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; after?: string | null; includeReleases?: boolean };
      };
      assert.equal(body.variables?.first, 25);
      assert.equal(body.variables?.after, null);
      assert.equal(body.variables?.includeReleases, false);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next-page" },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(graphqlCalls, 1);
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.equal(body.cache?.repoLimit, 200);
    assert.equal(body.options?.repoLimit, 200);
    assert.equal(body.projects.length, 24);
    assert.equal(
      body.projects.some((project) => project.name === "repo-1"),
      false,
    );
    assert.equal(body.projects.find((project) => project.name === "repo-25")?.openIssues, 25);
    assert.equal(body.projects.find((project) => project.name === "repo-25")?.openPullRequests, 24);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns structured GitHub errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.match(body.cache?.message ?? "", /GitHub shared API quota is exhausted/);

    const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
    const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
    dashboard.generatedAt = new Date().toISOString();
    if (dashboard.cache && dashboard.options) {
      dashboard.cache.generatedAt = dashboard.generatedAt;
      dashboard.options.includeUnreleased = true;
    }
    const cache = kvStore({ [key]: JSON.stringify(dashboard) });
    const cachedResponse = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(cachedResponse.status, 429);
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(cached.cache?.state, "fresh");
    assert.equal(cached.projects.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL backoff does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore({
    "github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL upstream failure does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "upstream unavailable" },
        {
          status: 503,
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "800",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner", "/graphql"]);
    assert.ok(await cache.get("github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata"));
    assert.ok(await cache.get("github:budget:v1:shared:graphql"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves released-only cache while rebuilding", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "Released repo",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 42,
                  forkCount: 2,
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-05-15T00:00:00Z",
                  updatedAt: "2026-05-15T00:00:00Z",
                  releases: {
                    nodes: [
                      {
                        tagName: "v1.0.0",
                        name: null,
                        url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                        isDraft: false,
                        publishedAt: "2026-05-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: false, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const env = {
    DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]?.version, "v1.0.0");
    assert.match(body.cache?.message ?? "", /release data updating/);

    await Promise.all(waits);
    const cached = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false"),
      env,
      { waitUntil: () => undefined },
    );
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.projects[0]?.openIssues, 7);
    assert.equal(hydrated.projects[0]?.openPullRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects POST to reserved read-only owner-like APIs", async () => {
  for (const path of ["/api/me", "/api/_hot", "/api/_discover"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`, { method: "POST" }),
      {},
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 405, path);
  }
});

test("worker marks GitHub discovery hydration complete when release scan is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      return Response.json({
        total_count: 1,
        items: [
          {
            name: "releasebar",
            full_name: "acme/releasebar",
            private: false,
            fork: false,
            archived: false,
            html_url: "https://github.com/acme/releasebar",
            description: "Release dashboard",
            default_branch: "main",
            language: "TypeScript",
            stargazers_count: 1200,
            forks_count: 42,
            open_issues_count: 7,
            pushed_at: "2026-05-16T12:00:00Z",
            updated_at: "2026-05-16T12:00:00Z",
            owner: { login: "acme" },
          },
        ],
      });
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const waitUntil: Promise<unknown>[] = [];
  const env = { DASHBOARD_CACHE: kvStore() };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntil.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    await Promise.all(waitUntil.splice(0));
    const cached = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    const body = (await cached.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "fresh");
    assert.equal(body.cache?.progress?.done, true);
    assert.equal(body.projects[0]?.version, "repo search");
    assert.match(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker pauses shared quota after discovery secondary rate limits", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "You have exceeded a secondary rate limit" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "search",
        },
      },
    );
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const cooldown = JSON.parse((await cache.get("github:budget:v1:shared:search")) ?? "{}") as {
      active?: boolean;
      resource?: string;
      reason?: string;
      resetAt?: string | null;
    };
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.resource, "search");
    assert.equal(cooldown.reason, "rate limited status 403");
    assert.equal(typeof cooldown.resetAt, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker falls back to stale discovery cache when GitHub search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [testProject({ owner: "cached", name: "repo" })]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    }),
  };
  globalThis.fetch = async () =>
    Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.projects[0]?.fullName, "cached/repo");
    assert.match(body.cache?.message ?? "", /cached search/);
    assert.doesNotMatch(body.cache?.message ?? "", /install the app/i);

    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=month"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(coldResponse.status, 429);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    assert.equal(coldBody.cache?.state, "error");
    assert.match(coldBody.cache?.message ?? "", /repository search quota is exhausted/);
    assert.doesNotMatch(coldBody.cache?.message ?? "", /install the app/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns dashboard-shaped rate-limit errors without raw GitHub JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/vincentkoc") {
      return Response.json(
        {
          message: "API rate limit exceeded for user ID 58493",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
          status: "403",
        },
        { status: 403 },
      );
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  const waits: Array<Promise<unknown>> = [];
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.equal(body.owners[0]?.login, "vincentkoc");
    assert.deepEqual(body.projects, []);
    assert.match(body.cache?.message ?? "", /shared API quota is exhausted/);
    assert.doesNotMatch(body.cache?.message ?? "", /58493|documentation_url|request ID/i);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(cached.status, 429);
    await cached.arrayBuffer();
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard build records GitHub quota headers", async () => {
  const resetAt = Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "installation-token",
    quotaSource: "app",
    quotaAccount: "owner",
    repoLimit: 200,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  });

  assert.equal(payload.cache?.quota?.source, "app");
  assert.equal(payload.cache?.quota?.account, "owner");
  assert.equal(payload.cache?.quota?.limit, 5000);
  assert.equal(payload.cache?.quota?.remaining, 4998);
  assert.equal(payload.cache?.quota?.resetAt, "2026-05-15T13:00:00.000Z");
  assert.equal(payload.cache?.quota?.resource, "graphql");
});

test("worker preserves cached quota metadata on fresh responses", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", []);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
    dashboard.cache.quota = {
      source: "app",
      account: "owner",
      limit: 5000,
      remaining: 4900,
      resetAt: "2026-05-15T13:00:00.000Z",
      resource: "graphql",
    };
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.cache?.state, "fresh");
  assert.equal(body.cache?.quota?.source, "app");
  assert.equal(body.cache?.quota?.remaining, 4900);
});

test("worker streams cached dashboard snapshots over owner events", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /owner\/repo/);
});

test("worker records dashboard stream sync audits", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const cache = kvStore({ [key]: JSON.stringify(dashboard) });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  await response.text();
  const events = await refreshAuditEvents(cache);
  assert.equal(
    events.some((event) => event.event === "dashboard_stream_start"),
    true,
  );
  const send = events.find((event) => event.event === "dashboard_stream_send");
  assert.equal(send?.status, "fresh");
  assert.equal(send?.projects, 1);
  const done = events.find((event) => event.event === "dashboard_stream_done");
  assert.equal(done?.events, 1);
});

test("worker keeps owner events working for the repos owner slug", async () => {
  const key = dashboardCacheKey({ owner: "repos", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("repos", [testProject({ owner: "repos", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /repos\/repo/);
});

test("worker returns rebuilding while another isolate owns the dashboard build lock", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: kvStore(),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses an in-isolate build lease when Durable Objects fail open", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  let graphqlCalls = 0;
  let markGraphqlStarted: (() => void) | undefined;
  let releaseGraphql: (() => void) | undefined;
  const graphqlStarted = new Promise<void>((resolve) => {
    markGraphqlStarted = resolve;
  });
  const graphqlGate = new Promise<void>((resolve) => {
    releaseGraphql = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/local") {
      return Response.json({ login: "local", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      markGraphqlStarted?.();
      await graphqlGate;
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const failedLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/acquire") {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  const env = {
    DASHBOARD_CACHE: cache,
    DASHBOARD_LOCKS: failedLocks,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: { send: async () => undefined },
  };

  try {
    const first = worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    await graphqlStarted;
    const second = await worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(second.status, 202);
    const secondBody = (await second.json()) as DashboardPayload;
    assert.equal(secondBody.cache?.state, "rebuilding");
    releaseGraphql?.();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(graphqlCalls, 1);
  } finally {
    releaseGraphql?.();
    globalThis.fetch = originalFetch;
  }
});

test("worker does not display dashboard data past the stale display window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/old") {
      return Response.json({ login: "old", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const key = dashboardCacheKey({ owner: "old", schemaVersion: 6 });
  const dashboard = testDashboard("old", [testProject({ owner: "old", name: "ancient" })]);
  dashboard.generatedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/old"),
      {
        DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(body.projects.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves partial cached sources while combined dashboard rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const now = new Date().toISOString();
  const alphaSource = testProject({ owner: "alpha", name: "one", openIssues: 1 });
  const alphaMetadata = testProject({
    owner: "alpha",
    name: "one",
    openIssues: 9,
    version: "repo search",
    releaseDate: null,
  });

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        DASHBOARD_CACHE: kvStore({
          [alphaKey]: JSON.stringify(testDashboard("alpha", [alphaSource])),
          [betaKey]: JSON.stringify(
            testDashboard("beta", [testProject({ owner: "beta", name: "two" })]),
          ),
          "owner-metadata:v1:alpha": JSON.stringify({
            owner: "alpha",
            generatedAt: now,
            metadataUpdatedAt: now,
            countsUpdatedAt: now,
            projects: [alphaMetadata],
          }),
        }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.deepEqual(body.projects.map((project) => project.fullName).sort(), [
      "alpha/one",
      "beta/two",
    ]);
    assert.equal(body.totals.repos, 2);
    assert.equal(body.cache?.countsUpdatedAt, null);
    assert.equal(body.cache?.releasesUpdatedAt, null);
    assert.equal(body.cache?.ciUpdatedAt, null);
    const mergedAlpha = body.projects.find((project) => project.fullName === "alpha/one");
    assert.equal(mergedAlpha?.openIssues, 9);
    assert.equal(mergedAlpha?.version, alphaSource.version);
    assert.equal(mergedAlpha?.releaseDate, alphaSource.releaseDate);
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker filters shared owner snapshots for cold combined dashboards", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname === "/users/stale") {
      return Response.json({ login: "stale", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const now = new Date().toISOString();
  const snapshot = (
    owner: string,
    projects: Project[],
    projectMetadataUpdatedAt: Record<string, string> = {},
  ) =>
    JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      projectMetadataUpdatedAt: Object.fromEntries(
        projects.map((project) => [
          project.fullName.toLowerCase(),
          projectMetadataUpdatedAt[project.fullName.toLowerCase()] ?? now,
        ]),
      ),
      projects,
    });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta,stale&unreleased=false"),
      {
        DASHBOARD_CACHE: kvStore({
          "owner-metadata:v1:alpha": snapshot(
            "alpha",
            [
              testProject({ owner: "alpha", name: "released", fork: false }),
              testProject({ owner: "alpha", name: "fork", fork: true }),
              testProject({
                owner: "alpha",
                name: "unreleased",
                fork: false,
                releaseDate: null,
                version: "unreleased",
              }),
              testProject({ owner: "alpha", name: "expired", fork: false }),
            ],
            {
              "alpha/expired": new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ),
          "owner-metadata:v1:beta": snapshot("beta", [
            testProject({ owner: "beta", name: "released", fork: false }),
          ]),
          "owner-metadata:v1:stale": JSON.stringify({
            owner: "stale",
            generatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            metadataUpdatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            countsUpdatedAt: now,
            projects: [testProject({ owner: "stale", name: "private-now", fork: false })],
          }),
        }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.deepEqual(body.projects.map((project) => project.fullName).sort(), [
      "alpha/released",
      "beta/released",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses explicit repository owner snapshots for cold dashboards", async () => {
  const now = new Date().toISOString();
  const project = testProject({ owner: "other", name: "repo" });
  const response = await worker.fetch(
    new Request("https://release.bar/api/dashboard?repos=other/repo"),
    {
      DASHBOARD_CACHE: kvStore({
        "owner-metadata:v1:other": JSON.stringify({
          owner: "other",
          generatedAt: now,
          metadataUpdatedAt: now,
          countsUpdatedAt: now,
          knownRepos: ["other/repo"],
          projectMetadataUpdatedAt: { "other/repo": now },
          projectCountsUpdatedAt: { "other/repo": now },
          projects: [project],
        }),
      }),
      DASHBOARD_LOCKS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => new Response(null, { status: 409 }),
        }),
      },
    },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.deepEqual(
    body.projects.map((candidate) => candidate.fullName),
    ["other/repo"],
  );
});

test("cold partial dashboards honor durable privatization tombstones over stale KV", async () => {
  const now = new Date().toISOString();
  const project = testProject({ owner: "owner", name: "repo" });
  const privateSnapshot = {
    owner: "owner",
    generatedAt: now,
    metadataUpdatedAt: now,
    countsUpdatedAt: now,
    countsAttemptedAt: now,
    releaseDataComplete: true,
    knownRepos: [],
    privateRepos: { "owner/repo": now },
    removedRepos: { "owner/repo": now },
    projectMetadataUpdatedAt: { "owner/repo": now },
    projectCountsUpdatedAt: {},
    countOverlays: {},
    projects: [],
  };
  const response = await worker.fetch(
    new Request("https://release.bar/api/dashboard?repos=owner/repo"),
    {
      DASHBOARD_CACHE: kvStore({
        "owner-metadata:v1:owner": JSON.stringify({
          ...privateSnapshot,
          privateRepos: {},
          removedRepos: {},
          knownRepos: ["owner/repo"],
          projectCountsUpdatedAt: { "owner/repo": now },
          projects: [project],
        }),
      }),
      DASHBOARD_LOCKS: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: async (request: Request) =>
            id === "owner-metadata:owner" &&
            new URL(request.url).pathname === "/owner-metadata/read"
              ? Response.json(privateSnapshot)
              : new Response(null, { status: 409 }),
        }),
      },
    },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.deepEqual(body.projects, []);
});

test("metadata-only partial dashboards strip hydrated release and CI fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const now = new Date().toISOString();
  const snapshot = (owner: string) =>
    JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [testProject({ owner, name: "repo", ciState: "failure" })],
    });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        DASHBOARD_CACHE: kvStore({
          "owner-metadata:v1:alpha": snapshot("alpha"),
          "owner-metadata:v1:beta": snapshot("beta"),
        }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.projects.length, 2);
    for (const project of body.projects) {
      assert.equal(project.version, "repo search");
      assert.equal(project.releaseDate, null);
      assert.equal(project.latestCommitSha, null);
      assert.equal(project.commitsSinceRelease, null);
      assert.equal(project.ciState, "unknown");
      assert.equal(project.ciConclusion, null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker progressively resumes large owner dashboard builds from partial cache", async () => {
  const originalFetch = globalThis.fetch;
  const repos = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "big" },
      name,
      full_name: `big/${name}`,
      description: null,
      html_url: `https://github.com/big/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      fork: false,
      private: false,
    };
  });
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = { DASHBOARD_CACHE: kvStore() };

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/big") {
      return Response.json({ login: "big", type: "User" });
    }
    if (path === "/users/big/repos") {
      return Response.json(repos);
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/big/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/big/repo/compare",
      });
    }
    if (path.endsWith("/pulls")) {
      return Response.json([]);
    }
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const first = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const firstBody = (await first.json()) as DashboardPayload;
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(firstBody.cache?.state, "partial");
    assert.equal(firstBody.cache?.progress?.scanned, 0);
    assert.equal(firstBody.cache?.progress?.done, false);
    assert.equal(firstBody.projects.length, 25);
    assert.equal(
      firstBody.projects.filter((project) => project.version === "repo search").length,
      25,
    );

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const secondBody = (await second.json()) as DashboardPayload;
    assert.equal(secondBody.cache?.state, "fresh");
    assert.equal(secondBody.cache?.progress?.done, true);
    assert.equal(secondBody.projects.length, 25);
    assert.equal(typeof secondBody.cache?.releasesUpdatedAt, "string");
    assert.equal(secondBody.cache?.ciUpdatedAt, secondBody.cache?.releasesUpdatedAt);
    assert.equal(
      secondBody.projects.filter((project) => project.version === "repo search").length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker bounds cold owner resolution by the response deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  let deliveryDelaySeconds: number | undefined;
  let ownerAborted = false;
  let releaseOwner: (() => void) | undefined;
  const ownerGate = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  let ownerStarted = false;
  const cache = kvStore();

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 15_000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/slowmeta") {
      ownerStarted = true;
      await new Promise<void>((resolve, reject) => {
        if (init?.signal?.aborted) {
          ownerAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            ownerAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        void ownerGate.then(resolve);
      });
      return Response.json({ login: "slowmeta", type: "User" });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slowmeta"),
      {
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send(job: RefreshJob, options?: { delaySeconds?: number }) {
            sentJobs.push(job);
            deliveryDelaySeconds = options?.delaySeconds;
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(ownerStarted, true);
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    assert.equal(ownerAborted, true);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
    assert.equal(deliveryDelaySeconds, 2);
  } finally {
    releaseOwner?.();
    await Promise.all(waits);
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker bounds cold GitHub App token lookup by the response deadline", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  let credentialAborted = false;
  const cache = kvStore();

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 15_000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app/installations") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          credentialAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            credentialAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    if (path === "/users/slowtoken") {
      throw new DOMException("Aborted", "AbortError");
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slowtoken"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    assert.equal(credentialAborted, true);
    await Promise.all(waits);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-build");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker resumes durable progress on cold metadata cache misses", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  const project = testProject({ owner: "checkpoint", name: "repo" });
  const progress = {
    scannedRepos: Array.from({ length: 43 }, (_, index) => `checkpoint/repo-${index}`),
    projects: [project],
    updatedAt: new Date().toISOString(),
  };
  let progressDeletes = 0;
  let progressWrites = 0;
  let released = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/acquire" || path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/progress/get") {
          return Response.json(progress, {
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/progress/delete") {
          progressDeletes += 1;
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/progress/put") {
          progressWrites += 1;
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/target-index/upsert") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/checkpoint") {
      return Response.json({ login: "checkpoint", type: "User" });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/checkpoint"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: locks,
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.scanned, 43);
    assert.deepEqual(body.projects, [project]);
    await Promise.all(waits);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
    assert.equal(progressDeletes, 0);
    assert.equal(progressWrites, 0);
    assert.equal(released, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker chains direct progressive continuation after a cold build timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "slow" },
      name,
      full_name: `slow/${name}`,
      description: null,
      html_url: `https://github.com/slow/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      fork: false,
      private: false,
    };
  });
  const waits: Promise<unknown>[] = [];
  let releaseFirstRepo: (() => void) | undefined;
  const firstRepoGate = new Promise<void>((resolve) => {
    releaseFirstRepo = resolve;
  });
  let firstRepoStarted: (() => void) | undefined;
  const firstRepoFetch = new Promise<void>((resolve) => {
    firstRepoStarted = resolve;
  });
  let gated = false;
  const cache = kvStore();
  const key = dashboardCacheKey({
    owner: "slow",
    includeUnreleased: false,
    includeReleaseData: true,
    schemaVersion: 6,
  });

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 15_000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/slow") {
      return Response.json({ login: "slow", type: "User" });
    }
    if (path === "/users/slow/repos") {
      return Response.json(repos);
    }
    if (path.endsWith("/releases")) {
      if (!gated) {
        gated = true;
        firstRepoStarted?.();
        await firstRepoGate;
      }
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/slow/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/slow/repo/compare",
      });
    }
    if (path.endsWith("/pulls")) {
      return Response.json([]);
    }
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slow?unreleased=false"),
      { DASHBOARD_CACHE: cache },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    await firstRepoFetch;
    releaseFirstRepo?.();
    while (waits.length > 0) {
      await Promise.all(waits.splice(0));
    }

    const stored = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(stored.cache?.state, "fresh");
    assert.equal(stored.cache?.progress?.done, true);
    assert.equal(stored.cache?.progress?.scanned, 13);
    assert.equal(stored.projects.length, 13);
  } finally {
    releaseFirstRepo?.();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker deduplicates queued refreshes for partial dashboards", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: new Date().toISOString(),
      progress: {
        scanned: 12,
        limit: 200,
        done: false,
      },
    },
  };
  const backingCache = kvStore({ [key]: JSON.stringify(cached) });
  let targetReads = 0;
  const cache = {
    ...backingCache,
    async get(storageKey: string) {
      if (storageKey.startsWith("refresh:target:v1:")) {
        targetReads += 1;
      }
      return backingCache.get(storageKey);
    },
  };
  const sentJobs: RefreshJob[] = [];
  let deliveryDelaySeconds: number | undefined;
  let reservedJobId: string | null = null;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as { jobId?: string };
        if (path === "/job/reserve") {
          if (reservedJobId && reservedJobId !== body.jobId) {
            return new Response(null, { status: 409 });
          }
          reservedJobId = body.jobId ?? null;
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          if (reservedJobId === body.jobId) {
            reservedJobId = null;
          }
          return new Response(null, { status: 204 });
        }
        if (path === "/target-index/upsert") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const env = {
    DASHBOARD_CACHE: cache,
    DASHBOARD_LOCKS: locks,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob, options?: { delaySeconds?: number }) {
        sentJobs.push(job);
        deliveryDelaySeconds = options?.delaySeconds;
      },
    },
  };

  await Promise.all(
    Array.from({ length: 2 }, async () => {
      const waits: Promise<unknown>[] = [];
      const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
        waitUntil: (promise) => waits.push(promise),
      });
      assert.equal(response.status, 200);
      await Promise.all(waits);
    }),
  );

  assert.equal(sentJobs.length, 1);
  assert.equal(sentJobs[0]?.reason, "partial-cache");
  assert.equal(sentJobs[0]?.target, undefined);
  assert.match(sentJobs[0]?.targetSnapshotKey ?? "", /^refresh:jobs:v2:/);
  assert.equal(deliveryDelaySeconds, 2);
  assert.equal(targetReads, 2);
  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  assert.equal(indexedJobs.keys.length, 1);
  const snapshot = JSON.parse(
    (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
  ) as RefreshJob;
  assert.equal(snapshot.target?.key, key);
  assert.equal((await cache.list({ prefix: "refresh:job:v1:" })).keys.length, 0);
});

test("worker Queue messages stay bounded when profile filters are large", async () => {
  const key = dashboardCacheKey({
    owner: "profiled",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const profile = {
    owner: "profiled",
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: Array.from(
      { length: 5000 },
      (_, index) => `profiled/repository-${String(index).padStart(4, "0")}`,
    ),
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: "profiled",
  };
  const profileSnapshotKey = `refresh:profile-snapshot:v1:profiled:${encodeURIComponent(
    profile.updatedAt,
  )}`;
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "profiled",
    owners: ["profiled"],
    repos: [],
    profileSnapshotKey,
    includeReleaseData: false,
    path: "/profiled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [profileSnapshotKey]: JSON.stringify(profile),
  });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];

  await (
    worker as unknown as {
      scheduled(
        event: { cron: string },
        env: unknown,
        context: { waitUntil(promise: Promise<unknown>): void },
      ): Promise<void>;
    }
  ).scheduled(
    { cron: "*/15 * * * *" },
    {
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: (promise) => waits.push(promise) },
  );
  await Promise.all(waits);

  assert.equal(sentJobs.length, 1);
  assert.equal(sentJobs[0]?.target, undefined);
  assert.equal(JSON.stringify(sentJobs[0]).length < 4096, true);
  const snapshot = JSON.parse(
    (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
  ) as RefreshJob;
  assert.equal(snapshot.target?.profileSnapshotKey, profileSnapshotKey);
  assert.equal(JSON.stringify(snapshot.target).length < 4096, true);
  assert.equal(await cache.get("refresh:target-index:v1:ready"), null);
  const storedProfile = JSON.parse((await cache.get(profileSnapshotKey)) ?? "{}") as {
    hiddenRepos?: string[];
  };
  assert.equal(storedProfile.hiddenRepos?.length, 5000);
});

test("owner count scheduling rotates beyond a deferred owner cap", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const owners = Array.from({ length: 21 }, (_, index) => `owner${String(index).padStart(3, "0")}`);
  const entries = Object.fromEntries(
    owners.flatMap((owner) => {
      const key = dashboardCacheKey({
        owner,
        includeUnreleased: true,
        includeReleaseData: true,
        schemaVersion: 6,
      });
      const project = testProject({ owner, name: "repo" });
      const target: RefreshTarget = {
        key,
        kind: "dashboard",
        owner,
        owners: [owner],
        repos: [],
        includeReleaseData: true,
        path: `/${owner}`,
        priority: 100,
        lastSeenAt: now,
        lastAttemptAt: null,
        lastSuccessAt: now,
        nextDueAt: "2999-01-01T00:00:00Z",
        failureCount: 0,
      };
      return [
        [`refresh:target:v1:${key}`, JSON.stringify(target)],
        [key, JSON.stringify(testDashboard(owner, [project]))],
        [
          `owner-metadata:v1:${owner}`,
          JSON.stringify({
            owner,
            generatedAt: now,
            metadataUpdatedAt: now,
            countsUpdatedAt: staleAt,
            releaseDataComplete: true,
            knownRepos: [project.fullName.toLowerCase()],
            removedRepos: {},
            projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
            projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
            projects: [project],
          }),
        ],
      ];
    }),
  );
  const cache = kvStore(entries);
  const run = async () => {
    const waits: Promise<unknown>[] = [];
    await (
      worker as unknown as {
        scheduled(
          event: { cron: string },
          env: unknown,
          context: { waitUntil(promise: Promise<unknown>): void },
        ): Promise<void>;
      }
    ).scheduled(
      { cron: "*/15 * * * *" },
      { DASHBOARD_CACHE: cache },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  };

  await run();
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), "owner019");
  await run();
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), "owner018");
});

test("owner count scheduling throttles recent incomplete scans", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "large-owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "large-owner", name: "repo" });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "large-owner",
    owners: ["large-owner"],
    repos: [],
    includeReleaseData: true,
    path: "/large-owner",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [key]: JSON.stringify(testDashboard("large-owner", [project])),
    "owner-metadata:v1:large-owner": JSON.stringify({
      owner: "large-owner",
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: staleAt,
      countsAttemptedAt: now,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      removedRepos: {},
      projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
      projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
      projects: [project],
    }),
  });
  const originalFetch = globalThis.fetch;
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname === "/graphql") graphqlRequests += 1;
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/15 * * * *" } as never,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(graphqlRequests, 0);
  assert.equal(await cache.get("refresh:owner-count-cursor:v1"), null);
});

test("worker scheduler terminalizes retryable refreshes when Queue is unavailable", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: "/owner",
    priority: 100,
    lastSeenAt: "2026-06-11T06:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T06:00:00Z",
    failureCount: 0,
  };
  const cached: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: new Date().toISOString(),
      progress: {
        scanned: 12,
        limit: 200,
        done: false,
      },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  let released = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const waits: Promise<unknown>[] = [];
  await (
    worker as unknown as {
      scheduled(
        event: { cron: string },
        env: unknown,
        context: { waitUntil(promise: Promise<unknown>): void },
      ): Promise<void>;
    }
  ).scheduled(
    { cron: "*/15 * * * *" },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: (promise) => waits.push(promise) },
  );

  while (waits.length > 0) {
    await Promise.all(waits.splice(0));
  }

  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  assert.equal(indexedJobs.keys.length, 1);
  const indexed = JSON.parse(
    (await cache.get(indexedJobs.keys[0]?.name ?? "")) ?? "{}",
  ) as RefreshJob;
  const stored = JSON.parse(
    (await cache.get(`refresh:job:v1:${indexed.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.match(stored.error ?? "", /Queue continuation unavailable/);
  assert.equal(released, true);
});

test("dashboard build lock only releases the matching lease token", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );

  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    409,
  );

  storage.set("lock", { token: "first", expiresAt: Date.now() - 1 });
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  const secondExpiresAt = (storage.get("lock") as { expiresAt: number }).expiresAt;
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal((storage.get("lock") as { expiresAt: number }).expiresAt >= secondExpiresAt, true);
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/release", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.deepEqual(storage.get("lock"), {
    token: "second",
    expiresAt: (storage.get("lock") as { expiresAt: number }).expiresAt,
  });
});

test("dashboard build lock reserves one refresh job per dashboard", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );
  const request = (path: string, jobId: string) =>
    lock.fetch(
      new Request(`https://releasebar.internal${path}`, {
        method: "POST",
        body: JSON.stringify({ jobId }),
      }),
    );

  assert.equal((await request("/job/reserve", "first")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 409);
  assert.equal((await request("/job/reserve", "first")).status, 204);
  assert.equal((await request("/job/release", "second")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 409);
  assert.equal((await request("/job/release", "first")).status, 204);
  assert.equal((await request("/job/reserve", "second")).status, 204);
});

test("dashboard target mutations preserve terminal backoff across stale observations", async () => {
  const storage = new Map<string, unknown>();
  const cache = kvStore();
  const lock = new DashboardBuildLock(
    {
      blockConcurrencyWhile: async (callback) => callback(),
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    { DASHBOARD_CACHE: cache },
  );
  const input = {
    key: "dashboard:v6:owner=target-race",
    owner: "target-race",
    owners: ["target-race"],
    repos: [],
    includeReleaseData: true,
    path: "/target-race",
    priority: 100,
  };
  const mutate = async (snapshot: RefreshTarget | null, mutation: unknown) => {
    const response = await lock.fetch(
      new Request("https://releasebar.internal/target/mutate", {
        method: "POST",
        body: JSON.stringify({ snapshot, mutation }),
      }),
    );
    assert.equal(response.status, 200);
    return (await response.json()) as RefreshTarget;
  };

  const observed = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:00:00Z",
    profileProvided: false,
  });
  const failed = await mutate(observed, {
    kind: "failure",
    at: "2026-06-11T12:01:00Z",
    message: "terminal failure",
    terminal: true,
  });
  const observedAgain = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:02:00Z",
    profileProvided: false,
  });

  assert.equal(observedAgain.failureCount, 1);
  assert.equal(observedAgain.nextDueAt, failed.nextDueAt);
  assert.equal(observedAgain.terminalBackoffUntil, failed.nextDueAt);
  assert.equal(observedAgain.message, "terminal failure");
  const stored = JSON.parse(
    (await cache.get(`refresh:target:v1:${input.key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(stored.terminalBackoffUntil, failed.nextDueAt);
});

test("dashboard build lock stores strongly consistent build progress", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );
  const request = (path: string, body?: unknown) =>
    lock.fetch(
      new Request(`https://releasebar.internal${path}`, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const progress = {
    scannedRepos: ["owner/repo"],
    projects: [testProject({ owner: "owner", name: "repo" })],
    updatedAt: "2026-06-11T12:00:00Z",
  };

  const empty = await request("/progress/get");
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get("x-releasebar-progress"), "durable");
  assert.equal((await request("/progress/put", progress)).status, 204);
  const stored = await request("/progress/get");
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get("x-releasebar-progress"), "durable");
  assert.deepEqual(await stored.json(), progress);
  assert.equal((await request("/progress/delete")).status, 204);
  assert.equal((await request("/progress/get")).status, 204);

  assert.equal(
    (
      await request("/progress/put", {
        ...progress,
        updatedAt: "2020-01-01T00:00:00Z",
      })
    ).status,
    204,
  );
  assert.equal((await request("/progress/get")).status, 204);
  assert.equal(storage.has("build-progress"), false);
});

test("worker falls back to KV progress when the Durable Object is unavailable", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
    }
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: async (request: Request) => {
              if (new URL(request.url).pathname === "/owner-metadata/read") {
                return new Response(null, { status: 204 });
              }
              throw new Error("Durable Object unavailable");
            },
          }),
        },
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          send: async () => undefined,
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const fallback = JSON.parse((await cache.get(`progress:v1:${key}`)) ?? "{}") as {
      durableFallback?: boolean;
    };
    assert.equal(fallback.durableFallback, true);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker resumes marked KV progress after an authoritative Durable Object miss", async () => {
  const key = dashboardCacheKey({
    owner: "fallback",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "fallback",
    owners: ["fallback"],
    repos: [],
    includeReleaseData: true,
    path: "/fallback",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-kv-progress-fallback",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "fallback" },
      name,
      full_name: `fallback/${name}`,
      description: null,
      html_url: `https://github.com/fallback/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: "2026-06-11T06:00:00Z",
      updated_at: "2026-06-11T06:00:00Z",
      fork: false,
      private: false,
    };
  });
  const progressProjects = repos.slice(0, 12).map((repo) =>
    testProject({
      owner: "fallback",
      name: repo.name,
      pushedAt: repo.pushed_at,
      updatedAt: repo.updated_at,
      latestCommitDate: repo.updated_at,
    }),
  );
  const cache = kvStore({
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: progressProjects.map((project) => project.fullName.toLowerCase()),
      projects: progressProjects,
      updatedAt: "2026-06-11T07:00:00Z",
      durableFallback: true,
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/progress/get") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/progress/delete" || path === "/progress/put") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  const originalFetch = globalThis.fetch;
  const hydratedRepos: string[] = [];
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/fallback") {
        return Response.json({ login: "fallback", type: "User" });
      }
      if (path === "/users/fallback/repos") {
        return Response.json(repos);
      }
      if (path.endsWith("/releases")) {
        hydratedRepos.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("KV fallback progress should complete");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: locks },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(acked, true);
  assert.deepEqual(hydratedRepos, ["repo-13"]);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.equal(dashboard.projects.length, 13);
  assert.equal(dashboard.cache?.progress?.done, true);
});

test("worker does not restore stale KV progress after an authoritative Durable Object miss", async () => {
  const key = dashboardCacheKey({
    owner: "authoritative",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "authoritative",
    owners: ["authoritative"],
    repos: [],
    includeReleaseData: true,
    path: "/authoritative",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-authoritative-progress",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const staleProject = testProject({ owner: "authoritative", name: "deleted" });
  const cache = kvStore({
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [staleProject.fullName.toLowerCase()],
      projects: [staleProject],
      updatedAt: "2026-06-11T07:00:00Z",
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/progress/get") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/progress/put" || path === "/progress/delete") {
          return new Response(null, {
            status: 204,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  const originalFetch = globalThis.fetch;
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/authoritative") {
        return Response.json({ login: "authoritative", type: "User" });
      }
      if (path === "/users/authoritative/repos") {
        return Response.json([]);
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("authoritative progress job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: locks },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(acked, true);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.deepEqual(dashboard.projects, []);
  const tombstone = JSON.parse((await cache.get(`progress:tombstone:v1:${key}`)) ?? "{}") as {
    clearedAt?: string;
  };
  assert.equal(typeof tombstone.clearedAt, "string");
});

test("worker does not persist delayed progress older than its tombstone", async () => {
  const key = dashboardCacheKey({
    owner: "delayed-progress",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "delayed-progress",
    owners: ["delayed-progress"],
    repos: [],
    includeReleaseData: false,
    path: "/delayed-progress",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: new Date().toISOString(),
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-delayed-progress",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "delayed-progress" },
      name,
      full_name: `delayed-progress/${name}`,
      description: null,
      html_url: `https://github.com/delayed-progress/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: "2026-06-11T06:00:00Z",
      updated_at: "2026-06-11T06:00:00Z",
      fork: false,
      private: false,
    };
  });
  const cache = kvStore({
    [`progress:tombstone:v1:${key}`]: JSON.stringify({
      clearedAt: "2999-01-01T00:00:00Z",
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  let retryDelaySeconds: number | undefined;

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/delayed-progress") {
      return Response.json({ login: "delayed-progress", type: "User" });
    }
    if (path === "/users/delayed-progress/repos") {
      return Response.json(repos);
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("partial delayed progress should retry");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(retryDelaySeconds, 2);
  assert.equal(await cache.get(`progress:v1:${key}`), null);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.equal(dashboard.cache?.progress?.scanned, 12);
  assert.equal(dashboard.cache?.progress?.done, false);
});

test("worker tombstones failed Durable Object progress deletion before publishing fresh cache", async () => {
  const originalFetch = globalThis.fetch;
  const key = dashboardCacheKey({
    owner: "delete-failure",
    includeUnreleased: false,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const progressStorageKey = `progress:v1:${key}`;
  const progressTombstoneStorageKey = `progress:tombstone:v1:${key}`;
  const storedProgress = JSON.stringify({
    scannedRepos: [],
    projects: [],
    updatedAt: new Date().toISOString(),
  });
  const cache = kvStore({ [progressStorageKey]: storedProgress });
  const staleProject = testProject({
    owner: "delete-failure",
    name: "repo",
    version: "v0.1.0",
    releaseDate: "2025-01-01T00:00:00Z",
  });
  let released = false;
  let deleteAttempts = 0;
  let deleteFails = true;
  let durableProgressPresent = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/acquire") {
          return new Response(null, { status: 204 });
        }
        if (path === "/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/progress/get") {
          return durableProgressPresent
            ? Response.json(
                {
                  scannedRepos: [staleProject.fullName.toLowerCase()],
                  projects: [staleProject],
                  updatedAt: "2026-06-10T00:00:00Z",
                },
                { headers: { "x-releasebar-progress": "durable" } },
              )
            : new Response(null, {
                status: 204,
                headers: { "x-releasebar-progress": "durable" },
              });
        }
        if (path === "/progress/delete") {
          deleteAttempts += 1;
          if (!deleteFails) {
            durableProgressPresent = false;
            return new Response(null, {
              status: 204,
              headers: { "x-releasebar-progress": "durable" },
            });
          }
          durableProgressPresent = true;
          return new Response(null, {
            status: 503,
            headers: { "x-releasebar-progress": "durable" },
          });
        }
        if (path === "/job/reserve" || path === "/job/release") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/delete-failure") {
      return Response.json({ login: "delete-failure", type: "User" });
    }
    if (path === "/users/delete-failure/repos") {
      return Response.json([
        {
          owner: { login: "delete-failure" },
          name: "repo",
          full_name: "delete-failure/repo",
          description: null,
          html_url: "https://github.com/delete-failure/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: "2026-06-11T06:00:00Z",
          updated_at: "2026-06-11T06:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/delete-failure/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-06-10T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-06-11T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/delete-failure/repo/compare",
      });
    }
    if (path.endsWith("/pulls")) {
      return Response.json([]);
    }
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/delete-failure?unreleased=false"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: locks,
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "fresh");
    assert.equal(body.projects[0]?.version, "v1.0.0");
    const tombstone = JSON.parse((await cache.get(progressTombstoneStorageKey)) ?? "{}") as {
      clearedAt?: string;
    };
    assert.equal(typeof tombstone.clearedAt, "string");
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(cached.cache?.state, "fresh");
    assert.equal(deleteAttempts, 1);
    assert.equal(released, true);

    deleteFails = false;
    const target: RefreshTarget = {
      key,
      kind: "dashboard",
      owner: "delete-failure",
      owners: ["delete-failure"],
      repos: [],
      includeReleaseData: true,
      path: "/delete-failure?unreleased=false",
      priority: 100,
      lastSeenAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextDueAt: new Date().toISOString(),
      failureCount: 0,
    };
    const job: RefreshJob = {
      id: "job-delete-failure-recovery",
      targetKey: key,
      target,
      kind: "dashboard",
      status: "queued",
      reason: "error-cache",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      durationMs: null,
    };
    let acked = false;
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("recovered progress deletion should not retry");
            },
          },
        ],
      },
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: locks,
      },
      { waitUntil: () => undefined },
    );

    assert.equal(acked, true);
    const recovered = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(recovered.cache?.state, "fresh");
    assert.equal(recovered.projects[0]?.version, "v1.0.0");
    const recoveredTombstone = JSON.parse(
      (await cache.get(progressTombstoneStorageKey)) ?? "{}",
    ) as { clearedAt?: string };
    assert.equal(typeof recoveredTombstone.clearedAt, "string");
    assert.equal(deleteAttempts >= 2, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects oversized custom source requests", async () => {
  const owners = Array.from({ length: 9 }, (_, index) => `owner-${index}`).join(",");
  const response = await worker.fetch(
    new Request(`https://release.bar/api/dashboard?owners=${owners}`),
    {},
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /too many custom sources/);
});

test("worker exposes GitHub App auth endpoints", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const context = { waitUntil: () => undefined };

  const anonymous = await worker.fetch(new Request("https://release.bar/api/me"), env, context);
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), {
    configured: true,
    quotaConfigured: false,
    user: null,
    installations: [],
    installNeeded: false,
    installReason: null,
    loginUrl: "https://release.bar/api/auth/login",
    logoutUrl: "https://release.bar/api/auth/logout",
    installUrl: "https://release.bar/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
  });

  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw?owners=steipete"),
    env,
    context,
  );
  assert.equal(login.status, 302);
  const location = login.headers.get("location") ?? "";
  assert.equal(location.startsWith("https://github.com/login/oauth/authorize?"), true);
  assert.match(location, /client_id=Iv123/);
  assert.match(location, /redirect_uri=https%3A%2F%2Frelease.bar%2Fapi%2Fauth%2Fcallback/);
  assert.equal(new URL(location).searchParams.has("scope"), false);
  assert.match(login.headers.get("set-cookie") ?? "", /rd_oauth_state_[^=]+=.+HttpOnly/);

  const badCallback = await worker.fetch(
    new Request("https://release.bar/api/auth/callback?code=x&state=bad"),
    env,
    context,
  );
  assert.equal(badCallback.status, 400);
  assert.equal((await env.DASHBOARD_CACHE.list({ prefix: "auth:funnel:v1:" })).keys.length, 0);

  const install = await worker.fetch(
    new Request("https://release.bar/api/auth/install?returnTo=/openclaw"),
    env,
    context,
  );
  assert.equal(install.status, 302);
  assert.equal(
    install.headers.get("location"),
    "https://github.com/apps/releasebar-app/installations/new",
  );
});

test("worker binds OAuth callbacks to the initiating browser", async () => {
  const returnTo = "/openclaw?owners=steipete";
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const context = { waitUntil: () => undefined };
  const login = await worker.fetch(
    new Request(`https://release.bar/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    env,
    context,
  );
  const location = new URL(login.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.equal(stateCookie.length < 256, true);

  const longLogin = await worker.fetch(
    new Request(
      `https://release.bar/api/auth/login?returnTo=${encodeURIComponent(`/openclaw?filter=${"x".repeat(5000)}`)}`,
    ),
    env,
    context,
  );
  const longState =
    new URL(longLogin.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const longStatePayload = JSON.parse(
    Buffer.from(longState.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { returnTo: string };
  assert.equal(longState.length < 2048, true);
  assert.equal(longStatePayload.returnTo, "/");

  let oauthExchanges = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      oauthExchanges += 1;
      return Response.json({ access_token: "user-token", token_type: "bearer", scope: "" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: 1,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/octocat",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const callbackUrl = `https://release.bar/api/auth/callback?code=code&state=${encodeURIComponent(state)}`;
    const unbound = await worker.fetch(new Request(callbackUrl), env, context);
    assert.equal(unbound.status, 400);
    assert.equal(oauthExchanges, 0);

    const callback = await worker.fetch(
      new Request(callbackUrl, { headers: { cookie: stateCookie } }),
      env,
      context,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), returnTo);
    assert.match(callback.headers.get("set-cookie") ?? "", /rd_session=/);
    assert.match(callback.headers.get("set-cookie") ?? "", /rd_oauth_state_[^=]+=;.*Max-Age=0/);
    assert.equal(oauthExchanges, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker queues shared cache warming after login discovers an installation", async () => {
  const profile = {
    owner: "openclaw",
    includeOwners: [],
    includeRepos: ["outside/releasebar"],
    hiddenOwners: [],
    hiddenRepos: [],
    updatedAt: "2026-06-15T09:00:00.000Z",
    updatedBy: "openclaw",
  };
  const cacheKey = dashboardCacheKey({
    owner: "openclaw",
    owners: [],
    repos: ["outside/releasebar"],
    salt: profile.updatedAt,
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const staleDashboard = testDashboard("openclaw", []);
  const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  staleDashboard.generatedAt = staleAt;
  staleDashboard.cache!.generatedAt = staleAt;
  const cache = kvStore({
    "profile:v1:openclaw": JSON.stringify(profile),
    [cacheKey]: JSON.stringify(staleDashboard),
  });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw"),
    env,
    context,
  );
  const location = new URL(login.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({ access_token: "user-token", token_type: "bearer", scope: "" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: 2,
        login: "openclaw",
        name: "OpenClaw",
        avatar_url: "https://avatars.githubusercontent.com/u/2",
        html_url: "https://github.com/openclaw",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 77,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/77",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const callback = await worker.fetch(
      new Request(
        `https://release.bar/api/auth/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookie } },
      ),
      env,
      context,
    );
    await Promise.all(waits);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/openclaw");
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "installation-warm");
    assert.match(sentJobs[0]?.targetKey ?? "", /openclaw/);
    const snapshot = JSON.parse(
      (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
    ) as RefreshJob;
    assert.deepEqual(snapshot.target?.owners, ["openclaw"]);
    assert.deepEqual(snapshot.target?.repos, ["outside/releasebar"]);
    assert.equal(snapshot.target?.includeReleaseData, false);
    assert.equal(
      snapshot.target?.profileSnapshotKey,
      `refresh:profile-snapshot:v1:openclaw:${encodeURIComponent(profile.updatedAt)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker remembers GitHub App installs without OAuth session", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/openclaw",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore();
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/77") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 77,
        account: {
          login: "openclaw",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/2",
          html_url: "https://github.com/openclaw",
        },
        html_url: "https://github.com/organizations/openclaw/settings/installations/77",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=77&setup_action=install", {
        headers: { cookie: `rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    assert.equal(install.status, 302);
    assert.equal(install.headers.get("location"), "/openclaw");
    const remembered = JSON.parse((await cache.get("auth:installation:v1:openclaw")) ?? "{}");
    assert.equal(remembered.id, 77);
    assert.equal(remembered.accountLogin, "openclaw");
    assert.equal(remembered.repositorySelection, "all");
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "installation-warm");
    assert.match(sentJobs[0]?.targetKey ?? "", /openclaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reports GitHub App installation coverage for signed-in users", async () => {
  const sessionId = "session-1";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.login, "octocat");
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.equal(body.quotaConfigured, true);
    assert.equal(body.installations[0].accountLogin, "openclaw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker detects the signed-in user's GitHub App install with app auth fallback", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-app-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 99,
          account: {
            login: "steipete",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1",
            html_url: "https://github.com/steipete",
          },
          html_url: "https://github.com/settings/installations/99",
          repository_selection: "all",
          target_type: "User",
        },
        {
          id: 100,
          account: {
            login: "someone-else",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/someone-else",
          },
          html_url: "https://github.com/settings/installations/100",
          repository_selection: "all",
          target_type: "User",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.deepEqual(
      body.installations.map((installation: { accountLogin: string }) => installation.accountLogin),
      ["steipete"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not prompt signed-in users to install the app for third-party repos", async () => {
  const sessionId = "session-third-party";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/-/f/prompts.chat", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.match(body.installReason, /shared API quota unless f\/prompts\.chat installs/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker still prompts signed-in users to install the app for owner dashboards", async () => {
  const sessionId = "session-owner-install";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, true);
    assert.match(body.installReason, /Install the GitHub App for @openclaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker remembers a just-completed GitHub App install while GitHub catches up", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-install-return";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/steipete",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/99") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 99,
        account: {
          login: "steipete",
          type: "User",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/steipete",
        },
        html_url: "https://github.com/settings/installations/99",
        repository_selection: "all",
        target_type: "User",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}; rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(install.status, 302);
    assert.equal(install.headers.get("location"), "/steipete");

    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    const acknowledgedAt = stored.installationsUpdatedAt;
    const remembered = stored.installations.find(
      (installation: { id: number }) => installation.id === 99,
    );
    assert.equal(remembered.accountLogin, "steipete");
    assert.equal(remembered.repositorySelection, "all");

    const me = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.equal(
      body.installations.some(
        (installation: { accountLogin: string }) => installation.accountLogin === "steipete",
      ),
      true,
    );
    const afterMe = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    assert.equal(afterMe.installationsUpdatedAt, acknowledgedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores install callback acknowledgements without signed return state", async () => {
  const sessionId = "session-install-forged";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    assert.equal(stored.installations, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker records server-verified install callbacks without signed return state", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/101") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 101,
        account: {
          login: "outside-org",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/101",
          html_url: "https://github.com/outside-org",
        },
        html_url: "https://github.com/organizations/outside-org/settings/installations/101",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=101&setup_action=install"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    const remembered = JSON.parse((await cache.get("auth:installation:v1:outside-org")) ?? "{}");
    assert.equal(remembered.id, 101);
    assert.equal(remembered.accountLogin, "outside-org");
    const events = await cache.list({ prefix: "auth:funnel:v1:" });
    assert.equal(events.keys.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only exposes public selected installation repositories", async () => {
  const sessionId = "session-public-repos";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "steipete",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/58493",
              html_url: "https://github.com/steipete",
            },
            html_url: "https://github.com/settings/installations/1",
            repository_selection: "selected",
            target_type: "User",
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/1/repositories") {
      return Response.json({
        repositories: [
          {
            full_name: "steipete/public-repo",
            private: false,
            visibility: "public",
          },
          {
            full_name: "steipete/private-repo",
            private: true,
            visibility: "private",
          },
          {
            full_name: "steipete/contradictory-private-repo",
            private: true,
            visibility: "public",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/?repos=steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.installations[0].repositories, ["steipete/public-repo"]);
    assert.equal(body.installNeeded, false);

    const repoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoRoute.status, 200);
    const repoRouteBody = await repoRoute.json();
    assert.equal(repoRouteBody.installNeeded, false);

    const escapedRepoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/-/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(escapedRepoRoute.status, 200);
    const escapedRepoRouteBody = await escapedRepoRoute.json();
    assert.equal(escapedRepoRouteBody.installNeeded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker allows mixed-account dashboards to use partitioned App quota", async () => {
  const sessionId = "session-2";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: ["openclaw", "steipete"].map((login, index) => ({
          id: index + 1,
          account: {
            login,
            type: index === 0 ? "Organization" : "User",
            avatar_url: `https://avatars.githubusercontent.com/u/${index + 2}`,
            html_url: `https://github.com/${login}`,
          },
          html_url: `https://github.com/settings/installations/${index + 1}`,
          repository_selection: "all",
          target_type: index === 0 ? "Organization" : "User",
        })),
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps signed-in mixed-account dashboards on shared release scans", async () => {
  const sessionId = "session-mixed-dashboard";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const graphqlIncludeReleases: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/users/steipete") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "steipete", type: "User" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer shared-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { includeReleases?: boolean };
      };
      graphqlIncludeReleases.push(Boolean(body.variables?.includeReleases));
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4996",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.deepEqual(graphqlIncludeReleases, [false, false]);
    assert.equal(sentJobs.length, 1);
    assert.equal(sentJobs[0]?.reason, "cold-metadata");
    assert.equal(body.cache?.quota?.source, "shared");
    assert.equal(body.cache?.quota?.remaining, 4996);
    assert.doesNotMatch(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured owner dashboards metadata-only", async () => {
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "v9.9.9",
      releaseName: "hydrated release cache",
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const fetchedPaths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    fetchedPaths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "repo",
          full_name: "owner/repo",
          description: null,
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          language: "TypeScript",
          topics: ["releasebar"],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 2,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.deepEqual(fetchedPaths, ["/users/owner", "/users/owner/repos"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "cookie");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.equal(body.projects[0]?.commitsSinceRelease, null);
    assert.equal(body.projects[0]?.openIssues, null);
    assert.equal(body.projects[0]?.openPullRequests, null);
    assert.equal(body.cache?.countsUpdatedAt, null);
    assert.match(body.cache?.message ?? "", /release scan skipped/);
    assert.notEqual(body.projects[0]?.releaseName, "hydrated release cache");
    assert.equal(await env.DASHBOARD_CACHE.get("hot:index:v3"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses GitHub App installation token for cold owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-3";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  let appRestFallbacks = 0;
  const appReleasePageSizes: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      assert.equal(authorization, "Bearer installation-token");
      appRestFallbacks += 1;
      return Response.json([]);
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      if (!body.variables?.includeReleases) {
        return Response.json({ message: "upstream unavailable" }, { status: 502 });
      }
      if (body.variables?.includeReleases && body.variables.first) {
        appReleasePageSizes.push(body.variables.first);
      }
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4997",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, null);
    assert.equal(appRestFallbacks, 1);
    assert.deepEqual(appReleasePageSizes, [50]);
    assert.ok(
      await env.DASHBOARD_CACHE.get(
        "github:backoff:v2:graphql:app:openclaw:ReleaseBarOwnerRepos.metadata",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered source-owned app tokens for anonymous owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const auditLogs: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  console.log = (message?: unknown) => {
    if (typeof message === "string" && message.includes("github_token_use")) {
      auditLogs.push(JSON.parse(message));
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4998",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, 4998);
    assert.equal(
      auditLogs.some(
        (entry) =>
          (entry as { event?: string; quota?: { source?: string; account?: string } }).event ===
            "github_token_use" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.source === "app" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.account ===
            "openclaw",
      ),
      true,
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps stale source installation coverage when discovery fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
    "auth:installation-token:1": "installation-token",
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let discoveryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      discoveryCalls += 1;
      return Response.json({ message: "temporarily unavailable" }, { status: 503 });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(discoveryCalls, 1);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(await cache.get("auth:installation-miss:v1:openclaw"), null);
    assert.notEqual(await cache.get("auth:installation:v1:openclaw"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker discovers and stores source-owned app installs for anonymous dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const waits: Promise<unknown>[] = [];
  console.log = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "openclaw",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/openclaw",
          },
          html_url: "https://github.com/organizations/openclaw/settings/installations/7",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    const stored = JSON.parse((await cache.get("auth:installation:v1:openclaw")) ?? "{}");
    assert.equal(stored.id, 7);
    assert.equal(stored.repositorySelection, "all");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker saves owner public defaults and applies them to clean owner URLs", async () => {
  const sessionId = "session-profile";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/steipete") {
      return Response.json({ login: "steipete", type: "User" });
    }
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (path === "/users/steipete/repos") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo") {
      return Response.json({
        owner: { login: "openclaw" },
        name: "peekaboo",
        full_name: "openclaw/peekaboo",
        description: null,
        html_url: "https://github.com/openclaw/peekaboo",
        default_branch: "main",
        language: "Swift",
        stargazers_count: 5,
        forks_count: 0,
        open_issues_count: 0,
        archived: false,
        pushed_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        fork: false,
        private: false,
      });
    }
    if (path === "/repos/openclaw/peekaboo/releases") {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/openclaw/peekaboo/releases/tag/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (path === "/repos/openclaw/peekaboo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 2,
        html_url: "https://github.com/openclaw/peekaboo/compare/v1.0.0...main",
      });
    }
    if (path === "/repos/openclaw/peekaboo/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const save = await worker.fetch(
      new Request("https://release.bar/api/profile/steipete", {
        method: "POST",
        headers: {
          cookie: `rd_session=${authCookie}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          includeRepos: ["openclaw/peekaboo"],
          hiddenRepos: [],
        }),
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.deepEqual(saved.profile.includeRepos, ["openclaw/peekaboo"]);

    const response = await worker.fetch(new Request("https://release.bar/api/steipete"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    assert.equal(body.profile?.owner, "steipete");
    assert.equal(body.projects[0]?.fullName, "openclaw/peekaboo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only lets the dashboard owner save public defaults", async () => {
  const sessionId = "session-profile-forbidden";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
  };
  const response = await worker.fetch(
    new Request("https://release.bar/api/profile/steipete", {
      method: "POST",
      headers: {
        cookie: `rd_session=${authCookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ includeRepos: ["openclaw/peekaboo"] }),
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 403);
});

test("worker logout deletes the stored session and clears the cookie", async () => {
  const sessionId = "session-logout";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/logout?returnTo=/openclaw", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/openclaw");
  assert.match(response.headers.get("set-cookie") ?? "", /rd_session=;.*Max-Age=0/);
  assert.equal(await cache.get(`auth:session:${sessionId}`), null);
});

test("worker login returns 503 when GitHub App is not configured", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/login"),
    { DASHBOARD_CACHE: kvStore() },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 503);
});

test("worker admin scheduler requires an admin session and reports refresh targets", async () => {
  const sessionId = "session-admin";
  const otherSessionId = "session-admin-other";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const activeAt = new Date().toISOString();
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const otherAuthCookie = await signedJson("test-secret", { id: otherSessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const legacyTarget = { ...target, key: "dashboard:v5:owner=legacy", owner: "legacy" };
  const activeJob: RefreshJob = {
    id: "job-active",
    targetKey: target.key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: activeAt,
    updatedAt: activeAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const accessHour = new Date().toISOString().slice(0, 13);
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`auth:session:${otherSessionId}`]: JSON.stringify({
      user: {
        id: 2,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/2",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    [`refresh:target:v1:${legacyTarget.key}`]: JSON.stringify(legacyTarget),
    [`refresh:job:v1:${activeJob.id}`]: JSON.stringify(activeJob),
    "refresh:jobs:index:v1": JSON.stringify([activeJob.id]),
    [`github:access:v1:${accessHour}:dashboard:shared:_:graphql:200:graphql`]: JSON.stringify({
      area: "dashboard",
      route: "graphql",
      status: 200,
      source: "shared",
      account: null,
      resource: "graphql",
      count: 3,
      lastPath: "/graphql",
      lastAt: `${accessHour}:00:00.000Z`,
    }),
  });
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const anonymous = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler"),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(anonymous.status, 401);

  const nonAdmin = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${otherAuthCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(nonAdmin.status, 403);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as SchedulerAdminPayload;
  assert.equal(body.status.targets, 1);
  assert.equal(body.status.scannedTargets, 1);
  assert.equal(body.status.dueTargets, 0);
  assert.equal(body.status.queuedJobs, 1);
  assert.equal(body.targets[0]?.owner, "openclaw");
  assert.equal("githubAccess" in body, false);
  assert.equal("auth" in body, false);

  const access = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(access.status, 200);
  const accessBody = (await access.json()) as GitHubAccessSummary;
  assert.equal(accessBody.total, 3);
  assert.equal(accessBody.topRoutes[0]?.route, "graphql");

  const installations = await worker.fetch(
    new Request("https://release.bar/api/admin/installations", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(installations.status, 200);
  const installationBody = (await installations.json()) as AuthFunnelSummary;
  assert.equal(installationBody.installationCount, 0);
  assert.equal(installationBody.counterCount, 0);

  const run = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(run.status, 200);
  const runBody = (await run.json()) as { enqueued: number; due: number };
  assert.equal(runBody.enqueued, 0);
  assert.equal(runBody.due, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker admin installation summary bounds record and counter reads", async () => {
  const sessionId = "session-admin-installation-bounds";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const entries: Record<string, string> = {
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  };
  for (let index = 0; index < 121; index += 1) {
    const account = `account-${String(index).padStart(3, "0")}`;
    entries[`auth:installation:v1:${account}`] = JSON.stringify({
      id: index + 1,
      accountLogin: account,
      accountType: "user",
      accountUrl: `https://github.com/${account}`,
      avatarUrl: `https://avatars.githubusercontent.com/u/${index + 1}`,
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date(index * 1000).toISOString(),
    });
    entries[`auth:funnel-counter:v1:2026-06-13:event-${String(index).padStart(3, "0")}:_:ok`] =
      String(index + 1);
  }
  const baseCache = kvStore(entries);
  let installationReads = 0;
  let counterReads = 0;
  const cache = {
    ...baseCache,
    async get(key: string) {
      if (key.startsWith("auth:installation:v1:")) installationReads += 1;
      if (key.startsWith("auth:funnel-counter:v1:")) counterReads += 1;
      return baseCache.get(key);
    },
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/installations", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as AuthFunnelSummary;
  assert.equal(body.installationCount, 121);
  assert.equal(body.installations.length, 80);
  assert.equal(body.counterCount, 121);
  assert.equal(body.counts.length, 80);
  assert.equal(installationReads, 80);
  assert.equal(counterReads, 80);
});

test("worker scheduler rotates bounded current-schema target pages", async () => {
  const sessionId = "session-admin-pagination";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = new Date().toISOString();
  const entries: Record<string, string> = {
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  };
  for (let index = 0; index < 121; index += 1) {
    const owner = `page-${String(index).padStart(3, "0")}`;
    const key = `dashboard:v6:${owner}`;
    const target: RefreshTarget = {
      key,
      kind: "dashboard",
      indexVersion: 2,
      owner,
      owners: [],
      repos: [],
      includeReleaseData: false,
      path: `/${owner}`,
      priority: 60,
      lastSeenAt: now,
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextDueAt: "2999-01-01T00:00:00Z",
      failureCount: 0,
    };
    entries[`refresh:target:v1:${key}`] = JSON.stringify(target);
    entries[key] = JSON.stringify(testDashboard(owner, []));
  }
  entries["refresh:target:v1:dashboard:v5:obsolete"] = JSON.stringify({
    key: "dashboard:v5:obsolete",
    kind: "dashboard",
    owner: "obsolete",
    owners: [],
    repos: [],
    includeReleaseData: false,
    path: "/obsolete",
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  } satisfies RefreshTarget);
  const cache = kvStore(entries);
  const run = async () => {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { considered: number; due: number; enqueued: number };
  };

  assert.deepEqual(await run(), { ok: true, considered: 120, due: 0, enqueued: 0 });
  const firstState = JSON.parse((await cache.get("refresh:state:v1")) ?? "{}") as {
    targetCursor?: string;
  };
  assert.equal(firstState.targetCursor, "120");

  assert.deepEqual(await run(), { ok: true, considered: 1, due: 0, enqueued: 0 });
  const secondState = JSON.parse((await cache.get("refresh:state:v1")) ?? "{}") as {
    targetCursor?: string;
  };
  assert.equal(secondState.targetCursor, undefined);

  const admin = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );
  assert.equal(admin.status, 200);
  const adminBody = (await admin.json()) as SchedulerAdminPayload;
  assert.equal(adminBody.status.targets, 121);
  assert.equal(adminBody.status.scannedTargets, 1);
  assert.equal(adminBody.targets.length, 120);
});

test("worker queue skips jobs from obsolete dashboard schemas", async () => {
  const key = "dashboard:v5:owner=legacy";
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "legacy",
    owners: ["legacy"],
    repos: [],
    includeReleaseData: true,
    path: "/legacy",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: new Date().toISOString(),
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-obsolete-schema",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  let acked = false;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: job,
          ack() {
            acked = true;
          },
          retry() {
            throw new Error("obsolete jobs should not retry");
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );

  assert.equal(acked, true);
  const stored = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(stored.status, "skipped");
  assert.equal(stored.error, "obsolete dashboard schema");
});

test("worker admin installation sync removes stale registry entries", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:stale-org": JSON.stringify({
      id: 7,
      accountLogin: "stale-org",
      accountType: "org",
      accountUrl: "https://github.com/stale-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 11,
          account: {
            login: "fresh-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/fresh-org",
          },
          html_url: "https://github.com/organizations/fresh-org/settings/installations/11",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count?: number };
    assert.equal(body.count, 1);
    assert.equal(await cache.get("auth:installation:v1:stale-org"), null);
    const fresh = JSON.parse((await cache.get("auth:installation:v1:fresh-org")) ?? "{}");
    assert.equal(fresh.id, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps registry when GitHub listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:known-org": JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 400);
    assert.notEqual(await cache.get("auth:installation:v1:known-org"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps selected repos when repository listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-selected-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:known-org": JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "selected",
      repositories: ["known-org/releasebar"],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "known-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/7",
            html_url: "https://github.com/known-org",
          },
          html_url: "https://github.com/organizations/known-org/settings/installations/7",
          repository_selection: "selected",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/installation/repositories") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 400);
    const preserved = JSON.parse((await cache.get("auth:installation:v1:known-org")) ?? "{}");
    assert.deepEqual(preserved.repositories, ["known-org/releasebar"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin scheduler counts missing caches as due even before nextDueAt", async () => {
  const sessionId = "session-admin-due";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as SchedulerAdminPayload;
  assert.equal(body.status.dueTargets, 1);
});

test("worker admin scheduler respects transient failure retry delay", async () => {
  const sessionId = "session-admin-retry-delay";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=retrying",
    kind: "dashboard",
    owner: "retrying",
    owners: ["retrying"],
    repos: [],
    includeReleaseData: true,
    path: "/retrying",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 1,
    terminalBackoffUntil: null,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as SchedulerAdminPayload;
  assert.equal(body.status.dueTargets, 0);
});

test("worker scheduler skips shared cold targets while GraphQL is backed off", async () => {
  const sessionId = "session-admin-graphql-backoff";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=backedoff",
    kind: "dashboard",
    owner: "backedoff",
    owners: ["backedoff"],
    repos: [],
    includeReleaseData: true,
    path: "/backedoff",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker scheduler keeps repo-only targets runnable during RepoDetails backoff", async () => {
  const sessionId = "session-admin-repo-only-graphql-backoff";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:repo-only",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: ["acme/releasebar"],
    includeReleaseData: true,
    path: "/custom",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
  assert.equal(sentJobs[0]?.targetKey, target.key);
});

test("worker scheduler keeps dormant shared targets on weekly cadence after success", async () => {
  const sessionId = "session-admin-dormant-shared-cadence";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const key = dashboardCacheKey({
    owner: "sleepy",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const lastRefreshAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "sleepy",
    owners: ["sleepy"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: lastRefreshAt,
    lastSuccessAt: lastRefreshAt,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [key]: JSON.stringify(testDashboard("sleepy", [])),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker scheduler still rebuilds missing dormant shared caches", async () => {
  const sessionId = "session-admin-dormant-shared-missing";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=sleepy-missing",
    kind: "dashboard",
    owner: "sleepy-missing",
    owners: ["sleepy-missing"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy-missing",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    lastSuccessAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker scheduler preserves queued backlog jobs until reservation expiry", async () => {
  const sessionId = "session-admin-stale-queued";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=stale-queued",
    kind: "dashboard",
    owner: "stale-queued",
    owners: ["stale-queued"],
    repos: [],
    includeReleaseData: false,
    path: "/stale-queued",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const queuedJob: RefreshJob = {
    id: "queued-backlog-job",
    targetKey: target.key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    durationMs: null,
    error: "dashboard incomplete",
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    [`refresh:job:v1:${queuedJob.id}`]: JSON.stringify(queuedJob),
    "refresh:jobs:index:v1": JSON.stringify([queuedJob.id]),
  });
  const sentJobs: RefreshJob[] = [];

  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  const activeResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });
  assert.equal(activeResponse.status, 200);
  const activeBody = (await activeResponse.json()) as { due: number; enqueued: number };
  assert.equal(activeBody.due, 0);
  assert.equal(activeBody.enqueued, 0);
  assert.equal(sentJobs.length, 0);

  const expiredJob = {
    ...queuedJob,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  };
  await cache.put(`refresh:job:v1:${queuedJob.id}`, JSON.stringify(expiredJob));

  const expiredResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });

  assert.equal(expiredResponse.status, 200);
  const expiredBody = (await expiredResponse.json()) as { due: number; enqueued: number };
  assert.equal(expiredBody.due, 1);
  assert.equal(expiredBody.enqueued, 1);
  assert.equal(sentJobs.length, 1);
  assert.notEqual(sentJobs[0]?.id, queuedJob.id);
});

test("worker clears fallback reservations after active-job scans fail", async () => {
  const sessionId = "session-admin-reservation-scan-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-scan-failure",
    kind: "dashboard",
    owner: "reservation-scan-failure",
    owners: ["reservation-scan-failure"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-scan-failure",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const backingCache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  let refreshJobListCalls = 0;
  const cache = {
    ...backingCache,
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      if (options.prefix?.startsWith("refresh:job")) {
        refreshJobListCalls += 1;
      }
      if (refreshJobListCalls === 3) {
        throw new Error("active job scan failed");
      }
      return backingCache.list(options);
    },
  };
  const unavailableLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    DASHBOARD_LOCKS: unavailableLocks,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  await assert.rejects(
    worker.fetch(request(), env, { waitUntil: () => undefined }),
    /active job scan failed/,
  );
  assert.equal(sentJobs.length, 0);

  const response = await worker.fetch(request(), env, { waitUntil: () => undefined });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker scheduler falls back when the reservation Durable Object is unavailable", async () => {
  const sessionId = "session-admin-reservation-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-fallback",
    kind: "dashboard",
    owner: "reservation-fallback",
    owners: ["reservation-fallback"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-fallback",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];
  const unavailableLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: unavailableLocks,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker admin GitHub access ignores expired shared quota cooldowns", async () => {
  const sessionId = "session-admin-expired-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { active?: boolean } };
  assert.equal(body.cooldown?.active, false);
  assert.equal(await cache.get("github:budget:v1:shared:_"), null);
});

test("worker admin GitHub access keeps longest active shared quota cooldown", async () => {
  const sessionId = "session-admin-longest-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 10,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "shorter",
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "3000-01-01T00:00:00.000Z",
      reason: "longer",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { resource?: string | null } };
  assert.equal(body.cooldown?.resource, "graphql");
});

test("worker admin scheduler defers shared quota paused targets even with missing cache", async () => {
  const sessionId = "session-admin-shared-quota-defer";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker admin scheduler lets app-token targets bypass shared quota pauses", async () => {
  const sessionId = "session-admin-shared-quota-app-bypass";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler uses app registry coverage without minting tokens", async () => {
  const sessionId = "session-admin-shared-quota-app-registry";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler bypasses shared quota defer time with app coverage", async () => {
  const sessionId = "session-admin-shared-quota-app-stale";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: "2026-05-15T13:00:00Z",
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker scheduler marks jobs failed when queue delivery fails", async () => {
  const sessionId = "session-admin-queue-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  await assert.rejects(
    worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send() {
            throw new Error("queue unavailable");
          },
        },
      },
      { waitUntil: () => undefined },
    ),
    /queue unavailable/,
  );

  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  assert.equal(indexedJobs.keys.length, 1);
  const indexed = JSON.parse(
    (await cache.get(indexedJobs.keys[0]?.name ?? "")) ?? "{}",
  ) as RefreshJob;
  const stored = JSON.parse(
    (await cache.get(`refresh:job:v1:${indexed.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.match(stored.error ?? "", /queue unavailable/);
});

test("worker refresh jobs can use shared quota when no source app token exists", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer shared-token");
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "succeeded");
  const auditEvents = await refreshAuditEvents(cache);
  assert.equal(
    auditEvents.some((event) => event.event === "job_start"),
    true,
  );
  assert.equal(
    auditEvents.some((event) => event.event === "dashboard_build_start"),
    true,
  );
  const buildDone = auditEvents.find((event) => event.event === "dashboard_build_done");
  assert.equal(buildDone?.status, "fresh");
  assert.equal(buildDone?.projects, 0);
  assert.deepEqual(paths, ["/users/openclaw", "/graphql"]);
});

test("worker refresh jobs preserve profile filters from the queued target snapshot", async () => {
  const key = dashboardCacheKey({
    owner: "profiled",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const profile = {
    owner: "profiled",
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: ["profiled/secret"],
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: "profiled",
  };
  const profileSnapshotKey = `refresh:profile-snapshot:v1:profiled:${encodeURIComponent(
    profile.updatedAt,
  )}`;
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "profiled",
    owners: ["profiled"],
    repos: [],
    profileSnapshotKey,
    includeReleaseData: false,
    path: "/profiled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const targetSnapshotKey = `refresh:jobs:v2:${String(
    Number.MAX_SAFE_INTEGER - Date.parse("2026-06-11T07:00:00Z"),
  ).padStart(16, "0")}:job-profile-snapshot`;
  const job: RefreshJob = {
    id: "job-profile-snapshot",
    targetKey: key,
    target,
    targetSnapshotKey,
    kind: "dashboard",
    status: "queued",
    reason: "cold-metadata",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const latestLastSeenAt = "2026-06-11T07:30:00Z";
  const latestPath = "/profiled?sort=prs&dir=desc";
  const backingCache = kvStore({
    [targetSnapshotKey]: JSON.stringify(job),
    [profileSnapshotKey]: JSON.stringify(profile),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  let mutableJobWrites = 0;
  const cache = {
    ...backingCache,
    async put(storageKey: string, value: string) {
      if (storageKey === `refresh:job:v1:${job.id}`) {
        mutableJobWrites += 1;
      }
      await backingCache.put(storageKey, value);
    },
  };
  const originalFetch = globalThis.fetch;
  let releaseOwnerFetch: (() => void) | undefined;
  const ownerFetchGate = new Promise<void>((resolve) => {
    releaseOwnerFetch = resolve;
  });
  let markOwnerFetchStarted: (() => void) | undefined;
  const ownerFetchStarted = new Promise<void>((resolve) => {
    markOwnerFetchStarted = resolve;
  });
  const repo = (name: string) => ({
    owner: { login: "profiled" },
    name,
    full_name: `profiled/${name}`,
    description: null,
    html_url: `https://github.com/profiled/${name}`,
    default_branch: "main",
    language: "TypeScript",
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  });
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/profiled") {
        await cache.put(
          `refresh:target:v1:${key}`,
          JSON.stringify({
            ...target,
            lastSeenAt: latestLastSeenAt,
            path: latestPath,
          }),
        );
        markOwnerFetchStarted?.();
        await ownerFetchGate;
        return Response.json({ login: "profiled", type: "User" });
      }
      if (url.pathname === "/users/profiled/repos") {
        return Response.json([repo("visible"), repo("secret")]);
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    };

    const processing = (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: { ...job, target: undefined },
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("profile snapshot job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    await ownerFetchStarted;
    const deliveries = await cache.list({ prefix: "refresh:job-deliveries:v1:" });
    assert.equal(deliveries.keys.length, 1);
    const running = JSON.parse(
      (await cache.get(deliveries.keys[0]?.name ?? "")) ?? "{}",
    ) as RefreshJob;
    assert.equal(running.status, "running");
    assert.notEqual(running.startedAt, null);
    releaseOwnerFetch?.();
    await processing;
  } finally {
    releaseOwnerFetch?.();
    globalThis.fetch = originalFetch;
  }

  assert.equal(acked, true);
  assert.equal(mutableJobWrites, 1);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  assert.deepEqual(dashboard.profile, profile);
  assert.deepEqual(
    dashboard.projects.map((project) => project.fullName),
    ["profiled/visible"],
  );
  const updatedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(updatedTarget.lastSeenAt, latestLastSeenAt);
  assert.equal(updatedTarget.path, latestPath);
});

test("worker retries refresh jobs when the dashboard build lock is busy", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-locked",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  let acked = false;
  let retryDelaySeconds: number | undefined;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: job,
          ack() {
            acked = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: busyLocks },
    { waitUntil: () => undefined },
  );

  assert.equal(acked, false);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.startedAt, null);
  assert.equal(updated.finishedAt, null);
  assert.equal(updated.durationMs, null);
  assert.equal(updated.error, "dashboard locked");
});

test("worker stops and retries stalled progressive dashboard scans", async () => {
  const key = dashboardCacheKey({
    owner: "stalled",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const projects = Array.from({ length: 100 }, (_, index) =>
    testProject({
      owner: "stalled",
      name: `repo-${String(index + 1).padStart(3, "0")}`,
    }),
  );
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "stalled",
    owners: ["stalled"],
    repos: [],
    includeReleaseData: true,
    path: "/stalled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-stalled",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const dashboard = {
    ...testDashboard("stalled", projects),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 100, limit: 200, done: false },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: projects.map((project) => project.fullName.toLowerCase()),
      projects,
      updatedAt: "2026-06-11T07:00:00Z",
    }),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const repoRows = projects.map((project) => ({
    owner: { login: "stalled" },
    name: project.name,
    full_name: project.fullName,
    description: null,
    html_url: project.url,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  }));
  const originalFetch = globalThis.fetch;
  let repoPages = 0;
  let retryDelaySeconds: number | undefined;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/stalled/repos") {
        repoPages += 1;
        return Response.json(repoRows);
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("stalled job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(repoPages, 2);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard stalled");
});

test("worker aborts Queue hydration at the delivery deadline", async () => {
  const key = dashboardCacheKey({
    owner: "deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "deadline",
    owners: ["deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cached = {
    ...testDashboard("deadline", []),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 0, limit: 200, done: false },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let aborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/deadline/repos") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(aborted, true);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard deadline reached");
  assert.equal(updated.finishedAt, null);
});

test("worker aborts Queue GitHub App token lookup at the delivery deadline", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = dashboardCacheKey({
    owner: "credential-deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "credential-deadline",
    owners: ["credential-deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/credential-deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-credential-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let credentialAborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app/installations") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          credentialAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            credentialAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("credential deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(credentialAborted, true);
  assert.equal(retryDelaySeconds, 60);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "queued");
  assert.equal(updated.error, "dashboard deadline reached");
});

test("worker terminalizes exhausted refresh retries before dead-lettering", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-lock-exhausted",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const backingCache = kvStore({
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  let jobWrites = 0;
  const cache = {
    ...backingCache,
    async put(storageKey: string, value: string) {
      if (storageKey === `refresh:job:v1:${job.id}`) {
        jobWrites += 1;
      }
      await backingCache.put(storageKey, value);
    },
  };
  let released = false;
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  let retryDelaySeconds: number | undefined;

  const deliver = async (attempts: number) =>
    (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            attempts,
            ack() {
              throw new Error("exhausted job should be retried into the DLQ");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: busyLocks },
      { waitUntil: () => undefined },
    );

  await deliver(9);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, false);
  const retrying = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(retrying.status, "queued");
  assert.equal(retrying.error, "dashboard locked");

  await deliver(10);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, false);
  const finalRetry = JSON.parse(
    (await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(finalRetry.status, "queued");
  assert.equal(finalRetry.error, "dashboard locked");

  await deliver(11);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "failed");
  assert.match(updated.error ?? "", /after 11 Queue attempts/);
  assert.equal(updated.attempts, 11);
  assert.equal(jobWrites, 3);

  const failedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${target.key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(failedTarget.failureCount, 1);
  assert.equal(Date.parse(failedTarget.nextDueAt) > Date.now(), true);
  assert.equal(failedTarget.terminalBackoffUntil, failedTarget.nextDueAt);
  assert.match(failedTarget.message ?? "", /after 11 Queue attempts/);

  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  globalThis.fetch = async (input) => {
    throw new Error(`backed-off dashboard should not fetch ${String(input)}`);
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(staleResponse.status, 200);
    await Promise.all(waits.splice(0));
    assert.equal(sentJobs.length, 0);

    await cache.delete(key);
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(coldResponse.status, 202);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    assert.equal(coldBody.cache?.state, "rebuilding");
    assert.match(coldBody.cache?.message ?? "", /refresh paused after repeated failures/);
    await Promise.all(waits);
    assert.equal(sentJobs.length, 0);

    await cache.put(
      `refresh:target:v1:${target.key}`,
      JSON.stringify({ ...failedTarget, terminalBackoffUntil: null }),
    );
    await cache.put(
      key,
      JSON.stringify(testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })])),
    );
    const transientFailureResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(transientFailureResponse.status, 200);
    await Promise.all(waits.splice(0));
    assert.equal(sentJobs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker terminalizes final-delivery queue handler failures", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-handler-failure",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const backingCache = kvStore();
  let failJobRead = true;
  const cache = {
    ...backingCache,
    async get(key: string) {
      if (key === `refresh:job:v1:${job.id}` && failJobRead) {
        failJobRead = false;
        throw new Error("refresh job read failed");
      }
      return backingCache.get(key);
    },
  };
  let released = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  let retryDelaySeconds: number | undefined;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
            attempts?: number;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: job,
          attempts: 11,
          ack() {
            throw new Error("failed handler should not acknowledge");
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(retryDelaySeconds, 300);
  assert.equal(released, true);
  const stored = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.equal(stored.attempts, 11);
  assert.match(stored.error ?? "", /refresh job read failed/);
});

test("worker refresh jobs defer shared work while shared quota is paused", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared-paused",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 42,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "remaining 42 <= 500",
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("shared quota pause should skip GitHub fetches");
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "skipped");
  assert.match(updated.error ?? "", /remaining 42/);
  const storedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.match(storedTarget.message ?? "", /shared GitHub quota paused/);
});

test("worker refresh jobs defer shared work while GraphQL is backed off", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared-graphql-paused",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("GraphQL backoff should skip GitHub fetches");
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "skipped");
  assert.match(updated.error ?? "", /GraphQL temporarily paused/);
  const storedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(storedTarget.failureCount, 0);
  assert.match(storedTarget.message ?? "", /GitHub GraphQL paused/);
});

test("worker skips request-triggered progressive rebuilds while shared quota is paused", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 42,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "remaining 42 <= 500",
    }),
  });
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("shared quota pause should skip progressive GitHub fetches");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(waits.length > 0, true);
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_progressive_skip"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cached dashboards to crawlers without scheduling refreshes", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const dashboard: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    generatedAt: "2026-05-15T12:00:00Z",
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: 200,
    },
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: "2026-05-15T12:00:00Z",
      progress: {
        scanned: 1,
        limit: 200,
        done: false,
      },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
  });
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  let installationListCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([
        {
          id: 7,
          account: {
            login: "owner",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/7",
            html_url: "https://github.com/owner",
          },
          html_url: "https://github.com/settings/installations/7",
          repository_selection: "all",
          target_type: "User",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "installation-token" });
    }
    throw new Error(`crawler should not refresh dashboard ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/owner", "AhrefsBot/7.0", null),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_refresh_schedule"),
      false,
    );
    assert.equal(installationListCalls, 0);
    assert.equal(await cache.get(`refresh:target:v1:${key}`), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cache-only cold dashboard status to crawlers", async () => {
  const key = dashboardCacheKey({
    owner: "coldbot",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const baseCache = kvStore({
    "auth:installation:v1:coldbot": JSON.stringify({
      id: 42,
      accountLogin: "coldbot",
      accountType: "org",
      accountUrl: "https://github.com/coldbot",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  let installationTokenReads = 0;
  const cache = {
    ...baseCache,
    async get(key: string) {
      if (key.startsWith("auth:installation-token:")) installationTokenReads += 1;
      return baseCache.get(key);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler cold dashboard should not call GitHub ${String(input)}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/coldbot", "Googlebot/2.1", null),
      { DASHBOARD_CACHE: cache, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "invalid" },
      {
        waitUntil: (promise) => waits.push(promise),
      },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(body.cache?.message, "cached dashboard unavailable for crawler");
    assert.equal(await cache.get(key), null);
    assert.equal(installationTokenReads, 0);
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_refresh_schedule"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not pause shared quota for ordinary forbidden responses", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "Resource not accessible by integration" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "core",
        },
      },
    );
  try {
    await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await cache.get("github:budget:v1:shared:_"), null);
    assert.equal(await cache.get("github:budget:v1:shared:core"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safeReturnTo accepts the current request origin, including workers.dev", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const ctx = { waitUntil: () => undefined };

  const workersDevLogin = await worker.fetch(
    new Request(
      "https://releasedeck-api.steipete.workers.dev/api/auth/login?returnTo=https%3A%2F%2Freleasedeck-api.steipete.workers.dev%2Fopenclaw",
    ),
    env,
    ctx,
  );
  assert.equal(workersDevLogin.status, 302);
  assert.match(
    workersDevLogin.headers.get("location") ?? "",
    /redirect_uri=https%3A%2F%2Freleasedeck-api.steipete.workers.dev%2Fapi%2Fauth%2Fcallback/,
  );

  const evilOriginLogout = await worker.fetch(
    new Request(
      "https://release.bar/api/auth/logout?returnTo=https%3A%2F%2Fevil.example.com%2Fattack",
    ),
    env,
    ctx,
  );
  assert.equal(evilOriginLogout.headers.get("location"), "/");
});

test("worker refreshes stale installation coverage before using its cached token", async () => {
  const sessionId = "session-token-cache";
  const accountLogin = "cacheorg";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
      [`auth:installation:v1:${accountLogin}`]: JSON.stringify({
        id: 1,
        accountLogin,
        accountType: "org",
        accountUrl: `https://github.com/${accountLogin}`,
        avatarUrl: "https://avatars.githubusercontent.com/u/2",
        repositorySelection: "all",
        repositories: [],
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
      "auth:installation-token:1": "installation-token",
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_APP_SLUG: "releasebar-app",
    REFRESH_QUEUE: { send: async () => undefined },
  };
  const originalFetch = globalThis.fetch;
  let tokenMintCalled = false;
  let userInstallationsCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      userInstallationsCalls += 1;
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: accountLogin,
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: `https://github.com/${accountLogin}`,
            },
            html_url: `https://github.com/organizations/${accountLogin}/settings/installations/1`,
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      tokenMintCalled = true;
      throw new Error("cached installation token should be reused");
    }
    if (url.pathname === `/users/${accountLogin}`) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer installation-token");
      return Response.json({ login: accountLogin, type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number };
      };
      assert.equal(body.variables?.first, 25);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (url.pathname === `/orgs/${accountLogin}/repos`) {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const headers = { cookie: `rd_session=${authCookie}` };
    const waits: Array<Promise<unknown>> = [];
    const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
    const first = await worker.fetch(
      new Request(`https://release.bar/api/${accountLogin}`, { headers }),
      env,
      context,
    );
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    await Promise.all(waits);
    assert.equal(tokenMintCalled, false);
    assert.equal(userInstallationsCalls, 1);

    const second = await worker.fetch(
      new Request(`https://release.bar/api/${accountLogin}`, { headers }),
      env,
      context,
    );
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    await Promise.all(waits);
    assert.equal(userInstallationsCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("query options are explicit booleans", () => {
  assert.deepEqual(optionsFromSearch("?forks=true&archived=false&unreleased=true"), {
    includeForks: true,
    includeArchived: false,
    includeUnreleased: true,
  });
  assert.deepEqual(optionsFromSearch("?unreleased=false"), {
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
  });
  assert.equal(optionsFromSearch("").includeUnreleased, true);
});

test("build option normalization preserves config includeUnreleased", () => {
  const options = normalizeBuildOptions({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
  });

  assert.equal(options.includeUnreleased, true);
  assert.equal(
    normalizeBuildOptions({ ...options, includeUnreleased: undefined }).includeUnreleased,
    false,
  );
});

test("cache keys include owner, schema, and visibility flags", () => {
  assert.equal(
    dashboardCacheKey({
      owner: "@OpenClaw",
      includeForks: true,
      includeArchived: false,
      includeUnreleased: true,
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:forks-noarchived-unreleased-release",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:noforks-noarchived-released-release:sources-2dgec2fqc87xi",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      includeReleaseData: false,
      schemaVersion: 6,
    }),
    "dashboard:v6:openclaw:noforks-noarchived-released-metadata",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: Array.from({ length: 50 }, (_, index) => `owner-${index}`),
      repos: Array.from({ length: 50 }, (_, index) => `owner-${index}/repo-${index}`),
    }).length < 512,
    true,
  );
});

test("owner slugs match public GitHub login rules", () => {
  assert.equal(validOwnerSlug("steipete"), true);
  assert.equal(validOwnerSlug("openclaw"), true);
  assert.equal(validOwnerSlug("-bad"), false);
  assert.equal(validOwnerSlug("bad-"), false);
  assert.equal(validOwnerSlug("bad_owner"), false);
  assert.equal(validRepoSlug("steipete/oracle"), true);
  assert.equal(validRepoSlug("bad_owner/oracle"), false);
});

test("owner resolution keeps GitHub profile identity", async () => {
  const owner = await resolveOwnerType("OpenClaw", {
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/users/openclaw");
      return Response.json({
        login: "OpenClaw",
        type: "Organization",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
        html_url: "https://github.com/openclaw",
      });
    },
  });

  assert.deepEqual(owner, {
    type: "org",
    login: "OpenClaw",
    avatarUrl: "https://avatars.githubusercontent.com/u/123",
    url: "https://github.com/openclaw",
  });
});

test("repo filtering respects forks, archived repos, private repos, and excludes", () => {
  const repo = {
    full_name: "owner/repo",
    fork: false,
    archived: false,
    private: false,
  };
  assert.equal(filterRepo(repo, { includeForks: false, includeArchived: false }), true);
  assert.equal(
    filterRepo({ ...repo, fork: true }, { includeForks: false, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, archived: true }, { includeForks: true, includeArchived: false }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, private: true }, { includeForks: true, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo(repo, {
      includeForks: true,
      includeArchived: true,
      excludeRepos: ["owner/repo"],
    }),
    false,
  );
});

test("freshness buckets remain compatible with existing dashboard semantics", () => {
  const project = { commitsSinceRelease: null };
  assert.equal(freshness(project), "hot");
  assert.equal(freshness({ ...project, commitsSinceRelease: 0 }), "fresh");
  assert.equal(freshness({ ...project, commitsSinceRelease: 5 }), "warm");
  assert.equal(freshness({ ...project, commitsSinceRelease: 25 }), "busy");
  assert.equal(freshness({ ...project, commitsSinceRelease: 26 }), "hot");
});

test("dashboard build skips empty unreleased repositories without failing", async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "empty",
          full_name: "owner/empty",
          description: null,
          html_url: "https://github.com/owner/empty",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        },
      ]);
    }
    if (path === "/repos/owner/empty/releases") {
      return Response.json([]);
    }
    if (path === "/repos/owner/empty/commits/main") {
      return new Response("empty repository", { status: 409 });
    }
    throw new Error(`unexpected ${path}`);
  };

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    fetch: fetcher,
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build partitions GitHub App quota by owner", async () => {
  const authorizations = new Map<string, string | null>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/graphql");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      variables?: { login?: string };
    };
    const login = body.variables?.login ?? "";
    authorizations.set(login, new Headers(init?.headers).get("authorization"));
    return Response.json(
      {
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
      {
        headers: {
          "x-ratelimit-resource": "graphql",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": login === "alpha" ? "4200" : "3900",
        },
      },
    );
  };

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [
      { type: "org", login: "alpha" },
      { type: "org", login: "beta" },
    ],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    fetch: fetcher,
    token: "shared-token",
    quotaSource: "shared",
    ownerCredentials: {
      alpha: {
        token: "alpha-token",
        quotaSource: "app",
        quotaAccount: "alpha",
      },
      beta: {
        token: "beta-token",
        quotaSource: "app",
        quotaAccount: "beta",
      },
    },
  });

  assert.deepEqual(Object.fromEntries(authorizations), {
    alpha: "Bearer alpha-token",
    beta: "Bearer beta-token",
  });
  assert.equal(payload.cache?.quota?.source, "app");
  assert.equal(payload.cache?.quota?.account, null);
  assert.equal(payload.cache?.quota?.remaining, 3900);
});

test("dashboard build keeps empty included repositories without check-run calls", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(path);
      if (path === "/users/owner/repos") {
        return Response.json([
          {
            owner: { login: "owner" },
            name: "empty",
            full_name: "owner/empty",
            description: null,
            html_url: "https://github.com/owner/empty",
            default_branch: "main",
            language: null,
            stargazers_count: 0,
            forks_count: 0,
            open_issues_count: 0,
            archived: false,
            pushed_at: null,
            updated_at: null,
            fork: false,
            private: false,
          },
        ]);
      }
      if (path === "/repos/owner/empty/releases") {
        return Response.json([]);
      }
      if (path === "/repos/owner/empty/commits/main") {
        return Response.json(
          { message: "Git Repository is empty.", status: "409" },
          { status: 409 },
        );
      }
      if (path === "/repos/owner/empty/pulls") {
        return Response.json([]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.version, "unreleased");
  assert.equal(payload.projects[0]?.ciState, "unknown");
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
});

test("dashboard build treats empty successful GitHub JSON as no data", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeRepos: ["other/repo"],
    includeForks: false,
    includeArchived: false,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/other/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path === "/repos/other/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/other/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/other/repo/compare/v1.0.0...main",
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return new Response("", { status: 200 });
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openPullRequests, 0);
});

test("dashboard build falls back when GraphQL returns an empty success body", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") return new Response("", { status: 200 });
      if (path === "/users/owner/repos") return Response.json([]);
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build treats ignored 403 check-run rate limits as quota errors", async () => {
  await assert.rejects(
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json([
            {
              owner: { login: "owner" },
              name: "repo",
              full_name: "owner/repo",
              description: null,
              html_url: "https://github.com/owner/repo",
              default_branch: "main",
              language: null,
              stargazers_count: 0,
              forks_count: 0,
              open_issues_count: 0,
              archived: false,
              pushed_at: null,
              updated_at: null,
              fork: false,
              private: false,
            },
          ]);
        }
        if (path === "/repos/owner/repo/releases") {
          return Response.json([
            {
              tag_name: "v1.0.0",
              name: null,
              html_url: "https://github.com/owner/repo/releases/v1.0.0",
              draft: false,
              published_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        if (path === "/repos/owner/repo/commits/main") {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/pulls") {
          return Response.json([]);
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          return Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
              },
            },
          );
        }
        throw new Error(`unexpected ${path}`);
      },
    }),
    GitHubRateLimitError,
  );
});

test("dashboard build can add explicit public repositories without an owner scan", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/repo"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/other/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path === "/repos/other/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/other/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/other/repo/compare/v1.0.0...main",
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return Response.json([]);
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.fullName, "other/repo");
});

test("dashboard metadata splits explicit repository issue and PR counts", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    includeRepos: ["other/repo"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 7,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return Response.json([{}], {
          headers: {
            link: '<https://api.github.com/repos/other/repo/pulls?state=open&per_page=1&page=3>; rel="last"',
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.deepEqual(requested, ["/repos/other/repo", "/repos/other/repo/pulls"]);
});

test("dashboard metadata splits authenticated REST owner issue and PR counts", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 1,
    repoScanLimit: 0,
    repoScanTarget: 1,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return new Response(null, { status: 500 });
      }
      if (path === "/users/owner/repos") {
        return Response.json([
          {
            owner: { login: "owner" },
            name: "repo",
            full_name: "owner/repo",
            description: null,
            html_url: "https://github.com/owner/repo",
            default_branch: "main",
            language: null,
            stargazers_count: 1,
            forks_count: 0,
            open_issues_count: 7,
            archived: false,
            pushed_at: null,
            updated_at: null,
            fork: false,
            private: false,
          },
        ]);
      }
      if (path === "/repos/owner/repo/pulls") {
        return Response.json([{}], {
          headers: {
            link: '<https://api.github.com/repos/owner/repo/pulls?state=open&per_page=1&page=3>; rel="last"',
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.cache?.capped, false);
  assert.deepEqual(requested, ["/graphql", "/users/owner/repos", "/repos/owner/repo/pulls"]);
});

test("dashboard REST hydration only splits counts for the hydrated batch", async () => {
  const requested: string[] = [];
  const repos = ["one", "two", "three"].map((name) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 7,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  }));
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 3,
    repoScanLimit: 1,
    repoScanTarget: 3,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return new Response(null, { status: 500 });
      }
      if (path === "/users/owner/repos") {
        return Response.json(repos);
      }
      if (path === "/repos/owner/one/releases") {
        return Response.json([]);
      }
      if (path === "/repos/owner/one/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/one/pulls") {
        return Response.json([{}]);
      }
      if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    requested.filter((path) => path.endsWith("/pulls")),
    ["/repos/owner/one/pulls"],
  );
  assert.equal(payload.projects.find((project) => project.name === "one")?.openIssues, 6);
  assert.equal(payload.projects.find((project) => project.name === "one")?.openPullRequests, 1);
  assert.equal(payload.projects.find((project) => project.name === "two")?.openIssues, null);
  assert.equal(
    payload.projects.find((project) => project.name === "three")?.openPullRequests,
    null,
  );
});

test("dashboard build uses GraphQL owner metadata when token is available", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 2,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                          {
                            __typename: "CheckRun",
                            name: "lint",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/2",
                            completedAt: "2026-01-03T00:11:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    owner: { login: "owner", __typename: "User" },
                    name: "repo",
                    nameWithOwner: "owner/repo",
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
                    isArchived: false,
                    isFork: false,
                    isPrivate: false,
                    pushedAt: "2026-01-03T00:00:00Z",
                    updatedAt: "2026-01-03T00:00:00Z",
                    releases: {
                      nodes: [
                        {
                          tagName: "v2.0.0-alpha.1",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v2.0.0-alpha.1",
                          isDraft: false,
                          publishedAt: "2026-01-04T00:00:00Z",
                        },
                        {
                          tagName: "v1.0.0",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                          isDraft: false,
                          publishedAt: "2026-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/repo/compare/v2.0.0-alpha.1...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v2.0.0-alpha.1...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openIssues, 7);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.projects[0]?.version, "v2.0.0-alpha.1");
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "2/2 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/releases")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/pulls")),
    false,
  );
});

test("dashboard released-only build uses GraphQL detail hydration for CI", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    owner: { login: "owner", __typename: "User" },
                    name: "repo",
                    nameWithOwner: "owner/repo",
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
                    isArchived: false,
                    isFork: false,
                    isPrivate: false,
                    pushedAt: "2026-01-03T00:00:00Z",
                    updatedAt: "2026-01-03T00:00:00Z",
                    releases: {
                      nodes: [
                        {
                          tagName: "v1.0.0",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                          isDraft: false,
                          publishedAt: "2026-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.version, "v1.0.0");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "1/1 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
});

test("dashboard build emits owner metadata before release hydration", async () => {
  const progress: Awaited<ReturnType<typeof buildDashboard>>[] = [];
  const requested: string[] = [];
  const repoNode = (name: string, issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name,
    nameWithOwner: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: `2026-01-0${issues}T00:00:00Z`,
    updatedAt: `2026-01-0${issues}T00:00:00Z`,
    releases: { nodes: [] },
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 3,
    repoScanLimit: 1,
    repoScanTarget: 3,
    hydrateSort: "prs",
    hydrateDirection: "desc",
    token: "token",
    previousReleasesUpdatedAt: "2026-01-01T00:00:00Z",
    previousCiUpdatedAt: "2026-01-02T00:00:00Z",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [repoNode("three", 3, 0), repoNode("one", 5, 2), repoNode("two", 4, 1)],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/one/commits/main") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-04T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (partial) => {
      progress.push(partial);
    },
  });

  assert.equal(progress[0]?.projects.length, 3);
  assert.deepEqual(
    progress[0]?.projects.map((project) => [
      project.name,
      project.openIssues,
      project.openPullRequests,
      project.version,
    ]),
    [
      ["one", 5, 2, "repo search"],
      ["two", 4, 1, "repo search"],
      ["three", 3, 0, "repo search"],
    ],
  );
  assert.equal(progress[0]?.cache?.progress?.scanned, 0);
  assert.equal(payload.cache?.countsUpdatedAt, progress[0]?.cache?.countsUpdatedAt);
  assert.equal(progress[0]?.cache?.releasesUpdatedAt, "2026-01-01T00:00:00Z");
  assert.equal(progress[0]?.cache?.ciUpdatedAt, "2026-01-02T00:00:00Z");
  assert.equal(requested.includes("/repos/owner/one/commits/main"), true);
  assert.equal(requested.includes("/repos/owner/three/commits/main"), false);
  assert.equal(payload.cache?.state, "partial");
  assert.equal(payload.cache?.releasesUpdatedAt, "2026-01-01T00:00:00Z");
  assert.equal(payload.cache?.ciUpdatedAt, "2026-01-02T00:00:00Z");
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two", "three"],
  );
});

test("partial owner scans do not advance count freshness without current coverage", async () => {
  const previousCountsUpdatedAt = "2026-06-11T01:00:00Z";
  const initialProjects = [
    testProject({ owner: "partial-counts", name: "one", openIssues: 1, openPullRequests: 1 }),
    testProject({ owner: "partial-counts", name: "two", openIssues: 2, openPullRequests: 2 }),
  ];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "partial-counts" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 3,
    repoScanLimit: 0,
    repoScanTarget: 3,
    ownerPageLimit: 1,
    initialProjects,
    token: "token",
    previousCountsUpdatedAt,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      assert.equal(path, "/graphql");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                {
                  owner: { login: "partial-counts", __typename: "User" },
                  name: "one",
                  nameWithOwner: "partial-counts/one",
                  description: null,
                  url: "https://github.com/partial-counts/one",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: null,
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 0,
                  forkCount: 0,
                  issues: { totalCount: 9 },
                  pullRequests: { totalCount: 4 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T03:00:00Z",
                  updatedAt: "2026-06-11T03:00:00Z",
                  releases: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    },
  });

  assert.equal(payload.cache?.state, "partial");
  assert.equal(payload.projects.find((project) => project.name === "one")?.openIssues, 9);
  assert.equal(payload.projects.find((project) => project.name === "two")?.openIssues, 2);
  assert.equal(payload.cache?.countsUpdatedAt, previousCountsUpdatedAt);
});

test("multi-page count scans keep their first-request observation time", async () => {
  let page = 0;
  let secondRequestStartedAt = 0;
  const repoNode = (name: string) => ({
    owner: { login: "count-clock", __typename: "User" },
    name,
    nameWithOwner: `count-clock/${name}`,
    description: null,
    url: `https://github.com/count-clock/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: 1 },
    pullRequests: { totalCount: 0 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T03:00:00Z",
    updatedAt: "2026-06-11T03:00:00Z",
    releases: { nodes: [] },
  });
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "count-clock" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 0,
    ownerPageSize: 1,
    token: "token",
    fetch: async (url) => {
      assert.equal(new URL(String(url)).pathname, "/graphql");
      page += 1;
      if (page === 2) secondRequestStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: {
                hasNextPage: page === 1,
                endCursor: page === 1 ? "next" : null,
              },
              nodes: [repoNode(page === 1 ? "one" : "two")],
            },
          },
        },
      });
    },
  });

  assert.equal(payload.projects.length, 2);
  assert.ok(secondRequestStartedAt > 0);
  assert.ok(Date.parse(payload.cache?.countsUpdatedAt ?? "") < secondRequestStartedAt);
});

test("metadata-only released-only builds preserve count freshness without fetching", async () => {
  const previousCountsUpdatedAt = "2026-06-11T01:00:00Z";
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "released-only" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    includeReleaseData: false,
    previousCountsUpdatedAt,
    fetch: async () => {
      throw new Error("released-only metadata build should not fetch");
    },
  });

  assert.deepEqual(payload.projects, []);
  assert.equal(payload.cache?.countsUpdatedAt, previousCountsUpdatedAt);
});

test("dashboard cached hydration keeps fresh owner issue and PR totals", async () => {
  const cache = kvStore();
  let openIssues = 1;
  let openPullRequests = 1;
  const repoNode = () => ({
    owner: { login: "owner", __typename: "User" },
    name: "one",
    nameWithOwner: "owner/one",
    description: null,
    url: "https://github.com/owner/one",
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: openIssues },
    pullRequests: { totalCount: openPullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    releases: { nodes: [] },
  });
  const fetch: typeof globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode()],
            },
          },
        },
      });
    }
    if (path === "/repos/owner/one/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-01-02T00:00:00Z" } },
      });
    }
    if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const options = {
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user" as const, login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    repoScanLimit: 1,
    repoScanTarget: 1,
    token: "token",
    projectCache: cache,
    fetch,
  };

  await buildDashboard(options);
  openIssues = 8;
  openPullRequests = 5;
  const payload = await buildDashboard(options);

  assert.equal(payload.projects[0]?.openIssues, 8);
  assert.equal(payload.projects[0]?.openPullRequests, 5);
});

test("dashboard build reuses cached repo fragments when metadata is unchanged", async () => {
  const backingCache = kvStore();
  const writtenKeys: string[] = [];
  const cache = {
    ...backingCache,
    async put(key: string, value: string) {
      writtenKeys.push(key);
      await backingCache.put(key, value);
    },
  };
  let fanoutCalls = 0;
  const build = () =>
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 1,
      token: "token",
      projectCache: cache,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/graphql") {
          return Response.json({
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      owner: { login: "owner", __typename: "User" },
                      name: "repo",
                      nameWithOwner: "owner/repo",
                      description: null,
                      url: "https://github.com/owner/repo",
                      defaultBranchRef: { name: "main" },
                      primaryLanguage: null,
                      stargazerCount: 1,
                      forkCount: 0,
                      issues: { totalCount: 0 },
                      pullRequests: { totalCount: 0 },
                      isArchived: false,
                      isFork: false,
                      isPrivate: false,
                      pushedAt: "2026-01-03T00:00:00Z",
                      updatedAt: "2026-01-03T00:00:00Z",
                      releases: {
                        nodes: [
                          {
                            tagName: "v1.0.0",
                            name: null,
                            url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                            isDraft: false,
                            publishedAt: "2026-01-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          });
        }
        if (path === "/repos/owner/repo/commits/main") {
          fanoutCalls += 1;
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-03T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          fanoutCalls += 1;
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          fanoutCalls += 1;
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build()).totals.repos, 1);
  assert.equal((await build()).totals.repos, 1);
  assert.equal(fanoutCalls, 3);
  assert.equal(
    writtenKeys.some((key) => key.startsWith("repo:v2:owner/repo:")),
    true,
  );
});

test("dashboard build ignores explicit private repositories", async () => {
  let releaseFetched = false;
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/private"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/private") {
        return Response.json({
          owner: { login: "other" },
          name: "private",
          full_name: "other/private",
          description: null,
          html_url: "https://github.com/other/private",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: true,
        });
      }
      if (path === "/repos/other/private/releases") {
        releaseFetched = true;
        return Response.json([]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
  assert.equal(releaseFetched, false);
});

test("dashboard cache cap only marks omitted repos as capped", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const build = (repos: unknown[]) =>
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 2,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json(repos);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
          return Response.json([
            {
              tag_name: "v1.0.0",
              name: null,
              html_url: "https://github.com/owner/repo/releases/v1.0.0",
              draft: false,
              published_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path.includes("/compare/")) {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare",
          });
        }
        if (path.endsWith("/pulls")) {
          return Response.json([]);
        }
        if (path.endsWith("/check-runs")) {
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build([repo("one"), repo("two")])).cache?.capped, false);
  assert.equal((await build([repo("one"), repo("two"), repo("three")])).cache?.capped, true);
});

test("explicit repositories survive capped owner scan trimming", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["owner/three"],
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      if (path === "/repos/owner/three") {
        return Response.json(repo("three"));
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/three"),
    true,
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies after visibility filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("fork", { fork: true }),
          repo("archived", { archived: true }),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies per owner for custom dashboards", async () => {
  const repo = (owner: string, name: string) => ({
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    description: null,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [
      { type: "user", login: "owner" },
      { type: "org", login: "other" },
    ],
    includeForks: false,
    includeArchived: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("owner", "one"), repo("owner", "two"), repo("owner", "three")]);
      }
      if (path === "/orgs/other/repos") {
        return Response.json([
          repo("other", "alpha"),
          repo("other", "beta"),
          repo("other", "gamma"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const fullNames = payload.projects.map((project) => project.fullName);
  assert.equal(payload.totals.repos, 4);
  assert.equal(fullNames.includes("owner/one"), true);
  assert.equal(fullNames.includes("owner/two"), true);
  assert.equal(fullNames.includes("owner/three"), false);
  assert.equal(fullNames.includes("other/alpha"), true);
  assert.equal(fullNames.includes("other/beta"), true);
  assert.equal(fullNames.includes("other/gamma"), false);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies to visible rows before release hydration", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: name === "empty-a" ? 3 : 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const released = new Set(["one", "two", "three"]);

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("empty-a"),
          repo("empty-b"),
          repo("empty-c"),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      const name = path.split("/")[3];
      if (path.endsWith("/releases")) {
        return Response.json(
          released.has(name)
            ? [
                {
                  tag_name: "v1.0.0",
                  name: null,
                  html_url: "https://github.com/owner/repo/releases/v1.0.0",
                  draft: false,
                  published_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json(name === "empty-a" ? [{}] : []);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({
          check_runs:
            name === "empty-a"
              ? [
                  {
                    name: "ci",
                    status: "completed",
                    conclusion: "success",
                    html_url: "https://github.com/owner/empty-a/actions/runs/1",
                    completed_at: "2026-01-02T00:00:00Z",
                    started_at: "2026-01-02T00:00:00Z",
                  },
                ]
              : [],
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["unreleased", "unreleased"],
  );
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.openIssues, 2);
  assert.equal(payload.projects[0]?.openPullRequests, 1);
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.cache?.capped, true);
});

test("dashboard hydration advances across a metadata-seeded 200-repo cap", async () => {
  const repos = Array.from({ length: 200 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return {
      owner: { login: "owner" },
      name,
      full_name: `owner/${name}`,
      description: null,
      html_url: `https://github.com/owner/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: index === 150 ? 99 : 0,
      open_issues_total: index === 150 ? 99 : 0,
      open_pull_requests_total: 0,
      archived: false,
      pushed_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      fork: false,
      private: false,
    };
  });
  const fetcher: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === "/users/owner/repos") {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return Response.json(repos.slice((page - 1) * 100, page * 100));
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/owner/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-01-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/owner/repo/compare",
      });
    }
    if (path.endsWith("/pulls")) {
      return Response.json([]);
    }
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const baseOptions = {
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user" as const, login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 200,
    repoScanTarget: 200,
    hydrateSort: "issues" as const,
    hydrateDirection: "desc" as const,
    fetch: fetcher,
  };
  const metadata = await buildDashboard({
    ...baseOptions,
    includeReleaseData: false,
    repoScanLimit: 0,
  });
  assert.equal(metadata.projects.length, 200);

  const firstScanned: string[] = [];
  const first = await buildDashboard({
    ...baseOptions,
    includeReleaseData: true,
    repoScanLimit: 12,
    initialProjects: metadata.projects,
    onProgress: async (_payload, progress) => {
      if (progress.scannedRepo) firstScanned.push(progress.scannedRepo);
    },
  });
  assert.equal(firstScanned.length, 12);
  assert.equal(firstScanned[0], "owner/repo-151");
  assert.equal(first.cache?.progress?.scanned, 12);
  assert.equal(first.cache?.progress?.done, false);

  const secondScanned: string[] = [];
  const second = await buildDashboard({
    ...baseOptions,
    includeReleaseData: true,
    repoScanLimit: 12,
    initialProjects: first.projects,
    skipRepos: firstScanned,
    onProgress: async (_payload, progress) => {
      if (progress.scannedRepo) secondScanned.push(progress.scannedRepo);
    },
  });
  assert.equal(secondScanned.length, 12);
  assert.equal(
    secondScanned.some((repo) => firstScanned.includes(repo)),
    false,
  );
  assert.equal(second.cache?.progress?.scanned, 24);
  assert.equal(second.cache?.progress?.done, false);
});

test("dashboard hydration reconciles new repositories into a cached 200-repo set", async () => {
  const repo = (name: string, pushedAt: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: pushedAt,
    updated_at: pushedAt,
    fork: false,
    private: false,
  });
  const oldRepos = Array.from({ length: 200 }, (_, index) =>
    repo(
      `repo-${String(index + 1).padStart(3, "0")}`,
      new Date(Date.UTC(2026, 0, 1) + (200 - index) * 1000).toISOString(),
    ),
  );
  const liveRepos = [repo("repo-new", "2026-06-11T07:00:00Z"), ...oldRepos.slice(0, 199)];
  const initialProjects = oldRepos.map((item) =>
    testProject({
      owner: item.owner.login,
      name: item.name,
      pushedAt: item.pushed_at,
      updatedAt: item.updated_at,
      latestCommitDate: item.updated_at,
    }),
  );
  const scanned: string[] = [];
  const removed: string[] = [];
  const absent: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 200,
    initialProjects,
    skipRepos: oldRepos.map((item) => item.full_name),
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        const page = Number(parsed.searchParams.get("page") ?? "1");
        return Response.json(liveRepos.slice((page - 1) * 100, page * 100));
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (_partial, progress) => {
      if (progress.scannedRepo) scanned.push(progress.scannedRepo);
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.equal(payload.projects.length, 200);
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-new"),
    true,
  );
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-200"),
    false,
  );
  assert.deepEqual(scanned, ["owner/repo-new"]);
  assert.deepEqual(removed, ["owner/repo-200"]);
  assert.deepEqual(absent, []);
  assert.equal(payload.cache?.progress?.scanned, 200);
  assert.equal(payload.cache?.progress?.done, true);
});

test("dashboard hydration removes vanished repositories after complete owner enumeration", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T07:00:00Z",
    updated_at: "2026-06-11T07:00:00Z",
    fork: false,
    private: false,
  });
  const initialProjects = ["keep", "old-name"].map((name) =>
    testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    }),
  );
  const removed: string[] = [];
  const absent: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 2,
    initialProjects,
    skipRepos: ["owner/keep", "owner/old-name"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("keep"), repo("new-name")]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (_partial, progress) => {
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.deepEqual(payload.projects.map((project) => project.fullName).sort(), [
    "owner/keep",
    "owner/new-name",
  ]);
  assert.deepEqual(removed, ["owner/old-name"]);
  assert.deepEqual(absent, ["owner/old-name"]);
  assert.equal(payload.cache?.progress?.scanned, 2);
  assert.equal(payload.cache?.progress?.done, true);
});

test("dashboard filtering does not report archived repositories as absent", async () => {
  const previousReleasesUpdatedAt = "2026-06-10T05:00:00Z";
  const previousCiUpdatedAt = "2026-06-10T06:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    archived: false,
    pushedAt: "2026-06-10T07:00:00Z",
    updatedAt: "2026-06-10T07:00:00Z",
  });
  const removed: string[] = [];
  const absent: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 1,
    initialProjects: [project],
    skipRepos: [project.fullName],
    previousReleasesUpdatedAt,
    previousCiUpdatedAt,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          {
            owner: { login: "owner" },
            name: "repo",
            full_name: "owner/repo",
            description: null,
            html_url: "https://github.com/owner/repo",
            default_branch: "main",
            language: null,
            stargazers_count: 0,
            forks_count: 0,
            open_issues_count: 0,
            archived: true,
            pushed_at: "2026-06-11T07:00:00Z",
            updated_at: "2026-06-11T07:00:00Z",
            fork: false,
            private: false,
          },
        ]);
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (_partial, progress) => {
      removed.push(...(progress.removedRepos ?? []));
      absent.push(...(progress.absentRepos ?? []));
    },
  });

  assert.deepEqual(payload.projects, []);
  assert.deepEqual(removed, ["owner/repo"]);
  assert.deepEqual(absent, []);
  assert.equal(payload.cache?.releasesUpdatedAt, previousReleasesUpdatedAt);
  assert.equal(payload.cache?.ciUpdatedAt, previousCiUpdatedAt);
});

test("dashboard reconciliation preserves live repositories later on a short page", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T07:00:00Z",
    updated_at: "2026-06-11T07:00:00Z",
    fork: false,
    private: false,
  });
  const initialProjects = Array.from({ length: 200 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    });
  });
  const liveRepos = Array.from({ length: 20 }, (_, index) =>
    repo(`repo-${String(index + 1).padStart(3, "0")}`),
  );
  const removed = new Set<string>();
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 12,
    repoScanTarget: 200,
    initialProjects,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json(liveRepos);
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (_partial, progress) => {
      for (const fullName of progress.removedRepos ?? []) {
        removed.add(fullName);
      }
    },
  });

  assert.equal(payload.projects.length, 20);
  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/repo-020"),
    true,
  );
  assert.equal(removed.size, 180);
  assert.equal(payload.cache?.progress?.scanned, 12);
  assert.equal(payload.cache?.progress?.done, false);
});

test("dashboard reconciliation follows GraphQL pagination when a page contains null nodes", async () => {
  const repoNode = (name: string) => ({
    owner: { login: "owner", __typename: "User" },
    name,
    nameWithOwner: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: 0 },
    pullRequests: { totalCount: 0 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    releases: { nodes: [] },
  });
  const initialProjects = ["keep", "later"].map((name) =>
    testProject({
      owner: "owner",
      name,
      pushedAt: "2026-06-10T07:00:00Z",
      updatedAt: "2026-06-10T07:00:00Z",
      latestCommitDate: "2026-06-10T07:00:00Z",
    }),
  );
  let graphqlPages = 0;

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: true,
    repoLimit: 200,
    repoScanLimit: 0,
    repoScanTarget: 2,
    initialProjects,
    skipRepos: ["owner/keep", "owner/later"],
    token: "token",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/graphql") {
        throw new Error(`unexpected ${path}`);
      }
      graphqlPages += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const after = body.variables?.after;
      const finalPage = after === "page-3";
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: finalPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: after === "page-2" ? "page-3" : "page-2" },
              nodes: finalPage ? [repoNode("keep"), repoNode("later")] : [null],
            },
          },
        },
      });
    },
  });

  assert.equal(graphqlPages, 3);
  assert.deepEqual(payload.projects.map((project) => project.fullName).sort(), [
    "owner/keep",
    "owner/later",
  ]);
});

test("dashboard metadata scan follows GraphQL pagination past all-null pages", async () => {
  const repoNode = {
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: null,
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: 4 },
    pullRequests: { totalCount: 2 },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    releases: { nodes: [] },
  };
  let graphqlPages = 0;

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/graphql") {
        throw new Error(`unexpected ${path}`);
      }
      graphqlPages += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const after = body.variables?.after;
      const finalPage = after === "page-3";
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: finalPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: after === "page-2" ? "page-3" : "page-2" },
              nodes: finalPage ? [repoNode] : [null],
            },
          },
        },
      });
    },
  });

  assert.equal(graphqlPages, 3);
  assert.equal(payload.projects[0]?.fullName, "owner/repo");
  assert.equal(payload.projects[0]?.openIssues, 4);
  assert.equal(payload.projects[0]?.openPullRequests, 2);
});

test("dashboard released-only repo cap scans past unreleased repositories", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const released = new Set(["one", "two", "three"]);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("empty-a"),
          repo("empty-b"),
          repo("empty-c"),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      const name = path.split("/")[3];
      if (path.endsWith("/releases")) {
        return Response.json(
          released.has(name)
            ? [
                {
                  tag_name: "v1.0.0",
                  name: null,
                  html_url: `https://github.com/owner/${name}/releases/v1.0.0`,
                  draft: false,
                  published_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.totals.unreleased, 0);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap stops giant owners after recent repos", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const releaseFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("empty-a"), repo("empty-b"), repo("released")]);
      }
      if (path.endsWith("/releases")) {
        releaseFetches.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(releaseFetches, ["empty-a", "empty-b"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 2 recently pushed repos/);
});

test("dashboard metadata-only mode skips release hydration", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const unexpectedHydrationFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      unexpectedHydrationFetches.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(unexpectedHydrationFetches, []);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["repo search", "repo search"],
  );
  assert.equal(payload.projects[0]?.commitsSinceRelease, null);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard metadata-only released-only mode keeps released-only semantics", async () => {
  const fetchedPaths: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      fetchedPaths.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(fetchedPaths, []);
  assert.deepEqual(payload.projects, []);
  assert.equal(payload.totals.repos, 0);
  assert.equal(payload.totals.unreleased, 0);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard shared owner page cap finishes as fresh capped data", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    quotaSource: "shared",
    repoLimit: 400,
    repoScanLimit: 0,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        const page = parsed.searchParams.get("page") ?? "";
        pages.push(page);
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`page-${page}-${index}`)),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1", "2", "3"]);
  assert.equal(payload.cache?.state, "fresh");
  assert.equal(payload.cache?.progress?.done, undefined);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap marks full page boundary truncation as capped", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const pages: string[] = [];
  const pageSizes: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 100,
    repoScanLimit: 100,
    ownerPageSize: 200,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        pageSizes.push(parsed.searchParams.get("per_page") ?? "");
        return Response.json(Array.from({ length: 100 }, (_, index) => repo(`empty-${index}`)));
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1"]);
  assert.deepEqual(pageSizes, ["100"]);
  assert.equal(payload.totals.repos, 100);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 100 recently pushed repos/);
});

test("dashboard resume stops paging when visible cap is already scanned", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const project = (
    name: string,
  ): Awaited<ReturnType<typeof buildDashboard>>["projects"][number] => ({
    owner: "owner",
    name,
    fullName: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 0,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/owner/${name}/issues`,
    pullRequestsUrl: `https://github.com/owner/${name}/pulls`,
    archived: false,
    pushedAt: null,
    updatedAt: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `https://github.com/owner/${name}/releases`,
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
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    repoScanTarget: 2,
    initialProjects: [project("one"), project("two")],
    skipRepos: ["owner/one", "owner/two"],
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.progress?.done, true);
});

test("dashboard repo cap keeps paginating until eligible repos survive filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    repoLimit: 1,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      const page = parsed.searchParams.get("page");
      if (path === "/users/owner/repos" && page === "1") {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`fork-${index}`, { fork: true })),
        );
      }
      if (path === "/users/owner/repos" && page === "2") {
        return Response.json([repo("one"), repo("two")]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one"],
  );
  assert.equal(payload.cache?.capped, true);
});

test("owner count refresh uses the lean GraphQL shape", async () => {
  let query = "";
  const result = await fetchOwnerRepoCounts({
    owner: "owner",
    token: "token",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query?: string };
      query = body.query ?? "";
      return Response.json({
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  nameWithOwner: "owner/repo",
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T01:00:00Z",
                },
              ],
            },
          },
        },
      });
    },
  });

  assert.match(query, /query ReleaseBarOwnerCounts/);
  assert.doesNotMatch(query, /repositoryTopics|releases|statusCheckRollup/);
  assert.equal(result.complete, true);
  assert.deepEqual(result.repos[0], {
    fullName: "owner/repo",
    openIssues: 7,
    openPullRequests: 3,
    archived: false,
    fork: false,
    private: false,
    pushedAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T01:00:00Z",
  });

  const truncated = await fetchOwnerRepoCounts({
    owner: "owner",
    token: "token",
    limit: 1,
    fetch: async () =>
      Response.json({
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                {
                  nameWithOwner: "owner/repo",
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T01:00:00Z",
                },
              ],
            },
          },
        },
      }),
  });
  assert.equal(truncated.complete, false);
});

test("worker serves fresh dashboard cache before GitHub App token discovery", async () => {
  const now = new Date().toISOString();
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const metadataKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cachedProject = { ...project, archived: true };
  const removedProject = testProject({ owner: "owner", name: "removed", openIssues: 4 });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [cachedProject, removedProject]),
    generatedAt: now,
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: now,
      countsUpdatedAt: now,
      releasesUpdatedAt: now,
      ciUpdatedAt: now,
    },
  };
  const staleMetadataAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const freshCountsAt = new Date(Date.now() + 1_000).toISOString();
  const ownerSnapshot = {
    owner: "owner",
    generatedAt: staleMetadataAt,
    metadataUpdatedAt: staleMetadataAt,
    countsUpdatedAt: freshCountsAt,
    knownRepos: [project.fullName.toLowerCase()],
    projects: [{ ...project, description: "stale description", archived: false, openIssues: 9 }],
  };
  const cache = kvStore({
    [metadataKey]: JSON.stringify(cached),
    "owner-metadata:v1:owner": JSON.stringify(ownerSnapshot),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fresh cache should not discover or mint GitHub App tokens");
  };
  try {
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]?.openIssues, 9);
    assert.equal(body.projects[0]?.description, project.description);
    await Promise.all(waits);
    const metadataTarget = JSON.parse(
      (await cache.get(`refresh:target:v1:${metadataKey}`)) ?? "{}",
    ) as RefreshTarget;
    assert.equal(metadataTarget.key, metadataKey);
    assert.equal(metadataTarget.includeReleaseData, false);
    assert.equal(await cache.get(`refresh:target:v1:${releaseKey}`), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner metadata does not overwrite newer dashboard counts", async () => {
  const now = new Date().toISOString();
  const newerMetadataAt = new Date(Date.now() + 1_000).toISOString();
  const staleCountsAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [project]),
    generatedAt: now,
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: now,
      countsUpdatedAt: now,
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: newerMetadataAt,
      metadataUpdatedAt: newerMetadataAt,
      countsUpdatedAt: staleCountsAt,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      projects: [{ ...project, description: "new metadata", openIssues: 9 }],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects[0]?.description, "new metadata");
  assert.equal(body.projects[0]?.openIssues, 1);
  assert.equal(body.cache?.countsUpdatedAt, now);
});

test("owner metadata compares count snapshots against count freshness", async () => {
  const countsAt = "2026-06-11T01:00:00Z";
  const snapshotAt = "2026-06-11T02:00:00Z";
  const generatedAt = "2026-06-11T03:00:00Z";
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [project]),
      generatedAt,
      cache: {
        state: "partial",
        stale: true,
        capped: false,
        repoLimit: 200,
        generatedAt,
        countsUpdatedAt: countsAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: snapshotAt,
      metadataUpdatedAt: snapshotAt,
      countsUpdatedAt: snapshotAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": snapshotAt },
      projectCountsUpdatedAt: { "owner/repo": snapshotAt },
      projects: [{ ...project, openIssues: 9 }],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects[0]?.openIssues, 9);
  assert.equal(body.cache?.countsUpdatedAt, snapshotAt);
  assert.equal(body.cache?.projectCountsUpdatedAt?.["owner/repo"], snapshotAt);
});

test("owner count overlays update repositories absent from a narrow metadata snapshot", async () => {
  const cachedAt = new Date(Date.now() - 60_000).toISOString();
  const observedAt = new Date().toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cachedProject = testProject({
    owner: "owner",
    name: "outside-filter",
    archived: false,
    openIssues: 1,
  });
  const narrowProject = testProject({ owner: "owner", name: "inside-filter" });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [cachedProject]),
      generatedAt: cachedAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: cachedAt,
        countsUpdatedAt: cachedAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: cachedAt,
      metadataUpdatedAt: cachedAt,
      countsUpdatedAt: cachedAt,
      releaseDataComplete: true,
      knownRepos: null,
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/inside-filter": cachedAt },
      projectCountsUpdatedAt: { "owner/inside-filter": cachedAt },
      projects: [narrowProject],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = locks;
  const response = await locks.get(locks.idFromName("owner-metadata:owner")).fetch(
    new Request("https://releasebar.internal/owner-metadata/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "owner",
        mutation: {
          kind: "counts",
          updatedAt: observedAt,
          complete: true,
          counts: [
            {
              fullName: "owner/inside-filter",
              openIssues: 0,
              openPullRequests: 0,
              archived: false,
              fork: false,
              private: false,
              pushedAt: observedAt,
              updatedAt: observedAt,
            },
            {
              fullName: "owner/outside-filter",
              openIssues: 9,
              openPullRequests: 2,
              archived: true,
              fork: false,
              private: false,
              pushedAt: observedAt,
              updatedAt: observedAt,
            },
          ],
        },
      }),
    }),
  );
  assert.equal(response.ok, true);

  const dashboard = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  assert.equal(dashboard.status, 200);
  assert.equal(((await dashboard.json()) as DashboardPayload).projects.length, 0);
  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    countOverlays?: Record<string, { archived?: boolean; openIssues?: number }>;
  };
  assert.equal(snapshot.countOverlays?.["owner/outside-filter"]?.archived, true);
  assert.equal(snapshot.countOverlays?.["owner/outside-filter"]?.openIssues, 9);
});

test("owner snapshots only advance count freshness when they cover every displayed repository", async () => {
  const cachedAt = "2026-06-11T03:00:00Z";
  const snapshotAt = "2026-06-11T04:00:00Z";
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: cachedAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: cachedAt,
        countsUpdatedAt: cachedAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: snapshotAt,
      metadataUpdatedAt: cachedAt,
      countsUpdatedAt: snapshotAt,
      releaseDataComplete: true,
      knownRepos: null,
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": cachedAt },
      projects: [{ ...repo, openIssues: 9 }],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects.find((project) => project.name === "repo")?.openIssues, 9);
  assert.equal(body.projects.find((project) => project.name === "sibling")?.openIssues, 2);
  assert.equal(body.cache?.countsUpdatedAt, cachedAt);
});

test("partial owner count scans expose matched repository counts without advancing global freshness", async () => {
  const initialAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const dashboardAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const partialAt = new Date().toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: dashboardAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: dashboardAt,
        countsUpdatedAt: initialAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo", "owner/sibling"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projectCountsUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projects: [repo, sibling],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutation = await stub.fetch(
    new Request("https://releasebar.internal/owner-metadata/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "owner",
        mutation: {
          kind: "counts",
          updatedAt: partialAt,
          complete: false,
          counts: [
            {
              fullName: "owner/repo",
              openIssues: 9,
              openPullRequests: 3,
              archived: false,
              fork: false,
              private: false,
              pushedAt: partialAt,
              updatedAt: partialAt,
            },
          ],
        },
      }),
    }),
  );
  assert.equal(mutation.ok, true);

  const snapshot = (await mutation.json()) as {
    countsUpdatedAt?: string;
    projectCountsUpdatedAt?: Record<string, string>;
  };
  assert.equal(snapshot.countsUpdatedAt, initialAt);
  assert.equal(snapshot.projectCountsUpdatedAt?.["owner/repo"], partialAt);
  assert.equal(snapshot.projectCountsUpdatedAt?.["owner/sibling"], initialAt);

  const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects.find((project) => project.name === "repo")?.openIssues, 9);
  assert.equal(body.projects.find((project) => project.name === "sibling")?.openIssues, 2);
  assert.equal(body.cache?.countsUpdatedAt, initialAt);
});

test("stale archive observations do not override newer count observations", async () => {
  const metadataAt = "2026-06-11T01:00:00Z";
  const archiveAt = "2026-06-11T02:00:00Z";
  const countsAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo", archived: false });
  const cache = kvStore({
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: countsAt,
      metadataUpdatedAt: metadataAt,
      countsUpdatedAt: countsAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": metadataAt },
      projectCountsUpdatedAt: { "owner/repo": countsAt },
      projects: [project],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  const stub = locks.get(locks.idFromName("owner-metadata:owner"));
  const response = await stub.fetch(
    new Request("https://releasebar.internal/owner-metadata/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "owner",
        mutation: {
          kind: "visibility",
          fullName: "owner/repo",
          archived: true,
          observedAt: archiveAt,
          repositoryUpdatedAt: archiveAt,
        },
      }),
    }),
  );
  assert.equal(response.ok, true);
  const snapshot = (await response.json()) as { projects?: Project[] };
  assert.equal(snapshot.projects?.[0]?.archived, false);
});

test("partial owner count scans cannot make an incomplete repository set authoritative", async () => {
  const initialAt = "2026-06-11T01:00:00Z";
  const partialAt = "2026-06-11T02:00:00Z";
  const repo = testProject({ owner: "owner", name: "repo" });
  const newlyDiscovered = testProject({ owner: "owner", name: "new" });
  const cache = kvStore({
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/new": initialAt,
      },
      projectCountsUpdatedAt: {
        "owner/repo": initialAt,
        "owner/new": initialAt,
      },
      projects: [repo, newlyDiscovered],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const response = await stub.fetch(
    new Request("https://releasebar.internal/owner-metadata/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "owner",
        mutation: {
          kind: "counts",
          updatedAt: partialAt,
          complete: false,
          counts: [repo, newlyDiscovered].map((project) => ({
            fullName: project.fullName,
            openIssues: 1,
            openPullRequests: 0,
            archived: false,
            fork: false,
            private: false,
            pushedAt: partialAt,
            updatedAt: partialAt,
          })),
        },
      }),
    }),
  );
  assert.equal(response.ok, true);
  const snapshot = (await response.json()) as {
    countsUpdatedAt?: string;
    countsAttemptedAt?: string;
    knownRepos?: string[];
  };
  assert.equal(snapshot.countsUpdatedAt, initialAt);
  assert.equal(snapshot.countsAttemptedAt, partialAt);
  assert.deepEqual(snapshot.knownRepos, ["owner/repo"]);
});

test("combined dashboards do not merge counts using another owner's oldest timestamp", async () => {
  const generatedAt = new Date().toISOString();
  const oldestOwnerCountAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const intermediateCountAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    owners: ["other"],
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const ownerProject = testProject({ owner: "owner", name: "repo", openIssues: 10 });
  const otherProject = testProject({ owner: "other", name: "repo", openIssues: 2 });
  const cache = kvStore({
    "owner:v1:owner": JSON.stringify({ type: "user", login: "owner" }),
    "owner:v1:other": JSON.stringify({ type: "user", login: "other" }),
    [key]: JSON.stringify({
      ...testDashboard("owner", [ownerProject, otherProject]),
      generatedAt,
      owners: [
        { type: "user", login: "owner" },
        { type: "user", login: "other" },
      ],
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt,
        countsUpdatedAt: oldestOwnerCountAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: intermediateCountAt,
      metadataUpdatedAt: intermediateCountAt,
      countsUpdatedAt: intermediateCountAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": intermediateCountAt },
      projects: [{ ...ownerProject, openIssues: 3 }],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner?owners=other"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects.find((project) => project.fullName === "owner/repo")?.openIssues, 10);
  assert.equal(body.cache?.countsUpdatedAt, oldestOwnerCountAt);
});

test("older owner snapshots do not overwrite newer dashboard fields", async () => {
  const now = new Date().toISOString();
  const olderAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [project]),
      generatedAt: now,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: now,
        countsUpdatedAt: now,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: olderAt,
      metadataUpdatedAt: olderAt,
      countsUpdatedAt: olderAt,
      releaseDataComplete: true,
      knownRepos: [],
      projects: [
        {
          ...project,
          description: "older metadata",
          archived: true,
          openIssues: 9,
        },
      ],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0]?.description, project.description);
  assert.equal(body.projects[0]?.archived, false);
  assert.equal(body.projects[0]?.openIssues, 1);
});

test("targeted owner metadata updates do not refresh sibling repositories", async () => {
  const dashboardAt = new Date().toISOString();
  const olderAt = new Date(Date.parse(dashboardAt) - 60 * 60 * 1000).toISOString();
  const eventAt = new Date(Date.parse(dashboardAt) + 1_000).toISOString();
  const repo = testProject({ owner: "owner", name: "repo" });
  const sibling = testProject({ owner: "owner", name: "sibling", description: "fresh sibling" });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: dashboardAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: dashboardAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: eventAt,
      metadataUpdatedAt: eventAt,
      countsUpdatedAt: olderAt,
      releaseDataComplete: true,
      projectMetadataUpdatedAt: {
        "owner/repo": eventAt,
        "owner/sibling": olderAt,
      },
      projects: [
        { ...repo, archived: true },
        { ...sibling, description: "stale sibling" },
      ],
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(
    body.projects.some((project) => project.fullName === "owner/repo"),
    false,
  );
  assert.equal(
    body.projects.find((project) => project.fullName === "owner/sibling")?.description,
    "fresh sibling",
  );
});

test("owner removal tombstones survive older refresh observations", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const olderAt = "2026-06-11T02:00:00Z";
  const newerAt = "2026-06-11T04:00:00Z";
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({ kind: "remove", fullName: "owner/repo", observedAt: removedAt });
  await mutate({
    kind: "counts",
    updatedAt: olderAt,
    complete: true,
    counts: [
      {
        fullName: "owner/repo",
        openIssues: 1,
        openPullRequests: 0,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
    ],
  });
  await mutate({ kind: "restore", fullName: "owner/repo", observedAt: olderAt });
  let snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
  };
  assert.equal(snapshot.removedRepos?.["owner/repo"], removedAt);

  await mutate({ kind: "restore", fullName: "owner/repo", observedAt: newerAt });
  snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
  };
  assert.equal(snapshot.removedRepos?.["owner/repo"], undefined);
});

test("owner mutations reconcile newer KV fallback state before updating durable storage", async () => {
  const initialAt = "2026-06-11T01:00:00Z";
  const removedAt = "2026-06-11T02:00:00Z";
  const followUpAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
    return response;
  };

  await mutate({
    kind: "merge",
    generatedAt: initialAt,
    observedAt: initialAt,
    countsUpdatedAt: initialAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  const fallbackSnapshot = JSON.parse(
    (await cache.get("owner-metadata:v1:owner")) ?? "{}",
  ) as Record<string, unknown>;
  await cache.put(
    "owner-metadata:v1:owner",
    JSON.stringify({
      ...fallbackSnapshot,
      generatedAt: removedAt,
      metadataUpdatedAt: removedAt,
      knownRepos: [],
      removedRepos: { "owner/repo": removedAt },
      projectMetadataUpdatedAt: { "owner/repo": removedAt },
      projects: [],
    }),
  );

  const response = await mutate({
    kind: "counts",
    updatedAt: followUpAt,
    complete: false,
    counts: [],
  });
  const snapshot = (await response.json()) as {
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  assert.equal(snapshot.removedRepos?.["owner/repo"], removedAt);
  assert.equal(
    snapshot.projects?.some((candidate) => candidate.fullName === project.fullName),
    false,
  );
});

test("older owner count refreshes cannot replace newer snapshots", async () => {
  const metadataAt = "2026-06-11T02:00:00Z";
  const olderAt = "2026-06-11T03:00:00Z";
  const newerAt = "2026-06-11T04:00:00Z";
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: metadataAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [repo, sibling],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: newerAt,
    complete: true,
    counts: [
      {
        fullName: repo.fullName,
        openIssues: 7,
        openPullRequests: 3,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
      {
        fullName: sibling.fullName,
        openIssues: 9,
        openPullRequests: 4,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
    ],
  });
  await mutate({
    kind: "counts",
    updatedAt: olderAt,
    complete: true,
    counts: [
      {
        fullName: repo.fullName,
        openIssues: 5,
        openPullRequests: 2,
        archived: false,
        fork: false,
        private: false,
        pushedAt: olderAt,
        updatedAt: olderAt,
      },
    ],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    countsUpdatedAt?: string;
    knownRepos?: string[];
    projects?: Project[];
  };
  assert.equal(snapshot.countsUpdatedAt, newerAt);
  assert.deepEqual(snapshot.knownRepos?.sort(), ["owner/repo", "owner/sibling"]);
  assert.equal(
    snapshot.projects?.find((project) => project.fullName === repo.fullName)?.openIssues,
    7,
  );
  assert.equal(
    snapshot.projects?.find((project) => project.fullName === sibling.fullName)?.openIssues,
    9,
  );
});

test("older complete count scans preserve newer repository metadata", async () => {
  const countsAt = "2026-06-11T03:00:00Z";
  const metadataAt = "2026-06-11T04:00:00Z";
  const project = testProject({ owner: "owner", name: "repo", updatedAt: metadataAt });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: "2026-06-11T02:00:00Z",
    countsComplete: false,
    releaseDataComplete: false,
    mode: "metadata",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: countsAt,
    complete: true,
    counts: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  assert.deepEqual(snapshot.knownRepos, ["owner/repo"]);
  assert.equal(snapshot.removedRepos?.["owner/repo"], undefined);
  assert.equal(snapshot.projects?.[0]?.fullName, "owner/repo");
});

test("newer metadata merges preserve counts without restoring stale repository state", async () => {
  const countsAt = "2026-06-11T03:00:00Z";
  const metadataAt = "2026-06-11T04:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    archived: false,
    openIssues: 7,
    openPullRequests: 3,
    pushedAt: countsAt,
    updatedAt: countsAt,
  });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: countsAt,
    observedAt: countsAt,
    countsUpdatedAt: countsAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: null,
    countsComplete: false,
    releaseDataComplete: false,
    mode: "metadata",
    projects: [
      {
        ...project,
        archived: true,
        openIssues: null,
        openPullRequests: null,
        pushedAt: metadataAt,
        updatedAt: metadataAt,
      },
    ],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    projects?: Project[];
  };
  assert.equal(snapshot.projects?.[0]?.archived, true);
  assert.equal(snapshot.projects?.[0]?.pushedAt, metadataAt);
  assert.equal(snapshot.projects?.[0]?.updatedAt, metadataAt);
  assert.equal(snapshot.projects?.[0]?.openIssues, 7);
  assert.equal(snapshot.projects?.[0]?.openPullRequests, 3);

  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  await cache.put(
    key,
    JSON.stringify({
      ...testDashboard("owner", [{ ...project, openIssues: 1, openPullRequests: 1 }]),
      generatedAt: countsAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: countsAt,
        countsUpdatedAt: "2026-06-11T02:00:00Z",
        projectCountsUpdatedAt: { "owner/repo": "2026-06-11T02:00:00Z" },
        releasesUpdatedAt: countsAt,
        ciUpdatedAt: countsAt,
      },
    } satisfies DashboardPayload),
  );
  const dashboard = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  assert.equal(dashboard.status, 200);
  assert.equal(((await dashboard.json()) as DashboardPayload).projects.length, 0);
});

test("older dashboard builds cannot restore repositories removed by newer counts", async () => {
  const buildStartedAt = "2026-06-11T02:00:00Z";
  const countsUpdatedAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: buildStartedAt,
    observedAt: buildStartedAt,
    countsUpdatedAt: buildStartedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: countsUpdatedAt,
    complete: true,
    counts: [],
  });
  await mutate({
    kind: "merge",
    generatedAt: countsUpdatedAt,
    observedAt: buildStartedAt,
    countsUpdatedAt: buildStartedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    projects?: Project[];
  };
  assert.deepEqual(snapshot.knownRepos, []);
  assert.equal(snapshot.projects?.length, 0);
});

test("complete metadata scans tombstone absent repositories across cached variants", async () => {
  const initialAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const staleBuildAt = new Date(Date.now() - 60 * 1000).toISOString();
  const removedAt = new Date().toISOString();
  const repo = testProject({ owner: "owner", name: "repo" });
  const sibling = testProject({ owner: "owner", name: "sibling" });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: initialAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: initialAt,
        countsUpdatedAt: initialAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo", "owner/sibling"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projects: [repo, sibling],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: removedAt,
    observedAt: removedAt,
    countsUpdatedAt: removedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [sibling],
    removedRepos: ["owner/repo"],
  });
  await mutate({
    kind: "merge",
    generatedAt: removedAt,
    observedAt: staleBuildAt,
    countsUpdatedAt: staleBuildAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [repo, sibling],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  assert.deepEqual(snapshot.knownRepos, ["owner/sibling"]);
  assert.equal(snapshot.removedRepos?.["owner/repo"], removedAt);
  assert.equal(
    snapshot.projects?.some((project) => project.fullName === "owner/repo"),
    false,
  );

  const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.deepEqual(
    body.projects.map((project) => project.fullName),
    ["owner/sibling"],
  );
});

test("stale repository removals cannot hide newer public metadata", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const publicAt = "2026-06-11T04:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    updatedAt: publicAt,
  });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({
    kind: "merge",
    generatedAt: publicAt,
    observedAt: publicAt,
    countsUpdatedAt: publicAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({ kind: "remove", fullName: project.fullName.toLowerCase(), observedAt: removedAt });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  assert.equal(snapshot.removedRepos?.[project.fullName.toLowerCase()], undefined);
  assert.equal(
    snapshot.projects?.some((candidate) => candidate.fullName === project.fullName),
    true,
  );
});

test("newer owner metadata merges cannot clear privacy tombstones", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const observedAt = "2026-06-11T04:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    assert.equal(response.ok || response.status === 204, true);
  };

  await mutate({ kind: "remove", fullName: "owner/repo", observedAt: removedAt });
  await mutate({
    kind: "merge",
    generatedAt: observedAt,
    observedAt,
    countsUpdatedAt: observedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  assert.equal(snapshot.removedRepos?.["owner/repo"], removedAt);
  assert.equal(
    snapshot.projects?.some((candidate) => candidate.fullName === "owner/repo"),
    false,
  );
});

test("worker persists archived observations without showing archived repositories", async () => {
  const owner = "archived-observation";
  const generatedAt = "2026-06-11T01:00:00Z";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({
    owner,
    name: "repo",
    archived: false,
    updatedAt: generatedAt,
  });
  const cache = kvStore({
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [],
      projects: [project],
      updatedAt: generatedAt,
      durableFallback: true,
    }),
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: generatedAt,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: generatedAt,
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-archived-observation",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: generatedAt,
    updatedAt: generatedAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/users/${owner}/repos`) {
      return Response.json([
        {
          owner: { login: owner },
          name: "repo",
          full_name: `${owner}/repo`,
          description: "archived repository",
          html_url: `https://github.com/${owner}/repo`,
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: true,
          pushed_at: "2026-06-11T02:00:00Z",
          updated_at: "2026-06-11T02:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    let acknowledged = false;
    await worker.queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              acknowledged = true;
            },
            retry() {
              throw new Error("archived observation refresh should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    assert.equal(acknowledged, true);
    const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(dashboard.projects.length, 0);
    const snapshot = JSON.parse((await cache.get(`owner-metadata:v1:${owner}`)) ?? "{}") as {
      projects?: Project[];
      removedRepos?: Record<string, string>;
    };
    assert.equal(snapshot.projects?.[0]?.archived, true);
    assert.equal(snapshot.removedRepos?.[`${owner}/repo`], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker preserves field freshness when resuming an older progress checkpoint", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "freshness-checkpoint";
  const now = new Date();
  const generatedAt = now.toISOString();
  const generationStartedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const removedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const releasesUpdatedAt = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const ciUpdatedAt = new Date(now.getTime() - 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner, name: "repo" });
  const cache = kvStore({
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [project.fullName.toLowerCase()],
      projects: [project],
      generationStartedAt,
      countsUpdatedAt: generatedAt,
      releasesUpdatedAt,
      ciUpdatedAt,
      updatedAt: generatedAt,
      durableFallback: true,
    }),
    [`owner-metadata:v1:${owner}`]: JSON.stringify({
      owner,
      generatedAt: removedAt,
      metadataUpdatedAt: removedAt,
      countsUpdatedAt: null,
      releaseDataComplete: false,
      knownRepos: [],
      removedRepos: { [project.fullName.toLowerCase()]: removedAt },
      projectMetadataUpdatedAt: {},
      projectCountsUpdatedAt: {},
      countOverlays: {},
      projects: [],
    }),
  });
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/users/${owner}/repos`) {
      return Response.json([
        {
          owner: { login: owner },
          name: project.name,
          full_name: project.fullName,
          description: null,
          html_url: project.url,
          default_branch: project.defaultBranch,
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: project.pushedAt,
          updated_at: project.updatedAt,
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const env = {
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    };
    const response = await worker.fetch(new Request(`https://release.bar/api/${owner}`), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    assert.equal(response.status, 200);
    const resumed = (await response.json()) as DashboardPayload;
    assert.equal(resumed.cache?.countsUpdatedAt, generatedAt);
    assert.equal(resumed.cache?.releasesUpdatedAt, releasesUpdatedAt);
    assert.equal(resumed.cache?.ciUpdatedAt, ciUpdatedAt);
    await Promise.all(waits);
    assert.equal(sentJobs.length, 1);

    let acknowledged = false;
    await worker.queue(
      {
        messages: [
          {
            body: sentJobs[0]!,
            attempts: 1,
            ack: () => {
              acknowledged = true;
            },
            retry: () => undefined,
          },
        ],
      },
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(acknowledged, true);
    const completed = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(completed.projects.length, 0);
    assert.equal(completed.cache?.releasesUpdatedAt, releasesUpdatedAt);
    assert.equal(completed.cache?.ciUpdatedAt, ciUpdatedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signed repository-less GitHub App webhooks are acknowledged", async () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({
    action: "created",
    installation: { id: 42 },
    sender: { login: "owner" },
  });
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-installation",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    { GITHUB_WEBHOOK_SECRET: secret },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, ignored: true });
});

test("signed private repository webhooks are ignored before durable admission", async () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: {
      full_name: "owner/private-repo",
      private: true,
      default_branch: "main",
      updated_at: "2026-06-11T04:00:00Z",
    },
  });
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-private-push",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    { GITHUB_WEBHOOK_SECRET: secret },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, ignored: true });
});

test("signed GitHub webhooks coalesce bursts and enqueue authoritative refreshes", async () => {
  const secret = "webhook-secret";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const combinedKey = dashboardCacheKey({
    owner: "owner",
    owners: ["other"],
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const combinedCountsUpdatedAt = "2026-01-01T00:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    openIssues: 2,
    openPullRequests: 1,
  });
  const oldProject = testProject({
    owner: "owner",
    name: "old-repo",
    openIssues: 8,
    pushedAt: "2020-01-01T00:00:00Z",
  });
  const dashboard: DashboardPayload = {
    ...testDashboard("owner", [project]),
    generatedAt: now,
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: now,
    },
  };
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: "/owner",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const combinedTarget: RefreshTarget = {
    ...target,
    key: combinedKey,
    owners: ["owner", "other"],
    path: "/owner?owners=other",
  };
  const secondaryKey = dashboardCacheKey({
    owner: "primary",
    owners: ["owner"],
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const secondaryTarget: RefreshTarget = {
    ...target,
    key: secondaryKey,
    owner: "primary",
    owners: ["primary", "owner"],
    path: "/primary?owners=owner",
  };
  const legacyTargets = Object.fromEntries(
    Array.from({ length: 201 }, (_, index) => {
      const owner = `legacy${String(index).padStart(3, "0")}`;
      const legacyKey = dashboardCacheKey({
        owner,
        includeUnreleased: true,
        includeReleaseData: true,
        schemaVersion: 6,
      });
      return [
        `refresh:target:v1:${legacyKey}`,
        JSON.stringify({
          ...target,
          key: legacyKey,
          owner,
          owners: [owner],
          path: `/${owner}`,
        } satisfies RefreshTarget),
      ];
    }),
  );
  const repoMatchedLegacyTargets = Array.from({ length: 30 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const legacyKey = `dashboard:v6:aaa${suffix}:noforks-noarchived-unreleased-release`;
    return {
      key: legacyKey,
      storageKey: `refresh:target:v1:${legacyKey}`,
      target: {
        ...target,
        key: legacyKey,
        owner: `aaa${suffix}`,
        owners: [],
        repos: ["owner/repo"],
        path: `/?repos=owner/repo&variant=${suffix}`,
      } satisfies RefreshTarget,
    };
  });
  const ownerLegacyPriorityTargets = Array.from({ length: 30 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const legacyKey = `dashboard:v6:owner:noforks-noarchived-unreleased-release:sources-priority-${suffix}`;
    return {
      key: legacyKey,
      storageKey: `refresh:target:v1:${legacyKey}`,
      target: {
        ...target,
        key: legacyKey,
        path: `/owner?priority=${suffix}`,
        lastSeenAt: new Date(Date.parse(now) - (30 - index) * 1_000).toISOString(),
      } satisfies RefreshTarget,
    };
  });
  const cache = kvStore({
    ...legacyTargets,
    ...Object.fromEntries(
      repoMatchedLegacyTargets.map(({ storageKey, target: matchedTarget }) => [
        storageKey,
        JSON.stringify(matchedTarget),
      ]),
    ),
    ...Object.fromEntries(
      ownerLegacyPriorityTargets.map(({ storageKey, target: priorityTarget }) => [
        storageKey,
        JSON.stringify(priorityTarget),
      ]),
    ),
    "owner:v1:owner": JSON.stringify({ type: "user", login: "owner" }),
    [key]: JSON.stringify(dashboard),
    [combinedKey]: JSON.stringify({
      ...dashboard,
      owners: [
        { type: "user", login: "owner" },
        { type: "user", login: "other" },
      ],
      cache: {
        ...dashboard.cache!,
        countsUpdatedAt: combinedCountsUpdatedAt,
      },
    } satisfies DashboardPayload),
    [secondaryKey]: JSON.stringify({
      ...dashboard,
      owners: [
        { type: "user", login: "primary" },
        { type: "user", login: "owner" },
      ],
    } satisfies DashboardPayload),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:target:v1:${combinedKey}`]: JSON.stringify(combinedTarget),
    [`refresh:target:v1:${secondaryKey}`]: JSON.stringify(secondaryTarget),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [oldProject],
    }),
    "owner-metadata:v1:other": JSON.stringify({
      owner: "other",
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: null,
      releaseDataComplete: true,
      projects: [testProject({ owner: "other", name: "repo" })],
    }),
  });
  const queued: unknown[] = [];
  const queuedDashboardTargets: string[] = [];
  let delivery7ImmediateTargets: string[] = [];
  let delivery7ImmediateCaptured = false;
  const queuedWebhooks: Array<Record<string, unknown>> = [];
  const queuedWebhookDelays: Array<number | undefined> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        if (
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "dashboard" &&
          typeof (message as { targetKey?: unknown }).targetKey === "string"
        ) {
          queuedDashboardTargets.push((message as { targetKey: string }).targetKey);
        }
        if (
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "github-webhook"
        ) {
          queuedWebhooks.push(message as Record<string, unknown>);
          queuedWebhookDelays.push(options?.delaySeconds);
        }
        if (
          !delivery7ImmediateCaptured &&
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "github-webhook-fanout" &&
          (message as { delivery?: unknown }).delivery === "delivery-7"
        ) {
          delivery7ImmediateTargets = [...queuedDashboardTargets];
          delivery7ImmediateCaptured = true;
        }
      },
    },
  };
  const locks = durableLocks(env);
  const durableObjectNames: string[] = [];
  env.DASHBOARD_LOCKS = {
    idFromName(name) {
      durableObjectNames.push(name);
      return locks.idFromName(name);
    },
    get: locks.get,
  };
  let exactIssues = 2;
  let exactArchived = false;
  let failCounts = false;
  let countRefreshes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      countRefreshes += 1;
      if (failCounts) throw new Error("count refresh failed");
      return Response.json({
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  nameWithOwner: "owner/repo",
                  issues: { totalCount: exactIssues },
                  pullRequests: { totalCount: 1 },
                  isArchived: exactArchived,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: repository.pushed_at,
                  updatedAt: repository.updated_at,
                },
              ],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const releaseQueuedDashboardJobs = async () => {
    for (let queuedIndex = queued.length - 1; queuedIndex >= 0; queuedIndex -= 1) {
      const queuedJob = queued[queuedIndex] as
        | { id?: unknown; kind?: unknown; targetKey?: unknown }
        | undefined;
      if (
        queuedJob?.kind !== "dashboard" ||
        typeof queuedJob.id !== "string" ||
        typeof queuedJob.targetKey !== "string"
      ) {
        continue;
      }
      queued.splice(queuedIndex, 1);
      await env.DASHBOARD_LOCKS!.get(env.DASHBOARD_LOCKS!.idFromName(queuedJob.targetKey)).fetch(
        new Request("https://releasebar.internal/job/release", {
          method: "POST",
          body: JSON.stringify({ jobId: queuedJob.id }),
        }),
      );
    }
  };
  const send = async (event: string, delivery: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const response = await worker.fetch(
      new Request("https://release.bar/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": await webhookSignature(secret, body),
        },
        body,
      }),
      env,
      { waitUntil: () => undefined },
    );
    const index = queued.findIndex(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
        (message as { delivery?: unknown }).delivery === delivery,
    );
    if (index >= 0) {
      const [message] = queued.splice(index, 1);
      await worker.queue(
        {
          messages: [
            {
              body: message as never,
              attempts: 1,
              ack: () => undefined,
              retry: () => undefined,
            },
          ],
        },
        env,
        { waitUntil: () => undefined },
      );
      await releaseQueuedDashboardJobs();
      while (true) {
        const fanoutIndex = queued.findIndex(
          (queuedMessage) =>
            Boolean(queuedMessage) &&
            typeof queuedMessage === "object" &&
            (queuedMessage as { kind?: unknown }).kind === "github-webhook-fanout",
        );
        if (fanoutIndex < 0) break;
        const [fanout] = queued.splice(fanoutIndex, 1);
        await worker.queue(
          {
            messages: [
              {
                body: fanout as never,
                attempts: 1,
                ack: () => undefined,
                retry: () => undefined,
              },
            ],
          },
          env,
          { waitUntil: () => undefined },
        );
      }
      await releaseQueuedDashboardJobs();
    }
    return response;
  };

  const repository = {
    full_name: "owner/repo",
    archived: false,
    default_branch: "main",
    pushed_at: "2026-06-11T00:00:00Z",
    updated_at: new Date(Date.parse(now) + 1_000).toISOString(),
  };
  let repositoryObservation = Date.parse(repository.updated_at);
  const observedRepository = (overrides: Record<string, unknown> = {}) => ({
    ...repository,
    ...overrides,
    updated_at: new Date((repositoryObservation += 1_000)).toISOString(),
  });
  const readDashboard = async (url = "https://release.bar/api/owner") => {
    const response = await worker.fetch(new Request(url), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as DashboardPayload;
  };
  try {
    const oversized = await worker.fetch(
      new Request("https://release.bar/api/github/webhook", {
        method: "POST",
        headers: {
          "content-length": String(2 * 1024 * 1024 + 1),
        },
        body: "{}",
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(oversized.status, 413);

    assert.equal(
      (await send("ping", "delivery-ping", { zen: "Approachable is better" })).status,
      200,
    );

    exactIssues = 3;
    assert.equal(
      (
        await send("issues", "delivery-1", {
          action: "opened",
          repository,
        })
      ).status,
      202,
    );
    const counted = await readDashboard();
    assert.equal(counted.projects[0]?.openIssues, 3);
    const combinedCounted = await readDashboard("https://release.bar/api/owner?owners=other");
    assert.equal(combinedCounted.projects[0]?.openIssues, 3);
    assert.equal(combinedCounted.cache?.countsUpdatedAt, combinedCountsUpdatedAt);
    const countedSnapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
      countsUpdatedAt?: string;
      projects?: Project[];
    };
    assert.ok(Date.parse(countedSnapshot.countsUpdatedAt ?? "") >= Date.parse(now));
    assert.equal(
      countedSnapshot.projects?.find((candidate) => candidate.name === "repo")?.openIssues,
      3,
    );
    assert.equal(
      countedSnapshot.projects?.find((candidate) => candidate.name === "old-repo")?.openIssues,
      undefined,
    );

    exactIssues = 4;
    await send("issues", "delivery-transferred", {
      action: "transferred",
      repository,
    });
    assert.equal((await readDashboard()).projects[0]?.openIssues, 4);

    await send("issues", "delivery-1", { action: "opened", repository });
    const deduplicated = await readDashboard();
    assert.equal(deduplicated.projects[0]?.openIssues, 4);

    exactIssues = 5;
    const refreshesBeforeBurst = countRefreshes;
    await Promise.all([
      send("issues", "delivery-2", { action: "opened", repository }),
      send("issues", "delivery-3", { action: "opened", repository }),
    ]);
    assert.equal(countRefreshes - refreshesBeforeBurst, 1);
    const serialized = await readDashboard();
    assert.equal(serialized.projects[0]?.openIssues, 5);

    failCounts = true;
    await send("issues", "delivery-redelivery", { action: "opened", repository });
    assert.equal(queuedWebhookDelays.at(-1), 5 * 60);
    assert.equal(
      (
        queued.find(
          (message) =>
            Boolean(message) &&
            typeof message === "object" &&
            (message as { delivery?: unknown }).delivery === "delivery-redelivery",
        ) as { attempts?: number } | undefined
      )?.attempts,
      1,
    );
    const redeliveryJobs = queuedWebhooks.filter(
      (message) => message.delivery === "delivery-redelivery",
    );
    assert.equal(redeliveryJobs.at(-1)?.id, redeliveryJobs[0]?.id);
    failCounts = false;
    exactIssues = 6;
    await send("issues", "delivery-redelivery", { action: "opened", repository });
    const redelivered = await readDashboard();
    assert.equal(redelivered.projects[0]?.openIssues, 6);

    failCounts = true;
    await send("repository", "delivery-archive-fallback", {
      action: "archived",
      repository: observedRepository({ archived: true }),
    });
    failCounts = false;
    const fallbackSnapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
      projects?: Project[];
    };
    assert.equal(
      fallbackSnapshot.projects?.find((candidate) => candidate.fullName === "owner/repo")?.archived,
      true,
    );
    assert.notEqual(await cache.get(key), null);
    assert.equal((await readDashboard()).projects.length, 0);

    exactArchived = false;
    await send("repository", "delivery-archive-fallback-restore", {
      action: "unarchived",
      repository: observedRepository(),
    });

    exactArchived = true;
    await send("repository", "delivery-4", {
      action: "archived",
      repository: observedRepository({ archived: true }),
    });
    assert.equal((await readDashboard()).projects.length, 0);

    exactArchived = false;
    await send("repository", "delivery-5", {
      action: "unarchived",
      repository: observedRepository(),
    });
    assert.equal((await readDashboard()).projects[0]?.archived, false);

    await send("push", "delivery-6", {
      ref: "refs/heads/feature",
      after: "11111112222222",
      head_commit: { timestamp: "2026-06-11T02:00:00Z" },
      commits: Array.from({ length: 2_048 }, (_, index) => ({
        id: String(index).padStart(40, "0"),
        message: "large push payload",
      })),
      repository,
    });
    const featurePush = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(featurePush.projects[0]?.latestCommitSha, "abcdef1");

    queuedDashboardTargets.length = 0;
    await cache.delete("refresh:target-index:v1:ready");
    await send("push", "delivery-7", {
      ref: "refs/heads/main",
      after: "22222223333333",
      head_commit: { timestamp: "2026-06-11T03:00:00Z" },
      repository,
    });
    assert.equal(
      repoMatchedLegacyTargets.every(({ key: matchedKey }) =>
        queuedDashboardTargets.includes(matchedKey),
      ),
      true,
    );
    assert.equal(delivery7ImmediateTargets?.includes(key), true);
    assert.equal(delivery7ImmediateTargets.length <= 25, true);
    assert.equal(delivery7ImmediateTargets.includes(ownerLegacyPriorityTargets.at(-1)!.key), true);
    assert.equal(delivery7ImmediateTargets.includes(ownerLegacyPriorityTargets[0]!.key), false);
    assert.equal(
      ownerLegacyPriorityTargets.every(({ key: priorityKey }) =>
        queuedDashboardTargets.includes(priorityKey),
      ),
      true,
    );
    assert.equal(await cache.get(key), null);
    assert.equal(await cache.get(secondaryKey), null);
    const activeLocks = env.DASHBOARD_LOCKS;
    env.DASHBOARD_LOCKS = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => new Response(null, { status: 409 }),
      }),
    };
    const pushFallback = await readDashboard();
    env.DASHBOARD_LOCKS = activeLocks;
    assert.equal(pushFallback.projects[0]?.version, "repo search");
    assert.equal(pushFallback.projects[0]?.releaseDate, null);
    assert.equal(pushFallback.projects[0]?.latestCommitSha, null);
    assert.equal(pushFallback.projects[0]?.ciState, "unknown");

    await cache.put(key, JSON.stringify(dashboard));
    await send("release", "delivery-8", {
      action: "edited",
      release: {
        tag_name: "v0.9.0",
        name: "old release",
        html_url: "https://github.com/owner/repo/releases/tag/v0.9.0",
        published_at: "2026-04-01T00:00:00Z",
        draft: false,
      },
      repository,
    });
    assert.equal(await cache.get(key), null);

    await cache.put(key, JSON.stringify(dashboard));
    await send("release", "delivery-9", {
      action: "edited",
      release: {
        tag_name: "v1.0.0",
        name: "current release",
        html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        published_at: "2026-05-01T00:00:00Z",
        draft: false,
      },
      repository,
    });
    assert.equal(await cache.get(key), null);

    const releaseFragmentKey = "repo:v2:owner/repo:unreleased:release";
    await cache.put(key, JSON.stringify(dashboard));
    await cache.put(releaseFragmentKey, "cached");
    await send("release", "delivery-created", {
      action: "created",
      release: {
        tag_name: "v1.1.0",
        name: "new release",
        html_url: "https://github.com/owner/repo/releases/tag/v1.1.0",
        published_at: "2026-06-11T04:00:00Z",
        draft: false,
      },
      repository,
    });
    assert.equal(await cache.get(releaseFragmentKey), null);
    assert.equal(await cache.get(key), null);

    await cache.put(key, JSON.stringify(dashboard));
    await cache.put(releaseFragmentKey, "cached");
    await send("release", "delivery-unpublished", {
      action: "unpublished",
      release: {
        tag_name: "v1.1.0",
        name: "unpublished release",
        html_url: "https://github.com/owner/repo/releases/tag/v1.1.0",
        published_at: "2026-06-11T04:00:00Z",
        draft: true,
      },
      repository,
    });
    assert.equal(await cache.get(releaseFragmentKey), null);
    assert.equal(await cache.get(key), null);

    await cache.put(key, JSON.stringify(dashboard));
    await cache.put("hot:v3", JSON.stringify(testDashboard("hot", [project])));
    const privateCacheKeys = [
      "repo-detail:v4:owner/repo",
      "social-repo:v3:owner/repo",
      "repo-activity:v1:owner/repo:day",
      "repo-audience:v5:owner/repo:week",
      "owner-activity:v2:owner:day",
      "owner-activity-summary:v4:owner:week:chat-latest:hash",
      "repo-activity-summary:v4:owner/repo:day:chat-latest:hash",
      "release-summary:v1:owner/repo:v1.0.0:abcdef1:chat-latest",
      "discover:v4:week:all",
      "repo-audience:v5:other/repo:week",
      "owner-activity:v2:contributor:week",
      "owner-activity-summary:v4:contributor:week:chat-latest:hash",
      "trust-profile:v4:owner",
      "audience-user-repos:v2:owner",
    ];
    await Promise.all(privateCacheKeys.map((cacheKey) => cache.put(cacheKey, "cached")));
    await cache.delete("owner-metadata:v1:owner");
    await send("repository", "delivery-10", {
      action: "privatized",
      repository: observedRepository(),
    });
    assert.equal(await cache.get(key), null);
    await cache.put(key, JSON.stringify(dashboard));
    assert.equal((await readDashboard()).projects.length, 0);
    const privateSnapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
      privateRepos?: Record<string, string>;
      removedRepos?: Record<string, string>;
      projects?: Project[];
    };
    assert.equal(privateSnapshot.projects?.length, 0);
    assert.equal(typeof privateSnapshot.privateRepos?.["owner/repo"], "string");
    assert.equal(typeof privateSnapshot.removedRepos?.["owner/repo"], "string");
    assert.equal(await cache.get("hot:v3"), null);
    for (const cacheKey of privateCacheKeys) {
      assert.equal(await cache.get(cacheKey), null);
    }
    await cache.put(
      "discover:v4:week:all",
      JSON.stringify({
        ...testDashboard("hot", [project]),
        title: "GitHub Hot",
        owners: [],
      }),
    );
    const privateDiscover = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(privateDiscover.status, 200);
    assert.equal(((await privateDiscover.json()) as DashboardPayload).projects.length, 0);

    const leakedAt = new Date(Date.parse(now) + 10_000).toISOString();
    await cache.put(
      "owner-activity:v2:contributor:week",
      JSON.stringify({
        owner: {
          type: "user",
          login: "contributor",
          avatarUrl: "https://github.com/contributor.png",
          url: "https://github.com/contributor",
        },
        range: "week",
        generatedAt: leakedAt,
        cache: {
          state: "fresh",
          stale: false,
          generatedAt: leakedAt,
        },
        totals: {
          events: 1,
          commits: 1,
          pullRequests: 0,
          issues: 0,
          comments: 0,
          releases: 0,
          repositories: 1,
        },
        repositories: [
          {
            fullName: "owner/repo",
            url: "https://github.com/owner/repo",
            events: 1,
            commits: 1,
            pullRequests: 0,
            issues: 0,
            comments: 0,
            releases: 0,
            lastActiveAt: leakedAt,
          },
        ],
        events: [
          {
            id: "private-race",
            kind: "commit",
            title: "private repository work",
            repo: "owner/repo",
            url: "https://github.com/owner/repo",
            createdAt: leakedAt,
            count: 1,
          },
        ],
      } satisfies OwnerActivityPayload),
    );
    const privateActivity = await worker.fetch(
      new Request("https://release.bar/api/contributor/activity?range=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(privateActivity.status, 200);
    const privateActivityBody = (await privateActivity.json()) as OwnerActivityPayload;
    assert.equal(privateActivityBody.events.length, 0);
    assert.equal(privateActivityBody.repositories.length, 0);
    assert.doesNotMatch(JSON.stringify(privateActivityBody), /owner\/repo|private repository work/);

    await Promise.all([
      cache.put(key, JSON.stringify(dashboard)),
      cache.put(
        "owner-metadata:v1:owner",
        JSON.stringify({
          owner: "owner",
          generatedAt: now,
          metadataUpdatedAt: now,
          countsUpdatedAt: now,
          releaseDataComplete: true,
          knownRepos: ["owner/repo"],
          privateRepos: {},
          removedRepos: {},
          projectMetadataUpdatedAt: { "owner/repo": now },
          projectCountsUpdatedAt: { "owner/repo": now },
          countOverlays: {},
          projects: [project],
        }),
      ),
      cache.put(
        "repo-detail:v4:owner/repo",
        JSON.stringify({
          fullName: "owner/repo",
          generatedAt: now,
          cache: { state: "fresh", stale: false, generatedAt: now },
          stats: {
            commitActivity: { state: "ready" },
            codeFrequency: { state: "ready" },
          },
          project,
          releases: [],
          contributors: [],
          commitActivity: [],
          codeFrequency: [],
          languages: [],
          workTrend: null,
        } satisfies RepoDetailPayload),
      ),
    ]);
    assert.equal((await readDashboard()).projects.length, 0);
    const stalePrivateDetail = await worker.fetch(
      new Request("https://release.bar/api/repos/owner/repo"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(stalePrivateDetail.status, 404);

    await cache.put(key, JSON.stringify(dashboard));
    await send("repository", "delivery-publicized-old", {
      action: "publicized",
      repository: {
        ...repository,
        updated_at: new Date(Date.parse(now) - 1_000).toISOString(),
      },
    });
    assert.equal((await readDashboard()).projects.length, 0);

    await send("repository", "delivery-publicized-new", {
      action: "publicized",
      repository: observedRepository(),
    });
    assert.equal((await readDashboard()).projects.length, 1);

    const compactPush = queuedWebhooks.find((message) => message.delivery === "delivery-6")
      ?.payload as Record<string, unknown> | undefined;
    assert.equal("commits" in (compactPush ?? {}), false);
    assert.equal(JSON.stringify(compactPush).length < 2_000, true);
    const indexes = await cache.list({ prefix: "refresh:target-index:v1:owner:owner:" });
    assert.equal(indexes.keys.length > 0, true);
    assert.equal(durableObjectNames.includes("github-webhook-admission"), true);
    assert.equal(durableObjectNames.includes("github-webhook-process:owner"), true);
    assert.equal(durableObjectNames.includes("github-webhooks"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub push webhooks prioritize recent targets beyond the durable hot-cache limit", async () => {
  type QueuedWebhook = {
    kind: "github-webhook";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    attempts?: number;
  };
  type QueuedFanout = {
    kind: "github-webhook-fanout";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    action: {
      reason: string;
      includeReleaseDataOnly: boolean;
      invalidateDashboard: boolean;
      recentTargetsOnly?: boolean;
      prioritizedTargetKeys?: string[];
    };
    source: "indexed" | "owner" | "repo" | "kv-owner" | "kv-repo" | "legacy";
    priorityBatchStartedAt?: string;
    cursor?: string;
  };
  const secret = "fanout-webhook-secret";
  const owner = "fanout";
  const now = new Date().toISOString();
  const fallbackTargetIndex = 0;
  const staleTargetIndex = 204;
  const firstReleaseTargetIndex = 26;
  const movedTargetIndex = 201;
  const newestTargetIndex = 202;
  const durableOnlyTargetIndex = 203;
  const metadataOnlyTargetIndexes = new Set(Array.from({ length: 25 }, (_, index) => index + 1));
  const project = testProject({ owner, name: "repo" });
  const degradedRepoTarget = {
    key: "dashboard:v6:custom:noforks-noarchived-unreleased-release:sources-degraded",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: [`${owner}/repo`],
    includeReleaseData: true,
    path: `/?repos=${owner}/repo`,
    priority: 60,
    lastSeenAt: new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  } satisfies RefreshTarget;
  const targets = Array.from({ length: 205 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    const key = `dashboard:v6:${owner}:noforks-noarchived-unreleased-release:sources-${suffix}`;
    return {
      key,
      kind: "dashboard",
      owner,
      owners: [owner],
      repos: [],
      includeReleaseData: !metadataOnlyTargetIndexes.has(index),
      path: `/${owner}?variant=${suffix}`,
      priority: 60,
      lastSeenAt:
        index === staleTargetIndex
          ? new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString()
          : index === fallbackTargetIndex
            ? new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString()
            : metadataOnlyTargetIndexes.has(index)
              ? new Date(Date.parse(now) + 3_000).toISOString()
              : index === newestTargetIndex
                ? new Date(Date.parse(now) + 2_000).toISOString()
                : now,
      lastAttemptAt: null,
      lastSuccessAt: now,
      nextDueAt: "2999-01-01T00:00:00Z",
      failureCount: 0,
      indexVersion: 2,
    } satisfies RefreshTarget;
  });
  const cache = kvStore({
    "refresh:target-index:v1:ready": "2",
    ...Object.fromEntries(
      targets.flatMap((target, index) => [
        [`refresh:target:v1:${target.key}`, JSON.stringify(target)],
        [
          `refresh:target-index:v1:owner:${owner}:${String(index).padStart(3, "0")}`,
          JSON.stringify(target.key),
        ],
        [target.key, JSON.stringify(testDashboard(owner, [project]))],
      ]),
    ),
    [`refresh:target:v1:${degradedRepoTarget.key}`]: JSON.stringify(degradedRepoTarget),
    [degradedRepoTarget.key]: JSON.stringify(testDashboard("custom", [project])),
  });
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:duplicate`,
    JSON.stringify(targets[0]!.key),
  );
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:degraded`,
    JSON.stringify(degradedRepoTarget.key),
  );
  const queued: Array<RefreshJob | QueuedWebhook | QueuedFanout> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const durableOwnerIndex = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(`refresh-target-index:owner:${owner}`),
  );
  for (const [index, target] of targets.entries()) {
    const indexedTarget =
      index === fallbackTargetIndex
        ? {
            ...target,
            lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
          }
        : target;
    const indexed = await durableOwnerIndex.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify(indexedTarget),
      }),
    );
    assert.equal(indexed.status, 204);
  }
  await cache.delete(`refresh:target:v1:${targets[durableOnlyTargetIndex]!.key}`);
  const durableRepoIndex = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(`refresh-target-index:repo:${owner}/repo`),
  );
  const staleRepoDuplicate = {
    ...targets[newestTargetIndex]!,
    lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  const duplicate = await durableRepoIndex.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify(staleRepoDuplicate),
    }),
  );
  assert.equal(duplicate.status, 204);
  const payload = {
    ref: "refs/heads/main",
    after: "abcdef1234567890",
    repository: {
      full_name: `${owner}/repo`,
      archived: false,
      default_branch: "main",
      pushed_at: now,
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-fanout",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 202);
  const webhookJob = queued.find(
    (message): message is QueuedWebhook => message.kind === "github-webhook",
  );
  assert.ok(webhookJob);
  let acknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob,
          attempts: 1,
          ack: () => {
            acknowledged = true;
          },
          retry: () => undefined,
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );
  const initialDashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  const firstFanout = queued.find(
    (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
  );
  assert.ok(firstFanout);
  assert.equal(initialDashboardJobs.length, 25);
  assert.equal(firstFanout.action.prioritizedTargetKeys?.length, 25);
  assert.equal(typeof firstFanout.priorityBatchStartedAt, "string");
  firstFanout.createdAt = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  await cache.put(
    "github:budget:v1:shared:_",
    JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5_000,
      resetAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      reason: "test cooldown",
    }),
  );
  let fanoutAcknowledged = false;
  let fanoutRetryDelaySeconds: number | undefined;
  await worker.queue(
    {
      messages: [
        {
          body: firstFanout,
          attempts: 1,
          ack: () => {
            fanoutAcknowledged = true;
          },
          retry: (options) => {
            fanoutRetryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(fanoutAcknowledged, false);
  assert.equal(fanoutRetryDelaySeconds, 20);
  await cache.delete("github:budget:v1:shared:_");
  for (const job of initialDashboardJobs) {
    const releaseResponse: Response = await env.DASHBOARD_LOCKS.get(
      env.DASHBOARD_LOCKS.idFromName(job.targetKey),
    ).fetch(
      new Request("https://releasebar.internal/job/release", {
        method: "POST",
        body: JSON.stringify({ jobId: job.id }),
      }),
    );
    assert.equal(releaseResponse.status, 204);
  }
  const moved = await durableOwnerIndex.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify({
        ...targets[movedTargetIndex]!,
        lastSeenAt: new Date(Date.parse(now) + 4_000).toISOString(),
      }),
    }),
  );
  assert.equal(moved.status, 204);
  const rebuiltPrioritizedCache = JSON.stringify(testDashboard(owner, [project]));
  await cache.put(targets[newestTargetIndex]!.key, rebuiltPrioritizedCache);
  const pageSizes = [
    queued.filter((message): message is RefreshJob => message.kind === "dashboard").length,
  ];
  while (true) {
    const fanoutIndex = queued.findIndex(
      (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
    );
    if (fanoutIndex < 0) break;
    const [fanout] = queued.splice(fanoutIndex, 1);
    const before = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    await worker.queue(
      {
        messages: [
          {
            body: fanout!,
            attempts: 1,
            ack: () => undefined,
            retry: () => undefined,
          },
        ],
      },
      env,
      { waitUntil: () => undefined },
    );
    const after = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    pageSizes.push(after - before);
  }

  const dashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  assert.equal(acknowledged, true);
  assert.equal(pageSizes.length >= 2, true);
  assert.equal(Math.max(...pageSizes) <= 200, true);
  assert.equal(
    new Set(dashboardJobs.map((job) => job.targetKey)).size,
    targets.length - metadataOnlyTargetIndexes.size,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[staleTargetIndex]!.key),
    false,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[fallbackTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[movedTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === targets[durableOnlyTargetIndex]!.key),
    true,
  );
  assert.equal(
    dashboardJobs.some((job) => job.targetKey === degradedRepoTarget.key),
    true,
  );
  assert.equal(dashboardJobs[0]?.targetKey, targets[newestTargetIndex]!.key);
  const firstJob = dashboardJobs.find(
    (job) => job.targetKey === targets[firstReleaseTargetIndex]!.key,
  );
  assert.ok(firstJob);
  const firstTargetStub = env.DASHBOARD_LOCKS.get(
    env.DASHBOARD_LOCKS.idFromName(targets[firstReleaseTargetIndex]!.key),
  );
  const release = await firstTargetStub.fetch(
    new Request("https://releasebar.internal/job/release", {
      method: "POST",
      body: JSON.stringify({ jobId: firstJob.id, consumeDirty: true }),
    }),
  );
  assert.equal(release.status, 204);
  assert.equal(await cache.get(targets[staleTargetIndex]!.key), null);
  assert.notEqual(await cache.get(targets[1]!.key), null);
  assert.equal(await cache.get(targets[firstReleaseTargetIndex]!.key), null);
  assert.equal(await cache.get(targets[newestTargetIndex]!.key), rebuiltPrioritizedCache);
  assert.equal(await cache.get(targets.at(-1)!.key), null);
  assert.equal(await cache.get(degradedRepoTarget.key), null);
});

test("durable target indexes cap persistent variants per source", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  const stub = locks.get(locks.idFromName("refresh-target-index:owner:owner"));
  for (let index = 0; index < 512; index += 1) {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify({
          key: `dashboard:v6:owner:variant-${index}`,
          kind: "dashboard",
          owner: "owner",
          owners: ["owner"],
          repos: [],
          includeReleaseData: true,
          path: `/owner?variant=${index}`,
          priority: 60,
          lastSeenAt: now,
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextDueAt: now,
          failureCount: 0,
        } satisfies RefreshTarget),
      }),
    );
    assert.equal(response.status, 204);
  }
  const rejected = await stub.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify({
        key: "dashboard:v6:owner:variant-overflow",
        kind: "dashboard",
        owner: "owner",
        owners: ["owner"],
        repos: [],
        includeReleaseData: true,
        path: "/owner?variant=overflow",
        priority: 60,
        lastSeenAt: now,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextDueAt: now,
        failureCount: 0,
      } satisfies RefreshTarget),
    }),
  );
  assert.equal(rejected.status, 429);
});

test("durable target indexes reject oversized entries and serialized source state", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  const stub = locks.get(locks.idFromName("refresh-target-index:owner:owner"));
  const target = (index: number, padding: number): RefreshTarget => ({
    key: `dashboard:v6:owner:large-${index}`,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: `/owner?padding=${"x".repeat(padding)}&variant=${index}`,
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: now,
    failureCount: 0,
  });
  const oversized = await stub.fetch(
    new Request("https://releasebar.internal/target-index/upsert", {
      method: "POST",
      body: JSON.stringify(target(0, 9 * 1024)),
    }),
  );
  assert.equal(oversized.status, 413);

  let accepted = 0;
  let rejected = 0;
  for (let index = 1; index <= 512; index += 1) {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/target-index/upsert", {
        method: "POST",
        body: JSON.stringify(target(index, 4 * 1024)),
      }),
    );
    if (response.status === 204) accepted += 1;
    if (response.status === 429) {
      rejected = index;
      break;
    }
  }
  assert.equal(accepted > 0, true);
  assert.equal(rejected > 0 && rejected < 512, true);
});

test("repo-only refresh targets do not consume a shared custom-owner index", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:repo-only-index",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: ["owner/repo"],
    includeReleaseData: true,
    path: "/?repos=owner/repo",
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("custom", [testProject({ owner: "owner", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = locks;
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const customIndex = await locks.get(locks.idFromName("refresh-target-index:owner:custom")).fetch(
    new Request("https://releasebar.internal/target-index/list", {
      method: "POST",
    }),
  );
  const repoIndex = await locks.get(locks.idFromName("refresh-target-index:repo:owner/repo")).fetch(
    new Request("https://releasebar.internal/target-index/list", {
      method: "POST",
    }),
  );
  assert.deepEqual(await customIndex.json(), []);
  assert.equal(((await repoIndex.json()) as RefreshTarget[])[0]?.key, target.key);
});

test("multi-source target admission rolls back newly-created durable indexes", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:atomic-index",
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: ["other/repo"],
    includeReleaseData: true,
    path: "/owner?repos=other/repo",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("owner", [testProject({ owner: "other", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const backing = durableLocks(env);
  const locks = {
    idFromName: backing.idFromName,
    get(id: string) {
      if (id === "refresh-target-index:repo:other/repo") {
        return {
          async fetch(request: Request) {
            return new URL(request.url).pathname === "/target-index/upsert"
              ? new Response(null, { status: 429 })
              : new Response(null, { status: 204 });
          },
        };
      }
      return backing.get(id);
    },
  };
  env.DASHBOARD_LOCKS = locks;
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  const ownerIndex = await backing
    .get(backing.idFromName("refresh-target-index:owner:owner"))
    .fetch(
      new Request("https://releasebar.internal/target-index/list", {
        method: "POST",
      }),
    );
  assert.deepEqual(await ownerIndex.json(), []);
  assert.equal(await cache.get(`refresh:target:v1:${target.key}`), null);
});

test("rejected target admission does not persist or queue the target", async () => {
  const owner = "capped";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const generatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cached = {
    ...testDashboard(owner, [testProject({ owner, name: "repo" })]),
    generatedAt,
    cache: {
      state: "stale",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt,
      countsUpdatedAt: generatedAt,
      projectCountsUpdatedAt: { [`${owner}/repo`]: generatedAt },
      releasesUpdatedAt: generatedAt,
      ciUpdatedAt: generatedAt,
    },
  } satisfies DashboardPayload;
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
  });
  const queued: unknown[] = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(message) {
        queued.push(message);
      },
    },
  };
  const backing = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: backing.idFromName,
    get(id: string) {
      if (id === `refresh-target-index:owner:${owner}`) {
        return {
          async fetch(request: Request) {
            return new URL(request.url).pathname === "/target-index/upsert"
              ? new Response(null, { status: 429 })
              : new Response(null, { status: 204 });
          },
        };
      }
      return backing.get(id);
    },
  };
  const waits: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`https://release.bar/api/${owner}`), env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  assert.equal(response.status, 200);
  assert.equal(queued.length, 0);
  assert.equal(await cache.get(`refresh:target:v1:${key}`), null);
});

test("archive webhooks invalidate caches when owner snapshots omit the repository", async () => {
  const secret = "archive-no-snapshot-secret";
  const owner = "coldowner";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const dashboard = testDashboard(owner, [testProject({ owner, name: "repo" })]);
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`]:
      JSON.stringify({ generatedAt: now, data: { name: "repo" } }),
    [`owner-metadata:v1:${owner}`]: JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [testProject({ owner, name: "sibling" })],
    }),
  });
  const queued: unknown[] = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const payload = {
    action: "archived",
    repository: {
      full_name: `${owner}/repo`,
      archived: true,
      default_branch: "main",
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "repository",
        "x-github-delivery": "delivery-archive-no-snapshot",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 202);
  const webhookJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "github-webhook",
  );
  assert.ok(webhookJob);
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob as never,
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  assert.equal(
    await cache.get(
      `repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`,
    ),
    null,
  );
});

test("push webhooks bypass terminal target backoff before invalidating caches", async () => {
  const owner = "backedoff";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 11,
    terminalBackoffUntil: "2999-01-01T00:00:00Z",
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
    "hot:v3": JSON.stringify(
      testDashboard("hot", [testProject({ owner, name: "repo", commitsSinceRelease: 5 })]),
    ),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  const queued: unknown[] = [];
  const queuedDelays: Array<number | undefined> = [];
  const dashboardCacheAtEnqueue: Array<string | null> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        queuedDelays.push(options?.delaySeconds);
        if (
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "dashboard"
        ) {
          dashboardCacheAtEnqueue.push(await cache.get(key));
        }
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-backedoff-push",
            event: "push",
            delivery: "delivery-backedoff-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  const invalidatedHot = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  assert.equal(invalidatedHot.cache?.state, "stale");
  assert.deepEqual(dashboardCacheAtEnqueue, [null]);
  assert.equal(
    queued.some(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { kind?: unknown; targetKey?: unknown }).kind === "dashboard" &&
        (message as { targetKey?: unknown }).targetKey === key,
    ),
    true,
  );

  const activeJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "dashboard",
  ) as { id?: string } | undefined;
  assert.equal(typeof activeJob?.id, "string");
  queued.length = 0;
  await cache.put(
    key,
    JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
  );
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-push",
            event: "push",
            delivery: "delivery-reserved-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(await cache.get(key), null);
  const requeued = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-push",
  );
  assert.equal(requeued, undefined);
  const targetStub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName(key));
  const release = await targetStub.fetch(
    new Request("https://releasebar.internal/job/release", {
      method: "POST",
      body: JSON.stringify({
        jobId: activeJob!.id,
        consumeDirty: true,
      }),
    }),
  );
  assert.equal(release.status, 200);
  assert.equal(((await release.json()) as { reason?: string }).reason, "webhook:push");
});

test("reserved webhook refreshes queue one follow-up after the active job", async () => {
  const owner = "reserved-fallback";
  const now = new Date().toISOString();
  const finalDeliveryStartedAt = new Date(Date.parse(now) + 60_000).toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "sibling" })])),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
  });
  const queued: unknown[] = [];
  const delays: Array<number | undefined> = [];
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        delays.push(options?.delaySeconds);
      },
    },
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const targetStub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName(key));
  const reservation = await targetStub.fetch(
    new Request("https://releasebar.internal/job/reserve", {
      method: "POST",
      body: JSON.stringify({ jobId: "existing-job" }),
    }),
  );
  assert.equal(reservation.status, 204);

  let acknowledged = false;
  let retried = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-fallback",
            event: "repository",
            delivery: "delivery-reserved-fallback",
            payload: {
              action: "publicized",
              repository: {
                full_name: `${owner}/missing`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
            attempts: 0,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  const requeuedWebhook = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-fallback",
  );
  assert.equal(requeuedWebhook, undefined);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);

  let activeAcknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            id: "existing-job",
            targetKey: key,
            target,
            kind: "dashboard",
            status: "succeeded",
            reason: "existing refresh",
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: now,
            startedAt: finalDeliveryStartedAt,
            finishedAt: now,
            attempts: 1,
            durationMs: 1,
          },
          attempts: 1,
          ack() {
            activeAcknowledged = true;
          },
          retry() {
            throw new Error("completed active job should not retry");
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(activeAcknowledged, true);
  const followup = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; reason?: unknown }).kind === "dashboard" &&
      String((message as { reason?: unknown }).reason).includes("repository-publicized:follow-up"),
  ) as { targetKey?: string } | undefined;
  assert.equal(followup?.targetKey, key);
  assert.equal(delays.at(-1), 0);
  assert.equal(await cache.get(key), null);
});

test("worker acknowledges webhook jobs after the durable requeue limit", async () => {
  let abandoned = false;
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/webhook/process") {
          return new Response(null, { status: 500 });
        }
        if (path === "/webhook/abandon") {
          abandoned = true;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
            attempts?: number;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-terminal",
            event: "issues",
            delivery: "delivery-terminal",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        },
      ],
    },
    { DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(abandoned, true);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
});

test("processed webhook retries take over followers behind a stale matching lease", async () => {
  const now = new Date().toISOString();
  const values = new Map<string, unknown>([
    ["webhook-deliveries", [{ id: "delivery-leader", processedAt: Date.now() }]],
    [
      "webhook-active",
      {
        jobId: "job-leader",
        leaseId: "stale-lease",
        delivery: "delivery-leader",
        expiresAt: Date.now() + 60_000,
      },
    ],
    [
      "webhook-pending",
      [
        {
          key: "delivery:delivery-follower",
          revision: "follower-revision",
          job: {
            kind: "github-webhook",
            id: "job-follower",
            event: "status",
            delivery: "delivery-follower",
            payload: {
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: now,
            attempts: 0,
          },
          deliveries: ["delivery-follower"],
        },
      ],
    ],
  ]);
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return values.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          values.set(key, value);
        },
        async delete(key: string) {
          return values.delete(key);
        },
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      },
    },
    {},
  );

  const response = await lock.fetch(
    new Request("https://releasebar.internal/webhook/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "github-webhook",
        id: "job-leader",
        event: "issues",
        delivery: "delivery-leader",
        payload: {
          action: "opened",
          repository: {
            full_name: "owner/repo",
            default_branch: "main",
          },
        },
        createdAt: now,
        attempts: 1,
      }),
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(values.get("webhook-pending"), []);
  assert.equal(values.has("webhook-active"), false);
  assert.equal(
    (values.get("webhook-deliveries") as Array<{ id: string }>).some(
      (delivery) => delivery.id === "delivery-follower",
    ),
    true,
  );
});

test("worker retries terminal webhook jobs when durable abandonment fails", async () => {
  let acknowledged = false;
  let retryDelaySeconds: number | undefined;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/webhook/process" || path === "/webhook/abandon") {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-terminal-abandon-failed",
            event: "issues",
            delivery: "delivery-terminal-abandon-failed",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        } as never,
      ],
    },
    { DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, false);
  assert.equal(retryDelaySeconds, 20);
});

test("worker quickly requeues busy webhook jobs without consuming their failure budget", async () => {
  let acknowledged = false;
  let queuedDelaySeconds: number | undefined;
  let queuedJob: { attempts?: number; delivery?: string } | undefined;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/webhook/process") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
            attempts?: number;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-busy",
            event: "issues",
            delivery: "delivery-busy",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            throw new Error("durably requeued webhook should not retry the original message");
          },
        },
      ],
    },
    {
      DASHBOARD_LOCKS: locks,
      REFRESH_QUEUE: {
        async send(
          job: { attempts?: number; delivery?: string },
          options?: { delaySeconds?: number },
        ) {
          queuedJob = job;
          queuedDelaySeconds = options?.delaySeconds;
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, true);
  assert.equal(queuedJob?.delivery, "delivery-busy");
  assert.equal(queuedJob?.attempts, 48);
  assert.equal(queuedDelaySeconds, 20);
});

test("terminal webhook fanout clears admission and processing deduplication", async () => {
  const abandoned: string[] = [];
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/webhook/abandon") {
          abandoned.push(id);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const cache = {
    ...kvStore(),
    async list() {
      throw new Error("fanout page failed");
    },
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal",
            event: "push",
            delivery: "delivery-fanout-terminal",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: () => undefined },
  );

  assert.deepEqual(abandoned.sort(), ["github-webhook-admission", "github-webhook-process:owner"]);
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
});

test("terminal webhook fanout retries when durable abandonment fails", async () => {
  let acknowledged = false;
  let retried = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 500 }),
    }),
  };
  const cache = {
    ...kvStore(),
    async list() {
      throw new Error("fanout page failed");
    },
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal-abandon-failed",
            event: "push",
            delivery: "delivery-fanout-terminal-abandon-failed",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(acknowledged, false);
  assert.equal(retried, true);
});

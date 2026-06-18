import { readFile } from "node:fs/promises";

import type { DashboardPayload, Project, SchedulerAuditEvent } from "../../src/types.js";
import { DashboardBuildLock } from "../../worker/index.js";

const textEncoder = new TextEncoder();

const systemDate = Date;

const testClockStartedAt = systemDate.now();

const testClockEpoch = systemDate.parse("2026-06-13T12:00:00Z");

class TestDate extends systemDate {
  constructor(value?: string | number) {
    super(value === undefined ? TestDate.now() : value);
  }

  static override now(): number {
    return testClockEpoch + systemDate.now() - testClockStartedAt;
  }
}

globalThis.Date = TestDate as DateConstructor;

export async function socialRenderAsset(request: Request, paths?: string[]): Promise<Response> {
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

export function kvStore(initial: Record<string, string> = {}) {
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

export function durableLocks(env: ConstructorParameters<typeof DashboardBuildLock>[1]) {
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

export async function refreshAuditEvents(
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

export async function githubAccessRouteRecords(cache: ReturnType<typeof kvStore>): Promise<
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

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function signedJson(secret: string, value: unknown): Promise<string> {
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

export async function webhookSignature(secret: string, body: string): Promise<string> {
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

export function crawlerRequest(
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

export function testProject(
  overrides: Partial<Project> & Pick<Project, "owner" | "name">,
): Project {
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

export function testDashboard(owner: string, projects: Project[]): DashboardPayload {
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

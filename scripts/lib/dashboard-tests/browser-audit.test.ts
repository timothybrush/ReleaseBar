import assert from "node:assert/strict";
import test from "node:test";
import { isGitHubRateLimit } from "../../../src/rate-limit.js";
import worker from "../../../worker/index.js";
import {
  githubAccessRouteRecords,
  kvStore,
  refreshAuditEvents,
} from "../dashboard-test-harness.js";

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

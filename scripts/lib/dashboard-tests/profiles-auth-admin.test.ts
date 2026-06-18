import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type {
  AuthFunnelSummary,
  DashboardPayload,
  GitHubAccessSummary,
  RefreshJob,
  RefreshTarget,
  SchedulerAdminPayload,
} from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, signedJson, testDashboard } from "../dashboard-test-harness.js";

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

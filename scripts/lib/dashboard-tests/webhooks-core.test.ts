import assert from "node:assert/strict";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type {
  DashboardPayload,
  OwnerActivityPayload,
  Project,
  RepoDetailPayload,
  RefreshTarget,
} from "../../../src/types.js";
import worker, { DashboardBuildLock } from "../../../worker/index.js";
import {
  durableLocks,
  kvStore,
  testDashboard,
  testProject,
  webhookSignature,
} from "../dashboard-test-harness.js";

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

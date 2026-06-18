import assert from "node:assert/strict";
import test from "node:test";
import type {
  OwnerActivityPayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { kvStore, testProject } from "../dashboard-test-harness.js";

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

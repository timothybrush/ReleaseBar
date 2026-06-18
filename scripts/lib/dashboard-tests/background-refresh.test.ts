import assert from "node:assert/strict";
import test from "node:test";
import type {
  OwnerActivityPayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { crawlerRequest, kvStore, testProject } from "../dashboard-test-harness.js";

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

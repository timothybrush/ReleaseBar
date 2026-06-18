import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateAudienceScore, isLikelyBot } from "../audience.js";
import {
  dashboardRoute,
  ownerActivityFromPath,
  ownerActivityPath,
  ownerDashboardPath,
  ownerFromPath,
  fallbackApiOrigin,
  repoDetailPath,
  repoFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../../src/routing.js";
import {
  matchesProjectSearch,
  parseViewState,
  showCodeChurn,
  sortProjects,
  viewStateSearch,
  type DashboardViewState,
} from "../../../src/dashboard-view.js";
import type { DashboardPayload, RepoDetailPayload } from "../../../src/types.js";
import { dashboardStreamSignature, dashboardStreamState } from "../../../worker/index.js";
import { testDashboard, testProject } from "../dashboard-test-harness.js";

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
  const source = await readFile("src/components/OwnerActivityPage.svelte", "utf8");
  assert.match(source, /<details class="activity-event-details">/);
  assert.doesNotMatch(source, /<details class="activity-event-details"[^>]*\bopen(?:=|\s|>)/);
});

test("owner activity range links use the reserved-safe route helper", async () => {
  const source = await readFile("src/components/OwnerActivityPage.svelte", "utf8");
  assert.match(source, /ownerActivityPath\(activityPageRoute\.owner, range\)/);
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

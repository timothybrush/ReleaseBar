import { slugOwner } from "../scripts/lib/dashboard.js";
import type {
  ActivityRange,
  ApiQuota,
  Owner,
  OwnerActivityEvent,
  OwnerActivityPayload,
  OwnerActivityRepository,
  OwnerActivityRepositorySummary,
  OwnerActivitySummary,
  RepoDetailActivityPayload,
} from "../src/types.js";
import { sha256Base64Url } from "./crypto.js";
import { auditGitHubFetch, quotaFromGitHubResponse } from "./github-audit.js";
import type { Env } from "./runtime.js";
import { type GitHubPublicEvent, gitHubPublicEventListSchema, tryJsonParse } from "./schemas.js";
import {
  activityEventPageLimit,
  activityForkLookupBatchSize,
  activityRepositorySummaryLimit,
  activitySummaryInputLimit,
  activitySummaryPromptVersion,
  activitySummaryRepositoryEventLimit,
  dashboardStorageTtlSeconds,
} from "./config.js";
import { privateRepositoryNames } from "./owner-metadata-read.js";
import { commitTitle } from "./release-summary.js";
import { activityRangeMs, detailGitHubJson } from "./repo-github.js";

export function ownerActivitySummaryCacheKey(
  owner: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `owner-activity-summary:v${activitySummaryPromptVersion}`,
    slugOwner(owner),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

export function repoActivityCacheKey(owner: string, repo: string, range: ActivityRange): string {
  return `repo-activity:v1:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

export function repoActivitySummaryCacheKey(
  fullName: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `repo-activity-summary:v${activitySummaryPromptVersion}`,
    fullName.toLowerCase(),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

export function ownerActivityAgeMs(payload: OwnerActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export async function readOwnerActivity(
  env: Env,
  key: string,
): Promise<OwnerActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivityPayload>(raw, `owner activity ${key}`) : null;
}

export async function writeOwnerActivity(
  env: Env,
  key: string,
  payload: OwnerActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readRepoActivity(
  env: Env,
  key: string,
): Promise<RepoDetailActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailActivityPayload>(raw, `repo activity ${key}`) : null;
}

export async function writeRepoActivity(
  env: Env,
  key: string,
  payload: RepoDetailActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readOwnerActivitySummary(
  env: Env,
  key: string,
): Promise<OwnerActivitySummary | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivitySummary>(raw, `owner activity summary ${key}`) : null;
}

export async function writeOwnerActivitySummary(
  env: Env,
  key: string,
  summary: OwnerActivitySummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function payloadString(value: unknown, key: string): string | null {
  const result = payloadRecord(value)[key];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

export function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return payloadRecord(payloadRecord(value)[key]);
}

export function nestedString(value: unknown, key: string, nestedKey: string): string | null {
  const result = nestedRecord(value, key)[nestedKey];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

export function activityRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

export function normalizeActivityEvent(event: GitHubPublicEvent): OwnerActivityEvent | null {
  if (event.public === false) return null;
  const repo = event.repo?.name?.trim() ?? "";
  const payload = event.payload;
  const createdAt = event.created_at;
  if (!repo || !createdAt) return null;
  const repoUrl = activityRepoUrl(repo);

  if (event.type === "PushEvent") {
    const payloadData = payloadRecord(payload);
    const commits = payloadData.commits;
    const commitList = Array.isArray(commits) ? commits : [];
    const titles = commitList
      .map((commit) => commitTitle(payloadString(commit, "message") ?? ""))
      .filter(Boolean);
    const size = Number(payloadData.size ?? 0);
    const count = Math.max(1, titles.length, Number.isFinite(size) ? size : 0);
    return {
      id: event.id,
      kind: "commit",
      title:
        titles[0] && count > 1
          ? `${titles[0]} +${count - 1} commits`
          : (titles[0] ?? `${count} commit${count === 1 ? "" : "s"}`),
      repo,
      url: repoUrl,
      createdAt,
      count,
    };
  }

  if (event.type === "PullRequestEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} PR: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "PullRequestReviewEvent") {
    const action = payloadString(payload, "action") ?? "reviewed";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} review: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssuesEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "issue",
      title: `${action} issue: ${title}`,
      repo,
      url: nestedString(payload, "issue", "html_url") ?? `${repoUrl}/issues`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssueCommentEvent") {
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "comment",
      title: `commented on: ${title}`,
      repo,
      url:
        nestedString(payload, "comment", "html_url") ?? nestedString(payload, "issue", "html_url"),
      createdAt,
      count: 1,
    };
  }

  if (event.type === "ReleaseEvent") {
    const action = payloadString(payload, "action") ?? "published";
    const tag = nestedString(payload, "release", "tag_name");
    const name = nestedString(payload, "release", "name");
    return {
      id: event.id,
      kind: "release",
      title: `${action} release: ${name || tag || repo}`,
      repo,
      url: nestedString(payload, "release", "html_url") ?? `${repoUrl}/releases`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "CreateEvent") {
    const refType = payloadString(payload, "ref_type") ?? "thing";
    const ref = payloadString(payload, "ref");
    return {
      id: event.id,
      kind: "repository",
      title: `created ${refType}${ref ? ` ${ref}` : ""}`,
      repo,
      url: repoUrl,
      createdAt,
      count: 1,
    };
  }

  return {
    id: event.id,
    kind: "other",
    title: event.type
      .replace(/Event$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase(),
    repo,
    url: repoUrl,
    createdAt,
    count: 1,
  };
}

export async function fetchOwnerActivityEvents(
  owner: Owner,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  const base =
    owner.type === "org"
      ? `/orgs/${encodeURIComponent(owner.login)}/events`
      : `/users/${encodeURIComponent(owner.login)}/events/public`;
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${base}?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "owner public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "owner-activity",
      undefined,
      env,
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export type ActivityForkNode = {
  isFork?: boolean;
  parent?: {
    owner?: {
      login?: string | null;
    } | null;
  } | null;
};

export type ActivityForkResponse = {
  data?: Record<string, ActivityForkNode | null>;
  errors?: Array<{ message?: string; type?: string }>;
};

export async function filterForksOfOwner(
  owner: Owner,
  events: OwnerActivityEvent[],
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<OwnerActivityEvent[]> {
  if (!token || events.length === 0) return events;
  const ownerLogin = owner.login.toLowerCase();
  const repositories = [
    ...new Set(
      events
        .map((event) => event.repo)
        .filter((fullName) => {
          const [repoOwner, repo] = fullName.split("/");
          return Boolean(repoOwner && repo && repoOwner.toLowerCase() !== ownerLogin);
        }),
    ),
  ];
  if (repositories.length === 0) return events;

  const forksOfOwner = new Set<string>();
  const githubFetch = auditGitHubFetch("owner-activity", quotaSource, quotaAccount, env);
  try {
    for (let offset = 0; offset < repositories.length; offset += activityForkLookupBatchSize) {
      const batch = repositories.slice(offset, offset + activityForkLookupBatchSize);
      const definitions: string[] = [];
      const fields: string[] = [];
      const variables: Record<string, string> = {};
      batch.forEach((fullName, index) => {
        const [repoOwner, repo] = fullName.split("/");
        definitions.push(`$owner${index}: String!`, `$name${index}: String!`);
        variables[`owner${index}`] = repoOwner ?? "";
        variables[`name${index}`] = repo ?? "";
        fields.push(`
          repo${index}: repository(owner: $owner${index}, name: $name${index}) {
            isFork
            parent {
              owner {
                login
              }
            }
          }
        `);
      });
      const query = `
        query ReleaseBarActivityForkOrigins(${definitions.join(", ")}) {
          ${fields.join("\n")}
        }
      `;
      const response = await githubFetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
      });
      onQuota(quotaFromGitHubResponse(response, quotaSource, quotaAccount));
      const body = (await response.json().catch(() => null)) as ActivityForkResponse | null;
      if (!response.ok || !body?.data) break;
      batch.forEach((fullName, index) => {
        const repository = body.data?.[`repo${index}`];
        if (repository?.isFork && repository.parent?.owner?.login?.toLowerCase() === ownerLogin) {
          forksOfOwner.add(fullName.toLowerCase());
        }
      });
    }
  } catch {
    // Keep successfully resolved fork matches if a later batch fails.
  }
  return events.filter((event) => !forksOfOwner.has(event.repo.toLowerCase()));
}

export async function fetchRepoActivityEvents(
  path: string,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${path}/events?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "repository public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "repo-activity",
      undefined,
      env,
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function activityRepositories(events: OwnerActivityEvent[]): OwnerActivityRepository[] {
  const repos = new Map<string, OwnerActivityRepository>();
  for (const event of events) {
    const existing = repos.get(event.repo) ?? {
      fullName: event.repo,
      url: activityRepoUrl(event.repo),
      events: 0,
      commits: 0,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      lastActiveAt: event.createdAt,
    };
    existing.events += event.count;
    existing.commits += event.kind === "commit" ? event.count : 0;
    existing.pullRequests += event.kind === "pull_request" ? event.count : 0;
    existing.issues += event.kind === "issue" ? event.count : 0;
    existing.comments += event.kind === "comment" ? event.count : 0;
    existing.releases += event.kind === "release" ? event.count : 0;
    if (Date.parse(event.createdAt) > Date.parse(existing.lastActiveAt)) {
      existing.lastActiveAt = event.createdAt;
    }
    repos.set(event.repo, existing);
  }
  return [...repos.values()].sort(
    (a, b) =>
      b.events - a.events ||
      Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) ||
      a.fullName.localeCompare(b.fullName),
  );
}

export function activityTotals(events: OwnerActivityEvent[]): OwnerActivityPayload["totals"] {
  return {
    events: events.reduce((sum, event) => sum + event.count, 0),
    commits: events
      .filter((event) => event.kind === "commit")
      .reduce((sum, event) => sum + event.count, 0),
    pullRequests: events.filter((event) => event.kind === "pull_request").length,
    issues: events.filter((event) => event.kind === "issue").length,
    comments: events.filter((event) => event.kind === "comment").length,
    releases: events.filter((event) => event.kind === "release").length,
    repositories: new Set(events.map((event) => event.repo)).size,
  };
}

export function activityEventsForCurrentRange(
  events: OwnerActivityEvent[],
  range: ActivityRange,
): OwnerActivityEvent[] {
  const since = Date.now() - activityRangeMs(range);
  return events.filter((event) => {
    const createdAt = Date.parse(event.createdAt);
    return Number.isFinite(createdAt) && createdAt >= since;
  });
}

export async function publicOwnerActivity(
  env: Env,
  payload: OwnerActivityPayload,
): Promise<OwnerActivityPayload | null> {
  const privateNames = await privateRepositoryNames(
    env,
    payload.events.map((event) => event.repo),
  );
  if (!privateNames) return null;
  const events = activityEventsForCurrentRange(payload.events, payload.range).filter(
    (event) => !privateNames.has(event.repo.toLowerCase()),
  );
  const current = {
    ...payload,
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  if (events.length === payload.events.length) return current;
  return {
    ...current,
    summary: await activitySummaryState(current, env),
  };
}

export function activitySummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

export type ActivitySummaryPayload = Pick<OwnerActivityPayload, "events" | "repositories">;

export function activitySummaryEvents(payload: ActivitySummaryPayload): OwnerActivityEvent[] {
  const selected: OwnerActivityEvent[] = [];
  const selectedIds = new Set<string>();
  const eventsByRepository = new Map<string, OwnerActivityEvent[]>();
  for (const event of payload.events) {
    const events = eventsByRepository.get(event.repo) ?? [];
    events.push(event);
    eventsByRepository.set(event.repo, events);
  }
  for (const repo of payload.repositories.slice(0, activityRepositorySummaryLimit)) {
    for (const event of (eventsByRepository.get(repo.fullName) ?? []).slice(
      0,
      activitySummaryRepositoryEventLimit,
    )) {
      selected.push(event);
      selectedIds.add(event.id);
    }
  }
  for (const event of payload.events) {
    if (selected.length >= activitySummaryInputLimit) break;
    if (selectedIds.has(event.id)) continue;
    selected.push(event);
    selectedIds.add(event.id);
  }
  return selected.slice(0, activitySummaryInputLimit);
}

export function activitySummaryInput(payload: ActivitySummaryPayload): string {
  const summaryEvents = activitySummaryEvents(payload);
  if (summaryEvents.length === 0) return "";
  const targetRepositories = payload.repositories.slice(0, activityRepositorySummaryLimit);
  const targetNames = new Set(targetRepositories.map((repo) => repo.fullName));
  const repositoryByName = new Map(payload.repositories.map((repo) => [repo.fullName, repo]));
  const eventsByRepository = new Map<string, OwnerActivityEvent[]>();
  for (const event of summaryEvents) {
    const events = eventsByRepository.get(event.repo) ?? [];
    events.push(event);
    eventsByRepository.set(event.repo, events);
  }
  const orderedRepositories = [
    ...targetRepositories,
    ...[...eventsByRepository.keys()]
      .filter((fullName) => !targetNames.has(fullName))
      .map((fullName) => repositoryByName.get(fullName))
      .filter((repo): repo is OwnerActivityRepository => repo !== undefined),
  ];
  return orderedRepositories
    .map((repo) => {
      const totals = [
        `${repo.events} items`,
        repo.commits > 0 ? `${repo.commits} commits` : "",
        repo.pullRequests > 0 ? `${repo.pullRequests} PR${repo.pullRequests === 1 ? "" : "s"}` : "",
        repo.issues > 0 ? `${repo.issues} issue${repo.issues === 1 ? "" : "s"}` : "",
        repo.comments > 0 ? `${repo.comments} comment${repo.comments === 1 ? "" : "s"}` : "",
        repo.releases > 0 ? `${repo.releases} release${repo.releases === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      const events = (eventsByRepository.get(repo.fullName) ?? []).map(
        (event) => `- ${event.kind}${event.count > 1 ? ` x${event.count}` : ""}: ${event.title}`,
      );
      return [
        `Repository: ${repo.fullName}`,
        `Summary target: ${targetNames.has(repo.fullName) ? "yes" : "no (overall only)"}`,
        `Totals: ${totals.join("; ")}`,
        "Work:",
        ...events,
      ].join("\n");
    })
    .join("\n\n");
}

export function unavailableActivitySummary(
  model: string | null,
  inputHash: string | null,
  message: string,
): OwnerActivitySummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed: 0,
    promptVersion: activitySummaryPromptVersion,
    message,
  };
}

export async function activitySummaryState(
  payload: ActivitySummaryPayload & Pick<OwnerActivityPayload, "owner" | "range">,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = ownerActivitySummaryCacheKey(
    payload.owner.login,
    payload.range,
    model,
    inputHash,
  );
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

export function activitySummaryInstructions(structured = false): string {
  return [
    "You write the working-on paragraph for ReleaseBar owner dashboards.",
    "The UI already says this is a GitHub dashboard, shows the selected time range, and lists commit/PR/issue totals, so do not restate those facts.",
    "Do not use filler like public GitHub activity, recent activity, events, commits, PRs, has been working on, centered on, or touched repositories.",
    "Start with concrete work: systems, fixes, releases, docs, integrations, repo names, and themes that are directly supported by the event titles.",
    "For the overall or single-repository summary, write 2-3 useful sentences, no bullets, no markdown, no hype.",
    "Do not infer private work, intentions, employers, or impact beyond the event titles.",
    ...(structured
      ? [
          'Return only JSON in this shape: {"summary":"overall summary","repositories":[{"fullName":"owner/repo","summary":"one concise sentence"}]}.',
          `Include one repository entry for every block marked Summary target: yes, up to ${activityRepositorySummaryLimit}, in the same order.`,
          "Use blocks marked Summary target: no only in the overall summary; do not return repository entries for them.",
          "Each repository summary may use one or two short sentences. When several concrete work items are available, connect the main themes in roughly 28-50 words; when the input is sparse or generic, stay brief and factual instead of padding.",
          "Do not write a counting-only summary such as commits were added or ongoing updates when any concrete work title is available.",
        ]
      : []),
  ].join(" ");
}

export function ownerActivitySummaryOutputTokens(repositoryCount: number): number {
  const boundedCount = Math.min(repositoryCount, activityRepositorySummaryLimit);
  return Math.max(2_200, Math.min(3_050, 500 + boundedCount * 85));
}

export function polishActivitySummaryText(text: string): string {
  return text
    .replace(/\bpublic GitHub activity\b/gi, "work")
    .replace(/\bGitHub activity\b/gi, "work")
    .replace(/\bpublic activity\b/gi, "work")
    .replace(/\brecent activity\b/gi, "work")
    .replace(/\bActivity also touched\b/g, "Also touched")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseOwnerActivitySummaryText(
  text: string,
  repositories: OwnerActivityRepository[],
): Pick<OwnerActivitySummary, "text" | "repositories"> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { summary?: unknown; repositories?: unknown };
  if (typeof record.summary !== "string" || !record.summary.trim()) return null;
  const expected = new Map(
    repositories
      .slice(0, activityRepositorySummaryLimit)
      .map((repository) => [repository.fullName.toLowerCase(), repository.fullName]),
  );
  if (!Array.isArray(record.repositories) || record.repositories.length !== expected.size)
    return null;
  const summaries = new Map<string, OwnerActivityRepositorySummary>();
  for (const candidate of record.repositories) {
    if (!candidate || typeof candidate !== "object") return null;
    const value = candidate as { fullName?: unknown; summary?: unknown };
    const key = typeof value.fullName === "string" ? value.fullName.trim().toLowerCase() : "";
    const fullName = expected.get(key);
    const summary =
      typeof value.summary === "string" ? polishActivitySummaryText(value.summary) : "";
    if (!fullName || !summary || summaries.has(key)) return null;
    summaries.set(key, { fullName, text: summary });
  }
  if ([...expected.keys()].some((key) => !summaries.has(key))) return null;
  return {
    text: polishActivitySummaryText(record.summary),
    repositories: [...expected.keys()].map((key) => summaries.get(key)!),
  };
}

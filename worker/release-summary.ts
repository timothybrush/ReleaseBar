import { slugOwner } from "../scripts/lib/dashboard.js";
import type {
  ApiQuota,
  Project,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
} from "../src/types.js";
import { workerFetch } from "./http.js";
import type { Env } from "./runtime.js";
import {
  gitHubCheckRunsSchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  tryJsonParse,
} from "./schemas.js";
import type { InferOutput } from "valibot";
import { cachedUserTrustSignals } from "./audience-data.js";
import { bestInstallationToken } from "./auth-tokens.js";
import {
  dashboardStorageTtlSeconds,
  releaseSummaryCommitLimit,
  releaseSummaryPromptVersion,
  type UserTrustSignal,
} from "./config.js";
import { isGitHubRateLimit } from "./dashboard-cache.js";
import { detailGitHubJson } from "./repo-github.js";

export function repoDetailCacheKey(owner: string, repo: string): string {
  return `repo-detail:v4:${slugOwner(owner)}/${repo.toLowerCase()}`;
}

export function releaseSummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

export function releaseSummaryCacheKey(project: Project, model: string): string | null {
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return null;
  }
  return [
    `release-summary:v${releaseSummaryPromptVersion}`,
    project.fullName.toLowerCase(),
    encodeURIComponent(project.version),
    project.latestCommitSha,
    encodeURIComponent(model),
  ].join(":");
}

export async function readRepoDetail(env: Env, key: string): Promise<RepoDetailPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailPayload>(raw, `repo detail ${key}`) : null;
}

export async function writeRepoDetail(
  env: Env,
  key: string,
  payload: RepoDetailPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readReleaseSummary(
  env: Env,
  key: string | null,
): Promise<RepoDetailReleaseSummary | null> {
  if (!key) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailReleaseSummary>(raw, `release summary ${key}`) : null;
}

export async function writeReleaseSummary(
  env: Env,
  key: string,
  summary: RepoDetailReleaseSummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function repoDetailAgeMs(payload: RepoDetailPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export function withRepoDetailState(
  payload: RepoDetailPayload,
  state: RepoDetailPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

export async function optionalRepoDetail<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isGitHubRateLimit(error)) throw error;
    return fallback;
  }
}

export function unavailableReleaseSummary(
  project: Project,
  model: string | null,
  message: string,
): RepoDetailReleaseSummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.releaseDate ? project.version : null,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message,
  };
}

export async function releaseSummaryState(
  project: Project,
  env: Env,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!project.releaseDate || project.version === "unreleased") {
    return unavailableReleaseSummary(project, model, "No prior release to summarize.");
  }
  if (!project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "Latest commit is unavailable.");
  }
  if (project.commitsSinceRelease === null) {
    return unavailableReleaseSummary(project, model, "Commit comparison is unavailable.");
  }
  if (project.commitsSinceRelease === 0) {
    return {
      state: "ready",
      text: "No commits have landed since the latest release.",
      generatedAt: new Date().toISOString(),
      model,
      releaseTag: project.version,
      headSha: project.latestCommitSha,
      commitCount: 0,
      commitsUsed: 0,
    };
  }
  const key = releaseSummaryCacheKey(project, model);
  const cached = await readReleaseSummary(env, key);
  if (cached?.state === "ready") return cached;
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message: "Summarizing commits since the latest release.",
  };
}

export function commitTitle(message: string): string {
  return message.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
}

export async function compareCommitTitles(
  path: string,
  releaseTag: string,
  head: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<{ titles: string[]; total: number | null }> {
  const titles: string[] = [];
  let total: number | null = null;
  for (let page = 1; titles.length < releaseSummaryCommitLimit; page += 1) {
    const compare = await detailGitHubJson(
      `${path}/compare/${encodeURIComponent(releaseTag)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      gitHubCompareSchema,
      "release summary compare",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "release-summary",
      undefined,
      env,
    );
    total = compare.total_commits ?? total;
    const pageTitles = (compare.commits ?? [])
      .map((commit) => commitTitle(commit.commit.message))
      .filter(Boolean);
    titles.push(...pageTitles);
    if (pageTitles.length === 0 || (total !== null && titles.length >= total)) break;
  }
  return { titles: titles.slice(0, releaseSummaryCommitLimit), total };
}

export function openAIOutputText(body: unknown): string {
  if (body && typeof body === "object" && "output_text" in body) {
    const text = (body as { output_text?: unknown }).output_text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const output = body && typeof body === "object" ? (body as { output?: unknown }).output : null;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => {
      const content =
        item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function summarizeReleaseDelta(
  project: Project,
  path: string,
  request: Request,
  env: Env,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "No comparable release delta is available.");
  }
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [project.fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = () => undefined;
  const { titles, total } = await compareCommitTitles(
    path,
    project.version,
    project.latestCommitSha,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (titles.length === 0) {
    return unavailableReleaseSummary(
      project,
      model,
      "No commit titles were available to summarize.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 450,
      instructions:
        "You summarize public GitHub commit titles for release dashboards. Write 2-4 concise sentences, past tense, no bullets, no hype, no markdown. Mention broad themes and user-visible changes when commit titles support them. Do not invent details beyond the commit titles.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Repository: ${project.fullName}`,
                `Latest release: ${project.version}`,
                `Default branch head: ${project.latestCommitSha}`,
                `Commit titles included: ${titles.length} of ${total ?? project.commitsSinceRelease ?? titles.length}`,
                "",
                titles.map((title, index) => `${index + 1}. ${title}`).join("\n"),
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include summary text");
  return {
    state: "ready",
    text,
    generatedAt: new Date().toISOString(),
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: total ?? project.commitsSinceRelease,
    commitsUsed: titles.length,
  };
}

export type ContributorTrustSignal = UserTrustSignal;

export async function cachedContributorTrustSignals(
  env: Env,
  contributors: Array<InferOutput<typeof gitHubContributorSchema>>,
): Promise<Map<string, ContributorTrustSignal>> {
  const logins = Array.from(
    new Set(
      contributors
        .map((contributor) => contributor.login)
        .filter((login): login is string => Boolean(login))
        .map(slugOwner),
    ),
  );
  return cachedUserTrustSignals(env, logins);
}

export type RepoDetailCredential = {
  token: string | null;
  quotaSource: ApiQuota["source"];
  quotaAccount: string | null;
};

export type RepoDetailCore = {
  repo: InferOutput<typeof gitHubRepositorySchema>;
  releases: Array<InferOutput<typeof gitHubReleaseSchema>>;
  latestCommit: InferOutput<typeof gitHubCommitSchema> | null;
  openPullRequests: number;
  checks: InferOutput<typeof gitHubCheckRunsSchema> | null;
};

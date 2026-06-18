import { attentionReasons, matchesProjectSearch } from "./dashboard-view.js";
import type { DashboardRoute } from "./routing.js";
import type {
  ApiQuota,
  DashboardPayload,
  Owner,
  OwnerActivityPayload,
  Project,
  RepoAudiencePayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
  TrustProfilePayload,
} from "./types.js";

export function dashboardOwnerLabel(payload: DashboardPayload, route: DashboardRoute): string {
  if (route.isDefault) return payload.title || "ReleaseBar Hot";
  if (payload.owners.length > 0) {
    const [first] = payload.owners;
    const extraCount = route.extraOwners.length + route.repos.length;
    return `${first ? `@${first.login}` : "custom"}${extraCount > 0 ? ` +${extraCount}` : ""}`;
  }
  if (route.repos.length === 1) return route.repos[0] ?? "custom deck";
  return route.repos.length > 1 ? `custom deck +${route.repos.length}` : route.label;
}

export function dashboardOwner(
  payload: DashboardPayload | null,
  route: DashboardRoute,
  hasRepoRoute: boolean,
): Owner | null {
  if (hasRepoRoute || route.isDefault || !route.owner) return null;
  return payload?.owners[0] ?? { type: "user", login: route.owner };
}

export function githubOwnerAvatar(owner: Owner): string {
  return owner.avatarUrl ?? `https://github.com/${encodeURIComponent(owner.login)}.png?size=160`;
}

export function githubProjectOwnerAvatar(
  project: Project,
  payload: DashboardPayload | null,
): string {
  const owner = payload?.owners.find(
    (candidate) => candidate.login.toLowerCase() === project.owner.toLowerCase(),
  );
  return owner?.avatarUrl ?? `https://github.com/${encodeURIComponent(project.owner)}.png?size=80`;
}

export function matchesDashboardProject(
  project: Project,
  searchQuery: string,
  languageQuery: string,
  hiddenOwners: Set<string>,
  hiddenRepos: Set<string>,
  includeArchived: boolean,
): boolean {
  if (project.archived && !includeArchived) return false;
  if (hiddenOwners.has(project.owner.toLowerCase())) return false;
  if (hiddenRepos.has(project.fullName.toLowerCase())) return false;
  if (languageQuery && project.language?.toLowerCase() !== languageQuery.toLowerCase())
    return false;
  return matchesProjectSearch(project, searchQuery);
}

export const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
});
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function countLabel(value: number | null): string {
  return value === null ? "—" : numberFormat.format(value);
}

export function openWorkCount(project: Project): number | null {
  return project.openIssues === null || project.openPullRequests === null
    ? null
    : project.openIssues + project.openPullRequests;
}

function daysAgo(value: string | null): number | null {
  if (!value) return null;
  return Math.round((Date.parse(value) - Date.now()) / 86400000);
}

export function absoluteDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : "no release";
}

export function relativeDate(value: string | null): string {
  const days = daysAgo(value);
  if (days === null) return "never";
  if (Math.abs(days) < 7) {
    if (days === 0) return "today";
    if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`;
    return `in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (Math.abs(days) < 45) return relativeFormat.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 18) return relativeFormat.format(months, "month");
  return relativeFormat.format(Math.round(months / 12), "year");
}

export function relativeReset(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const diffMs = time - Date.now();
  if (Math.abs(diffMs) < 90 * 60 * 1000) {
    return relativeFormat.format(Math.round(diffMs / 60000), "minute");
  }
  if (Math.abs(diffMs) < 36 * 60 * 60 * 1000) {
    return `${relativeFormat.format(Math.round(diffMs / 3600000), "hour")} at ${timeFormat.format(new Date(time))}`;
  }
  return `${absoluteDate(value)} at ${timeFormat.format(new Date(time))}`;
}

export function shortDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : "never";
}

export function maxNumber(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0);
}

export function percent(value: number, max: number): number {
  if (value <= 0) return 0;
  return max <= 0 ? 0 : Math.max(4, Math.round((value / max) * 100));
}

export function percentOfTotal(value: number, total: number): number {
  return total <= 0 ? 0 : Math.round((value / total) * 100);
}

export function releaseSummaryMeta(summary: RepoDetailReleaseSummary): string {
  const count =
    summary.commitCount === null ? "" : `${numberFormat.format(summary.commitCount)} commits`;
  const used =
    summary.commitsUsed > 0 && summary.commitCount !== summary.commitsUsed
      ? `${numberFormat.format(summary.commitsUsed)} summarized`
      : "";
  return [count, used, summary.model ?? ""].filter(Boolean).join(" · ");
}

export function repoActivityMeta(payload: RepoDetailActivityPayload): string {
  const events = `${numberFormat.format(payload.totals.events)} public event${payload.totals.events === 1 ? "" : "s"}`;
  const range =
    payload.range === "day"
      ? "in the last day"
      : payload.range === "week"
        ? "in the last week"
        : "in the last month";
  return `${events} ${range} · updated ${relativeDate(payload.generatedAt)}`;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : Math.round(sorted[middle] ?? 0);
}

export function cadenceSummary(releases: RepoDetailPayload["releases"]): {
  medianDays: number | null;
  latestGapDays: number | null;
  releaseCount: number;
} {
  const dates = releases
    .map((release) => (release.publishedAt ? Date.parse(release.publishedAt) : Number.NaN))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const gaps = dates
    .slice(0, -1)
    .map((date, index) => Math.round((date - (dates[index + 1] ?? date)) / 86400000))
    .filter((days) => days >= 0);
  return {
    medianDays: median(gaps),
    latestGapDays: gaps[0] ?? null,
    releaseCount: dates.length,
  };
}

export function formatDays(value: number | null): string {
  return value === null ? "n/a" : `${numberFormat.format(value)}d`;
}

export function detailValueStyle(value: string | number | null): string {
  const length = String(value ?? "").length;
  const size = length > 22 ? 24 : length > 16 ? 30 : length > 12 ? 34 : 42;
  return `--detail-value-size: ${size}px; --detail-fit-size: ${size}px`;
}

export function fitDetailValue(node: HTMLElement, _value: string | number | null) {
  let frame = 0;
  const minSize = 20;
  const preferredSize = (): number => {
    const parsed = Number.parseFloat(
      getComputedStyle(node).getPropertyValue("--detail-value-size"),
    );
    return Number.isFinite(parsed) ? parsed : 42;
  };
  const fit = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const preferred = preferredSize();
      node.style.setProperty("--detail-fit-size", `${preferred}px`);
      const rendered = Number.parseFloat(getComputedStyle(node).fontSize);
      const base = Number.isFinite(rendered) ? rendered : preferred;
      const next =
        node.clientWidth > 0 && node.scrollWidth > node.clientWidth
          ? Math.max(minSize, Math.floor(base * (node.clientWidth / node.scrollWidth) * 0.96))
          : preferred;
      node.style.setProperty("--detail-fit-size", `${next}px`);
    });
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  observer?.observe(node);
  fit();
  return {
    update: fit,
    destroy() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    },
  };
}

export function attentionText(project: Project): string {
  const reasons = attentionReasons(project).slice(0, 3);
  return reasons.length > 0 ? reasons.join(" · ") : "looks okay";
}

export function ciLabel(project: Project): string {
  if (project.ciState === "unknown") return "no ci";
  if (project.ciState === "failure") return "fail";
  return project.ciState;
}

export function quotaLabel(quota: ApiQuota | undefined): string {
  if (!quota) return "";
  const source =
    quota.source === "app"
      ? `app quota${quota.account ? ` @${quota.account}` : ""}`
      : quota.source === "shared"
        ? "shared quota"
        : "anonymous quota";
  const remaining = quota.remaining === null ? "" : `${numberFormat.format(quota.remaining)} left`;
  const resetAt = quota.resetAt ? relativeReset(quota.resetAt) : "";
  return [source, remaining, resetAt ? `reset ${resetAt}` : ""].filter(Boolean).join(" · ");
}

export function activityMeta(payload: OwnerActivityPayload): string {
  const repos = `${numberFormat.format(payload.totals.repositories)} repo${payload.totals.repositories === 1 ? "" : "s"}`;
  const events = `${numberFormat.format(payload.totals.events)} public event${payload.totals.events === 1 ? "" : "s"}`;
  return `${events} · ${repos} · updated ${relativeDate(payload.generatedAt)}`;
}

export function activityBreakdown(
  repo: OwnerActivityPayload["repositories"][number],
): Array<{ label: string; value: number }> {
  return [
    { label: "commits", value: repo.commits },
    { label: "PRs", value: repo.pullRequests },
    { label: "issues", value: repo.issues },
    { label: "comments", value: repo.comments },
    { label: "releases", value: repo.releases },
  ].filter((item) => item.value > 0);
}

export function activityKindLabel(kind: OwnerActivityPayload["events"][number]["kind"]): string {
  if (kind === "pull_request") return "PR";
  if (kind === "repository") return "repo";
  return kind;
}

export function audienceTotalStargazers(payload: RepoAudiencePayload): number {
  return payload.totals.stargazers ?? payload.totals.stargazersSampled;
}

export function audienceShare(payload: RepoAudiencePayload, count: number, share: number): string {
  const value = Number.isFinite(share)
    ? share
    : payload.totals.stargazersSampled > 0
      ? Math.round((count / payload.totals.stargazersSampled) * 100)
      : 0;
  return `${numberFormat.format(value)}%`;
}

export function audienceReasonText(reasons: string[]): string {
  return reasons.length > 0 ? reasons.slice(0, 3).join(" · ") : "public profile signal";
}

export function audienceInsightText(user: RepoAudiencePayload["users"][number]): string {
  const orgs = user.orgs
    .slice(0, 2)
    .map((org) => `@${org.login}`)
    .join(", ");
  const topRepo = user.topRepositories[0];
  return [
    orgs ? `orgs ${orgs}` : "",
    topRepo ? `top repo ${topRepo.fullName} · ${numberFormat.format(topRepo.stars)} stars` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function trustProfileAge(payload: TrustProfilePayload): string {
  if (payload.accountAgeDays === null) return "age unknown";
  const years = payload.accountAgeDays / 365;
  if (years >= 1) return `${years.toFixed(years >= 10 ? 0 : 1)} years on GitHub`;
  return `${numberFormat.format(payload.accountAgeDays)} days on GitHub`;
}

export function trustDimensionEntries(payload: TrustProfilePayload): Array<[string, number]> {
  return payload.type === "org"
    ? [
        ["credibility", payload.dimensions.trust],
        ["repo footprint", payload.dimensions.builder],
        ["reach", payload.dimensions.influence],
        ["profile safety", payload.dimensions.risk],
      ]
    : [
        ["trust", payload.dimensions.trust],
        ["build", payload.dimensions.builder],
        ["reach", payload.dimensions.influence],
        ["account safety", payload.dimensions.risk],
      ];
}

export function factorContribution(value: number): string {
  if (value === 0) return "0.0";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

export function personTrustScoreTooltip(score: number): string {
  return `Trust score ${numberFormat.format(score)} — bounded public GitHub profile signal; triage context only.`;
}

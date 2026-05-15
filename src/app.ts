import type { CiState, DashboardPayload, Freshness, Project } from "./types.js";

type SortKey = "repo" | "version" | "release" | "since" | "activity" | "issues" | "prs" | "ci";
type SortDirection = "asc" | "desc";

const state = {
  data: null as DashboardPayload | null,
  query: "",
  filter: "all" as Freshness | "all",
  sortKey: "activity" as SortKey,
  sortDirection: "desc" as SortDirection,
  devMode: localStorage.getItem("releasedeck:dev-mode") === "true",
};

const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const elements = {
  generated: query<HTMLSpanElement>("#generated"),
  repoCount: query<HTMLSpanElement>("#repoCount"),
  releasedCount: query<HTMLSpanElement>("#releasedCount"),
  commitCount: query<HTMLSpanElement>("#commitCount"),
  staleCount: query<HTMLSpanElement>("#staleCount"),
  search: query<HTMLInputElement>("#search"),
  devMode: query<HTMLInputElement>("#devMode"),
  projects: query<HTMLDivElement>("#projects"),
  template: query<HTMLTemplateElement>("#projectRow"),
  sortButtons: document.querySelectorAll<HTMLButtonElement>("[data-sort]"),
};

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing ${selector}`);
  }
  return element;
}

function daysAgo(value: string | null): number | null {
  if (!value) return null;
  return Math.round((Date.parse(value) - Date.now()) / 86400000);
}

function absoluteDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : "no release";
}

function relativeDate(value: string | null): string {
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

function matches(project: Project): boolean {
  if (project.archived) return false;
  if (state.filter !== "all" && project.freshness !== state.filter) return false;
  if (!state.query) return true;
  const haystack = [
    project.fullName,
    project.description,
    project.language,
    project.version,
    project.freshness,
    project.ciState,
    project.ciWorkflow,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.query);
}

function tag(label: string, tone = ""): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `tag ${tone}`.trim();
  span.textContent = label;
  return span;
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function ciRank(project: Project): number {
  const rank: Record<CiState, number> = {
    failure: 7,
    cancelled: 6,
    running: 5,
    pending: 4,
    unknown: 3,
    skipped: 2,
    neutral: 1,
    success: 0,
  };
  return rank[project.ciState];
}

function sortValue(project: Project, sortKey: SortKey): string | number {
  switch (sortKey) {
    case "repo":
      return project.fullName.toLowerCase();
    case "version":
      return (project.version ?? "").toLowerCase();
    case "release":
      return timestamp(project.releaseDate);
    case "since":
      return project.commitsSinceRelease ?? -1;
    case "activity":
      return timestamp(project.latestCommitDate || project.pushedAt);
    case "issues":
      return project.openIssues;
    case "prs":
      return project.openPullRequests;
    case "ci":
      return ciRank(project);
  }
}

function sortProjects(projects: Project[]): Project[] {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const aValue = sortValue(a, state.sortKey);
    const bValue = sortValue(b, state.sortKey);
    if (typeof aValue === "string" && typeof bValue === "string") {
      return aValue.localeCompare(bValue) * direction;
    }
    return ((aValue as number) - (bValue as number)) * direction;
  });
}

function updateSortButtons(): void {
  elements.sortButtons.forEach((button) => {
    const sortKey = button.dataset.sort as SortKey;
    const active = sortKey === state.sortKey;
    if (active) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
    button.dataset.direction = active ? state.sortDirection : "";
  });
}

function issueLink(url: string, count: number): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = String(count);
  return link;
}

function ciLabel(project: Project): string {
  if (project.ciState === "unknown") {
    return "no ci";
  }
  if (project.ciState === "failure") {
    return "fail";
  }
  return project.ciState;
}

function renderProject(project: Project): DocumentFragment {
  const fragment = elements.template.content.cloneNode(true);
  if (!(fragment instanceof DocumentFragment)) {
    throw new Error("Project template did not clone to a document fragment");
  }

  const row = fragment.querySelector<HTMLElement>(".project");
  if (!row) {
    throw new Error("Project template is missing .project");
  }
  row.dataset.freshness = project.freshness;

  const link = fragment.querySelector<HTMLAnchorElement>(".repo-link");
  if (!link) {
    throw new Error("Project template is missing .repo-link");
  }
  link.href = project.url;
  link.textContent = project.fullName;

  const description = fragment.querySelector<HTMLParagraphElement>(".description");
  if (!description) {
    throw new Error("Project template is missing .description");
  }
  description.textContent = project.description || "no description";

  const tags = fragment.querySelector<HTMLDivElement>(".tags");
  if (!tags) {
    throw new Error("Project template is missing .tags");
  }
  if (project.language) tags.append(tag(project.language));
  tags.append(tag(`${numberFormat.format(project.stars)} stars`));
  if (project.archived) tags.append(tag("archived", "muted"));
  tags.append(tag(project.freshness));

  const version = fragment.querySelector<HTMLDivElement>(".version-cell");
  if (!version) {
    throw new Error("Project template is missing .version-cell");
  }
  const versionLink = document.createElement("a");
  versionLink.href = project.releaseUrl;
  versionLink.target = "_blank";
  versionLink.rel = "noreferrer";
  versionLink.textContent = project.version;
  version.append(versionLink);

  const release = fragment.querySelector<HTMLDivElement>(".release-cell");
  if (!release) {
    throw new Error("Project template is missing .release-cell");
  }
  release.innerHTML = `<strong>${absoluteDate(project.releaseDate)}</strong><span>${relativeDate(project.releaseDate)}</span>`;

  const since = fragment.querySelector<HTMLDivElement>(".since-cell");
  if (!since) {
    throw new Error("Project template is missing .since-cell");
  }
  if (project.compareUrl && project.commitsSinceRelease !== null) {
    const compare = document.createElement("a");
    compare.href = project.compareUrl;
    compare.target = "_blank";
    compare.rel = "noreferrer";
    compare.textContent = String(project.commitsSinceRelease);
    since.append(compare);
  } else {
    since.textContent = "n/a";
    since.classList.add("muted");
  }

  const activity = fragment.querySelector<HTMLDivElement>(".activity-cell");
  if (!activity) {
    throw new Error("Project template is missing .activity-cell");
  }
  activity.innerHTML = `<strong>${relativeDate(project.latestCommitDate || project.pushedAt)}</strong><span>${project.latestCommitSha || project.defaultBranch}</span>`;

  const issues = fragment.querySelector<HTMLDivElement>(".issues-cell");
  if (!issues) {
    throw new Error("Project template is missing .issues-cell");
  }
  issues.append(issueLink(project.issuesUrl, project.openIssues));

  const prs = fragment.querySelector<HTMLDivElement>(".prs-cell");
  if (!prs) {
    throw new Error("Project template is missing .prs-cell");
  }
  prs.append(issueLink(project.pullRequestsUrl, project.openPullRequests));

  const ci = fragment.querySelector<HTMLDivElement>(".ci-cell");
  if (!ci) {
    throw new Error("Project template is missing .ci-cell");
  }
  ci.dataset.ci = project.ciState;
  if (project.ciUrl) {
    const ciLink = document.createElement("a");
    ciLink.href = project.ciUrl;
    ciLink.target = "_blank";
    ciLink.rel = "noreferrer";
    ciLink.textContent = ciLabel(project);
    ci.append(ciLink);
  } else {
    ci.textContent = ciLabel(project);
  }
  if (project.ciWorkflow || project.ciRunDate) {
    const detail = document.createElement("span");
    detail.textContent = project.ciWorkflow || relativeDate(project.ciRunDate);
    ci.append(detail);
  }

  return fragment;
}

function render(): void {
  if (!state.data) {
    return;
  }

  const projects: Project[] = sortProjects(state.data.projects.filter(matches));
  document.body.classList.toggle("dev-mode", state.devMode);
  elements.projects.replaceChildren(...projects.map(renderProject));
  elements.repoCount.textContent = numberFormat.format(projects.length);
  elements.releasedCount.textContent = numberFormat.format(
    projects.filter((project) => project.version).length,
  );
  elements.commitCount.textContent = numberFormat.format(
    projects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0),
  );
  elements.staleCount.textContent = numberFormat.format(
    projects.filter((project) => ["hot", "busy"].includes(project.freshness)).length,
  );
  updateSortButtons();
}

async function boot(): Promise<void> {
  const response = await fetch(`./data/projects.json?v=${Date.now()}`, { cache: "no-store" });
  state.data = (await response.json()) as DashboardPayload;
  document.title = state.data.title;
  elements.generated.textContent = `updated ${relativeDate(state.data.generatedAt)}`;
  elements.devMode.checked = state.devMode;
  render();
}

elements.search.addEventListener("input", () => {
  state.query = elements.search.value.trim().toLowerCase();
  render();
});

elements.devMode.addEventListener("change", () => {
  state.devMode = elements.devMode.checked;
  if (!state.devMode && ["issues", "prs", "ci"].includes(state.sortKey)) {
    state.sortKey = "activity";
    state.sortDirection = "desc";
  }
  localStorage.setItem("releasedeck:dev-mode", String(state.devMode));
  render();
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = (button as HTMLElement).dataset.filter as Freshness | "all";
    render();
  });
});

elements.sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const sortKey = button.dataset.sort as SortKey;
    if (state.sortKey === sortKey) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = sortKey;
      state.sortDirection = ["repo", "version"].includes(sortKey) ? "asc" : "desc";
    }
    render();
  });
});

boot().catch((error) => {
  elements.generated.textContent = "failed";
  elements.projects.textContent = error instanceof Error ? error.message : String(error);
});

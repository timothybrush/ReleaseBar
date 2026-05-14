const state = {
  data: null,
  query: "",
  filter: "all"
};

const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });
const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const elements = {
  generated: document.querySelector("#generated"),
  repoCount: document.querySelector("#repoCount"),
  releasedCount: document.querySelector("#releasedCount"),
  commitCount: document.querySelector("#commitCount"),
  staleCount: document.querySelector("#staleCount"),
  search: document.querySelector("#search"),
  projects: document.querySelector("#projects"),
  template: document.querySelector("#projectRow")
};

function daysAgo(value) {
  if (!value) return null;
  return Math.round((Date.parse(value) - Date.now()) / 86400000);
}

function absoluteDate(value) {
  return value ? dateFormat.format(new Date(value)) : "no release";
}

function relativeDate(value) {
  const days = daysAgo(value);
  if (days === null) return "never";
  if (Math.abs(days) < 45) return relativeFormat.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 18) return relativeFormat.format(months, "month");
  return relativeFormat.format(Math.round(months / 12), "year");
}

function matches(project) {
  if (state.filter !== "all" && project.freshness !== state.filter) return false;
  if (!state.query) return true;
  const haystack = [
    project.fullName,
    project.description,
    project.language,
    project.version,
    project.freshness
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(state.query);
}

function tag(label, tone = "") {
  const span = document.createElement("span");
  span.className = `tag ${tone}`.trim();
  span.textContent = label;
  return span;
}

function renderProject(project) {
  const fragment = elements.template.content.cloneNode(true);
  const row = fragment.querySelector(".project");
  row.dataset.freshness = project.freshness;

  const link = fragment.querySelector(".repo-link");
  link.href = project.url;
  link.textContent = project.fullName;

  fragment.querySelector(".description").textContent = project.description || "no description";

  const tags = fragment.querySelector(".tags");
  if (project.language) tags.append(tag(project.language));
  tags.append(tag(`${numberFormat.format(project.stars)} stars`));
  if (project.archived) tags.append(tag("archived", "muted"));
  tags.append(tag(project.freshness));

  const version = fragment.querySelector(".version-cell");
  if (project.releaseUrl) {
    const versionLink = document.createElement("a");
    versionLink.href = project.releaseUrl;
    versionLink.target = "_blank";
    versionLink.rel = "noreferrer";
    versionLink.textContent = project.version;
    version.append(versionLink);
  } else {
    version.textContent = "unreleased";
    version.classList.add("muted");
  }

  const release = fragment.querySelector(".release-cell");
  release.innerHTML = `<strong>${absoluteDate(project.releaseDate)}</strong><span>${relativeDate(project.releaseDate)}</span>`;

  const since = fragment.querySelector(".since-cell");
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

  const activity = fragment.querySelector(".activity-cell");
  activity.innerHTML = `<strong>${relativeDate(project.latestCommitDate || project.pushedAt)}</strong><span>${project.latestCommitSha || project.defaultBranch}</span>`;

  return fragment;
}

function render() {
  const projects = state.data.projects.filter(matches);
  elements.projects.replaceChildren(...projects.map(renderProject));
  elements.repoCount.textContent = numberFormat.format(projects.length);
  elements.releasedCount.textContent = numberFormat.format(projects.filter((project) => project.version).length);
  elements.commitCount.textContent = numberFormat.format(projects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0));
  elements.staleCount.textContent = numberFormat.format(projects.filter((project) => ["hot", "busy", "unreleased"].includes(project.freshness)).length);
}

async function boot() {
  const response = await fetch("./data/projects.json");
  state.data = await response.json();
  document.title = state.data.title;
  elements.generated.textContent = `updated ${relativeDate(state.data.generatedAt)}`;
  render();
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    render();
  });
});

boot().catch((error) => {
  elements.generated.textContent = "failed";
  elements.projects.textContent = error.message;
});

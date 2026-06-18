<script lang="ts">
  import { paletteStore, type storeParams as PaletteStoreParams } from "svelte-command-palette";
  import {
    devSortOptions,
    filterLabel,
    filterOptions,
    needsAttention,
    releaseDebtText,
    sortLabel,
    sortOptions,
    type DashboardFilter,
    type SortDirection,
    type SortKey,
  } from "../dashboard-view.js";
  import {
    absoluteDate,
    attentionText,
    ciLabel,
    countLabel,
    numberFormat,
    percent,
    relativeDate,
  } from "../app-format.js";
  import { ownerDashboardPath, repoDetailPath } from "../routing.js";
  import type { AuthPayload, DashboardPayload, Project } from "../types.js";

  export let query: string;
  export let language = "";
  export let filter: DashboardFilter;
  export let sortKey: SortKey = "repo";
  export let sortDirection: SortDirection = "asc";
  export let devMode: boolean;
  export let visibleProjects: Project[];
  export let filteredProjects: Project[];
  export let errorMessage: string;
  export let dashboardFetching: boolean;
  export let dashboardUpdating: boolean;
  export let data: DashboardPayload | null = null;
  export let rateLimitHit: boolean;
  export let auth: AuthPayload | null;
  export let showProjectOwnerAvatars: boolean;
  export let setSort: (key: SortKey) => void;
  export let setDevMode: (enabled: boolean) => void;
  export let toggleLanguageFilter: (language: string) => void;
  export let primaryAuthAction: () => void;
  export let primaryAuthLabel: (auth: AuthPayload | null, compact?: boolean) => string;
  export let projectOwnerAvatarUrl: (project: Project) => string;

  function sortDirectionGlyph(direction: SortDirection): string {
    return direction === "asc" ? "↑" : "↓";
  }

  function sortButtonLabel(key: SortKey): string {
    const state = sortKey === key ? `, currently ${sortDirection}` : "";
    return `Sort by ${sortLabel(key)}${state}`;
  }

  function activeLanguage(nextLanguage: string): boolean {
    return language.trim().toLowerCase() === nextLanguage.toLowerCase();
  }

  function setTopicSearch(topic: string): void {
    query = query.trim().toLowerCase() === topic.toLowerCase() ? "" : topic;
  }

  function rowActivationTarget(event: Event): HTMLElement | null {
    return (event.target as HTMLElement | null)?.closest("a, button, input, label") ?? null;
  }

  function rowClick(event: MouseEvent, fullName: string): void {
    if (event.defaultPrevented || rowActivationTarget(event)) return;
    location.assign(repoDetailPath(fullName));
  }

  function rowKeydown(event: KeyboardEvent, fullName: string): void {
    if (event.defaultPrevented || rowActivationTarget(event)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    location.assign(repoDetailPath(fullName));
  }

  function isRepositorySearchProject(project: Project): boolean {
    return (
      project.version === "repo search" &&
      project.releaseDate === null &&
      project.commitsSinceRelease === null &&
      project.compareUrl === null
    );
  }

  function repositorySearchStatus(): string {
    if (data?.cache?.progress?.done === false) return "release scan queued";
    if (data?.cache?.message?.startsWith("release scan skipped")) return "release scan skipped";
    if (data?.cache?.progress?.done === true) return "outside hot scan batch";
    return "release not scanned";
  }
</script>

<section class="console" aria-label="Project search and metrics">
  <div class="prompt">
    <span class="mark">$</span>
    <input
      bind:value={query}
      type="search"
      autocomplete="off"
      spellcheck="false"
      placeholder="search repos, languages, owners, versions"
    />
    <button
      class="quick-jump"
      type="button"
      aria-label="Open command palette"
      onclick={() => paletteStore.update((s: PaletteStoreParams) => ({ ...s, isVisible: true }))}
    >
      <span aria-hidden="true">⌘</span>
      <span aria-hidden="true">K</span>
    </button>
  </div>
  <div class="metrics">
    <button
      class="metric-action"
      class:active={sortKey === "repo"}
      type="button"
      aria-pressed={sortKey === "repo"}
      onclick={() => setSort("repo")}
    >
      <span>{numberFormat.format(visibleProjects.length)}</span>
      <small>repos</small>
    </button>
    <button
      class="metric-action"
      class:active={sortKey === "release"}
      type="button"
      aria-pressed={sortKey === "release"}
      onclick={() => setSort("release")}
    >
      <span>{numberFormat.format(visibleProjects.filter((project) => project.releaseDate).length)}</span>
      <small>released</small>
    </button>
    <button
      class="metric-action"
      class:active={sortKey === "since"}
      type="button"
      aria-pressed={sortKey === "since"}
      onclick={() => setSort("since")}
    >
      <span>
        {numberFormat.format(
          visibleProjects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0),
        )}
      </span>
      <small>commits since release</small>
    </button>
    <button
      class="metric-action"
      class:active={filter === "attention"}
      type="button"
      aria-pressed={filter === "attention"}
      title="Show repositories with unreleased commits, stale releases, failed CI, or open-work pressure"
      onclick={() => (filter = filter === "attention" ? "all" : "attention")}
    >
      <span>{numberFormat.format(visibleProjects.filter(needsAttention).length)}</span>
      <small>need attention</small>
    </button>
  </div>
</section>

<nav class="filters" aria-label="Filters">
  {#each filterOptions as option}
    <button class:active={filter === option} type="button" onclick={() => (filter = option)}>
      {filterLabel(option)}
    </button>
  {/each}
  <label class="dev-toggle">
    <input type="checkbox" checked={devMode} onchange={(event) => setDevMode((event.currentTarget as HTMLInputElement).checked)} />
    <span>dev</span>
  </label>
</nav>

<section class="table-wrap" aria-label="Repositories">
  <div class="table-head">
    {#each [...sortOptions, ...devSortOptions] as key}
      <button
        class:dev-only={devSortOptions.includes(key)}
        class:since-heading={key === "since"}
        type="button"
        aria-label={sortButtonLabel(key)}
        aria-current={sortKey === key ? "true" : undefined}
        data-direction={sortKey === key ? sortDirection : ""}
        data-sort-symbol={sortKey === key ? sortDirectionGlyph(sortDirection) : ""}
        onclick={() => setSort(key)}
      >
        {#if key === "since"}
          <span class="label-full">commits since</span>
          <span class="label-compact">since</span>
        {:else}
          {sortLabel(key)}
        {/if}
      </button>
    {/each}
  </div>
  <div class="projects">
    {#if errorMessage}
      <div class="error-state">
        <span class="loading-kicker">dashboard unavailable</span>
        <strong>{errorMessage}</strong>
        <small>Unknown owners, cold caches, and GitHub rate limits can all land here. Connecting GitHub gives ReleaseBar dedicated App quota for dashboards you can access.</small>
        {#if !rateLimitHit && (auth?.configured || auth?.quotaConfigured) && !auth.user}
          <button type="button" onclick={primaryAuthAction}>{primaryAuthLabel(auth)}</button>
        {/if}
      </div>
    {:else if dashboardFetching}
      <div class="loading-state" aria-live="polite">
        <span class="loading-kicker">fetching dashboard</span>
        <strong>{data?.cache?.message ?? "building release data"}</strong>
        <small>GitHub data is being cached. This dashboard will refresh automatically.</small>
        <div class="loading-bars" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    {:else if filteredProjects.length === 0}
      <div class="loading-state empty-state">
        <span class="loading-kicker">no matching repos</span>
        <strong>nothing visible here</strong>
        <small>Adjust search, filters, or dashboard settings.</small>
      </div>
    {:else}
      {#if dashboardUpdating}
        <div class="partial-state" aria-live="polite">
          <span>cached rows visible · background update running</span>
          <strong>{data?.cache?.message ?? "combined dashboard updating"}</strong>
          {#if data?.cache?.progress}
            <div
              class="scan-meter"
              aria-label={`Scanned ${data.cache.progress.scanned} of ${data.cache.progress.limit ?? data.cache.repoLimit ?? data.cache.progress.scanned} repositories`}
            >
              <i
                style={`width: ${percent(
                  data.cache.progress.scanned,
                  data.cache.progress.limit ?? data.cache.repoLimit ?? data.cache.progress.scanned,
                )}%`}
              ></i>
            </div>
            <small>
              scanned {numberFormat.format(data.cache.progress.scanned)}
              {#if data.cache.progress.limit}
                /{numberFormat.format(data.cache.progress.limit)}
              {/if}
              repositories; rows update automatically as GitHub responds
            </small>
          {/if}
        </div>
        {/if}
      {#each filteredProjects as project (project.fullName)}
      <div
        class="project"
        data-freshness={project.freshness}
        role="link"
        tabindex="0"
        aria-label={`${project.fullName}: ${attentionText(project)}`}
        onclick={(event) => rowClick(event, project.fullName)}
        onkeydown={(event) => rowKeydown(event, project.fullName)}
      >
        <div class="repo-cell">
          <div class="repo-title">
            {#if showProjectOwnerAvatars}
              <a
                class="row-owner-avatar-link"
                href={ownerDashboardPath(project.owner)}
                title={`Open @${project.owner} dashboard`}
                aria-label={`Open @${project.owner} dashboard`}
              >
                <img
                  class="row-owner-avatar"
                  src={projectOwnerAvatarUrl(project)}
                  alt=""
                  width="28"
                  height="28"
                  loading="lazy"
                />
              </a>
            {/if}
            <span class="repo-name-line">
              <a class="owner-link" href={ownerDashboardPath(project.owner)} title={`Open @${project.owner} dashboard`}>
                {project.owner}
              </a>
              <span class="repo-separator" aria-hidden="true">/</span>
              <a class="repo-link" href={repoDetailPath(project.fullName)} title="Open repo detail">
                {project.name}
              </a>
            </span>
          </div>
          <p class="description">{project.description || "no description"}</p>
          <div class="tags">
            {#if project.language}
              <button
                class="tag tag-button"
                class:active={activeLanguage(project.language)}
                type="button"
                aria-pressed={activeLanguage(project.language)}
                title={`Filter by ${project.language}`}
                onclick={() => toggleLanguageFilter(project.language ?? "")}
              >
                {project.language}
              </button>
            {/if}
            {#each (project.topics ?? []).slice(0, 4) as topic}
              <button
                class="tag tag-button"
                class:active={query.trim().toLowerCase() === topic.toLowerCase()}
                type="button"
                aria-pressed={query.trim().toLowerCase() === topic.toLowerCase()}
                title={`Search ${topic}`}
                onclick={() => setTopicSearch(topic)}
              >
                {topic}
              </button>
            {/each}
            {#if project.archived}<span class="tag muted">archived</span>{/if}
            <span class="tag">{project.freshness}</span>
          </div>
          {#if releaseDebtText(project)}
            <p class="attention-reasons">
              <span>needs attention</span>
              {releaseDebtText(project)}
            </p>
          {/if}
        </div>
        <div class="stars-cell">
          <strong>{numberFormat.format(project.stars)}</strong>
        </div>
        <div class="release-cell">
          {#if isRepositorySearchProject(project)}
            <strong>repo search</strong>
            <a class="release-version" href={repoDetailPath(project.fullName)}>
              open repo
            </a>
            <span class:scan-pending={data?.cache?.progress?.done === false}>
              {repositorySearchStatus()}
            </span>
          {:else}
            <strong>{absoluteDate(project.releaseDate)}</strong>
            {#if project.releaseDate}
              <a
                class="release-version external-link"
                href={project.releaseUrl}
                target="_blank"
                rel="noreferrer"
                title={`Open release ${project.version}`}
              >
                {project.version}
              </a>
            {:else}
              <a class="release-version" href={repoDetailPath(project.fullName)} title="Open repo detail">
                open repo
              </a>
            {/if}
            <span>{relativeDate(project.releaseDate)}</span>
          {/if}
        </div>
        <div class="since-cell" class:muted={!project.compareUrl || project.commitsSinceRelease === null}>
          {#if project.compareUrl && project.commitsSinceRelease !== null}
            <a class="external-link" href={project.compareUrl} target="_blank" rel="noreferrer">
              {project.commitsSinceRelease}
            </a>
          {:else}
            n/a
          {/if}
        </div>
        <div class="activity-cell">
          <strong>{relativeDate(project.latestCommitDate || project.pushedAt)}</strong>
          <span>{project.latestCommitSha || project.defaultBranch}</span>
        </div>
        <div class="issues-cell dev-only">
          <a class="external-link" href={project.issuesUrl} target="_blank" rel="noreferrer">{countLabel(project.openIssues)}</a>
        </div>
        <div class="prs-cell dev-only">
          <a class="external-link" href={project.pullRequestsUrl} target="_blank" rel="noreferrer">
            {countLabel(project.openPullRequests)}
          </a>
        </div>
        <div class="ci-cell dev-only" data-ci={project.ciState}>
          {#if project.ciUrl}
            <a class="external-link" href={project.ciUrl} target="_blank" rel="noreferrer">{ciLabel(project)}</a>
          {:else}
            {ciLabel(project)}
          {/if}
          {#if project.ciWorkflow || project.ciRunDate}
            <span>{project.ciWorkflow || relativeDate(project.ciRunDate)}</span>
          {/if}
        </div>
      </div>
      {/each}
    {/if}
  </div>
</section>

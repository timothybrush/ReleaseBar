<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import CommandPalette, {
    defineActions,
    paletteStore,
    type action as CommandAction,
    type storeParams as PaletteStoreParams,
  } from "svelte-command-palette";
  import { DropdownMenu } from "bits-ui";

  import { dashboardRoute, validRepoSlug } from "./routing.js";
  import type { AuthPayload, CiState, DashboardPayload, Freshness, Project } from "./types.js";

  type SortKey = "repo" | "version" | "release" | "since" | "activity" | "issues" | "prs" | "ci";
  type SortDirection = "asc" | "desc";

  const initialRoute = dashboardRoute(location.pathname, location.search);
  const routeScope = initialRoute.owner ?? "default";
  const hiddenOwnersKey = `releasedeck:${routeScope}:hidden-owners`;
  const hiddenReposKey = `releasedeck:${routeScope}:hidden-repos`;
  const filterOptions: Array<Freshness | "all"> = ["all", "hot", "busy", "fresh"];
  const sortOptions: SortKey[] = ["repo", "version", "release", "since", "activity"];
  const devSortOptions: SortKey[] = ["issues", "prs", "ci"];

  let data: DashboardPayload | null = null;
  let auth: AuthPayload | null = null;
  let query = "";
  let filter: Freshness | "all" = "all";
  let sortKey: SortKey = initialRoute.isDefault ? "since" : "activity";
  let sortDirection: SortDirection = "desc";
  let devMode = localStorage.getItem("releasedeck:dev-mode") === "true";
  let hiddenOwners = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenOwnersKey) || "[]") as string[],
  );
  let hiddenRepos = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenReposKey) || "[]") as string[],
  );
  let settingsOpen = false;
  let sourceInput = "";
  let errorMessage = "";
  let paletteText = "";
  let generatedLabel = "loading";

  const numberFormat = new Intl.NumberFormat("en", { notation: "compact" });
  const dateFormat = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  $: label = data ? ownerLabel(data) : initialRoute.label;
  $: subtitle = data?.subtitle ?? "Release debt across recently requested public dashboards.";
  $: filteredProjects = data ? sortProjects(data.projects.filter(matches)) : [];
  $: ownerToggles = data
    ? [...new Set(data.projects.map((project) => project.owner.toLowerCase()))].sort()
    : [];
  $: sourceCount = initialRoute.extraOwners.length + initialRoute.repos.length;
  $: hiddenCount = hiddenOwners.size + hiddenRepos.size;
  $: settingsSummary = `${sourceCount === 0 ? "default sources" : `${numberFormat.format(sourceCount)} added`} · ${
    hiddenCount === 0 ? "all visible" : `${numberFormat.format(hiddenCount)} hidden`
  }`;
  $: connectionStatus = authStatus();
  $: commandActions = defineActions(
    buildCommands(
      filteredProjects,
      ownerToggles,
      paletteText,
      hiddenOwners,
      hiddenRepos,
      auth,
      devMode,
      sortKey,
      sortDirection,
      filter,
      settingsSummary,
    ),
  );
  $: document.body.classList.toggle("dev-mode", devMode);
  $: document.title = `${label} · ReleaseBar`;

  function ownerLabel(payload: DashboardPayload): string {
    if (initialRoute.isDefault) {
      return payload.title || "ReleaseBar Hot";
    }
    if (payload.owners.length > 0) {
      const [first] = payload.owners;
      const extraCount = payload.owners.length - 1 + initialRoute.repos.length;
      return `${first ? `@${first.login}` : "custom"}${extraCount > 0 ? ` +${extraCount}` : ""}`;
    }
    if (initialRoute.repos.length === 1) {
      return initialRoute.repos[0] ?? "custom deck";
    }
    return initialRoute.repos.length > 1
      ? `custom deck +${initialRoute.repos.length}`
      : initialRoute.label;
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
    if (project.archived && !data?.options?.includeArchived) return false;
    if (hiddenOwners.has(project.owner.toLowerCase())) return false;
    if (hiddenRepos.has(project.fullName.toLowerCase())) return false;
    if (filter !== "all" && project.freshness !== filter) return false;
    if (!query) return true;
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
    return haystack.includes(query);
  }

  function persistVisibility(nextOwners = hiddenOwners, nextRepos = hiddenRepos): void {
    localStorage.setItem(hiddenOwnersKey, JSON.stringify([...nextOwners]));
    localStorage.setItem(hiddenReposKey, JSON.stringify([...nextRepos]));
  }

  function addSource(value: string): void {
    const normalized = value.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) return;

    const url = new URL(location.href);
    const key = validRepoSlug(normalized) ? "repos" : "owners";
    if (key === "owners" && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalized)) {
      return;
    }

    const values = [
      ...new Set((url.searchParams.get(key) ?? "").split(",").filter(Boolean).concat(normalized)),
    ].sort();
    url.searchParams.set(key, values.join(","));
    localStorage.setItem("releasedeck:custom-sources", url.search);
    location.assign(url.toString());
  }

  function openOwner(owner: string): void {
    location.assign(`/${encodeURIComponent(owner.replace(/^@/, ""))}`);
  }

  function toggleSet(set: Set<string>, key: string, visible: boolean): Set<string> {
    const next = new Set(set);
    if (visible) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  }

  function toggleOwner(owner: string, visible: boolean): void {
    hiddenOwners = toggleSet(hiddenOwners, owner, visible);
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function toggleRepo(repo: string, visible: boolean): void {
    hiddenRepos = toggleSet(hiddenRepos, repo.toLowerCase(), visible);
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function resetHidden(): void {
    hiddenOwners = new Set();
    hiddenRepos = new Set();
    persistVisibility(hiddenOwners, hiddenRepos);
  }

  function currentReturnTo(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function login(): void {
    const loginUrl = new URL(auth?.loginUrl ?? "/api/auth/login", location.origin);
    loginUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(loginUrl.toString());
  }

  function installApp(): void {
    const installUrl = new URL(auth?.installUrl ?? "/api/auth/install", location.origin);
    installUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(installUrl.toString());
  }

  function logout(): void {
    const logoutUrl = new URL(auth?.logoutUrl ?? "/api/auth/logout", location.origin);
    logoutUrl.searchParams.set("returnTo", currentReturnTo());
    location.assign(logoutUrl.toString());
  }

  function authStatus(): string {
    if (!auth?.configured) return "GitHub connection is not configured.";
    if (auth.user) {
      return (
        auth.installReason ??
        (auth.quotaConfigured
          ? `${auth.installations.length === 0 ? "Signed in." : `Connected to ${numberFormat.format(auth.installations.length)} GitHub App installation${auth.installations.length === 1 ? "" : "s"}.`}`
          : "Signed in. Dedicated app quota is not configured on this deployment.")
      );
    }
    return auth.quotaConfigured
      ? "Connect GitHub to use dedicated API quota for dashboards you choose."
      : "Connect GitHub to manage dashboard access.";
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

  function sortValue(project: Project, key: SortKey): string | number {
    switch (key) {
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
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...projects].sort((a, b) => {
      const aValue = sortValue(a, sortKey);
      const bValue = sortValue(b, sortKey);
      if (typeof aValue === "string" && typeof bValue === "string") {
        return aValue.localeCompare(bValue) * direction;
      }
      return ((aValue as number) - (bValue as number)) * direction;
    });
  }

  function setSort(key: SortKey): void {
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = ["repo", "version"].includes(key) ? "asc" : "desc";
    }
  }

  function setDevMode(value: boolean): void {
    devMode = value;
    if (!devMode && ["issues", "prs", "ci"].includes(sortKey)) {
      sortKey = "activity";
      sortDirection = "desc";
    }
    localStorage.setItem("releasedeck:dev-mode", String(devMode));
  }

  function ciLabel(project: Project): string {
    if (project.ciState === "unknown") return "no ci";
    if (project.ciState === "failure") return "fail";
    return project.ciState;
  }

  function updateStatus(): void {
    if (!data) return;
    const cacheState = data.cache?.state;
    const stale = data.cache?.stale && cacheState !== "stale" ? " · stale" : "";
    const capped = data.cache?.capped
      ? ` · capped at ${numberFormat.format(data.cache.repoLimit ?? data.projects.length)}`
      : "";
    generatedLabel = `updated ${relativeDate(data.generatedAt)}${cacheState ? ` · ${cacheState}` : ""}${stale}${capped}`;
  }

  async function fetchPayload(apiPath: string): Promise<Response> {
    const joiner = apiPath.includes("?") ? "&" : "?";
    return fetch(`${apiPath}${joiner}v=${Date.now()}`, { cache: "no-store" });
  }

  async function readDashboardResponse(
    response: Response,
  ): Promise<DashboardPayload | { error?: string } | null> {
    return (await response.json().catch(() => null)) as DashboardPayload | { error?: string } | null;
  }

  async function loadAuth(): Promise<void> {
    try {
      const url = new URL("/api/me", location.origin);
      url.searchParams.set("returnTo", currentReturnTo());
      const response = await fetch(url.toString(), { cache: "no-store" });
      if (response.ok) {
        auth = (await response.json()) as AuthPayload;
      }
    } catch {
      auth = null;
    }
  }

  async function loadDashboard(attempt = 0): Promise<void> {
    let response = await fetchPayload(initialRoute.apiPath);
    let body = await readDashboardResponse(response);
    if (response.ok && body && "projects" in body) {
      data = body;
      updateStatus();
      if (data.cache?.state === "rebuilding" && attempt < 24) {
        globalThis.setTimeout(() => {
          void loadDashboard(attempt + 1);
        }, 5000);
      }
      return;
    }
    if (body && "cache" in body) {
      data = body;
      updateStatus();
      errorMessage = body.cache?.message || "dashboard error";
      return;
    }
    if (initialRoute.fallbackApiPath) {
      response = await fetchPayload(initialRoute.fallbackApiPath);
      body = await readDashboardResponse(response);
      if (response.ok && body && "projects" in body) {
        data = body;
        updateStatus();
        return;
      }
    }
    const message = body && "error" in body ? body.error : `dashboard fetch failed: ${response.status}`;
    throw new Error(message || `dashboard fetch failed: ${response.status}`);
  }

  function handleSourceSubmit(event: SubmitEvent): void {
    event.preventDefault();
    addSource(sourceInput);
  }

  function openUrl(url: string | null, newTab = true): void {
    if (!url) return;
    if (newTab) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      location.assign(url);
    }
  }

  function sortCommand(key: SortKey): CommandAction {
    return {
      actionId: `sort:${key}`,
      title: `Sort by ${key}`,
      subTitle: sortKey === key ? `currently ${sortDirection}` : "table order",
      group: "View",
      keywords: ["order", "table", key],
      onRun: () => setSort(key),
    };
  }

  function filterCommand(value: Freshness | "all"): CommandAction {
    return {
      actionId: `filter:${value}`,
      title: `Show ${value}`,
      subTitle: filter === value ? "current filter" : "filter dashboard",
      group: "View",
      keywords: ["filter", value],
      onRun: () => {
        filter = value;
      },
    };
  }

  function repoCommands(project: Project): CommandAction[] {
    const commands: CommandAction[] = [
      {
        actionId: `repo:${project.fullName}`,
        title: project.fullName,
        subTitle: `${project.version} · ${project.freshness} · ${numberFormat.format(project.stars)} stars`,
        description: project.description ?? undefined,
        group: "Repos",
        keywords: [project.owner, project.name, project.language ?? "", project.version],
        onRun: () => openUrl(project.url),
      },
      {
        actionId: `release:${project.fullName}`,
        title: `Open release ${project.version}`,
        subTitle: project.fullName,
        group: "Repos",
        keywords: ["tag", "version", project.fullName],
        onRun: () => openUrl(project.releaseUrl),
      },
      {
        actionId: `issues:${project.fullName}`,
        title: `Open issues`,
        subTitle: `${project.fullName} · ${project.openIssues}`,
        group: "Repos",
        keywords: ["bugs", "issues", project.fullName],
        onRun: () => openUrl(project.issuesUrl),
      },
      {
        actionId: `prs:${project.fullName}`,
        title: `Open pull requests`,
        subTitle: `${project.fullName} · ${project.openPullRequests}`,
        group: "Repos",
        keywords: ["prs", "pulls", "pull requests", project.fullName],
        onRun: () => openUrl(project.pullRequestsUrl),
      },
      {
        actionId: `hide:${project.fullName}`,
        title: `${hiddenRepos.has(project.fullName.toLowerCase()) ? "Show" : "Hide"} ${project.fullName}`,
        subTitle: "local visibility",
        group: "Visibility",
        keywords: ["hide", "show", "visible", project.fullName],
        onRun: () => toggleRepo(project.fullName, hiddenRepos.has(project.fullName.toLowerCase())),
      },
    ];
    if (project.compareUrl) {
      commands.splice(2, 0, {
        actionId: `compare:${project.fullName}`,
        title: `Open compare`,
        subTitle: `${project.fullName} · ${project.commitsSinceRelease ?? "n/a"} commits`,
        group: "Repos",
        keywords: ["compare", "commits", project.fullName],
        onRun: () => openUrl(project.compareUrl),
      });
    }
    if (project.ciUrl) {
      commands.push({
        actionId: `ci:${project.fullName}`,
        title: `Open CI`,
        subTitle: `${project.fullName} · ${ciLabel(project)}`,
        group: "Repos",
        keywords: ["ci", "checks", "actions", project.fullName],
        onRun: () => openUrl(project.ciUrl),
      });
    }
    return commands;
  }

  function buildCommands(
    projects: Project[],
    owners: string[],
    typedText: string,
    hiddenOwnerSet: Set<string>,
    hiddenRepoSet: Set<string>,
    authPayload: AuthPayload | null,
    devEnabled: boolean,
    activeSortKey: SortKey,
    activeSortDirection: SortDirection,
    activeFilter: Freshness | "all",
    currentSettingsSummary: string,
  ): CommandAction[] {
    const rawTyped = typedText.trim();
    const typed = rawTyped.replace(/^@/, "").toLowerCase();
    const typedCommands: CommandAction[] = [];
    if (rawTyped.startsWith("@") && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(typed)) {
      typedCommands.push({
        actionId: `typed-owner:${typed}`,
        title: `Open @${typed}`,
        subTitle: "public dashboard",
        group: "Dashboards",
        keywords: ["owner", "org", typed],
        onRun: () => openOwner(typed),
      });
    }
    if (validRepoSlug(typed)) {
      typedCommands.push({
        actionId: `typed-repo:${typed}`,
        title: `Add ${typed}`,
        subTitle: "explicit public repo source",
        group: "Dashboards",
        keywords: ["repo", "source", typed],
        onRun: () => addSource(typed),
      });
    }

    const ownerCommands = owners.map((owner) => ({
      actionId: `owner:${owner}`,
      title: `Open @${owner}`,
      subTitle: hiddenOwnerSet.has(owner) ? "hidden locally" : "owner dashboard",
      group: "Dashboards",
      keywords: ["owner", "dashboard", owner],
      onRun: () => openOwner(owner),
    }));

    return [
      ...typedCommands,
      {
        actionId: "dashboard:home",
        title: "Open ReleaseBar Hot",
        subTitle: "root dashboard",
        group: "Dashboards",
        keywords: ["home", "root", "hot"],
        onRun: () => location.assign("/"),
      },
      ...ownerCommands,
      ...projects.flatMap(repoCommands).slice(0, 420),
      ...filterOptions.map(filterCommand),
      ...sortOptions.map(sortCommand),
      ...(devEnabled ? devSortOptions.map(sortCommand) : []),
      {
        actionId: "view:dev",
        title: `${devEnabled ? "Disable" : "Enable"} dev columns`,
        subTitle: "issues, PRs, CI",
        group: "View",
        keywords: ["dev", "issues", "prs", "ci"],
        onRun: () => setDevMode(!devEnabled),
      },
      {
        actionId: "view:settings",
        title: "Open settings",
        subTitle: currentSettingsSummary,
        group: "View",
        keywords: ["settings", "sources", "visibility"],
        onRun: () => {
          settingsOpen = true;
        },
      },
      {
        actionId: "visibility:reset",
        title: "Show all hidden items",
        subTitle: currentSettingsSummary,
        group: "Visibility",
        keywords: ["reset", "hidden", "visibility"],
        onRun: resetHidden,
      },
      ...owners.map((owner) => ({
        actionId: `visibility:owner:${owner}`,
        title: `${hiddenOwnerSet.has(owner) ? "Show" : "Hide"} @${owner}`,
        subTitle: "local visibility",
        group: "Visibility",
        keywords: ["hide", "show", "owner", owner],
        onRun: () => toggleOwner(owner, hiddenOwnerSet.has(owner)),
      })),
      ...(authPayload?.configured && !authPayload.user
        ? [
            {
              actionId: "auth:login",
              title: "Connect GitHub",
              subTitle: "dedicated API quota",
              group: "Account",
              keywords: ["login", "github", "quota"],
              onRun: login,
            },
          ]
        : []),
      ...(authPayload?.user
        ? [
            ...(authPayload.installNeeded
              ? [
                  {
                    actionId: "auth:install",
                    title: "Install GitHub App",
                    subTitle: authPayload.installReason ?? "dedicated API quota",
                    group: "Account",
                    keywords: ["install", "github", "app"],
                    onRun: installApp,
                  },
                ]
              : []),
            {
              actionId: "auth:logout",
              title: "Log out",
              subTitle: `@${authPayload.user.login}`,
              group: "Account",
              keywords: ["logout", "sign out", authPayload.user.login],
              onRun: logout,
            },
          ]
        : []),
    ];
  }

  onMount(() => {
    const unsubscribe = paletteStore.subscribe((value: PaletteStoreParams) => {
      paletteText = value.textInput;
    });
    void Promise.all([loadAuth(), loadDashboard()]).catch((error) => {
      generatedLabel = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    });
    return () => unsubscribe();
  });

  onDestroy(() => {
    document.body.classList.remove("dev-mode");
  });
</script>

<main class="shell">
  <header class="topline">
    <div>
      <a class="eyebrow" href="/">ReleaseBar</a>
      <h1>{label}</h1>
      <p class="subtitle">{subtitle}</p>
    </div>
    <div class="top-actions">
      <div class="status" aria-live="polite">
        <span class="pulse"></span>
        <span>{generatedLabel}</span>
      </div>

      {#if auth?.user}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="account-button">
            <span class="account-label">@{auth.user.login}</span>
            <span class="account-caret" aria-hidden="true"></span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="account-dropdown" align="end" sideOffset={8} loop>
            <DropdownMenu.Item class="menu-action" onSelect={() => (settingsOpen = !settingsOpen)}>
              Settings
            </DropdownMenu.Item>
            {#if auth.installNeeded}
              <DropdownMenu.Item class="menu-action" onSelect={installApp}>
                Install App
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item class="menu-action" onSelect={logout}>Log Out</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        <button
          class="account-button"
          type="button"
          disabled={!auth?.configured}
          onclick={login}
          title={auth?.configured ? "Connect GitHub" : "GitHub login unavailable"}
        >
          <span class="account-label">{auth?.configured ? "Connect GitHub" : "Login Unavailable"}</span>
          {#if auth?.configured}
            <span class="account-caret" aria-hidden="true"></span>
          {/if}
        </button>
      {/if}
    </div>
  </header>

  {#if settingsOpen}
    <div class="settings-panel" aria-label="Dashboard settings" data-open>
      <div>
        <strong>dashboard</strong>
        <p>{settingsSummary}</p>
        <p class="connection-status">{connectionStatus}</p>
        <form class="source-form" onsubmit={handleSourceSubmit}>
          <input
            bind:value={sourceInput}
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="@owner or owner/repo"
          />
          <button type="submit">add</button>
        </form>
      </div>
      <section>
        <h2>owners</h2>
        <div class="setting-list">
          {#each ownerToggles as owner}
            <label class="setting-check">
              <input
                type="checkbox"
                checked={!hiddenOwners.has(owner)}
                onchange={(event) =>
                  toggleOwner(owner, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span>@{owner}</span>
            </label>
          {/each}
        </div>
      </section>
      <section>
        <h2>repos</h2>
        <div class="setting-list repo-settings">
          {#each data?.projects ?? [] as project (project.fullName)}
            <label class="setting-check">
              <input
                type="checkbox"
                checked={!hiddenRepos.has(project.fullName.toLowerCase())}
                onchange={(event) =>
                  toggleRepo(project.fullName, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span>{project.fullName}</span>
            </label>
          {/each}
        </div>
      </section>
    </div>
  {/if}

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
      <div>
        <span>{numberFormat.format(filteredProjects.length)}</span>
        <small>repos</small>
      </div>
      <div>
        <span>{numberFormat.format(filteredProjects.filter((project) => project.releaseDate).length)}</span>
        <small>released</small>
      </div>
      <div>
        <span>
          {numberFormat.format(
            filteredProjects.reduce((sum, project) => sum + (project.commitsSinceRelease || 0), 0),
          )}
        </span>
        <small>commits since release</small>
      </div>
      <div>
        <span>
          {numberFormat.format(
            filteredProjects.filter((project) => ["hot", "busy"].includes(project.freshness)).length,
          )}
        </span>
        <small>need attention</small>
      </div>
    </div>
  </section>

  <nav class="filters" aria-label="Filters">
    {#each filterOptions as option}
      <button class:active={filter === option} type="button" onclick={() => (filter = option)}>
        {option}
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
          type="button"
          aria-current={sortKey === key ? "true" : undefined}
          data-direction={sortKey === key ? sortDirection : ""}
          onclick={() => setSort(key)}
        >
          {key}
        </button>
      {/each}
    </div>
    <div class="projects">
      {#if errorMessage}
        <p class="error-message">{errorMessage}</p>
      {/if}
      {#each filteredProjects as project (project.fullName)}
        <article class="project" data-freshness={project.freshness}>
          <div class="repo-cell">
            <a class="repo-link" target="_blank" rel="noreferrer" href={project.url}>
              {project.fullName}
            </a>
            <p class="description">{project.description || "no description"}</p>
            <div class="tags">
              {#if project.language}<span class="tag">{project.language}</span>{/if}
              <span class="tag">{numberFormat.format(project.stars)} stars</span>
              {#if project.archived}<span class="tag muted">archived</span>{/if}
              <span class="tag">{project.freshness}</span>
            </div>
          </div>
          <div class="version-cell">
            <a href={project.releaseUrl} target="_blank" rel="noreferrer">{project.version}</a>
          </div>
          <div class="release-cell">
            <strong>{absoluteDate(project.releaseDate)}</strong>
            <span>{relativeDate(project.releaseDate)}</span>
          </div>
          <div class="since-cell" class:muted={!project.compareUrl || project.commitsSinceRelease === null}>
            {#if project.compareUrl && project.commitsSinceRelease !== null}
              <a href={project.compareUrl} target="_blank" rel="noreferrer">
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
            <a href={project.issuesUrl} target="_blank" rel="noreferrer">{project.openIssues}</a>
          </div>
          <div class="prs-cell dev-only">
            <a href={project.pullRequestsUrl} target="_blank" rel="noreferrer">
              {project.openPullRequests}
            </a>
          </div>
          <div class="ci-cell dev-only" data-ci={project.ciState}>
            {#if project.ciUrl}
              <a href={project.ciUrl} target="_blank" rel="noreferrer">{ciLabel(project)}</a>
            {:else}
              {ciLabel(project)}
            {/if}
            {#if project.ciWorkflow || project.ciRunDate}
              <span>{project.ciWorkflow || relativeDate(project.ciRunDate)}</span>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  </section>
</main>

<CommandPalette
  commands={commandActions}
  placeholder="jump to repo, dashboard, action"
  shortcut="$mod+k"
  overlayClass="command-overlay"
  paletteWrapperInnerClass="command-panel"
  inputClass="command-input"
  resultsContainerClass="command-results"
  resultContainerClass="command-result"
  optionSelectedClass="command-result-active"
  titleClass="command-title"
  subtitleClass="command-subtitle"
  descriptionClass="command-description"
  keyboardButtonClass="command-key"
  unstyled={true}
/>

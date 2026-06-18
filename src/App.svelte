<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import CommandPalette, {
    defineActions,
    paletteStore,
    type storeParams as PaletteStoreParams,
  } from "svelte-command-palette";
  import AdminConsole from "./components/AdminConsole.svelte";
  import AppHeader from "./components/AppHeader.svelte";
  import DashboardControls from "./components/DashboardControls.svelte";
  import OwnerActivityPage from "./components/OwnerActivityPage.svelte";
  import OwnerOverview from "./components/OwnerOverview.svelte";
  import ProjectTable from "./components/ProjectTable.svelte";
  import RepoDetail from "./components/RepoDetail.svelte";
  import {
    dashboardOwner,
    dashboardOwnerLabel,
    githubOwnerAvatar,
    githubProjectOwnerAvatar,
    matchesDashboardProject,
    numberFormat,
  } from "./app-format.js";
  import { buildCommands } from "./app-commands.js";
  import {
    createActivityController,
    type ActivityControllerContext,
  } from "./app-activity-controller.js";
  import { createRouteController, type RouteState } from "./app-route-controller.js";
  import { createAdminController, type AdminState } from "./app-admin-controller.js";
  import {
    createSettingsController,
    type SettingsState,
  } from "./app-settings-controller.js";
  import type { AdminDashboardPayload } from "./app-types.js";

  import {
    defaultSortDirection,
    isDevSortKey,
    matchesFilter,
    parseViewState,
    sortProjects,
    viewStateSearch,
    type DashboardFilter,
    type SortDirection,
    type SortKey,
  } from "./dashboard-view.js";
  import {
    dashboardRoute,
    ownerActivityFromPath,
    repoFromPath,
    type DiscoverPeriod,
  } from "./routing.js";
  import { isGitHubRateLimit } from "./rate-limit.js";
  import type {
    ActivityRange,
    AudienceRange,
    AuthPayload,
    DashboardPayload,
    OwnerActivityPayload,
    Project,
    RepoAudiencePayload,
    RepoActivityRange,
    RepoDetailActivityPayload,
    RepoDetailPayload,
    TrustProfilePayload,
  } from "./types.js";

  const adminRoute = location.pathname === "/_admin";
  const activityPageRoute = ownerActivityFromPath(location.pathname);
  const repoRoute = activityPageRoute ? null : repoFromPath(location.pathname);
  const initialRoute = dashboardRoute(location.pathname, location.search);
  type InitialPageData =
    | { route: "dashboard"; payload: DashboardPayload }
    | { route: "repo"; payload: RepoDetailPayload };

  function initialPageData(): InitialPageData | null {
    const element = document.getElementById("releasebar-initial-data");
    if (!element?.textContent) return null;
    try {
      const parsed = JSON.parse(element.textContent) as InitialPageData;
      return parsed.route === "dashboard" || parsed.route === "repo" ? parsed : null;
    } catch {
      return null;
    }
  }

  const embedded = initialPageData();
  const initialOwnerTab =
    new URLSearchParams(location.search).get("tab") === "trust" ? "trust" : "overview";
  const storedDevMode = localStorage.getItem("releasedeck:dev-mode") === "true";
  const storedTheme = localStorage.getItem("releasedeck:theme");
  let theme: "dark" | "light" = storedTheme === "light" ? "light" : "dark";
  const initialView = parseViewState(
    location.search,
    initialRoute.discoverPeriod === "releasebar",
    storedDevMode,
  );
  const routeScope = initialRoute.owner ?? "default";
  const hiddenOwnersKey = `releasedeck:${routeScope}:hidden-owners`;
  const hiddenReposKey = `releasedeck:${routeScope}:hidden-repos`;

  let data: DashboardPayload | null =
    !adminRoute && !repoRoute && !activityPageRoute && embedded?.route === "dashboard"
      ? embedded.payload
      : null;
  let repoDetail: RepoDetailPayload | null =
    repoRoute && embedded?.route === "repo" ? embedded.payload : null;
  let auth: AuthPayload | null = null;
  let query = initialView.query;
  let language = initialView.language;
  let filter: DashboardFilter = initialView.filter;
  let sortKey: SortKey = initialView.sortKey;
  let sortDirection: SortDirection = initialView.sortDirection;
  let devMode = initialView.devMode;
  let hiddenOwners = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenOwnersKey) || "[]") as string[],
  );
  let hiddenRepos = new Set<string>(
    JSON.parse(localStorage.getItem(hiddenReposKey) || "[]") as string[],
  );
  let settingsOpen = false;
  let sourceInput = "";
  let profileSaving = false;
  let profileMessage = "";
  let errorMessage = "";
  let paletteText = "";
  let generatedLabel = embedded ? "cached" : "loading";
  let generatedDetail = embedded ? "rendered from cached data" : "";
  let mounted = false;
  let activityRange: ActivityRange = (() => {
    const value = new URLSearchParams(location.search).get("range");
    return value === "day" || value === "month" ? value : "week";
  })();
  let activity: OwnerActivityPayload | null = null;
  let activityLoading = false;
  let activityError = "";
  let repoSummaryRange: RepoActivityRange = "release";
  let repoActivity: RepoDetailActivityPayload | null = null;
  let repoActivityLoading = false;
  let repoActivityError = "";
  let trustProfile: TrustProfilePayload | null = null;
  let trustProfileLoading = false;
  let trustProfileError = "";
  let audienceRange: AudienceRange = "month";
  let audienceQuery = "";
  let audience: RepoAudiencePayload | null = null;
  let audienceLoading = false;
  let audienceError = "";
  let audienceBackfillLoading = false;
  let audienceBackfillMessage = "";
  let ownerTab: "overview" | "trust" = initialOwnerTab;
  let admin: AdminDashboardPayload | null = null;
  let adminLoading = false;
  let adminError = "";
  let adminActionMessage = "";
  let manualRefreshLoading = false;
  let rateLimitHit = false;

  const discoverPeriods: Array<{ value: DiscoverPeriod; label: string }> = [
    { value: "day", label: "today" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "year", label: "year" },
    { value: "releasebar", label: "releasebar" },
  ];
  const discoverLanguages = ["TypeScript", "Python", "Rust", "Go", "Swift"];
  const activityRanges: Array<{ value: ActivityRange; label: string }> = [
    { value: "day", label: "last day" },
    { value: "week", label: "last week" },
    { value: "month", label: "last month" },
  ];
  const audienceRanges: Array<{ value: AudienceRange; label: string }> = [
    { value: "week", label: "week" },
    { value: "month", label: "month" },
  ];

  $: repoSummaryRanges = repoDetail?.project.releaseDate
    ? [...activityRanges, { value: "release" as RepoActivityRange, label: "since release" }]
    : activityRanges;
  $: isAdminUser = auth?.user?.login.toLowerCase() === "steipete";
  $: label = adminRoute
    ? "ReleaseBar Admin"
    : activityPageRoute
      ? `@${activityPageRoute.owner} activity`
    : repoRoute
      ? (repoDetail?.fullName ?? repoRoute.fullName)
      : data
        ? dashboardOwnerLabel(data, initialRoute)
        : initialRoute.label;
  $: heroOwner = dashboardOwner(data, initialRoute, Boolean(repoRoute));
  $: heroExtraCount = initialRoute.extraOwners.length + initialRoute.repos.length;
  $: subtitle = adminRoute
    ? "Scheduler, refresh jobs, and cache health."
    : activityPageRoute
      ? "A ranked, repository-by-repository record of recent public work."
    : repoRoute
    ? (repoDetail?.project.description ?? "Repository release and activity detail.")
    : data?.subtitle ?? "Release debt across recently requested public dashboards.";
  $: repoActionUrl = repoRoute
    ? (repoDetail?.project.url ?? `https://github.com/${encodeURIComponent(repoRoute.owner)}/${encodeURIComponent(repoRoute.repo)}`)
    : null;
  $: profileSourceCount =
    (data?.profile?.includeOwners.length ?? 0) + (data?.profile?.includeRepos.length ?? 0);
  $: subtitleOwner =
    !repoRoute &&
    !activityPageRoute &&
    !initialRoute.isDefault &&
    initialRoute.owner &&
    initialRoute.extraOwners.length === 0 &&
    initialRoute.repos.length === 0 &&
    (!data || (data.owners.length === 1 && profileSourceCount === 0))
      ? (data?.owners[0]?.login ?? initialRoute.owner)
      : null;
  $: includeArchived = data?.options?.includeArchived === true;
  $: visibleProjects = data
    ? data.projects.filter((project) =>
        matchesDashboardProject(
          project,
          query,
          language,
          hiddenOwners,
          hiddenRepos,
          includeArchived,
        ),
      )
    : [];
  $: filteredProjects = sortProjects(
    visibleProjects.filter((project) => matchesFilter(project, filter)),
    sortKey,
    sortDirection,
  );
  $: dashboardFetching =
    (!data && !errorMessage) ||
    (data?.cache?.state === "rebuilding" && data.projects.length === 0);
  $: dashboardUpdating = data?.cache?.state === "partial";
  $: manualRefreshAvailable =
    !adminRoute && !repoRoute && !activityPageRoute && !initialRoute.isDefault;
  $: ownerToggles = data
    ? [...new Set(data.projects.map((project) => project.owner.toLowerCase()))].sort()
    : [];
  $: visibleOwnerCount = new Set(visibleProjects.map((project) => project.owner.toLowerCase())).size;
  $: showProjectOwnerAvatars = initialRoute.isDefault || visibleOwnerCount > 1;
  $: languageOptions = data
    ? [
        ...new Set(
          data.projects
            .filter((project) =>
              matchesDashboardProject(project, "", "", hiddenOwners, hiddenRepos, includeArchived),
            )
            .map((project) => project.language)
            .filter((language): language is string => Boolean(language)),
        ),
      ].sort((a, b) => a.localeCompare(b))
    : [];
  $: publicProfile = data?.profile ?? null;
  $: publicSourceCount =
    (publicProfile?.includeOwners.length ?? 0) + (publicProfile?.includeRepos.length ?? 0);
  $: sourceCount = publicSourceCount + initialRoute.extraOwners.length + initialRoute.repos.length;
  $: hiddenCount = hiddenOwners.size + hiddenRepos.size;
  $: settingsSummary = `${sourceCount === 0 ? "default sources" : `${numberFormat.format(sourceCount)} added`} · ${
    hiddenCount === 0 ? "all visible" : `${numberFormat.format(hiddenCount)} hidden`
  }`;
  $: connectionStatus = authStatus(auth);
  $: canEditPublicDefault =
    !repoRoute &&
    Boolean(auth?.user && initialRoute.owner) &&
    auth?.user?.login.toLowerCase() === initialRoute.owner?.toLowerCase();
  $: commandActions = defineActions(
    buildCommands(
      {
        projects: filteredProjects,
        owners: ownerToggles,
        languages: languageOptions,
        language,
        typedText: paletteText,
        hiddenOwners,
        hiddenRepos,
        auth,
        devMode,
        sortKey,
        sortDirection,
        filter,
        settingsSummary,
        adminRoute,
        discoverPeriods,
      },
      {
        openOwner,
        addSource,
        discoverHref,
        setSort,
        setFilter,
        setLanguage: setLanguageFilter,
        openUrl,
        toggleRepo,
        toggleOwner,
        setDevMode,
        focusSearch,
        copyDashboardUrl,
        openSettings,
        resetHidden,
        primaryAuthAction,
        installApp,
        logout,
      },
    ),
  );
  $: document.body.classList.toggle("dev-mode", devMode);
  $: document.title = `${label} · release.bar`;
  $: activeDiscoverPeriod = initialRoute.discoverPeriod ?? "week";
  $: activeDiscoverLanguage = initialRoute.discoverLanguage;
  $: syncViewState(query, language, filter, sortKey, sortDirection, devMode);
  $: showOwnerActivity =
    Boolean(activityPageRoute) ||
    (!repoRoute && !initialRoute.isDefault && Boolean(initialRoute.owner) && heroExtraCount === 0);
  $: showTrustProfile = showOwnerActivity && !activityPageRoute;

  const ownerAvatarUrl = githubOwnerAvatar;
  const projectOwnerAvatarUrl = (project: Project): string =>
    githubProjectOwnerAvatar(project, data);

  // Keep auth explicit so Svelte tracks async auth updates in template helper calls.

  function setSort(key: SortKey): void {
    if (isDevSortKey(key) && !devMode) {
      setDevMode(true);
    }
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = defaultSortDirection(key);
    }
  }

  function setFilter(value: DashboardFilter): void {
    filter = value;
  }

  function openSettings(): void {
    settingsOpen = true;
  }

  function applyTheme(next: "dark" | "light"): void {
    theme = next;
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    localStorage.setItem("releasedeck:theme", next);
  }

  function toggleTheme(): void {
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  function setDevMode(value: boolean): void {
    devMode = value;
    if (!devMode && isDevSortKey(sortKey)) {
      sortKey = "activity";
      sortDirection = defaultSortDirection(sortKey);
    }
    localStorage.setItem("releasedeck:dev-mode", String(devMode));
  }

  function discoverHref(period: DiscoverPeriod, nextLanguage = activeDiscoverLanguage): string {
    const params = new URLSearchParams();
    if (period !== "week") params.set("period", period);
    if (nextLanguage.trim() && period !== "releasebar") params.set("hotLang", nextLanguage.trim());
    const search = params.toString();
    return search ? `/?${search}` : "/";
  }

  function discoverLanguageHref(nextLanguage: string): string {
    return discoverHref(
      activeDiscoverPeriod,
      discoverLanguageActive(nextLanguage) ? "" : nextLanguage,
    );
  }

  function discoverLanguageActive(nextLanguage: string): boolean {
    return activeDiscoverLanguage.toLowerCase() === nextLanguage.toLowerCase();
  }

  function syncViewState(
    activeQuery: string,
    activeLanguage: string,
    activeFilter: DashboardFilter,
    activeSortKey: SortKey,
    activeSortDirection: SortDirection,
    devEnabled: boolean,
  ): void {
    if (!mounted) return;
    if (repoRoute || activityPageRoute) return;
    const nextSearch = viewStateSearch(
      location.search,
      {
        query: activeQuery,
        language: activeLanguage,
        filter: activeFilter,
        sortKey: activeSortKey,
        sortDirection: activeSortDirection,
        devMode: devEnabled,
      },
      initialRoute.discoverPeriod === "releasebar",
    );
    if (nextSearch === location.search) return;
    const nextUrl = `${location.pathname}${nextSearch}${location.hash}`;
    history.replaceState(history.state, "", nextUrl);
  }

  function noteGitHubRateLimit(
    status: number | null,
    ...messages: Array<string | null | undefined>
  ): void {
    if (isGitHubRateLimit(status, ...messages)) {
      rateLimitHit = true;
    }
  }

  const activityControllerContext: ActivityControllerContext = {
    initialRoute,
    activityPageRoute,
    repoRoute,
    get showOwnerActivity() {
      return showOwnerActivity;
    },
    get showTrustProfile() {
      return showTrustProfile;
    },
    get activityRange() {
      return activityRange;
    },
    set activityRange(value) {
      activityRange = value;
    },
    get activity() {
      return activity;
    },
    set activity(value) {
      activity = value;
    },
    get activityLoading() {
      return activityLoading;
    },
    set activityLoading(value) {
      activityLoading = value;
    },
    get activityError() {
      return activityError;
    },
    set activityError(value) {
      activityError = value;
    },
    get repoSummaryRange() {
      return repoSummaryRange;
    },
    set repoSummaryRange(value) {
      repoSummaryRange = value;
    },
    get repoActivity() {
      return repoActivity;
    },
    set repoActivity(value) {
      repoActivity = value;
    },
    get repoActivityLoading() {
      return repoActivityLoading;
    },
    set repoActivityLoading(value) {
      repoActivityLoading = value;
    },
    get repoActivityError() {
      return repoActivityError;
    },
    set repoActivityError(value) {
      repoActivityError = value;
    },
    get trustProfile() {
      return trustProfile;
    },
    set trustProfile(value) {
      trustProfile = value;
    },
    get trustProfileLoading() {
      return trustProfileLoading;
    },
    set trustProfileLoading(value) {
      trustProfileLoading = value;
    },
    get trustProfileError() {
      return trustProfileError;
    },
    set trustProfileError(value) {
      trustProfileError = value;
    },
    get audienceRange() {
      return audienceRange;
    },
    set audienceRange(value) {
      audienceRange = value;
    },
    get audience() {
      return audience;
    },
    set audience(value) {
      audience = value;
    },
    get audienceLoading() {
      return audienceLoading;
    },
    set audienceLoading(value) {
      audienceLoading = value;
    },
    get audienceError() {
      return audienceError;
    },
    set audienceError(value) {
      audienceError = value;
    },
    get audienceBackfillLoading() {
      return audienceBackfillLoading;
    },
    set audienceBackfillLoading(value) {
      audienceBackfillLoading = value;
    },
    get audienceBackfillMessage() {
      return audienceBackfillMessage;
    },
    set audienceBackfillMessage(value) {
      audienceBackfillMessage = value;
    },
    get generatedLabel() {
      return generatedLabel;
    },
    set generatedLabel(value) {
      generatedLabel = value;
    },
    get generatedDetail() {
      return generatedDetail;
    },
    set generatedDetail(value) {
      generatedDetail = value;
    },
    noteGitHubRateLimit,
  };
  const activityController = createActivityController(activityControllerContext);
  const {
    loadOwnerActivity,
    loadTrustProfile,
    loadRepoAudience,
    backfillRepoAudience,
    setActivityRange,
    setAudienceRange,
    loadRepoActivity,
    setRepoSummaryRange,
  } = activityController;

  function routeState(): RouteState {
    return {
      data,
      repoDetail,
      repoSummaryRange,
      repoActivity,
      generatedLabel,
      generatedDetail,
      errorMessage,
      manualRefreshLoading,
    };
  }

  function updateRouteState(patch: Partial<RouteState>): void {
    if ("data" in patch) data = patch.data ?? null;
    if ("repoDetail" in patch) repoDetail = patch.repoDetail ?? null;
    if (patch.repoSummaryRange !== undefined) repoSummaryRange = patch.repoSummaryRange;
    if ("repoActivity" in patch) repoActivity = patch.repoActivity ?? null;
    if (patch.generatedLabel !== undefined) generatedLabel = patch.generatedLabel;
    if (patch.generatedDetail !== undefined) generatedDetail = patch.generatedDetail;
    if (patch.errorMessage !== undefined) errorMessage = patch.errorMessage;
    if (patch.manualRefreshLoading !== undefined) {
      manualRefreshLoading = patch.manualRefreshLoading;
    }
  }

  const routeController = createRouteController({
    initialRoute,
    activityPageRoute,
    repoRoute,
    manualRefreshAvailable: () => manualRefreshAvailable,
    getState: routeState,
    update: updateRouteState,
    noteGitHubRateLimit,
    loadRepoActivity,
  });
  const {
    updateStatus,
    updateRepoDetailStatus,
    reportDashboardTiming,
    shouldAutoRefresh,
    closeDashboardStream,
    loadDashboard,
    manualRefreshDashboard,
    loadRepoDetail,
  } = routeController;

  function settingsState(): SettingsState {
    return {
      auth,
      hiddenOwners,
      hiddenRepos,
      publicProfile,
      canEditPublicDefault,
      profileSaving,
      profileMessage,
    };
  }

  function updateSettingsState(patch: Partial<SettingsState>): void {
    if ("auth" in patch) auth = patch.auth ?? null;
    if (patch.hiddenOwners !== undefined) hiddenOwners = patch.hiddenOwners;
    if (patch.hiddenRepos !== undefined) hiddenRepos = patch.hiddenRepos;
    if (patch.profileSaving !== undefined) profileSaving = patch.profileSaving;
    if (patch.profileMessage !== undefined) profileMessage = patch.profileMessage;
  }

  const settingsController = createSettingsController({
    initialRoute,
    adminRoute,
    hiddenOwnersKey,
    hiddenReposKey,
    getState: settingsState,
    update: updateSettingsState,
  });
  const {
    currentReturnTo,
    addSource,
    savePublicDefault,
    resetPublicDefault,
    openOwner,
    openSignedInUserDashboard,
    toggleOwner,
    toggleRepo,
    resetHidden,
    login,
    installApp,
    primaryAuthAction,
    primaryAuthLabel,
    primaryAuthTitle,
    logout,
    authStatus,
  } = settingsController;

  function adminState(): AdminState {
    return {
      auth,
      admin,
      adminLoading,
      adminError,
      adminActionMessage,
      generatedLabel,
      generatedDetail,
    };
  }

  function updateAdminState(patch: Partial<AdminState>): void {
    if ("auth" in patch) auth = patch.auth ?? null;
    if ("admin" in patch) admin = patch.admin ?? null;
    if (patch.adminLoading !== undefined) adminLoading = patch.adminLoading;
    if (patch.adminError !== undefined) adminError = patch.adminError;
    if (patch.adminActionMessage !== undefined) adminActionMessage = patch.adminActionMessage;
    if (patch.generatedLabel !== undefined) generatedLabel = patch.generatedLabel;
    if (patch.generatedDetail !== undefined) generatedDetail = patch.generatedDetail;
  }

  const { loadAuth, loadAdmin, runScheduler, syncInstallations } = createAdminController({
    adminRoute,
    currentReturnTo,
    getState: adminState,
    update: updateAdminState,
  });

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

  function activeLanguage(nextLanguage: string): boolean {
    return language.trim().toLowerCase() === nextLanguage.toLowerCase();
  }

  function setLanguageFilter(nextLanguage: string): void {
    language = nextLanguage;
  }

  function toggleLanguageFilter(nextLanguage: string): void {
    language = activeLanguage(nextLanguage) ? "" : nextLanguage;
  }

  function focusSearch(): void {
    document.querySelector<HTMLInputElement>(".prompt input")?.focus();
  }

  async function copyDashboardUrl(): Promise<void> {
    await navigator.clipboard?.writeText(location.href);
  }

  onMount(() => {
    mounted = true;
    if (isDevSortKey(sortKey) && !devMode) {
      devMode = true;
    }
    const unsubscribe = paletteStore.subscribe((value: PaletteStoreParams) => {
      paletteText = value.textInput;
    });
    const routeTask = (() => {
      if (adminRoute) {
        return loadAdmin();
      }
      if (activityPageRoute) {
        return Promise.resolve();
      }
      if (repoRoute && repoDetail) {
        if (!repoDetail.project.releaseDate && repoSummaryRange === "release") {
          repoSummaryRange = "month";
        }
        updateRepoDetailStatus();
        if (
          repoDetail.cache.state === "warming" ||
          repoDetail.cache.state === "stale" ||
          repoDetail.releaseSummary?.state === "warming"
        ) {
          return loadRepoDetail();
        }
        if (repoSummaryRange !== "release" && !repoActivity) {
          void loadRepoActivity();
        }
        return Promise.resolve();
      }
      if (!repoRoute && data) {
        updateStatus();
        void reportDashboardTiming(data, {
          source: "embedded",
          attempt: 0,
          totalMs: Math.round(performance.now()),
        });
        if (new URLSearchParams(location.search).has("rdRefresh")) {
          return loadDashboard();
        }
        if (shouldAutoRefresh(data)) {
          return loadDashboard();
        } else {
          closeDashboardStream();
        }
        return Promise.resolve();
      }
      return repoRoute ? loadRepoDetail() : loadDashboard();
    })();
    void Promise.all([
      loadAuth(),
      routeTask,
      !adminRoute && showTrustProfile ? loadTrustProfile() : Promise.resolve(),
      !adminRoute && repoRoute ? loadRepoAudience() : Promise.resolve(),
      !adminRoute && showOwnerActivity ? loadOwnerActivity() : Promise.resolve(),
    ]).catch((error) => {
      generatedLabel = "failed";
      generatedDetail = error instanceof Error ? error.message : String(error);
      errorMessage = generatedDetail;
    });
    return () => unsubscribe();
  });

  onDestroy(() => {
    routeController.destroy();
    activityController.destroy();
    closeDashboardStream();
    document.body.classList.remove("dev-mode");
  });
</script>

<main class="shell">
  <AppHeader
    {repoRoute}
    {activityPageRoute}
    {repoDetail}
    {heroOwner}
    {heroExtraCount}
    {label}
    {subtitleOwner}
    {subtitle}
    {repoActionUrl}
    {generatedLabel}
    {generatedDetail}
    {manualRefreshAvailable}
    {manualRefreshLoading}
    {manualRefreshDashboard}
    {theme}
    {toggleTheme}
    {auth}
    bind:settingsOpen
    {rateLimitHit}
    {adminRoute}
    {ownerAvatarUrl}
    {projectOwnerAvatarUrl}
    {openSignedInUserDashboard}
    {installApp}
    {logout}
    {primaryAuthAction}
    {primaryAuthTitle}
    {primaryAuthLabel}
  />

  <DashboardControls
    {repoRoute}
    {activityPageRoute}
    isDefault={initialRoute.isDefault}
    {discoverPeriods}
    {activeDiscoverPeriod}
    {activeDiscoverLanguage}
    {discoverLanguages}
    {discoverHref}
    {discoverLanguageHref}
    {discoverLanguageActive}
    bind:settingsOpen
    {settingsSummary}
    {publicProfile}
    {canEditPublicDefault}
    {connectionStatus}
    {isAdminUser}
    bind:sourceInput
    {handleSourceSubmit}
    {profileSaving}
    {savePublicDefault}
    {resetPublicDefault}
    {profileMessage}
    {ownerToggles}
    {hiddenOwners}
    {hiddenRepos}
    {data}
    {toggleOwner}
    {toggleRepo}
  />

  {#if adminRoute}
    <AdminConsole
      {adminError}
      {auth}
      {adminLoading}
      {admin}
      {adminActionMessage}
      {login}
      {loadAdmin}
      {runScheduler}
      {syncInstallations}
    />
  {:else if activityPageRoute}
    <OwnerActivityPage
      {activityPageRoute}
      {activityRange}
      {activityRanges}
      {activityLoading}
      {activityError}
      {activity}
      {setActivityRange}
    />
  {:else if repoRoute}
    <RepoDetail
      {errorMessage}
      {rateLimitHit}
      {auth}
      {primaryAuthAction}
      {primaryAuthLabel}
      {repoDetail}
      {repoSummaryRange}
      {repoSummaryRanges}
      {repoActivity}
      {repoActivityLoading}
      {repoActivityError}
      {setRepoSummaryRange}
      {audienceRange}
      {audienceRanges}
      bind:audienceQuery
      {audience}
      {audienceLoading}
      {audienceError}
      {audienceBackfillLoading}
      {audienceBackfillMessage}
      {setAudienceRange}
      {backfillRepoAudience}
    />
  {:else}
    <OwnerOverview
      {showTrustProfile}
      bind:ownerTab
      {trustProfileLoading}
      {trustProfileError}
      {trustProfile}
      ownerType={heroOwner?.type ?? null}
      {showOwnerActivity}
      {activityRanges}
      {activityRange}
      {activityLoading}
      {activityError}
      {activity}
      owner={initialRoute.owner}
      {setActivityRange}
    />
    {#if !showTrustProfile || ownerTab === "overview"}
      <ProjectTable
        bind:query
        bind:language
        bind:filter
        {sortKey}
        {sortDirection}
        {devMode}
        {visibleProjects}
        {filteredProjects}
        {errorMessage}
        {dashboardFetching}
        {dashboardUpdating}
        {data}
        {rateLimitHit}
        {auth}
        {showProjectOwnerAvatars}
        {setSort}
        {setDevMode}
        {toggleLanguageFilter}
        {primaryAuthAction}
        {primaryAuthLabel}
        {projectOwnerAvatarUrl}
      />
    {/if}
  {/if}
</main>

<footer class="site-footer">
  <span>A project by</span>
  <a class="external-link" href="https://steipete.me" target="_blank" rel="noreferrer">Peter Steinberger</a>
  <span class="footer-separator" aria-hidden="true">.</span>
  <a class="external-link" href="https://github.com/steipete/ReleaseBar/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT Licensed</a>
</footer>

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

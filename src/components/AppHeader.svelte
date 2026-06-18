<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ownerDashboardPath } from "../routing.js";
  import type { AuthPayload, Owner, Project, RepoDetailPayload } from "../types.js";

  type RepoRoute = { owner: string; repo: string; fullName: string };

  export let repoRoute: RepoRoute | null;
  export let activityPageRoute: { owner: string } | null;
  export let repoDetail: RepoDetailPayload | null;
  export let heroOwner: Owner | null;
  export let heroExtraCount: number;
  export let label: string;
  export let subtitleOwner: string | null;
  export let subtitle: string;
  export let repoActionUrl: string | null;
  export let generatedLabel: string;
  export let generatedDetail: string;
  export let manualRefreshAvailable: boolean;
  export let manualRefreshLoading: boolean;
  export let manualRefreshDashboard: () => Promise<void>;
  export let theme: "dark" | "light";
  export let toggleTheme: () => void;
  export let auth: AuthPayload | null;
  export let settingsOpen: boolean;
  export let rateLimitHit: boolean;
  export let adminRoute: boolean;
  export let ownerAvatarUrl: (owner: Owner) => string;
  export let projectOwnerAvatarUrl: (project: Project) => string;
  export let openSignedInUserDashboard: () => void;
  export let installApp: () => void;
  export let logout: () => void;
  export let primaryAuthAction: () => void;
  export let primaryAuthTitle: (auth: AuthPayload | null) => string;
  export let primaryAuthLabel: (auth: AuthPayload | null, compact?: boolean) => string;
</script>

<header class="topline">
  <div class="hero-copy">
    <nav class="eyebrow-nav" aria-label="Page navigation">
      <a class="eyebrow brand" href="/">release.bar</a>
      {#if repoRoute}
        <span aria-hidden="true">/</span>
        <a class="eyebrow eyebrow-back" href={ownerDashboardPath(repoRoute.owner)}>
          <span aria-hidden="true">←</span>
          @{repoRoute.owner}
        </a>
      {:else if activityPageRoute}
        <span aria-hidden="true">/</span>
        <a class="eyebrow eyebrow-back" href={ownerDashboardPath(activityPageRoute.owner)}>
          <span aria-hidden="true">←</span>
          dashboard
        </a>
      {/if}
    </nav>
    <h1>
      {#if heroOwner}
        <span class="hero-owner-title">
          <a class="hero-owner-link" href={ownerDashboardPath(heroOwner.login)}>
            <img
              class="hero-owner-avatar"
              src={ownerAvatarUrl(heroOwner)}
              alt=""
              width="88"
              height="88"
              loading="eager"
            />
            <span>@{heroOwner.login}</span>
          </a>
          {#if heroExtraCount > 0}
            <span>+{heroExtraCount}</span>
          {/if}
          {#if activityPageRoute}
            <span class="hero-section-label">activity</span>
          {/if}
        </span>
      {:else if repoRoute && repoDetail}
        <span class="repo-hero-title">
          <a
            class="repo-title-avatar-link"
            href={ownerDashboardPath(repoDetail.project.owner)}
            aria-label={`Open @${repoDetail.project.owner} dashboard`}
          >
            <img
              class="repo-title-avatar"
              src={projectOwnerAvatarUrl(repoDetail.project)}
              alt=""
              width="88"
              height="88"
              loading="eager"
            />
          </a>
          <span class="repo-title-text" title={label}>
            <span class="repo-title-name">{repoDetail.project.name}</span>
          </span>
        </span>
      {:else}
        {label}
      {/if}
    </h1>
    <p class="subtitle">
      {#if subtitleOwner}
        Release freshness for
        <a class="subtitle-link" href={ownerDashboardPath(subtitleOwner)}>
          @{subtitleOwner}</a
        >.
      {:else}
        {subtitle}
      {/if}
    </p>
    {#if repoActionUrl}
      <nav class="repo-actions" aria-label="Repository links">
        <a class="external-link" href={repoActionUrl} target="_blank" rel="noreferrer">GitHub</a>
        <a class="external-link" href={`${repoActionUrl}/releases`} target="_blank" rel="noreferrer">Releases</a>
        <a class="external-link" href={repoDetail?.project.issuesUrl ?? `${repoActionUrl}/issues`} target="_blank" rel="noreferrer">Issues</a>
        <a class="external-link" href={repoDetail?.project.pullRequestsUrl ?? `${repoActionUrl}/pulls`} target="_blank" rel="noreferrer">PRs</a>
      </nav>
    {/if}
  </div>
  <div class="top-actions">
    <button
      type="button"
      class="status"
      aria-live="polite"
      aria-label={generatedDetail ? `${generatedLabel} · ${generatedDetail}` : generatedLabel}
      data-tooltip={generatedDetail || undefined}
      tabindex={generatedDetail ? 0 : undefined}
    >
      <span class="pulse"></span>
      <span>{generatedLabel}</span>
    </button>

    {#if manualRefreshAvailable}
      <button
        type="button"
        class="refresh-toggle"
        disabled={manualRefreshLoading}
        onclick={manualRefreshDashboard}
        aria-label="Refresh dashboard"
        title="Refresh dashboard"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 1-15.2 6.5" />
          <path d="M3 12A9 9 0 0 1 18.2 5.5" />
          <path d="M18 2v4h-4" />
          <path d="M6 22v-4h4" />
        </svg>
      </button>
    {/if}

    <button
      type="button"
      class="theme-toggle"
      onclick={toggleTheme}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {#if theme === "dark"}
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      {/if}
    </button>

    {#if auth?.user}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="account-button">
          <img class="account-avatar" src={auth.user.avatarUrl} alt="" width="24" height="24" loading="lazy" />
          <span class="account-label">@{auth.user.login}</span>
          <span class="account-caret" aria-hidden="true"></span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content class="account-dropdown" align="end" sideOffset={8} loop>
          <DropdownMenu.Item class="menu-action" onSelect={openSignedInUserDashboard}>
            My Dashboard
          </DropdownMenu.Item>
          {#if !repoRoute && !activityPageRoute}
            <DropdownMenu.Item class="menu-action" onSelect={() => (settingsOpen = !settingsOpen)}>
              Settings
            </DropdownMenu.Item>
          {/if}
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
        disabled={!auth?.configured && !auth?.quotaConfigured}
        onclick={primaryAuthAction}
        title={primaryAuthTitle(auth)}
      >
        <span class="account-label account-label-full">{primaryAuthLabel(auth)}</span>
        <span class="account-label account-label-short">{primaryAuthLabel(auth, true)}</span>
        {#if auth?.configured || auth?.quotaConfigured}
          <span class="account-caret" aria-hidden="true"></span>
        {/if}
      </button>
    {/if}
  </div>
</header>

{#if rateLimitHit && !adminRoute}
  <aside class="quota-install-callout" role="alert" aria-live="assertive">
    <div>
      <span>GitHub rate limit</span>
      <strong>Switch this dashboard to dedicated GitHub App quota.</strong>
      <small>Install or update ReleaseBar access for the GitHub account you are viewing.</small>
    </div>
    <button type="button" onclick={installApp}>Install GitHub App</button>
  </aside>
{/if}


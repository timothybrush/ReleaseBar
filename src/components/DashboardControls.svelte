<script lang="ts">
  import type { DashboardPayload } from "../types.js";
  import type { DiscoverPeriod } from "../routing.js";

  export let repoRoute: unknown | null;
  export let activityPageRoute: unknown | null;
  export let isDefault: boolean;
  export let discoverPeriods: Array<{ value: DiscoverPeriod; label: string }>;
  export let activeDiscoverPeriod: DiscoverPeriod;
  export let activeDiscoverLanguage: string | null;
  export let discoverLanguages: string[];
  export let discoverHref: (period: DiscoverPeriod, language?: string) => string;
  export let discoverLanguageHref: (language: string) => string;
  export let discoverLanguageActive: (language: string) => boolean;
  export let settingsOpen: boolean;
  export let settingsSummary: string;
  export let publicProfile: DashboardPayload["profile"] | null;
  export let canEditPublicDefault: boolean;
  export let connectionStatus: string;
  export let isAdminUser: boolean;
  export let sourceInput: string;
  export let handleSourceSubmit: (event: SubmitEvent) => void;
  export let profileSaving: boolean;
  export let savePublicDefault: () => Promise<void>;
  export let resetPublicDefault: () => Promise<void>;
  export let profileMessage: string;
  export let ownerToggles: string[];
  export let hiddenOwners: Set<string>;
  export let hiddenRepos: Set<string>;
  export let data: DashboardPayload | null;
  export let toggleOwner: (owner: string, visible: boolean) => void;
  export let toggleRepo: (repo: string, visible: boolean) => void;
</script>

{#if !repoRoute && isDefault}
  <nav class="discover-nav" aria-label="Discover GitHub repositories">
    <div class="discover-group" aria-label="Time range">
      {#each discoverPeriods as period}
        <a
          class:active={activeDiscoverPeriod === period.value}
          href={discoverHref(period.value)}
          aria-current={activeDiscoverPeriod === period.value ? "page" : undefined}
        >
          {period.label}
        </a>
      {/each}
    </div>
    {#if activeDiscoverPeriod !== "releasebar"}
      <div class="discover-group" aria-label="Language">
        <a
          class:active={!activeDiscoverLanguage}
          href={discoverHref(activeDiscoverPeriod, "")}
          aria-current={!activeDiscoverLanguage ? "page" : undefined}
        >
          all
        </a>
        {#each discoverLanguages as discoverLanguage}
          <a
            class:active={discoverLanguageActive(discoverLanguage)}
            href={discoverLanguageHref(discoverLanguage)}
            aria-current={discoverLanguageActive(discoverLanguage) ? "page" : undefined}
          >
            {discoverLanguage}
          </a>
        {/each}
      </div>
    {/if}
  </nav>
{/if}

{#if settingsOpen && !repoRoute && !activityPageRoute}
  <div class="settings-panel" aria-label="Dashboard settings" data-open>
    <button
      class="settings-close"
      type="button"
      aria-label="Close settings"
      onclick={() => (settingsOpen = false)}
    >
      <span aria-hidden="true">×</span>
    </button>
    <div>
      <strong>dashboard</strong>
      <p>{settingsSummary}</p>
      <p class="profile-badge">
        {publicProfile
          ? `public profile config · saved by @${publicProfile.updatedBy}`
          : canEditPublicDefault
            ? "public profile config · not saved yet"
            : "local view settings"}
      </p>
      <p class="public-note">Only public GitHub repositories are listed, stored, and selectable.</p>
      <p class="connection-status">{connectionStatus}</p>
      {#if isAdminUser}
        <a class="settings-admin-link" href="/_admin">Admin</a>
      {/if}
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
      {#if canEditPublicDefault}
        <div class="profile-actions">
          <button type="button" disabled={profileSaving} onclick={savePublicDefault}>
            save default
          </button>
          <button type="button" disabled={profileSaving} onclick={resetPublicDefault}>
            reset
          </button>
        </div>
        <p class="profile-status">
          {profileMessage || "Save custom sources and visibility as the public default for this route."}
        </p>
      {/if}
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

<script lang="ts">
  import {
    activityMeta,
    audienceReasonText,
    factorContribution,
    numberFormat,
    quotaLabel,
    relativeDate,
    trustDimensionEntries,
    trustProfileAge,
  } from "../app-format.js";
  import { ownerActivityPath, repoDetailPath } from "../routing.js";
  import type {
    ActivityRange,
    Owner,
    OwnerActivityPayload,
    TrustProfilePayload,
  } from "../types.js";

  export let showTrustProfile: boolean;
  export let ownerTab: "overview" | "trust";
  export let trustProfileLoading: boolean;
  export let trustProfileError: string;
  export let trustProfile: TrustProfilePayload | null = null;
  export let ownerType: Owner["type"] | null = null;
  export let showOwnerActivity: boolean;
  export let activityRanges: Array<{ value: ActivityRange; label: string }>;
  export let activityRange: ActivityRange;
  export let activityLoading: boolean;
  export let activityError: string;
  export let activity: OwnerActivityPayload | null;
  export let owner: string | null;
  export let setActivityRange: (range: ActivityRange) => void;

  function setOwnerTab(tab: "overview" | "trust"): void {
    ownerTab = tab;
    const url = new URL(location.href);
    if (tab === "trust") url.searchParams.set("tab", "trust");
    else url.searchParams.delete("tab");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function ownerSignalLabel(payload: TrustProfilePayload | null = trustProfile): string {
    if (payload) return payload.scoreLabel;
    return ownerType === "org" ? "org signal" : "trust";
  }

  function ownerSignalDescription(payload: TrustProfilePayload | null = trustProfile): string {
    return payload?.type === "org" || (!payload && ownerType === "org")
      ? "bounded public GitHub organization signals"
      : "bounded public GitHub trust signals";
  }

  function ownerSignalTooltip(payload: TrustProfilePayload | null = trustProfile): string {
    if (payload?.type === "org" || (!payload && ownerType === "org")) {
      return "0–100 bounded public GitHub organization signal from profile, repository footprint, reach, and account safety. Triage context only, not a personal trust score.";
    }
    return "0–100 bounded public GitHub signal from account age, profile completeness, public reach, builder history, organizations, and account safety. Triage context only, not identity proof.";
  }

  function ownerSignalTabLabel(payload: TrustProfilePayload | null = trustProfile): string {
    return payload?.type === "org" || (!payload && ownerType === "org") ? "org signal" : "trust";
  }

  function trustProfileMeta(payload: TrustProfilePayload): string {
    return [
      trustProfileAge(payload),
      `${numberFormat.format(payload.followers)} followers`,
      `${numberFormat.format(payload.publicRepos)} repos`,
      quotaLabel(payload.cache.quota),
      `updated ${relativeDate(payload.generatedAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function trustFactorEntries(payload: TrustProfilePayload): TrustProfilePayload["factors"] {
    return (payload.factors ?? [])
      .filter((factor) => factor.key !== "recency" || factor.value > 0)
      .slice(0, 8);
  }
</script>

{#if showTrustProfile && ownerTab === "overview"}
  <section class="trust-snapshot" aria-label={`${ownerSignalLabel()} summary`}>
    {#if trustProfileLoading}
      <span class="panel-kicker">{ownerSignalTabLabel()}</span>
      <strong>loading</strong>
      <small>{ownerSignalDescription()}</small>
    {:else if trustProfileError}
      <span class="panel-kicker">{ownerSignalTabLabel()}</span>
      <strong>unavailable</strong>
      <small>{trustProfileError}</small>
    {:else if trustProfile}
      <div class="trust-snapshot-score" title={ownerSignalTooltip(trustProfile)} aria-label={`${ownerSignalLabel(trustProfile)} ${trustProfile.score}: ${ownerSignalTooltip(trustProfile)}`}>
        <span class="panel-kicker">{ownerSignalLabel(trustProfile)}</span>
        <strong>{trustProfile.score}</strong>
        <small class={`audience-tier tier-${trustProfile.tier}`}>{trustProfile.tier}</small>
      </div>
      <div>
        <span>GitHub age</span>
        <strong>{trustProfileAge(trustProfile)}</strong>
      </div>
      <div>
        <span>reach</span>
        <strong>{numberFormat.format(trustProfile.followers)} followers</strong>
      </div>
      <div>
        <span>{trustProfile.type === "org" ? "footprint" : "builder"}</span>
        <strong>{numberFormat.format(trustProfile.stats.activeRepositories)} active repos</strong>
      </div>
      <button type="button" onclick={() => setOwnerTab("trust")}>factors</button>
    {:else}
      <span class="panel-kicker">{ownerSignalTabLabel()}</span>
      <strong>pending</strong>
      <small>{ownerSignalDescription()} will appear here.</small>
    {/if}
  </section>
{/if}

{#if showTrustProfile && ownerTab === "trust"}
  <section class="trust-panel" aria-label={`GitHub ${ownerSignalLabel()} profile`}>
    <div class="panel-heading">
      <div title={ownerSignalTooltip(trustProfile)} aria-label={trustProfile ? `${ownerSignalLabel(trustProfile)} ${trustProfile.score}: ${ownerSignalTooltip(trustProfile)}` : ownerSignalTooltip(trustProfile)}>
        <span class="panel-kicker">{ownerSignalTabLabel()}</span>
        <h2>{trustProfile ? `${trustProfile.score}` : "loading"}</h2>
      </div>
      <div class="trust-panel-actions">
        {#if trustProfile}
          <span class={`audience-tier tier-${trustProfile.tier}`}>{trustProfile.tier}</span>
        {/if}
        <button type="button" onclick={() => setOwnerTab("overview")}>overview</button>
      </div>
    </div>

    {#if trustProfileLoading}
      <p class="activity-text">Loading {ownerSignalDescription()}.</p>
    {:else if trustProfileError}
      <p class="activity-text muted">{trustProfileError}</p>
    {:else if trustProfile}
      <div class="trust-summary" aria-label={trustProfileMeta(trustProfile)}>
        <div>
          <span>GitHub age</span>
          <strong>{trustProfileAge(trustProfile)}</strong>
        </div>
        <div>
          <span>public reach</span>
          <strong>{numberFormat.format(trustProfile.followers)} followers</strong>
        </div>
        <div>
          <span>{trustProfile.type === "org" ? "repo footprint" : "builder proof"}</span>
          <strong>{numberFormat.format(trustProfile.stats.activeRepositories)} active repos</strong>
        </div>
        <div>
          <span>repo stars</span>
          <strong>{numberFormat.format(trustProfile.stats.totalStars)}</strong>
        </div>
      </div>

      <div class="trust-dimensions" aria-label={`${ownerSignalLabel(trustProfile)} dimensions`}>
        {#each trustDimensionEntries(trustProfile) as [label, value]}
          <span>
            <small>{label}</small>
            <strong>{value}</strong>
          </span>
        {/each}
      </div>

      {#if trustFactorEntries(trustProfile).length > 0}
        <div class="trust-factors" aria-label={`${ownerSignalLabel(trustProfile)} factors`}>
          {#each trustFactorEntries(trustProfile) as factor}
            <div class:negative={factor.sentiment === "negative"}>
              <span>
                <strong>{factor.label}</strong>
                <small>{factor.detail}</small>
              </span>
              <span class="factor-value">{factor.value}/{factor.maxValue}</span>
              <b style={`--factor-width: ${Math.min(100, Math.round((factor.value / Math.max(1, factor.maxValue)) * 100))}%`}></b>
              <em class="factor-impact">{factorContribution(factor.weightedValue)}</em>
            </div>
          {/each}
        </div>
      {/if}

      <p class="trust-reasons">{audienceReasonText(trustProfile.reasons)}</p>

      {#if trustProfile.topRepositories.length > 0}
        <div class="trust-table" aria-label="Repository evidence">
          {#each trustProfile.topRepositories as repo}
            <a href={repoDetailPath(repo.fullName)}>
              <span>
                <strong>{repo.fullName}</strong>
                <small>{repo.language || repo.topics.slice(0, 2).join(", ") || "public repo"}</small>
              </span>
              <span>{numberFormat.format(repo.stars)} stars</span>
            </a>
          {/each}
        </div>
      {/if}

      <div class="trust-tags" aria-label="Profile signals">
        {#each trustProfile.stats.languages as item}
          <span>{item.name} × {item.count}</span>
        {/each}
        {#each trustProfile.stats.topics.slice(0, 4) as item}
          <span>{item.name} × {item.count}</span>
        {/each}
        {#each trustProfile.orgs.slice(0, 4) as org}
          <span>@{org.login}</span>
        {/each}
      </div>
      <small class="activity-meta">{trustProfileMeta(trustProfile)} · public {trustProfile.type === "org" ? "organization" : "profile"} signals only</small>
    {:else}
      <p class="activity-text muted">{ownerSignalDescription()} will appear here when available.</p>
    {/if}
  </section>
{/if}

{#if showOwnerActivity && ownerTab === "overview"}
  <section class="activity-panel" aria-label="Recent public activity">
    <div class="panel-heading">
      <div>
        <span class="panel-kicker">working on</span>
      </div>
      <div class="range-toggle" aria-label="Activity range">
        {#each activityRanges as range}
          <button
            class:active={activityRange === range.value}
            type="button"
            aria-pressed={activityRange === range.value}
            onclick={() => setActivityRange(range.value)}
          >
            {range.label}
          </button>
        {/each}
      </div>
    </div>

    {#if activityLoading}
      <p class="activity-text">Loading recent work.</p>
    {:else if activity?.summary?.state === "ready" && activity.summary.text}
      <p class="activity-text">{activity.summary.text}</p>
    {:else if activity?.summary?.state === "warming"}
      <p class="activity-text">Summarizing recent work.</p>
    {:else if activity?.summary?.message}
      <p class="activity-text muted">{activity.summary.message}</p>
    {:else if activityError}
      <p class="activity-text muted">{activityError}</p>
    {:else}
      <p class="activity-text muted">Recent work will appear here when GitHub returns enough signal.</p>
    {/if}

    {#if activity}
      <div class="activity-digest">
        <div class="activity-stats" aria-label="Activity totals">
          <span><strong>{numberFormat.format(activity.totals.commits)}</strong><small>commits</small></span>
          <span><strong>{numberFormat.format(activity.totals.pullRequests)}</strong><small>PRs</small></span>
          <span><strong>{numberFormat.format(activity.totals.issues)}</strong><small>issues</small></span>
          <span><strong>{numberFormat.format(activity.totals.comments)}</strong><small>comments</small></span>
        </div>
        {#if activity.repositories.length > 0}
          <div class="activity-repos" aria-label="Most active repositories">
            {#each activity.repositories.slice(0, 5) as repo, index}
              <a href={repoDetailPath(repo.fullName)}>
                <span>{repo.fullName}</span>
                <small aria-label={`${numberFormat.format(repo.events)} activity items`}>
                  {numberFormat.format(repo.events)}
                </small>
                <span class="activity-repo-rank" aria-hidden="true">{index + 1}</span>
              </a>
            {/each}
          </div>
        {/if}
      </div>
      <div class="activity-footer">
        <small class="activity-meta">
          {activityMeta(activity)}
          {#if activity.cache.state === "stale"}
            · refreshing
          {/if}
        </small>
        {#if owner}
          <a class="activity-drilldown" href={ownerActivityPath(owner, activityRange)}>
            view grouped activity <span aria-hidden="true">→</span>
          </a>
        {/if}
      </div>
    {/if}
  </section>
{/if}

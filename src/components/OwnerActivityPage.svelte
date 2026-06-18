<script lang="ts">
  import {
    activityBreakdown,
    activityKindLabel,
    activityMeta,
    maxNumber,
    numberFormat,
    percent,
    relativeDate,
  } from "../app-format.js";
  import { ownerActivityPath, repoDetailPath } from "../routing.js";
  import type { ActivityRange, OwnerActivityPayload } from "../types.js";

  export let activityPageRoute: { owner: string } = { owner: "" };
  export let activityRange: ActivityRange;
  export let activityRanges: Array<{ value: ActivityRange; label: string }>;
  export let activityLoading: boolean;
  export let activityError: string;
  export let activity: OwnerActivityPayload | null = null;
  export let setActivityRange: (range: ActivityRange) => void;

  $: activityMaxRepoEvents = maxNumber(activity?.repositories.map((repo) => repo.events) ?? []);

  function activityPageHref(range: ActivityRange): string {
    return ownerActivityPath(activityPageRoute.owner, range);
  }

  function repositoryEvents(fullName: string): OwnerActivityPayload["events"] {
    return (activity?.events ?? []).filter((event) => event.repo === fullName);
  }

  function repositorySummary(fullName: string): string | null {
    return (
      activity?.summary?.repositories?.find(
        (summary) => summary.fullName.toLowerCase() === fullName.toLowerCase(),
      )?.text ?? null
    );
  }
</script>

<section class="activity-page" aria-label={`Recent activity for @${activityPageRoute.owner}`}>
  <section class="activity-page-summary">
    <div class="activity-page-heading">
      <div>
        <span class="panel-kicker">working log</span>
        <h2>{activityRange === "day" ? "last day" : activityRange === "week" ? "last week" : "last month"}</h2>
      </div>
      <nav class="range-toggle" aria-label="Activity range">
        {#each activityRanges as range}
          <a
            class:active={activityRange === range.value}
            href={activityPageHref(range.value)}
            aria-current={activityRange === range.value ? "page" : undefined}
            onclick={(event) => {
              event.preventDefault();
              setActivityRange(range.value);
            }}
          >
            {range.label}
          </a>
        {/each}
      </nav>
    </div>

    {#if activityLoading}
      <div class="activity-page-loading">
        <span class="loading-kicker">collecting public work</span>
        <strong>grouping repositories</strong>
        <div class="loading-bars" aria-hidden="true"><span></span><span></span><span></span></div>
      </div>
    {:else if activityError && !activity}
      <div class="error-state">
        <span class="loading-kicker">activity unavailable</span>
        <strong>{activityError}</strong>
      </div>
    {:else if activity}
      <div class="activity-overview-copy">
        <span class="activity-overview-index">00</span>
        <div>
          <span class="panel-kicker">AI overview</span>
          {#if activity.summary?.state === "ready" && activity.summary.text}
            <p>{activity.summary.text}</p>
          {:else if activity.summary?.state === "warming"}
            <p class="muted">Summarizing work across repositories.</p>
          {:else}
            <p class="muted">{activity.summary?.message ?? "Not enough recent work to summarize."}</p>
          {/if}
        </div>
      </div>

      <div class="activity-overview-metrics" aria-label="Activity totals">
        <div><strong>{numberFormat.format(activity.totals.repositories)}</strong><span>repositories</span></div>
        <div><strong>{numberFormat.format(activity.totals.commits)}</strong><span>commits</span></div>
        <div><strong>{numberFormat.format(activity.totals.pullRequests)}</strong><span>pull requests</span></div>
        <div><strong>{numberFormat.format(activity.totals.issues)}</strong><span>issues</span></div>
        <div><strong>{numberFormat.format(activity.totals.comments)}</strong><span>comments</span></div>
        <div><strong>{numberFormat.format(activity.totals.releases)}</strong><span>releases</span></div>
      </div>
      <small class="activity-meta">{activityMeta(activity)}</small>
      {#if activityError}
        <small class="activity-meta">Refresh failed: {activityError}</small>
      {/if}
    {/if}
  </section>

  {#if activity && activity.repositories.length > 0}
    <div class="activity-repository-list">
      {#each activity.repositories as repo, index (repo.fullName)}
        <article class="activity-repository-card">
          <div class="activity-rank" aria-label={`Rank ${index + 1}`}>
            {String(index + 1).padStart(2, "0")}
          </div>
          <div class="activity-repository-main">
            <header>
              <div>
                <a class="activity-repository-name" href={repoDetailPath(repo.fullName)}>
                  {repo.fullName}
                </a>
                <span
                  >{numberFormat.format(repo.events)} activity {repo.events === 1
                    ? "item"
                    : "items"} · last active {relativeDate(repo.lastActiveAt)}</span
                >
              </div>
              <a class="activity-repository-open" href={repo.url} target="_blank" rel="noreferrer">
                GitHub ↗
              </a>
            </header>

            <div class="activity-weight" aria-hidden="true">
              <i style={`width: ${percent(repo.events, activityMaxRepoEvents)}%`}></i>
            </div>

            <div class="activity-repository-breakdown">
              {#each activityBreakdown(repo) as item}
                <span><strong>{numberFormat.format(item.value)}</strong> {item.label}</span>
              {/each}
            </div>

            <div class="activity-repository-summary">
              <span class="panel-kicker">AI summary</span>
                  {#if repositorySummary(repo.fullName)}
                    <p>{repositorySummary(repo.fullName)}</p>
              {:else if activity.summary?.state === "warming"}
                <p class="muted">Summarizing this repository.</p>
              {:else}
                <p class="muted">No repository summary available.</p>
              {/if}
            </div>

            <details class="activity-event-details">
              <summary>
                <span>event log</span>
                    <small>{repositoryEvents(repo.fullName).length} grouped entries</small>
              </summary>
              <div class="activity-event-list">
                    {#each repositoryEvents(repo.fullName) as event (event.id)}
                  {#if event.url}
                    <a href={event.url} target="_blank" rel="noreferrer">
                      <span class={`activity-kind kind-${event.kind}`}>{activityKindLabel(event.kind)}</span>
                      <strong>{event.title}</strong>
                      {#if event.count > 1}<small>×{event.count}</small>{/if}
                      <time datetime={event.createdAt}>{relativeDate(event.createdAt)}</time>
                    </a>
                  {:else}
                    <div>
                      <span class={`activity-kind kind-${event.kind}`}>{activityKindLabel(event.kind)}</span>
                      <strong>{event.title}</strong>
                      {#if event.count > 1}<small>×{event.count}</small>{/if}
                      <time datetime={event.createdAt}>{relativeDate(event.createdAt)}</time>
                    </div>
                  {/if}
                {/each}
              </div>
            </details>
          </div>
        </article>
      {/each}
    </div>
  {:else if activity && !activityLoading}
    <div class="loading-state empty-state">
      <span class="loading-kicker">quiet range</span>
      <strong>no public work found</strong>
      <small>Try a longer time range.</small>
    </div>
  {/if}
</section>

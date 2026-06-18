<script lang="ts">
  import { showCodeChurn } from "../dashboard-view.js";
  import {
    audienceInsightText,
    audienceReasonText,
    audienceShare,
    audienceTotalStargazers,
    cadenceSummary,
    countLabel,
    detailValueStyle,
    fitDetailValue,
    formatDays,
    maxNumber,
    numberFormat,
    openWorkCount,
    percent,
    percentOfTotal,
    personTrustScoreTooltip,
    quotaLabel,
    relativeDate,
    releaseSummaryMeta,
    repoActivityMeta,
    shortDate,
  } from "../app-format.js";
  import { ownerDashboardPath, repoDetailPath } from "../routing.js";
  import type {
    ActivityRange,
    AudienceRange,
    AuthPayload,
    RepoAudiencePayload,
    RepoActivityRange,
    RepoDetailActivityPayload,
    RepoDetailPayload,
  } from "../types.js";

  export let errorMessage: string;
  export let rateLimitHit: boolean;
  export let auth: AuthPayload | null;
  export let primaryAuthAction: () => void;
  export let primaryAuthLabel: (auth: AuthPayload | null, compact?: boolean) => string;
  export let repoDetail: RepoDetailPayload | null = null;
  export let repoSummaryRange: RepoActivityRange;
  export let repoSummaryRanges: Array<{ value: ActivityRange | RepoActivityRange; label: string }>;
  export let repoActivity: RepoDetailActivityPayload | null;
  export let repoActivityLoading: boolean;
  export let repoActivityError: string;
  export let setRepoSummaryRange: (range: RepoActivityRange) => void;
  export let audienceRange: AudienceRange;
  export let audienceRanges: Array<{ value: AudienceRange; label: string }>;
  export let audienceQuery = "";
  export let audience: RepoAudiencePayload | null = null;
  export let audienceLoading: boolean;
  export let audienceError: string;
  export let audienceBackfillLoading: boolean;
  export let audienceBackfillMessage: string;
  export let setAudienceRange: (range: AudienceRange) => void;
  export let backfillRepoAudience: () => Promise<void>;

  $: detailMaxCommits = maxNumber(repoDetail?.commitActivity.map((week) => week.total) ?? []);
  $: detailMaxContributorCommits = maxNumber(
    repoDetail?.contributors.map((contributor) => contributor.commits) ?? [],
  );
  $: stableReleases = (repoDetail?.releases ?? [])
    .filter((release) => !release.prerelease)
    .slice(0, 3);
  $: preReleases = (repoDetail?.releases ?? [])
    .filter((release) => release.prerelease)
    .slice(0, 3);
  $: detailLanguageTotal = (repoDetail?.languages ?? []).reduce(
    (sum, language) => sum + language.bytes,
    0,
  );
  $: releaseCadence = cadenceSummary(repoDetail?.releases ?? []);
  $: workTrend = repoDetail?.workTrend ?? null;
  $: filteredAudienceUsers = audience ? audienceUsersMatching(audience, audienceQuery) : [];

  function commitTotal(): number {
    return (repoDetail?.commitActivity ?? []).reduce((sum, week) => sum + week.total, 0);
  }

  function codeTotal(kind: "additions" | "deletions"): number {
    return (repoDetail?.codeFrequency ?? []).reduce((sum, week) => sum + week[kind], 0);
  }

  function audienceMeta(payload: RepoAudiencePayload): string {
    const total = `${numberFormat.format(audienceTotalStargazers(payload))} total stargazers`;
    const scored = `${numberFormat.format(payload.totals.stargazersSampled)} scored profiles`;
    const high = `${audienceShare(payload, payload.totals.highSignal, payload.totals.highSignalPercent)} high-signal`;
    return [
      total,
      scored,
      high,
      payload.cache.state,
      quotaLabel(payload.cache.quota),
      `updated ${relativeDate(payload.generatedAt)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function audienceUsersMatching(
    payload: RepoAudiencePayload,
    text: string,
  ): RepoAudiencePayload["users"] {
    const needle = text.trim().toLowerCase();
    if (!needle) return payload.users;
    return payload.users.filter((user) =>
      [
        user.login,
        user.name,
        user.company,
        user.bio,
        user.location,
        user.tier,
        ...user.reasons,
        ...(user.factors ?? []).map((factor) => `${factor.label} ${factor.detail}`),
        ...user.orgs.map((org) => org.login),
        ...user.topRepositories.map((repo) => repo.fullName),
        ...user.topRepositories.map((repo) => repo.language),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }
</script>

<section class="repo-detail" aria-label="Repository detail">
  {#if errorMessage}
    <div class="error-state">
      <span class="loading-kicker">repository unavailable</span>
      <strong>{errorMessage}</strong>
      <small>ReleaseBar only reads public GitHub metadata. Connected GitHub App quota can make public repo refreshes more reliable.</small>
      {#if !rateLimitHit && (auth?.configured || auth?.quotaConfigured) && !auth.user}
        <button type="button" onclick={primaryAuthAction}>{primaryAuthLabel(auth)}</button>
      {/if}
    </div>
  {:else if !repoDetail}
    <div class="loading-state" aria-live="polite">
      <span class="loading-kicker">fetching repository</span>
      <strong>loading stats</strong>
      <small>GitHub release and activity data is being cached.</small>
      <div class="loading-bars" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  {:else}
    {#if repoDetail.cache.state === "warming" || repoDetail.cache.state === "stale"}
      <div class="partial-state" aria-live="polite">
        <span>{repoDetail.cache.state === "warming" ? "stats warming" : "cached stats visible"}</span>
        <strong>{repoDetail.cache.message ?? "Repository statistics are refreshing."}</strong>
      </div>
    {/if}
    <div class="detail-grid">
      <section class="detail-panel detail-overview">
        <div>
          <span class="panel-kicker">release</span>
          <strong
            style={detailValueStyle(repoDetail.project.version)}
            title={repoDetail.project.version}
            use:fitDetailValue={repoDetail.project.version}
          >
            {repoDetail.project.version}
          </strong>
          <small>{shortDate(repoDetail.project.releaseDate)} · {relativeDate(repoDetail.project.releaseDate)}</small>
        </div>
        <div>
          <span class="panel-kicker">commits since</span>
          <strong
            style={detailValueStyle(repoDetail.project.commitsSinceRelease ?? "n/a")}
            use:fitDetailValue={repoDetail.project.commitsSinceRelease ?? "n/a"}
          >
            {repoDetail.project.commitsSinceRelease ?? "n/a"}
          </strong>
          <small>{repoDetail.project.freshness}</small>
        </div>
        <div>
          <span class="panel-kicker">stars</span>
          <strong
            style={detailValueStyle(numberFormat.format(repoDetail.project.stars))}
            use:fitDetailValue={numberFormat.format(repoDetail.project.stars)}
          >
            {numberFormat.format(repoDetail.project.stars)}
          </strong>
          <small>{numberFormat.format(repoDetail.project.forks)} forks</small>
        </div>
        <div>
          <span class="panel-kicker">open work</span>
          <strong
            style={detailValueStyle(countLabel(openWorkCount(repoDetail.project)))}
            use:fitDetailValue={countLabel(openWorkCount(repoDetail.project))}
          >
            {countLabel(openWorkCount(repoDetail.project))}
          </strong>
          <small>{countLabel(repoDetail.project.openIssues)} issues · {countLabel(repoDetail.project.openPullRequests)} PRs</small>
        </div>
        <div>
          <span class="panel-kicker">cadence</span>
          <strong
            style={detailValueStyle(formatDays(releaseCadence.medianDays))}
            use:fitDetailValue={formatDays(releaseCadence.medianDays)}
          >
            {formatDays(releaseCadence.medianDays)}
          </strong>
          <small>median release gap · {releaseCadence.releaseCount} recent releases</small>
        </div>
      </section>

      <section class="detail-panel detail-wide">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">commit graph</span>
            <h2>last year</h2>
          </div>
          <strong>{numberFormat.format(commitTotal())} commits</strong>
        </div>
        {#if repoDetail.commitActivity.length > 0}
          <div class="spark-bars" aria-label="Weekly commits">
            {#each repoDetail.commitActivity as week}
              <button
                type="button"
                aria-label={`${shortDate(week.week)} · ${numberFormat.format(week.total)} commits`}
                data-tooltip={`${shortDate(week.week)} · ${numberFormat.format(week.total)} commits`}
                style={`height: ${percent(week.total, detailMaxCommits)}%`}
              ></button>
            {/each}
          </div>
        {:else}
          <p class="detail-empty">Commit activity is still warming or unavailable.</p>
        {/if}
      </section>

      <section class="detail-panel detail-wide release-summary">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">AI summary</span>
            <h2>{repoSummaryRange === "release" ? "since last release" : "recent work"}</h2>
          </div>
          <div class="range-toggle" aria-label="Repository summary range">
            {#each repoSummaryRanges as range}
              <button
                class:active={repoSummaryRange === range.value}
                type="button"
                aria-pressed={repoSummaryRange === range.value}
                onclick={() => setRepoSummaryRange(range.value)}
              >
                {range.label}
              </button>
            {/each}
          </div>
        </div>
        {#if repoSummaryRange === "release"}
          {#if repoDetail.releaseSummary?.state === "ready" && repoDetail.releaseSummary.text}
            <p>{repoDetail.releaseSummary.text}</p>
            <small>{releaseSummaryMeta(repoDetail.releaseSummary)}</small>
          {:else if repoDetail.releaseSummary?.state === "warming"}
            <p>Summarizing commit titles since the latest release.</p>
            <small>{releaseSummaryMeta(repoDetail.releaseSummary)}</small>
          {:else if repoDetail.releaseSummary?.message}
            <p class="detail-empty">{repoDetail.releaseSummary.message}</p>
          {:else}
            <p class="detail-empty">No release summary is available yet.</p>
          {/if}
        {:else if repoActivityLoading}
          <p>Loading recent work.</p>
        {:else if repoActivity?.summary?.state === "ready" && repoActivity.summary.text}
          <p>{repoActivity.summary.text}</p>
          <small>{repoActivityMeta(repoActivity)}</small>
        {:else if repoActivity?.summary?.state === "warming"}
          <p>Summarizing recent work.</p>
          <small>{repoActivityMeta(repoActivity)}</small>
        {:else if repoActivity?.summary?.message}
          <p class="detail-empty">{repoActivity.summary.message}</p>
        {:else if repoActivityError}
          <p class="detail-empty">{repoActivityError}</p>
        {:else}
          <p class="detail-empty">Recent work will appear here when GitHub returns enough signal.</p>
        {/if}
      </section>

      <section class="detail-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">contributors</span>
            <h2>top committers</h2>
          </div>
        </div>
        <div class="contributor-list">
          {#each repoDetail.contributors as contributor}
            <a
              class="contributor-row"
              href={contributor.url ? ownerDashboardPath(contributor.login) : repoDetailPath(repoDetail.fullName)}
            >
              {#if contributor.avatarUrl}
                <img src={contributor.avatarUrl} alt="" width="26" height="26" loading="lazy" />
              {:else}
                <span class="avatar-fallback" aria-hidden="true"></span>
              {/if}
              <span class="contributor-name">
                <span>{contributor.login}</span>
                {#if contributor.trustScore !== undefined}
                  <small
                    class={`person-score-pill tier-${contributor.trustTier ?? "low"}`}
                    title={personTrustScoreTooltip(contributor.trustScore)}
                    aria-label={personTrustScoreTooltip(contributor.trustScore)}
                  >
                    {numberFormat.format(contributor.trustScore)}
                  </small>
                {/if}
              </span>
              <strong>{numberFormat.format(contributor.commits)}</strong>
              <i style={`width: ${percent(contributor.commits, detailMaxContributorCommits)}%`}></i>
            </a>
          {/each}
        </div>
      </section>

      <section class="detail-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">releases</span>
            <h2>latest versions</h2>
          </div>
          <strong>{formatDays(releaseCadence.latestGapDays)}</strong>
        </div>
        <div class="release-groups">
          {#if stableReleases.length > 0}
            <div class="release-group">
              <span class="release-group-label">stable</span>
              <div class="release-list">
                {#each stableReleases as release}
                  <a class="external-link" href={release.url} target="_blank" rel="noreferrer">
                    <strong>{release.tagName}</strong>
                    <span>{shortDate(release.publishedAt)} · {relativeDate(release.publishedAt)}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}
          {#if preReleases.length > 0}
            <div class="release-group">
              <span class="release-group-label">pre</span>
              <div class="release-list">
                {#each preReleases as release}
                  <a class="external-link" href={release.url} target="_blank" rel="noreferrer">
                    <strong>{release.tagName}</strong>
                    <span>{shortDate(release.publishedAt)} · {relativeDate(release.publishedAt)}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}
          {#if stableReleases.length === 0 && preReleases.length === 0}
            <p class="detail-empty">Release history is unavailable.</p>
          {/if}
        </div>
      </section>

      <section class="detail-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">open work trend</span>
            <h2>last 30 days</h2>
          </div>
        </div>
        {#if workTrend}
          <div class="work-trend">
            <div>
              <span>issues opened</span>
              <strong>{numberFormat.format(workTrend.issuesOpened30d)}</strong>
              <i style={`width: ${percent(workTrend.issuesOpened30d, Math.max(workTrend.issuesOpened30d, workTrend.issuesClosed30d, 1))}%`}></i>
            </div>
            <div>
              <span>issues closed</span>
              <strong>{numberFormat.format(workTrend.issuesClosed30d)}</strong>
              <i style={`width: ${percent(workTrend.issuesClosed30d, Math.max(workTrend.issuesOpened30d, workTrend.issuesClosed30d, 1))}%`}></i>
            </div>
            <div>
              <span>PRs opened</span>
              <strong>{numberFormat.format(workTrend.pullRequestsOpened30d)}</strong>
              <i style={`width: ${percent(workTrend.pullRequestsOpened30d, Math.max(workTrend.pullRequestsOpened30d, workTrend.pullRequestsClosed30d, 1))}%`}></i>
            </div>
            <div>
              <span>PRs merged/closed</span>
              <strong>{numberFormat.format(workTrend.pullRequestsClosed30d)}</strong>
              <i style={`width: ${percent(workTrend.pullRequestsClosed30d, Math.max(workTrend.pullRequestsOpened30d, workTrend.pullRequestsClosed30d, 1))}%`}></i>
            </div>
          </div>
        {:else}
          <p class="detail-empty">Issue and PR trend data is warming or unavailable.</p>
        {/if}
      </section>

      <section class="detail-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">languages</span>
            <h2>repo mix</h2>
          </div>
        </div>
        <div class="language-bars">
          {#each repoDetail.languages.slice(0, 6) as repoLanguage}
            <div>
              <span>{repoLanguage.name}</span>
              <strong>{percentOfTotal(repoLanguage.bytes, detailLanguageTotal)}%</strong>
              <i style={`width: ${percentOfTotal(repoLanguage.bytes, detailLanguageTotal)}%`}></i>
            </div>
          {/each}
        </div>
      </section>

      <section class="detail-panel detail-wide audience-panel" aria-label="Recent stargazer audience">
        <div class="panel-heading audience-heading">
          <div>
            <span class="panel-kicker">audience</span>
            <h2>new stargazers</h2>
          </div>
          <div class="range-toggle" aria-label="Audience range">
            {#each audienceRanges as range}
              <button
                class:active={audienceRange === range.value}
                type="button"
                aria-pressed={audienceRange === range.value}
                onclick={() => setAudienceRange(range.value)}
              >
                {range.label}
              </button>
            {/each}
            <button type="button" disabled={audienceBackfillLoading} onclick={backfillRepoAudience}>
              {audienceBackfillLoading ? "backfilling" : "backfill"}
            </button>
          </div>
        </div>
        {#if audienceBackfillMessage}
          <p class="detail-empty audience-backfill-message">{audienceBackfillMessage}</p>
        {/if}
        {#if audienceLoading}
          <p class="detail-empty">Scoring recent public stargazer profiles.</p>
        {:else if audienceError}
          <p class="detail-empty">{audienceError}</p>
        {:else if audience}
          <div class="audience-summary" aria-label={audienceMeta(audience)}>
            <div>
              <span>stargazers</span>
              <strong>{numberFormat.format(audienceTotalStargazers(audience))}</strong>
            </div>
            <div>
              <span>high</span>
              <strong>{audienceShare(audience, audience.totals.highSignal, audience.totals.highSignalPercent)}</strong>
            </div>
            <div>
              <span>medium</span>
              <strong>{audienceShare(audience, audience.totals.mediumSignal, audience.totals.mediumSignalPercent)}</strong>
            </div>
            <div>
              <span>bots</span>
              <strong>{audienceShare(audience, audience.totals.bots, audience.totals.botPercent)}</strong>
            </div>
          </div>
          {#if audience.users.length > 0}
            <div class="audience-tools">
              <input
                bind:value={audienceQuery}
                type="search"
                autocomplete="off"
                spellcheck="false"
                placeholder="find people, orgs, companies, repos"
                aria-label="Find stargazers"
              />
              <span>
                {numberFormat.format(filteredAudienceUsers.length)} / {numberFormat.format(audience.users.length)}
              </span>
            </div>
            <div class="audience-list">
              {#each filteredAudienceUsers as user}
                <a class="audience-row" href={ownerDashboardPath(user.login)}>
                  <img src={user.avatarUrl} alt="" width="34" height="34" loading="lazy" />
                  <span class="audience-user">
                    <strong>
                      <span>{user.login}</span>
                      {#if user.trustScore !== undefined}
                        <small
                          class={`person-score-pill tier-${user.trustTier ?? "low"}`}
                          title={personTrustScoreTooltip(user.trustScore)}
                          aria-label={personTrustScoreTooltip(user.trustScore)}
                        >
                          {numberFormat.format(user.trustScore)}
                        </small>
                      {/if}
                    </strong>
                    <small>{user.name || user.company || audienceReasonText(user.reasons)}</small>
                    {#if audienceInsightText(user)}
                      <small>{audienceInsightText(user)}</small>
                    {/if}
                  </span>
                  <span class="audience-score">
                    <span class={`audience-tier tier-${user.tier}`}>{user.tier}</span>
                    <strong>{numberFormat.format(user.score)}</strong>
                    <small>{numberFormat.format(user.followers)} followers · {numberFormat.format(user.publicRepos)} repos</small>
                  </span>
                </a>
              {/each}
            </div>
            <small class="audience-note">{audienceMeta(audience)} · public stargazer profile signals only</small>
            {#if filteredAudienceUsers.length === 0}
              <p class="detail-empty">No stargazers match that search.</p>
            {/if}
          {:else}
            <p class="detail-empty">No recent public stargazers in this range.</p>
          {/if}
        {:else}
          <p class="detail-empty">Audience signals are warming.</p>
        {/if}
      </section>

      {#if showCodeChurn(repoDetail)}
        <section class="detail-panel detail-tail">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">code churn</span>
              <h2>last year</h2>
            </div>
          </div>
          {#if repoDetail.codeFrequency.length > 0}
            <div class="churn-meter">
              <div>
                <span>additions</span>
                <strong>{numberFormat.format(codeTotal("additions"))}</strong>
              </div>
              <div>
                <span>deletions</span>
                <strong>{numberFormat.format(codeTotal("deletions"))}</strong>
              </div>
            </div>
          {:else}
            <p class="detail-empty">GitHub is preparing code-frequency stats. ReleaseBar will refresh this panel.</p>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</section>

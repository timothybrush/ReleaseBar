<script lang="ts">
  import { numberFormat, relativeDate } from "../app-format.js";
  import type { AdminDashboardPayload } from "../app-types.js";
  import type {
    AuthPayload,
    RefreshJob,
    RefreshTarget,
    SchedulerAuditEvent,
  } from "../types.js";

  export let adminError: string;
  export let auth: AuthPayload | null;
  export let adminLoading: boolean;
  export let admin: AdminDashboardPayload | null;
  export let adminActionMessage: string;
  export let login: () => void;
  export let loadAdmin: () => Promise<void>;
  export let runScheduler: () => Promise<void>;
  export let syncInstallations: () => Promise<void>;

  function adminAge(value: string | null): string {
    return value ? relativeDate(value) : "never";
  }

  function adminTargetSources(target: RefreshTarget): string {
    const owners = target.owners.map((owner) => `@${owner}`);
    return [...owners, ...target.repos].join(", ") || target.owner;
  }

  function adminJobLabel(job: RefreshJob): string {
    return [
      job.status,
      job.reason,
      job.durationMs === null ? "" : `${numberFormat.format(job.durationMs)}ms`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function adminEventLabel(event: SchedulerAuditEvent): string {
    return [event.status, event.reason, event.account ? `@${event.account}` : "", event.detail]
      .filter(Boolean)
      .join(" · ");
  }

  function adminAccessLabel(row: {
    source: string;
    account: string | null;
    resource: string | null;
    status: number;
  }): string {
    return [
      `${row.source}${row.account ? `:${row.account}` : ""}`,
      row.resource ?? "unknown",
      `HTTP ${row.status}`,
    ].join(" · ");
  }
</script>

<section class="admin-console" aria-label="Scheduler admin">
  {#if adminError}
    <div class="error-state">
      <span class="loading-kicker">admin unavailable</span>
      <strong>{adminError}</strong>
      <small>Admin access requires signing in as @steipete.</small>
      {#if auth?.configured && !auth.user}
        <button type="button" onclick={login}>Connect GitHub</button>
      {:else}
        <button type="button" disabled={adminLoading} onclick={loadAdmin}>retry</button>
      {/if}
    </div>
  {:else if adminLoading && !admin}
    <div class="loading-state" aria-live="polite">
      <span class="loading-kicker">scheduler</span>
      <strong>loading status</strong>
      <small>Reading refresh targets, recent jobs, and audit events.</small>
      <div class="loading-bars" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  {:else if admin}
    <div class="admin-toolbar">
      <div>
        <span class="panel-kicker">scheduler</span>
        <strong>{admin.status.queueConfigured ? "queue backed" : "direct fallback"}</strong>
        <small>
          last tick {adminAge(admin.status.lastTickAt)} · next due {adminAge(admin.status.nextDueAt)}
        </small>
      </div>
      <div class="admin-actions">
        <button type="button" disabled={adminLoading} onclick={loadAdmin}>refresh</button>
        <button type="button" disabled={adminLoading} onclick={runScheduler}>run now</button>
        <button type="button" disabled={adminLoading} onclick={syncInstallations}>sync installs</button>
      </div>
    </div>
    {#if adminActionMessage}
      <p class="admin-message">{adminActionMessage}</p>
    {/if}
    <div class="admin-metrics">
      <div>
        <span>targets</span>
        <strong>{numberFormat.format(admin.status.targets)}</strong>
      </div>
      <div>
        <span>due in scan</span>
        <strong>{numberFormat.format(admin.status.dueTargets)}</strong>
      </div>
      <div>
        <span>queued</span>
        <strong>{numberFormat.format(admin.status.queuedJobs)}</strong>
      </div>
      <div>
        <span>running</span>
        <strong>{numberFormat.format(admin.status.runningJobs)}</strong>
      </div>
      <div>
        <span>failed</span>
        <strong>{numberFormat.format(admin.status.failedJobs)}</strong>
      </div>
      <div>
        <span>GitHub calls</span>
        <strong>{numberFormat.format(admin.githubAccess.total)}</strong>
      </div>
      <div>
        <span>shared pause</span>
        <strong>{admin.githubAccess.cooldown.active ? "on" : "off"}</strong>
      </div>
      <div>
        <span>installs</span>
        <strong>{numberFormat.format(admin.auth.installationCount)}</strong>
      </div>
      <div>
        <span>auth events</span>
        <strong>{numberFormat.format(admin.auth.events.length)}</strong>
      </div>
    </div>
    <div class="admin-grid">
      <section class="admin-panel admin-wide">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">GitHub App installs</span>
            <h2>sync coverage</h2>
          </div>
          <strong>
            {numberFormat.format(admin.auth.installations.length)} of {numberFormat.format(admin.auth.installationCount)}
          </strong>
        </div>
        <div class="admin-list compact">
          {#each admin.auth.installations as installation}
            <div class="admin-row">
              <span>
                <strong>@{installation.accountLogin}</strong>
                <small>
                  {installation.accountType} · {installation.repositorySelection === "all" ? "all repos" : `${numberFormat.format(installation.repositories.length)} public repos`}
                </small>
              </span>
              <span>
                <strong>{installation.repositorySelection}</strong>
                <small>updated {adminAge(installation.updatedAt)}</small>
              </span>
            </div>
          {/each}
          {#if admin.auth.installations.length === 0}
            <p class="detail-empty">No GitHub App installations recorded yet. Use sync installs to read GitHub's current app installation list.</p>
          {/if}
        </div>
      </section>

      <section class="admin-panel admin-wide">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">auth funnel</span>
            <h2>recent events</h2>
          </div>
          <strong>{numberFormat.format(admin.auth.counterCount)} counters</strong>
        </div>
        <div class="admin-list compact token-use">
          {#each admin.auth.events as event}
            <div class={`admin-row status-${event.status === "error" ? "failed" : "succeeded"}`}>
              <span>
                <strong>{event.event}{event.account ? ` · @${event.account}` : ""}</strong>
                <small>{event.detail ?? event.status ?? "recorded"}</small>
              </span>
              <span>
                <strong>{event.repositorySelection ?? event.status ?? "event"}</strong>
                <small>{adminAge(event.at)}</small>
              </span>
            </div>
          {/each}
          {#if admin.auth.events.length === 0}
            <p class="detail-empty">No auth or install funnel events recorded yet.</p>
          {/if}
        </div>
      </section>

      <section class="admin-panel admin-wide">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">GitHub token use</span>
            <h2>{admin.githubAccess.hours}h window</h2>
          </div>
          <strong>{numberFormat.format(admin.githubAccess.buckets)} buckets</strong>
        </div>
        {#if admin.githubAccess.cooldown.active}
          <p class="admin-message inline">
            shared quota paused · {admin.githubAccess.cooldown.reason ?? "budget guard"} · resets {adminAge(admin.githubAccess.cooldown.resetAt)}
          </p>
        {/if}
        <div class="admin-list compact token-use">
          {#each admin.githubAccess.topRoutes as route}
            <div class={`admin-row status-${route.status >= 400 ? "failed" : "succeeded"}`}>
              <span>
                <strong>{route.area} · {route.route}</strong>
                <small>{adminAccessLabel(route)}</small>
              </span>
              <span>
                <strong>{numberFormat.format(route.count)}</strong>
                <small>{route.lastAt ? `last ${adminAge(route.lastAt)}` : (route.lastPath ?? route.key)}</small>
              </span>
            </div>
          {/each}
          {#if admin.githubAccess.topRoutes.length === 0}
            <p class="detail-empty">No GitHub token counters in the current window.</p>
          {/if}
        </div>
      </section>

      <section class="admin-panel admin-wide">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">refresh targets</span>
            <h2>stale first</h2>
          </div>
          <strong>{numberFormat.format(admin.targets.length)}</strong>
        </div>
        <div class="admin-list">
          {#each admin.targets as target}
            <div class="admin-row">
              <span>
                <strong>{adminTargetSources(target)}</strong>
                <small>
                  {target.includeReleaseData ? "release data" : "metadata"} · seen {adminAge(target.lastSeenAt)}
                </small>
              </span>
              <span>
                <strong>due {adminAge(target.nextDueAt)}</strong>
                <small>
                  success {adminAge(target.lastSuccessAt)} · failures {numberFormat.format(target.failureCount)}
                </small>
              </span>
            </div>
          {/each}
          {#if admin.targets.length === 0}
            <p class="detail-empty">No refresh targets recorded yet. Open an owner dashboard to seed one.</p>
          {/if}
        </div>
      </section>

      <section class="admin-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">jobs</span>
            <h2>recent</h2>
          </div>
        </div>
        <div class="admin-list compact">
          {#each admin.jobs as job}
            <div class={`admin-row status-${job.status}`}>
              <span>
                <strong>{job.targetKey.replace(/^dashboard:v\d+:/, "")}</strong>
                <small>{adminJobLabel(job)}</small>
              </span>
              <span>
                <strong>{adminAge(job.updatedAt)}</strong>
                <small>{job.error ?? `attempts ${numberFormat.format(job.attempts)}`}</small>
              </span>
            </div>
          {/each}
          {#if admin.jobs.length === 0}
            <p class="detail-empty">No refresh jobs yet.</p>
          {/if}
        </div>
      </section>

      <section class="admin-panel">
        <div class="panel-heading">
          <div>
            <span class="panel-kicker">audit</span>
            <h2>events</h2>
          </div>
        </div>
        <div class="admin-list compact">
          {#each admin.events as event}
            <div class="admin-row">
              <span>
                <strong>{event.event}</strong>
                <small>{adminEventLabel(event) || event.targetKey || event.jobId || "scheduler"}</small>
              </span>
              <span>
                <strong>{adminAge(event.at)}</strong>
                <small>{event.jobId ?? event.targetKey ?? event.id}</small>
              </span>
            </div>
          {/each}
          {#if admin.events.length === 0}
            <p class="detail-empty">No audit events yet.</p>
          {/if}
        </div>
      </section>
    </div>
  {/if}
</section>


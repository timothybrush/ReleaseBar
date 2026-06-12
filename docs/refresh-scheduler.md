# ReleaseBar Refresh Scheduler

ReleaseBar keeps public dashboard data warm with a small scheduler on the Cloudflare Worker. The goal is not to rebuild every known dashboard constantly. The scheduler records dashboards people actually view, refreshes them when they are stale or incomplete, and uses GitHub App quota when that quota is available for the dashboard sources.

## Runtime Pieces

- Cloudflare cron runs every 15 minutes from `wrangler.toml`.
- `DASHBOARD_CACHE` stores compact refresh targets, shared owner metadata/count snapshots, immutable profile and per-job snapshots, latest job states, visible dashboard snapshots, audit events, and scheduler state.
- `DASHBOARD_LOCKS` Durable Objects hold the active job reservation, refresh-target failure state, and strongly consistent progressive-scan checkpoint for each dashboard.
- `REFRESH_QUEUE` receives background rebuild jobs in production.
- User requests return cheap repository metadata first, bounded by the same 15-second cold-response deadline, then enqueue release hydration instead of keeping long scans inside HTTP `waitUntil()`.
- If the queue binding is missing, scheduler jobs run one bounded `waitUntil()` attempt and record retryable work as failed so a later tick can schedule it again.
- The admin UI at `/_admin` reads `/api/admin/scheduler` and can trigger `/api/admin/scheduler/run`.

## Refresh Targets

A refresh target is created when an owner dashboard is opened. The target stores:

- the dashboard cache key
- primary owner, extra owners, and explicit repositories
- a small reference to the immutable profile-settings snapshot used by that dashboard key
- whether release data should be hydrated
- the dashboard path
- last seen, last attempt, last success, next due time, and failure count

Targets are intentionally demand-driven. A dashboard nobody has opened is not scheduled. Opening the dashboard seeds or updates its target and moves `lastSeenAt` forward.

## Scheduling Policy

Every cron tick first refreshes lean issue, pull request, archive, and activity metadata for recently viewed owners whose shared snapshot is about 15 minutes old. These count queries use GitHub App or shared authenticated quota, run with bounded concurrency, and are merged into every cached dashboard variant at read time.

The same tick schedules deep dashboard work:

1. Lists known refresh targets.
2. Reads the cached dashboard payload for each target.
3. Marks a target due when the cache is missing, expired, errored, incomplete, or past `nextDueAt`.
4. Skips targets that already have a queued or running job.
5. Sorts due work by target priority, then oldest due time.
6. Enqueues up to 20 jobs per tick.

Successful targets get their next refresh time based on recent use:

- recently viewed in the last 7 days: refresh after about 6 hours
- dormant: refresh after about 24 hours
- jitter is added so many targets do not all refresh at once

Failed targets back off from 30 minutes up to 4 hours, plus jitter.

## Job Execution

A refresh job rebuilds the same dashboard cache entry the user-facing route would build:

1. Load the target.
2. Find a source-owned GitHub App installation token for the target owners/repos when possible.
3. Fall back to shared or anonymous quota if no app token exists.
4. Rebuild consecutive 12-repository hydration batches within a 12-minute Queue budget, hydrating up to four repositories concurrently.
5. Store the scan checkpoint in the dashboard Durable Object and the visible dashboard snapshot in KV after each batch.
6. Retry the same reserved Queue message if the dashboard remains incomplete.
7. Update target success/failure state and write at most one job-state update per Queue delivery.
8. Write an audit event.

The build lock is still the hydration concurrency guard. The dashboard's Durable Object also reserves one active refresh job, serializes request observations with Queue success/failure updates, and keeps its scan checkpoint. Concurrent requests therefore cannot enqueue duplicate scans or erase a terminal failure backoff, and rapid Queue retries do not depend on eventually consistent KV reads. Checkpoints that cannot be stored in the Durable Object fall back to explicitly marked KV records; timestamped tombstones prevent completed or stale fallback records from being resumed. Lock collisions and non-advancing checkpoints retry the reserved Queue message after 60 seconds instead of spinning or dropping the refresh. Queue delivery starts after a two-second KV settling delay, advancing incomplete scans retry after two seconds, each batch processes one target, and up to five targets can run concurrently. Job reservations last two hours so a full 20-target scheduler wave remains deduplicated while waiting behind long-running consumers.

## Quota Behavior

Scheduler jobs use the same quota preference as normal dashboard builds:

- source-owned GitHub App installation token when the app covers the source
- shared `GITHUB_TOKEN` when configured
- anonymous GitHub API as the last fallback

This means popular or installed accounts can refresh without burning the shared quota. Mixed-source dashboards use app quota only when a matching source installation is available.

## Admin And Audit

`/_admin` is available only to the hardcoded `@steipete` admin login. It shows:

- target count and due target count
- queued, running, and failed job counts
- last scheduler tick and next due target
- queue-backed vs direct fallback mode
- sharded GitHub token-use counters from the last 24 hours, also available at `/api/admin/github-access`
- recent targets, jobs, and audit events

Audit events are stored in KV and logged to Worker logs with `area: "scheduler"`. Keep audit detail short and structured so production logs remain searchable.

## GitHub Webhooks

`POST /api/github/webhook` accepts payloads up to 2 MiB, verifies `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`, accepts GitHub setup pings, and serializes delivery admission through `DASHBOARD_LOCKS`. It acknowledges event deliveries only after the payload is durably written to Cloudflare Queue. Queue consumers serialize cache mutations through the same Durable Object and deduplicate accepted and processed `X-GitHub-Delivery` values for 24 hours.

- `issues` and `pull_request` run one lean authoritative owner-count query, then patch known split counts
- `repository` archive/unarchive events remove or restore rows according to dashboard visibility and enqueue a metadata refresh
- `push` and `release` invalidate repository fragments and enqueue affected release dashboards for authoritative hydration
- failed background processing clears the delivery marker so GitHub retries remain actionable

## Operational Notes

- Missing or invalid cached payloads are due immediately.
- Partial dashboards are due until completed.
- Shared quota cooldowns pause shared-token background refreshes until reset while app-token refreshes can continue.
- Queue delivery failures mark the job failed.
- Request-triggered jobs are deduplicated against queued and running work for the same dashboard.
- Queue messages carry a small immutable-target reference instead of profile settings, keeping messages below the Queue size limit even when filter lists are large.
- Job listings merge immutable running-delivery records with the latest mutable result; mutable job state is written once per delivery to stay within Workers KV same-key write limits.
- Cold requests and each Queue delivery use absolute abort deadlines that include GitHub App discovery and token minting; interrupted GitHub work is retried from the Durable Object checkpoint.
- Cloudflare's Queue delivery-attempt counter controls exhaustion. With `max_retries = 10`, delivery 11 is terminal: the initial delivery plus ten retries. Exhausted retries are recorded as failed before dead-lettering and put the target on scheduler backoff, so requests and cron ticks do not immediately restart the same failed scan. Ordinary transient failures retain scheduler retry timing but remain eligible for request-triggered recovery. Stale queued records stop blocking scheduling after the Durable Object reservation expires.
- Durable Object scan checkpoints expire after seven days so abandoned jobs cannot resume stale repository rows.
- Job records and audit events are retained for 14 days.
- Target records use the dashboard cache TTL.
- Manual `run now` uses the same batch limit and due rules as cron.
- The live deploy smoke checks `/`, `/steipete`, `/openclaw/openclaw`, and `/api/_discover`; admin state is inspected through the admin UI/API.

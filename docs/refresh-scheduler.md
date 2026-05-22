# ReleaseBar Refresh Scheduler

ReleaseBar keeps public dashboard data warm with a small scheduler on the Cloudflare Worker. The goal is not to rebuild every known dashboard constantly. The scheduler records dashboards people actually view, refreshes them when they are stale or incomplete, and uses GitHub App quota when that quota is available for the dashboard sources.

## Runtime Pieces

- Cloudflare cron runs every 15 minutes from `wrangler.toml`.
- `DASHBOARD_CACHE` stores refresh targets, recent jobs, audit events, and scheduler state.
- `REFRESH_QUEUE` receives background rebuild jobs in production.
- If the queue binding is missing, the Worker falls back to `waitUntil(processRefreshJob(...))` so local and preview environments can still run jobs.
- The admin UI at `/_admin` reads `/api/admin/scheduler` and can trigger `/api/admin/scheduler/run`.

## Refresh Targets

A refresh target is created when an owner dashboard is opened. The target stores:

- the dashboard cache key
- primary owner, extra owners, and explicit repositories
- whether release data should be hydrated
- the dashboard path
- last seen, last attempt, last success, next due time, and failure count

Targets are intentionally demand-driven. A dashboard nobody has opened is not scheduled. Opening the dashboard seeds or updates its target and moves `lastSeenAt` forward.

## Scheduling Policy

Every cron tick:

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
4. Rebuild through the existing dashboard build lock.
5. Store the new dashboard payload.
6. Update target success/failure state and write a job record.
7. Write an audit event.

The build lock is still the concurrency guard. If another isolate is already rebuilding the same dashboard, the job is skipped instead of doing duplicate GitHub work.

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
- recent targets, jobs, and audit events

Audit events are stored in KV and logged to Worker logs with `area: "scheduler"`. Keep audit detail short and structured so production logs remain searchable.

## Operational Notes

- Missing or invalid cached payloads are due immediately.
- Partial dashboards are due until completed.
- Queue delivery failures mark the job failed.
- Job records and audit events are retained for 14 days.
- Target records use the dashboard cache TTL.
- Manual `run now` uses the same batch limit and due rules as cron.
- The live deploy smoke checks `/`, `/steipete`, `/openclaw/openclaw`, and `/api/_discover`; admin state is inspected through the admin UI/API.

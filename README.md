# ReleaseBar

Release freshness dashboard for public GitHub users and orgs.

ReleaseBar tracks public GitHub repository release health: latest version, release date, commits since release, activity, stars, language, topics, open work, and CI status. It serves cached dashboards for routes like `https://release.bar/steipete`, `https://release.bar/openclaw`, and `https://release.bar/microsoft`.

Owner dashboards show visible public repositories immediately with lightweight repo metadata, then progressively hydrate release, commit, PR, and CI data in the background.

## Configure

Edit `releasebar.config.json`:

- `owners`: GitHub users or orgs to scan
- `includeForks`: include forked repositories
- `includeArchived`: include archived repositories
- `includeUnreleased`: include repositories without GitHub releases in static builds
- `excludeRepos`: full `owner/name` entries to hide
- `canonicalDomain`: primary public dashboard domain

## Build

```sh
npm run build
```

Set `GITHUB_TOKEN` for higher API limits. GitHub Actions uses the built-in token. Static builds read `releasebar.config.json`; the public service reads owner routes through the Worker API.

## Generic Dashboards

- `/` loads `ReleaseBar Hot`, a cached board built from recently requested public dashboards
- `/:owner` loads the Worker API for that owner
- query options: `forks=true`, `archived=true`, `unreleased=false`
- add public sources with `owners=openclaw,steipete` or `repos=owner/name`
- the settings panel can add public users, orgs, or explicit repos to the current URL
- custom URLs are capped at 8 added public sources
- settings can hide visible owners or repos locally without changing the shared cache
- GitHub App login uses `/api/auth/login`, `/api/auth/callback`, `/api/auth/install`, `/api/auth/logout`, and `/api/me`
- `Connect GitHub` signs the user in, checks GitHub App installations, and sends them to install the app when the current dashboard source is not covered
- GitHub App installation gives ReleaseBar dedicated GitHub API quota for the selected account/repositories; public dashboards still fall back to the shared server token and cache
- private repositories are ignored even when selected in GitHub App installation; ReleaseBar only stores and renders public repository metadata

## API And Cache

The Worker in `worker/index.ts` serves both the static app shell and the generic owner API:

- `GET /api/:owner` returns a cached dashboard for a public GitHub user or org
- `GET /api/:owner/events` streams cache updates for progressive rebuilds
- `GET /api/repos/:owner/:repo` returns repository detail stats
- `GET /api/_discover` and `GET /api/_hot` power the root dashboard

Dashboard builds validate public GitHub owners, scan up to the 200 most recently pushed public repositories per owner, and hydrate repositories in 12-repository batches. Dashboard payloads, repo fragments, hot boards, profile settings, and auth session data live in Cloudflare KV. A Durable Object binding (`DASHBOARD_LOCKS`) prevents repeated cold requests from stampeding GitHub.

Fresh dashboard cache is served for about 1h. Stale or partial cache is shown while a background rebuild continues, so large owners can show useful rows before all release data finishes.

### GitHub App Login

Configure these Worker secrets before enabling login:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `AUTH_COOKIE_SECRET`

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required for dedicated GitHub App quota. Without them, users can still sign in, but dashboard rebuilds use the shared server token/cache. Optional: `GITHUB_APP_SLUG` defaults to `releasebar-app`, the current GitHub App slug.

Set the GitHub App setup URL to `https://release.bar/api/auth/install` and enable redirect-on-update so users return to their dashboard after installing or changing repository access.

## Deploy

The combined app/API Worker deploys with Wrangler through `.github/workflows/deploy.yml` on pushes to `main`:

```sh
npm run build
wrangler deploy
```

`wrangler.toml` binds `dist` as Worker static assets, `DASHBOARD_CACHE` as KV, and `DASHBOARD_LOCKS` as the Durable Object single-flight lock. The Worker runs first so `/api/*` stays dynamic and owner routes like `/openclaw` return the app shell with HTTP 200.

The deployed Worker service is still named `releasedeck-api` in Cloudflare for continuity. The canonical product, repo, package, and config names are ReleaseBar / `releasebar`.

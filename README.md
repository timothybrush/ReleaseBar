# ReleaseDeck

ReleaseDeck is a release freshness dashboard for public GitHub users and orgs: latest version, latest release date, commits since release, activity, stars, language, and quick search. Repositories without any GitHub releases are skipped unless unreleased repositories are explicitly included. Dev mode adds open issue counts, open PR counts, and latest CI status.

## Configure

Edit `releasedeck.config.json`:

- `owners`: GitHub users or orgs to scan
- `includeForks`: include forked repositories
- `includeArchived`: include archived repositories
- `excludeRepos`: full `owner/name` entries to hide
- `canonicalDomain`: primary GitHub Pages custom domain

## Build

```sh
npm run build
```

Set `GITHUB_TOKEN` for higher API limits. GitHub Actions uses the built-in token.

## Generic Dashboards

- `/` loads the checked-in static snapshot from `data/projects.json`
- `/:owner` loads `/api/:owner`
- query options: `forks=true`, `archived=true`, `unreleased=true`
- settings can hide visible owners or repos locally without changing the shared cache

The Worker API in `worker/index.ts` validates public GitHub owners, builds a capped public dashboard from the 8 most recently pushed public repos, stores it in KV, serves fresh cache for 1h, and serves stale cache while revalidating. Configure `DASHBOARD_CACHE` and `GITHUB_TOKEN` before deploying the Worker.

## Deploy

GitHub Pages is deployed by `.github/workflows/pages.yml`.
The optional `/api/:owner` Worker is deployed separately with Wrangler once `wrangler.toml` has production KV ids.

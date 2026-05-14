# ReleaseDeck

ReleaseDeck is a static dashboard for maintainer release freshness: latest version, latest release date, commits since release, activity, stars, language, and quick search.

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

## Deploy

GitHub Pages is deployed by `.github/workflows/pages.yml`.

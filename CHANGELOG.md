# Changelog

## Unreleased

- Fixed GitHub App install redirects to use the real `releasebar-app` app slug while keeping `release.bar` OAuth callbacks.
- Changed the root dashboard to `ReleaseBar Hot`, built from cached public dashboards instead of the maintainer snapshot.
- Replaced raw GitHub rate-limit failures with dashboard-shaped quota guidance.
- Changed the canonical public domain to `release.bar` and renamed the public dashboard to ReleaseBar.
- Added a combined GitHub connection flow that detects GitHub App installations and prompts installation for dedicated API quota only when needed.
- Removed the always-on GitHub App install action from the account menu and tightened account menu styling.
- Moved GitHub login state into a top-right account menu with settings and logout actions.
- Added GitHub App login endpoints and settings UI state for signed-in users and app installation.
- Added customizable public dashboard sources for extra owners and explicit repositories, plus dynamic owner social preview cards.
- Added Worker static-asset hosting so owner routes can return the app shell with HTTP 200 once the domain is proxied through Cloudflare.
- Added route-aware owner dashboards, local visibility settings, and a cached Worker API for generic public GitHub dashboards.
- Added favicon and social preview card assets.
- Prevented cached dashboard data from showing archived repositories.
- Hid archived repositories from the dashboard.
- Updated the header owner label to `@steipete`.
- Added a dev mode toggle for open issues, open pull requests, and latest CI status.
- Skipped repositories that do not have any GitHub releases.
- Added CI for static checks, Pages deploys, and dependency updates.
- Added TypeScript sources, Oxlint/Oxfmt checks, sortable dashboard columns, and day-level relative dates.

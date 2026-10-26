# GitHub automation

Everything the site needs is committed: `data/audit.json` is the evidence, `data/requests.json` is
the queue, `data/staleness.json` is the update watch and `data/site-config.json` is visibility. The
workflows below only ever read or rewrite those four files, then let the normal Deploy workflow
publish the result.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push, pull request, manual | Builds `dist/`, verifies structure, checks internal links and anchors, validates data files, uploads `dist` as a build artifact. |
| `deploy.yml` | push to `main`, manual | Same checks, then `netlify deploy --prod --dir=dist --functions=netlify/functions`. |
| `requests-sync.yml` | hourly at :17, issue events, dispatch, data changes | `sync-requests.mjs` (GitHub issues labelled `mod-request` → `data/requests.json`), then `check-staleness.mjs`; commits if either file changed. |
| `staleness.yml` | daily 05:23 UTC, manual | Refresh `data/staleness.json` against Steam's public Workshop API; commit when a build moved. |
| `admin-commands.yml` | manual | Runs `scripts/admin.mjs` with the chosen action and id, rebuilds, verifies and commits `data/site-config.json`. |
| `issue-triage.yml` | issues opened | If a new issue looks like an audit request, labels it `mod-request`, acknowledges it and dispatches `requests-sync.yml`. |
| `codeql.yml` | push, PR, weekly | CodeQL `security-and-quality` analysis for the scripts and the functions. |
| `link-check.yml` | weekly, manual | Build + internal link check, then probes the live routes and `/api/requests`. |
| `dependabot-automerge.yml` | pull request | Enables squash auto-merge for Dependabot patch updates once CI is green. |

`.github/dependabot.yml` keeps GitHub Actions and any future npm tooling up to date weekly.

## How a request becomes an audit

1. A visitor submits the form on `requests.html` (or opens an issue directly).
2. `POST /api/request` validates the item against Steam and opens an issue labelled `mod-request`.
3. `issue-triage.yml` labels/acknowledges the issue and dispatches `requests-sync.yml`.
4. `requests-sync.mjs` writes the issue into `data/requests.json`; the mod appears in the site's
   "Queued for audit" list as `pending`.
5. When the report folder for that mod id exists in `data/audit.json`, the next sync flips the
   request to `audited`. When the Workshop build moves past the audited timestamp, it becomes
   `needs-reaudit`.
6. `deploy.yml` publishes the new queue and the update watch banner.

## How the update watch works

`check-staleness.mjs` asks Steam for `time_updated` on every audited item. A mod is flagged when
Steam's update time is newer than the audit date, or when the item no longer resolves (delisted or
unlisted). The site then shows an "Update watch" callout; the verdict still applies to the audited
bytes, which is why the banner names the mod rather than changing its score.

## Secrets and permissions

| Secret | Scope | Notes |
| --- | --- | --- |
| `NETLIFY_AUTH_TOKEN` | repository | Personal access token for deploys. |
| `NETLIFY_SITE_ID` | repository | `710ee0da-e912-4c0d-a334-f9a6ad59b911`. |

Workflows use the built-in `GITHUB_TOKEN` for issue reads and repository commits; no personal token is
stored in Actions. The Netlify functions read `GITHUB_TOKEN`, `GITHUB_REPO` and `ADMIN_TOKEN` from
the site's environment variables.

## Changing things by hand

```sh
npm run admin -- list
npm run admin -- hide-mod 3776968217
npm run admin -- show-mod 3776968217
npm run admin -- hide-request 5
npm run admin -- site-url https://example.netlify.app
```

Or open `/admin.html` on the live site and enter the admin token.

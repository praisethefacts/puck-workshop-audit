# GitHub automation

Everything the site needs is committed: `data/audit.json` is the evidence, `data/requests.json` is
the queue, `data/staleness.json` is the update watch, `data/audit-runs.json` is the live state of
automated triage and `data/site-config.json` is visibility. The workflows below only read or rewrite
those files and the generated `reports/`, then let the Deploy workflow publish the result.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push, pull request, manual | Builds `dist/`, verifies structure, checks internal links and anchors, validates data files, uploads `dist` as a build artifact. |
| `pages.yml` | push to `main`, manual, after the data workflows | Same checks, then publish `dist/` to GitHub Pages. |
| `requests-sync.yml` | hourly at :17, issue events, dispatch, data changes | `sync-requests.mjs` (GitHub issues labelled `mod-request` → `data/requests.json`), then `check-staleness.mjs`; commits if either file changed. |
| `staleness.yml` | daily 05:23 UTC, manual | Refresh `data/staleness.json` against Steam's public Workshop API; commit when a build moved. |
| `audit-request.yml` | issue opened/labelled `mod-request`, manual | Downloads the requested Workshop item with `steamcmd`, runs the static triage, commits each step to `data/audit-runs.json`, deploys, writes `reports/<id>.html` and comments the outcome on the issue. |
| `admin-commands.yml` | manual | Runs `scripts/admin.mjs` with the chosen action and id, rebuilds, verifies and commits `data/site-config.json`. |
| `issue-triage.yml` | issues opened | If a new issue looks like an audit request, labels it `mod-request`, acknowledges it and dispatches `requests-sync.yml`. |
| `link-check.yml` | weekly, manual | Build + internal link check, then probes the live routes and `/api/requests`. |
| `dependabot-automerge.yml` | pull request, after CI | Enables squash auto-merge for Dependabot patch/minor bumps once CI is green. |

CodeQL is not included: code scanning is unavailable for this repository without GitHub Advanced
Security, so the workflow failed on every run and was removed.

`.github/dependabot.yml` keeps GitHub Actions and any future npm tooling up to date weekly.

## How a request becomes an audit

1. A visitor submits the form on `requests.html` (or opens an issue directly).
2. `POST /api/request` validates the item against Steam and opens an issue labelled `mod-request`.
3. `issue-triage.yml` labels/acknowledges the issue and dispatches `requests-sync.yml`; the request
   appears in the site's "Queued for audit" list as `pending`.
4. `audit-request.yml` starts automatically (issue opened with the label, or when it is labelled).
   It marks the run `running` and the site shows it live in "Working on it, in public":
   metadata → download → hash/scan → report → publish.
5. The run commits `data/audit-runs.json` and `data/reports.json` after every step and deploys, so a
   visitor can watch the state change while it works. Each run appends a `reports/<id>.html` page.
6. When it finishes, the workflow comments the verdict, score and report link on the issue and
   swaps the `audit-running` label for `audited` (or `audit-blocked` on failure).

The automated triage is a static scan (unpack, hash every file, parse PE headers, match indicator
patterns, inspect text/config/scripts). It is documented as a scan, not a manual audit — it cannot
see runtime behaviour or remote payloads. The automated score and verdict are kept separate from the
hand-written verdicts in `data/audit.json`, which stay the authority for installed mods.

## How the update watch works

`check-staleness.mjs` asks Steam for `time_updated` on every audited item. A mod is flagged when
Steam's update time is newer than the audit date, or when the item no longer resolves (delisted or
unlisted). The site then shows an "Update watch" callout; the verdict still applies to the audited
bytes, which is why the banner names the mod rather than changing its score.

## Secrets and permissions

| Secret | Scope | Notes |
| --- | --- | --- |

Workflows use the built-in `GITHUB_TOKEN` for issue reads and repository commits; no personal token is
stored in Actions. That token cannot push workflow files, so changes to `.github/workflows/` have to
arrive through a normal (non-workflow) push.

`netlify/functions/*` are optional and unused by the live site. If you host them yourself they read:

| Variable | Used by | Notes |
| --- | --- | --- |
| `GITHUB_TOKEN` | request + admin functions | Fine-grained token with Issues (write) and Contents (write) for this repo. |
| `GITHUB_REPO` | request + admin functions | `praisethefacts/puck-workshop-audit`. |
| `ADMIN_TOKEN` | admin function | Password for `/admin.html`; checked server-side, never shipped to the browser. |

## Removing things from the site

`/admin.html` hides a mod, a queued request or a re-audit row. Every action is a commit to
`data/site-config.json`, so it is reviewable and reversible — nothing is deleted from the audit
itself. Hidden items disappear from the ledger, the queue and the counts, but remain in the data.

```sh
npm run admin -- list
npm run admin -- hide-mod 3776968217
npm run admin -- show-mod 3776968217
npm run admin -- hide-request 5
npm run admin -- hide-reaudit 3811996661
npm run admin -- site-url https://praisethefacts.github.io/puck-workshop-audit
```

## Running the automated triage by hand

```sh
npm run audit -- --id 3826743382        # download, scan, write report, commit, deploy
npm run audit -- --id 3826743382 --no-push   # keep everything local
node scripts/issue-comment.mjs 3826743382   # preview the issue comment
```

`audit-mod.mjs` needs `steamcmd` on `PATH` (or `STEAMCMD=/path/to/steamcmd.sh`) and only performs a
`+login anonymous` workshop download; it never signs in with an account.

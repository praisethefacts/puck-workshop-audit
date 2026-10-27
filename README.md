# Puck Workshop mod audit

**Live site:** https://praisethefacts.github.io/puck-workshop-audit/ (GitHub Pages mirror,
republished on every commit) · https://puck-workshop-safecheck.netlify.app (canonical host with
the request/admin functions; its deploys pause when the Netlify account credits run out).

A static, dependency-free security audit site for 63 installed Puck Workshop mods, an automated
triage pipeline for newly requested mods, and a public request queue. Plain HTML, CSS and vanilla
JavaScript; the build is a single Node script with no npm dependencies, and Netlify hosts the static
output and two small Web API functions.

No framework, bundler, CDN, cookie or client-side tracker is used.

## What is here

| Path | Purpose |
| --- | --- |
| `data/audit.json` | The audit itself: verdicts, scores, findings, re-audit log, full report Markdown |
| `data/requests.json` | The public audit queue, kept in sync with GitHub issues labelled `mod-request` |
| `data/audit-runs.json` | Live state of automated triage runs (steps, timestamps, notes) |
| `data/reports.json` | Index of machine-generated triage reports published under `reports/` |
| `data/staleness.json` | "Update watch": Workshop builds that moved, or delisted items, since the audit |
| `data/site-config.json` | Which mods/requests/re-audits are hidden, and the canonical site URL |
| `scripts/build.mjs` | Zero-dependency generator: renders `dist/` from the data files |
| `scripts/verify.mjs` | Structural checks on the built site (rows, pages, queue, runs, leaks) |
| `scripts/check-links.mjs` | Internal link and anchor checker |
| `scripts/validate-data.mjs` | Schema checks for the committed data files |
| `scripts/sync-requests.mjs` | GitHub issues → `data/requests.json` |
| `scripts/check-staleness.mjs` | Steam Workshop → `data/staleness.json` |
| `scripts/audit-mod.mjs` | Automated triage: Steam download → hash/scan → report → commit → deploy |
| `scripts/lib/triage.mjs` | The static triage engine (PE metadata, indicator patterns, scoring) |
| `scripts/request-id.mjs` | Extracts a Workshop id from issue title/body |
| `scripts/issue-comment.mjs` | Builds the verdict comment posted back on the issue |
| `scripts/admin.mjs` | CLI for hiding/showing entries (`data/site-config.json`) |
| `scripts/serve.mjs` | Tiny static server for `dist/` |
| `scripts/theme/` | Source stylesheet, browser scripts and favicon copied into `dist/assets/` |
| `netlify/functions/api.mjs` | `/api/requests` (GET) and `/api/request` (POST) |
| `netlify/functions/admin.mjs` | `/api/admin` (POST): password-gated visibility changes |
| `netlify.toml` | Build command, publish directory, function directory, API rewrites and headers |

`dist/` is generated and is not committed. Every page, report and asset in it is reproducible from
the committed data with `npm run build`.

## Build, verify and preview

Requirements: Node.js 20 or newer. There is nothing to install. Automated triage also needs
`steamcmd` (only for the download step) and `netlify-cli` (only for the deploy step).

```sh
npm run build     # writes dist/
npm run verify    # structural checks on dist/
npm run check     # build + verify + internal link check + data validation
npm run serve     # http://127.0.0.1:4173/ over dist/
```

`build.mjs` accepts `--out <dir>` and `--data <file>` (defaults: `dist`, `data/audit.json`). The
site never fetches Markdown at runtime: every report is rendered during the build, and the generator
redacts local filesystem paths and machine usernames from report content before writing HTML.

For the API functions, use `npx netlify dev` instead of `npm run serve`; the static server is enough
for the ledger, reports, method page and the request page's designed offline state.

## Automated triage

`audit-request.yml` runs when an issue labelled `mod-request` is opened. It downloads the published
Workshop files anonymously with `steamcmd`, hashes every file, reads PE headers, matches indicator
patterns against strings/scripts/configs and writes a machine-generated report.

Progress is public: every step commits `data/audit-runs.json` and deploys, so
`requests.html#automation` shows the run moving through
`metadata → download → hash/scan → report → publish` while it works. The finished report lives at
`reports/<id>.html` and is linked from the queue and from the issue comment.

```sh
npm run audit -- --id 3826743382         # run it locally (needs STEAMCMD)
npm run audit -- --id 3826743382 --no-push
node scripts/issue-comment.mjs 3826743382
```

The automated score is deliberately kept apart from the hand-written verdicts: the ledger is a human
audit, the report page is a scan, and the page says so. A clean scan is not a safety guarantee.

## Deploy

Deployment is automated: a push to `main` runs **Deploy**, which builds, verifies, checks links and
publishes `dist/` to Netlify. To do it locally:

```sh
npm run build
netlify deploy --prod --dir=dist --functions=netlify/functions
```

### Repository secrets

| Secret | Used by | Purpose |
| --- | --- | --- |
| `NETLIFY_AUTH_TOKEN` | Deploy | Netlify personal access token. |
| `NETLIFY_SITE_ID` | Deploy | `710ee0da-e912-4c0d-a334-f9a6ad59b911` for the live site. |

### Netlify environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Fine-grained token with **Issues: read and write** and **Contents: read and write** on the queue repository. Creates request issues, and commits visibility changes from the admin page. |
| `GITHUB_REPO` | Optional | `owner/repo` for the queue. Defaults to `praisethefacts/puck-workshop-audit`. |
| `ADMIN_TOKEN` | Yes, for `/admin.html` | Password for the admin page. Compared server-side; never rendered into the page. |

Never put these in client code, `netlify.toml`, or the repository. Both functions read them from the
environment and never return them to the browser.

## Automation

The repository keeps itself current with GitHub Actions (details in
[`docs/AUTOMATION.md`](docs/AUTOMATION.md)):

- **CI** — build, verify, link-check and data-validate every push and pull request.
- **Deploy** — build and publish to Netlify on every push to `main`, and after the data workflows.
- **Sync audit requests** — hourly, on issue events and on dispatch: issues labelled `mod-request`
  become `data/requests.json`, and the Workshop update watch is refreshed.
- **Audit requested mod** — downloads a requested item, runs the static triage, publishes the report
  and the live progress, and comments the outcome on the issue.
- **Update watch** — daily Steam check so a mod that changed after its audit shows an update banner.
- **Site admin** — manual workflow for hide/show changes without leaving GitHub.
- **Triage audit requests** — labels and acknowledges new request issues, then triggers the sync.
- **Link and uptime check**, **Dependabot** — weekly link/uptime probe and dependency/action updates.

CodeQL is intentionally not part of the pipeline: code scanning needs GitHub Advanced Security, which
is not enabled for this private repository, so the workflow could only fail. Add
`.github/workflows/codeql.yml` back if the repository ever gains code scanning.

## Admin page

`/admin.html` (noindex, not linked from the site navigation) lets the operator hide or restore a mod,
a request or a re-audit row. Each action is a commit to `data/site-config.json` via
`/api/admin`, so it is reviewable and reversible; the audit reports themselves are never deleted.
The same changes can be made from the **Site admin** workflow or locally with
`npm run admin -- hide-mod 3776968217`.

## API contract

### `GET /api/requests`

Reads open and closed issues labelled `mod-request` from the configured repository and returns them
as a list of public queue entries. When the queue cannot be reached the page shows its offline state
and links to the GitHub issue list rather than pretending the queue is empty.

### `POST /api/request`

```json
{
  "mod": "https://steamcommunity.com/sharedfiles/filedetails/?id=3776968217",
  "reason": "New binary in the update; unexpected outbound traffic",
  "contact": "optional handle"
}
```

`mod` may be a Workshop link, a numeric published file ID, or `steam://url/CommunityFilePage/<id>`.
The function extracts the ID, checks the item through Steam's public `GetPublishedFileDetails`
endpoint (rejecting deleted, unlisted, private or banned items), opens a GitHub issue titled
`Audit request: <title> (<id>)` with the `mod-request` label, and returns
`{ "ok": true, "issueUrl": "..." }`.

Limits: `mod` 300 characters, `reason` 2,000, `contact` 200. POSTs are rate-limited in memory per
client address to five per hour per function instance; this is a courtesy limit, not a security
boundary.

### `POST /api/admin`

```json
{ "password": "<ADMIN_TOKEN>", "action": "hide-mod", "id": "3776968217" }
```

Actions: `hide-mod`, `show-mod`, `hide-request`, `show-request`, `hide-reaudit`, `show-reaudit` and
`check` (validates the password and returns the current hidden lists). Changes are written to
`data/site-config.json` in the repository through the GitHub contents API, which then triggers the
deploy workflow.

## Content and privacy notes

- The site contains no analytics, cookies or third-party scripts.
- The request queue is public. Contact details entered in the form become part of a public GitHub
  issue.
- Reports are static triage tied to file hashes, not a sandbox detonation or a guarantee. Read
  `method.html` before treating a verdict as complete. Automated report pages say exactly what they
  are: a scan of the published files, not an audit of intent.
- The admin page is excluded from the sitemap and marked `noindex`; it contains no data beyond the
  public ledger.

## License and attribution

The audit content belongs to its author. Steam Workshop names and links belong to their respective
creators. This repository contains no mod binaries.

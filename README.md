# Puck Workshop mod audit

**Live site:** https://praisethefacts.github.io/puck-workshop-audit/ — GitHub Pages, republished on
every commit by the **Publish mirror** workflow. That is the only deployment.

A static, dependency-free security audit site for 63 installed Puck Workshop mods, an automated
triage pipeline for newly requested mods, and a public request queue. Plain HTML, CSS and vanilla
JavaScript; the build is a single Node script with no npm dependencies. The hosted site needs no
server: the request form hands off to a pre-filled GitHub issue, and the queue is a static snapshot
that the workflows keep in sync.

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
| `netlify/functions/api.mjs` | Optional self-hosting: `/api/requests` (GET) and `/api/request` (POST). Not used by the live site. |
| `netlify/functions/admin.mjs` | Optional self-hosting: `/api/admin` (POST), password-gated visibility changes. Not used by the live site. |
| `netlify.toml` | Optional self-hosting config (build command, publish dir, functions, API rewrites). Not used by the live site. |

`dist/` is generated and is not committed. Every page, report and asset in it is reproducible from
the committed data with `npm run build`.

## Build, verify and preview

Requirements: Node.js 20 or newer. There is nothing to install. Automated triage also needs
`steamcmd` (only for the download step); decompilation needs the .NET SDK with `ilspycmd`
(`scripts/install-audit-tools.sh` installs both).

```sh
npm run build     # writes dist/
npm run verify    # structural checks on dist/
npm run check     # build + verify + internal link check + data validation
npm run serve     # http://127.0.0.1:4173/ over dist/
```

`build.mjs` accepts `--out <dir>` and `--data <file>` (defaults: `dist`, `data/audit.json`). The
site never fetches Markdown at runtime: every report is rendered during the build, and the generator
redacts local filesystem paths and machine usernames from report content before writing HTML.

`npm run serve` is enough for every page: the request form falls back to a pre-filled GitHub issue,
and the queue renders from the committed snapshot.

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

Deployment is automated and static. A push to `main` (or a completed data/audit workflow) runs
**Publish mirror**, which builds `dist/`, verifies it, checks links and publishes it to GitHub Pages.
There is no other host and no server-side component.

To inspect exactly what will be published, build and serve it locally:

```sh
npm run check
npm run serve
```

### Optional: hosting the API functions yourself

`netlify/functions/*` and `netlify.toml` are kept for anyone who wants server-side request intake or
the password-gated admin page. They are inert on GitHub Pages. If you do host them, set:

| Name | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes | Fine-grained token with **Issues: read and write** and **Contents: read and write** on the queue repository. |
| `GITHUB_REPO` | Optional | `owner/repo` for the queue. Defaults to `praisethefacts/puck-workshop-audit`. |
| `ADMIN_TOKEN` | Yes, for `/admin.html` | Password for the admin page. Compared server-side; never rendered into the page. |

Never put these in client code or the repository: both functions read them from the environment and
never return them to the browser. On the live GitHub Pages site, visibility changes are made by
committing `data/site-config.json` (see `npm run admin -- --help`).

## Automation

The repository keeps itself current with GitHub Actions (details in
[`docs/AUTOMATION.md`](docs/AUTOMATION.md)):

- **CI** — build, verify, link-check and data-validate every push and pull request.
- **Publish mirror** — build, verify and publish to GitHub Pages on every push to `main`, and after the data workflows.
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

## Run the same audit in a Codespace or in Actions

The hand audits were made with a local pipeline: download the Workshop files, hash
every file, parse the PE headers, decompile the managed assemblies with ILSpy, match
indicators, then write `REPORT.md` + `evidence/` + `sources/`. That pipeline is in this
repository as `scripts/audit-box.mjs`, so the same output can be produced anywhere Node
and .NET run.

### GitHub Codespace (interactive, same as the PC)

1. On GitHub: **Code -> Codespaces -> Create codespace on main** (this repo's
   `.devcontainer/devcontainer.json` installs Node, .NET, ILSpy CLI and steamcmd).
2. In the Codespace terminal:

   ```bash
   node scripts/audit-box.mjs --id 3776968217
   # or, for files you already have:
   node scripts/audit-box.mjs --id 3776968217 --dir /workspaces/puck-workshop-audit/mod
   ```

   It downloads the item anonymously with steamcmd, then writes:

   ```
   audit-out/<id>_<name>/
     REPORT.md
     evidence/   inventory.tsv, hashes_sha256.txt, pe_info.txt,
                 scan_hits.tsv, api_surface.txt, FACTS.md
     sources/    decompiled C# (ILSpy project export)
     report.json
   ```

3. Download the folder or run `zip -r audit.zip audit-out` if you want it locally.

Re-running `scripts/install-audit-tools.sh` is safe; it only installs what is missing.

### GitHub Actions (no local setup)

`Actions -> Full audit (on demand) -> Run workflow` takes a Workshop id, runs the same
script on `ubuntu-24.04`, and uploads the `audit-out/` folder as a downloadable artifact
for 30 days. It does not publish to the public site - that stays with the
`audit-request` workflow, which produces the lighter site triage.

What is still different from a hand audit: the automated pass does not read intent.
It reports what the bytes can do and the same 0-100 rubric, but a person still decides
whether a capability is legitimate for a hockey mod.

### One click on Windows: `audit.bat`

Double-click `audit.bat` (or drag a Workshop link onto it) and it will:

1. accept a Workshop id, a `steamcommunity.com/...?id=` link or a `steam://` link,
2. find `node`, `ilspycmd` and `steamcmd` (it looks in the usual places, including
   `%USERPROFILE%\Documents\Code\_steamcmd`),
3. run the full audit into `audit-out\<id>_<name>\` and open the folder.

```bat
audit.bat                          :: asks for an id / link
audit.bat 3765045334               :: full audit (REPORT.md + evidence\ + sources\)
audit.bat 3765045334 site          :: also publish it as an automated site triage
audit.bat 3765045334 --dir "%CD%\mod"   :: audit files already on disk
```

Set `AUDIT_BATCH=1` to skip the "press any key" and the Explorer window (CI use).

### Docker

Same pipeline in a container: Node 22, .NET 8, ILSpy CLI and steamcmd are baked in.

```bash
docker build -t puck-audit .
docker run --rm -e ID=3765045334 -v "$PWD/audit-out:/work/audit-out" puck-audit
```

or with Compose (mounts `audit-out/`, `data/` and `reports/` back into the repo):

```bash
ID=3765045334 docker compose run --rm audit          # full audit
MODE=site ID=3765045334 docker compose run --rm audit   # site triage in reports/ + data/
```

In PowerShell the variables go through the environment:

```powershell
$env:ID = "3765045334"; docker compose run --rm audit
```

The image downloads Workshop items with steamcmd anonymous login inside the
container, so no Steam account is needed. Decompiled sources land in
`audit-out\<id>_<name>\sources\`.

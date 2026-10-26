# Puck Workshop mod audit

A static, dependency-free security audit site for 63 installed Puck Workshop mods. The pages are plain HTML, CSS and vanilla JavaScript; Netlify hosts the static output and one Web API function for the public request queue.

No framework, build tool, CDN, cookie or client-side tracker is used.

## What is here

| Path | Purpose |
| --- | --- |
| `index.html` | Verdict, headline numbers, findings, re-audit log and the filterable 63-row ledger |
| `mods/<id>.html` | One rendered audit report per Workshop item |
| `method.html` | Method, scoring bands, scope and limitations, with a contents list |
| `requests.html` | Workshop audit request form and the public GitHub-backed queue |
| `assets/style.css` | The single stylesheet |
| `assets/app.js` | Ledger filtering/sorting and request-page behaviour |
| `netlify/functions/api.mjs` | Dependency-free Web API function for `/api/request` and `/api/requests` |
| `scripts/build.mjs` | Zero-dependency generator for every page |
| `scripts/theme/` | Source stylesheet, browser script and favicon copied by the generator |
| `netlify.toml` | Static publish directory, function directory and API rewrites |

The generated `assets/` files are copies of `scripts/theme/` and are committed with the HTML so the site works as plain files.

## Regenerate

Requirements: Node.js 18 or newer. There are no packages to install.

```sh
node scripts/build.mjs
```

The generator reads the audit JSON in this order:

1. The path in the `SITE_DATA` environment variable.
2. `../puck-audit-site/data/site.json` (the sibling audit workspace).
3. `data/site.json` (a local copy, if present).

The generated site does not fetch Markdown at runtime. Reports are rendered during the build.

```sh
SITE_DATA=/absolute/path/to/site.json node scripts/build.mjs
```

## Preview

The static pages work directly from the filesystem. To exercise the Netlify redirects and function locally:

```sh
npx netlify dev
```

A plain static server is enough for the ledger, reports and method page. The request queue will show its designed unavailable state when `/api/requests` does not exist.

## Deploy

From this folder, with the Netlify CLI installed and the site linked:

```sh
netlify deploy --prod
```

The generated files are already present. Netlify does not need a build command; `netlify.toml` publishes the folder and bundles the function. Do not deploy a generated copy that still contains the source audit JSON.

### Environment variables

Set these in Netlify (Site configuration → Environment variables):

| Name | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Required for writes; optional for public reads | Token with permission to create issues in the queue repository. A fine-grained token with **Issues: read and write** on that repository is enough. |
| `GITHUB_REPO` | Optional | `owner/repo` for the request queue. Defaults to `praisethefacts/puck-workshop-audit`. |

Never put `GITHUB_TOKEN` in client code, `netlify.toml`, or the repository. The function is the only place it is read, and it is never returned to the browser.

## API contract

### `GET /api/requests`

Reads open and closed issues labelled `mod-request` from the configured GitHub repository.

```json
{
  "ok": true,
  "items": [
    {
      "number": 12,
      "title": "Audit request: Example mod (3776968217)",
      "url": "https://github.com/owner/repo/issues/12",
      "state": "open",
      "createdAt": "2026-10-26T22:42:50Z",
      "labels": ["mod-request"]
    }
  ]
}
```

Errors are JSON with `{ "ok": false, "error": "..." }` and a 4xx/5xx status.

### `POST /api/request`

Request body:

```json
{
  "mod": "https://steamcommunity.com/sharedfiles/filedetails/?id=3776968217",
  "reason": "New binary in the update; unexpected outbound traffic",
  "contact": "optional handle"
}
```

`mod` can be a public Steam Community file link, a numeric published file ID, or a `steam://url/CommunityFilePage/<id>` link. The function:

1. Extracts and validates the ID.
2. Checks the item through Steam's public `GetPublishedFileDetails` endpoint and rejects deleted, unlisted, private or banned items.
3. Opens a GitHub issue titled `Audit request: <title> (<id>)` with the `mod-request` label.
4. Returns `{ "ok": true, "issueUrl": "..." }`.

Limits: `mod` 300 characters, `reason` 2,000, `contact` 200. POSTs are rate-limited in memory per client address to five per hour per function instance; this is a courtesy limit, not a security boundary.

The form handles validation, a pending button, success, API errors, timeouts and an unreachable API. If the API is unavailable, it links to the GitHub issue list so a request can still be filed.

## Content and privacy notes

- The site contains no analytics, cookies or third-party scripts.
- The request queue is public. Contact details entered in the form become part of a public GitHub issue.
- Reports are static triage tied to file hashes, not a sandbox detonation or a guarantee. Read `method.html` before treating a verdict as complete.
- The generator redacts local filesystem paths and machine usernames from report content before writing HTML.

## License and attribution

The audit content belongs to its author. Steam Workshop names and links belong to their respective creators. This repository contains no mod binaries.

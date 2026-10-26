#!/usr/bin/env node
/**
 * Sync the public request queue from GitHub issues into data/requests.json.
 *
 * Every issue labelled `mod-request` is parsed for a Workshop item id, checked
 * against Steam's public Workshop API, and written back with a status:
 *
 *   audited         the item is in data/audit.json and its audited bytes match
 *   needs-reaudit   the item is audited but Steam reports a newer build
 *   pending         open request for an item that has no report yet
 *   closed          closed request that never produced a report
 *
 * Usage: node scripts/sync-requests.mjs [--dry-run]
 * Env: GITHUB_TOKEN (required), GITHUB_REPOSITORY (defaults to the repo below)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const REPO = process.env.GITHUB_REPOSITORY || "praisethefacts/puck-workshop-audit";
const TOKEN = process.env.GITHUB_TOKEN || "";
const DRY_RUN = process.argv.includes("--dry-run");
const STEAM_DETAILS =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const writeJson = (file, value) => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const audit = readJson(path.join(DATA_DIR, "audit.json"), { mods: [], auditDate: "" });
const previous = readJson(path.join(DATA_DIR, "requests.json"), { requests: [] });
const auditDate = String(audit.auditDate || "");

const auditedAt = new Map();
for (const mod of audit.mods || []) {
  auditedAt.set(String(mod.id), auditDate);
}

// A re-audit after the bulk snapshot supersedes the audit date for that mod.
for (const reaudit of audit.reaudits || []) {
  const timestamp = String(reaudit.when || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) continue;
  const ids = String(reaudit.mod || "").match(/\b\d{6,20}\b/g) || [];
  for (const id of ids) {
    const current = auditedAt.get(id);
    if (!current || timestamp > current) auditedAt.set(id, timestamp);
  }
}

const auditById = new Map((audit.mods || []).map((mod) => [String(mod.id), mod]));

function parseModId(text) {
  const source = String(text || "");
  const url = source.match(/(?:id=|steam:\/\/url\/CommunityFilePage\/)(\d{5,20})/i);
  if (url) return Number(url[1]);
  const parenthesised = source.match(/\((\d{5,20})\)/);
  if (parenthesised) return Number(parenthesised[1]);
  const bare = source.match(/\b(\d{5,20})\b/);
  return bare ? Number(bare[1]) : null;
}

function extractReason(body) {
  const text = String(body || "").replace(/\r/g, "");
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^requested because|^reason/i.test(entry));
  if (!line) return "";
  const cleaned = line.replace(/^\**\s*(requested because|reason)\**\s*:?\s*/i, "").trim();
  return cleaned.slice(0, 200);
}

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "puck-workshop-audit-requests-sync",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${pathname} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listIssues() {
  const issues = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(
      `/repos/${REPO}/issues?labels=mod-request&state=all&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

async function steamDetails(ids) {
  const details = new Map();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const body = new URLSearchParams();
    body.set("itemcount", String(batch.length));
    batch.forEach((id, index) => body.set(`publishedfileids[${index}]`, String(id)));
    const response = await fetch(STEAM_DETAILS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`Steam Workshop API -> ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    for (const item of payload?.response?.publishedfiledetails || []) {
      details.set(String(item.publishedfileid), item);
    }
  }
  return details;
}

function newerBuild(item, audited) {
  const updated = Number(item?.time_updated || 0) * 1000;
  const auditedTime = Date.parse(audited);
  if (!updated || Number.isNaN(auditedTime)) return false;
  return updated > auditedTime;
}

async function main() {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN is not set; cannot read the request queue.");
    process.exit(1);
  }

  const issues = await listIssues();
  const parsed = issues
    .map((issue) => ({
      issue,
      id: parseModId(
        `${issue.title || ""}\n${issue.body || ""}\n${(issue.labels || [])
          .map((label) => label.name)
          .join(" ")}`
      ),
    }))
    .filter((entry) => entry.id);

  const ids = [...new Set(parsed.map((entry) => String(entry.id)))];
  const steam = ids.length ? await steamDetails(ids) : new Map();

  const now = new Date().toISOString();
  const requests = parsed.map(({ issue, id }) => {
    const key = String(id);
    const item = steam.get(key);
    const audited = auditedAt.get(key);
    const workshopUpdated = item?.time_updated
      ? new Date(Number(item.time_updated) * 1000).toISOString()
      : "";

    let status = "pending";
    if (audited) {
      status = newerBuild(item, audited) ? "needs-reaudit" : "audited";
    } else if (issue.state === "closed") {
      status = "closed";
    }

    const known = auditById.get(key);
    return {
      id: key,
      title: String(item?.title || known?.name || issue.title || `Workshop item ${key}`)
        .replace(/^Audit request:\s*/i, "")
        .replace(/\s*\(\d{5,20}\)\s*$/, "")
        .trim(),
      issue: issue.number,
      status,
      requestedAt: issue.created_at,
      updatedAt: now,
      note: extractReason(issue.body),
      workshopUpdated,
      steamResult: Number(item?.result ?? -1),
    };
  });

  // One row per mod id: keep the oldest issue, but let the newest state win.
  const byId = new Map();
  for (const request of requests.sort((a, b) =>
    String(a.requestedAt).localeCompare(String(b.requestedAt))
  )) {
    const existing = byId.get(request.id);
    if (!existing) {
      byId.set(request.id, request);
      continue;
    }
    existing.status = request.status;
    existing.updatedAt = now;
    if (request.workshopUpdated) existing.workshopUpdated = request.workshopUpdated;
    existing.duplicateIssue = existing.duplicateIssue || request.issue;
  }

  // Keep manual notes written into requests.json by hand.
  const manual = new Map((previous.requests || []).map((entry) => [String(entry.id), entry]));
  for (const request of byId.values()) {
    const hand = manual.get(request.id);
    if (hand?.note && !request.note) request.note = hand.note;
    if (hand?.hidden) request.hidden = true;
  }

  const next = {
    updatedAt: now,
    source: `GitHub issues labelled mod-request in ${REPO}`,
    requests: [...byId.values()].sort((a, b) =>
      String(b.requestedAt).localeCompare(String(a.requestedAt))
    ),
  };

  // Ignore the volatile timestamp when deciding whether anything really changed,
  // so the scheduled run only commits when queue state moves.
  const strip = (list) =>
    JSON.stringify(
      [...list]
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((entry) => {
          const { updatedAt: _updatedAt, ...rest } = entry;
          return rest;
        })
    );

  const previousList = previous.requests || [];
  const changed = strip(next.requests) !== strip(previousList);
  if (!changed) next.requests = previousList;

  if (!DRY_RUN && changed) writeJson(path.join(DATA_DIR, "requests.json"), next);

  const tally = next.requests.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`${next.requests.length} request(s): ${JSON.stringify(tally)}`);
  console.log(changed ? "data/requests.json updated." : "No change.");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${next.requests.length}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

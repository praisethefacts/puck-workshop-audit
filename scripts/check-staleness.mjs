#!/usr/bin/env node
/**
 * Watch the Steam Workshop builds behind every audited mod.
 *
 * The audit ties each verdict to hashes of the installed files. A Workshop
 * update replaces those bytes, so this job compares Steam's public
 * `time_updated` against the audit (and re-audit) timestamps and records the
 * mods whose build moved. data/staleness.json feeds the "update watch" banner
 * on the site.
 *
 * Usage: node scripts/check-staleness.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
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

const audit = readJson(path.join(DATA_DIR, "audit.json"), { mods: [] });
const config = readJson(path.join(DATA_DIR, "site-config.json"), {});
const previous = readJson(path.join(DATA_DIR, "staleness.json"), { items: [] });

const auditDate = String(audit.auditDate || "");
const hidden = new Set((config.hiddenMods || []).map(String));

const auditedAt = new Map();
for (const mod of audit.mods || []) auditedAt.set(String(mod.id), auditDate);

// Re-audits after the bulk snapshot supersede the audit date for that mod.
for (const reaudit of audit.reaudits || []) {
  const timestamp = String(reaudit.when || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) continue;
  for (const id of String(reaudit.mod || "").match(/\b\d{6,20}\b/g) || []) {
    const current = auditedAt.get(id);
    if (!current || timestamp > current) auditedAt.set(id, timestamp);
  }
}

const ids = [...auditedAt.keys()].filter((id) => !hidden.has(id));

async function steamDetails(batch) {
  const body = new URLSearchParams();
  body.set("itemcount", String(batch.length));
  batch.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
  const response = await fetch(STEAM_DETAILS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Steam Workshop API -> ${response.status}`);
  const payload = await response.json();
  return new Map(
    (payload?.response?.publishedfiledetails || []).map((item) => [
      String(item.publishedfileid),
      item,
    ])
  );
}

async function main() {
  const items = [];

  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const details = await steamDetails(batch);

    for (const id of batch) {
      const item = details.get(id);
      const mod = (audit.mods || []).find((entry) => String(entry.id) === id);
      const name = String(item?.title || mod?.name || `Workshop item ${id}`);
      const audited = auditedAt.get(id) || auditDate;
      const updatedAt = item?.time_updated
        ? new Date(Number(item.time_updated) * 1000).toISOString()
        : "";

      if (!item || Number(item.result) !== 1) {
        items.push({ id, name, auditedAt: audited, state: "missing", workshopUpdated: "" });
        continue;
      }

      const updatedMs = Number(item.time_updated || 0) * 1000;
      const auditedMs = Date.parse(audited);
      if (updatedMs && !Number.isNaN(auditedMs) && updatedMs > auditedMs) {
        items.push({
          id,
          name,
          auditedAt: audited,
          state: "updated",
          workshopUpdated: updatedAt,
        });
      }
    }
  }

  items.sort((a, b) => String(b.workshopUpdated).localeCompare(String(a.workshopUpdated)));

  const next = {
    checkedAt: new Date().toISOString(),
    source: "Steam ISteamRemoteStorage/GetPublishedFileDetails",
    items,
  };

  const strip = (value) =>
    JSON.stringify({
      items: (value.items || []).map(({ ...rest }) => rest),
    });

  const changed = strip(next) !== strip(previous);
  if (!DRY_RUN && changed) {
    fs.writeFileSync(
      path.join(DATA_DIR, "staleness.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8"
    );
  }

  console.log(
    `${ids.length} audited mods checked · ${items.length} moved or unverifiable · ${
      changed ? "data/staleness.json updated" : "no change"
    }`
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `stale=${items.length}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

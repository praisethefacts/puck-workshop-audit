#!/usr/bin/env node
/**
 * Edit data/site-config.json without hand-editing JSON.
 *
 * This is the same lever the /remove and /restore GitHub-issue commands use, so
 * you can also run it locally:
 *
 *   node scripts/admin.mjs list
 *   node scripts/admin.mjs hide-mod 3776968217 3824708567
 *   node scripts/admin.mjs show-mod 3776968217
 *   node scripts/admin.mjs hide-request 5
 *   node scripts/admin.mjs show-request 5
 *   node scripts/admin.mjs hide-reaudit 3735183385
 *   node scripts/admin.mjs site-url https://praisethefacts.github.io/puck-workshop-audit
 *
 * Hidden mods disappear from the ledger and their mod page is not generated.
 * Hidden requests disappear from the "Queued for audit" list. Editing only
 * rewrites the relevant array and keeps everything else intact.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "site-config.json");

const LISTS = {
  "hide-mod": "hiddenMods",
  "show-mod": "hiddenMods",
  "hide-request": "hiddenRequests",
  "show-request": "hiddenRequests",
  "hide-reaudit": "hiddenReaudits",
  "show-reaudit": "hiddenReaudits",
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const config = readJson(CONFIG_PATH, {
  siteUrl: "https://praisethefacts.github.io/puck-workshop-audit",
  hiddenMods: [],
  hiddenRequests: [],
  hiddenReaudits: [],
});

for (const key of ["hiddenMods", "hiddenRequests", "hiddenReaudits"]) {
  if (!Array.isArray(config[key])) config[key] = [];
}

const audit = readJson(path.join(DATA_DIR, "audit.json"), { mods: [] });
const knownModIds = new Set((audit.mods || []).map((mod) => String(mod.id)));

function save() {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalize(value) {
  return String(value).replace(/^#/, "").trim();
}

function usage() {
  console.error(
    [
      "Usage: node scripts/admin.mjs <command> [values...]",
      "",
      "  list                          show current visibility settings",
      "  hide-mod <id...>              remove mods from the ledger",
      "  show-mod <id...>              restore hidden mods",
      "  hide-request <id|issue...>    hide entries from the requested list",
      "  show-request <id|issue...>    restore hidden requests",
      "  hide-reaudit <id...>          hide re-audit log rows for a mod",
      "  show-reaudit <id...>          restore re-audit rows",
      "  site-url <url>                canonical URL used in the sitemap",
    ].join("\n")
  );
  process.exit(2);
}

const [command, ...values] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") usage();

if (command === "list") {
  console.log(
    JSON.stringify(
      {
        siteUrl: config.siteUrl,
        hiddenMods: config.hiddenMods,
        hiddenRequests: config.hiddenRequests,
        hiddenReaudits: config.hiddenReaudits,
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (command === "site-url") {
  const url = String(values[0] || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    console.error("site-url needs an http(s) URL.");
    process.exit(1);
  }
  config.siteUrl = url;
  save();
  console.log(`siteUrl = ${url}`);
  process.exit(0);
}

const listName = LISTS[command];
if (!listName) usage();

if (values.length === 0) {
  console.error(`${command} needs at least one value.`);
  process.exit(1);
}

const hidden = command.startsWith("hide-");
let changed = 0;

for (const raw of values) {
  const value = normalize(raw);
  if (!value) continue;

  if (listName === "hiddenMods" && hidden && !knownModIds.has(value)) {
    console.warn(`warning: ${value} is not in data/audit.json (hiding it anyway)`);
  }

  const index = config[listName].indexOf(value);
  if (hidden && index === -1) {
    config[listName].push(value);
    changed += 1;
  } else if (!hidden && index !== -1) {
    config[listName].splice(index, 1);
    changed += 1;
  }
}

if (changed > 0) {
  save();
  console.log(`${command}: ${changed} change(s).`);
  console.log(`${listName}: ${config[listName].join(", ") || "(empty)"}`);
} else {
  console.log(`${command}: nothing to change.`);
}

#!/usr/bin/env node
/**
 * Post-build checks for the generated site.
 *
 * Usage: node scripts/verify.mjs [--out dist] [--data data/audit.json]
 * Exits non-zero and prints every problem instead of the first one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cliArg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
};

const OUT = path.resolve(ROOT, cliArg("out") || "dist");
const dataPath = path.resolve(ROOT, cliArg("data") || path.join("data", "audit.json"));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const problems = [];
const notes = [];

const audit = readJson(dataPath, null);
if (!audit || !Array.isArray(audit.mods)) {
  console.error(`No usable audit data at ${dataPath}`);
  process.exit(1);
}

const config = readJson(path.join(ROOT, "data", "site-config.json"), {});
const requests = readJson(path.join(ROOT, "data", "requests.json"), { requests: [] });
const staleness = readJson(path.join(ROOT, "data", "staleness.json"), { items: [] });

const hiddenMods = new Set((config.hiddenMods || []).map(String));
const hiddenRequests = new Set((config.hiddenRequests || []).map(String));

const mods = audit.mods.filter((mod) => !hiddenMods.has(String(mod.id)));
const visibleRequests = (requests.requests || [])
  .filter((request) => !request.hidden)
  .filter(
    (request) =>
      !hiddenRequests.has(String(request.id)) && !hiddenRequests.has(String(request.issue))
  );
const staleItems = (staleness.items || []).filter((item) => !hiddenMods.has(String(item.id)));

const exists = (relative) => fs.existsSync(path.join(OUT, relative));
const read = (relative) => fs.readFileSync(path.join(OUT, relative), "utf8");

const index = exists("index.html") ? read("index.html") : "";
if (!index.trim()) problems.push("index.html is missing or empty");

const rowCount = (index.match(/<tr data-name=/g) || []).length;
if (rowCount !== mods.length) {
  problems.push(`index has ${rowCount} ledger rows, expected ${mods.length}`);
}

const modPageCount = exists("mods")
  ? fs.readdirSync(path.join(OUT, "mods")).filter((name) => name.endsWith(".html")).length
  : 0;
if (modPageCount !== mods.length) {
  problems.push(`mods/ has ${modPageCount} pages, expected ${mods.length}`);
}

for (const mod of mods) {
  if (!exists(path.join("mods", `${mod.id}.html`))) {
    problems.push(`missing mod page for ${mod.id}`);
  }
}
for (const id of hiddenMods) {
  if (exists(path.join("mods", `${id}.html`))) {
    problems.push(`hidden mod ${id} still has a generated page`);
  }
}

for (const required of [
  "method.html",
  "requests.html",
  "404.html",
  "sitemap.xml",
  "robots.txt",
  path.join("assets", "style.css"),
  path.join("assets", "app.js"),
  path.join("assets", "favicon.svg"),
]) {
  if (!exists(required)) problems.push(`missing ${required}`);
}

const allPages = [
  path.join(OUT, "index.html"),
  path.join(OUT, "method.html"),
  path.join(OUT, "requests.html"),
]
  .concat(mods.map((mod) => path.join(OUT, "mods", `${mod.id}.html`)))
  .filter((file) => fs.existsSync(file));

const leakPattern = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]|\bw4ua\b|REA For malwares)/i;
for (const file of allPages) {
  const html = fs.readFileSync(file, "utf8");
  if (leakPattern.test(html)) {
    problems.push(`local path leak in ${path.relative(OUT, file)}`);
    break;
  }
}

const requestsHtml = exists("requests.html") ? read("requests.html") : "";
if (visibleRequests.length > 0 && !/id="requested"/.test(requestsHtml)) {
  problems.push("requests.html has no requested-mods section despite queued requests");
}
for (const request of visibleRequests) {
  if (request.id && !requestsHtml.includes(String(request.id))) {
    problems.push(`requests.html does not mention request ${request.id}`);
  }
}
if (visibleRequests.length === 0 && /id="requested"/.test(requestsHtml)) {
  problems.push("requests.html renders an empty requested-mods section");
}

if (staleItems.length > 0 && !/note-callout--watch/.test(index)) {
  problems.push("index.html is missing the update-watch banner despite stale builds");
}
if (staleItems.length === 0 && /note-callout--watch/.test(index)) {
  problems.push("index.html shows an update-watch banner with no stale builds");
}

const sitemap = exists("sitemap.xml") ? read("sitemap.xml") : "";
const locCount = (sitemap.match(/<loc>/g) || []).length;
if (locCount !== mods.length + 3) {
  problems.push(`sitemap has ${locCount} entries, expected ${mods.length + 3}`);
}

if (!/Sitemap: https?:\/\//.test(exists("robots.txt") ? read("robots.txt") : "")) {
  problems.push("robots.txt has no sitemap URL");
}

notes.push(`${allPages.length} HTML pages checked`);
notes.push(`${mods.length} ledger rows, ${modPageCount} mod pages`);
notes.push(
  `${visibleRequests.length} queued request(s), ${staleItems.length} stale build(s), ${hiddenMods.size} hidden mod(s)`
);

for (const note of notes) console.log(note);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

console.log("All checks passed.");

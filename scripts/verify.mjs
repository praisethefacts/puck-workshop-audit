import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".");
const data = JSON.parse(await readFile(path.resolve("../puck-audit-site/data/site.json"), "utf8"));
const problems = [];
const pages = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".netlify" || entry.name === "node_modules" || entry.name === "scripts") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".html")) pages.push(full);
  }
}
await walk(root);

const allGenerated = [];
async function walkAll(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".netlify" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkAll(full);
    else allGenerated.push(full);
  }
}
await walkAll(root);

if (pages.length !== 66) problems.push(`Expected 66 HTML pages, got ${pages.length}`);

for (const file of allGenerated) {
  const rel = path.relative(root, file).replaceAll("\\", "/");
  if (!/\.(html|css|js|mjs|toml|md|svg)$/.test(file)) continue;
  const text = await readFile(file, "utf8");
  if (new RegExp(["w4", "ua"].join(""), "i").test(text)) problems.push(`${rel}: contains local username`);
  if (/C:\\Users|C:\\Program Files/i.test(text)) problems.push(`${rel}: contains absolute Windows path`);
  if (/\{\{[^}\n]+\}\}/.test(text)) problems.push(`${rel}: contains unresolved template placeholder`);
}

const byId = new Map(data.mods.map((m) => [m.id, m]));
for (const mod of data.mods) {
  const rel = `mods/${mod.id}.html`;
  const file = path.join(root, rel);
  let html;
  try { html = await readFile(file, "utf8"); } catch { problems.push(`${rel}: missing`); continue; }
  if (!html.includes('class="report" id="report"')) problems.push(`${rel}: missing report body`);
  if (!html.includes(`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}`)) problems.push(`${rel}: no Workshop link`);
  if (html.includes("undefined")) problems.push(`${rel}: contains literal undefined`);
  if (!/class="prose"[\s\S]{500,}<\/div>/.test(html)) problems.push(`${rel}: report body looks empty`);
  if (!new RegExp(`Audit report`, "i").test(html) && !html.includes(mod.name.slice(0, 12))) problems.push(`${rel}: no readable report identity`);
}

const index = await readFile(path.join(root, "index.html"), "utf8");
const indexRows = (index.match(/<tr data-name=/g) || []).length;
if (indexRows !== 63) problems.push(`index: expected 63 mod rows, found ${indexRows}`);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
for (const mod of data.mods) {
  if (!index.includes(`mods/${mod.id}.html`)) problems.push(`index: missing link for ${mod.id}`);
  if (!index.includes(esc(mod.name))) problems.push(`index: missing name for ${mod.id}`);
}

const shells = new Map();
for (const file of pages) {
  const rel = path.relative(root, file).replaceAll("\\", "/");
  const html = await readFile(file, "utf8");
  if (!/^<!doctype html>/i.test(html.trimStart())) problems.push(`${rel}: no doctype`);
  if (!/<html lang="en">/.test(html)) problems.push(`${rel}: no lang`);
  if (!/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html)) problems.push(`${rel}: no viewport`);
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (!title || !title[1].trim()) problems.push(`${rel}: no title`);
  const h1s = (html.match(/<h1\b/g) || []).length;
  if (h1s !== 1) problems.push(`${rel}: expected 1 h1, found ${h1s}`);
  if (!/<main\b/.test(html)) problems.push(`${rel}: no main`);
  if (!/<nav\b/.test(html)) problems.push(`${rel}: no nav`);
  shells.set(rel, html);

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    if (href === "/api/request" || href === "/api/requests") continue;
    const clean = href.split("#")[0].split("?")[0];
    if (!clean) continue;
    const target = clean.startsWith("/") ? path.join(root, clean) : path.resolve(path.dirname(file), clean);
    try {
      const info = await stat(target);
      if (info.isDirectory()) await stat(path.join(target, "index.html"));
    } catch {
      problems.push(`${rel}: broken link ${href}`);
    }
  }
}

if (!index.includes("<caption")) problems.push("index: table has no caption");
if (!index.includes('scope="col"')) problems.push("index: table headers have no scope");
if (!index.includes('class="skip-link"')) problems.push("index: no skip link");

const method = shells.get("method.html") || "";
if (!method.includes('class="toc toc--doc"')) problems.push("method: no TOC");
if (!method.includes("How this audit was done")) problems.push("method: missing method prose");

const requests = shells.get("requests.html") || "";
if (!requests.includes('id="request-form"')) problems.push("requests: no form");
if (!requests.includes("https://github.com/praisethefacts/puck-workshop-audit/issues")) problems.push("requests: no fallback link");
if (!requests.includes('aria-live="polite"')) problems.push("requests: no live status");

const long = data.mods.reduce((a, b) => (b.report.length > a.report.length ? b : a));
const short = data.mods.reduce((a, b) => (b.report.length < a.report.length ? b : a));
console.log(`Pages: ${pages.length}`);
console.log(`Index rows: ${indexRows}`);
console.log(`Mod pages: ${data.mods.length}`);
console.log(`Longest report: ${long.name} (${long.report.length} chars)`);
console.log(`Shortest report: ${short.name} (${short.report.length} chars)`);
console.log(`Index bytes: ${Buffer.byteLength(index)}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n- ${problems.join("\n- ")}` : "All checks passed.");
if (problems.length) process.exitCode = 1;

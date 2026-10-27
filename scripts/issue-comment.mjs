#!/usr/bin/env node
/**
 * Build the GitHub issue comment for a finished automated triage run.
 *
 * Env: AUDIT_ID (required), SITE_URL (optional)
 * Writes markdown to the path in argv[2] (default /tmp/comment.md).
 */
import fs from "node:fs";

const ROOT = process.cwd();
const argId = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "";
const id = String(process.env.AUDIT_ID || argId || "").trim();
const site = String(process.env.SITE_URL || "https://praisethefacts.github.io/puck-workshop-audit").replace(/\/+$/, "");
const outFile = process.argv[3] || "/tmp/comment.md";

if (!id) {
  console.error("AUDIT_ID is required");
  process.exit(1);
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
};

const findEntry = (dirName, legacyName) => {
  const own = readJson(`${ROOT}/data/${dirName}/${id}.json`, null);
  if (own) return own;
  const legacy = readJson(`${ROOT}/data/${legacyName}`, []);
  return (Array.isArray(legacy) ? legacy : []).find((entry) => String(entry.id) === id) || null;
};

const run = findEntry("runs", "audit-runs.json") || {};
const report = findEntry("reports", "reports.json");

const lines = [];
if (report) {
  lines.push(`Automated triage finished: **${report.verdict}** (automated score ${report.score}/100).`);
  lines.push("");
  lines.push(`- Report: ${site}/reports/${report.id}.html`);
  lines.push(`- Files hashed: ${report.fileCount} (${report.codeFiles} code files), indicators: ${report.indicatorCount}`);
  lines.push("");
  lines.push("This is a machine scan of the published files, not a manual audit. A clean automated result is not a safety guarantee; the report lists its own limits.");
} else {
  lines.push(`Automated triage could not finish: **${run.note || run.state || "unknown error"}**.`);
  lines.push("");
  lines.push("The request stays queued and nothing was published from this attempt.");
}

fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
console.log(fs.readFileSync(outFile, "utf8"));

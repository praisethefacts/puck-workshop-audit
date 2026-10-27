// Automated triage runner for a requested Workshop item.
// Steps: metadata -> download -> scan -> report -> publish.
// Every step is committed (and optionally deployed) so the site shows live progress.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeDirectory, toMarkdown } from "./lib/triage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
// One file per run and per report: concurrent runs never edit the same file, so
// their commits cannot conflict while the site shows several of them at once.
const RUNS_DIR = path.join(DATA, "runs");
const REPORT_META_DIR = path.join(DATA, "reports");
const APP_ID = "2994020";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const flag = (name) => process.argv.includes(`--${name}`);

const id = String(arg("id", "") || "").trim();
if (!/^\d{6,20}$/.test(id)) {
  console.error("usage: node scripts/audit-mod.mjs --id <workshopId> [--issue 123] [--dir <path>] [--no-commit] [--no-deploy]");
  process.exit(2);
}
const issue = arg("issue", null);
const localDir = arg("dir", null);
const maxBytes = Number(arg("max-bytes", 600 * 1024 * 1024));
const commit = !flag("no-commit");
const deploy = !flag("no-deploy");
const RUN_FILE = path.join(RUNS_DIR, `${id}.json`);
const REPORT_META_FILE = path.join(REPORT_META_DIR, `${id}.json`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: opts.stdio || "pipe", env: process.env, ...opts });
}

const existing = readJson(RUN_FILE, null);
const manualAudit = readJson(path.join(DATA, "audit.json"), { mods: [] });
const hasManual = (manualAudit.mods || []).some((m) => String(m.id) === id);

const STEP_DEFS = [
  { key: "metadata", label: "Reading Workshop metadata" },
  { key: "download", label: "Downloading the published files" },
  { key: "scan", label: "Hashing files and scanning binaries" },
  { key: "report", label: "Writing the triage report" },
  { key: "publish", label: "Publishing to the site" },
];

const now = () => new Date().toISOString();
const run = existing || {
  id,
  issue: issue ? Number(issue) : null,
  title: null,
  state: "queued",
  startedAt: now(),
  updatedAt: now(),
  step: "queued",
  stepIndex: 0,
  steps: STEP_DEFS.map((s) => ({ ...s, state: "pending" })),
  report: null,
  note: null,
};
if (issue && !run.issue) run.issue = Number(issue);
run.updatedAt = now();
if (hasManual) {
  run.state = "skipped";
  run.note = "A manual audit already exists for this mod, so the automated run was skipped.";
  run.steps = STEP_DEFS.map((s) => ({ ...s, state: "skipped" }));
}

function persist({ message } = {}) {
  writeJson(RUN_FILE, run);
  if (!commit) return;
  try {
    if (deploy) sh("node", ["scripts/build.mjs"], { stdio: "inherit" });
    sh("git", ["add", "data", "reports"]);    if (!sh("git", ["status", "--porcelain"]).trim()) return;
    sh("git", ["commit", "-m", message || `audit: ${id} progress`]);
    push();
    if (deploy) deployNow();
  } catch (err) {
    console.warn("commit/deploy failed:", err.message);
  }
}

function push() {
  if (!process.env.GITHUB_ACTIONS) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      sh("git", ["push", "origin", "HEAD:main"]);
      return;
    } catch (err) {
      // Another run committed first: rebase and retry so both survive.
      try {
        sh("git", ["pull", "--rebase", "--autostash", "origin", "main"]);
      } catch (rebaseError) {
        console.warn("push retry failed:", rebaseError.message);
      }
      if (attempt === 3) throw err;
    }
  }
}

function deployNow() {
  if (!process.env.NETLIFY_AUTH_TOKEN || !process.env.NETLIFY_SITE_ID) return;
  try {
    if (process.env.NETLIFY_CLI) {
      sh(process.env.NETLIFY_CLI, ["deploy", "--prod", "--dir", "dist", "--message", `audit ${id}`], { stdio: "inherit" });
    } else {
      sh("npx", ["--yes", "netlify-cli@23", "deploy", "--prod", "--dir", "dist", "--message", `audit ${id}`], { stdio: "inherit" });
    }
  } catch (err) {
    console.warn("deploy failed:", err.message);
  }
}

function step(key, state, extra = {}) {
  const i = STEP_DEFS.findIndex((s) => s.key === key);
  run.stepIndex = i;
  run.step = key;
  run.steps[i] = { ...run.steps[i], ...extra, state, at: state === "running" ? now() : run.steps[i].at };
  if (state === "done" || state === "failed") {
    run.steps[i].at = run.steps[i].at || now();
    run.steps[i].finishedAt = now();
  }
  run.updatedAt = now();
}

async function steamMeta() {
  const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `itemcount=1&publishedfileids[0]=${id}`,
  });
  if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
  const json = await res.json();
  const d = (json.response?.publishedfiledetails || [])[0];
  if (!d || Number(d.result) !== 1) throw new Error(`Steam API result ${d ? d.result : "none"}`);
  return {
    id,
    title: d.title,
    creator: d.creator,
    result: d.result,
    banned: d.banned,
    visibility: d.visibility,
    fileSize: Number(d.file_size) || 0,
    timeCreated: d.time_created,
    timeUpdated: d.time_updated,
    timeCreatedHuman: d.time_created ? new Date(d.time_created * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
    timeUpdatedHuman: d.time_updated ? new Date(d.time_updated * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
    description: (d.description || "").slice(0, 400),
    previewUrl: d.preview_url || "",
  };
}

function findSteamCmd() {
  const candidates = [
    process.env.STEAMCMD,
    path.join(os.homedir(), "steamcmd", "steamcmd.sh"),
    "/usr/games/steamcmd",
    "/usr/bin/steamcmd",
    "C:/Users/w4ua/Documents/Code/_steamcmd/steamcmd.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return sh("which", ["steamcmd"]).trim(); } catch { return null; }
}

function download() {
  if (localDir) return path.resolve(localDir);
  const cmd = findSteamCmd();
  if (!cmd) throw new Error("steamcmd not found (set STEAMCMD)");
  const installDir = path.join(os.tmpdir(), "audit-steamcmd");
  fs.mkdirSync(installDir, { recursive: true });
  sh(cmd, ["+force_install_dir", installDir, "+login", "anonymous", "+workshop_download_item", APP_ID, id, "+quit"], { timeout: 15 * 60 * 1000 });
  const dir = path.join(installDir, "steamapps", "workshop", "content", APP_ID, id);
  if (!fs.existsSync(dir)) throw new Error("steamcmd reported success but the item folder is missing");
  return dir;
}

function dirSize(dir) {
  let total = 0;
  for (const f of analyzeDirFiles(dir)) total += fs.statSync(f).size;
  return total;
}
function analyzeDirFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function main() {
  if (hasManual) {
    run.state = "skipped";
    persist({ message: `audit: ${id} skipped (manual audit exists)` });
    console.log(`Skipped: a manual audit for ${id} already exists.`);
    return;
  }

  run.state = "running";
  step("metadata", "running");
  persist({ message: `audit: ${id} started` });

  let meta;
  try {
    meta = await steamMeta();
  } catch (err) {
    meta = {
      id, title: `Workshop item ${id}`, creator: null, result: null, banned: null,
      fileSize: 0, timeCreatedHuman: "", timeUpdatedHuman: "",
      description: "", previewUrl: "",
    };
    run.note = `Steam metadata unavailable (${err.message}); the files were analysed as published.`;
  }
  run.title = meta.title;
  step("metadata", meta.result === null ? "done" : "done", { detail: `${meta.title}${meta.fileSize ? " · " + meta.fileSize + " B reported" : ""}${run.note ? " · metadata unavailable" : ""}` });
  persist({ message: `audit: ${id} metadata` });

  step("download", "running");
  persist();
  if (meta.fileSize > maxBytes) throw new Error(`item is ${meta.fileSize} B, above the ${maxBytes} B download cap`);
  let dir;
  try {
    dir = download();
  } catch (err) {
    step("download", "failed", { detail: err.message });
    run.state = "blocked";
    run.note = `Could not obtain the files: ${err.message}`;
    persist({ message: `audit: ${id} download blocked` });
    console.log(`Blocked: ${run.note}`);
    return;
  }
  const size = dirSize(dir);
  step("download", "done", { detail: `${size} B on disk` });
  // The files are here, so a leftover "could not obtain" note from an earlier
  // attempt no longer applies.
  if (run.note && /could not obtain/i.test(run.note)) run.note = null;
  persist({ message: `audit: ${id} downloaded` });

  step("scan", "running");
  persist();
  const report = analyzeDirectory(dir, meta);
  step("scan", "done", { detail: `${report.files} files, ${report.codeFiles} code files, ${report.findings.length} indicators` });
  persist({ message: `audit: ${id} scanned` });

  step("report", "running");
  fs.mkdirSync(REPORTS, { recursive: true });
  const md = toMarkdown(report);
  fs.writeFileSync(path.join(REPORTS, `${id}.md`), md, "utf8");
  const summary = {
    id,
    issue: run.issue,
    title: meta.title,
    creator: meta.creator,
    verdict: report.verdict,
    score: report.score,
    automated: true,
    generatedAt: report.generatedAt,
    reportPath: `reports/${id}.md`,
    fileCount: report.files,
    bytes: report.bytes,
    codeFiles: report.codeFiles,
    indicatorCount: report.findings.length,
    topIndicators: report.findings.slice(0, 6).map((f) => f.label),
    programs: report.binaries
      .filter((b) => b.decompile && b.decompile.available)
      .slice(0, 6)
      .map((b) => ({
        file: b.path,
        typeCount: b.decompile.typeCount,
        methodCount: b.decompile.methodCount,
        sourceLines: b.decompile.sourceLines,
        apiHits: b.decompile.apiHits,
        types: b.decompile.types.slice(0, 40),
        excerpt: b.decompile.excerpt.slice(0, 6000),
      })),
    workshopUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
  };
  writeJson(REPORT_META_FILE, summary);
  run.report = summary;
  step("report", "done", { detail: `${report.verdict} (${report.score}/100)` });
  persist({ message: `audit: ${id} report` });

  step("publish", "running");
  persist();
  run.state = "done";
  step("publish", "done", { detail: "Report live on the site" });
  persist({ message: `audit: ${id} published` });

  console.log(JSON.stringify({ id, verdict: report.verdict, score: report.score, findings: report.findings.length }, null, 2));
}

main().catch((err) => {
  run.state = "failed";
  run.note = err.message;
  const i = STEP_DEFS.findIndex((s) => s.key === run.step);
  if (i !== -1) run.steps[i] = { ...run.steps[i], state: "failed", detail: err.message, finishedAt: now() };
  run.updatedAt = now();
  persist({ message: `audit: ${id} failed` });
  console.error("audit failed:", err.message);
  process.exit(1);
});

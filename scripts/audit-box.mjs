#!/usr/bin/env node
// Run one Workshop mod through the full local audit - the same shape as the
// hand audits on the operator's PC:
//
//   audit-out/<id>_<slug>/
//     REPORT.md
//     evidence/  inventory.tsv, hashes_sha256.txt, pe_info.txt, scan_hits.tsv,
//                api_surface.txt, FACTS.md
//     sources/   decompiled C# (ILSpy project export)
//
// Usage:
//   node scripts/audit-box.mjs --id 3776968217
//   node scripts/audit-box.mjs --id 3776968217 --dir /path/to/mod --out audit-out
//
// Needs: node 20+, ilspycmd (dotnet tool install -g ilspycmd) for decompilation,
// steamcmd for downloading (skipped when --dir points at files already on disk).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyzeDirectory, toMarkdown } from "./lib/triage.mjs";

const APP_ID = "2994020";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const id = String(arg("id") || "").trim();
if (!/^\d{6,12}$/.test(id)) {
  console.error("usage: node scripts/audit-box.mjs --id <workshopId> [--dir <folder>] [--out <dir>] [--no-sources]");
  process.exit(2);
}
const outRoot = path.resolve(String(arg("out") || "audit-out"));
const localDir = arg("dir") ? String(arg("dir")) : null;
const withSources = !flag("no-sources");
const ilspycmd = process.env.ILSPYCMD || "ilspycmd";

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

async function steamMeta() {
  try {
    const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `itemcount=1&publishedfileids[0]=${id}`,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = (json.response?.publishedfiledetails || [])[0];
    if (!d || Number(d.result) !== 1) throw new Error(`Steam API result ${d ? d.result : "none"}`);
    return {
      id,
      title: d.title,
      creator: d.creator,
      result: d.result,
      banned: d.banned,
      fileSize: Number(d.file_size) || 0,
      timeCreatedHuman: d.time_created ? new Date(d.time_created * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
      timeUpdatedHuman: d.time_updated ? new Date(d.time_updated * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
    };
  } catch (err) {
    console.warn(`Steam metadata unavailable (${err.message}); continuing with the files.`);
    return { id };
  }
}

function findSteamCmd() {
  const candidates = [
    process.env.STEAMCMD,
    path.join(os.homedir(), "steamcmd", "steamcmd.sh"),
    "/usr/games/steamcmd",
    "/usr/bin/steamcmd",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return sh("which", ["steamcmd"]).trim(); } catch { return null; }
}

function runSteamCmd(cmd, args) {
  // steamcmd exits 0 even when it fails, so keep the output to explain failures.
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20 * 60 * 1000 });
    return out;
  } catch (err) {
    return `${err.stdout || ""}${err.stderr || ""}\n${err.message}`;
  }
}

function findDownloaded(installDir) {
  const candidates = [
    path.join(installDir, "steamapps", "workshop", "content", APP_ID, id),
    path.join(os.homedir(), ".steam", "steam", "steamapps", "workshop", "content", APP_ID, id),
    path.join(os.homedir(), "Steam", "steamapps", "workshop", "content", APP_ID, id),
    path.join(os.homedir(), ".local", "share", "Steam", "steamapps", "workshop", "content", APP_ID, id),
    path.join("C:", "Program Files (x86)", "Steam", "steamapps", "workshop", "content", APP_ID, id),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function download() {
  if (localDir) return path.resolve(localDir);
  const cmd = findSteamCmd();
  if (!cmd) throw new Error("steamcmd not found - run scripts/install-audit-tools.sh or pass --dir");
  const installDir = path.join(os.tmpdir(), "audit-steamcmd");
  fs.mkdirSync(installDir, { recursive: true });
  console.log(`Downloading ${id} with steamcmd (${cmd})...`);
  const out = runSteamCmd(cmd, ["+force_install_dir", installDir, "+login", "anonymous", "+workshop_download_item", APP_ID, id, "+quit"]);
  const dir = findDownloaded(installDir);
  if (!dir) {
    console.error("steamcmd output:");
    console.error(out.split("\n").slice(-25).join("\n"));
    throw new Error(`the item folder is missing after steamcmd (searched ${installDir} and the usual Steam roots)`);
  }
  console.log(`Downloaded ${dir}`);
  return dir;
}

function slug(text) {
  return String(text || "mod").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "mod";
}

function writeEvidence(dir, report, meta) {
  fs.mkdirSync(dir, { recursive: true });
  const inv = report.inventory || [];
  fs.writeFileSync(
    path.join(dir, "inventory.tsv"),
    "path\tbytes\tsha256\text\n" + inv.map((f) => [f.path, f.size, f.sha256, path.extname(f.path).replace(/^\./, "").toLowerCase()].join("\t")).join("\n") + "\n"
  );
  fs.writeFileSync(path.join(dir, "hashes_sha256.txt"), inv.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n");

  const peLines = [];
  for (const b of report.binaries) {
    if (!b.pe) continue;
    peLines.push(`${b.path}\t${b.size} B\tsha256 ${b.sha256}`);
    peLines.push(`  kind: PE${b.pe.bitness}${b.pe.dotnet ? " .NET" : " native"}; sections: ${b.pe.sections.length}; overlay: ${b.pe.overlay} B`);
    for (const s of b.pe.sections) {
      peLines.push(`  section ${s.name}: raw ${s.rawSize} B, entropy ${s.entropy}${s.executable ? ", executable" : ""}${s.writable ? ", writable" : ""}`);
    }
    if (b.obfuscation) peLines.push(`  obfuscation signals: ${b.obfuscation.escapes} escaped literals, ${b.obfuscation.junk} renamed identifiers over ${b.obfuscation.lines} decompiled lines`);
    if (b.decompile?.available) peLines.push(`  ILSpy: ${b.decompile.typeCount} types, ${b.decompile.methodCount} methods, ${b.decompile.sourceLines} lines`);
    peLines.push("");
  }
  fs.writeFileSync(path.join(dir, "pe_info.txt"), (peLines.join("\n") || "no PE files\n") + "\n");

  const hits = [];
  for (const f of report.findings || []) {
    for (const sample of f.samples || []) {
      hits.push([f.id, f.severity, f.file, f.label, String(sample).replace(/\s+/g, " ").slice(0, 200)].join("\t"));
    }
    if (!f.samples || !f.samples.length) hits.push([f.id, f.severity, f.file, f.label, ""].join("\t"));
  }
  fs.writeFileSync(path.join(dir, "scan_hits.tsv"), "indicator\tseverity\tfile\tlabel\tsample\n" + hits.join("\n") + (hits.length ? "\n" : ""));

  const apiLines = [];
  for (const t of report.techniques || []) apiLines.push(`${t.group}\t${t.text}`);
  for (const b of report.binaries) {
    for (const hit of b.decompile?.apiHits || []) apiLines.push(`ilspy-api\t${b.path}\t${hit}`);
  }
  fs.writeFileSync(path.join(dir, "api_surface.txt"), apiLines.join("\n") + (apiLines.length ? "\n" : ""));

  const facts = [];
  facts.push(`# ${meta.title || "Workshop item " + id} (${id}) - automated audit facts`);
  facts.push("");
  facts.push(`- Verdict: **${report.verdict}**, automated score **${report.score}/100**`);
  facts.push(`- Files: ${report.files}, bytes: ${report.bytes}, code files analysed: ${report.codeFiles}`);
  facts.push(`- Steam metadata: ${meta.title ? `${meta.title} / creator ${meta.creator || "?"} / created ${meta.timeCreatedHuman || "?"} / updated ${meta.timeUpdatedHuman || "?"}` : "unavailable"}`);
  facts.push(`- Generated: ${report.generatedAt} in ${report.analysisMs} ms`);
  const managed = report.binaries.filter((b) => b.pe && b.pe.dotnet);
  const native = report.binaries.filter((b) => b.pe && !b.pe.dotnet);
  facts.push(`- Binaries: ${managed.length} managed .NET, ${native.length} native, ${report.binaries.length - managed.length - native.length} script/text`);
  if (report.endpoints?.length) {
    facts.push(`- Endpoints (${report.endpoints.length}):`);
    for (const e of report.endpoints) facts.push(`  - ${e.url}${e.plain ? " [http]" : ""}${e.rawIp ? " [raw IP]" : ""}`);
  } else {
    facts.push("- Endpoints: none readable");
  }
  if (report.capabilities?.length) {
    facts.push("- Capabilities:");
    for (const c of report.capabilities) facts.push(`  - ${c.label}: weight ${c.weight + c.bump}, evidence ${c.ids.join(", ")}`);
  }
  if (report.notableStrings?.length) {
    facts.push("- Notable strings:");
    for (const s of report.notableStrings) facts.push(`  - ${s}`);
  }
  fs.writeFileSync(path.join(dir, "FACTS.md"), facts.join("\n") + "\n");
}

function exportSources(modDir, sourcesDir, report) {
  fs.mkdirSync(sourcesDir, { recursive: true });
  const managed = report.binaries.filter((b) => b.pe && b.pe.dotnet);
  if (!managed.length) {
    fs.writeFileSync(path.join(sourcesDir, "README.txt"), "No managed .NET assemblies in this item.\n");
    return;
  }
  try {
    sh(ilspycmd, ["-p", "-o", sourcesDir, ...managed.map((b) => path.join(modDir, b.path))], { timeout: 30 * 60 * 1000 });
    console.log(`Decompiled sources -> ${sourcesDir}`);
  } catch (err) {
    fs.writeFileSync(path.join(sourcesDir, "EXPORT-FAILED.txt"), `ilspycmd project export failed: ${err.message}\n`);
    console.warn("Source export failed; per-file decompiled text is still in the evidence summary and the site report.");
  }
}

async function main() {
  const meta = await steamMeta();
  const modDir = download();
  const folderName = `${id}_${slug(meta.title)}`;
  const target = path.join(outRoot, folderName);
  fs.mkdirSync(target, { recursive: true });

  console.log(`Analysing ${modDir}`);
  const report = analyzeDirectory(modDir, meta, { decompile: true });
  writeEvidence(path.join(target, "evidence"), report, meta);
  if (withSources) exportSources(modDir, path.join(target, "sources"), report);

  const body = toMarkdown(report);
  fs.writeFileSync(path.join(target, "REPORT.md"), body);
  fs.writeFileSync(path.join(target, "report.json"), JSON.stringify({ meta: report.meta, verdict: report.verdict, score: report.score, generatedAt: report.generatedAt, capabilities: report.capabilities, endpoints: report.endpoints, techniques: report.techniques, notableStrings: report.notableStrings }, null, 2) + "\n");

  console.log("");
  console.log(`${meta.title || "item " + id}: ${report.verdict} (${report.score}/100)`);
  console.log(`  files ${report.files}, code ${report.codeFiles}, endpoints ${report.endpoints?.length || 0}`);
  console.log(`  ${target}`);
  console.log("  REPORT.md, report.json, evidence/ (inventory, hashes, pe_info, scan_hits, api_surface, FACTS), sources/");
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

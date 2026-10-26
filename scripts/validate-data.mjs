import fs from "node:fs";
import path from "node:path";

// Schema sanity for the committed data files. The build is tolerant, but a broken
// data file silently degrades the site, so CI rejects malformed input early.

const DATA = path.resolve(process.argv[2] || "data");
const problems = [];
const readJson = (name) => {
  const file = path.join(DATA, name);
  if (!fs.existsSync(file)) {
    problems.push(`missing ${name}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    problems.push(`${name} is not valid JSON: ${error.message}`);
    return null;
  }
};

const audit = readJson("audit.json");
if (audit) {
  if (!Array.isArray(audit.mods) || !audit.mods.length) problems.push("audit.mods must be a non-empty array");
  else {
    const ids = new Set();
    for (const mod of audit.mods) {
      if (!mod || typeof mod !== "object") {
        problems.push("audit.mods contains a non-object entry");
        continue;
      }
      if (!/^\d{6,12}$/.test(String(mod.id || ""))) problems.push(`audit.mods entry has a bad id: ${mod.id}`);
      if (ids.has(String(mod.id))) problems.push(`duplicate mod id: ${mod.id}`);
      ids.add(String(mod.id));
      if (!String(mod.name || "").trim()) problems.push(`mod ${mod.id} has no name`);
      // Code-bearing mods link to REPORT.md; asset-only mods inline their short
      // report markdown directly in the data file.
      const report = String(mod.report || "");
      const inlineReport = report.trimStart().startsWith("#") && report.length > 200;
      if (!report.includes("REPORT.md") && !inlineReport) problems.push(`mod ${mod.id} has no report`);
      if (!Number.isFinite(Number(mod.score))) problems.push(`mod ${mod.id} has no numeric score`);
      if (!String(mod.verdict || "").trim()) problems.push(`mod ${mod.id} has no verdict`);
    }
    if (!audit.stats || !Number.isFinite(Number(audit.stats.total))) problems.push("audit.stats.total missing");
    for (const key of ["findings", "reaudits"]) {
      if (audit[key] && !Array.isArray(audit[key])) problems.push(`audit.${key} must be an array`);
    }
  }
}

const requests = readJson("requests.json");
if (requests) {
  if (!Array.isArray(requests.requests)) problems.push("requests.requests must be an array");
  else {
    for (const request of requests.requests) {
      if (!/^\d{6,12}$/.test(String(request.id || ""))) problems.push(`request has a bad id: ${request.id}`);
      if (!["pending", "audited", "needs-reaudit", "closed", "duplicate"].includes(request.status)) {
        problems.push(`request ${request.id} has an unknown status: ${request.status}`);
      }
    }
  }
}

const config = readJson("site-config.json");
if (config) {
  for (const key of ["hiddenMods", "hiddenRequests", "hiddenReaudits"]) {
    if (!Array.isArray(config[key])) problems.push(`site-config.${key} must be an array`);
  }
  if (audit && Array.isArray(config.hiddenMods) && Array.isArray(audit.mods)) {
    const known = new Set(audit.mods.map((mod) => String(mod.id)));
    for (const id of config.hiddenMods) if (!known.has(String(id))) problems.push(`site-config hides unknown mod ${id}`);
  }
}

const staleness = readJson("staleness.json");
if (staleness && !Array.isArray(staleness.items)) problems.push("staleness.items must be an array");

if (problems.length) {
  console.error(`${problems.length} data problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(
  `data ok: ${audit.mods.length} mods, ${requests.requests.length} requests, ` +
    `${config.hiddenMods.length} hidden mods, ${staleness.items.length} watched builds.`
);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = path.join(ROOT, "scripts", "theme");
const DATA_DIR = path.join(ROOT, "data");

function cliArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

// Build output goes to dist/ by default so generated pages never mix with sources.
const OUT = path.resolve(ROOT, cliArg("out") || "dist");
const OUT_MODS = path.join(OUT, "mods");
const OUT_ASSETS = path.join(OUT, "assets");

const GITHUB_REPO = "praisethefacts/puck-workshop-audit";
const GITHUB_ISSUES = `https://github.com/${GITHUB_REPO}/issues`;
const WORKSHOP = "https://steamcommunity.com/sharedfiles/filedetails/?id=";

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Could not parse ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function findData() {
  const explicit = cliArg("data");
  const candidates = [
    explicit && path.resolve(explicit),
    process.env.SITE_DATA,
    path.join(DATA_DIR, "audit.json"),
    path.join(DATA_DIR, "site.json"),
    path.resolve(ROOT, "..", "puck-audit-site", "data", "site.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  console.error(
    "Could not find audit JSON. Pass --data <file>, set SITE_DATA, or place it at data/audit.json."
  );
  process.exit(1);
}

const dataPath = findData();
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

if (!Array.isArray(data.mods) || data.mods.length === 0) {
  console.error("The audit JSON has no mods array.");
  process.exit(1);
}

const auditIds = new Set();
for (const mod of data.mods) {
  if (!mod || !mod.id || !mod.name || !String(mod.report || "").trim()) {
    console.error(`The audit JSON has an incomplete mod record: ${mod?.id || "(no id)"}`);
    process.exit(1);
  }
  if (auditIds.has(String(mod.id))) {
    console.error(`Duplicate mod id in the audit JSON: ${mod.id}`);
    process.exit(1);
  }
  auditIds.add(String(mod.id));
}

/* -------------------------------------------------------------------------- */
/* Site control files                                                         */
/* -------------------------------------------------------------------------- */

// data/site-config.json  -> { hiddenMods: [], hiddenRequests: [], hiddenReaudits: [] }
// data/requests.json    -> { requests: [{ id, title, status, issue, requestedAt, updatedAt, note }] }
// data/staleness.json   -> { items: [{ id, name, auditedAt, workshopUpdated }] }
const siteConfig = readJson(path.join(DATA_DIR, "site-config.json"), {});
const requestsData = readJson(path.join(DATA_DIR, "requests.json"), { requests: [] });
const stalenessData = readJson(path.join(DATA_DIR, "staleness.json"), { items: [] });
const auditRuns = readJson(path.join(DATA_DIR, "audit-runs.json"), []);
const autoReports = readJson(path.join(DATA_DIR, "reports.json"), []);

const hiddenMods = new Set((siteConfig.hiddenMods || []).map(String));
const hiddenRequests = new Set((siteConfig.hiddenRequests || []).map(String));
const hiddenReaudits = new Set((siteConfig.hiddenReaudits || []).map(String));

if (hiddenMods.size > 0) {
  const kept = data.mods.filter((mod) => !hiddenMods.has(String(mod.id)));
  const removed = data.mods.length - kept.length;
  console.log(
    `Hidden by data/site-config.json: ${removed} mod${removed === 1 ? "" : "s"} (${[...hiddenMods].join(", ")}).`
  );
  if (kept.length === 0) {
    console.error("Every mod is hidden, refusing to build an empty ledger.");
    process.exit(1);
  }
  data.mods = kept;
}

if (Array.isArray(data.reaudits)) {
  data.reaudits = data.reaudits.filter(
    (entry) => !hiddenReaudits.has(String(entry.mod || "").match(/\b(\d{6,})\b/)?.[1] || "")
  );
}

const pendingRequests = (requestsData.requests || [])
  .filter((request) => !request.hidden)
  .filter((request) => !hiddenRequests.has(String(request.id)) && !hiddenRequests.has(String(request.issue)))
  .sort((a, b) => String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")));

const staleItems = (stalenessData.items || []).filter((item) => !hiddenMods.has(String(item.id)));

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function attr(value) {
  return esc(value).replace(/\n/g, " ");
}

const MACHINE_USER = ["w4", "ua"].join("");

function redact(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(
      /\b[A-Za-z]:\\(?:[^\\\r\n`"'<>|?*]+\\)*[^\\\r\n`"'<>|?*]*/g,
      "[local path]"
    )
    .replace(/\b[A-Za-z]:\/(?:[^/\r\n`"'<>|?*]+\/)*[^/\r\n`"'<>|?*]*/g, "[local path]")
    .replace(/(?:^|[\s("'`])(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"'`)]+/g,
      (match) => match.replace(/(?:[\\/](?:Users|home)[\\/])[^\\/\s"'`)]+/, "/[user]")
    )
    .replace(new RegExp(`\\b${MACHINE_USER}\\b`, "gi"), "[user]");
}

function plainText(markdown) {
  return String(markdown ?? "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(text) {
  const base = plainText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return base || "section";
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function riskBand(score) {
  const n = Number(score) || 0;
  if (n <= 15) return { key: "low", label: "Low", note: "Minimal capability" };
  if (n <= 40) return { key: "moderate", label: "Moderate", note: "Review the caveats" };
  if (n <= 70) return { key: "high", label: "High", note: "Material concern" };
  return { key: "critical", label: "Critical", note: "Immediate attention" };
}

function scoreClass(score) {
  return riskBand(score).key;
}

function verdictCategory(verdict) {
  const value = String(verdict || "").toUpperCase();
  if (value.includes("SUSPICIOUS")) return "suspicious";
  if (value.includes("CAVEAT")) return "caveats";
  if (value.includes("BENIGN")) return "benign";
  if (value.includes("CLEAN")) return "clean";
  return "unknown";
}

function verdictLabel(verdict) {
  const category = verdictCategory(verdict);
  return {
    clean: "Clean",
    benign: "Benign",
    caveats: "With caveats",
    suspicious: "Suspicious",
    unknown: String(verdict || "Unrated"),
  }[category];
}

function kindInfo(kind) {
  const full = String(kind || "Unspecified");
  const asset = /asset-only/i.test(full);
  return {
    asset,
    category: asset ? "asset" : "code",
    label: asset ? "Asset only" : "Code",
    full,
  };
}

function badgeMarkup(verdict, extraClass = "") {
  const category = verdictCategory(verdict);
  return `<span class="badge badge--${category}${extraClass ? ` ${extraClass}` : ""}"><span class="badge-dot" aria-hidden="true"></span>${esc(
    verdictLabel(verdict)
  )}</span>`;
}

function scoreMarkup(score, wide = false) {
  const band = riskBand(score);
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return `<span class="score-cell"><span class="score-number">${value}</span><span class="score-track${
    wide ? " score-track--wide" : ""
  }" aria-hidden="true"><span class="score-fill score-fill--${band.key}" style="--score:${value}"></span></span></span><span class="sr-only"> out of 100, ${band.label.toLowerCase()} risk</span>`;
}

function dateDisplay(iso) {
  const value = String(iso || "");
  if (!value) return "";
  return value.replace(/\.\d+Z$/, "Z").replace("T", " ").replace(/Z$/, " UTC");
}

function timeMarkup(iso) {
  const display = dateDisplay(iso);
  if (!display) return "";
  const machine = /^\d{4}-\d{2}-\d{2}T/.test(String(iso))
    ? String(iso)
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(iso))
      ? `${iso.replace(" ", "T")}:00`
      : String(iso);
  return `<time datetime="${attr(machine)}">${esc(display)}</time>`;
}

/* -------------------------------------------------------------------------- */
/* Markdown renderer                                                          */
/* -------------------------------------------------------------------------- */

const MOD_IDS = new Set(data.mods.map((mod) => String(mod.id)));

function safeHref(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^(#|\.{0,2}\/)/.test(value)) return value;
  return "";
}

function inline(markdown, context = {}) {
  const codes = [];
  const links = [];
  let text = esc(redact(markdown));

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const index = codes.length;
    codes.push(code);
    return `\uE000C${index}\uE001`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const safe = safeHref(href.replace(/&amp;/g, "&"));
    if (!safe) return label;
    const index = links.length;
    const external = /^https?:/i.test(safe);
    links.push(
      `<a href="${attr(safe)}"${external ? ' rel="noopener noreferrer"' : ""}>${label}</a>`
    );
    return `\uE000L${index}\uE001`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s([{"'])\*([^*\n]+?)\*(?=$|[\s)\]}"'.,;:!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s([{"'])_([^_\n]+?)_(?=$|[\s)\]}"'.,;:!?])/g, "$1<em>$2</em>");

  text = text.replace(/\uE000C(\d+)\uE001/g, (_, index) => {
    const code = codes[Number(index)];
    const raw = plainText(code);
    if (
      /^\d{5,20}$/.test(raw) &&
      MOD_IDS.has(raw) &&
      raw !== context.selfId &&
      context.modHref
    ) {
      return `<a class="mod-ref" href="${attr(context.modHref(raw))}"><code>${code}</code></a>`;
    }
    return `<code>${code}</code>`;
  });

  text = text.replace(/\uE000L(\d+)\uE001/g, (_, index) => links[Number(index)]);

  return text;
}

function splitTableRow(line) {
  let value = String(line).trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  return lines[index].includes("|") && isTableSeparator(lines[index + 1]);
}

function isHr(line) {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function listMatch(line) {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, "    ").length,
    ordered: /\d/.test(match[2]),
    text: match[3],
  };
}

function startsBlock(lines, index) {
  const line = lines[index];
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isHr(line) ||
    Boolean(listMatch(line)) ||
    isTableStart(lines, index)
  );
}

function renderList(lines, start, baseIndent, context) {
  const first = listMatch(lines[start]);
  const ordered = first.ordered;
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = start;

  while (index < lines.length) {
    const item = listMatch(lines[index]);
    if (!item || item.indent < baseIndent) break;
    if (item.indent > baseIndent) break;

    let content = item.text;
    let nested = "";
    index += 1;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        let lookahead = index + 1;
        while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
        if (lookahead >= lines.length) {
          index = lookahead;
          break;
        }
        const nextItem = listMatch(lines[lookahead]);
        const indented = /^\s{2,}\S/.test(lines[lookahead]);
        if ((nextItem && nextItem.indent > baseIndent) || (indented && !nextItem)) {
          index = lookahead;
          continue;
        }
        index = lookahead;
        break;
      }

      const nextItem = listMatch(line);
      if (nextItem) {
        if (nextItem.indent > baseIndent) {
          const child = renderList(lines, index, nextItem.indent, context);
          nested += child.html;
          index = child.next;
          continue;
        }
        break;
      }

      if (startsBlock(lines, index)) break;

      if (/^\s+/.test(line)) {
        content += ` ${line.trim()}`;
        index += 1;
        continue;
      }

      // CommonMark lazy continuation of a list item.
      content += ` ${line.trim()}`;
      index += 1;
    }

    items.push(`<li>${inline(content, context)}${nested}</li>`);
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
}

function renderTable(lines, start, context, currentHeading) {
  const headerCells = splitTableRow(lines[start]);
  const separatorCells = splitTableRow(lines[start + 1]);
  const aligns = separatorCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  const rows = [];
  let index = start + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const alignClass = (position) => {
    const align = aligns[position] || "left";
    return align === "right" ? "align-right" : align === "center" ? "align-center" : "";
  };
  const label = currentHeading
    ? `Table in section ${plainText(currentHeading)}`
    : "Report data table";

  const head = headerCells
    .map(
      (cell, cellIndex) =>
        `<th scope="col"${alignClass(cellIndex) ? ` class="${alignClass(cellIndex)}"` : ""}>${inline(
          cell,
          context
        )}</th>`
    )
    .join("");

  const body = rows
    .map((row) => {
      const cells = headerCells.map((_, cellIndex) => {
        const cell = row[cellIndex] || "";
        const className = alignClass(cellIndex);
        return `<td${className ? ` class="${className}"` : ""}>${inline(cell, context)}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");

  return {
    html: `<div class="table-wrap" role="region" aria-label="${attr(
      label
    )}" tabindex="0"><table aria-label="${attr(
      label
    )}"><caption>${esc(label)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index,
  };
}

function renderMarkdown(source, options = {}) {
  const context = {
    selfId: options.selfId,
    modHref: options.modHref,
    ...(options.context || {}),
  };
  const lines = redact(source).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  const headings = [];
  const usedSlugs = new Map();
  let index = 0;
  let skippedH1 = false;
  let currentHeading = "";

  const nextSlug = (text) => {
    const base = slugify(text);
    const seen = usedSlugs.get(base) || 0;
    usedSlugs.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*```\s*([\w.+-]*)\s*$/.exec(line);
    if (fence) {
      const codeLines = [];
      const language = fence[1] || "";
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const languageClass = language
        ? ` class="language-${attr(language.replace(/[^\w.+-]/g, ""))}"`
        : "";
      output.push(
        `<pre tabindex="0"><code${languageClass}>${esc(codeLines.join("\n"))}</code></pre>`
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const rawText = heading[2];
      index += 1;

      if (level === 1 && options.skipFirstH1 && !skippedH1) {
        skippedH1 = true;
        continue;
      }

      const id = nextSlug(rawText);
      currentHeading = rawText;
      if (level <= 3) headings.push({ level, text: plainText(rawText), id });

      const anchor =
        level >= 2
          ? ` <a class="heading-anchor" href="#${attr(id)}" aria-label="Link to ${attr(
              plainText(rawText)
            )}">#</a>`
          : "";
      output.push(
        `<h${level} id="${attr(id)}">${inline(rawText, context)}${anchor}</h${level}>`
      );
      continue;
    }

    if (isHr(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const inner = renderMarkdown(quoted.join("\n"), {
        ...options,
        skipFirstH1: false,
        headings: undefined,
      });
      output.push(`<blockquote>${inner.html}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index, context, currentHeading);
      output.push(table.html);
      index = table.next;
      continue;
    }

    if (listMatch(line)) {
      const list = renderList(lines, index, listMatch(line).indent, context);
      output.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines, index) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${inline(paragraph.join(" "), context)}</p>`);
  }

  return { html: output.join("\n"), headings };
}

/* -------------------------------------------------------------------------- */
/* Page shell                                                                 */
/* -------------------------------------------------------------------------- */

function navItems(prefix) {
  return [
    { key: "home", href: `${prefix}index.html`, label: "Mods" },
    { key: "method", href: `${prefix}method.html`, label: "Method" },
    { key: "requests", href: `${prefix}requests.html`, label: "Requests" },
  ];
}

function pageShell({ title, description, prefix = "", current = "home", main, bodyClass = "", noindex = false }) {
  const nav = navItems(prefix)
    .map(
      (item) =>
        `<a href="${item.href}"${
          item.key === current ? ' aria-current="page"' : ""
        }>${esc(item.label)}</a>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#090a08">
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${prefix}assets/style.css">
<script src="${prefix}assets/app.js" defer></script>
</head>
<body${bodyClass ? ` class="${attr(bodyClass)}"` : ""}>
<a class="skip-link" href="#main">Skip to content</a>
<div class="statusbar">
  <div class="shell statusbar-inner">
    <span class="status-state"><span class="status-dot" aria-hidden="true"></span>No malware found</span>
    <span>Independent static audit</span>
    <span class="statusbar-detail">${data.mods.length} installed mods</span>
    <span class="statusbar-detail">Snapshot ${esc(data.auditDate)}</span>
  </div>
</div>
<header class="site-header">
  <div class="shell header-inner">
    <a class="brand" href="${prefix}index.html" aria-label="Puck Workshop audit home">
      <span class="brand-mark" aria-hidden="true">PWA</span>
      <span class="brand-copy">
        <span class="brand-name">Puck Workshop audit</span>
        <span class="brand-sub">Forensic mod ledger</span>
      </span>
    </a>
    <nav class="site-nav" aria-label="Primary">${nav}</nav>
    <span class="header-proof"><span class="status-dot" aria-hidden="true"></span>${data.mods.length} records</span>
  </div>
</header>
<main id="main" class="${bodyClass === "page-requests" ? "page-main" : "page-main"}">
${main}
</main>
<footer class="site-footer">
  <div class="shell">
    <div class="footer-grid">
      <div>
        <p class="footer-mark">PUCK WORKSHOP <span>/</span> AUDIT</p>
        <p class="footer-note">Static reports tied to file inventories and hashes. Triage, not a guarantee. Read the method before treating a verdict as a clean bill of health.</p>
      </div>
      <nav class="footer-nav" aria-label="Footer">
        <a href="${prefix}index.html">Audit ledger</a>
        <a href="${prefix}method.html">Method &amp; limits</a>
        <a href="${prefix}requests.html">Request a check</a>
        <a href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">GitHub issues <span class="external-mark" aria-hidden="true">↗</span></a>
      </nav>
      <div class="footer-meta">
        <p><span class="meta-label">Snapshot</span><span>${esc(data.auditDate)}</span></p>
        <p><span class="meta-label">Scope</span><span>${data.mods.length} mods · app ${esc(data.appId)}</span></p>
        <p><span class="meta-label">Reports</span><span>Hash-bound, per mod</span></p>
      </div>
    </div>
    <div class="footer-bottom">
      <span>No tracking · no cookies · plain static output</span>
      <span>Puck · Steam Workshop ${esc(data.appId)}</span>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

const counts = data.mods.reduce(
  (acc, mod) => {
    const category = verdictCategory(mod.verdict);
    acc.total += 1;
    if (category !== "unknown" && Object.hasOwn(acc, category)) acc[category] += 1;
    if (kindInfo(mod.kind).asset) acc.assetOnly += 1;
    return acc;
  },
  { total: 0, clean: 0, benign: 0, caveats: 0, suspicious: 0, assetOnly: 0 }
);

const sortedByRisk = [...data.mods].sort(
  (a, b) => Number(b.score) - Number(a.score) || String(a.name).localeCompare(String(b.name))
);

const worstSuspicious = sortedByRisk.find((mod) => verdictCategory(mod.verdict) === "suspicious");
const worstLabel = worstSuspicious ? worstSuspicious.name : "none";
const gradeLine = counts.suspicious
  ? `${counts.suspicious} record${counts.suspicious === 1 ? "" : "s"} sit in the suspicious band. The highest is ${esc(
      worstSuspicious.name
    )}; read that report before treating an update as safe.`
  : "No record sits in the suspicious band in this build. Verdicts are still tied to the audited hashes.";

function filterOption(value, label) {
  return `<option value="${attr(value)}">${esc(label)}</option>`;
}

function modRow(mod) {
  const kind = kindInfo(mod.kind);
  const category = verdictCategory(mod.verdict);
  const band = riskBand(mod.score);
  const search = normalizeText([mod.name, mod.id, mod.kind, mod.verdict].join(" "));
  return `<tr data-name="${attr(normalizeText(mod.name))}" data-id="${attr(
    mod.id
  )}" data-score="${Number(mod.score) || 0}" data-verdict="${attr(
    category
  )}" data-kind="${attr(kind.category)}" data-search="${attr(search)}">
<th scope="row" class="cell-mod"><a class="mod-link" href="mods/${attr(
    mod.id
  )}.html">${esc(mod.name)}</a><span class="mod-id">ID ${esc(mod.id)}</span></th>
<td class="cell-verdict">${badgeMarkup(mod.verdict, "badge--table")}</td>
<td class="cell-score">${scoreMarkup(mod.score)}</td>
<td class="cell-kind"><span class="kind-badge${
    kind.asset ? " kind-badge--asset" : ""
  }" title="${attr(kind.full)}">${esc(kind.label)}</span></td>
<td class="cell-workshop"><a class="table-link" href="${attr(
    mod.workshopUrl || WORKSHOP + mod.id
  )}" target="_blank" rel="noopener noreferrer" aria-label="Open ${attr(
    mod.name
  )} on Steam Workshop">Workshop<span class="external-mark" aria-hidden="true">↗</span></a></td>
</tr>`;
}

function renderStalenessBanner() {
  if (!staleItems.length) return "";

  const linkList = (items) => {
    const visible = items.slice(0, 4);
    const extra = items.length - visible.length;
    return visible
      .map((item) => {
        const known = data.mods.find((mod) => String(mod.id) === String(item.id));
        if (known) return `<a href="mods/${attr(known.id)}.html">${esc(known.name)}</a>`;
        return esc(item.name || `mod ${item.id}`);
      })
      .join(", ")
      .concat(extra > 0 ? ` and ${extra} more` : "");
  };

  const updated = staleItems.filter((item) => item.state !== "missing");
  const missing = staleItems.filter((item) => item.state === "missing");
  const parts = [];
  if (updated.length) {
    parts.push(
      `${linkList(updated)} changed on the Workshop after the audited snapshot (${esc(data.auditDate)}), so the published files are no longer the audited bytes`
    );
  }
  if (missing.length) {
    parts.push(
      `${linkList(missing)} cannot be verified on the Workshop any more (delisted or unlisted), so the audited copy is the only record of it`
    );
  }

  return `<section class="section section--watch" aria-labelledby="watch-title">
  <div class="note-callout note-callout--watch">
    <p class="meta-label">Update watch · ${staleItems.length} build${staleItems.length === 1 ? "" : "s"} moved or unverifiable</p>
    <p>${parts.join("; ")}. The verdicts below apply to the audited bytes only; a re-audit is queued at <a href="requests.html#requested">the request list</a>.</p>
  </div>
</section>

`;
}

function renderIndex() {
  const findings = data.findings
    .map((finding) => {
      const risk = String(finding.risk || "").trim();
      return `<li class="finding-row">
<span class="finding-index" aria-hidden="true">${String(finding.n).padStart(2, "0")}</span>
<div>
<div class="finding-mods">${inline(finding.mods, { modHref: (id) => `mods/${id}.html` })}</div>
<div class="finding-body">${renderMarkdown(finding.finding, {
        skipFirstH1: false,
        modHref: (id) => `mods/${id}.html`,
      }).html}</div>
</div>
<div class="finding-risk"><span class="meta-label">Risk</span><span>${inline(risk)}</span></div>
</li>`;
    })
    .join("\n");

  const reaudits = data.reaudits
    .map(
      (reaudit) => `<li class="reaudit-row">
<div class="reaudit-time">${timeMarkup(reaudit.when)}</div>
<div>
<div class="reaudit-mod">${inline(reaudit.mod, { modHref: (id) => `mods/${id}.html` })}</div>
<div class="reaudit-what">${inline(reaudit.what)}</div>
</div>
<div class="reaudit-result">${inline(reaudit.result)}</div>
</li>`
    )
    .join("\n");

  const rows = sortedByRisk.map(modRow).join("\n");

  const main = `<div class="shell page-enter">
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-copy">
    <p class="eyebrow"><span class="eyebrow-index">01</span><span>Independent audit</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Puck · Steam Workshop</span></p>
    <h1 id="hero-title">Puck Workshop<br><span class="hero-title-soft">mod audit</span></h1>
    <p class="hero-lede">Every one of the <strong>${counts.total} installed mods</strong> was unpacked, hashed and reviewed for token grabbers, stealers, ransomware, miners, persistence and the usual Steam-account theft patterns. <strong>No malware found.</strong></p>
    <div class="hero-actions">
      <a class="btn btn--primary" href="#ledger">Browse the ${counts.total} records</a>
      <a class="text-link" href="method.html">How the audit was done</a>
    </div>
    <p class="hero-scope">Audit date ${esc(data.auditDate)} · target app ${esc(data.appId)} · ${counts.assetOnly} asset-only mods · ${counts.total - counts.assetOnly} code-bearing mods</p>
  </div>
  <aside class="verdict-panel" aria-label="Headline audit verdict">
    <div class="panel-head">
      <span class="meta-label">Verdict / 00</span>
      <span class="panel-date">${esc(data.auditDate)}</span>
    </div>
    <div class="zero-lockup">
      <span class="verdict-zero" aria-hidden="true">0</span>
      <span class="verdict-word">malware<br>found</span>
    </div>
    <p class="panel-proof"><span class="status-dot" aria-hidden="true"></span>No malicious capability identified</p>
    <div class="panel-split">
      <div><span class="panel-number panel-number--warn">${counts.suspicious}</span><span class="panel-label">Suspicious verdict</span></div>
      <div><span class="panel-number">${counts.caveats}</span><span class="panel-label">With caveats</span></div>
    </div>
    <p class="panel-note">${gradeLine}</p>
  </aside>
</section>

<section class="stats-strip" aria-label="Audit totals">
  <div class="stats-grid">
    <div class="stat"><div class="stat-value">${counts.total}</div><div class="stat-label"><span class="stat-tick" aria-hidden="true"></span>Mods audited</div><p class="stat-note">Every installed file</p></div>
    <div class="stat stat--clean"><div class="stat-value">${counts.clean}</div><div class="stat-label"><span class="stat-tick" aria-hidden="true"></span>Clean</div><p class="stat-note">Plus ${counts.benign} benign</p></div>
    <div class="stat stat--caveats"><div class="stat-value">${counts.caveats}</div><div class="stat-label"><span class="stat-tick" aria-hidden="true"></span>With caveats</div><p class="stat-note">Privacy or capability</p></div>
    <div class="stat stat--suspicious"><div class="stat-value">${counts.suspicious}</div><div class="stat-label"><span class="stat-tick" aria-hidden="true"></span>Suspicious</div><p class="stat-note">${worstSuspicious ? esc(worstLabel) : "None"}</p></div>
    <div class="stat"><div class="stat-value">${counts.assetOnly}</div><div class="stat-label"><span class="stat-tick" aria-hidden="true"></span>Asset-only</div><p class="stat-note">No executable code</p></div>
  </div>
</section>

${renderStalenessBanner()}

<section class="section" aria-labelledby="verdict-title">
  <div class="section-head">
    <span class="section-num">01</span>
    <div class="section-head-copy">
      <p class="kicker">Scope and verdict</p>
      <h2 id="verdict-title">No malware. Six findings that still matter.</h2>
    </div>
  </div>
  <div class="statement-grid">
    <div class="statement-main">
      <p class="statement-lead">The headline is deliberately plain: no token or credential grabber, stealer, ransomware, miner, RAT, persistence mechanism, code injection or evasion was found in any of the ${counts.total} installed mods.</p>
      <p>What the audit did find is more ordinary and more nuanced. One mod deliberately fingerprints machines over plain HTTP. Fourteen carry privacy, telemetry or capability caveats. Two no longer have verifiable Workshop provenance. The rest are game logic, stat trackers, audio packs, reskins and UI tweaks.</p>
      <p>Every verdict is tied to a file inventory and SHA-256 hashes. Managed code was decompiled and read, not just scanned. The reports are triage: they describe what the reviewed bytes can do, and where a verdict depends on a hash that a future Workshop update can change.</p>
    </div>
    <aside class="statement-aside" aria-label="Audit scope facts">
      <dl class="fact-list">
        <div><dt>Installed</dt><dd>${counts.total} mods on the audited machine</dd></div>
        <div><dt>Coverage</dt><dd>Every shipped file, per mod</dd></div>
        <div><dt>Method</dt><dd>Hashes, PE facts, decompilation, API and string review</dd></div>
        <div><dt>Split</dt><dd>${counts.total - counts.assetOnly} code · ${counts.assetOnly} asset-only</dd></div>
        <div><dt>Limit</dt><dd>Best-effort static triage, not a guarantee</dd></div>
      </dl>
      <a class="text-link" href="method.html">Read method &amp; limitations</a>
    </aside>
  </div>
</section>

<section class="section" aria-labelledby="findings-title">
  <div class="section-head">
    <span class="section-num">02</span>
    <div class="section-head-copy">
      <p class="kicker">Key findings</p>
      <h2 id="findings-title">What the clean verdict is not hiding.</h2>
      <p class="section-lede">Ranked by security relevance, with the affected records linked. A low score is not the same as “nothing to see here”; read the caveats before installing.</p>
    </div>
  </div>
  <ol class="finding-list">${findings}</ol>
</section>

<section class="section" aria-labelledby="reaudits-title">
  <div class="section-head">
    <span class="section-num">03</span>
    <div class="section-head-copy">
      <p class="kicker">Re-audit log</p>
      <h2 id="reaudits-title">Verdicts change when builds change.</h2>
      <p class="section-lede">Two records were re-checked after the first pass. One fixes a real authorisation flaw; one confirms that re-exported textures did not hide a code change.</p>
    </div>
  </div>
  <ol class="reaudit-list">${reaudits}</ol>
  <p class="section-footnote">A verdict is tied to the reviewed bytes. Workshop updates can invalidate it; check the hash and re-run the review when a build changes.</p>
</section>

<section class="section" id="ledger" aria-labelledby="ledger-title">
  <div class="section-head">
    <span class="section-num">04</span>
    <div class="section-head-copy">
      <p class="kicker">The ledger</p>
      <h2 id="ledger-title">All ${counts.total} records.</h2>
      <p class="section-lede">Search by name or Workshop ID, filter by verdict and kind, and sort by risk or name. Scores run from 0 to 100; higher means more concerning.</p>
      <ul class="legend" aria-label="Verdict colour key">
        <li class="legend-item"><span class="badge badge--clean badge--mini"><span class="badge-dot" aria-hidden="true"></span>Clean</span>No security finding</li>
        <li class="legend-item"><span class="badge badge--caveats badge--mini"><span class="badge-dot" aria-hidden="true"></span>With caveats</span>Privacy or capability note</li>
        <li class="legend-item"><span class="badge badge--suspicious badge--mini"><span class="badge-dot" aria-hidden="true"></span>Suspicious</span>Material concern</li>
      </ul>
    </div>
  </div>
  <form class="filter-bar" id="ledger-filters" role="search" aria-label="Filter audit records">
    <div class="filter-field filter-field--search">
      <label for="filter-q">Search records</label>
      <input id="filter-q" name="q" type="search" placeholder="Name or Workshop ID" autocomplete="off">
    </div>
    <div class="filter-field">
      <label for="filter-verdict">Verdict</label>
      <select id="filter-verdict" name="verdict">
        <option value="all">All verdicts</option>
        ${filterOption("clean", "Clean")}
        ${filterOption("benign", "Benign")}
        ${filterOption("caveats", "With caveats")}
        ${filterOption("suspicious", "Suspicious")}
      </select>
    </div>
    <div class="filter-field">
      <label for="filter-kind">Kind</label>
      <select id="filter-kind" name="kind">
        <option value="all">All kinds</option>
        ${filterOption("code", "Code-bearing")}
        ${filterOption("asset", "Asset-only")}
      </select>
    </div>
    <div class="filter-actions"><button class="btn btn--quiet" type="reset" id="filter-reset">Reset</button></div>
  </form>
  <noscript><p class="inline-note">Filters and sorting need JavaScript. All ${counts.total} records are listed below in risk order.</p></noscript>
  <div class="table-meta">
    <span id="ledger-count" aria-live="polite">Showing ${counts.total} of ${counts.total} records</span>
    <span class="table-hint" id="ledger-sort-note">Sorted by risk score, high to low<span class="js-only"> · filters update live</span></span>
  </div>
  <div class="table-scroll" tabindex="0" role="region" aria-label="Audit ledger table; scroll horizontally on narrow screens">
    <table class="mod-table" id="mod-ledger">
      <caption>All ${counts.total} installed Puck Workshop mods. Use the linked mod name to read its full report.</caption>
      <thead>
        <tr>
          <th scope="col" class="th-sortable" data-sort-key="name" aria-sort="none"><span class="sort-fallback">Mod</span><button class="sort-control js-only" type="button" data-sort="name">Mod<span class="sort-arrow" aria-hidden="true"></span></button></th>
          <th scope="col">Verdict</th>
          <th scope="col" class="th-sortable th-num" data-sort-key="score" aria-sort="descending"><span class="sort-fallback">Score</span><button class="sort-control js-only" type="button" data-sort="score">Score<span class="sort-arrow" aria-hidden="true">↓</span></button></th>
          <th scope="col">Kind</th>
          <th scope="col"><span class="sr-only">Steam Workshop</span><span aria-hidden="true">Link</span></th>
        </tr>
      </thead>
      <tbody id="ledger-body">
${rows}
      </tbody>
    </table>
  </div>
  <div class="empty-state" id="ledger-empty" hidden>
    <div class="empty-index" aria-hidden="true">0</div>
    <h3>No records match those filters.</h3>
    <p>Try a broader name or ID search, switch the verdict back to all, or reset the ledger.</p>
    <button class="btn" type="button" id="empty-reset">Reset filters</button>
  </div>
</section>

<section class="closing" aria-labelledby="closing-title">
  <div class="closing-rule"></div>
  <div class="closing-grid">
    <div>
      <p class="kicker">Method before trust</p>
      <h2 id="closing-title">Read the limits with the verdict.</h2>
      <p>This is static triage on a single machine, not a sandbox detonation or a guarantee. The method page explains the checks, the scoring bands and the gaps that remain.</p>
    </div>
    <div class="closing-actions">
      <a class="btn" href="method.html">Read the method</a>
      <a class="text-link" href="requests.html">Request a check</a>
    </div>
  </div>
</section>
</div>`;

  return pageShell({
    title: `Puck Workshop mod audit — ${counts.total} mods, no malware`,
    description:
      "Independent static security audit of 63 installed Puck Workshop mods: verdicts, risk scores, hash-bound reports, key findings and re-audit history.",
    current: "home",
    main,
  });
}

/* -------------------------------------------------------------------------- */
/* Mod pages                                                                  */
/* -------------------------------------------------------------------------- */

function renderModPage(mod, index) {
  const previous = data.mods[index - 1];
  const next = data.mods[index + 1];
  const kind = kindInfo(mod.kind);
  const band = riskBand(mod.score);
  const report = renderMarkdown(mod.report, {
    skipFirstH1: true,
    selfId: String(mod.id),
    modHref: (id) => `${id}.html`,
  });
  const headings = report.headings.filter((heading) => heading.level === 2);
  const toc = headings.length
    ? `<ol>${headings
        .map((heading) => `<li><a href="#${attr(heading.id)}">${esc(heading.text)}</a></li>`)
        .join("")}</ol>`
    : `<p class="aside-note">This report has no section headings.</p>`;

  const prevNext = `<nav class="prev-next" aria-label="Adjacent audit records">
<a class="prev-next-link" href="${previous ? `${previous.id}.html` : "../index.html"}">
<span class="meta-label">${previous ? "Previous record" : "Back to ledger"}</span>
<span>${esc(previous ? previous.name : "All audit records")}</span>
</a>
<a class="prev-next-link prev-next-link--next" href="${next ? `${next.id}.html` : "../index.html"}">
<span class="meta-label">${next ? "Next record" : "Back to ledger"}</span>
<span>${esc(next ? next.name : "All audit records")}</span>
</a>
</nav>`;

  const main = `<div class="shell page-enter">
<nav class="breadcrumb" aria-label="Breadcrumb">
  <ol>
    <li><a href="../index.html">Audit ledger</a></li>
    <li aria-current="page">${esc(mod.name)}</li>
  </ol>
</nav>
<article>
<header class="record-hero">
  <div class="record-copy">
    <p class="eyebrow"><span class="eyebrow-index">RECORD ${esc(mod.id)}</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>${esc(kind.asset ? "Asset-only entry" : "Code-bearing entry")}</span></p>
    <h1>${esc(mod.name)}</h1>
    <div class="record-verdict">
      ${badgeMarkup(mod.verdict)}
      <span class="record-score-label">Risk score <strong>${Number(mod.score) || 0}/100</strong> · ${esc(
        band.label
      )}</span>
    </div>
    <p class="record-summary">${
      kind.asset
        ? "No executable code ships in this entry. The report covers the file inventory, provenance and any embedded capability in the assets."
        : "This entry ships code. The report covers every file, the decompiled managed code and the external interfaces it uses."
    } Report tied to the audited bytes; a later Workshop update can change the verdict.</p>
    <div class="record-actions">
      <a class="btn btn--primary" href="${attr(
        mod.workshopUrl || WORKSHOP + mod.id
      )}" target="_blank" rel="noopener noreferrer">Open Workshop<span class="external-mark" aria-hidden="true">↗</span></a>
      <a class="text-link" href="#report">Read the report</a>
    </div>
  </div>
  <aside class="record-score-panel" aria-label="Record summary">
    <span class="meta-label">Suspicion score</span>
    <div class="record-big-score">${Number(mod.score) || 0}<span>/ 100</span></div>
    <div class="score-track score-track--wide" aria-hidden="true"><span class="score-fill score-fill--${
      band.key
    }" style="--score:${Number(mod.score) || 0}"></span></div>
    <div class="record-band">${esc(band.label)} · ${esc(band.note)}</div>
    <dl class="record-mini-facts">
      <div><dt>Kind</dt><dd>${esc(kind.full)}</dd></div>
      <div><dt>Verdict</dt><dd>${esc(mod.verdict)}</dd></div>
      <div><dt>Workshop</dt><dd>${esc(mod.id)}</dd></div>
      <div><dt>Report</dt><dd>${mod.report.length.toLocaleString("en-US")} characters</dd></div>
    </dl>
  </aside>
</header>
<div class="record-layout">
  <div>
    <div class="report-head">
      <div>
        <p class="kicker">Full audit report</p>
        <h2 class="report-title">What the bytes do</h2>
      </div>
      <p class="report-timestamp"><span class="meta-label">Audit</span> ${esc(data.auditDate)}</p>
    </div>
    <section class="report" id="report" aria-label="Audit report">
      <div class="prose">${report.html}</div>
    </section>
    ${prevNext}
  </div>
  <aside class="report-aside" aria-label="Report navigation and actions">
    <div class="aside-block">
      <p class="meta-label">Verdict</p>
      <div class="aside-verdict">${badgeMarkup(mod.verdict)}</div>
      <p class="aside-note">${esc(band.label)} risk band. A verdict applies to the reviewed build, not to every future update.</p>
    </div>
    <div class="aside-block">
      <p class="meta-label">Suspicion score</p>
      <div class="aside-score-row"><span class="aside-score">${Number(mod.score) || 0}</span><span class="aside-score-denom">/ 100</span></div>
      <div class="score-track score-track--wide" aria-hidden="true"><span class="score-fill score-fill--${
        band.key
      }" style="--score:${Number(mod.score) || 0}"></span></div>
    </div>
    <div class="aside-block">
      <p class="meta-label">On this page</p>
      <nav class="toc" aria-label="Report sections">${toc}</nav>
    </div>
    <div class="aside-block aside-block--link">
      <a class="aside-link" href="${attr(
        mod.workshopUrl || WORKSHOP + mod.id
      )}" target="_blank" rel="noopener noreferrer">Steam Workshop <span aria-hidden="true">↗</span></a>
      <a class="aside-link" href="../method.html">Method &amp; scoring <span aria-hidden="true">→</span></a>
      <a class="aside-link" href="../requests.html">Request another check <span aria-hidden="true">→</span></a>
    </div>
  </aside>
</div>
</article>
</div>`;

  return pageShell({
    title: `${mod.name} — ${verdictLabel(mod.verdict)} · Puck Workshop audit`,
    description: `Audit report for ${mod.name} (Workshop ${mod.id}): ${verdictLabel(
      mod.verdict
    )}, suspicion score ${mod.score}/100. ${kind.asset ? "Asset-only." : "Code review included."}`,
    prefix: "../",
    current: "home",
    main,
  });
}

/* -------------------------------------------------------------------------- */
/* Method                                                                     */
/* -------------------------------------------------------------------------- */

function renderMethodPage() {
  const methodSource = String(data.method || "")
    .replace(/any of the 61 mods/g, `any of the ${counts.total} mods`);
  const rendered = renderMarkdown(methodSource, {
    skipFirstH1: true,
    modHref: (id) => `mods/${id}.html`,
  });
  const headings = rendered.headings.filter((heading) => heading.level === 2);
  const toc = headings.length
    ? `<ol>${headings
        .map(
          (heading, index) =>
            `<li><a href="#${attr(heading.id)}"><span>${String(index + 1).padStart(
              2,
              "0"
            )}</span>${esc(heading.text)}</a></li>`
        )
        .join("")}</ol>`
    : "";

  const main = `<div class="shell page-enter">
<header class="page-hero">
  <p class="eyebrow"><span class="eyebrow-index">METHOD</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Scoring, scope and limits</span></p>
  <h1>How this audit was done.</h1>
  <p class="page-lede">The checks behind every verdict, the rubric that turns findings into a 0–100 score, and the gaps that keep this honest. Read it before treating “clean” as proof of safety.</p>
  <div class="page-hero-meta"><span><span class="status-dot" aria-hidden="true"></span>Snapshot ${esc(
    data.auditDate
  )}</span><span>${counts.total} installed mods</span><span>Static triage</span></div>
</header>
<div class="doc-layout">
  <aside class="doc-aside">
    <nav class="toc toc--doc" aria-label="On this page">
      <p class="meta-label">Contents</p>
      ${toc}
    </nav>
    <div class="doc-aside-note">
      <p class="meta-label">The short version</p>
      <p>Every file hashed, every managed DLL decompiled, every capability read. One machine, one snapshot, no sandbox detonation.</p>
      <a class="text-link" href="index.html">Back to the ledger</a>
    </div>
  </aside>
  <div class="doc-content prose">${rendered.html}</div>
</div>
<section class="closing closing--compact" aria-labelledby="method-cta">
  <div class="closing-grid">
    <div>
      <p class="kicker">Next step</p>
      <h2 id="method-cta">Have a mod that deserves a look?</h2>
      <p>The request queue is public and lives in GitHub issues. Bring a Workshop link and a reason, not a private pack.</p>
    </div>
    <div class="closing-actions">
      <a class="btn btn--primary" href="requests.html">Request a check</a>
      <a class="text-link" href="index.html">Browse all records</a>
    </div>
  </div>
</section>
</div>`;

  return pageShell({
    title: "Method, scoring and limitations — Puck Workshop audit",
    description:
      "How the Puck Workshop mod audit was performed: file inventories and hashes, PE analysis, decompilation, API review, scoring rubric, scope and limitations.",
    current: "method",
    main,
  });
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const autoReportById = new Map(autoReports.map((report) => [String(report.id), report]));
const RUN_STATE = {
  queued: { label: "Queued", cls: "open" },
  running: { label: "Running", cls: "open" },
  done: { label: "Report ready", cls: "closed" },
  blocked: { label: "Blocked", cls: "closed" },
  failed: { label: "Failed", cls: "closed" },
  skipped: { label: "Skipped", cls: "closed" },
};
const STEP_STATE = { pending: "waiting", running: "active", done: "done", failed: "failed", skipped: "skipped" };

function automationStateChip(run) {
  const state = RUN_STATE[run.state] || RUN_STATE.queued;
  return `<span class="request-status request-status--${state.cls}">${esc(state.label)}</span>`;
}

function automationRunMarkup(run) {
  const steps = (run.steps || [])
    .map((step) => {
      const cls = STEP_STATE[step.state] || "waiting";
      const detail = step.detail ? `<span class="run-step-detail">${esc(step.detail)}</span>` : "";
      return `<li class="run-step run-step--${cls}">
<span class="run-dot" aria-hidden="true"></span>
<span class="run-step-label">${esc(step.label || step.key)}</span>
${detail}
</li>`;
    })
    .join("");
  const title = run.title || `Workshop item ${run.id}`;
  const report = run.report
    ? `<a class="text-link run-report-link" href="reports/${esc(run.id)}.html">Automated triage report<span aria-hidden="true"> →</span></a>`
    : "";
  const note = run.note ? `<p class="run-note">${esc(run.note)}</p>` : "";
  return `<li class="run-row" data-run-id="${esc(run.id)}" data-run-state="${esc(run.state)}">
<div class="run-head">
  <div>
    <p class="request-title"><a href="${attr(WORKSHOP + String(run.id))}" target="_blank" rel="noopener noreferrer">${esc(title)}<span class="external-mark" aria-hidden="true">↗</span></a></p>
    <p class="request-meta">Mod ${esc(run.id)}${run.issue ? ` · Issue #${esc(run.issue)}` : ""} · started ${esc(timeMarkup(run.startedAt))}</p>
  </div>
  ${automationStateChip(run)}
</div>
<ol class="run-steps" aria-label="Audit steps">${steps}</ol>
${note}
${report}
</li>`;
}

function renderAutomationSection() {
  if (!auditRuns.length) return "";
  const active = auditRuns.filter((run) => ["queued", "running"].includes(run.state));
  const recent = auditRuns
    .filter((run) => !["queued", "running"].includes(run.state))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 6);
  const ordered = [...active, ...recent];
  const live = active.length > 0;
  return `<section class="queue-section" id="automation" aria-labelledby="automation-title">
  <div class="section-head section-head--queue">
    <span class="section-num">03</span>
    <div class="section-head-copy">
      <p class="kicker">Automated triage</p>
      <h2 id="automation-title">Working on it, in public.</h2>
      <p class="section-lede">Requested mods are fetched from Steam, unpacked, hashed and scanned by an automated static triage. Every step commits and redeploys, so this list shows the run as it happens.${
        live ? " A run is active right now — the page checks for updates on its own." : ""
      }</p>
    </div>
    <span class="run-live${live ? " run-live--on" : ""}" data-run-live="${live ? "on" : "off"}"><span class="run-live-dot" aria-hidden="true"></span>${live ? "Live" : "Idle"}</span>
  </div>
  <div class="queue-panel" id="automation-panel" data-automation-panel>
    <ul class="request-list run-list" id="automation-list">${ordered.map(automationRunMarkup).join("\n")}</ul>
  </div>
  <div class="queue-foot">
    <p class="meta-label">Source: data/audit-runs.json · runs triggered by the audit workflow</p>
    <p class="meta-label">Automated triage is a scan, not a manual audit. It can miss runtime behaviour and remote payloads.</p>
  </div>
</section>`;
}

function renderAutoReportPage(report) {
  const reportFile = path.join(ROOT, report.reportPath);
  const markdown = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : "";
  const rendered = markdown
    ? renderMarkdown(markdown, { skipFirstH1: true, selfId: String(report.id) })
    : { html: "<p>Report file missing.</p>", headings: [] };
  const score = Number(report.score) || 0;
  const band = riskBand(score);
  const main = `<div class="shell page-enter">
<nav class="breadcrumb" aria-label="Breadcrumb">
  <ol>
    <li><a href="../requests.html#automation">Automated triage</a></li>
    <li aria-current="page">${esc(report.title || `Workshop item ${report.id}`)}</li>
  </ol>
</nav>
<article>
<header class="record-hero">
  <div class="record-copy">
    <p class="eyebrow"><span class="eyebrow-index">AUTO ${esc(report.id)}</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Automated static triage</span></p>
    <h1>${esc(report.title || `Workshop item ${report.id}`)}</h1>
    <div class="record-verdict">
      ${badgeMarkup(report.verdict)}
      <span class="record-score-label">Automated score <strong>${score}/100</strong> · ${esc(band.label)}</span>
    </div>
    <p class="record-summary">This is machine-generated triage of the published files: every file hashed, every binary parsed, strings matched against indicator patterns. It is not a manual audit and a clean scan is not a safety guarantee.${
      report.issue ? ` Requested in issue #${esc(report.issue)}.` : ""
    }</p>
    <div class="record-actions">
      <a class="btn btn--primary" href="https://steamcommunity.com/sharedfiles/filedetails/?id=${attr(
        report.id
      )}" target="_blank" rel="noopener noreferrer">Open Workshop<span class="external-mark" aria-hidden="true">↗</span></a>
      <a class="text-link" href="../requests.html#automation">Back to the run list</a>
    </div>
  </div>
  <aside class="record-score-panel" aria-label="Automated triage summary">
    <span class="meta-label">Automated score</span>
    <div class="record-big-score">${score}<span>/ 100</span></div>
    <div class="score-track score-track--wide" aria-hidden="true"><span class="score-fill score-fill--${band.key}" style="--score:${score}"></span></div>
    <div class="record-band">${esc(band.label)} · ${esc(band.note)}</div>
    <dl class="record-mini-facts">
      <div><dt>Files</dt><dd>${Number(report.fileCount) || 0}</dd></div>
      <div><dt>Code files</dt><dd>${Number(report.codeFiles) || 0}</dd></div>
      <div><dt>Indicators</dt><dd>${Number(report.indicatorCount) || 0}</dd></div>
      <div><dt>Generated</dt><dd>${esc(dateDisplay(report.generatedAt))}</dd></div>
    </dl>
  </aside>
</header>
<div class="record-layout">
  <div>
    <div class="report-head">
      <div>
        <p class="kicker">Automated triage</p>
        <h2 class="report-title">What the scanner saw</h2>
      </div>
      <p class="report-timestamp"><span class="meta-label">Run</span> ${esc(dateDisplay(report.generatedAt))}</p>
    </div>
    <section class="report" id="report" aria-label="Automated triage report">
      <div class="prose">${rendered.html}</div>
    </section>
  </div>
  <aside class="report-aside" aria-label="Triage actions">
    <div class="aside-block">
      <p class="meta-label">Not a manual audit</p>
      <p class="aside-note">A human audit inspects the decompiled code and the intent behind each capability. This page is the machine half: hashes, binaries, indicators.</p>
    </div>
    <div class="aside-block aside-block--link">
      <a class="aside-link" href="../method.html">Method &amp; scoring <span aria-hidden="true">→</span></a>
      <a class="aside-link" href="../requests.html">Request a manual audit <span aria-hidden="true">→</span></a>
    </div>
  </aside>
</div>
</article>
</div>`;
  return pageShell({
    title: `${report.title || `Workshop item ${report.id}`} — automated triage · Puck Workshop audit`,
    description: `Automated static triage of ${report.title || `Workshop ${report.id}`}: ${report.verdict}, automated score ${score}/100.`,
    prefix: "../",
    current: "requests",
    main,
  });
}

function renderRequestedSection() {
  if (!pendingRequests.length) return "";

  const STATUS = {
    pending: { label: "Pending audit", cls: "open" },
    "needs-reaudit": { label: "Needs re-audit", cls: "open" },
    audited: { label: "Audited", cls: "closed" },
    closed: { label: "Closed, not audited", cls: "closed" },
    rejected: { label: "Rejected", cls: "closed" },
    duplicate: { label: "Duplicate", cls: "closed" },
  };

  const items = pendingRequests
    .map((request) => {
      const auto = autoReportById.get(String(request.id));
      const activeRun = auditRuns.find(
        (run) => String(run.id) === String(request.id) && ["queued", "running"].includes(run.state)
      );
      let status = STATUS[request.status] || STATUS.pending;
      if (auto) status = { label: "Triage ready", cls: "closed" };
      else if (activeRun) {
        const stepLabel = (activeRun.steps || []).find((step) => step.state === "running")?.label || "Queued";
        status = { label: `Auditing — ${stepLabel.toLowerCase()}`, cls: "open" };
      }
      const autoLine = auto
        ? `<p class="request-auto"><span class="auto-tag">AUTO</span> ${esc(
            auto.verdict
          )} · ${Number(auto.score) || 0}/100 · <a href="reports/${esc(auto.id)}.html">automated triage report</a></p>`
        : "";
      const meta = [
        request.id ? `Mod ${esc(request.id)}` : "",
        request.issue ? `Issue #${esc(request.issue)}` : "",
        request.requestedAt ? `requested ${esc(dateDisplay(request.requestedAt))}` : "",
        request.note ? esc(request.note) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<li class="request-row">
<div>
<p class="request-title"><a href="${attr(WORKSHOP + String(request.id))}" target="_blank" rel="noopener noreferrer">${esc(
        request.title || `Workshop item ${request.id}`
      )}<span class="external-mark" aria-hidden="true">↗</span></a></p>
<p class="request-meta">${meta}</p>
${autoLine}
</div>
<span class="request-status request-status--${status.cls}">${esc(status.label)}</span>
</li>`;
    })
    .join("\n");

  return `<section class="queue-section" id="requested" aria-labelledby="requested-title">
  <div class="section-head section-head--queue">
    <span class="section-num">04</span>
    <div class="section-head-copy">
      <p class="kicker">Requested</p>
      <h2 id="requested-title">Queued for audit.</h2>
      <p class="section-lede">Kept in sync by the repository workflows from the GitHub request queue. A request is marked audited once its report exists, and needs re-audit when the Workshop build moves past the audited bytes.</p>
    </div>
  </div>
  <div class="queue-panel">
    <ul class="request-list">${items}</ul>
  </div>
  <div class="queue-foot">
    <p class="meta-label">Source: data/requests.json · synced by GitHub Actions</p>
    <a class="text-link" href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">Request another mod<span class="external-mark" aria-hidden="true">↗</span></a>
  </div>
</section>`;
}

function renderRequestsPage() {
  const main = `<div class="shell page-enter">
<script src="assets/queue-live.js" defer></script>
<header class="page-hero page-hero--request">
  <div>
    <p class="eyebrow"><span class="eyebrow-index">REQUESTS</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Public queue</span></p>
    <h1>Put a mod in the queue.</h1>
    <p class="page-lede">Send a Steam Workshop link or published file ID. The item is checked against Steam’s public API before a public GitHub issue is opened, so the queue stays verifiable.</p>
    <div class="page-hero-meta"><span><span class="status-dot" aria-hidden="true"></span>GitHub-backed</span><span>One request per mod</span><span>Public by design</span></div>
  </div>
  <div class="request-stat">
    <p class="meta-label">Queue source</p>
    <p class="request-stat-value">mod-request</p>
    <p class="request-stat-note">Requests become issues in <a href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">${GITHUB_REPO}</a>, labelled <code>mod-request</code>. Public, linkable, and independent of this page.</p>
  </div>
</header>

<div class="request-layout">
  <section class="request-form-panel" aria-labelledby="request-form-title">
    <div class="panel-heading">
      <span class="section-num">01</span>
      <div>
        <p class="kicker">Request form</p>
        <h2 id="request-form-title">What should be checked?</h2>
      </div>
    </div>
    <form class="request-form" id="request-form" action="requests.html#request-form" method="get" novalidate>
      <div class="form-field">
        <label for="req-mod">Workshop link or ID <span class="required-mark" aria-hidden="true">*</span></label>
        <p class="field-hint" id="mod-hint">Paste a Steam Workshop URL, a <code>steam://</code> link, or the numeric published file ID.</p>
        <input id="req-mod" name="mod" type="text" required maxlength="300" autocomplete="off" spellcheck="false" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=3776968217" aria-describedby="mod-hint mod-error">
        <p class="field-error" id="mod-error" hidden></p>
      </div>
      <div class="form-field">
        <label for="req-reason">Why does it need a look? <span class="optional-mark">Optional</span></label>
        <p class="field-hint" id="reason-hint">Comma-separated reasons are fine: new binary, unexpected network traffic, changed after an update, odd permissions. Do not paste private data.</p>
        <textarea id="req-reason" name="reason" maxlength="2000" rows="5" aria-describedby="reason-hint reason-error reason-count"></textarea>
        <div class="field-meta"><span id="reason-count">0 / 2000</span></div>
        <p class="field-error" id="reason-error" hidden></p>
      </div>
      <div class="form-field">
        <label for="req-contact">Contact <span class="optional-mark">Optional</span></label>
        <p class="field-hint" id="contact-hint">A handle, profile or email if follow-up helps. This will be public in the GitHub issue.</p>
        <input id="req-contact" name="contact" type="text" maxlength="200" autocomplete="off" aria-describedby="contact-hint contact-error">
        <div class="field-meta"><span id="contact-count">0 / 200</span></div>
        <p class="field-error" id="contact-error" hidden></p>
      </div>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit" id="request-submit">Submit request</button>
        <a class="text-link" href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">Open GitHub issues directly</a>
      </div>
      <div class="form-status" id="request-status" role="status" aria-live="polite" hidden></div>
      <p class="form-footnote">Submitting creates a public GitHub issue. The form does not upload files; only the Workshop reference, your note and optional contact are sent. Requests are queued, not guaranteed.</p>
      <noscript><p class="form-footnote">JavaScript is required to send the request from this page. Use the GitHub issues link above and include the Workshop URL and your reason.</p></noscript>
    </form>
  </section>

  <aside class="request-notes" aria-labelledby="request-notes-title">
    <p class="kicker">What happens next</p>
    <h2 id="request-notes-title">Public, checked, queued.</h2>
    <ol class="process-list">
      <li><span class="process-num" aria-hidden="true">01</span><div><strong>The ID is parsed.</strong><p>Raw IDs, Steam Community URLs and <code>steam://</code> links are accepted. Junk fails before anything is posted.</p></div></li>
      <li><span class="process-num" aria-hidden="true">02</span><div><strong>Steam confirms it exists.</strong><p>The public Workshop API must return a live item. Deleted or unlisted items are rejected.</p></div></li>
      <li><span class="process-num" aria-hidden="true">03</span><div><strong>An issue is opened.</strong><p>The request lands in the <code>mod-request</code> queue on GitHub with the Workshop link, the reason and the request time.</p></div></li>
    </ol>
    <div class="note-callout">
      <p class="meta-label">Ground rules</p>
      <p>One mod per request. No private packs, leaked builds or paid content. A request is not a promise or a priority ticket; the queue is public so it can stay honest.</p>
    </div>
  </aside>
</div>

<section class="queue-section" aria-labelledby="queue-title">
  <div class="section-head section-head--queue">
    <span class="section-num">02</span>
    <div class="section-head-copy">
      <p class="kicker">Live queue</p>
      <h2 id="queue-title">Requested, publicly tracked.</h2>
      <p class="section-lede">Open and closed requests pulled from GitHub issues labelled <code>mod-request</code>. If the API is unavailable, the queue says so instead of pretending to be empty.</p>
    </div>
    <button class="btn btn--quiet js-only" type="button" id="queue-refresh">Refresh queue</button>
  </div>
  <div class="queue-panel" id="queue-panel" aria-busy="false">
    <div class="queue-state queue-state--loading js-only" id="queue-loading" role="status">
      <p class="meta-label">Loading queue</p>
      <p class="queue-state-title">Reading GitHub issues…</p>
      <div class="skeleton-stack" aria-hidden="true">
        <span class="skeleton-line"></span>
        <span class="skeleton-line skeleton-line--mid"></span>
        <span class="skeleton-line skeleton-line--short"></span>
      </div>
    </div>
    <div class="queue-state queue-state--error" id="queue-error" role="alert" hidden>
      <p class="meta-label">Queue unavailable</p>
      <p class="queue-state-title">The request queue could not be loaded.</p>
      <p id="queue-error-detail">The API is unreachable or GitHub did not answer. The audit itself is still readable; the queue is a convenience, not the evidence.</p>
      <div class="queue-state-actions">
        <a class="btn" href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">Browse requests on GitHub<span class="external-mark" aria-hidden="true">↗</span></a>
        <button class="btn btn--quiet js-only" type="button" data-retry-queue>Try again</button>
      </div>
    </div>
    <div class="queue-state queue-state--empty" id="queue-empty" role="status" hidden>
      <p class="meta-label">Queue clear</p>
      <p class="queue-state-title">No requests in the queue yet.</p>
      <p>That is a clean empty state, not a failed one. Use the form above to put the first mod in line.</p>
    </div>
    <ul class="request-list" id="request-list" hidden></ul>
    <noscript><div class="queue-state"><p class="meta-label">JavaScript required</p><p class="queue-state-title">The live queue needs JavaScript.</p><p>Open the <a href="${GITHUB_ISSUES}">GitHub issue list</a> to see requests labelled <code>mod-request</code>.</p></div></noscript>
  </div>
  <div class="queue-foot">
    <p class="meta-label" id="queue-updated">Source: GitHub · label mod-request</p>
    <a class="text-link" href="${GITHUB_ISSUES}" target="_blank" rel="noopener noreferrer">View the raw queue<span class="external-mark" aria-hidden="true">↗</span></a>
  </div>
</section>

${renderAutomationSection()}

${renderRequestedSection()}

<div class="closing closing--compact">
  <div class="closing-grid">
    <div>
      <p class="kicker">Before you ask</p>
      <h2>Check the existing ledger first.</h2>
      <p>${counts.total} mods are already documented. If the record exists, read the report and cite the hash rather than opening a duplicate request.</p>
    </div>
    <div class="closing-actions"><a class="btn" href="index.html">Search the ledger</a></div>
  </div>
</div>
</div>`;

  return pageShell({
    title: "Request a mod audit — Puck Workshop audit",
    description:
      "Request a Puck Workshop mod security check. Workshop links are verified against Steam, then tracked as a public GitHub issue labelled mod-request.",
    current: "requests",
    main,
    bodyClass: "page-requests",
  });
}

/* -------------------------------------------------------------------------- */
/* Admin page                                                                 */
/* -------------------------------------------------------------------------- */

const ADMIN_STATE = () => {
  const known = new Set(data.mods.map((mod) => String(mod.id)));
  return {
    mods: data.mods.map((mod) => ({
      id: String(mod.id),
      name: mod.name,
      verdict: mod.verdict,
      score: mod.score,
    })),
    requests: (requestsData.requests || []).map((request) => ({
      id: String(request.id),
      title: request.title || request.name || "",
      issue: request.issue || 0,
      status: request.status,
    })),
    reaudits: (data.reaudits || []).map((entry) => {
      const match = String(entry.mod || "").match(/\b(\d{6,12})\b/);
      return { id: match ? match[1] : "", what: entry.what || "", mod: entry.mod || "" };
    }).filter((entry) => entry.id && known.has(entry.id)),
    hidden: {
      hiddenMods: siteConfig.hiddenMods || [],
      hiddenRequests: siteConfig.hiddenRequests || [],
      hiddenReaudits: siteConfig.hiddenReaudits || [],
    },
  };
};

function renderAdminPage() {
  const state = ADMIN_STATE();
  const main = `<div class="shell page-enter">
<header class="page-hero">
  <div>
    <p class="eyebrow"><span class="eyebrow-index">A</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Site admin</span></p>
    <h1>Take things off the site.</h1>
    <p class="page-lede">Hide a mod, a request or a re-audit row. Every action is a commit to <code>data/site-config.json</code>, so it is reviewable and reversible — nothing is deleted from the audit itself.</p>
    <div class="hero-actions"><a class="text-link" href="index.html">Back to the ledger</a></div>
  </div>
</header>

<section class="queue-section" aria-labelledby="admin-title">
  <div class="section-head">
    <span class="section-num">01</span>
    <div class="section-head-copy">
      <p class="kicker">Authenticate</p>
      <h2 id="admin-title">Admin password</h2>
      <p>Set as <code>ADMIN_TOKEN</code> on the site. It is checked server-side and never stored in the page.</p>
    </div>
  </div>
  <form class="admin-bar" id="admin-form" autocomplete="off">
    <label class="meta-label" for="admin-password">Password</label>
    <input class="field" id="admin-password" type="password" autocomplete="current-password" placeholder="Admin token" required />
    <button class="btn btn--primary" type="submit" id="admin-submit">Unlock</button>
    <p class="admin-status" id="admin-status" role="status" aria-live="polite">Locked. Enter the admin token to manage visibility.</p>
  </form>
</section>

<div id="admin-panels" hidden>
<section class="queue-section" aria-labelledby="admin-mods-title">
  <div class="section-head">
    <span class="section-num">02</span>
    <div class="section-head-copy">
      <p class="kicker">Ledger</p>
      <h2 id="admin-mods-title">Mods</h2>
      <p>Hiding a mod removes its row and its report page from the published site. The report stays in the repository of reports.</p>
    </div>
  </div>
  <ul class="admin-list" id="admin-mods"></ul>
</section>

<section class="queue-section" aria-labelledby="admin-requests-title">
  <div class="section-head">
    <span class="section-num">03</span>
    <div class="section-head-copy">
      <p class="kicker">Queue</p>
      <h2 id="admin-requests-title">Requests</h2>
      <p>Hide a request from the public queue without closing its GitHub issue.</p>
    </div>
  </div>
  <ul class="admin-list" id="admin-requests"></ul>
</section>

<section class="queue-section" aria-labelledby="admin-reaudits-title">
  <div class="section-head">
    <span class="section-num">04</span>
    <div class="section-head-copy">
      <p class="kicker">History</p>
      <h2 id="admin-reaudits-title">Re-audits</h2>
      <p>Hide a re-audit log row for one mod.</p>
    </div>
  </div>
  <ul class="admin-list" id="admin-reaudits"></ul>
</section>
</div>
</div>

<script>
(function () {
  var STATE = ${JSON.stringify(state).replace(/</g, "\\u003c")};
  var password = "";
  var form = document.getElementById("admin-form");
  var input = document.getElementById("admin-password");
  var submit = document.getElementById("admin-submit");
  var status = document.getElementById("admin-status");
  var panels = document.getElementById("admin-panels");

  function say(message, tone) {
    status.textContent = message;
    status.className = "admin-status" + (tone ? " admin-status--" + tone : "");
  }

  function list(node, items, kind, hiddenKey) {
    node.innerHTML = "";
    items.forEach(function (item) {
      var hidden = STATE.hidden[hiddenKey].indexOf(item.id) !== -1;
      var li = document.createElement("li");
      li.className = "admin-row" + (hidden ? " is-hidden" : "");
      var label = document.createElement("span");
      label.className = "admin-row-label";
      label.textContent = item.name || item.title || ("mod " + item.id);
      var meta = document.createElement("span");
      meta.className = "admin-row-meta";
      meta.textContent = item.id + (item.verdict ? " · " + item.verdict : "") + (item.status ? " · " + item.status : "");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--quiet admin-row-action";
      button.textContent = hidden ? "Show" : "Hide";
      button.addEventListener("click", function () {
        act((hidden ? "show-" : "hide-") + kind, item.id, button);
      });
      li.appendChild(label);
      li.appendChild(meta);
      li.appendChild(button);
      node.appendChild(li);
    });
    if (!items.length) {
      var empty = document.createElement("li");
      empty.className = "admin-row admin-row--empty";
      empty.textContent = "Nothing here.";
      node.appendChild(empty);
    }
  }

  function render() {
    list(document.getElementById("admin-mods"), STATE.mods, "mod", "hiddenMods");
    list(document.getElementById("admin-requests"), STATE.requests, "request", "hiddenRequests");
    list(document.getElementById("admin-reaudits"), STATE.reaudits, "reaudit", "hiddenReaudits");
  }

  function act(action, id, button) {
    button.disabled = true;
    say("Saving " + action + " " + id + "…");
    fetch("/api/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password, action: action, id: id }),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.ok) throw new Error(body.error || "Request failed (" + response.status + ").");
          return body;
        });
      })
      .then(function (body) {
        STATE.hidden.hiddenMods = body.hiddenMods || STATE.hidden.hiddenMods;
        STATE.hidden.hiddenRequests = body.hiddenRequests || STATE.hidden.hiddenRequests;
        STATE.hidden.hiddenReaudits = body.hiddenReaudits || STATE.hidden.hiddenReaudits;
        render();
        say(body.changed ? "Saved. The deploy picks it up in a moment." : "Already in that state — nothing changed.", "ok");
      })
      .catch(function (error) {
        button.disabled = false;
        say(error.message, "error");
      });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    password = input.value.trim();
    if (!password) return;
    submit.disabled = true;
    say("Checking…");
    fetch("/api/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password, action: "check" }),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (response.status === 401) throw new Error("Wrong password.");
          if (!response.ok && !body.error) throw new Error("Admin API unavailable (" + response.status + ").");
          return body;
        });
      })
      .then(function (body) {
        if (body.error && /password/i.test(body.error)) throw new Error(body.error);
        STATE.hidden.hiddenMods = body.hiddenMods || STATE.hidden.hiddenMods;
        STATE.hidden.hiddenRequests = body.hiddenRequests || STATE.hidden.hiddenRequests;
        STATE.hidden.hiddenReaudits = body.hiddenReaudits || STATE.hidden.hiddenReaudits;
        panels.hidden = false;
        form.hidden = true;
        render();
        say("Unlocked. Pick a row and hide or restore it.", "ok");
      })
      .catch(function (error) {
        submit.disabled = false;
        say(error.message, "error");
      });
  });
})();
</script>`;

  return pageShell({
    title: "Site admin — Puck Workshop audit",
    description: "Visibility controls for the Puck Workshop audit ledger.",
    current: "",
    noindex: true,
    main,
    bodyClass: "page-admin",
  });
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, redact(content), "utf8");
}

function copyAsset(name) {
  const source = path.join(THEME_DIR, name);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing theme asset: ${name}`);
  }
  fs.copyFileSync(source, path.join(OUT_ASSETS, name));
}

if (path.resolve(OUT) === path.resolve(ROOT)) {
  console.error("Refusing to build into the source directory. Use --out <dir> (default: dist).");
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT_MODS, { recursive: true });
fs.mkdirSync(OUT_ASSETS, { recursive: true });

writeFile(path.join(OUT, "index.html"), renderIndex());
for (const [index, mod] of data.mods.entries()) {
  writeFile(path.join(OUT_MODS, `${mod.id}.html`), renderModPage(mod, index));
}
writeFile(path.join(OUT, "method.html"), renderMethodPage());
writeFile(path.join(OUT, "requests.html"), renderRequestsPage());
writeFile(path.join(OUT, "admin.html"), renderAdminPage());

for (const report of autoReports) {
  writeFile(path.join(OUT, "reports", `${report.id}.html`), renderAutoReportPage(report));
}
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.writeFileSync(path.join(OUT, "data", "audit-runs.json"), JSON.stringify({ generatedAt: new Date().toISOString(), runs: auditRuns }), "utf8");
fs.writeFileSync(path.join(OUT, "data", "reports.json"), JSON.stringify({ generatedAt: new Date().toISOString(), reports: autoReports }), "utf8");

copyAsset("style.css");
copyAsset("app.js");
copyAsset("queue-live.js");
copyAsset("favicon.svg");

const SITE_URL = String(
  siteConfig.siteUrl || process.env.SITE_URL || "https://puck-workshop-safecheck.netlify.app"
).replace(/\/+$/, "");

const sitemapEntries = ["", "method.html", "requests.html"]
  .map((relative) => `  <url><loc>${esc(`${SITE_URL}/${relative}`)}</loc></url>`)
  .concat(
    data.mods.map(
      (mod) => `  <url><loc>${esc(`${SITE_URL}/mods/${mod.id}.html`)}</loc></url>`
    )
  )
  .concat(
    autoReports.map(
      (report) => `  <url><loc>${esc(`${SITE_URL}/reports/${report.id}.html`)}</loc></url>`
    )
  )
  .join("\n");

writeFile(
  path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries}\n</urlset>\n`
);

writeFile(
  path.join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /admin.html\nSitemap: ${SITE_URL}/sitemap.xml\n`
);

writeFile(
  path.join(OUT, "404.html"),
  pageShell({
    title: "Not found — Puck Workshop audit",
    description: "That page is not in the ledger. Return to the audit index.",
    current: "",
    prefix: "/",
    main: `<div class="shell page-enter">
<header class="page-hero">
  <div>
    <p class="eyebrow"><span class="eyebrow-index">404</span><span class="eyebrow-sep" aria-hidden="true">/</span><span>Not in the ledger</span></p>
    <h1>No record at this address.</h1>
    <p class="page-lede">The page may have been removed from the ledger, or the link is wrong. Every current record is listed on the index.</p>
    <div class="hero-actions">
      <a class="btn btn--primary" href="/index.html">Back to the ${counts.total} records</a>
      <a class="text-link" href="/method.html">Read the method</a>
    </div>
  </div>
</header>
</div>`,
  })
);

const htmlFiles = ["index.html", "method.html", "requests.html", "admin.html", "404.html"].concat(
  data.mods.map((mod) => `mods/${mod.id}.html`)
);

let totalBytes = 0;
for (const relative of htmlFiles) {
  totalBytes += fs.statSync(path.join(OUT, relative)).size;
}
for (const asset of ["style.css", "app.js", "favicon.svg"]) {
  totalBytes += fs.statSync(path.join(OUT_ASSETS, asset)).size;
}

console.log(`Output: ${path.relative(ROOT, OUT) || "."}`);
console.log(`Source data: ${path.relative(ROOT, dataPath) || "site.json"}`);
console.log(`Wrote ${htmlFiles.length} HTML pages (${data.mods.length} mod records).`);
if (hiddenMods.size) console.log(`Hidden mods: ${[...hiddenMods].join(", ")}`);
if (pendingRequests.length) console.log(`Requested mods listed: ${pendingRequests.length}.`);
if (staleItems.length) console.log(`Stale (Workshop moved): ${staleItems.length}.`);
console.log(`Wrote 3 assets. Generated page/asset bytes: ${totalBytes.toLocaleString("en-US")}.`);
console.log(`Audit snapshot: ${data.auditDate} · ${data.mods.length} mods.`);

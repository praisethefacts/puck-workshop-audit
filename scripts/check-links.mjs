import fs from "node:fs";
import path from "node:path";

// Internal link check for the generated site: every relative href/src must resolve
// to a file in dist/, and every in-page fragment must exist on the target page.
// External links are intentionally ignored (the site has no external dependencies
// that would make CI flaky); the release checklist covers those by hand.

const OUT = path.resolve(process.argv[2] || "dist");
const problems = [];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const files = walk(OUT).filter((file) => file.endsWith(".html"));
const pages = new Map(
  files.map((file) => [path.relative(OUT, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8")])
);

const idsOf = (html) => {
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
};
const cache = new Map();
const idsFor = (pageKey) => {
  if (!cache.has(pageKey)) cache.set(pageKey, idsOf(pages.get(pageKey) || ""));
  return cache.get(pageKey);
};

const resolveTarget = (fromKey, target) => {
  const clean = target.split("#")[0].split("?")[0];
  if (!clean) return fromKey;
  const base = clean.startsWith("/") ? "" : path.posix.dirname(fromKey);
  return path.posix.normalize(path.posix.join(base === "." ? "" : base, clean.replace(/^\//, "")));
};

for (const [key, html] of pages) {
  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = match[1];
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(raw)) {
      if (raw.startsWith("#") && raw.length > 1 && !idsFor(key).has(raw.slice(1))) {
        problems.push(`${key}: missing anchor "${raw}"`);
      }
      continue;
    }
    const [target, fragment] = raw.split("#");
    const resolved = resolveTarget(key, target);
    const candidate = resolved === "" ? "index.html" : resolved;
    const file = path.join(OUT, candidate);
    const hitsFile = fs.existsSync(file);
    const hitsDir = !hitsFile && fs.existsSync(file + ".html");
    if (!hitsFile && !hitsDir) {
      problems.push(`${key}: broken link "${raw}" -> ${candidate}`);
      continue;
    }
    if (fragment && (hitsFile || hitsDir)) {
      const pageKey = hitsDir ? `${candidate}.html` : candidate;
      if (!idsFor(pageKey).has(fragment)) problems.push(`${key}: missing anchor "${raw}"`);
    }
  }
}

for (const required of ["index.html", "method.html", "requests.html", "404.html", "sitemap.xml", "robots.txt"]) {
  if (!fs.existsSync(path.join(OUT, required))) problems.push(`missing required file: ${required}`);
}

if (problems.length) {
  console.error(`${problems.length} link problem(s):`);
  for (const problem of problems.slice(0, 25)) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(`${pages.size} pages checked: all internal links and anchors resolve.`);

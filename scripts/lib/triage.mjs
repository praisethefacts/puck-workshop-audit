// Static triage for a downloaded Workshop mod.
// Deterministic: hashes, PE structure, strings, indicator patterns.
// This is deliberately conservative: it reports what it can see and says so.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_ANALYSED_FILE_BYTES = 96 * 1024 * 1024; // per file
const STRING_SCAN_LIMIT = 8 * 1024 * 1024; // bytes per file for string extraction
const MAX_STRINGS = 4000;

const INDICATORS = [
  // shells / lolbins
  { id: "shell-exec", label: "Shell or LOLBin execution string", sev: 3, re: /\b(powershell(?:\.exe)?|pwsh|cmd\.exe|mshta(?:\.exe)?|rundll32(?:\.exe)?|regsvr32(?:\.exe)?|bitsadmin|certutil|schtasks|wmic)\b/i },
  { id: "destructive-cmd", label: "Shadow-copy / boot / defender tampering command", sev: 4, re: /\b(vssadmin|bcdedit|wbadmin|netsh\s+advfirewall|Set-MpPreference|DisableRealtimeMonitoring)\b/i },
  // credential and wallet targets
  { id: "browser-login", label: "Browser credential database reference", sev: 4, re: /(Login Data|Web Data|Local State|Cookies|History)\b.*(sqlite|leveldb|chromium|chrome|edge|brave)|\\Google\\Chrome\\User Data|\\Microsoft\\Edge\\User Data/i },
  { id: "wallet", label: "Crypto wallet path reference", sev: 5, re: /(wallet\.dat|Exodus[\\/]|MetaMask|Phantom[\\/]|Electrum[\\/]|Coinbase[\\/]|Keplr|Trust\s*Wallet)/i },
  { id: "discord-token", label: "Discord token storage reference", sev: 5, re: /(discord[\\/]Local Storage|leveldb|discordcanary|discordptb)/i },
  { id: "steam-session", label: "Steam session / SSFN / config reference", sev: 4, re: /(loginusers\.vdf|ssfn\d*|config[\\/]config\.vdf|Steam\\config|SteamID64)/i },
  // input capture / screen
  { id: "keylog", label: "Keystroke or clipboard capture API", sev: 4, re: /\b(GetAsyncKeyState|SetWindowsHookEx|GetKeyboardState|OpenClipboard|GetClipboardData)\b/ },
  { id: "screen-capture", label: "Screen capture API", sev: 2, re: /\b(BitBlt|PrintWindow|GetDC|CaptureScreenshot)\b/ },
  // injection / loading
  { id: "injection", label: "Process injection API", sev: 5, re: /\b(VirtualAllocEx|WriteProcessMemory|CreateRemoteThread|NtCreateThreadEx|QueueUserAPC|SetThreadContext)\b/ },
  { id: "dynamic-load", label: "Dynamic code loading", sev: 3, re: /\b(Assembly\.Load|LoadFrom\(|FromBase64String|AppDomain\.CurrentDomain\.Load|new\s+Function\()/ },
  { id: "native-call", label: "Native P/Invoke into kernel32/user32/advapi32", sev: 2, re: /\b(kernel32|user32|advapi32|ntdll|winhttp|wininet)\b/i },
  // persistence / filesystem
  { id: "run-key", label: "Run-key or startup persistence", sev: 5, re: /(CurrentVersion\\Run|\\RunOnce|Startup\\|shell:startup|StartupApproved)/i },
  { id: "wide-write", label: "Writes outside the mod folder (AppData/ProgramData/Temp)", sev: 3, re: /(%APPDATA%|%LOCALAPPDATA%|Environment\.GetFolderPath\(\s*"ApplicationData"\)|AppData\\Roaming|AppData\\Local|ProgramData\\|GetTempPath)/i },
  // crypto / ransom / miner
  { id: "crypto", label: "Encryption API in use", sev: 2, re: /\b(Aes|Rijndael|CryptoStream|Rfc2898DeriveBytes|ProtectedData|BigInteger\s*\()\b/ },
  { id: "ransom", label: "File-encryption / ransom markers", sev: 5, re: /(encrypt(?:ed|ion)?\s+(?:all|your)\s+files|readme.*(?:decrypt|btc|monero)|\.locked\b|ransom)/i },
  { id: "miner", label: "Miner markers", sev: 5, re: /(stratum\+tcp|stratum\+ssl|xmrig|monero|randomx|cryptonight|nicehash)/i },
  // network
  { id: "raw-ip", label: "Hardcoded IPv4 endpoint", sev: 3, re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, skip: (value) => /^v?\d+(?:\.\d+){3,}$/i.test(value.trim()) },
  { id: "http", label: "HTTP(S) endpoint", sev: 1, re: /https?:\/\/[^\s"'<>)]{6,}/i },
  { id: "webhook", label: "Discord webhook / paste / exfil style endpoint", sev: 5, re: /(discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|pastebin\.com\/raw|transfer\.sh|anonfiles|gofile\.io|ngrok\.io)/i },
  { id: "process-start", label: "Launches external processes", sev: 2, re: /\b(Process\.Start|UseShellExecute\s*=\s*true|ShellExecute(?:Ex)?)\b/ },
  { id: "registry-write", label: "Registry writes", sev: 3, re: /\b(Registry\.CurrentUser|RegistryKey|SetValue\s*\(|HKEY_CURRENT_USER)\b/ },
];

// Strings that look scary but are normal for a Unity game mod.
const BENIGN_CONTEXT = [
  /UnityEngine/i, /Steamworks/i, /0Harmony/i, /com\.rlabrecque/i, /Newtonsoft/i,
  /puck/i, /hockey/i, /\.puckclip/i, /Prefs\b/, /PlayerPrefs/,
];

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function entropy(buf) {
  if (!buf.length) return 0;
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let e = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / buf.length;
    e -= p * Math.log2(p);
  }
  return Math.round(e * 100) / 100;
}

export function peInfo(buf) {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
  const lfanew = buf.readUInt32LE(0x3c);
  if (lfanew + 0x18 > buf.length) return null;
  if (buf.toString("latin1", lfanew, lfanew + 4) !== "PE\0\0") return null;
  const machine = buf.readUInt16LE(lfanew + 4);
  const numSections = buf.readUInt16LE(lfanew + 6);
  const timestamp = buf.readUInt32LE(lfanew + 8);
  const optSize = buf.readUInt16LE(lfanew + 20);
  const characteristics = buf.readUInt16LE(lfanew + 22);
  const optOff = lfanew + 24;
  const magic = optOff + 2 <= buf.length ? buf.readUInt16LE(optOff) : 0;
  const pe32plus = magic === 0x20b;
  const ddOff = optOff + (pe32plus ? 112 : 96);
  let cliRva = 0, cliSize = 0;
  if (ddOff + 15 * 8 <= buf.length) {
    cliRva = buf.readUInt32LE(ddOff + 14 * 8);
    cliSize = buf.readUInt32LE(ddOff + 14 * 8 + 4);
  }
  const sections = [];
  const secOff = optOff + optSize;
  let maxRawEnd = 0;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    if (o + 40 > buf.length) break;
    const name = buf.toString("latin1", o, o + 8).replace(/\0+$/, "").trim();
    const vsize = buf.readUInt32LE(o + 8);
    const rawSize = buf.readUInt32LE(o + 16);
    const rawPtr = buf.readUInt32LE(o + 20);
    const secChars = buf.readUInt32LE(o + 36);
    const raw = rawPtr + rawSize <= buf.length ? buf.subarray(rawPtr, rawPtr + rawSize) : Buffer.alloc(0);
    sections.push({
      name, vsize, rawSize, entropy: entropy(raw),
      executable: !!(secChars & 0x20000000),
      writable: !!(secChars & 0x80000000),
    });
    maxRawEnd = Math.max(maxRawEnd, rawPtr + rawSize);
  }
  return {
    machine, timestamp, numSections, characteristics,
    bitness: pe32plus ? 64 : 32,
    dotnet: cliRva !== 0,
    sections,
    overlay: Math.max(0, buf.length - maxRawEnd),
  };
}

function decodeUtf16(buf) {
  if (buf.length % 2) buf = buf.subarray(0, buf.length - 1);
  return buf.toString("utf16le");
}

export function extractStrings(buf) {
  const limit = Math.min(buf.length, STRING_SCAN_LIMIT);
  const slice = buf.subarray(0, limit);
  const ascii = slice.toString("latin1");
  const utf16 = decodeUtf16(slice);
  const found = new Set();
  const re = /[\x20-\x7e]{5,}/g;
  for (const src of [ascii, utf16]) {
    let m;
    while ((m = re.exec(src)) && found.size < MAX_STRINGS) {
      const s = m[0].trim();
      if (s.length >= 5 && s.length <= 400) found.add(s);
    }
  }
  return [...found];
}

function scanIndicators(strings) {
  const hits = new Map();
  for (const s of strings) {
    for (const ind of INDICATORS) {
      if (ind.skip && ind.skip(s)) continue;
      if (ind.re.test(s)) {
        if (!hits.has(ind.id)) hits.set(ind.id, { ...ind, samples: [] });
        const entry = hits.get(ind.id);
        if (entry.samples.length < 3 && !entry.samples.includes(s)) entry.samples.push(s.slice(0, 180));
      }
    }
  }
  return [...hits.values()];
}

const SKIP_DIRS = /^(\.git|\.netlify|node_modules)$/i;

export function analyzeDirectory(root, meta = {}) {
  const started = Date.now();
  const files = walk(root).filter((f) => !SKIP_DIRS.test(path.basename(path.dirname(f))));
  const inventory = [];
  const binaries = [];
  const findings = [];
  let analysedCount = 0;
  let skipped = 0;

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const size = fs.statSync(file).size;
    const ext = path.extname(file).toLowerCase();
    const entry = { path: rel, size, sha256: sha256File(file) };
    inventory.push(entry);
    if (size > MAX_ANALYSED_FILE_BYTES) { skipped++; entry.skipped = "over-size"; continue; }
    const head = Buffer.alloc(Math.min(size, 4096));
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    const isPe = head[0] === 0x4d && head[1] === 0x5a;
    const isCode = isPe || [".dll", ".exe", ".node", ".js", ".mjs", ".ps1", ".bat", ".cmd", ".vbs", ".lnk", ".cs"].includes(ext);
    if (!isCode) continue;
    analysedCount++;
    const buf = fs.readFileSync(file);
    const pe = isPe ? peInfo(buf) : null;
    const strings = extractStrings(buf);
    const indicators = scanIndicators(strings);
    const benign = BENIGN_CONTEXT.filter((re) => strings.some((s) => re.test(s))).length;
    const binary = {
      path: rel, size, sha256: entry.sha256, kind: pe ? (pe.dotnet ? "managed .NET" : "native PE") : ext.slice(1) || "text",
      pe, indicators: indicators.map(({ id, label, sev, samples }) => ({ id, label, severity: sev, samples })),
      stringCount: strings.length, benignMarkers: benign,
    };
    binaries.push(binary);
    for (const ind of indicators) {
      const already = findings.find((f) => f.id === ind.id && f.file === rel);
      if (already) continue;
      findings.push({
        id: ind.id, file: rel, severity: ind.sev, label: ind.label,
        samples: ind.samples.slice(0, 2),
        benignContext: benign > 0 && ind.sev <= 2,
      });
    }
    if (pe && pe.dotnet && pe.overlay > 65536) {
      findings.push({ id: "overlay", file: rel, severity: 3, label: "Managed assembly carries appended data", samples: [`overlay: ${pe.overlay} bytes`] });
    }
    for (const sec of pe ? pe.sections : []) {
      if (sec.entropy > 7.3 && sec.rawSize > 2048) {
        findings.push({ id: "packed-section", file: rel, severity: 2, label: `High-entropy section .${sec.name} (${sec.entropy})`, samples: [] });
      }
    }
  }

  // score: strongest per category, ignore benign-context low-sev items
  const scored = findings.filter((f) => !f.benignContext);
  const maxPerId = new Map();
  for (const f of scored) maxPerId.set(f.id, Math.max(maxPerId.get(f.id) || 0, f.severity));
  let score = 0;
  for (const v of maxPerId.values()) score += v;
  if (findings.some((f) => f.id === "ransom" || f.id === "miner" || f.id === "wallet" || f.id === "discord-token" || f.id === "injection")) score = Math.max(score, 14);
  score = Math.min(100, score * 4);

  let verdict;
  if (score >= 56) verdict = "HIGH RISK - do not run";
  else if (score >= 36) verdict = "SUSPICIOUS";
  else if (score >= 16) verdict = "REVIEW";
  else verdict = "NO OBVIOUS INDICATORS";

  const hashes = inventory.map((i) => "`" + i.sha256.slice(0, 16) + "` " + i.path).slice(0, 40);

  return {
    meta, verdict, score, automated: true,
    generatedAt: new Date().toISOString(),
    analysisMs: Date.now() - started,
    root, files: inventory.length, bytes: inventory.reduce((a, b) => a + b.size, 0),
    codeFiles: analysedCount, skippedFiles: skipped,
    inventory, binaries, findings: scored.map((f) => ({ ...f, samples: f.samples })),
    hashes,
  };
}

export function toMarkdown(report) {
  const m = report.meta || {};
  const item = m.title || `Workshop item ${m.id}`;
  const lines = [];
  lines.push(`# ${item} — automated triage`);
  lines.push("");
  lines.push(`**Verdict:** ${report.verdict} — automated score ${report.score}/100`);
  lines.push("");
  lines.push("> This report was produced by an automated static scanner, not a manual audit. It lists");
  lines.push("> machine-checkable indicators in the shipped files. Nothing here is executed, and a low");
  lines.push("> score is not a guarantee of safety. Manual reports supersede this when they exist.");
  lines.push("");
  lines.push(`- Workshop id: ${m.id}`);
  lines.push(`- Title: ${m.title || "(unknown)"}`);
  lines.push(`- Creator: ${m.creator || "(unknown)"}`);
  lines.push(`- Created / updated: ${m.timeCreatedHuman || "?"} / ${m.timeUpdatedHuman || "?"}`);
  lines.push(`- Reported size: ${m.fileSize ? m.fileSize + " B" : "?"}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Files: ${report.files}, bytes hashed: ${report.bytes}`);
  lines.push("");
  lines.push("## Files and hashes");
  lines.push("");
  for (const f of report.inventory.slice(0, 60)) {
    lines.push(`- \`${f.sha256}\` ${f.size} B — ${f.path}`);
  }
  if (report.inventory.length > 60) lines.push(`- … ${report.inventory.length - 60} more`);
  lines.push("");
  lines.push("## Binaries");
  lines.push("");
  if (!report.binaries.length) lines.push("No code files were found in this item.");
  for (const b of report.binaries) {
    const pe = b.pe ? `PE${b.pe.bitness}${b.pe.dotnet ? " .NET" : " native"}, ${b.pe.sections.length} sections, overlay ${b.pe.overlay} B` : b.kind;
    lines.push(`- **${b.path}** — ${b.size} B, ${pe}, sha256 \`${b.sha256}\``);
    for (const s of b.pe ? b.pe.sections : []) {
      lines.push(`  - section ${s.name}: entropy ${s.entropy}${s.executable ? ", executable" : ""}${s.writable ? ", writable" : ""}`);
    }
    if (b.indicators.length) {
      for (const i of b.indicators) lines.push(`  - indicator ${i.id} (${i.label})${i.samples.length ? ": " + i.samples.map((x) => "`" + x.replace(/`/g, "") + "`").join(", ") : ""}`);
    }
  }
  lines.push("");
  lines.push("## Indicators");
  lines.push("");
  if (!report.findings.length) {
    lines.push("No indicator pattern matched.");
  } else {
    const order = { 5: "critical", 4: "high", 3: "medium", 2: "low", 1: "info" };
    for (const f of [...report.findings].sort((a, b) => b.severity - a.severity)) {
      lines.push(`- **${order[f.severity] || "info"}** — ${f.label} (${f.file})`);
      for (const s of f.samples || []) lines.push(`  - \`${String(s).replace(/`/g, "").slice(0, 180)}\``);
    }
  }
  lines.push("");
  lines.push("## What was checked");
  lines.push("");
  lines.push("- Every file in the published item was hashed with SHA-256.");
  lines.push("- Every PE file was parsed for machine, sections, overlay, entropy and .NET metadata.");
  lines.push("- ASCII and UTF-16 strings were extracted and matched against indicator patterns:");
  lines.push("  shells/LOLBins, credential and wallet stores, input capture, injection, persistence,");
  lines.push("  encryption, miner markers, raw IP endpoints and exfiltration-style webhooks.");
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- Static only: nothing is run. Runtime behaviour and remote payloads are invisible here.");
  lines.push("- Strings can appear in benign libraries; context is judged by a human in a manual audit.");
  lines.push("- A clean automated scan does not prove a mod is safe.");
  return lines.join("\n") + "\n";
}

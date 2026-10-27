// Static triage for a downloaded Workshop mod.
// Deterministic: hashes, PE structure, strings, indicator patterns.
// This is deliberately conservative: it reports what it can see and says so.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_ANALYSED_FILE_BYTES = 96 * 1024 * 1024; // per file
const STRING_SCAN_LIMIT = 8 * 1024 * 1024; // bytes per file for string extraction
const MAX_STRINGS = 4000;

// Decompiler used for the "what did it actually do" half of an automated run.
// ilspycmd is a dotnet tool; set ILSPYCMD to override the path.
const WINDOWS_ILSPYCMD = "C:\\Users\\w4ua\\.dotnet\\tools\\ilspycmd.exe";
const ILSPYCMD = process.env.ILSPYCMD || (fs.existsSync(WINDOWS_ILSPYCMD) ? WINDOWS_ILSPYCMD : "ilspycmd");

const API_NEEDLES = [
  "HttpClient",
  "WebClient",
  "HttpWebRequest",
  "WebRequest",
  "TcpClient",
  "UdpClient",
  "Socket",
  "System.Net",
  "Process.Start",
  "ProcessStartInfo",
  "Registry",
  "Assembly.Load",
  "LoadFrom",
  "DllImport",
  "File.Delete",
  "File.WriteAll",
  "Directory.GetFiles",
  "Environment.GetEnvironmentVariable",
  "Environment.GetFolderPath",
  "GetAsyncKeyState",
  "SetWindowsHookEx",
  "Aes",
  "Rijndael",
  "FromBase64String",
  "Application.OpenURL",
  "Steamworks",
  "SteamFriends",
  "UnityWebRequest",
  "DownloadHandler",
  "Application.persistentDataPath",
  "PersistentDataPath",
  "VoteKick",
  "Harmony",
  "PatchPrefix",
  "PatchPostfix",
];

function runIlspy(args, timeoutMs = 60000) {
  try {
    const stdout = execFileSync(ILSPYCMD, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    // ilspycmd returns non-zero even on success; keep whatever it printed.
    return {
      ok: false,
      stdout: String(err && err.stdout ? err.stdout : ""),
      error: String((err && (err.stderr || err.message)) || err).slice(0, 200),
    };
  }
}

function excerptAround(source, limit = 24) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i];
    const needle = API_NEEDLES.find((entry) => line.includes(entry));
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length, i + 4);
    hits.push({ needle, atLine: i + 1, text: lines.slice(from, to).join("\n") });
  }
  return hits;
}

export function decompileManaged(file, options = {}) {
  const maxSourceBytes = options.maxSourceBytes || 200000;
  const result = { available: false, tool: "ilspycmd", command: `ilspycmd -p -o <out> "${path.basename(file)}"` };
  if (!fs.existsSync(ILSPYCMD)) {
    result.error = `ilspycmd not found at ${ILSPYCMD}`;
    return result;
  }

  const typesOut = runIlspy(["-l", "c", file]);
  const classes = typesOut.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^Class\s+/.test(line))
    .map((line) => line.replace(/^Class\s+/, ""));

  let methodCount = 0;
  const tableOut = runIlspy(["--dump-table", "MethodDef", "--json", file]);
  try {
    const parsed = JSON.parse(tableOut.stdout);
    methodCount = Number(parsed.rowCount) || (Array.isArray(parsed.rows) ? parsed.rows.length : 0);
  } catch {
    methodCount = 0;
  }

  const decompiled = runIlspy([file], 120000);
  const source = decompiled.stdout.slice(0, maxSourceBytes);
  if (!classes.length && !source.trim()) {
    result.error = decompiled.error || typesOut.error || "no decompiler output";
    return result;
  }

  const apiHits = excerptAround(source);
  result.available = true;
  result.typeCount = classes.length;
  result.types = classes.slice(0, 150);
  result.methodCount = methodCount;
  result.sourceBytes = Buffer.byteLength(decompiled.stdout, "utf8");
  result.sourceLines = decompiled.stdout ? decompiled.stdout.split(/\r?\n/).length : 0;
  // Keep the reconstructed C# so the indicator pass can read the code, not just
  // the strings a binary happens to carry. Capped so a huge assembly stays sane.
  result.source = decompiled.stdout ? decompiled.stdout.slice(0, 8 * 1024 * 1024) : "";
  result.apiHits = apiHits.map((hit) => hit.needle);
  result.excerpt = apiHits.map((hit) => `// line ${hit.atLine} - ${hit.needle}\n${hit.text}`).join("\n\n");
  return result;
}

const INDICATORS = [
  // shells / lolbins
  { id: "shell-exec", label: "Shell or LOLBin execution string", sev: 3, re: /\b(powershell(?:\.exe)?|pwsh|cmd\.exe|mshta(?:\.exe)?|rundll32(?:\.exe)?|regsvr32(?:\.exe)?|bitsadmin|certutil|schtasks|wmic)\b/i },
  { id: "destructive-cmd", label: "Shadow-copy / boot / defender tampering command", sev: 4, re: /\b(vssadmin|bcdedit|wbadmin|netsh\s+advfirewall|Set-MpPreference|DisableRealtimeMonitoring)\b/i },
  // credential and wallet targets
  { id: "browser-login", label: "Browser credential database reference", sev: 4, re: /(Login Data|Web Data|Local State|Cookies|History)\b.*(sqlite|leveldb|chromium|chrome|edge|brave)|\\Google\\Chrome\\User Data|\\Microsoft\\Edge\\User Data/i },
  { id: "wallet", label: "Crypto wallet path reference", sev: 5, re: /(wallet\.dat|Exodus[\\/]|MetaMask|Phantom[\\/]|Electrum[\\/]|Coinbase[\\/]|Keplr|Trust\s*Wallet)/i },
  { id: "discord-token", label: "Discord token storage reference", sev: 5, re: /(discord[\\/]Local Storage|leveldb|discordcanary|discordptb)/i },
  { id: "steam-session", label: "Steam session / SSFN / config reference", sev: 2, re: /(loginusers\.vdf|ssfn\d*|config[\\/]config\.vdf|Steam[\\/]config|steamguard|SteamAppTicket|GetAuthTicketForWebApi)/i },
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
  { id: "raw-ip", label: "Hardcoded IPv4 endpoint", sev: 3, re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, skip: (value) => /Version=|PublicKeyToken|\.dll|assembly|^v?\d+(?:\.\d+){3,}$/i.test(value.trim()) },
  { id: "http", label: "HTTP(S) endpoint", sev: 1, re: /https?:\/\/[^\s"'<>)]{6,}/i },
  { id: "webhook", label: "Discord webhook / paste / exfil style endpoint", sev: 5, re: /(discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|pastebin\.com\/raw|transfer\.sh|anonfiles|gofile\.io|ngrok\.io)/i },
  { id: "process-start", label: "Launches external processes", sev: 2, re: /\b(Process\.Start|UseShellExecute\s*=\s*true|ShellExecute(?:Ex)?)\b/ },
  { id: "registry-write", label: "Registry writes", sev: 3, re: /\b(Registry\.CurrentUser|RegistryKey|SetValue\s*\(|HKEY_CURRENT_USER)\b/ },
  { id: "file-write", label: "Writes files at runtime", sev: 1, re: /\b(File\.WriteAllText|File\.WriteAllBytes|File\.AppendAllText|StreamWriter|FileStream\s*\()/ },
  { id: "harmony", label: "Harmony patches into game code", sev: 1, re: /\b(HarmonyPatch|Harmony\.Patch|AccessTools|PatchProcessor)\b/ },

  // --- the things a manual audit actually flags (parity with the hand reports) ---
  // Machine binding / anti-alt detection: a mod that fingerprints the PC is doing
  // something a hockey mod has no need for.
  { id: "hwid-binding", label: "Hardware / machine fingerprinting", sev: 4, re: /(deviceUniqueIdentifier|GetVolumeInformation|volume\s*serial|HWID|hardware\s*id|machine\s*(?:id|guid|fingerprint)|K32EnumProcessModules|EnumProcessModules|GetModuleFileNameEx|GetModuleInformation|ProcessorCount\s*\+|Win32_ComputerSystem)/i },
  // Enumerating the modules loaded into the game is an anti-cheat/telemetry shape:
  // it tells the author which other mods (and patches) you run.
  { id: "module-enumeration", label: "Enumerates loaded modules / assemblies", sev: 3, re: /(K32EnumProcessModules|EnumProcessModules|K32GetModuleFileNameExW|GetModuleFileNameEx|GetModuleInformation)/ },
  // Account identity leaving the game: SteamID + a network call in the same item.
  { id: "steam-identity", label: "Steam account identity in code/data", sev: 3, re: /(steamId64|SteamID64|GetSteamID\(\)|m_SteamID|SteamId\b|GetAuthTicketForWebApi|ISteamUser)/ },
  { id: "telemetry", label: "Telemetry / analytics payload", sev: 3, re: /(analytics|telemetry|heartbeat|usage\s*data|usage\s*ping|trackEvent)/i },
  // Endpoints that are not TLS or not resolvable to a domain are a manual-audit red flag.
  { id: "plain-http", label: "Unencrypted HTTP endpoint", sev: 3, re: /\bhttp:\/\/[^\s"'<>)]{4,}/i },
  { id: "ip-endpoint", label: "Endpoint addressed by raw IP", sev: 4, re: /(?:https?|wss?):\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/i },
  { id: "credential-store", label: "Password / token cache on disk", sev: 4, re: /(SavedServerPasswords|password[s]?\s*(?:cache|store|file|json|list)|savePassword|credential[s]?\s*(?:cache|store|file|json))/i },
  // Browser engine embedded in a game mod = remote content and remote JS.
  { id: "browser-embed", label: "Embedded browser engine (WebView/CEF)", sev: 2, re: /(WebView|CefSharp|CefSharpWrapper|ChromiumWebBrowser|uBlock|\.crx\b)/i },
  { id: "remote-content", label: "Loads remote pages or executes remote JS", sev: 3, re: /(LoadURL|LoadPage|Navigate\s*\(\s*"https?:|EvaluateJavascript|ExecuteJavaScript|RemoteMOTD|motd)/i },
  // Mods that load third-party bundles filled at runtime are a capability, not malware.
  { id: "remote-bundle", label: "Runtime bundle / payload loading", sev: 2, re: /(AssetBundle\.LoadFromFile|LoadFromFile\s*\(|\.abx\b|decrypt.*bundle|bundle.*decrypt)/i },
  { id: "base64-payload", label: "Base64-encoded payload strings", sev: 2, re: /(FromBase64String|Convert\.ToBase64String|base64)/i },

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

// Signals that a managed assembly was run through an obfuscator. A hand audit
// treats "the code is unreadable on purpose" as a real finding, so the scanner
// has to see it too, not just long strings.
function obfuscationSignals(source) {
  if (!source) return { junk: 0, blobs: 0, escapes: 0, lines: 0, ratio: 0 };
  const junk = (source.match(/\b_[0-9A-F]{3,10}\b/g) || []).length;
  const blobs = (source.match(/\b[A-Fa-f0-9]{32,}\b/g) || []).length;
  const escapes = (source.match(/\\u[0-9A-Fa-f]{4}/g) || []).length;
  const lines = source.split(/\r?\n/).length || 1;
  // Obfuscated assemblies are dominated by escaped literals and renamed
  // identifiers; a normal mod that touches a few \u escapes sits far below this.
  const ratio = (escapes + junk * 4) / lines;
  return { junk, blobs, escapes, lines, ratio: Math.round(ratio * 1000) / 1000 };
}

// Capability buckets: the same vocabulary the hand-written reports use. Each
// bucket contributes a fixed weight, and extra severity inside a bucket bumps it
// a little, so a mod cannot reach the suspicious band on one weak hint alone.
const CAPABILITIES = [
  { key: "hostile", label: "Hostile primitives (wallet/token theft, ransom, miner, injection)", weight: 26, ids: ["wallet", "discord-token", "ransom", "miner", "injection", "destructive-cmd", "run-key"] },
  { key: "credentials", label: "Credential or session access", weight: 18, ids: ["browser-login", "keylog", "screen-capture"] },
  { key: "obfuscation", label: "Deliberately obfuscated code", weight: 20, ids: ["obfuscated-code"] },
  { key: "fingerprinting", label: "Machine/account fingerprinting", weight: 12, ids: ["hwid-binding", "steam-identity"] },
  { key: "anti-cheat", label: "Loaded-module enumeration / anti-cheat snapshot", weight: 8, ids: ["module-enumeration"] },
  { key: "c2", label: "Outbound network with telemetry/C2 shape", weight: 8, ids: ["ip-endpoint", "plain-http", "webhook", "telemetry", "raw-ip"] },
  { key: "credential-cache", label: "Passwords/secrets cached in plain files", weight: 6, ids: ["credential-store", "steam-session"] },
  { key: "encrypted-payload", label: "Encrypted / encoded payload handling", weight: 4, ids: ["crypto", "base64-payload", "remote-bundle"] },
  { key: "crypto", label: "Encryption in use", weight: 6, ids: ["crypto"] },
  { key: "code-loading", label: "Executable content loaded at runtime", weight: 1, ids: ["dynamic-load", "browser-embed", "remote-content"] },
  { key: "filesystem", label: "Writes outside the mod folder / registry", weight: 1, ids: ["wide-write", "registry-write", "file-write"] },
  { key: "shell", label: "Launches external processes", weight: 1, ids: ["shell-exec", "process-start"] },
  { key: "native", label: "Native code / P/Invoke", weight: 1, ids: ["native-call"] },
  { key: "binary-anomaly", label: "Packed sections or appended data", weight: 1, ids: ["packed-section", "overlay"] },
  { key: "patches", label: "Harmony patches into game code", weight: 1, ids: ["harmony"] },
];

// Manual rubric: 0-15 clean, 16-30 benign with caveats, 31-50 suspicious,
// 51+ treat as hostile. Same bands as the hand reports.
export function manualVerdict(score) {
  if (score >= 51) return "HIGH RISK - treat as hostile";
  if (score >= 31) return "SUSPICIOUS";
  if (score >= 16) return "BENIGN WITH CAVEATS";
  return "CLEAN";
}

function deriveCapabilities(findings) {
  const caps = [];
  for (const cap of CAPABILITIES) {
    const hits = findings.filter((f) => cap.ids.includes(f.id));
    if (!hits.length) continue;
    const maxSev = Math.max(...hits.map((h) => h.severity));
    let weight = cap.weight;
    // A single weak hint should not move a whole bucket: encryption alone is
    // not "encrypted payload handling", and fingerprinting only bites when the
    // identity actually leaves the machine.
    if (cap.key === "encrypted-payload") {
      const strong = hits.some((h) => ["base64-payload", "remote-bundle"].includes(h.id)) && findings.some((f) => f.id === "crypto");
      weight = strong ? 16 : 4;
    }
    if (cap.key === "crypto" && findings.some((f) => f.id === "encrypted-payload")) weight = 6;
    const bump = maxSev >= 4 ? 2 : 0;
    caps.push({ key: cap.key, label: cap.label, weight, bump, ids: [...new Set(hits.map((h) => h.id))], count: hits.length });
  }
  // Manual reports put a whole mod in one band; summing every hint would push
  // ordinary mods into "suspicious". Count the minor buckets at most four
  // points total, then damp the sum so the bands line up with the hand reports.
  const minor = new Set(["code-loading", "filesystem", "shell", "native", "binary-anomaly", "patches"]);
  const majorScore = caps.filter((c) => !minor.has(c.key)).reduce((s, c) => s + c.weight + c.bump, 0);
  const minorScore = Math.min(4, caps.filter((c) => minor.has(c.key)).reduce((s, c) => s + c.weight + c.bump, 0));
  const score = Math.min(100, Math.round((majorScore + minorScore) * 0.8));
  return { capabilities: caps, score };
}


export function analyzeDirectory(root, meta = {}, options = {}) {
  const started = Date.now();
  const decompileEnabled = options.decompile !== false;
  const files = walk(root).filter((f) => !SKIP_DIRS.test(path.basename(path.dirname(f))));
  const inventory = [];
  const binaries = [];
  const findings = [];
  const endpointTexts = [];
  const techniqueTexts = [];
  const notableStrings = new Set();
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
    techniqueTexts.push(strings.join("\n"));
    endpointTexts.push(strings.join("\n"));
    for (const s of strings) { if (s.length >= 12 && s.length <= 140 && /(fingerprint|integrity|hwid|steam\s*id|steamid|api[-_ ]?key|telemetry|analytics|heartbeat|report[\s_-]?(?:plugin|integrity))/i.test(s)) notableStrings.add(s.trim()); }
    const indicators = scanIndicators(strings);
    const benign = BENIGN_CONTEXT.filter((re) => strings.some((s) => re.test(s))).length;
    const binary = {
      path: rel, size, sha256: entry.sha256, kind: pe ? (pe.dotnet ? "managed .NET" : "native PE") : ext.slice(1) || "text",
      pe, indicators: indicators.map(({ id, label, sev, samples }) => ({ id, label, severity: sev, samples })),
      stringCount: strings.length, benignMarkers: benign,
    };
    binaries.push(binary);
    if (pe && pe.dotnet && decompileEnabled) {
      binary.decompile = decompileManaged(file);
      if (binary.decompile && binary.decompile.available) {
        const sig = obfuscationSignals(binary.decompile.source);
        const weight = Math.round(sig.ratio * 100) + Math.round(sig.blobs / 4);
        binary.obfuscation = { ...sig, weight };
        if (sig.ratio >= 0.15 && sig.escapes >= 60) {
          findings.push({
            id: "obfuscated-code",
            file: rel,
            severity: sig.ratio >= 0.3 ? 4 : 3,
            label: "Obfuscated managed assembly (renamed types/methods, packed string table)",
            samples: [`${sig.junk} junk identifiers, ${sig.blobs} hex blobs, ${sig.escapes} unicode escapes over ${sig.lines} lines`],
          });
        }
        // Read the decompiled code with the same indicator list used for raw
        // strings: a hand audit reads the code, so the scanner should too.
        const codeLines = binary.decompile.source ? binary.decompile.source.split(/\r?\n/) : [];
        const codeIndicators = scanIndicators(codeLines);
        binary.codeIndicators = codeIndicators.map(({ id, label, sev, samples }) => ({ id, label, severity: sev, samples }));
        techniqueTexts.push(binary.decompile.source || "");
        endpointTexts.push(binary.decompile.source || "");
        const literals = (binary.decompile.source || "").match(/"([^"\n\r]{12,140})"/g) || [];
        for (const lit of literals) { const value = lit.slice(1, -1); if (/(fingerprint|integrity|hwid|steam\s*id|steamid|api[-_ ]?key|telemetry|analytics|heartbeat|report[\s_-]?(?:plugin|integrity))/i.test(value)) notableStrings.add(value); }
        for (const ind of codeIndicators) {
          if (findings.some((f) => f.id === ind.id)) continue;
          findings.push({
            id: ind.id,
            file: rel,
            severity: ind.sev,
            label: ind.label,
            samples: ind.samples.slice(0, 2),
            source: "decompiled",
            benignContext: ind.sev <= 1 && benign > 0,
          });
        }
      }
    }
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

  // Scoring mirrors the hand-audit rubric: capability buckets with fixed
  // weights, same 0-15 / 16-30 / 31-50 / 51+ bands, so an automated report and a
  // manual report of the same build land in the same band.
  const scored = findings.filter((f) => !f.benignContext);
  const { capabilities, score } = deriveCapabilities(scored);
  const verdict = manualVerdict(score);

  const hashes = inventory.map((i) => "`" + i.sha256.slice(0, 16) + "` " + i.path).slice(0, 40);

  return {
    meta, verdict, score, automated: true,
    rubric: "manual-parity",
    capabilities,
    generatedAt: new Date().toISOString(),
    analysisMs: Date.now() - started,
    root, files: inventory.length, bytes: inventory.reduce((a, b) => a + b.size, 0),
    codeFiles: analysedCount, skippedFiles: skipped,
    inventory, binaries, findings: scored.map((f) => ({ ...f, samples: f.samples })),
    hashes,
    techniques: detectTechniques(techniqueTexts),
    endpoints: extractEndpoints(endpointTexts),
    notableStrings: [...notableStrings].slice(0, 8),
  };
}

export function toMarkdownLegacy(report) {
  const m = report.meta || {};
  const item = m.title || `Workshop item ${m.id}`;
  const lines = [];
  lines.push(`# ${item}  -  automated triage`);
  lines.push("");
  lines.push(`**Verdict:** ${report.verdict}  -  automated score ${report.score}/100`);
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
  lines.push(`- Generated: ${formatWhen(report.generatedAt)}`);
  lines.push(`- Files: ${report.files}, bytes hashed: ${report.bytes}`);
  lines.push("");
  lines.push("## Files and hashes");
  lines.push("");
  for (const f of report.inventory.slice(0, 60)) {
    lines.push(`- \`${f.sha256}\` ${f.size} B  -  ${f.path}`);
  }
  if (report.inventory.length > 60) lines.push(`- ... ${report.inventory.length - 60} more`);
  lines.push("");
  lines.push("## Binaries");
  lines.push("");
  if (!report.binaries.length) lines.push("No code files were found in this item.");
  for (const b of report.binaries) {
    const pe = b.pe ? `PE${b.pe.bitness}${b.pe.dotnet ? " .NET" : " native"}, ${b.pe.sections.length} sections, overlay ${b.pe.overlay} B` : b.kind;
    lines.push(`- **${b.path}**  -  ${b.size} B, ${pe}, sha256 \`${b.sha256}\``);
    for (const s of b.pe ? b.pe.sections : []) {
      lines.push(`  - section ${s.name}: entropy ${s.entropy}${s.executable ? ", executable" : ""}${s.writable ? ", writable" : ""}`);
    }
    if (b.indicators.length) {
      for (const i of b.indicators) lines.push(`  - indicator ${i.id} (${i.label})${i.samples.length ? ": " + i.samples.map((x) => "`" + x.replace(/`/g, "") + "`").join(", ") : ""}`);
    }
  }
  lines.push("");
  lines.push("## Capabilities observed");
  lines.push("");
  lines.push("Same vocabulary and the same 0-100 rubric as the hand-written reports: 0-15 clean,");
  lines.push("16-30 benign with caveats, 31-50 suspicious, 51+ treat as hostile. A capability is");
  lines.push("listed when a machine-checkable pattern for it was present in the shipped bytes.");
  lines.push("");
  const caps = report.capabilities || [];
  if (!caps.length) {
    lines.push("- No capability pattern matched. The files are asset data or ordinary mod code.");
  } else {
    for (const c of [...caps].sort((a, b) => b.weight - a.weight)) {
      lines.push(`- **${c.label}**  -  ${c.weight + c.bump}/100 weight${c.ids.length ? `, evidence: ${c.ids.join(", ")}` : ""}`);
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
      lines.push(`- **${order[f.severity] || "info"}**  -  ${f.label} (${f.file})`);
      for (const s of f.samples || []) lines.push(`  - \`${String(s).replace(/`/g, "").slice(0, 180)}\``);
    }
  }
  lines.push("");
  lines.push("## Decompiled with ILSpy");
  lines.push("");
  const decompiled = report.binaries.filter((b) => b.decompile && b.decompile.available);
  if (!decompiled.length) {
    lines.push("No managed .NET assembly was decompiled in this item.");
  } else {
    lines.push("Managed assemblies were opened with `ilspycmd` (ICSharpCode.Decompiler) so the report can show");
    lines.push("what the code actually contains, not only which strings it carries.");
    for (const b of decompiled) {
      const d = b.decompile;
      lines.push("");
      lines.push(`### ${b.path}`);
      lines.push("");
      lines.push(`- ILSpy: ${d.typeCount} types, ${d.methodCount} methods, ${d.sourceLines} lines of C# reconstructed`);
      if (d.apiHits && d.apiHits.length) {
        lines.push(`- API surface used: ${d.apiHits.map((h) => "`" + h + "`").join(", ")}`);
      }
      lines.push(`- Types: ${d.types.slice(0, 40).map((t) => "`" + t + "`").join(", ")}${d.typeCount > 40 ? ", ..." : ""}`);
      if (d.excerpt) {
        lines.push("");
        lines.push("```csharp");
        lines.push(d.excerpt.slice(0, 4000));
        lines.push("```");
      }
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

// ---------------------------------------------------------------------------
// Report body shaped like a hand audit: What it is / Contents / Code analysis /
// Findings / Evidence trail / Bottom line. Everything is derived from what the
// scanner could actually verify, and the text says so where evidence is thin.
// ---------------------------------------------------------------------------

const TECHNIQUES = [
  { group: "identity", re: /GetVolumeInformation/i, text: "`GetVolumeInformation` (disk volume serial)" },
  { group: "identity", re: /deviceUniqueIdentifier/i, text: "`SystemInfo.deviceUniqueIdentifier`" },
  { group: "identity", re: /GetEnvironmentVariables?\s*\(/i, text: "environment variables" },
  { group: "identity", re: /SteamID64|SteamId64|GetSteamID\s*\(|m_SteamID|GetAuthTicketForWebApi/, text: "Steam account identity (SteamID64)" },
  { group: "modules", re: /K32EnumProcessModulesEx|EnumProcessModules|K32GetModuleFileNameExW|GetModuleFileNameEx|GetModuleInformation/, text: "loaded-module enumeration (`K32EnumProcessModulesEx` / `K32GetModuleFileNameExW`)" },
  { group: "loading", re: /Assembly\.Load|AppDomain\.CurrentDomain\.Load|LoadFrom\s*\(/, text: "runtime assembly loading" },
  { group: "loading", re: /FromBase64String|Convert\.ToBase64String/, text: "base64 decoding" },
  { group: "capture", re: /GetAsyncKeyState|SetWindowsHookEx|OpenClipboard|GetClipboardData/, text: "keystroke or clipboard capture" },
  { group: "fs", re: /File\.WriteAll(?:Text|Bytes)\s*\(|File\.AppendAllText\s*\(|new\s+StreamWriter/, text: "file writes at runtime" },
  { group: "shell", re: /Process\.Start\s*\(|UseShellExecute\s*=\s*true/, text: "launches external processes" },
  { group: "registry", re: /Registry\.(?:CurrentUser|LocalMachine)|SetValue\s*\(/, text: "registry writes" },
  { group: "network", re: /WebClient|HttpClient|UnityWebRequest|HttpWebRequest/, text: "an HTTP client" },
  { group: "network", re: /X-Api-Key/i, text: "a shipped `X-Api-Key` header" },
  { group: "assets", re: /AssetBundle\.LoadFromFile/, text: "asset-bundle loading" },
  { group: "patches", re: /HarmonyPatch|Harmony\.Patch/, text: "Harmony patches into game code" },
  { group: "obfuscation", re: /\\u[0-9A-Fa-f]{4}/, text: "escaped string literals" },
];

export function detectTechniques(texts) {
  const out = new Set();
  for (const raw of texts) {
    if (!raw) continue;
    const text = String(raw);
    for (const t of TECHNIQUES) if (t.re.test(text)) out.add(t.group + "\u0000" + t.text);
  }
  return [...out].map((entry) => {
    const at = entry.indexOf("\u0000");
    return { group: entry.slice(0, at), text: entry.slice(at + 1) };
  });
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}`]+/gi;

export function extractEndpoints(texts) {
  const seen = new Map();
  for (const raw of texts) {
    if (!raw) continue;
    const found = String(raw).match(URL_PATTERN) || [];
    for (const candidate of found) {
      const cleaned = candidate.replace(/[.,;:]+$/, "").replace(/&amp;/g, "&");
      let url;
      try { url = new URL(cleaned); } catch { continue; }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const key = url.origin + url.pathname;
      if (seen.has(key)) continue;
      seen.set(key, {
        url: key,
        scheme: url.protocol.replace(":", ""),
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        query: url.search ? url.search.slice(1) : "",
        plain: url.protocol === "http:",
        rawIp: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname),
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.plain === b.plain ? a.url.localeCompare(b.url) : a.plain ? -1 : 1));
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "?");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function techText(report, groups) {
  const seen = new Set();
  for (const t of report.techniques || []) if (groups.includes(t.group)) seen.add(t.text);
  return [...seen];
}

function hostsOf(endpoints) {
  return [...new Set(endpoints.map((e) => e.host))];
}

function describeWhatItIs(report) {
  const m = report.meta || {};
  const published = m.title ? '"' + m.title + '"' : "Workshop item " + (m.id || "?");
  if (!report.codeFiles) {
    return [published + " ships no executable code: " + report.files + " file(s) of asset data, " + formatBytes(report.bytes) + ". Nothing in it can run on its own."];
  }
  const managed = report.binaries.filter((b) => b.pe && b.pe.dotnet);
  const native = report.binaries.filter((b) => b.pe && !b.pe.dotnet);
  const groups = new Set((report.techniques || []).map((t) => t.group));
  const obfuscated = report.binaries.some((b) => b.obfuscation && b.obfuscation.weight >= 20);
  const parts = [];
  const kind = managed.length
    ? managed.length + " managed .NET assembl" + (managed.length === 1 ? "y" : "ies")
    : native.length + " native binar" + (native.length === 1 ? "y" : "ies");
  parts.push(published + " is a Puck Workshop item with " + kind + (groups.has("patches") ? ", patching game code through Harmony" : "") + ". Titles and sizes come from Steam; this description comes from the files themselves.");
  const identity = techText(report, ["identity"]);
  const modules = techText(report, ["modules"]);
  if (identity.length || modules.length) {
    const what = [];
    if (identity.length) what.push((modules.length ? "machine/account identity and loaded modules: " : "machine/account identity: ") + identity.join(", "));
    if (modules.length) what.push(modules.join(", "));
    parts.push("It reads " + what.join(" and ") + ".");
  }
  if (report.endpoints.length) {
    const hosts = hostsOf(report.endpoints);
    parts.push("It talks to " + hosts.length + " host" + (hosts.length === 1 ? "" : "s") + " (" + hosts.slice(0, 4).join(", ") + (hosts.length > 4 ? ", ..." : "") + ")" + (report.endpoints.some((e) => e.plain) ? ", partly over plain HTTP" : "") + ".");
  } else if (obfuscated) {
    parts.push("No endpoint is readable: URLs live in an encoded string table, so this scan cannot list them without de-obfuscation.");
  }
  if (obfuscated) {
    parts.push("The assembly is deliberately obfuscated (renamed symbols and/or an encoded string table), so its strings and control flow are hidden from casual review.");
  }
  const caps = (report.capabilities || []).filter((c) => c.key !== "patches");
  if (caps.length) parts.push("Capabilities matched by the scanner: " + caps.map((c) => c.label.toLowerCase()).join("; ") + ".");
  parts.push("This is an automated static triage: nothing is executed, and the remote side is not tested.");
  return parts;
}

function describeContents(report) {
  const out = [];
  const decompiled = report.binaries.filter((b) => b.decompile && b.decompile.available);
  if (decompiled.length) {
    out.push("- " + decompiled.length + " managed assembl" + (decompiled.length === 1 ? "y" : "ies") + " decompiled with ILSpy: " + decompiled.map((b) => b.path + " (" + b.decompile.typeCount + " types, " + b.decompile.methodCount + " methods, " + b.decompile.sourceLines + " lines of C#)").join("; ") + ".");
  }
  const peBits = report.binaries.filter((b) => b.pe).map((b) => b.path + " - PE" + b.pe.bitness + (b.pe.dotnet ? " .NET" : " native") + ", " + b.pe.sections.length + " sections, overlay " + b.pe.overlay + " B");
  if (peBits.length) out.push("- PE: " + peBits.join("; ") + ".");
  const obfuscated = report.binaries.filter((b) => b.obfuscation && b.obfuscation.weight >= 20);
  if (obfuscated.length) {
    out.push("- Obfuscation: " + obfuscated.map((b) => b.path + " (" + b.obfuscation.escapes + " escaped literals, " + b.obfuscation.junk + " renamed identifiers over " + b.obfuscation.lines + " decompiled lines)").join("; ") + ". Detected by symbol/string signals only - this scan does not de-obfuscate the string table.");
  }
  out.push("- Files: " + report.files + ", " + formatBytes(report.bytes) + "; code files analysed: " + report.codeFiles + (report.skippedFiles ? ", skipped over-size: " + report.skippedFiles : "") + ".");
  out.push("- Every file is hashed below; the JSON that produced this page lives beside the site data under `data/reports/`.");
  return out;
}

function absentLines(report) {
  const ids = new Set((report.findings || []).map((f) => f.id));
  const out = [];
  if (!ids.has("ransom")) out.push("no file-encryption/ransom behaviour");
  if (!["browser-login", "wallet", "discord-token"].some((id) => ids.has(id))) out.push("no browser, wallet or Discord credential paths");
  if (!ids.has("keylog")) out.push("no keystroke or clipboard capture");
  if (!ids.has("run-key")) out.push("no persistence (Run key / task / service)");
  if (!ids.has("injection")) out.push("no process injection");
  if (!ids.has("miner")) out.push("no miner markers");
  if (!["shell-exec", "dynamic-load"].some((id) => ids.has(id))) out.push("no shell/LOLBin execution or downloaded-binary execution");
  if (!ids.has("webhook")) out.push("no webhook/paste exfiltration endpoints");
  return out;
}

function describeCodeAnalysis(report) {
  const out = [];
  const identity = techText(report, ["identity", "modules"]);
  if (identity.length) out.push("- **Identity / fingerprinting:** " + identity.join(", ") + ".");
  if (report.endpoints.length) {
    out.push("- **Endpoints (" + report.endpoints.length + "):**");
    for (const e of report.endpoints.slice(0, 14)) {
      const flags = [e.plain ? "**plain HTTP**" : null, e.rawIp ? "**hard-coded IP, no domain**" : null, e.port ? "port " + e.port : null, e.query ? "query parameters" : null].filter(Boolean);
      out.push("  - `" + e.url + "`" + (flags.length ? " - " + flags.join(", ") : ""));
    }
    if (report.endpoints.length > 14) out.push("  - ... " + (report.endpoints.length - 14) + " more");
  }
  const network = techText(report, ["network", "assets"]);
  if (network.length) out.push("- **Network / content code:** " + network.join(", ") + ".");
  const notable = report.notableStrings || [];
  if (notable.length) out.push("- **Notable strings:** " + notable.map((s) => '"' + s + '"').join(", ") + ".");
  else if (report.binaries.some((b) => b.obfuscation && b.obfuscation.weight >= 20)) out.push("- **Notable strings:** not readable - literals are held in an encoded string table.");
  const misc = techText(report, ["fs", "shell", "registry", "capture", "loading"]);
  if (misc.length) out.push("- **Other calls found:** " + misc.join(", ") + ".");
  const absent = absentLines(report);
  if (absent.length) out.push("- **Absent:** " + absent.join("; ") + ".");
  return out;
}

const FINDING_SEVERITY = {
  hostile: "critical",
  credentials: "high",
  fingerprinting: "high-privacy / moderate overall",
  "anti-cheat": "moderate",
  obfuscation: "moderate",
  c2: "moderate",
  "credential-cache": "moderate",
  "encrypted-payload": "low",
  crypto: "low",
  "code-loading": "low",
  filesystem: "low",
  shell: "low",
  native: "low",
  "binary-anomaly": "low",
};

function describeFindings(report) {
  const caps = [...(report.capabilities || [])].filter((c) => c.key !== "patches").sort((a, b) => b.weight - a.weight);
  const items = [];
  for (const c of caps.slice(0, 6)) {
    const sev = FINDING_SEVERITY[c.key] || "low";
    const extra = [];
    if (c.key === "c2") {
      const plain = report.endpoints.filter((e) => e.plain);
      if (plain.length) extra.push("includes plain HTTP to " + hostsOf(plain).join(", "));
      if (report.endpoints.some((e) => e.rawIp)) extra.push("one endpoint is a bare IP with no domain");
    }
    if (c.key === "obfuscation") extra.push("symbols and/or strings are deliberately hidden");
    if (c.key === "anti-cheat") extra.push("the client can see every other mod you have loaded");
    if (c.key === "fingerprinting") extra.push("a persistent hardware/account identifier can be tied to you");
    items.push("**" + c.label + "**" + (extra.length ? " - " + extra.join("; ") : "") + ". Evidence: " + c.ids.join(", ") + ". Severity: **" + sev + "**.");
  }
  if (!caps.some((c) => ["hostile", "credentials"].includes(c.key))) items.push("No evidence of malware behaviour. Severity: **none**.");
  return items.map((text, i) => i + 1 + ". " + text);
}

function describeEvidence(report) {
  const out = [];
  out.push("- Method: SHA-256 of every file; PE parsing (machine, sections, overlay, .NET metadata); ASCII/UTF-16 string extraction; indicator matching (shells/LOLBins, credential and wallet stores, input capture, injection, persistence, encryption, miner markers, raw-IP and plain-HTTP endpoints); ILSpy (`ilspycmd`, ICSharpCode.Decompiler) decompilation of managed assemblies; the same 0-100 rubric as the hand-written audits (0-15 clean, 16-30 benign with caveats, 31-50 suspicious, 51+ hostile).");
  out.push("- Generated " + formatWhen(report.generatedAt) + " in " + (report.analysisMs / 1000).toFixed(1) + " s; " + report.files + " files, " + formatBytes(report.bytes) + ", " + report.codeFiles + " code files analysed.");
  out.push("- Not verified: nothing is executed; the endpoints are not contacted (no request is sent by this pipeline), so server-side handling and remote payloads are unknown; obfuscation is judged from symbol/string signals, not by fully de-obfuscating every method.");
  return out;
}

function describeBottomLine(report) {
  const caps = (report.capabilities || []).filter((c) => c.key !== "patches");
  const score = report.score;
  const labels = caps.map((c) => c.label.toLowerCase()).join("; ");
  if (score >= 51) return "**Treat as hostile until proven otherwise.** Multiple high-severity primitives were found in the shipped bytes; do not run this mod. Read a hand audit before touching the build again.";
  if (score >= 31) {
    const bits = [];
    if (caps.some((c) => c.key === "fingerprinting")) bits.push("a hardware/account identifier");
    if (caps.some((c) => c.key === "anti-cheat")) bits.push("the list of mods you have loaded");
    if (caps.some((c) => c.key === "c2")) bits.push("reports to a remote endpoint");
    if (caps.some((c) => c.key === "obfuscation")) bits.push("deliberate obfuscation");
    const collects = bits.filter((b) => !b.includes("obfuscation"));
    const obf = bits.includes("deliberate obfuscation");
    const sentence = collects.length === 1 ? "It collects " + collects[0] : collects.length ? "It collects " + collects.slice(0, -1).join(", ") + " and " + collects[collects.length - 1] : "It reports to a remote endpoint";
    return "**Not malware, but it behaves like an anti-cheat/telemetry client.** " + sentence + (obf ? ", and its code is deliberately obfuscated" : "") + ". Keep it only if you actually use what it is for; otherwise remove it.";
  }
  if (score >= 16) {
    return "**Not malware, but it carries capabilities a hockey mod does not need** (" + labels + "). Keep it if you trust the mod and its author; remove it if you do not.";
  }
  return "**No machine-checkable malware capability found.** Ordinary mod behaviour; treat this as triage, not as a safety guarantee.";
}

export function toMarkdown(report) {
  const m = report.meta || {};
  const item = m.title || ("Workshop item " + (m.id || "?"));
  const lines = [];
  lines.push("# " + item + " - automated triage");
  lines.push("");
  lines.push("**Verdict:** " + report.verdict + " - automated score " + report.score + "/100");
  const obfBinary = report.binaries.some((b) => b.obfuscation && b.obfuscation.weight >= 20);
  const managedCount = report.binaries.filter((b) => b.pe && b.pe.dotnet).length;
  const nativeCount = report.binaries.filter((b) => b.pe && !b.pe.dotnet).length;
  const kindLabel = !report.codeFiles ? "asset-only (no executable code)" : obfBinary ? "managed .NET mod, obfuscated" : managedCount && nativeCount ? "managed + native mod" : managedCount ? "managed .NET mod" : nativeCount ? "native mod" : "scripts";
  lines.push("**Kind:** " + kindLabel);
  lines.push("**Workshop id:** " + (m.id || "?") + " | **Files:** " + report.files + " (" + formatBytes(report.bytes) + ") | **Generated:** " + report.generatedAt);
  lines.push("");
  lines.push("> This report was produced by an automated static scanner, not a manual audit. It lists");
  lines.push("> machine-checkable indicators in the shipped files. Nothing here is executed, and a low");
  lines.push("> score is not a guarantee of safety. Manual reports supersede this when they exist.");
  lines.push("");
  lines.push("## What it is");
  for (const p of describeWhatItIs(report)) { lines.push(p); lines.push(""); }
  lines.push("## Contents");
  for (const p of describeContents(report)) lines.push(p);
  lines.push("");
  lines.push("## Code analysis");
  for (const p of describeCodeAnalysis(report)) lines.push(p);
  lines.push("");
  lines.push("## Findings");
  for (const p of describeFindings(report)) lines.push(p);
  lines.push("");
  lines.push("## Evidence trail");
  for (const p of describeEvidence(report)) lines.push(p);
  lines.push("");
  lines.push("## Bottom line");
  lines.push(describeBottomLine(report));
  lines.push("");
  lines.push("## Files and hashes");
  lines.push("");
  for (const f of report.inventory.slice(0, 60)) lines.push("- `" + f.sha256 + "` " + f.size + " B - " + f.path);
  if (report.inventory.length > 60) lines.push("- ... " + (report.inventory.length - 60) + " more");
  lines.push("");
  lines.push("## Binaries");
  lines.push("");
  if (!report.binaries.length) lines.push("No code files were found in this item.");
  for (const b of report.binaries) {
    const pe = b.pe ? "PE" + b.pe.bitness + (b.pe.dotnet ? " .NET" : " native") + ", " + b.pe.sections.length + " sections, overlay " + b.pe.overlay + " B" : b.kind;
    lines.push("- **" + b.path + "** - " + b.size + " B, " + pe + ", sha256 `" + b.sha256 + "`");
    for (const s of b.pe ? b.pe.sections : []) lines.push("  - section " + s.name + ": entropy " + s.entropy + (s.executable ? ", executable" : "") + (s.writable ? ", writable" : ""));
    for (const i of b.indicators || []) lines.push("  - indicator " + i.id + " (" + i.label + ")" + (i.samples.length ? ": " + i.samples.map((x) => "`" + String(x).replace(/`/g, "") + "`").join(", ") : ""));
  }
  lines.push("");
  lines.push("## Capabilities observed");
  lines.push("");
  lines.push("Same vocabulary and the same 0-100 rubric as the hand-written reports: 0-15 clean,");
  lines.push("16-30 benign with caveats, 31-50 suspicious, 51+ treat as hostile. A capability is");
  lines.push("listed when a machine-checkable pattern for it was present in the shipped bytes.");
  lines.push("");
  const caps = report.capabilities || [];
  if (!caps.length) lines.push("- No capability pattern matched. The files are asset data or ordinary mod code.");
  for (const c of [...caps].sort((a, b) => b.weight - a.weight)) {
    lines.push("- **" + c.label + "** - " + (c.weight + c.bump) + "/100 weight" + (c.ids.length ? ", evidence: " + c.ids.join(", ") : ""));
  }
  lines.push("");
  lines.push("## Indicators");
  lines.push("");
  if (!report.findings.length) lines.push("No indicator pattern matched.");
  const order = { 5: "critical", 4: "high", 3: "medium", 2: "low", 1: "info" };
  for (const f of [...report.findings].sort((a, b) => b.severity - a.severity)) {
    lines.push("- **" + (order[f.severity] || "info") + "** - " + f.label + " (" + f.file + ")");
    for (const s of f.samples || []) lines.push("  - `" + String(s).replace(/`/g, "").slice(0, 180) + "`");
  }
  lines.push("");
  lines.push("## Decompiled with ILSpy");
  lines.push("");
  const decompiled = report.binaries.filter((b) => b.decompile && b.decompile.available);
  if (!decompiled.length) {
    lines.push("No managed .NET assembly was decompiled in this item.");
  } else {
    lines.push("Managed assemblies were opened with `ilspycmd` (ICSharpCode.Decompiler) so the report can show");
    lines.push("what the code actually contains, not only which strings it carries.");
    for (const b of decompiled) {
      const d = b.decompile;
      lines.push("");
      lines.push("### " + b.path);
      lines.push("");
      lines.push("- ILSpy: " + d.typeCount + " types, " + d.methodCount + " methods, " + d.sourceLines + " lines of C# reconstructed");
      if (d.apiHits && d.apiHits.length) lines.push("- API surface used: " + d.apiHits.map((h) => "`" + h + "`").join(", "));
      lines.push("- Types: " + d.types.slice(0, 40).map((t) => "`" + t + "`").join(", ") + (d.typeCount > 40 ? ", ..." : ""));
      if (d.excerpt) {
        lines.push("");
        lines.push("```csharp");
        lines.push(d.excerpt.slice(0, 4000));
        lines.push("```");
      }
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
  lines.push("- Managed assemblies were decompiled with ILSpy and the C# was scanned the same way.");
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- Static only: nothing is run. Runtime behaviour and remote payloads are invisible here.");
  lines.push("- Strings can appear in benign libraries; context is judged by a human in a manual audit.");
  lines.push("- A clean automated scan does not prove a mod is safe.");
  return lines.join("\n") + "\n";
}

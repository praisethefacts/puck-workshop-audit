// Admin API: hide or show a mod / request / re-audit row from the site.
//
// POST /api/admin  { password, action, id }
//   action: hide-mod | show-mod | hide-request | show-request |
//           hide-reaudit | show-reaudit
//
// The change is written straight into data/site-config.json in the repository via
// the GitHub contents API, which is what the static build reads. Every change is
// therefore a normal commit: reviewable, revertable, and it triggers the deploy
// workflow.
//
// Environment:
//   ADMIN_TOKEN   required, the password typed into /admin.html
//   GITHUB_TOKEN  required, with contents:write on GITHUB_REPO
//   GITHUB_REPO   optional, defaults to praisethefacts/puck-workshop-audit
//
// Dependency-free: global fetch and the Web API are available in Netlify Functions.

const DEFAULT_REPO = "praisethefacts/puck-workshop-audit";
const GITHUB_API = "https://api.github.com";
const CONFIG_PATH = "data/site-config.json";
const LISTS = {
  "hide-mod": "hiddenMods",
  "show-mod": "hiddenMods",
  "hide-request": "hiddenRequests",
  "show-request": "hiddenRequests",
  "hide-reaudit": "hiddenReaudits",
  "show-reaudit": "hiddenReaudits",
};
const RATE = { windowMs: 60 * 60 * 1000, max: 20 };
const buckets = new Map();

class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function configuredRepo() {
  const raw = String(process.env.GITHUB_REPO || "").trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  return DEFAULT_REPO;
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "puck-workshop-audit-site",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function github(url, token, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...githubHeaders(token), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { response, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function clientIp(request) {
  const direct = request.headers.get("x-nf-client-connection-ip");
  if (direct) return direct.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

function takeRateLimit(ip) {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.start > RATE.windowMs) {
    buckets.set(ip, { start: now, count: 1 });
    return { ok: true };
  }
  entry.count += 1;
  if (entry.count > RATE.max) {
    return { ok: false, retryAfter: Math.ceil((entry.start + RATE.windowMs - now) / 1000) };
  }
  return { ok: true };
}

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
};

async function mutate(action, id) {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (!token) throw new ApiError("GITHUB_TOKEN is not configured on this site.", 503);
  const repo = configuredRepo();
  const listName = LISTS[action];
  if (!listName) throw new ApiError(`Unknown action: ${action}`, 400);
  const value = String(id || "").replace(/^#/, "").trim();
  if (!/^[0-9]{1,12}$/.test(value)) throw new ApiError("Give a numeric mod id or issue number.", 400);

  const url = `${GITHUB_API}/repos/${repo}/contents/${CONFIG_PATH}`;
  const current = await github(url, token);
  if (!current.response.ok || !current.data?.content) {
    throw new ApiError("Could not read data/site-config.json from the repository.", 502);
  }

  const config = JSON.parse(Buffer.from(current.data.content, "base64").toString("utf8"));
  for (const key of ["hiddenMods", "hiddenRequests", "hiddenReaudits"]) {
    if (!Array.isArray(config[key])) config[key] = [];
  }

  const hides = action.startsWith("hide-");
  const index = config[listName].indexOf(value);
  if (hides && index === -1) config[listName].push(value);
  if (!hides && index !== -1) config[listName].splice(index, 1);
  const changed = hides ? index === -1 : index !== -1;
  if (!changed) return { changed: false, config };

  const update = await github(url, token, {
    method: "PUT",
    body: JSON.stringify({
      message: `chore(admin): ${action} ${value} from /admin.html`,
      content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8").toString("base64"),
      sha: current.data.sha,
      branch: "main",
    }),
  });
  if (!update.response.ok) {
    throw new ApiError("GitHub rejected the configuration update.", 502);
  }
  return { changed: true, config, commit: update.data?.commit?.html_url || "" };
}

export default async function handler(request) {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "POST, OPTIONS", "cache-control": "no-store" },
    });
  }
  if (method !== "POST") {
    return json(405, { ok: false, error: "POST { password, action, id } to manage the site." });
  }

  try {
    const configured = String(process.env.ADMIN_TOKEN || "").trim();
    if (!configured) throw new ApiError("ADMIN_TOKEN is not configured on this site.", 503);

    const length = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > 4000) throw new ApiError("Body too large.", 413);

    const rate = takeRateLimit(clientIp(request));
    if (!rate.ok) {
      return json(
        429,
        { ok: false, error: "Too many admin attempts. Try again later." },
        { "retry-after": String(rate.retryAfter) }
      );
    }

    let payload;
    try {
      payload = JSON.parse(await request.text());
    } catch {
      throw new ApiError("Send a valid JSON object.", 400);
    }

    if (!safeEqual(payload?.password || "", configured)) {
      return json(401, { ok: false, error: "Wrong password." });
    }

    if (payload?.action === "check") {
      const current = await github(`${GITHUB_API}/repos/${configuredRepo()}/contents/${CONFIG_PATH}`, String(process.env.GITHUB_TOKEN || "").trim());
      const config = current.data?.content
        ? JSON.parse(Buffer.from(current.data.content, "base64").toString("utf8"))
        : {};
      return json(200, {
        ok: true,
        changed: false,
        hiddenMods: Array.isArray(config.hiddenMods) ? config.hiddenMods : [],
        hiddenRequests: Array.isArray(config.hiddenRequests) ? config.hiddenRequests : [],
        hiddenReaudits: Array.isArray(config.hiddenReaudits) ? config.hiddenReaudits : [],
      });
    }

    const result = await mutate(payload?.action, payload?.id);
    return json(200, {
      ok: true,
      changed: result.changed,
      hiddenMods: result.config.hiddenMods,
      hiddenRequests: result.config.hiddenRequests,
      hiddenReaudits: result.config.hiddenReaudits,
      commit: result.commit || "",
    });
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, { ok: false, error: error.message });
    return json(500, { ok: false, error: "Admin request failed." });
  }
}

// Puck Workshop audit request API.
//
// GET  /api/requests -> public request queue (GitHub issues labelled mod-request)
// POST /api/request  -> verify a public Workshop item, then open a GitHub issue
//
// Environment:
//   GITHUB_TOKEN  optional for public reads, required to create issues
//   GITHUB_REPO   optional, defaults to praisethefacts/puck-workshop-audit
//
// Dependency-free: global fetch and the Web API are available in Netlify Functions.

const DEFAULT_REPO = "praisethefacts/puck-workshop-audit";
const LABEL = "mod-request";
const GITHUB_API = "https://api.github.com";
const STEAM_ENDPOINT =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const WORKSHOP_URL = "https://steamcommunity.com/sharedfiles/filedetails/?id=";

const LIMITS = { mod: 300, reason: 2000, contact: 200, body: 10_000 };
const RATE = { windowMs: 60 * 60 * 1000, max: 5 };
const buckets = new Map();

class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function configuredRepo() {
  const raw = String(process.env.GITHUB_REPO || "").trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  return DEFAULT_REPO;
}

function githubHeaders(token, write = false) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "puck-workshop-audit-site",
  };
  if (write) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function takeRateLimit(ip) {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE.windowMs) {
    bucket = { startedAt: now, count: 0 };
  }
  if (bucket.count >= RATE.max) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((bucket.startedAt + RATE.windowMs - now) / 1000)),
    };
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (buckets.size > 5_000) {
    for (const [key, value] of buckets) {
      if (now - value.startedAt >= RATE.windowMs) buckets.delete(key);
    }
  }
  return { ok: true };
}

function cleanText(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function oneLine(value, maxLength) {
  return cleanText(value).replace(/\s+/g, " ").slice(0, maxLength).trim();
}

function markdownLiteral(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]()#+\-.!|>~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

function extractSteamId(input) {
  const raw = String(input || "").trim();

  const bare = /^(\d{5,20})$/.exec(raw);
  if (bare) return bare[1];

  const protocol = /^steam:\/\/url\/CommunityFilePage\/(\d{5,20})\/?$/i.exec(raw);
  if (protocol) return protocol[1];

  const link = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/sharedfiles\/filedetails\/?\?[^\s#]*?\bid=(\d{5,20})(?:[&#\s]|$)/i.exec(
    raw
  );
  if (link) return link[1];

  return null;
}

async function verifyWorkshopItem(id) {
  const form = new URLSearchParams();
  form.set("itemcount", "1");
  form.set("publishedfileids[0]", id);

  let result;
  try {
    result = await fetchJson(
      STEAM_ENDPOINT,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
      9_000
    );
  } catch {
    throw new ApiError("Steam could not be reached. Try again in a moment.", 502);
  }

  if (!result.response.ok) {
    throw new ApiError("Steam could not verify that item right now. Try again.", 502);
  }

  const detail = result.data?.response?.publishedfiledetails?.[0];
  if (!detail) {
    throw new ApiError("Steam did not return a usable result for that item.", 502);
  }

  const code = Number(detail.result);
  if (code === 9) {
    throw new ApiError(
      "That Workshop item is deleted or unlisted, so it cannot be audited.",
      404
    );
  }
  if (code !== 1) {
    throw new ApiError("Steam could not verify that item. Check the link and try again.", 502);
  }

  const visibility = Number(detail.visibility);
  const banned = Number(detail.banned);
  if ((Number.isFinite(visibility) && visibility !== 0) || banned === 1) {
    throw new ApiError(
      "That Workshop item is not public, so it cannot be queued for a public audit.",
      404
    );
  }

  return {
    title: oneLine(detail.title || `Workshop item ${id}`, 180) || `Workshop item ${id}`,
    workshopUrl: WORKSHOP_URL + id,
  };
}

async function listRequests() {
  const token = process.env.GITHUB_TOKEN;
  const repo = configuredRepo();
  const items = [];
  let page = 1;

  while (page <= 3) {
    let result;
    try {
      result = await fetchJson(
        `${GITHUB_API}/repos/${repo}/issues?state=all&labels=${LABEL}&per_page=100&page=${page}&sort=created&direction=desc`,
        { headers: githubHeaders(token, false) },
        9_000
      );
    } catch {
      throw new ApiError("GitHub did not answer while loading the request queue.", 502);
    }

    if (!result.response.ok) {
      if ([401, 403, 404].includes(result.response.status)) {
        throw new ApiError(
          "GitHub rejected the queue request. Check GITHUB_REPO and whether GITHUB_TOKEN is needed.",
          502
        );
      }
      throw new ApiError("GitHub could not load the request queue.", 502);
    }

    const batch = Array.isArray(result.data) ? result.data : [];
    items.push(...batch.filter((issue) => issue && !issue.pull_request));
    if (batch.length < 100) break;
    page += 1;
  }

  return items.map((issue) => ({
    number: issue.number,
    title: String(issue.title || ""),
    url: issue.html_url,
    state: String(issue.state || "").toLowerCase(),
    createdAt: issue.created_at,
    labels: (issue.labels || [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
  }));
}

async function createRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Send a JSON object with a Workshop link or ID.", 400);
  }

  if (payload.reason != null && typeof payload.reason !== "string") {
    throw new ApiError("The reason must be text.", 400);
  }
  if (payload.contact != null && typeof payload.contact !== "string") {
    throw new ApiError("The contact field must be text.", 400);
  }

  const mod = cleanText(payload.mod || "");
  const reason = cleanText(payload.reason || "");
  const contact = cleanText(payload.contact || "");

  if (!mod) throw new ApiError("Include a Steam Workshop link or numeric item ID.", 400);
  if (mod.length > LIMITS.mod) {
    throw new ApiError(`The Workshop reference must be ${LIMITS.mod} characters or fewer.`, 400);
  }
  if (reason.length > LIMITS.reason) {
    throw new ApiError(`The reason must be ${LIMITS.reason} characters or fewer.`, 400);
  }
  if (contact.length > LIMITS.contact) {
    throw new ApiError(`The contact must be ${LIMITS.contact} characters or fewer.`, 400);
  }

  const id = extractSteamId(mod);
  if (!id) {
    throw new ApiError(
      "That is not a Steam Workshop link or item ID. Paste the item link, its numeric ID, or a steam:// CommunityFilePage link.",
      400
    );
  }

  const item = await verifyWorkshopItem(id);

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new ApiError(
      "Request submission is not configured on this deployment. Open a GitHub issue instead.",
      503
    );
  }

  const repo = configuredRepo();
  const requestedAt = new Date().toISOString();
  const title = oneLine(`Audit request: ${item.title} (${id})`, 240);
  const body = [
    "## Audit request",
    "",
    `**Mod:** [${markdownLiteral(item.title)}](${item.workshopUrl})`,
    `**Workshop ID:** \`${id}\``,
    `**Requested at:** ${requestedAt}`,
    `**Contact:** ${contact ? markdownLiteral(contact) : "_Not provided_"}`,
    "",
    "### Why it looks suspicious",
    "",
    reason ? markdownLiteral(reason) : "_No reason given._",
    "",
    "---",
    "_Submitted through the Puck Workshop audit request form. Steam confirmed the item was public at submission time._",
  ].join("\n");

  let result;
  try {
    result = await fetchJson(
      `${GITHUB_API}/repos/${repo}/issues`,
      {
        method: "POST",
        headers: githubHeaders(token, true),
        body: JSON.stringify({ title, body, labels: [LABEL] }),
      },
      9_000
    );
  } catch {
    throw new ApiError("GitHub did not answer while creating the request.", 502);
  }

  if (!result.response.ok) {
    if ([401, 403, 404].includes(result.response.status)) {
      throw new ApiError(
        "GitHub rejected the request. The server token may be missing, expired, or lack issue access.",
        503
      );
    }
    throw new ApiError("GitHub could not create the request issue. Try again or open an issue directly.", 502);
  }

  const issueUrl = result.data?.html_url;
  if (!issueUrl) {
    throw new ApiError("GitHub created no readable issue URL. Check the repository directly.", 502);
  }

  return { issueUrl };
}

export default async function handler(request) {
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "GET, POST, OPTIONS", "cache-control": "no-store" },
    });
  }

  try {
    if (method === "GET") {
      return json(200, { ok: true, items: await listRequests() });
    }

    if (method === "POST") {
      const length = Number(request.headers.get("content-length") || 0);
      if (Number.isFinite(length) && length > LIMITS.body) {
        throw new ApiError("The request body is too large.", 413);
      }

      const rate = takeRateLimit(clientIp(request));
      if (!rate.ok) {
        return json(
          429,
          {
            ok: false,
            error:
              "Too many requests from this address. Try again later or open a GitHub issue directly.",
          },
          { "retry-after": String(rate.retryAfter) }
        );
      }

      let raw;
      try {
        raw = await request.text();
      } catch {
        throw new ApiError("The request body could not be read.", 400);
      }
      if (raw.length > LIMITS.body) {
        throw new ApiError("The request body is too large.", 413);
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ApiError("Send a valid JSON object.", 400);
      }

      const created = await createRequest(payload);
      return json(201, { ok: true, issueUrl: created.issueUrl });
    }

    return json(
      405,
      { ok: false, error: "Use GET for the queue or POST to request an audit." },
      { allow: "GET, POST, OPTIONS" }
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, { ok: false, error: error.message });
    }
    return json(500, {
      ok: false,
      error: "The request could not be completed. Try again or open a GitHub issue directly.",
    });
  }
}

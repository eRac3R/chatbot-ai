const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { redis, hasRedis } = require("./store");

const DATA_DIR = path.join(__dirname, "..", "data", "clients");
const CLIENT_KEY_PREFIX = "chatbot:client:";
const CLIENT_INDEX_KEY = "chatbot:client-index";

const MAX_QUICK_REPLIES = 4;
const MAX_PAGES = 12;
const MAX_PAGE_LABEL_LENGTH = 60;

// Deliberately generic -- greeting, what they sell, price, how to reach a
// human. These read sensibly for a pizzeria, a SaaS product or a gym alike,
// so a client is usable before anyone customises them.
const DEFAULT_QUICK_REPLIES = [
  "Hi!",
  "What do you offer?",
  "How much does it cost?",
  "How can I contact you?",
];

function isValidClientId(clientId) {
  return typeof clientId === "string" && /^[a-zA-Z0-9_-]{3,64}$/.test(clientId);
}

// Shared by avatarUrl (rendered straight into an <img src>) and website
// (rendered into an <a href>) -- both need the same rule: only real http(s)
// URLs, never javascript:/data: URIs.
function sanitizeUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

// Suggested-question buttons shown under the welcome message so visitors can
// start a conversation in one tap instead of typing.
//
// Always returns exactly MAX_QUICK_REPLIES entries: a blank slot falls back
// to the default for that position rather than dropping the button, so the
// widget never renders a half-empty row. Backfill is positional, so the
// caller must send blanks in place rather than a compacted list.
function sanitizeQuickReplies(replies) {
  const list = Array.isArray(replies) ? replies : [];
  const out = [];
  for (let i = 0; i < MAX_QUICK_REPLIES; i++) {
    const raw = typeof list[i] === "string" ? list[i].trim().slice(0, 60) : "";
    out.push(raw || DEFAULT_QUICK_REPLIES[i]);
  }
  return out;
}

// Named links to specific pages/sections of the business's own site (e.g.
// "Pricing" -> https://acme.com/pricing#plans), fed to the model so it can
// offer clickable navigation buttons instead of just describing where
// something is (see NAV_OPTIONS_MARKER in lib/sarvam.js). Same http(s)-only
// rule as avatarUrl/website -- these end up both in the model's prompt and,
// verbatim, in an <a>-like click target in the widget.
function sanitizePages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const label = typeof p.label === "string" ? p.label.trim().slice(0, MAX_PAGE_LABEL_LENGTH) : "";
    const url = sanitizeUrl(p.url);
    if (label && url) out.push({ label, url });
    if (out.length >= MAX_PAGES) break;
  }
  return out;
}

// ---- filesystem backend (local dev, no Redis env vars configured) ----

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(clientId) {
  return path.join(DATA_DIR, `${clientId}.json`);
}

function fileGetClient(clientId) {
  const file = filePath(clientId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileListClients() {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function fileUpsertClient(merged) {
  ensureDir();
  fs.writeFileSync(filePath(merged.id), JSON.stringify(merged, null, 2));
}

function fileDeleteClient(clientId) {
  const file = filePath(clientId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// ---- Redis backend (Vercel or any other stateless/serverless host) ----

async function redisGetClient(clientId) {
  const data = await redis.get(CLIENT_KEY_PREFIX + clientId);
  return data || null;
}

async function redisListClients() {
  return (await redis.smembers(CLIENT_INDEX_KEY)) || [];
}

async function redisUpsertClient(merged) {
  await redis.set(CLIENT_KEY_PREFIX + merged.id, merged);
  await redis.sadd(CLIENT_INDEX_KEY, merged.id);
}

async function redisDeleteClient(clientId) {
  const deletedCount = await redis.del(CLIENT_KEY_PREFIX + clientId);
  await redis.srem(CLIENT_INDEX_KEY, clientId);
  return deletedCount > 0;
}

// ---- public API (async everywhere, since the Redis path requires it) ----

async function getClient(clientId) {
  if (!isValidClientId(clientId)) return null;
  const client = hasRedis ? await redisGetClient(clientId) : fileGetClient(clientId);
  if (!client) return null;

  // Clients created before identity verification existed have no secret, so
  // signature checks would silently never pass for them. Mint one on first
  // read and persist it, so this is a one-time backfill rather than a
  // permanently broken feature for older clients.
  //
  // Same idea for createdAt (added for the workspaces list): clients from
  // before that field existed would otherwise show a permanent "null"
  // rather than a real, if approximate, date.
  let needsSave = false;
  if (!client.identitySecret) {
    client.identitySecret = crypto.randomBytes(32).toString("hex");
    needsSave = true;
  }
  if (!client.createdAt) {
    client.createdAt = client.updatedAt || new Date().toISOString();
    needsSave = true;
  }
  if (needsSave) {
    if (hasRedis) {
      await redisUpsertClient(client);
    } else {
      fileUpsertClient(client);
    }
  }
  return client;
}

// Fields safe to expose to the public widget (no internal notes, no admin metadata).
async function getPublicClient(clientId) {
  const client = await getClient(clientId);
  if (!client) return null;
  const { id, botName, welcomeMessage, brandColor, avatarUrl, quickReplies, faqs } = client;
  // faqs are safe to expose -- they're written to be shown to visitors, and
  // the widget renders them as a browsable tab. businessInfo deliberately
  // stays server-side: it's a bulk dump that may contain internal notes.
  return {
    id,
    botName,
    welcomeMessage,
    brandColor,
    avatarUrl,
    quickReplies,
    faqs: Array.isArray(faqs) ? faqs : [],
  };
}

async function listClients() {
  return hasRedis ? redisListClients() : fileListClients();
}

// What the platform-owner "all workspaces" view needs: enough to
// distinguish businesses at a glance without shipping full businessInfo
// dumps or the identitySecret over the wire. listClients() alone only
// returns bare ids.
async function listClientSummaries() {
  const ids = await listClients();
  const clients = await Promise.all(ids.map((id) => getClient(id)));
  return clients.filter(Boolean).map((c) => ({
    id: c.id,
    botName: c.botName,
    brandColor: c.brandColor,
    website: c.website || "",
    faqCount: Array.isArray(c.faqs) ? c.faqs.length : 0,
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
  }));
}

async function upsertClient(config) {
  if (!isValidClientId(config.id)) {
    throw new Error("clientId must be 3-64 chars, letters/numbers/-/_ only");
  }
  const existing = (await getClient(config.id)) || {};
  const merged = {
    id: config.id,
    botName: config.botName ?? existing.botName ?? "Assistant",
    welcomeMessage:
      config.welcomeMessage ?? existing.welcomeMessage ?? "Hi! How can I help you today?",
    brandColor: config.brandColor ?? existing.brandColor ?? "#6366f1",
    businessInfo: config.businessInfo ?? existing.businessInfo ?? "",
    faqs: config.faqs ?? existing.faqs ?? [],
    tone: config.tone ?? existing.tone ?? "friendly and concise",
    avatarUrl:
      config.avatarUrl !== undefined
        ? sanitizeUrl(config.avatarUrl)
        : existing.avatarUrl ?? "",
    // The business's own site, shown as a clickable link in the dashboards
    // (never rendered into the widget itself). Same http(s)-only rule as
    // avatarUrl -- it ends up in an <a href>, so javascript:/data: URIs need
    // the same rejection.
    website:
      config.website !== undefined ? sanitizeUrl(config.website) : existing.website ?? "",
    // Named page/section links the bot can offer as clickable navigation
    // buttons -- see sanitizePages above and NAV_OPTIONS_MARKER in
    // lib/sarvam.js. Never rendered directly; only ever surfaced through the
    // model choosing one of these verbatim.
    pages: config.pages !== undefined ? sanitizePages(config.pages) : existing.pages ?? [],
    quickReplies:
      config.quickReplies !== undefined
        ? sanitizeQuickReplies(config.quickReplies)
        : existing.quickReplies ?? DEFAULT_QUICK_REPLIES,
    // Shared secret the business's own backend uses to sign the id of a
    // logged-in user, proving the widget really is that person before we
    // hand over their cross-device chat history. Generated once, never
    // exposed through the public widget config. See lib/identity.js.
    identitySecret: existing.identitySecret || crypto.randomBytes(32).toString("hex"),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (hasRedis) {
    await redisUpsertClient(merged);
  } else {
    fileUpsertClient(merged);
  }
  return merged;
}

async function deleteClient(clientId) {
  if (!isValidClientId(clientId)) return false;
  return hasRedis ? redisDeleteClient(clientId) : fileDeleteClient(clientId);
}

module.exports = {
  isValidClientId,
  getClient,
  getPublicClient,
  listClients,
  listClientSummaries,
  upsertClient,
  deleteClient,
};

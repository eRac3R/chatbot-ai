const fs = require("fs");
const path = require("path");
const { redis, hasRedis } = require("./store");

const DATA_DIR = path.join(__dirname, "..", "data", "clients");
const CLIENT_KEY_PREFIX = "chatbot:client:";
const CLIENT_INDEX_KEY = "chatbot:client-index";

function isValidClientId(clientId) {
  return typeof clientId === "string" && /^[a-zA-Z0-9_-]{3,64}$/.test(clientId);
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
  return hasRedis ? redisGetClient(clientId) : fileGetClient(clientId);
}

// Fields safe to expose to the public widget (no internal notes, no admin metadata).
async function getPublicClient(clientId) {
  const client = await getClient(clientId);
  if (!client) return null;
  const { id, botName, welcomeMessage, brandColor } = client;
  return { id, botName, welcomeMessage, brandColor };
}

async function listClients() {
  return hasRedis ? redisListClients() : fileListClients();
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
  upsertClient,
  deleteClient,
};

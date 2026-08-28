const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data", "clients");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(clientId) {
  return path.join(DATA_DIR, `${clientId}.json`);
}

function isValidClientId(clientId) {
  return typeof clientId === "string" && /^[a-zA-Z0-9_-]{3,64}$/.test(clientId);
}

function getClient(clientId) {
  if (!isValidClientId(clientId)) return null;
  const file = filePath(clientId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Fields safe to expose to the public widget (no internal notes, no admin metadata).
function getPublicClient(clientId) {
  const client = getClient(clientId);
  if (!client) return null;
  const { id, botName, welcomeMessage, brandColor } = client;
  return { id, botName, welcomeMessage, brandColor };
}

function listClients() {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function upsertClient(config) {
  if (!isValidClientId(config.id)) {
    throw new Error("clientId must be 3-64 chars, letters/numbers/-/_ only");
  }
  ensureDir();
  const existing = getClient(config.id) || {};
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
  fs.writeFileSync(filePath(config.id), JSON.stringify(merged, null, 2));
  return merged;
}

function deleteClient(clientId) {
  if (!isValidClientId(clientId)) return false;
  const file = filePath(clientId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  isValidClientId,
  getClient,
  getPublicClient,
  listClients,
  upsertClient,
  deleteClient,
};

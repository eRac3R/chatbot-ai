const { redis, hasRedis } = require("./store");

// Per-session conversation history, so the bot remembers earlier turns in
// the same chat. On a stateless host (Vercel) each request can hit a fresh
// instance, so plain in-memory storage wouldn't survive between messages --
// use Redis there instead, with the same TTL behavior (Redis key expiry).
const MAX_TURNS = 10; // user+assistant pairs kept per session
const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes idle -> forget
const HISTORY_KEY_PREFIX = "chatbot:history:";

// ---- in-memory backend (local dev, no Redis env vars configured) ----

const sessions = new Map(); // sessionId -> { messages: [{role, content}], lastSeen }

function memoryCleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_SECONDS * 1000) sessions.delete(id);
  }
}

function memoryGetHistory(sessionId) {
  memoryCleanup();
  const session = sessions.get(sessionId);
  return session ? session.messages : [];
}

function memoryAppendTurn(sessionId, userMessage, assistantReply) {
  memoryCleanup();
  const session = sessions.get(sessionId) || { messages: [], lastSeen: Date.now() };
  session.messages.push({ role: "user", content: userMessage });
  session.messages.push({ role: "assistant", content: assistantReply });
  const maxMessages = MAX_TURNS * 2;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(-maxMessages);
  }
  session.lastSeen = Date.now();
  sessions.set(sessionId, session);
}

// ---- Redis backend (Vercel or any other stateless/serverless host) ----

async function redisGetHistory(sessionId) {
  const messages = await redis.get(HISTORY_KEY_PREFIX + sessionId);
  return messages || [];
}

async function redisAppendTurn(sessionId, userMessage, assistantReply) {
  const messages = await redisGetHistory(sessionId);
  messages.push({ role: "user", content: userMessage });
  messages.push({ role: "assistant", content: assistantReply });
  const maxMessages = MAX_TURNS * 2;
  const trimmed = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  // `ex` refreshes the TTL on every write, so an active conversation stays
  // alive while an idle one expires after SESSION_TTL_SECONDS.
  await redis.set(HISTORY_KEY_PREFIX + sessionId, trimmed, { ex: SESSION_TTL_SECONDS });
}

// ---- public API ----

async function getHistory(sessionId) {
  return hasRedis ? redisGetHistory(sessionId) : memoryGetHistory(sessionId);
}

async function appendTurn(sessionId, userMessage, assistantReply) {
  if (hasRedis) {
    await redisAppendTurn(sessionId, userMessage, assistantReply);
  } else {
    memoryAppendTurn(sessionId, userMessage, assistantReply);
  }
}

module.exports = { getHistory, appendTurn };

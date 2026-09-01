const { redis, hasRedis } = require("./store");

// One conversation between a visitor and either the AI bot or a human agent
// who has taken over. Replaces the old history-only store: alongside the
// message log this now tracks *who* is answering, so a human can step in.
//
// Session shape:
//   {
//     id, clientId,
//     seq,                       // monotonic counter, never reset by trimming
//     agent: null | { name, avatarUrl },
//     messages: [ { seq, ts, role, content, sender? } ],
//     updatedAt
//   }
//
// role is "user" | "assistant". An assistant message carries `sender` only
// when a human agent wrote it; bot messages have none and the widget falls
// back to the configured bot identity.

const MAX_MESSAGES = 60; // retained for agent context / visitor reloads
const LLM_MAX_MESSAGES = 20; // what we actually feed the model (10 turns)
const MAX_LISTED_SESSIONS = 100;

// How long a conversation sticks around after its last message. Expiry is
// sliding -- every write pushes it out again -- so this is "idle for N days",
// not "N days since it started". A returning visitor picks up where they
// left off instead of finding an empty widget.
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 1;
const SESSION_TTL_SECONDS = Math.max(1, SESSION_TTL_DAYS) * 24 * 60 * 60;

const SESSION_KEY = "chatbot:session:";
const CLIENT_SESSIONS_KEY = "chatbot:client-sessions:";

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(sessionId);
}

function newSession(sessionId, clientId) {
  return {
    id: sessionId,
    clientId: clientId,
    seq: 0,
    agent: null,
    messages: [],
    updatedAt: Date.now(),
  };
}

// ---- in-memory backend (local dev without Redis) ----

const memSessions = new Map();

function memPrune() {
  const cutoff = Date.now() - SESSION_TTL_SECONDS * 1000;
  for (const [id, s] of memSessions) {
    if (s.updatedAt < cutoff) memSessions.delete(id);
  }
}

// ---- shared read/write ----

async function getSession(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  if (hasRedis) {
    return (await redis.get(SESSION_KEY + sessionId)) || null;
  }
  memPrune();
  return memSessions.get(sessionId) || null;
}

async function saveSession(session) {
  session.updatedAt = Date.now();
  if (hasRedis) {
    await redis.set(SESSION_KEY + session.id, session, { ex: SESSION_TTL_SECONDS });
    if (session.clientId) {
      const indexKey = CLIENT_SESSIONS_KEY + session.clientId;
      await redis.zadd(indexKey, { score: session.updatedAt, member: session.id });
      // drop index entries for sessions that have already expired
      await redis.zremrangebyscore(indexKey, 0, Date.now() - SESSION_TTL_SECONDS * 1000);
    }
  } else {
    memSessions.set(session.id, session);
  }
  return session;
}

async function getOrCreateSession(sessionId, clientId) {
  const existing = await getSession(sessionId);
  if (existing) return existing;
  return newSession(sessionId, clientId);
}

// ---- messages ----

async function appendMessage(session, { role, content, sender }) {
  session.seq += 1;
  const message = {
    seq: session.seq,
    ts: Date.now(),
    role: role,
    content: content,
  };
  if (sender) message.sender = sender;
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  await saveSession(session);
  return message;
}

// What the model sees: plain {role, content}, most recent turns only.
//
// Messages a human agent wrote are labelled inline, because otherwise the
// model reads them as its own past output and its "never state anything
// outside the business info" rule makes it contradict things a colleague
// already promised the visitor. gemini.js has a matching rule telling it to
// treat these as authoritative.
function toLlmHistory(session) {
  return session.messages.slice(-LLM_MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: m.sender ? "(human agent " + m.sender.name + "): " + m.content : m.content,
  }));
}

function messagesSince(session, sinceSeq) {
  const since = Number(sinceSeq) || 0;
  return session.messages.filter((m) => m.seq > since);
}

// ---- agent handoff ----

// Hand the conversation to a human. Subsequent visitor messages skip the AI
// entirely and wait for this agent to reply.
async function assignAgent(session, agent) {
  session.agent = { name: agent.name, avatarUrl: agent.avatarUrl || "" };
  await saveSession(session);
  return session;
}

// Give control back to the bot.
async function releaseAgent(session) {
  session.agent = null;
  await saveSession(session);
  return session;
}

// ---- listing (for the future agent dashboard) ----

async function listSessions(clientId) {
  let ids;
  if (hasRedis) {
    ids = (await redis.zrange(CLIENT_SESSIONS_KEY + clientId, 0, -1)) || [];
    ids = ids.reverse(); // most recently active first
  } else {
    memPrune();
    ids = Array.from(memSessions.values())
      .filter((s) => s.clientId === clientId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => s.id);
  }
  ids = ids.slice(0, MAX_LISTED_SESSIONS);

  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  return sessions.filter(Boolean).map((s) => {
    const last = s.messages[s.messages.length - 1];
    return {
      id: s.id,
      clientId: s.clientId,
      agent: s.agent,
      messageCount: s.messages.length,
      updatedAt: s.updatedAt,
      lastMessage: last ? { role: last.role, content: last.content.slice(0, 120) } : null,
    };
  });
}

module.exports = {
  isValidSessionId,
  getSession,
  getOrCreateSession,
  saveSession,
  appendMessage,
  toLlmHistory,
  messagesSince,
  assignAgent,
  releaseAgent,
  listSessions,
};

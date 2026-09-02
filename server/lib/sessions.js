const crypto = require("crypto");
const { redis, hasRedis } = require("./store");

// One conversation ("session") between a visitor and either the AI bot or a
// human agent who has taken over. A visitor can have several of these --
// the widget's Home tab starts a new one, the Messages tab lists past ones
// -- all grouped under a stable `visitorId` (see identity.js): either a
// verified logged-in user, or an anonymous per-device id the widget itself
// generates. That grouping is a separate index (visitor -> [conversation
// ids]) from the existing per-client index (client -> [conversation ids])
// that the agent dashboard uses to see every conversation regardless of
// who started it.
//
// Session shape:
//   {
//     id, clientId, visitorId,
//     seq,                       // monotonic counter, never reset by trimming
//     agent: null | { name, avatarUrl },
//     agentRequested: boolean,   // visitor asked for a human; AI stops even
//                                // before one actually joins (agent is set)
//     locked: boolean,           // PERMANENTLY ended (an agent chose to end
//                                // it, see closeConversation) -- visitor can
//                                // never post again, no reopen
//     tempLocked: boolean,       // TEMPORARILY paused (30 min of visitor
//                                // silence with a live agent, see
//                                // maybeAutoPauseIdleSession below) --
//                                // visitor can reopen it just by sending a
//                                // new message; any agent can then claim it
//     messages: [ { seq, ts, role, content, sender? } ],
//     updatedAt
//   }
//
// Two clocks govern how long a stale conversation stays reachable at all:
// tempLocked is about a *live agent's* time (30 min, see
// AGENT_IDLE_TIMEOUT_MINUTES below); SESSION_TTL_DAYS (1 day, sliding on
// every write) is the outer bound -- once that lapses the whole session is
// gone from storage, reopen or not. That's this project's "fully close".
//
// role is "user" | "assistant". An assistant message carries `sender` only
// when a human agent wrote it; bot messages have none and the widget falls
// back to the configured bot identity.

const MAX_MESSAGES = 60; // retained for agent context / visitor reloads
const LLM_MAX_MESSAGES = 20; // what we actually feed the model (10 turns)
const MAX_LISTED_SESSIONS = 100;
const MAX_LISTED_CONVERSATIONS = 50; // per visitor, in the Messages tab

// How long a conversation sticks around after its last message. Expiry is
// sliding -- every write pushes it out again -- so this is "idle for N days",
// not "N days since it started". A returning visitor picks up where they
// left off instead of finding an empty widget.
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 1;
const SESSION_TTL_SECONDS = Math.max(1, SESSION_TTL_DAYS) * 24 * 60 * 60;

// Once a human agent has joined, how long the visitor can go quiet before
// the conversation auto-*pauses* (tempLocked, not locked -- see the shape
// comment above). Minutes, not the usual days -- this is about a live
// agent's time, not archival retention. Reversible: the visitor reopens it
// just by sending another message, and it goes back into the claimable
// queue for any agent, not necessarily the one who had it before.
const AGENT_IDLE_TIMEOUT_MINUTES = Number(process.env.AGENT_IDLE_TIMEOUT_MINUTES) || 30;
const AGENT_IDLE_TIMEOUT_MS = Math.max(1, AGENT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
const CONVERSATION_PAUSED_MESSAGE =
  "This conversation has been temporarily closed due to inactivity. Send a message here any time to reopen it and reconnect with our team.";
const CONVERSATION_REOPENED_MESSAGE =
  "Welcome back — reconnecting you with our team.";
// Distinct wording from the pause message above -- an agent choosing to end
// things outright reads very differently to a visitor than "you went quiet
// for a while", and unlike a pause this one has no reopen.
const CONVERSATION_CLOSED_MESSAGE =
  "This conversation has been closed by our team. Start a new conversation any time.";

const SESSION_KEY = "chatbot:session:";
const CLIENT_SESSIONS_KEY = "chatbot:client-sessions:";
const VISITOR_CONVERSATIONS_KEY = "chatbot:visitor-conversations:";

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(sessionId);
}

// A visitorId is either the widget's own random per-device id or a verified
// user id from identity.js -- both are plain opaque strings, same shape.
function isValidVisitorId(visitorId) {
  return typeof visitorId === "string" && /^[a-zA-Z0-9_-]{8,160}$/.test(visitorId);
}

function newSession(sessionId, clientId, visitorId, ip) {
  return {
    id: sessionId,
    clientId: clientId,
    visitorId: visitorId || null,
    // The visitor's IP at the moment this conversation started -- used only
    // to group same-IP conversations together in the agent dashboard (see
    // summarizeForAgent/groupByIp). Never sent to the public/widget-facing
    // API (see `summarize`, distinct from `summarizeForAgent`).
    ip: ip || null,
    seq: 0,
    agent: null,
    agentRequested: false,
    locked: false,
    tempLocked: false,
    messages: [],
    // Fixed at creation, unlike updatedAt -- this is what same-IP grouping
    // sorts by, so a group's position in the list can't shift just because
    // one of its conversations got a new message.
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function visitorKey(clientId, visitorId) {
  return VISITOR_CONVERSATIONS_KEY + clientId + ":" + visitorId;
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
  let session;
  if (hasRedis) {
    session = (await redis.get(SESSION_KEY + sessionId)) || null;
  } else {
    memPrune();
    session = memSessions.get(sessionId) || null;
  }
  if (!session) return null;
  return maybeAutoPauseIdleSession(session);
}

// Runs on every read (see getSession), not on a timer -- there's no
// always-on process to run one, especially on a serverless host. If a human
// agent is engaged and the visitor hasn't posted in AGENT_IDLE_TIMEOUT_MS,
// the conversation *pauses* (tempLocked) the next time anything touches it
// (a poll, a send attempt, an agent/admin reading it). Unlike the old
// behaviour this doesn't end the conversation -- releasing the agent and
// setting tempLocked leaves agentRequested untouched, so the moment the
// visitor sends a new message (see reopenConversation, called from
// routes/chat.js) it reads as "waiting" again and re-enters the claimable
// queue for any agent. A conversation that's never read again while idle
// just never gets paused -- acceptable, since nothing is waiting on it
// either, and it'll still fall out of storage entirely once SESSION_TTL_DAYS
// of total inactivity passes.
async function maybeAutoPauseIdleSession(session) {
  if (!session.agent || session.locked || session.tempLocked) return session;
  const lastUserMessage = session.messages.filter((m) => m.role === "user").pop();
  if (!lastUserMessage) return session;

  // Measure idleness from whichever came last: the visitor's last message
  // or the moment an agent actually joined. Using the message alone means a
  // request that sat in the queue longer than the timeout gets paused the
  // instant someone picks it up -- which is the normal case, since agents
  // aren't waiting by the screen. The visitor gets a full window to respond
  // to the agent's first "hello" either way.
  const idleSince = Math.max(lastUserMessage.ts, session.agentAssignedAt || 0);
  if (Date.now() - idleSince < AGENT_IDLE_TIMEOUT_MS) return session;

  session.tempLocked = true;
  session.agent = null;
  session.agentUserId = null;
  await appendMessage(session, { role: "assistant", content: CONVERSATION_PAUSED_MESSAGE });
  return session;
}

// The visitor's side of coming back after a pause: sending any new message
// while tempLocked clears it and posts a short "welcome back" note.
// agentRequested was never touched by the pause, so the conversation reads
// as "waiting" again the moment this returns -- any agent can claim it, not
// necessarily whoever had it before. Called from routes/chat.js, after the
// visitor's own message has already been appended (mirrors requestAgent's
// pattern: the visitor's action comes first, the canned message follows).
async function reopenConversation(session) {
  if (!session.tempLocked) return session;
  session.tempLocked = false;
  await appendMessage(session, { role: "assistant", content: CONVERSATION_REOPENED_MESSAGE });
  return session;
}

async function saveSession(session) {
  session.updatedAt = Date.now();
  if (hasRedis) {
    await redis.set(SESSION_KEY + session.id, session, { ex: SESSION_TTL_SECONDS });
    const expiredBefore = Date.now() - SESSION_TTL_SECONDS * 1000;
    if (session.clientId) {
      const indexKey = CLIENT_SESSIONS_KEY + session.clientId;
      await redis.zadd(indexKey, { score: session.updatedAt, member: session.id });
      await redis.zremrangebyscore(indexKey, 0, expiredBefore);
    }
    if (session.clientId && session.visitorId) {
      const vKey = visitorKey(session.clientId, session.visitorId);
      await redis.zadd(vKey, { score: session.updatedAt, member: session.id });
      await redis.zremrangebyscore(vKey, 0, expiredBefore);
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

// Starts a brand new conversation for a visitor -- what the widget's Home
// tab "Send us a message" button, or tapping a quick-reply there, does.
// Distinct from getOrCreateSession: that resumes a specific known
// conversation, this always mints a fresh one and registers it under the
// visitor so it shows up in their Messages tab.
async function createConversation(clientId, visitorId, ip) {
  if (!isValidVisitorId(visitorId)) {
    throw new Error("A valid visitorId is required to start a conversation");
  }
  const session = newSession(crypto.randomUUID(), clientId, visitorId, ip);
  await saveSession(session);
  return session;
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

// Visitor-initiated: "talk to a human". Distinct from assignAgent below --
// no specific agent is attached yet, but the AI stops responding from this
// point on (routes/chat.js treats agentRequested the same as agent being
// set), and a canned message tells the visitor what's happening. Idempotent
// so tapping the request action twice doesn't post it twice.
async function requestAgent(session) {
  if (session.agentRequested || session.agent) return session;
  session.agentRequested = true;
  // Stamped so the dashboard queue can show how long someone has been
  // waiting, which is the number that actually matters to an agent.
  session.agentRequestedAt = Date.now();
  await appendMessage(session, {
    role: "assistant",
    content:
      "Connecting you with a member of our team — feel free to keep " +
      "typing any questions here, they'll see the whole conversation as " +
      "soon as they join.",
  });
  return session;
}

// Hand the conversation to a human. Subsequent visitor messages skip the AI
// entirely and wait for this agent to reply.
//
// `agent` is the visitor-visible identity (name + photo) and is sent
// straight to the widget, so the CRM's internal user id is kept beside it
// as `agentUserId` rather than inside it -- that field never leaves the
// agent-facing API, and it's what lets the dashboard tell "you have this
// chat" apart from "a teammate has it".
async function assignAgent(session, agent) {
  session.agent = { name: agent.name, avatarUrl: agent.avatarUrl || "" };
  session.agentUserId = agent.userId || null;
  session.agentRequested = true;
  session.tempLocked = false; // claiming a just-reopened conversation clears any leftover pause state
  // Restarts the idle clock -- see maybeAutoPauseIdleSession.
  session.agentAssignedAt = Date.now();
  await saveSession(session);
  return session;
}

// Give control back to the bot. Clears agentRequested too -- otherwise the
// AI would stay silent forever, since routes/chat.js treats that flag the
// same as an agent being attached.
async function releaseAgent(session) {
  session.agent = null;
  session.agentUserId = null;
  session.agentRequested = false;
  session.tempLocked = false;
  await saveSession(session);
  return session;
}

// An agent ending a conversation outright, as opposed to releaseAgent
// (hands back to the bot, conversation stays open) or the automatic pause
// (tempLocked, reversible by the visitor). Permanently locks it -- the
// visitor can never post again, no reopen -- with wording that makes clear
// a person chose to end it, not that they were timed out. Idempotent:
// closing an already-closed conversation is a no-op rather than posting the
// message twice.
async function closeConversation(session) {
  if (session.locked) return session;
  session.locked = true;
  session.tempLocked = false;
  session.agent = null;
  session.agentUserId = null;
  session.agentRequested = false;
  await appendMessage(session, { role: "assistant", content: CONVERSATION_CLOSED_MESSAGE });
  return session;
}

// ---- listing (agent dashboard) ----

// Agent-facing summary. Carries fields the visitor-facing `summarize()`
// deliberately omits (agentUserId, the waiting flag), so keep the two
// separate -- listVisitorConversations below feeds the widget.
function summarizeForAgent(session) {
  const last = session.messages[session.messages.length - 1];
  // The visitor's own words, kept separate from `lastMessage`. A queue of
  // requests otherwise shows nothing but the canned "connecting you with a
  // member of our team" line on every row, since that's the most recent
  // message in every waiting conversation -- useless for deciding who to
  // pick up first.
  const lastFromVisitor = session.messages.filter((m) => m.role === "user").pop();
  return {
    id: session.id,
    clientId: session.clientId,
    visitorId: session.visitorId || null,
    agent: session.agent,
    agentUserId: session.agentUserId || null,
    agentRequested: !!session.agentRequested,
    agentRequestedAt: session.agentRequestedAt || null,
    locked: !!session.locked,
    tempLocked: !!session.tempLocked,
    // "Someone asked for a human and nobody has picked it up" -- the queue
    // the dashboard notifies on. A paused (tempLocked) conversation is
    // deliberately excluded: it only becomes claimable again once the
    // visitor reopens it (see reopenConversation), not the moment it pauses.
    waiting: !!session.agentRequested && !session.agent && !session.locked && !session.tempLocked,
    seq: session.seq,
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
    lastMessage: last
      ? { role: last.role, content: last.content.slice(0, 120), sender: last.sender || null }
      : null,
    lastVisitorMessage: lastFromVisitor ? lastFromVisitor.content.slice(0, 120) : null,
    ip: session.ip || null,
    createdAt: session.createdAt || session.updatedAt,
  };
}

// Same visitor opening several tabs/incognito windows gets a different
// visitorId each time (see identity.js), so the dashboard queue used to
// show what looked like N unrelated strangers. This folds same-IP
// conversations under one shared, human-friendly number instead --
// "Visitor 3 (2 open)" rather than three unrelated-looking rows.
//
// Deliberately a same-network signal, not a same-person one: a shared
// office or coffee-shop wifi groups distinct visitors together too. It's a
// triage hint for agents, not an identity claim.
//
// Numbering is derived from each group's earliest `createdAt`, not from
// current sort order (listSessions sorts by most-recently-active) -- so a
// group's number doesn't change just because a *different* group got a new
// message. It's still only stable across the currently-listed sessions
// (capped at MAX_LISTED_SESSIONS, and older ones age out with SESSION_TTL),
// not a permanent id.
function groupByIp(summaries) {
  const groupKey = (s) => s.ip || "solo:" + s.id; // no IP on record -> its own group of one
  const earliestByKey = new Map();
  const countByKey = new Map(); // open (non-locked) conversations only
  for (const s of summaries) {
    const key = groupKey(s);
    const current = earliestByKey.get(key);
    if (current === undefined || s.createdAt < current) earliestByKey.set(key, s.createdAt);
    if (!s.locked) countByKey.set(key, (countByKey.get(key) || 0) + 1);
  }

  const orderedKeys = Array.from(earliestByKey.keys()).sort(
    (a, b) => earliestByKey.get(a) - earliestByKey.get(b)
  );
  const numberByKey = new Map(orderedKeys.map((key, i) => [key, i + 1]));

  return summaries.map((s) => {
    const key = groupKey(s);
    return {
      ...s,
      visitorNumber: numberByKey.get(key),
      sameIpOpenCount: countByKey.get(key) || 0,
    };
  });
}

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
  return groupByIp(sessions.filter(Boolean).map(summarizeForAgent));
}

function summarize(session) {
  const last = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    clientId: session.clientId,
    agent: session.agent,
    agentRequested: !!session.agentRequested,
    locked: !!session.locked,
    seq: session.seq,
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
    lastMessage: last
      ? { role: last.role, content: last.content.slice(0, 120), sender: last.sender || null }
      : null,
  };
}

// Every conversation a specific visitor has had with this client, most
// recently active first -- what the widget's Messages tab renders. `seq` on
// each summary is what the widget diffs against its locally-stored
// last-read seq to compute the unread badge (see widget.js); read state
// itself isn't tracked server-side, so it's per-browser even for a verified
// cross-device visitor.
async function listVisitorConversations(clientId, visitorId) {
  if (!isValidVisitorId(visitorId)) return [];
  let ids;
  if (hasRedis) {
    ids = (await redis.zrange(visitorKey(clientId, visitorId), 0, -1)) || [];
    ids = ids.reverse();
  } else {
    memPrune();
    ids = Array.from(memSessions.values())
      .filter((s) => s.clientId === clientId && s.visitorId === visitorId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => s.id);
  }
  ids = ids.slice(0, MAX_LISTED_CONVERSATIONS);
  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  return sessions.filter(Boolean).map(summarize);
}

module.exports = {
  isValidSessionId,
  isValidVisitorId,
  getSession,
  getOrCreateSession,
  createConversation,
  saveSession,
  appendMessage,
  toLlmHistory,
  messagesSince,
  assignAgent,
  releaseAgent,
  closeConversation,
  requestAgent,
  reopenConversation,
  listSessions,
  listVisitorConversations,
  summarizeForAgent,
  groupByIp,
};

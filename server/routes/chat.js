const express = require("express");
const crypto = require("crypto");
const { getClient, getPublicClient } = require("../lib/clients");
const { getChatReply, getSuggestedReplies } = require("../lib/gemini");
const {
  isValidSessionId,
  isValidVisitorId,
  getSession,
  createConversation,
  appendMessage,
  toLlmHistory,
  messagesSince,
  listVisitorConversations,
  requestAgent,
} = require("../lib/sessions");
const { resolveSessionId } = require("../lib/identity");

const router = express.Router();

// Suggested-reply chips only make sense while a visitor is still getting
// oriented -- past this many user messages in a conversation, skip
// generating them entirely (saves a model call and avoids clutter in a
// longer, more specific conversation).
const MAX_SUGGESTION_TURNS = 3;

// Very small fixed-window rate limiter per session, to keep the demo/API
// from being trivially hammered. Not a substitute for a real gateway limiter.
const RATE_LIMIT = 20; // messages
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map(); // sessionId -> { count, windowStart }

function isRateLimited(sessionId) {
  const now = Date.now();
  const bucket = rateBuckets.get(sessionId);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(sessionId, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

router.get("/clients/:id/public", async (req, res) => {
  const config = await getPublicClient(req.params.id);
  if (!config) return res.status(404).json({ error: "Unknown client id" });
  res.json(config);
});

// The widget calls this once on load to find out which VISITOR it is --
// not which conversation. A visitor can have many conversations (Home tab
// starts a new one, Messages tab lists past ones); this just answers "which
// bucket do they all belong to". With a verified logged-in user that's their
// cross-device identity; otherwise it's the anonymous per-device id the
// widget generated and stored itself.
router.post("/visitor/resolve", async (req, res) => {
  const { clientId, userId, userHash, anonymousVisitorId } = req.body || {};

  if (typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }
  const clientConfig = await getClient(clientId);
  if (!clientConfig) return res.status(404).json({ error: "Unknown client id" });

  const fallback = isValidVisitorId(anonymousVisitorId)
    ? anonymousVisitorId
    : crypto.randomUUID();

  const resolved = resolveSessionId({
    clientConfig,
    userId,
    userHash,
    anonymousSessionId: fallback,
  });
  res.json({ visitorId: resolved.sessionId, identified: resolved.identified });
});

// Starts a brand-new conversation for a visitor: the widget's Home tab
// "Send us a message" button, and tapping a quick-question there, both call
// this rather than reusing an existing conversation.
router.post("/conversations", async (req, res) => {
  const { clientId, visitorId } = req.body || {};
  if (typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }
  const clientConfig = await getClient(clientId);
  if (!clientConfig) return res.status(404).json({ error: "Unknown client id" });

  try {
    const session = await createConversation(clientId, visitorId);
    res.json({ sessionId: session.id, seq: session.seq, agent: session.agent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Visitor-initiated "talk to a human" -- distinct from the admin-side
// takeover (server/routes/admin.js), which is what actually attaches a
// specific agent. This just flags the conversation as waiting and posts a
// canned message; the AI stops responding to it immediately (see /chat
// below), before any agent has actually picked it up.
router.post("/sessions/:sessionId/request-agent", async (req, res) => {
  const { sessionId } = req.params;
  const { clientId } = req.body || {};

  if (!isValidSessionId(sessionId) || typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId is required" });
  }
  const session = await getSession(sessionId);
  if (!session || session.clientId !== clientId) {
    return res.status(404).json({ error: "Unknown conversation" });
  }
  if (session.locked) {
    return res.status(409).json({ error: "This conversation has ended." });
  }

  await requestAgent(session);
  res.json({ agentRequested: session.agentRequested, agent: session.agent, seq: session.seq });
});

// The widget's Messages tab: every conversation this visitor has had with
// this client, most recent first. Each entry's `seq` is what the widget
// diffs against its own locally-stored last-read value to badge unread
// conversations -- see the comment on listVisitorConversations for why that
// read state lives client-side rather than being tracked here.
router.get("/visitors/:visitorId/conversations", async (req, res) => {
  const { visitorId } = req.params;
  const { clientId } = req.query;
  if (typeof clientId !== "string") {
    return res.status(400).json({ error: "clientId query param is required" });
  }
  res.json({ conversations: await listVisitorConversations(clientId, visitorId) });
});

// The widget polls this while it's open, to pick up messages it didn't get
// as a direct reply -- i.e. anything a human agent sends after taking over,
// and the existing transcript after a page reload.
//
// The sessionId is itself the secret (an unguessable UUID minted per
// conversation); clientId is checked as defence in depth so a leaked id
// can't be read across clients.
router.get("/sessions/:sessionId/messages", async (req, res) => {
  const { sessionId } = req.params;
  const { clientId, since } = req.query;

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "Invalid session id" });
  }
  const session = await getSession(sessionId);
  if (!session) {
    return res.json({ messages: [], agent: null, agentRequested: false, locked: false, seq: 0 });
  }
  if (clientId && session.clientId && session.clientId !== clientId) {
    return res.status(404).json({ error: "Unknown session" });
  }

  res.json({
    messages: messagesSince(session, since),
    agent: session.agent,
    agentRequested: session.agentRequested,
    locked: session.locked,
    seq: session.seq,
  });
});

router.post("/chat", async (req, res) => {
  const { clientId, sessionId, message } = req.body || {};

  if (typeof clientId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "clientId and message are required" });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "message is too long" });
  }

  const clientConfig = await getClient(clientId);
  if (!clientConfig) {
    return res.status(404).json({ error: "Unknown client id" });
  }

  // Conversations are created explicitly via POST /api/conversations (so
  // they get registered under a visitor); this endpoint answers within one,
  // it doesn't mint one on the fly.
  const session = await getSession(sessionId);
  if (!session || session.clientId !== clientId) {
    return res.status(404).json({ error: "Unknown conversation. Start one via POST /api/conversations." });
  }

  if (session.locked) {
    return res.status(409).json({ error: "This conversation has ended.", locked: true });
  }

  if (isRateLimited(sessionId)) {
    return res.status(429).json({ error: "Too many messages, please slow down." });
  }

  try {
    const userMessage = await appendMessage(session, { role: "user", content: message });

    // A human agent has taken over, or the visitor has asked for one and is
    // still waiting -- either way, record the visitor's message and don't
    // call the AI. The widget picks up an agent's reply (or the "waiting"
    // canned message posted by requestAgent) by polling
    // /sessions/:id/messages rather than getting it inline here.
    if (session.agent || session.agentRequested) {
      return res.json({
        pending: true,
        agent: session.agent,
        agentRequested: session.agentRequested,
        sessionId: sessionId,
        seq: userMessage.seq,
      });
    }

    const history = toLlmHistory(session).slice(0, -1); // exclude the message we just added
    const turnNumber = session.messages.filter((m) => m.role === "user").length;
    const wantSuggestions = turnNumber <= MAX_SUGGESTION_TURNS;

    const [reply, suggestions] = await Promise.all([
      getChatReply({ clientConfig, history, userMessage: message }),
      wantSuggestions
        ? getSuggestedReplies({ clientConfig, history, userMessage: message })
        : Promise.resolve([]),
    ]);
    const botMessage = await appendMessage(session, { role: "assistant", content: reply });

    res.json({ reply, sessionId, seq: botMessage.seq, suggestions });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(500).json({ error: "Sorry, something went wrong generating a reply." });
  }
});

module.exports = router;

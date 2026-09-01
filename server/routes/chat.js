const express = require("express");
const crypto = require("crypto");
const { getClient, getPublicClient } = require("../lib/clients");
const { getChatReply } = require("../lib/gemini");
const {
  isValidSessionId,
  getSession,
  getOrCreateSession,
  appendMessage,
  toLlmHistory,
  messagesSince,
} = require("../lib/sessions");

const router = express.Router();

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

// The widget polls this while it's open, to pick up messages it didn't get
// as a direct reply -- i.e. anything a human agent sends after taking over,
// and the existing transcript after a page reload.
//
// The sessionId is itself the secret (an unguessable UUID minted per
// visitor); clientId is checked as defence in depth so a leaked id can't be
// read across clients.
router.get("/sessions/:sessionId/messages", async (req, res) => {
  const { sessionId } = req.params;
  const { clientId, since } = req.query;

  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: "Invalid session id" });
  }
  const session = await getSession(sessionId);
  if (!session) {
    return res.json({ messages: [], agent: null, seq: 0 });
  }
  if (clientId && session.clientId && session.clientId !== clientId) {
    return res.status(404).json({ error: "Unknown session" });
  }

  res.json({
    messages: messagesSince(session, since),
    agent: session.agent,
    seq: session.seq,
  });
});

router.post("/chat", async (req, res) => {
  const { clientId, message } = req.body || {};
  let { sessionId } = req.body || {};

  if (typeof clientId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "clientId and message are required" });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "message is too long" });
  }
  if (!isValidSessionId(sessionId)) {
    sessionId = crypto.randomUUID();
  }

  const clientConfig = await getClient(clientId);
  if (!clientConfig) {
    return res.status(404).json({ error: "Unknown client id" });
  }

  if (isRateLimited(sessionId)) {
    return res.status(429).json({ error: "Too many messages, please slow down." });
  }

  try {
    const session = await getOrCreateSession(sessionId, clientId);
    const userMessage = await appendMessage(session, { role: "user", content: message });

    // A human agent has taken this conversation over -- record the visitor's
    // message and let them answer. The widget picks the reply up by polling
    // /sessions/:id/messages rather than getting it inline here.
    if (session.agent) {
      return res.json({
        pending: true,
        agent: session.agent,
        sessionId: sessionId,
        seq: userMessage.seq,
      });
    }

    const history = toLlmHistory(session).slice(0, -1); // exclude the message we just added
    const reply = await getChatReply({ clientConfig, history, userMessage: message });
    const botMessage = await appendMessage(session, { role: "assistant", content: reply });

    res.json({ reply, sessionId, seq: botMessage.seq });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(500).json({ error: "Sorry, something went wrong generating a reply." });
  }
});

module.exports = router;

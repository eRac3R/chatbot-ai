const express = require("express");
const crypto = require("crypto");
const { getClient, getPublicClient } = require("../lib/clients");
const { getChatReply } = require("../lib/gemini");
const { getHistory, appendTurn } = require("../lib/history");

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

router.get("/clients/:id/public", (req, res) => {
  const config = getPublicClient(req.params.id);
  if (!config) return res.status(404).json({ error: "Unknown client id" });
  res.json(config);
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
  if (!sessionId || typeof sessionId !== "string") {
    sessionId = crypto.randomUUID();
  }

  const clientConfig = getClient(clientId);
  if (!clientConfig) {
    return res.status(404).json({ error: "Unknown client id" });
  }

  if (isRateLimited(sessionId)) {
    return res.status(429).json({ error: "Too many messages, please slow down." });
  }

  try {
    const history = getHistory(sessionId);
    const reply = await getChatReply({ clientConfig, history, userMessage: message });
    appendTurn(sessionId, message, reply);
    res.json({ reply, sessionId });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(500).json({ error: "Sorry, something went wrong generating a reply." });
  }
});

module.exports = router;

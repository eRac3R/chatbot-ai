// In-memory per-session conversation history. Good enough for a single-process
// deployment; swap for Redis if you scale to multiple instances.

const MAX_TURNS = 10; // user+assistant pairs kept per session
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle -> forget

const sessions = new Map(); // sessionId -> { messages: [{role, content}], lastSeen }

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getHistory(sessionId) {
  cleanup();
  const session = sessions.get(sessionId);
  return session ? session.messages : [];
}

function appendTurn(sessionId, userMessage, assistantReply) {
  cleanup();
  const session = sessions.get(sessionId) || { messages: [], lastSeen: Date.now() };
  session.messages.push({ role: "user", content: userMessage });
  session.messages.push({ role: "assistant", content: assistantReply });
  // Trim to last MAX_TURNS pairs (2 * MAX_TURNS messages)
  const maxMessages = MAX_TURNS * 2;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(-maxMessages);
  }
  session.lastSeen = Date.now();
  sessions.set(sessionId, session);
}

module.exports = { getHistory, appendTurn };

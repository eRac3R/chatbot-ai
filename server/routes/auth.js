const express = require("express");
const { authenticate, publicUser, getUser, updateUser } = require("../lib/users");
const { getClient } = require("../lib/clients");
const {
  createToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} = require("../lib/auth");

const router = express.Router();

// Fixed-window limiter on login attempts, same shape as the one in
// routes/chat.js. Keyed by IP + email so one attacker can't lock out a real
// user by hammering their address from elsewhere. In-memory, so on
// serverless each instance counts separately -- this raises the cost of
// guessing, it doesn't make it impossible.
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginBuckets = new Map();

function isLoginRateLimited(key) {
  const now = Date.now();
  const bucket = loginBuckets.get(key);
  if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
    loginBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > LOGIN_LIMIT;
}

// Everything the dashboard needs to render itself for this user: who they
// are, and enough of their workspace to show its name and brand colour.
async function sessionPayload(user) {
  const client = await getClient(user.clientId);
  return {
    user: publicUser(user),
    workspace: client
      ? { id: client.id, botName: client.botName, brandColor: client.brandColor }
      : { id: user.clientId, botName: user.clientId, brandColor: "#6366f1" },
  };
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const key = `${req.ip}:${String(email || "").toLowerCase()}`;
  if (isLoginRateLimited(key)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }

  const user = await authenticate(email, password);
  // Deliberately the same message for "no such account" and "wrong
  // password" -- distinguishing them turns this into an account enumerator.
  if (!user) return res.status(401).json({ error: "Incorrect email or password" });

  setSessionCookie(res, createToken(user.id));
  res.json(await sessionPayload(user));
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// The dashboard calls this on load to decide between the login screen and
// the app itself.
router.get("/me", requireAuth, async (req, res) => {
  res.json(await sessionPayload(req.user));
});

// Editing your own profile. The name and photo set here are what a visitor
// sees in the widget once this agent takes a chat, so it's not just vanity.
// Role and clientId are deliberately not editable -- privilege escalation
// would be as easy as PATCHing your own role to "owner".
router.post("/me", requireAuth, async (req, res) => {
  const { name, avatarUrl, password } = req.body || {};
  try {
    const updated = await updateUser(req.user.id, { name, avatarUrl, password });
    res.json(await sessionPayload(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

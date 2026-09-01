const crypto = require("crypto");
const { getUser } = require("./users");

// Login sessions for the agent CRM.
//
// The token is stateless and self-verifying: "<userId>.<expiry>.<hmac>".
// Nothing is stored server-side, which matters because the app runs on
// serverless hosts where any request can hit a cold instance -- an
// in-memory session table would log everyone out at random. The trade-off
// is that a token can't be revoked before it expires; logging out clears
// the cookie, and changing a user's password does NOT kill their other
// sessions. Acceptable at this size, but it's the thing to revisit first if
// this ever needs "sign out everywhere".

const COOKIE_NAME = "branofy_session";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// A dedicated SESSION_SECRET is preferred, but deriving one from ADMIN_KEY
// keeps local dev zero-config. Derived rather than used directly so the
// admin key itself never doubles as the signing key.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return null;
  return crypto.createHmac("sha256", adminKey).update("branofy-session-v1").digest("hex");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function createToken(userId) {
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the userId, or null if the token is malformed, tampered with, or
// expired. Never throws -- callers treat null as "not logged in".
function verifyToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts;

  const expected = sign(`${userId}.${expiresAt}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (!Number(expiresAt) || Number(expiresAt) < Date.now()) return null;
  return userId;
}

// Express has no built-in cookie parser and this is the only cookie the app
// reads, so a tiny parser beats adding a dependency.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, token) {
  // SameSite=Lax means the browser won't attach this cookie to cross-site
  // POSTs, which is the CSRF protection for the whole workspace API.
  // Secure is skipped on localhost, where there's no HTTPS.
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=${Math.floor(
      SESSION_MS / 1000
    )}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=0`);
}

// ---- middleware ----

// Populates req.user from the session cookie. Rejects rather than falling
// through, so every route mounted behind it can assume req.user exists.
async function requireAuth(req, res, next) {
  if (!sessionSecret()) {
    return res.status(500).json({
      error: "Server misconfigured: set SESSION_SECRET (or ADMIN_KEY) in .env",
    });
  }
  const userId = verifyToken(readCookie(req, COOKIE_NAME));
  if (!userId) return res.status(401).json({ error: "Not signed in" });

  const user = await getUser(userId);
  // The token can outlive the account it points at (deleted teammate).
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Not signed in" });
  }
  req.user = user;
  next();
}

// Settings and team management are owner-only; agents can answer chats but
// can't change what the bot says or who else has access.
function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== "owner") {
    return res.status(403).json({ error: "Only a workspace owner can do that" });
  }
  next();
}

// The platform owner (us), authenticated by the global ADMIN_KEY rather
// than a workspace login. This is what creates new workspaces and their
// first owner account -- deliberately NOT something a customer can reach.
function requirePlatformAdmin(req, res, next) {
  const provided = req.header("x-admin-key");
  const expected = process.env.ADMIN_KEY;
  if (!expected || expected === "change-me-to-a-long-random-secret") {
    return res.status(500).json({
      error: "Server misconfigured: set a real ADMIN_KEY in .env before using the admin API.",
    });
  }
  if (provided !== expected) {
    return res.status(401).json({ error: "Invalid or missing x-admin-key header" });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  createToken,
  verifyToken,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireOwner,
  requirePlatformAdmin,
};

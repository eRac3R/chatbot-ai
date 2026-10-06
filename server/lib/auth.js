const crypto = require("crypto");
const { getUser } = require("./users");
const { getClient } = require("./clients");

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

const COOKIE_NAME = "agent_session";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// A dedicated SESSION_SECRET is preferred, but deriving one from ADMIN_KEY
// keeps local dev zero-config. Derived rather than used directly so the
// admin key itself never doubles as the signing key.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return null;
  return crypto.createHmac("sha256", adminKey).update("agent-session-v1").digest("hex");
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

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Buffers of different length would throw in timingSafeEqual rather than
  // just returning false -- and length itself is safe to leak here (it's
  // not derived from the secret), so this short-circuit is fine.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Server-to-server alternative to the cookie login above -- e.g. a CRM this
// workspace is embedded in, calling on behalf of whichever of ITS OWN users
// is currently active, rather than a human logging into this product
// directly. x-workspace-id + x-api-key select which workspace and which of
// its two keys (see ownerApiKey/agentApiKey in lib/clients.js) is being
// used; x-agent-id/x-agent-name/x-agent-avatar identify the acting person,
// since we have no account of our own for them -- x-agent-id in particular
// is what session.agentUserId ends up set to, so two different external
// agents claiming/replying still collide correctly (see loadOwnSession's
// callers in routes/workspace.js) instead of every API-key call looking
// like the same anonymous caller.
async function authenticateWithApiKey(req) {
  const clientId = req.header("x-workspace-id");
  const apiKey = req.header("x-api-key");
  if (!clientId || !apiKey) return null;

  const client = await getClient(clientId);
  if (!client) return null;

  let role = null;
  if (client.ownerApiKey && timingSafeEqualStrings(apiKey, client.ownerApiKey)) role = "owner";
  else if (client.agentApiKey && timingSafeEqualStrings(apiKey, client.agentApiKey)) role = "agent";
  if (!role) return null;

  const agentId = req.header("x-agent-id");
  const agentName = req.header("x-agent-name");
  // Every read (GET) in this API is either workspace-wide (inbox, config,
  // team list) or already scoped by a session id in the URL -- nothing
  // about "who's asking" changes the answer, so identity is optional there.
  // Every write (POST/DELETE) either needs it directly (claim/reply/close
  // use x-agent-id for the same-agent collision guard against
  // session.agentUserId, and x-agent-name as what the visitor sees in
  // place of the bot) or is fine defaulting it (release doesn't check
  // ownership at all; addUser/removeUser don't use identity downstream
  // either) -- requiring it uniformly on writes is a deliberate "every
  // mutating action names an actor" policy, not something each route has
  // to opt into individually.
  if (req.method !== "GET" && (!agentId || !agentName)) return null;

  return {
    // Prefixed so this can never collide with a real users.js id ("usr_...")
    // if the same string ever got reused as an x-agent-id by mistake.
    id: agentId ? "ext:" + agentId : null,
    clientId,
    role,
    name: agentName ? agentName.slice(0, 60) : "",
    avatarUrl: req.header("x-agent-avatar") || "",
  };
}

// Populates req.user from either an API key (server-to-server) or the
// session cookie (browser). Rejects rather than falling through, so every
// route mounted behind it can assume req.user exists either way -- nothing
// downstream (loadOwnSession, requireOwner, claim/reply's identity fields)
// needs to know or care which path authenticated the request.
async function requireAuth(req, res, next) {
  // x-api-key present at all means the caller is unambiguously attempting
  // key auth -- fail with a specific error rather than silently falling
  // through to the cookie check and returning a generic "Not signed in"
  // for what's actually a bad key or a missing agent-identity header.
  if (req.header("x-api-key")) {
    const apiKeyUser = await authenticateWithApiKey(req);
    if (!apiKeyUser) {
      return res.status(401).json({
        error: "Invalid workspace API key, or missing x-agent-id/x-agent-name headers",
      });
    }
    req.user = apiKeyUser;
    return next();
  }

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

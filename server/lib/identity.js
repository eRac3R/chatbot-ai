const crypto = require("crypto");

// Cross-device chat history.
//
// A visitor's conversation normally lives under a random id in their
// browser's localStorage, so it's per-device by definition. To follow a
// person across their phone and laptop we need to know they're the same
// person -- which only the business's own website knows, since it's the one
// with user accounts.
//
// So the embedding site passes the logged-in user's id into the widget. That
// alone can't be trusted: it's in the page, and anyone could edit it in
// devtools to read someone else's transcript. The site therefore also passes
// an HMAC of that id, computed on ITS server with a secret only it and we
// know (`identitySecret` on the client config). Forging one without the
// secret isn't feasible, so a valid hash is proof of identity.
//
// This is the same scheme Intercom calls "identity verification". If the
// hash is missing or wrong we silently fall back to the anonymous
// per-device session rather than erroring -- a misconfigured site should
// lose history continuity, not break its chat.

function signUserId(identitySecret, userId) {
  return crypto.createHmac("sha256", identitySecret).update(String(userId)).digest("hex");
}

function verifyUserHash(identitySecret, userId, userHash) {
  if (!identitySecret || typeof userHash !== "string") return false;
  const expected = signUserId(identitySecret, userId);
  if (expected.length !== userHash.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(userHash));
  } catch {
    return false;
  }
}

// Deterministic per (client, user) session id, so the same person lands on
// the same conversation from any device.
//
// Keyed on the client's identitySecret, NOT a plain hash of public values.
// The rest of the API treats a session id as a bearer credential, so a
// plain sha256(clientId + userId) would be computable by anyone who knows a
// victim's user id -- letting them read that person's transcript without
// ever passing identity verification. Deriving it from the secret means the
// id can't be produced offline at all.
function sessionIdForUser(identitySecret, clientId, userId) {
  const digest = crypto
    .createHmac("sha256", identitySecret)
    .update("session:" + clientId + ":" + String(userId))
    .digest("hex");
  return "u-" + digest.slice(0, 40);
}

// Returns the session id the widget should actually use, plus whether the
// visitor was recognised (the widget shows nothing different either way --
// this is for logging/debugging).
function resolveSessionId({ clientConfig, userId, userHash, anonymousSessionId }) {
  if (userId && verifyUserHash(clientConfig.identitySecret, userId, userHash)) {
    return {
      sessionId: sessionIdForUser(clientConfig.identitySecret, clientConfig.id, userId),
      identified: true,
    };
  }
  return { sessionId: anonymousSessionId, identified: false };
}

module.exports = { signUserId, verifyUserHash, sessionIdForUser, resolveSessionId };

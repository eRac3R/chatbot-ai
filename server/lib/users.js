const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { redis, hasRedis } = require("./store");

// A login for the agent CRM. Every user belongs to exactly one workspace,
// identified by the same `clientId` the widget embeds with -- so a user
// record IS the tenancy boundary. Nothing in routes/workspace.js reads a
// clientId from the request; it always comes off the authenticated user,
// which is what stops one business from touching another's data.
//
// User shape:
//   {
//     id, clientId, email, name, avatarUrl,
//     role: "owner" | "agent",
//     passwordSalt, passwordHash,
//     createdAt, updatedAt
//   }
//
// "owner" is the business itself: can change the knowledge base, branding
// and team. "agent" is their staff: can answer chats and nothing else.

const DATA_DIR = path.join(__dirname, "..", "data", "users");
const USER_KEY = "chatbot:user:";
const USER_EMAIL_KEY = "chatbot:user-email:"; // email -> userId
const CLIENT_USERS_KEY = "chatbot:client-users:"; // clientId -> set of userIds

const ROLES = ["owner", "agent"];
const MIN_PASSWORD_LENGTH = 8;

// scrypt is in Node's stdlib, so this adds no dependency. The cost
// parameters are the Node defaults (N=16384), which take ~50-100ms per
// hash -- slow enough to make offline guessing expensive, fast enough for
// a login endpoint.
const SCRYPT_KEYLEN = 64;

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  return value.length >= 3 && value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// An agent's profile photo, rendered straight into the visitor's widget
// once they claim a chat (see assignAgent in lib/sessions.js). Accepts
// either an ordinary http(s) link, or a data: URI from the "My profile"
// tab's upload-and-resize-client-side flow -- explicitly only the safe
// raster formats (never image/svg+xml, which can carry embedded scripts,
// and never a non-image mime type). MAX_AVATAR_DATA_URI_LENGTH is generous
// for a client-resized small square photo but still bounded, since this
// whole user record is stored as one value.
const MAX_AVATAR_DATA_URI_LENGTH = 300 * 1024;
const MAX_AVATAR_URL_LENGTH = 2000;

function sanitizeAvatar(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:")) {
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(trimmed)) return "";
    return trimmed.length <= MAX_AVATAR_DATA_URI_LENGTH ? trimmed : "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href.length <= MAX_AVATAR_URL_LENGTH ? parsed.href : "";
  } catch {
    return "";
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return reject(err);
      resolve({ passwordSalt: salt, passwordHash: derived.toString("hex") });
    });
  });
}

function verifyPassword(password, salt, expectedHash) {
  return new Promise((resolve) => {
    if (typeof password !== "string" || !salt || !expectedHash) return resolve(false);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return resolve(false);
      const expected = Buffer.from(expectedHash, "hex");
      // Lengths must match before timingSafeEqual, which throws otherwise.
      if (expected.length !== derived.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derived, expected));
    });
  });
}

// What's safe to send to the browser: everything except the password material.
function publicUser(user) {
  if (!user) return null;
  const { passwordSalt, passwordHash, ...rest } = user;
  return rest;
}

// ---- filesystem backend (local dev, no Redis configured) ----

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileReadAll() {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fileGetUser(userId) {
  const file = path.join(DATA_DIR, `${userId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Local dev only ever holds a handful of users, so a directory scan for the
// email lookup is cheaper than maintaining a second index file.
function fileGetUserByEmail(email) {
  return fileReadAll().find((u) => u.email === normalizeEmail(email)) || null;
}

function fileListUsers(clientId) {
  return fileReadAll().filter((u) => u.clientId === clientId);
}

function fileSaveUser(user) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, `${user.id}.json`), JSON.stringify(user, null, 2));
}

function fileDeleteUser(userId) {
  const file = path.join(DATA_DIR, `${userId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// ---- Redis backend (Vercel / any stateless host) ----

async function redisGetUser(userId) {
  return (await redis.get(USER_KEY + userId)) || null;
}

async function redisGetUserByEmail(email) {
  const userId = await redis.get(USER_EMAIL_KEY + normalizeEmail(email));
  return userId ? redisGetUser(userId) : null;
}

async function redisListUsers(clientId) {
  const ids = (await redis.smembers(CLIENT_USERS_KEY + clientId)) || [];
  const users = await Promise.all(ids.map((id) => redisGetUser(id)));
  return users.filter(Boolean);
}

async function redisSaveUser(user) {
  await redis.set(USER_KEY + user.id, user);
  await redis.set(USER_EMAIL_KEY + user.email, user.id);
  await redis.sadd(CLIENT_USERS_KEY + user.clientId, user.id);
}

async function redisDeleteUser(user) {
  await redis.del(USER_KEY + user.id);
  await redis.del(USER_EMAIL_KEY + user.email);
  await redis.srem(CLIENT_USERS_KEY + user.clientId, user.id);
  return true;
}

// ---- public API ----

async function getUser(userId) {
  if (typeof userId !== "string" || !userId) return null;
  return hasRedis ? redisGetUser(userId) : fileGetUser(userId);
}

async function getUserByEmail(email) {
  if (!isValidEmail(email)) return null;
  return hasRedis ? redisGetUserByEmail(email) : fileGetUserByEmail(email);
}

async function listUsers(clientId) {
  const users = hasRedis ? await redisListUsers(clientId) : fileListUsers(clientId);
  return users.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

async function createUser({ clientId, email, password, name, role, avatarUrl }) {
  if (!isValidEmail(email)) throw new Error("A valid email address is required");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(", ")}`);
  if (typeof clientId !== "string" || !clientId) throw new Error("clientId is required");

  const normalized = normalizeEmail(email);
  if (await getUserByEmail(normalized)) {
    throw new Error("An account with that email already exists");
  }

  const { passwordSalt, passwordHash } = await hashPassword(password);
  const now = new Date().toISOString();
  const user = {
    id: "usr_" + crypto.randomBytes(12).toString("hex"),
    clientId,
    email: normalized,
    name: (typeof name === "string" && name.trim().slice(0, 60)) || normalized.split("@")[0],
    avatarUrl: sanitizeAvatar(avatarUrl),
    role,
    passwordSalt,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  };

  if (hasRedis) await redisSaveUser(user);
  else fileSaveUser(user);
  return user;
}

async function updateUser(userId, changes) {
  const user = await getUser(userId);
  if (!user) return null;

  if (changes.name !== undefined) user.name = String(changes.name).trim().slice(0, 60);
  if (changes.avatarUrl !== undefined) {
    user.avatarUrl = sanitizeAvatar(changes.avatarUrl);
  }
  if (changes.role !== undefined) {
    if (!ROLES.includes(changes.role)) throw new Error("Invalid role");
    user.role = changes.role;
  }
  if (changes.password !== undefined) {
    if (typeof changes.password !== "string" || changes.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    Object.assign(user, await hashPassword(changes.password));
  }
  user.updatedAt = new Date().toISOString();

  if (hasRedis) await redisSaveUser(user);
  else fileSaveUser(user);
  return user;
}

async function deleteUser(userId) {
  const user = await getUser(userId);
  if (!user) return false;
  return hasRedis ? redisDeleteUser(user) : fileDeleteUser(userId);
}

// Login check. Returns the user on success, null on any failure -- the
// caller must not distinguish "no such email" from "wrong password" in what
// it tells the browser, or the endpoint becomes an account enumerator.
async function authenticate(email, password) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
  return ok ? user : null;
}

async function countUsers(clientId) {
  return (await listUsers(clientId)).length;
}

module.exports = {
  ROLES,
  MIN_PASSWORD_LENGTH,
  isValidEmail,
  normalizeEmail,
  publicUser,
  getUser,
  getUserByEmail,
  listUsers,
  countUsers,
  createUser,
  updateUser,
  deleteUser,
  authenticate,
};

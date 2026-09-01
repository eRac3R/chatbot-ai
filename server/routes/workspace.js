const express = require("express");
const { getClient, upsertClient } = require("../lib/clients");
const {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getUser,
  publicUser,
} = require("../lib/users");
const {
  getSession,
  appendMessage,
  assignAgent,
  releaseAgent,
  listSessions,
  summarizeForAgent,
} = require("../lib/sessions");
const { requireAuth, requireOwner } = require("../lib/auth");

const router = express.Router();

// The agent CRM's API. Everything here is behind a workspace login, and --
// the important part -- no route reads a clientId from the request. It
// always comes from req.user.clientId, so a signed-in user physically
// cannot address another business's data by editing a URL. That's the
// difference between this and /api/admin, which trusts a single shared key
// and therefore can only ever be used by us, not by customers.
router.use(requireAuth);

// Loads a conversation and refuses it unless it belongs to the caller's
// workspace. Session ids are UUIDs so they aren't guessable, but "hard to
// guess" is not authorization -- ids leak through logs, screenshots and
// support tickets. Every session route goes through here.
async function loadOwnSession(req, res) {
  const session = await getSession(req.params.sessionId);
  if (!session || session.clientId !== req.user.clientId) {
    res.status(404).json({ error: "Unknown conversation" });
    return null;
  }
  return session;
}

// ---- inbox ----

// The whole dashboard state in one call. The front end polls this on a
// timer (a few seconds) rather than holding a socket open, because on
// serverless there's no long-lived process to keep one alive -- and it
// diffs `waiting` between polls to decide when to raise a notification.
router.get("/inbox", async (req, res) => {
  const sessions = await listSessions(req.user.clientId);
  res.json({
    sessions,
    counts: {
      waiting: sessions.filter((s) => s.waiting).length,
      mine: sessions.filter((s) => s.agentUserId === req.user.id && !s.locked).length,
      active: sessions.filter((s) => s.agent && !s.locked).length,
    },
    serverTime: Date.now(),
  });
});

// Full transcript for the conversation pane.
router.get("/sessions/:sessionId", async (req, res) => {
  const session = await loadOwnSession(req, res);
  if (!session) return;
  res.json({
    ...summarizeForAgent(session),
    messages: session.messages,
  });
});

// Claim a waiting conversation -- the "any agent can pick it up when free"
// action. First writer wins: if a teammate got there first we return 409
// with who has it, so the loser's UI can correct itself instead of two
// agents unknowingly answering the same visitor.
//
// This is a read-then-write, so a genuinely simultaneous claim could still
// double-assign. Narrow enough at this scale to accept; closing it properly
// needs a compare-and-set in Redis.
router.post("/sessions/:sessionId/claim", async (req, res) => {
  const session = await loadOwnSession(req, res);
  if (!session) return;
  if (session.locked) return res.status(409).json({ error: "This conversation has ended." });

  if (session.agent && session.agentUserId && session.agentUserId !== req.user.id) {
    const holder = await getUser(session.agentUserId);
    return res.status(409).json({
      error: `${holder ? holder.name : "Another agent"} already picked this up`,
      agent: session.agent,
    });
  }

  // The visitor sees this agent's name and photo in place of the bot from
  // here on, so the profile in Settings is customer-facing.
  await assignAgent(session, {
    name: req.user.name,
    avatarUrl: req.user.avatarUrl,
    userId: req.user.id,
  });

  const { greeting } = req.body || {};
  if (typeof greeting === "string" && greeting.trim()) {
    await appendMessage(session, {
      role: "assistant",
      content: greeting.trim().slice(0, 2000),
      sender: session.agent,
    });
  }
  res.json(summarizeForAgent(session));
});

// Send a message to the visitor as the human agent.
router.post("/sessions/:sessionId/reply", async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  const session = await loadOwnSession(req, res);
  if (!session) return;
  if (session.locked) return res.status(409).json({ error: "This conversation has ended." });
  if (!session.agent) {
    return res.status(409).json({ error: "Pick this conversation up before replying" });
  }
  // Guard against replying into a chat a teammate holds -- otherwise two
  // agents' messages interleave under one name in the visitor's widget.
  if (session.agentUserId && session.agentUserId !== req.user.id) {
    const holder = await getUser(session.agentUserId);
    return res
      .status(409)
      .json({ error: `${holder ? holder.name : "Another agent"} is handling this conversation` });
  }

  const saved = await appendMessage(session, {
    role: "assistant",
    content: message.trim().slice(0, 4000),
    sender: session.agent,
  });
  res.json({ message: saved, seq: session.seq });
});

// Hand the conversation back to the AI. The bot gets everything the agent
// said as context (see toLlmHistory in lib/sessions.js).
router.post("/sessions/:sessionId/release", async (req, res) => {
  const session = await loadOwnSession(req, res);
  if (!session) return;
  await releaseAgent(session);
  res.json(summarizeForAgent(session));
});

// ---- team (owner only) ----

router.get("/users", requireOwner, async (req, res) => {
  const users = await listUsers(req.user.clientId);
  res.json({ users: users.map(publicUser) });
});

router.post("/users", requireOwner, async (req, res) => {
  const { email, password, name, role } = req.body || {};
  try {
    // clientId comes from the session, never the body -- otherwise an owner
    // could mint accounts inside someone else's workspace.
    const user = await createUser({
      clientId: req.user.clientId,
      email,
      password,
      name,
      role: role === "owner" ? "owner" : "agent",
    });
    res.json(publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/users/:userId", requireOwner, async (req, res) => {
  const target = await getUser(req.params.userId);
  if (!target || target.clientId !== req.user.clientId) {
    return res.status(404).json({ error: "Unknown user" });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: "You can't remove your own account" });
  }
  // Refuse to remove the last owner, which would leave the workspace with
  // nobody able to reach Settings or invite anyone back in.
  if (target.role === "owner") {
    const owners = (await listUsers(req.user.clientId)).filter((u) => u.role === "owner");
    if (owners.length <= 1) {
      return res.status(400).json({ error: "A workspace needs at least one owner" });
    }
  }
  await deleteUser(target.id);
  res.json({ deleted: true });
});

router.post("/users/:userId", requireOwner, async (req, res) => {
  const target = await getUser(req.params.userId);
  if (!target || target.clientId !== req.user.clientId) {
    return res.status(404).json({ error: "Unknown user" });
  }
  const { name, role, password } = req.body || {};
  // Same last-owner guard as delete: demoting the only owner strands the
  // workspace just as effectively as deleting them.
  if (role && role !== target.role && target.role === "owner") {
    const owners = (await listUsers(req.user.clientId)).filter((u) => u.role === "owner");
    if (owners.length <= 1) {
      return res.status(400).json({ error: "A workspace needs at least one owner" });
    }
  }
  try {
    const updated = await updateUser(target.id, { name, role, password });
    res.json(publicUser(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- knowledge base / branding (owner only) ----
//
// This is the old standalone admin page, moved inside the login so a
// business can maintain its own bot without us handing out a shared key.

router.get("/client", requireOwner, async (req, res) => {
  const client = await getClient(req.user.clientId);
  if (!client) return res.status(404).json({ error: "Workspace not found" });
  const { identitySecret, ...safe } = client;
  res.json(safe);
});

router.post("/client", requireOwner, async (req, res) => {
  try {
    // Force the id: whatever the body says, an owner can only ever write to
    // their own workspace.
    const saved = await upsertClient({ ...(req.body || {}), id: req.user.clientId });
    const { identitySecret, ...safe } = saved;
    res.json(safe);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

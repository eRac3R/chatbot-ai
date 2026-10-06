const express = require("express");
const multer = require("multer");
const {
  getClient,
  listClients,
  listClientSummaries,
  upsertClient,
  deleteClient,
} = require("../lib/clients");
const { crawlWebsite } = require("../lib/crawler");
const { getSuggestedFaqs } = require("../lib/llm");
const { extractPdfText } = require("../lib/pdfExtractor");
const {
  getSession,
  appendMessage,
  assignAgent,
  releaseAgent,
  listSessions,
} = require("../lib/sessions");
const {
  listUsers,
  createUser,
  deleteUser,
  getUser,
  publicUser,
} = require("../lib/users");
const { requirePlatformAdmin, createToken, setSessionCookie } = require("../lib/auth");

const router = express.Router();

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are accepted"));
    }
    cb(null, true);
  },
});

// The platform-owner API: creating and deleting whole workspaces, and
// minting their first login. Authenticated by the single shared ADMIN_KEY,
// which is exactly why it must never be handed to a customer -- one key
// reaches every business. Customers get workspace logins instead and use
// /api/workspace (see routes/workspace.js), which scopes everything to
// their own clientId.
router.use(requirePlatformAdmin);

router.get("/clients", async (req, res) => {
  res.json({ clients: await listClients() });
});

// Everything the Agent Desk's "Platform Admin" view (public/app.html,
// #adminPanel) needs in one round trip: per-business summary (brand, FAQ
// count, timestamps) plus how many people can sign in to each, broken down
// by role. Distinct from the bare id list above, which older tooling may
// still depend on.
router.get("/workspaces", async (req, res) => {
  const summaries = await listClientSummaries();
  const workspaces = await Promise.all(
    summaries.map(async (client) => {
      const users = await listUsers(client.id);
      return {
        ...client,
        userCount: users.length,
        ownerCount: users.filter((u) => u.role === "owner").length,
        agentCount: users.filter((u) => u.role === "agent").length,
      };
    })
  );
  res.json({ workspaces });
});

router.get("/clients/:id", async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  res.json(client);
});

// Support access: signs this browser in as the workspace's owner, without
// their password. Sets the same session cookie their own login would, so
// the normal workspace app loads as them. Every use is logged on the
// server, and only the platform admin key can reach this route.
router.post("/clients/:id/impersonate", async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  const owner = (await listUsers(client.id)).find((u) => u.role === "owner");
  if (!owner) {
    return res.status(404).json({ error: "This workspace has no owner account to sign in as" });
  }
  setSessionCookie(res, createToken(owner.id));
  // A plain, readable cookie so the dashboard can show the "Support view"
  // banner. It grants nothing by itself -- access is the session cookie above.
  res.append(
    "Set-Cookie",
    `support_view=${encodeURIComponent(client.id)}; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}` +
      (process.env.NODE_ENV === "production" ? "; Secure" : "")
  );
  console.log(
    `[impersonate] ${new Date().toISOString()} platform admin signed in as owner ${owner.email} of workspace "${client.id}"`
  );
  res.json({ ok: true, workspace: client.id, owner: owner.email });
});

router.post("/clients", async (req, res) => {
  try {
    const saved = await upsertClient(req.body || {});
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Fetches a business's website and extracts text (start page + a few
// same-domain FAQ/about/pricing-ish pages) to pre-fill a client's
// businessInfo. Returns the extracted text for the admin to review/edit
// before saving -- it does not write to a client config by itself.
router.post("/crawl", async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url is required" });
  }
  try {
    const result = await crawlWebsite(url.trim());
    // Best-effort: a crawl that succeeds but fails to produce FAQs (e.g. the
    // LLM call errors) still returns businessInfo/navPages fine --
    // getSuggestedFaqs never throws, just returns [].
    const suggestedFaqs = await getSuggestedFaqs({ businessInfo: result.businessInfo });
    res.json({ ...result, suggestedFaqs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Extracts text from an uploaded PDF (product brochure, spec sheet, terms,
// etc.) to pre-fill a client's businessInfo. Like /crawl, this only returns
// extracted text for the admin to review/edit -- it never saves by itself.
router.post("/extract-pdf", (req, res) => {
  uploadPdf.single("pdf")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded (field name must be 'pdf')" });
    }
    try {
      const businessInfo = await extractPdfText(req.file.buffer);
      res.json({ businessInfo, filename: req.file.originalname });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

router.delete("/clients/:id", async (req, res) => {
  const deleted = await deleteClient(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Unknown client id" });
  // Take their logins with them. A user record left pointing at a deleted
  // workspace can still authenticate, landing in a dashboard whose
  // workspace no longer exists.
  const orphans = await listUsers(req.params.id);
  await Promise.all(orphans.map((u) => deleteUser(u.id)));
  res.json({ deleted: true, usersRemoved: orphans.length });
});

// ---- workspace logins ----
//
// Onboarding a business means two steps: create the client config (above),
// then create its first "owner" account here. From that point the business
// signs in at /app.html and manages itself -- team, knowledge base and live
// chat -- without ever touching ADMIN_KEY.

router.get("/clients/:id/users", async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  const users = await listUsers(req.params.id);
  res.json({ users: users.map(publicUser) });
});

router.post("/clients/:id/users", async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  const { email, password, name, role } = req.body || {};
  try {
    const user = await createUser({
      clientId: req.params.id,
      email,
      password,
      name,
      role: role === "agent" ? "agent" : "owner",
    });
    res.json(publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/users/:userId", async (req, res) => {
  const user = await getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: "Unknown user" });
  await deleteUser(user.id);
  res.json({ deleted: true });
});

// ---- live agent handoff ----
//
// Kept as a platform-owner escape hatch for support and debugging. The
// real agent-facing versions of these live in routes/workspace.js behind a
// workspace login; these ones can reach any client, so they're for us, not
// for customers.

// Active conversations for a client, most recently active first.
router.get("/sessions", async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: "clientId query param is required" });
  res.json({ sessions: await listSessions(clientId) });
});

// Full transcript, for an agent reading up before replying.
router.get("/sessions/:sessionId", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json(session);
});

// Take the conversation over from the bot. From here on the AI stops
// answering this session and the visitor's widget shows this agent's name
// and photo instead of the bot's.
router.post("/sessions/:sessionId/takeover", async (req, res) => {
  const { name, avatarUrl, greeting } = req.body || {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Agent name is required" });
  }
  const session = await getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  if (session.locked) return res.status(409).json({ error: "This conversation has ended." });
  if (session.tempLocked) {
    return res
      .status(409)
      .json({ error: "This conversation is temporarily paused, waiting for the visitor to reopen it." });
  }

  const agent = { name: name.trim().slice(0, 60), avatarUrl: avatarUrl || "" };
  await assignAgent(session, agent);

  if (typeof greeting === "string" && greeting.trim()) {
    await appendMessage(session, {
      role: "assistant",
      content: greeting.trim(),
      sender: agent,
    });
  }
  res.json({ agent: session.agent, seq: session.seq });
});

// Agent sends a message to the visitor.
router.post("/sessions/:sessionId/reply", async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  const session = await getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  if (session.locked) return res.status(409).json({ error: "This conversation has ended." });
  if (!session.agent) {
    return res.status(409).json({ error: "Take the session over before replying" });
  }
  const saved = await appendMessage(session, {
    role: "assistant",
    content: message.trim(),
    sender: session.agent,
  });
  res.json({ message: saved });
});

// Hand back to the bot. The bot sees everything the agent said as context.
router.post("/sessions/:sessionId/release", async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  // Nothing to release -- the pause already cleared the agent, and
  // releaseAgent would also clear agentRequested, silently pulling the
  // conversation out of the waiting queue before the visitor reopens it.
  if (session.tempLocked) {
    return res
      .status(409)
      .json({ error: "This conversation is temporarily paused, waiting for the visitor to reopen it." });
  }
  await releaseAgent(session);
  res.json({ agent: null, seq: session.seq });
});

module.exports = router;

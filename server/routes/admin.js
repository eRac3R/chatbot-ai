const express = require("express");
const { getClient, listClients, upsertClient, deleteClient } = require("../lib/clients");
const { crawlWebsite } = require("../lib/crawler");

const router = express.Router();

function requireAdminKey(req, res, next) {
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

router.use(requireAdminKey);

router.get("/clients", (req, res) => {
  res.json({ clients: listClients() });
});

router.get("/clients/:id", (req, res) => {
  const client = getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  res.json(client);
});

router.post("/clients", (req, res) => {
  try {
    const saved = upsertClient(req.body || {});
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
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/clients/:id", (req, res) => {
  const deleted = deleteClient(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Unknown client id" });
  res.json({ deleted: true });
});

module.exports = router;

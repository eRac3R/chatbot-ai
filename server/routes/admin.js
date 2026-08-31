const express = require("express");
const multer = require("multer");
const { getClient, listClients, upsertClient, deleteClient } = require("../lib/clients");
const { crawlWebsite } = require("../lib/crawler");
const { extractPdfText } = require("../lib/pdfExtractor");

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

router.get("/clients", async (req, res) => {
  res.json({ clients: await listClients() });
});

router.get("/clients/:id", async (req, res) => {
  const client = await getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Unknown client id" });
  res.json(client);
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
    res.json(result);
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
  res.json({ deleted: true });
});

module.exports = router;

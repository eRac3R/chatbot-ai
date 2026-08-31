require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const chatRoutes = require("./routes/chat");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
const corsOptions = {
  origin: allowedOrigins.includes("*") ? true : allowedOrigins,
};

app.use(express.json({ limit: "100kb" }));

// Public, cross-origin API the embedded widget calls from any website.
app.use("/api", cors(corsOptions), chatRoutes);

// Admin API, protected by ADMIN_KEY (see routes/admin.js).
app.use("/api/admin", cors(corsOptions), adminRoutes);

// The embeddable widget script itself, and a small onboarding/demo UI.
app.use(express.static(path.join(__dirname, "..", "widget")));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

// Vercel (see api/index.js) imports `app` and handles incoming requests
// itself -- it must NOT also bind a port. Only listen when this file is run
// directly, e.g. `node server/index.js` / `npm start`.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`chatbot-ai server listening on http://localhost:${PORT}`);
    console.log(`  Widget script:  http://localhost:${PORT}/widget.js`);
    console.log(`  Admin panel:    http://localhost:${PORT}/admin.html`);
    console.log(`  Demo page:      http://localhost:${PORT}/demo.html`);
  });
}

module.exports = app;

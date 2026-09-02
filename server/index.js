require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const chatRoutes = require("./routes/chat");
const adminRoutes = require("./routes/admin");
const authRoutes = require("./routes/auth");
const workspaceRoutes = require("./routes/workspace");

const app = express();
const PORT = process.env.PORT || 3000;

// Vercel (and any host behind a reverse proxy) terminates the real
// connection itself and forwards to us with the visitor's real address in
// X-Forwarded-For -- without this, req.ip on every request is just
// Vercel's proxy, which breaks the login rate limiter (routes/auth.js,
// keyed by req.ip) and the same-IP visitor grouping (routes/chat.js).
// Locally there's no proxy, so req.ip already resolves correctly either way.
app.set("trust proxy", true);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
const corsOptions = {
  origin: allowedOrigins.includes("*") ? true : allowedOrigins,
};

app.use(express.json({ limit: "100kb" }));

// Public, cross-origin API the embedded widget calls from any website.
app.use("/api", cors(corsOptions), chatRoutes);

// Platform-owner API, protected by the shared ADMIN_KEY (see routes/admin.js).
app.use("/api/admin", cors(corsOptions), adminRoutes);

// The agent CRM: workspace logins and everything behind them. Deliberately
// mounted WITHOUT the permissive CORS above -- these routes authenticate
// with a cookie, so allowing arbitrary origins to call them with
// credentials is exactly the cross-site request problem SameSite is there
// to prevent. The dashboard is served from this same origin, so it doesn't
// need CORS at all.
app.use("/api/auth", authRoutes);
app.use("/api/workspace", workspaceRoutes);

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
    console.log(`  Agent CRM:      http://localhost:${PORT}/app.html  (Admin button on the login screen)`);
    console.log(`  Demo page:      http://localhost:${PORT}/demo.html`);
  });
}

module.exports = app;

# chatbot-ai

A plug-and-play AI chat widget (like Tawk.to) that answers visitors' questions
about a business's product, powered by Google Gemini (free tier). One `<script>` tag embeds it on
any website; each business gets its own knowledge base (product info + FAQs).

## How it fits together

- `server/` — Express backend. Multi-tenant: every business ("client") has a
  config file with their product info, FAQs, tone, and branding. Exposes:
  - `POST /api/chat` — the widget calls this to get a reply.
  - `GET /api/clients/:id/public` — public, non-sensitive widget config (bot
    name, welcome message, brand color).
  - `POST/GET/DELETE /api/admin/clients` — create/update/list/delete a
    client's knowledge base. Protected by the `ADMIN_KEY` header.
  - `POST /api/admin/crawl` — fetches a business's website (start page + a
    few same-domain About/FAQ/Pricing-ish pages) and extracts clean text to
    pre-fill `businessInfo`. Also protected by `ADMIN_KEY`.
  - `POST /api/admin/extract-pdf` — extracts text from an uploaded PDF
    (product brochure, spec sheet, price list, etc.) to pre-fill
    `businessInfo`. Also protected by `ADMIN_KEY`.
  - `GET /api/sessions/:sessionId/messages?clientId=…&since=…` — what the
    widget polls while it's open, to pick up agent messages and to restore
    the transcript after a page reload. The unguessable `sessionId` is the
    credential here; `clientId` is checked as defence in depth.
  - Live-agent endpoints (see below), all under `/api/admin/sessions`.

- `widget/widget.js` — the embeddable script. Vanilla JS, no dependencies, no
  build step. Reads `data-client-id` off its own `<script>` tag and infers the
  API base URL from where it was loaded — so the exact same file works for
  every customer with zero configuration.
- `public/admin.html` — a simple form to create/update a client's knowledge
  base and get the embed snippet to hand to the business. Besides the
  knowledge base it also sets the widget's presentation:
  - **Bot profile picture** (`avatarUrl`) — shown in the chat header and beside
    every bot message. Falls back to the bot's initials when blank or if the
    image fails to load. Only `http(s)` URLs are accepted (`clients.js`
    strips anything else, since the widget renders it into an `<img src>`).
  - **Personality** (`tone`) — free-form, as long as you like: voice, quirks,
    phrases to use or avoid, how to handle a frustrated visitor. It shapes
    *how* the bot speaks; the factual "only use the business info" rules
    still win, so a persona can't talk the bot into inventing facts.
  - **Quick reply buttons** (`quickReplies`) — up to 4 suggested questions
    rendered as tappable chips under the welcome message, so visitors can
    start without typing. They disappear once the visitor sends anything.
- `public/demo.html` — a stand-in customer website with the widget embedded,
  for end-to-end testing.
- `server/data/clients/*.json` — one JSON file per business (their knowledge
  base), used in local dev. A `demo.json` is included so you can try it
  immediately. When `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set (required on
  Vercel — see Deploying below), `server/lib/clients.js` and
  `server/lib/sessions.js` transparently switch to Redis instead, since
  serverless hosts don't offer a persistent disk or long-lived memory.

Knowledge base entry has three paths, all landing in the same `businessInfo`
field on `admin.html` for review before saving — none of them save
automatically:
- **Manual** — paste product info and add FAQs directly.
- **Import from website** — enter the business's URL and click "Fetch
  content"; `server/lib/crawler.js` fetches the page plus a few same-domain
  links that look like About/FAQ/Pricing/Support pages, strips it to clean
  text. Capped (5 pages, ~12k characters total, 8s timeout per page, 2MB per
  page) and refuses to fetch private/internal IP addresses. Doesn't render
  JS-heavy sites (no headless browser) — for those, use manual entry instead.
- **Import from PDF** — upload a product brochure, spec sheet, or price list
  and click "Extract text"; `server/lib/pdfExtractor.js` pulls the text out
  (15MB max, ~12k characters kept). Scanned/image-only PDFs (no real text
  layer) won't extract anything — you'd need to retype that content or paste
  it manually.

### Chat history and cross-device continuity

By default a visitor's conversation is stored server-side against a random id
kept in their browser's `localStorage`, so it survives reloads and closing
the widget, and is restored when they come back. Retention is **30 days of
inactivity** by default (`SESSION_TTL_DAYS`), sliding — every new message
pushes the expiry out again.

That's per-browser by nature. To let one person's history follow them from
laptop to phone, the embedding site tells the widget who its logged-in user
is:

```html
<script src="https://YOUR-DOMAIN/widget.js"
        data-client-id="acme-co"
        data-user-id="alice@example.com"
        data-user-hash="<hmac>"></script>
```

`data-user-id` alone can't be trusted — it sits in the page and anyone could
edit it in devtools to open someone else's transcript. So the site also
sends an HMAC of that id, computed **on its own server** with the client's
`identitySecret` (visible on `GET /api/admin/clients/:id`, never exposed to
the widget):

```js
// on the business's own backend, when rendering the page
const userHash = require("crypto")
  .createHmac("sha256", IDENTITY_SECRET)   // from GET /api/admin/clients/:id
  .update(loggedInUser.email)              // must match data-user-id exactly
  .digest("hex");
```

Behaviour, all verified end to end:
- **Valid hash** → the visitor gets a stable session derived from that user,
  identical on every device, with full history and conversational context.
- **Missing or wrong hash** → falls back to the anonymous per-device session
  and logs a console warning. A misconfigured site loses history continuity;
  it doesn't break the chat and it never exposes the real user's transcript.
- **Logged out** → back to the anonymous session for that browser. The
  logged-in history is untouched server-side and returns on next login; the
  logged-out thread never shows it.

The user session id is itself an HMAC of `identitySecret`, not a plain hash
of `clientId + userId`. That matters: session ids are treated as bearer
credentials elsewhere in the API, so a guessable one would let anyone who
knows a victim's email read their chat without ever passing verification.

Not implemented: merging an anonymous conversation into the user's history
when they log in mid-chat. Today that starts a fresh logged-in thread.

### Live agent handoff

The backend for human takeover is built; the agent-facing UI is not. A human
can already take a conversation over end to end through the API:

| Endpoint | What it does |
| --- | --- |
| `GET /api/admin/sessions?clientId=…` | Active conversations, most recent first |
| `GET /api/admin/sessions/:id` | Full transcript for one conversation |
| `POST /api/admin/sessions/:id/takeover` | `{name, avatarUrl?, greeting?}` — the AI stops answering this session |
| `POST /api/admin/sessions/:id/reply` | `{message}` — agent replies by hand |
| `POST /api/admin/sessions/:id/release` | Hands control back to the bot |

Once an agent takes over, `POST /api/chat` stops calling Gemini for that
session and returns `{pending: true, agent}`; the visitor's widget swaps the
header and message avatars to the agent's name/photo and waits for their
reply via polling. Bot messages keep the bot's avatar, so the history stays
readable as a mixed conversation.

When control is released, the bot picks up with the agent's messages in its
context. Those are labelled `(human agent NAME):` in the history
(`sessions.js`) and `gemini.js` has a matching rule telling the model to
treat them as authoritative — without it the model reads them as its own
output and its "never state anything outside the business info" rule makes
it *deny* things a colleague just promised (it told a visitor "I don't offer
discounts" moments after an agent granted 15% off). It will now honor and
reference the agent's promise while still refusing to invent a bigger one
itself.

Two things to know before putting agents in front of customers:
- These endpoints share `ADMIN_KEY`. A real agent UI should get its own
  per-agent auth — support staff shouldn't be able to edit knowledge bases
  or read other clients' data.
- Delivery is 4-second polling while the widget is open, not websockets.
  Fine at small scale and it works on Vercel (which doesn't hold persistent
  connections); revisit if you need instant delivery or have many concurrent
  chats.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `GEMINI_API_KEY` — get a free one at https://aistudio.google.com/apikey
  (no credit card required)
- `ADMIN_KEY` — set this to a long random string (used to protect the admin
  panel/API)

```bash
npm start
```

Then open:
- http://localhost:3000/demo.html — try the widget as an end user
- http://localhost:3000/admin.html — onboard a new business (paste their
  product info, get their embed snippet)

## Embedding on a real website

Give the business this one line (with their own client ID) to paste anywhere
in their HTML, ideally just before `</body>`:

```html
<script src="https://YOUR-SERVER-DOMAIN/widget.js" data-client-id="their-client-id"></script>
```

That's the entire integration — no npm install, no build step, no iframe
config on their end.

## Deploying

Deploy `server/` (which also serves `widget/` and `public/`) to any Node
host (Render, Railway, Fly.io, a VPS, etc.) with the same `.env` variables
set. Once deployed, replace `localhost:3000` above with your real domain in
the embed snippet — the widget script auto-detects its own origin, so no
other code changes are needed.

**Docker:**

```bash
docker build -t chatbot-ai .
docker run -p 3000:3000 --env-file .env -v chatbot-ai-data:/app/server/data/clients chatbot-ai
```

The `-v` volume mount is important — client knowledge bases live in
`server/data/clients/*.json`; without a mounted volume they're wiped every
time the container is rebuilt. (Or set `UPSTASH_REDIS_REST_URL`/`_TOKEN` as
below and skip the volume entirely.)

**Vercel:**

Vercel runs your code in short-lived serverless functions — there's no
persistent disk and no long-lived process memory, so the plain-file/
in-memory storage used for local dev won't work there (saved clients would
vanish, chat "memory" wouldn't persist between messages). This repo already
has the Vercel-compatible pieces:
- `api/index.js` + `vercel.json` — routes every request through the same
  Express app used locally, so nothing else about the app changes.
- `server/lib/store.js` — the Redis switch: `clients.js` and `sessions.js`
  automatically use Redis instead of files/memory once it's configured.

Steps:
1. Create a free Redis database at https://console.upstash.com (no card
   required) and copy its **REST URL** and **REST TOKEN**.
2. `vercel` CLI (`npm i -g vercel`, then `vercel`) or connect the repo at
   vercel.com — either way, add these environment variables in the Vercel
   project settings: `GEMINI_API_KEY`, `ADMIN_KEY`, `UPSTASH_REDIS_REST_URL`,
   `UPSTASH_REDIS_REST_TOKEN` (same values as your local `.env`).
3. Deploy. Your admin panel and widget are now at
   `https://your-project.vercel.app/admin.html` and
   `https://your-project.vercel.app/widget.js` — swap that domain into every
   client's embed snippet in place of `localhost:3000`.

Notes for production (Vercel or otherwise):
- The per-session rate limiter in `server/routes/chat.js` is still plain
  in-memory (not Redis-backed) — on Vercel this resets on cold starts and
  isn't shared across concurrent instances. Not a data-loss risk like the
  client/history storage was, just a weaker rate limit; move it to Redis too
  if that matters for your traffic.
- Client knowledge bases are single JSON blobs per client (file or Redis
  key); swap for a real relational database if you expect very high client
  counts or need concurrent-safe partial updates.
- `ALLOWED_ORIGINS=*` in `.env` allows any website to call `/api/chat`, which
  is normal for a public embeddable widget (this is how Tawk.to/Intercom
  work too) — the client's `data-client-id` scopes what knowledge is used,
  not CORS.

# chatbot-ai

A plug-and-play AI chat widget (like Tawk.to) that answers visitors' questions
about a business's product, powered by Google Gemini (free tier). One `<script>` tag embeds it on
any website; each business gets its own knowledge base (product info + FAQs).

## How it fits together

- `server/` — Express backend. Multi-tenant: every business ("client") has a
  config file with their product info, FAQs, tone, and branding. Exposes:
  - `GET /api/clients/:id/public` — public, non-sensitive widget config (bot
    name, welcome message, brand color, FAQs, quick replies).
  - `POST/GET/DELETE /api/admin/clients` — create/update/list/delete a
    client's knowledge base. Protected by the `ADMIN_KEY` header.
  - `POST /api/admin/crawl` — fetches a business's website (start page + a
    few same-domain About/FAQ/Pricing-ish pages) and extracts clean text to
    pre-fill `businessInfo`. Also protected by `ADMIN_KEY`.
  - `POST /api/admin/extract-pdf` — extracts text from an uploaded PDF
    (product brochure, spec sheet, price list, etc.) to pre-fill
    `businessInfo`. Also protected by `ADMIN_KEY`.
  - `POST /api/visitor/resolve` — which visitor this browser is (not which
    conversation — see Widget navigation below). Verified identity if
    `userId`/`userHash` check out, otherwise the anonymous per-device id.
  - `POST /api/conversations` — starts a new conversation for a visitor.
  - `GET /api/visitors/:visitorId/conversations?clientId=…` — that
    visitor's conversations, most recent first (the widget's Messages tab).
  - `POST /api/chat` — send a message in an existing conversation (404s if
    the conversation doesn't exist — see Widget navigation).
  - `GET /api/sessions/:sessionId/messages?clientId=…&since=…` — what the
    widget polls while a conversation is open, to pick up agent messages and
    to restore the transcript after a page reload. The unguessable
    `sessionId` is the credential here; `clientId` is checked as defence in
    depth.
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
  - **Quick reply buttons** (`quickReplies`) — up to 4 suggested questions,
    always exactly 4 (blank slots fall back to defaults, see
    `sanitizeQuickReplies`). Rendered *inside* a freshly-started conversation,
    under the welcome message (see Widget navigation below) — tapping one
    sends it immediately.
  - **FAQs** now do triple duty: they go into the AI's prompt, the widget
    shows the top 3 as an inline preview on Home, and the full list as a
    browsable Help tab (see below).
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

### Widget navigation

A bottom tab bar with three peer tabs, plus a conversation view reached by
drilling into either of them:

- **Home** — quick answers without needing to chat: the bot's greeting plus
  its top 3 FAQs (`HOME_FAQ_COUNT` in `widget.js`) as an inline
  expand/collapse accordion — tapping one shows the answer right there, no
  conversation started, no navigation. Ends in a "Message us directly →"
  fallback link for anything not covered. The "Top questions" header (and
  the whole section) is omitted for a client with no FAQs configured, but
  the fallback link always stays so Home is never a dead end.
- **Messages** — where a visitor actually starts or continues talking. A
  "Send us a message" tile sits above a "Past conversations" list: every
  conversation this visitor has had, most recent first, with a preview of
  the last message and a red unread-count badge (on both the tab icon and
  the individual row) for anything with activity the visitor hasn't seen
  yet. Tapping a past conversation reopens its full transcript.
- **Help** — the client's *full* FAQ list, same accordion as Home's preview,
  ending in the same "Still need help? Ask our assistant →" fallback.
  Whatever doesn't fit in Home's top-3 lives here.
- **An open conversation** is a fourth, "pushed" view — the tab bar hides
  and a back arrow takes its place in the header, returning to whichever
  tab it was opened from (tracked separately per conversation, so opening
  one from Home vs. Messages returns to the right place). Starting a fresh
  conversation shows the welcome message followed by the client's
  quick-reply chips (`config.quickReplies`), inline in the chat, exactly
  where the old pre-tab-bar widget showed them — tapping one sends it
  immediately as the first message.

**Reply suggestions ("smart replies").** After each AI reply (not during a
live-agent handoff), the server may also return up to 2 short, contextual
follow-up suggestions the visitor can tap instead of typing — e.g. after
"we ship within the US", a suggestion might be "Do you ship to Canada?".
These render the same way as the quick-reply chips, right under the bot's
message, and tapping one sends it and clears the set. Implementation notes:
- `getSuggestedReplies` (`server/lib/gemini.js`) is a second, separate
  Gemini call, deliberately isolated from `getChatReply` — if it fails or
  returns unparseable output, suggestions are silently empty rather than
  ever affecting the real reply. It runs concurrently with the reply call
  (`Promise.all` in `routes/chat.js`), so it costs no extra latency.
- Capped to a conversation's **first 3 user messages**
  (`MAX_SUGGESTION_TURNS`) — past that, the extra call is skipped
  entirely (not just hidden client-side) to avoid unnecessary cost in a
  longer, more specific conversation.
- The model is instructed to phrase suggestions as something the *visitor*
  would type (a question, or a short reply like "sounds good"), grounded
  only in the business info, and to return an empty array rather than
  force a suggestion that doesn't fit — verified it doesn't always produce
  2 (or any) on every turn, which is expected, not a bug.

A visitor can have **many conversations**, not just one — this is the real
architectural change from earlier versions, where a visitor had exactly one
ongoing session. Conversations are grouped under a stable `visitorId` (see
Chat history below): `POST /api/conversations` mints a new one,
`GET /api/visitors/:visitorId/conversations` lists them all. `POST
/api/chat` now requires an existing conversation (404s otherwise) rather
than silently creating one, since a conversation has to be registered under
a visitor to show up in their Messages tab.

**Unread tracking is client-side only** (localStorage, per browser) — the
server doesn't record what a visitor has "read". A verified cross-device
visitor's badge count is therefore per-device: reading a message on their
laptop doesn't clear the badge on their phone. Fixing that would mean
syncing read-state through the server too; not done, flagged here rather
than silently left as a surprise.

### Chat history and cross-device continuity

By default a visitor is identified by a random id kept in their browser's
`localStorage` (see Widget navigation above for how one visitor can have
several conversations under that id). Each individual conversation survives
reloads and closing the widget, and is restored when they come back.
Retention is **1 day of inactivity** per conversation by default
(`SESSION_TTL_DAYS`), sliding — every new message pushes that conversation's
expiry out again.

That visitor id is per-browser by nature. To let one person's conversations
follow them from laptop to phone, the embedding site tells the widget who
its logged-in user is:

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
- **Valid hash** → the visitor gets a stable id derived from that user,
  identical on every device, with the same conversations and Messages tab.
- **Missing or wrong hash** → falls back to the anonymous per-device visitor
  id and logs a console warning. A misconfigured site loses history
  continuity; it doesn't break the chat and it never exposes the real
  user's conversations.
- **Logged out** → back to the anonymous visitor id for that browser. The
  logged-in visitor's conversations are untouched server-side and return on
  next login; the logged-out visitor never sees them.

The verified visitor id is itself an HMAC of `identitySecret`, not a plain
hash of `clientId + userId`. That matters: it's treated as a bearer
credential elsewhere in the API (it's what `/api/conversations` and
`/api/visitors/:id/conversations` trust to scope a visitor to their own
conversations), so a guessable one would let anyone who knows a victim's
email enumerate their conversations without ever passing verification.

Not implemented: merging an anonymous visitor's conversations into their
account when they log in mid-session. Today those stay two separate
visitor buckets.

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

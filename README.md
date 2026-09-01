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
  - `POST /api/auth/login` / `logout` / `me` — agent CRM logins.
  - `/api/workspace/*` — everything behind a workspace login (inbox,
    claim, reply, team, settings). Scoped to the caller's own client.
  - Live-agent escape hatches under `/api/admin/sessions` (see below).

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
- `public/app.html` — the Agent Desk: the customer-facing CRM where a
  business signs in to answer live chats and manage its own bot. See below.
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

- **Home** — quick answers without needing to chat: bot greeting, a
  "Message us directly" tile, then a single "Top questions" section — a
  search box immediately followed by its top 3 FAQs (`HOME_FAQ_COUNT` in
  `widget.js`) as an inline expand/collapse accordion. Typing in the search
  box swaps that same spot for one bordered dropdown box listing every
  matching FAQ (not just the top 3), each row expandable in place; the box
  scrolls internally (capped height) once results run past the visible
  area, staying clear of the tab bar below. Clearing the box reverts to the
  top-3 view. The whole section is omitted for a client with no FAQs
  configured, but the "Message us directly" tile always stays so Home is
  never a dead end.
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

**Branding.** A small "⚡ Powered by Branofy" pill sits to the left of the
launcher bubble itself (a sibling in `#cw-root`, not inside the chat
window). It fades in only while the chat is open — CSS keys off the
`.cw-is-open` class on `#cw-root`, so a closed widget is just the bare
bubble. Because `#cw-root` is anchored to the right, the pill appearing on
its left never nudges the bubble. Hidden entirely on narrow screens
(`@media (max-width:480px)`) to avoid crowding the corner.

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

Two ways a conversation ends up in front of a human. The agent-facing side
is the Agent Desk (see below).

**Visitor-requested.** A "🙋 Talk to a live agent" button is shown in the
chat while the AI is still handling things. Tapping it calls
`POST /api/sessions/:id/request-agent` (`{clientId}`, no admin key --
this is visitor-facing), which:
- Flags the conversation `agentRequested: true`.
- Posts a canned message: *"Connecting you with a member of our team —
  feel free to keep typing any questions here, they'll see the whole
  conversation as soon as they join."*
- **Stops the AI immediately** — `POST /api/chat` treats `agentRequested`
  the same as an agent already being attached (`agent || agentRequested`)
  and returns `{pending: true}` without calling Gemini, even before any
  specific agent has actually joined. The visitor can keep typing; it's
  just queued for whoever picks it up.
- The widget reflects this with a header status of "Connecting to an
  agent…", and hides the request button (`updateChatStatusUI` in
  `widget.js`) so it can't be tapped twice.

**Operator-initiated.** An agent picks a conversation up from the Agent
Desk, which calls the workspace API (`/api/workspace/sessions/:id/claim`).
The same actions also exist under `/api/admin/sessions/:id/*`
(`takeover` / `reply` / `release`) as a platform-owner escape hatch for
support — those reach any client, so they're for us, not for customers.

Once an agent actually joins (`assignAgent`), `POST /api/chat` stops calling
Gemini for that session and returns `{pending: true, agent}`; the visitor's
widget swaps the header and message avatars to the agent's name/photo and
waits for their reply via polling. Bot messages keep the bot's avatar, so
the history stays readable as a mixed conversation.

When control is released, the bot picks up with the agent's messages in its
context. Those are labelled `(human agent NAME):` in the history
(`sessions.js`) and `gemini.js` has a matching rule telling the model to
treat them as authoritative — without it the model reads them as its own
output and its "never state anything outside the business info" rule makes
it *deny* things a colleague just promised (it told a visitor "I don't offer
discounts" moments after an agent granted 15% off). It will now honor and
reference the agent's promise while still refusing to invent a bigger one
itself.

**Idle timeout.** Once an agent has joined, if the visitor goes quiet for
`AGENT_IDLE_TIMEOUT_MINUTES` (default 10), the conversation auto-ends: a
"This conversation has ended due to inactivity" message is posted, the
agent is released, and the conversation is permanently `locked` — the
widget disables its composer, and `POST /api/chat` / the admin `/reply`
endpoint both 409 on it from then on. There's no timer process (doesn't
exist in a serverless world); the check runs lazily inside `getSession`
(`maybeAutoCloseIdleSession`), i.e. the *next* time anything touches the
conversation — a poll, a send attempt, an agent reading it — not necessarily
exactly 10 minutes to the second. The timeout only applies once an agent
has actually joined; a visitor who requested one and is still waiting can
wait indefinitely.

The clock runs from whichever is later, the visitor's last message or the
moment the agent joined (`agentAssignedAt`). Using the message alone meant
that picking up any request which had queued longer than the timeout closed
it instantly — the normal case, since agents aren't sitting on the screen
waiting.

Two things to know before putting agents in front of customers:
- Delivery is 4-second polling while the widget is open, not websockets.
  Fine at small scale and it works on Vercel (which doesn't hold persistent
  connections); revisit if you need instant delivery or have many concurrent
  chats.
- The idle timeout is per-conversation wall-clock time based on the
  visitor's last message, not tied to the widget being open — closing the
  browser doesn't pause the clock.

### The Agent Desk (`/app.html`)

A business's own login, so customers never touch `ADMIN_KEY`. This is the
distinction that makes the product multi-tenant rather than "one shared
password": **`/api/admin` is the platform owner (us) and can reach every
client; `/api/workspace` is a customer and can only ever reach their own.**
No workspace route reads a `clientId` from the request — it always comes off
the authenticated user, so editing a URL can't cross the boundary.

**Two roles.** `owner` is the business: answers chats *and* edits the
knowledge base, branding and team. `agent` is their staff: chats only. The
dashboard hides Team/Settings from agents, but the server enforces it
(`requireOwner`) — the hiding is convenience, not the boundary.

**Accounts** live in `server/lib/users.js` (one `clientId` per user, so the
user record *is* the tenancy key). Passwords are scrypt-hashed with a random
salt per user; no new dependency, it's in Node's stdlib. Sessions are
stateless signed tokens in an HttpOnly, SameSite=Lax cookie
(`server/lib/auth.js`) — stateless because on serverless there's no
long-lived process to hold a session table, and SameSite is what protects
the whole workspace API from CSRF. The trade-off: a token can't be revoked
before it expires (7 days), so changing a password doesn't sign out other
devices.

**Onboarding a business** is two platform-owner calls — create the client,
then mint its first owner login:

```bash
curl -X POST http://localhost:3000/api/admin/clients   -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json"   -d '{"id":"joes-pizza","botName":"Joe","businessInfo":"..."}'

curl -X POST http://localhost:3000/api/admin/clients/joes-pizza/users   -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json"   -d '{"email":"joe@joespizza.com","password":"at-least-8-chars","name":"Joe","role":"owner"}'
```

From there the owner signs in at `/app.html` and invites their own staff.

**The inbox.** Polls `GET /api/workspace/inbox` every 4 seconds (again: no
sockets on serverless) and splits conversations into Waiting / Mine / All.
A conversation is *waiting* when the visitor asked for a human and nobody
has picked it up (`agentRequested && !agent && !locked`).

**Notifications.** Every signed-in agent sees the same queue, so a new
request alerts all of them at once: a red badge, a count in the tab title, a
synthesised chime (no audio file to ship) and a desktop notification if the
browser has granted permission. The dashboard tracks which request ids it
has already seen, so the alert fires once per visitor rather than every
poll, and the backlog already present at login never triggers one.

**Claiming.** Any agent can take any waiting chat. The claim attaches *that
user's* name and photo to the conversation, which is what the visitor's
widget then shows in place of the bot — so an agent's profile is
customer-facing. A second agent claiming the same chat gets a 409 naming who
holds it, and replies from anyone but the holder are rejected, so two agents
can't interleave messages under one name. It's a read-then-write, so a
genuinely simultaneous claim could still double-assign; closing that needs a
compare-and-set in Redis.

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

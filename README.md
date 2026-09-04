# chatbot-ai

A plug-and-play AI chat widget (like Tawk.to) that answers visitors' questions
about a business's product, powered by Sarvam AI. One `<script>` tag embeds it on
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
- `public/app.html` — the Agent Desk. Two things live in this one file: the
  customer-facing CRM where a business signs in to answer live chats and
  manage its own bot (see The Agent Desk below), and — behind the "Admin"
  button on its login screen — the platform-owner console, gated by
  `ADMIN_KEY`. There is no separate admin page; that used to be
  `public/admin.html`, deleted once its "Platform Admin" view was fully
  ported into this file, so there'd be exactly one dashboard rather than two
  places doing the same thing.

  The platform-admin side opens on **Your workspaces**: every business on
  this server (`GET /api/admin/workspaces`, brand/FAQ-count/team-size in one
  round trip), each expandable in place to see its team, add or remove a
  login, or delete the workspace outright — the UI for the "two
  platform-owner calls" described under Onboarding a business below, so you
  no longer need curl for it. Clicking a workspace's Edit button prefills
  the form below (locking the Client ID field, since re-typing it would
  silently create a second workspace instead of editing this one) rather
  than duplicating a separate edit view. The form itself creates/updates a
  client's knowledge base and gets the embed snippet to hand to the
  business. Besides the knowledge base it also sets the widget's
  presentation:
  - **Bot profile picture** (`avatarUrl`) — shown in the chat header and beside
    every bot message. Falls back to the bot's initials when blank or if the
    image fails to load. Only `http(s)` URLs are accepted (`clients.js`
    strips anything else, since the widget renders it into an `<img src>`).
  - **Website** (`website`) — the business's own site, shown as a clickable
    link (not rendered into the widget itself) both in the platform-admin
    workspaces list and in the business's own Settings tab. Same `http(s)`-
    only sanitization as the bot picture, via the same `sanitizeUrl` helper.
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

Knowledge base entry has three paths feeding one `businessInfo` field,
present identically in both the platform-admin panel (`/app.html`, "Admin"
button) and a business owner's own Settings tab — the latter hits
workspace-scoped mirror routes (`POST /api/workspace/client/crawl` and
`/client/extract-pdf` in `routes/workspace.js`, gated by a workspace login
rather than `ADMIN_KEY`) that call the exact same `lib/crawler.js` and
`lib/pdfExtractor.js` functions, so owners can pull in their own content
without asking us to do it:
- **Manual** — paste product info and add FAQs directly.
- **Import from website** — enter the business's URL and click "Fetch
  content"; `server/lib/crawler.js` fetches the page plus a few same-domain
  links that look like About/FAQ/Pricing/Support pages, strips it to clean
  text. Capped (5 pages, ~12k characters total, 8s timeout per page, 2MB per
  page) and refuses to fetch private/internal IP addresses. Doesn't render
  JS-heavy sites (no headless browser) — for those, use manual entry instead.
  Merges straight into the businessInfo box on fetch, no separate save step
  before it's visible there.
- **Import from PDF** — choosing a file (no separate "Extract" button)
  immediately calls `server/lib/pdfExtractor.js` (15MB max, ~12k characters
  kept; scanned/image-only PDFs with no real text layer won't extract
  anything, retype or paste that content manually). Unlike the website
  import, the result lands in its *own* box, not directly in businessInfo —
  the two only merge (manual text + a blank line + the PDF text) at the
  moment Save is clicked, computed client-side and folded back into the
  visible businessInfo box once the save succeeds. This means uploading the
  wrong PDF, or wanting to trim what it pulled out, never clobbers text
  that's already been typed — review/edit the extracted box freely before
  saving, or just clear it. Nothing about this path saves automatically;
  only the `<input type="file">`'s `change` event is automatic, the actual
  write to the workspace still needs the explicit Save click.

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
- `getSuggestedReplies` (`server/lib/sarvam.js`) is a second, separate
  Sarvam call, deliberately isolated from `getChatReply` — if it fails or
  returns unparseable output, suggestions are silently empty rather than
  ever affecting the real reply. It runs concurrently with the reply call
  (`Promise.all` in `routes/chat.js`), so it costs no extra latency.
- Every Sarvam call retries once on a transient failure (rate limit, a
  momentary 5xx, a network blip) before giving up — seen in practice
  running live: an otherwise-healthy conversation occasionally has one
  message fail outright while everything around it works fine, consistent
  with a passing hiccup rather than a real config problem. A genuine 4xx
  (bad key, malformed request) is never retried, since retrying reproduces
  the same failure. One retry, ~400ms delay — enough to ride out a blip
  without meaningfully slowing down the one message that hits it.
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

### Polling and message dedup

While a conversation is open, the widget polls `GET /sessions/:id/messages`
every `POLL_INTERVAL_MS` (4s) and shows anything with `seq > lastSeq`,
bumping `lastSeq` as it goes — the same mechanism that picks up an agent's
reply. `pollOnce` skips *starting* a new poll while a send is in flight
(`sendInFlight`), so the visitor's own message doesn't get raced by a poll
that begins after it.

That guard alone isn't enough, though: a poll already in flight *before* the
send began isn't stopped by it, since that only gates starting a new one.
That poll's `since` value is captured in its URL before it's sent, so if the
AI is slow enough (or erroring) that the poll's response doesn't land until
*after* the visitor's message is already stored server-side, the response
comes back looking like it contains a genuinely new message — and renders a
second copy of something `submitText` already showed optimistically. Seen in
practice: a visitor reported their own messages appearing twice, worse the
slower or more error-prone the AI backend was — exactly the conditions that
widen this window. `fetchOpenConversationMessages`'s response handler now
also checks `sendInFlight` and bails out if a send is currently in progress,
trusting `submitText`'s own completion handler (and the next poll tick) to
reconcile state instead. Reproduced deterministically in testing by holding
a poll's response open with Playwright's request interception until after a
send had been stored, confirming both that the old code duplicated the
message and that this fix doesn't.

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

**Visitor-requested.** There is no "talk to a human" button anymore — the
bot itself offers and recognizes it, the way an actual staff member would,
rather than a visitor having to notice and tap a separate UI element.
- The model appends a fixed literal token, `AGENT_HANDOFF_MARKER`
  (`[[ROUTE_TO_AGENT]]`, `lib/sarvam.js`), to its own reply whenever a rule
  in `buildSystemPrompt` decides the visitor is asking for or accepting a
  human — either an explicit ask at any point ("can I talk to a person"),
  or agreeing after being offered. This can fire on turn one just as
  easily as turn ten; it isn't gated by anything below.
- **A third way it comes up, besides an explicit ask or the scheduled
  nudge below: whenever the bot doesn't know something.** The grounding
  rule used to end with "suggest the visitor contact the business
  directly" — which sent people away from a conversation that could
  already solve their problem, to some other channel entirely. It now
  offers a live agent instead ("I don't have that — want me to get someone
  who can help?"), in the same chat, which the handoff rule above then
  picks up if they say yes.
- **A repeating proactive nudge**, separately: once a visitor's sent
  `LIVE_AGENT_NUDGE_START_TURN` (4) messages without asking, `routes/chat.js`
  appends *"If you'd prefer talking to a live support agent, feel free to
  let me know!"* to that reply — plain string concatenation, not something
  the model decides. It repeats every `LIVE_AGENT_NUDGE_REPEAT_EVERY` (2)
  turns after that (4, 6, 8, …) for as long as the visitor keeps going
  without asking, worded exactly the same way each time, and never on the
  same turn as an actual handoff (that would be a strange thing to say in
  the same breath as "connecting you now").
- **The nudge is kept out of what the model sees in its own history.**
  `appendMessage` (`lib/sessions.js`) takes an optional `historyContent`
  distinct from the displayed `content`; `toLlmHistory` prefers it when
  present. Without this, the model imitates its own past output — once the
  nudge sentence had appeared in its history a couple of times, it started
  echoing/repeating that exact phrase unprompted on *later* turns too, even
  ones the deterministic logic never touched, compounding worse each time
  it fired (confirmed while testing: by turn 8 or so, replies came back
  with the sentence appended two or three times over). `chat.js` stores the
  model's clean reply as `historyContent` and the nudge-appended version
  (when due) as `content`, so the model's context never contains a copy of
  its own nudge text to imitate.
- `routes/chat.js` checks the AI's raw reply for the marker, strips it
  before the visitor ever sees the text (`rawReply.split(marker).join("")`),
  and if present calls `requestAgent(session)` — the exact same function
  the old button used to call directly, just triggered by the model's
  judgment instead of a click. Everything downstream is unchanged: flags
  `agentRequested: true`, posts the canned *"Connecting you with a member
  of our team…"* message, and `POST /api/chat` starts returning
  `{pending: true}` for that session from the next message on.
- One ordering detail worth knowing if you're touching this code: the
  handoff response returns `seq: botMessage.seq` (the AI's own stripped
  reply), not the later `session.seq` that includes the canned message
  `requestAgent` appends right after — the widget uses that value as its
  low-water mark for what it's already shown, and setting it too high
  would make the widget's next poll skip the canned message entirely.

**Operator-initiated.** An agent picks a conversation up from the Agent
Desk, which calls the workspace API (`/api/workspace/sessions/:id/claim`).
The same actions also exist under `/api/admin/sessions/:id/*`
(`takeover` / `reply` / `release`) as a platform-owner escape hatch for
support — those reach any client, so they're for us, not for customers.

Once an agent actually joins (`assignAgent`), `POST /api/chat` stops calling
Sarvam for that session and returns `{pending: true, agent}`; the visitor's
widget swaps the header and message avatars to the agent's name/photo and
waits for their reply via polling. Bot messages keep the bot's avatar, so
the history stays readable as a mixed conversation.

When control is released, the bot picks up with the agent's messages in its
context. Those are labelled `(human agent NAME):` in the history
(`sessions.js`) and `sarvam.js` has a matching rule telling the model to
treat them as authoritative — without it the model reads them as its own
output and its "never state anything outside the business info" rule makes
it *deny* things a colleague just promised (it told a visitor "I don't offer
discounts" moments after an agent granted 15% off). It will now honor and
reference the agent's promise while still refusing to invent a bigger one
itself.

**Two tiers of "closed".** A stale conversation doesn't just die outright —
it pauses first, reversibly, and only truly disappears much later:

- **Temporary pause (`AGENT_IDLE_TIMEOUT_MINUTES`, default 30).** Once an
  agent has joined, if the visitor goes quiet for this long, the
  conversation *pauses* (`tempLocked: true`, distinct from `locked` — see
  the shape comment atop `lib/sessions.js`): the agent is released, it drops
  out of the dashboard's waiting queue, and a "This conversation has been
  temporarily closed due to inactivity" message posts. Unlike the old
  behavior this isn't the end — `agentRequested` is deliberately left
  untouched, so the moment the visitor sends **any** new message
  (`reopenConversation`, called from `routes/chat.js`), it clears, posts a
  "Welcome back" note, and the conversation reads as *waiting* again. Any
  agent can then claim it — not necessarily whoever had it before — since
  claim/reply/release on a paused conversation all 409 with a clear "waiting
  for the visitor to reopen it" error until that happens. The widget's
  composer deliberately stays enabled through all of this (only permanent
  `locked` disables it) — typing is literally how a visitor reopens a
  paused chat, so status text and placeholder change ("Chat paused" / "Send
  a message to reopen this chat…") but nothing gets locked out.
- **Full close (`SESSION_TTL_DAYS`, default 1, see Setup below).** Whatever
  happens with the tier above, the whole conversation still expires from
  storage after a full day of *no activity at all* (sliding — every write,
  including the pause/reopen system messages, pushes it out again). That's
  this project's "fully closed, gone for good": no code path resurrects it,
  the visitor's Messages tab simply won't show it, and a returning visitor
  starts fresh. The two tiers are independent mechanisms (one an in-app
  flag, the other Redis/memory key expiry), not layered on top of each
  other.

Like before, there's no timer process (doesn't exist in a serverless
world); the pause check runs lazily inside `getSession`
(`maybeAutoPauseIdleSession`), i.e. the *next* time anything touches the
conversation — a poll, a send attempt, an agent reading it — not necessarily
exactly 30 minutes to the second. It only applies once an agent has
actually joined; a visitor who requested one and is still waiting in the
queue can wait indefinitely. The clock runs from whichever is later, the
visitor's last message or the moment the agent joined (`agentAssignedAt`) —
using the message alone would pause any request that had queued longer than
the timeout the instant someone finally picked it up.

Two things to know before putting agents in front of customers:
- Delivery is 4-second polling while the widget is open, not websockets.
  Fine at small scale and it works on Vercel (which doesn't hold persistent
  connections); revisit if you need instant delivery or have many concurrent
  chats.
- The pause timeout is per-conversation wall-clock time based on the
  visitor's last message, not tied to the widget being open — closing the
  browser doesn't pause the clock (no pun intended).

### The Agent Desk (`/app.html`)

A business's own login, so customers never touch `ADMIN_KEY`. This is the
distinction that makes the product multi-tenant rather than "one shared
password": **`/api/admin` is the platform owner (us) and can reach every
client; `/api/workspace` is a customer and can only ever reach their own.**
No workspace route reads a `clientId` from the request — it always comes off
the authenticated user, so editing a URL can't cross the boundary.

**Platform admin lives on the same login screen, not a separate page.** An
"Admin" button in the login screen's top-right corner swaps the card into a
one-field `ADMIN_KEY` form; on success it opens `#adminPanel` — the
workspaces list plus create/edit form, dark-themed to match the rest of the
Agent Desk and reusing its existing `.card`/`.field`/`.faq-item` styles
rather than new CSS. There used to be a second, separate `admin.html` page
with this same UI in a lighter theme; once everything it did was fully
ported in here, keeping two dashboards for one job stopped making sense, so
it was deleted. `state.adminKey` is a plain JS variable used only as the
`x-admin-key` header on `/api/admin/*` calls (via a separate `adminApi()`
helper, never the cookie-based `api()` the workspace login uses) — it is
never written to a cookie or persisted, so a page reload signs the platform
admin out but leaves any workspace session alone.

**Two roles.** `owner` is the business: answers chats *and* edits the
knowledge base, branding and team. `agent` is their staff: chats only. The
dashboard hides Team/Settings from agents, but the server enforces it
(`requireOwner`) — the hiding is convenience, not the boundary.

**The embed snippet lives in Settings, not just the platform-admin panel.**
The top card there ("Embed on your website") shows the exact `<script>` tag for
this workspace, built client-side from `window.location.origin` and the
workspace's own id (returned by `GET /api/workspace/client`, which an
owner can only ever fetch for their own client — no new endpoint needed).
Without this an owner had no way to get their snippet back except asking
us for it again.

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
then mint its first owner login. The platform-admin panel's workspaces list
(`/app.html`, "Admin" button) is the UI for both (create via the form, add
the owner login by expanding the new row), or drive it directly:

```bash
curl -X POST http://localhost:3000/api/admin/clients   -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json"   -d '{"id":"joes-pizza","botName":"Joe","businessInfo":"..."}'

curl -X POST http://localhost:3000/api/admin/clients/joes-pizza/users   -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json"   -d '{"email":"joe@joespizza.com","password":"at-least-8-chars","name":"Joe","role":"owner"}'
```

From there the owner signs in at `/app.html` and invites their own staff.
Deleting a workspace (from the list, or `DELETE /api/admin/clients/:id`)
cascades to every login under it — a user record pointing at a deleted
client would otherwise still authenticate, landing in a dashboard for a
workspace that no longer exists.

**The inbox.** Polls `GET /api/workspace/inbox` every 4 seconds (again: no
sockets on serverless) and splits conversations into Waiting / Mine / All.
A conversation is *waiting* when the visitor asked for a human and nobody
has picked it up (`agentRequested && !agent && !locked && !tempLocked`) — a
paused conversation gets its own low-key "Paused" tag instead and drops out
of Waiting until the visitor reopens it (see Live agent handoff above).

**Notifications.** Every signed-in agent sees the same queue, so a new
request alerts all of them at once: a red badge, a count in the tab title, a
synthesised chime (no audio file to ship) and a desktop notification if the
browser has granted permission. The dashboard tracks which request ids it
has already seen, so the alert fires once per visitor rather than every
poll, and the backlog already present at login never triggers one.

**Same-IP visitor grouping.** A conversation is stamped with the
visitor's IP at creation (`req.ip`, via `app.set("trust proxy", true)` in
`server/index.js` so this resolves correctly behind Vercel's proxy, not
just locally). The dashboard queue groups conversations sharing an IP
under one number — "Visitor 3 (2 open)" — instead of what otherwise reads
as unrelated strangers, since a fresh tab or incognito window gets its own
random `visitorId` (see Chat history and cross-device continuity above).
Grouping and numbering (`groupByIp` in `lib/sessions.js`) is a same-*network*
signal, not a same-*person* claim — a shared office or coffee-shop wifi
groups genuinely different visitors together too, so treat it as a triage
hint. The IP itself is agent-facing only: it lives in `summarizeForAgent`,
never in the visitor-facing `summarize` the widget's own Messages tab
calls, so it's never sent to the browser that owns it.

**Claiming.** Any agent can take any waiting chat. The claim attaches *that
user's* name and photo to the conversation, which is what the visitor's
widget then shows in place of the bot — so an agent's profile is
customer-facing. A second agent claiming the same chat gets a 409 naming who
holds it, and replies from anyone but the holder are rejected, so two agents
can't interleave messages under one name. It's a read-then-write, so a
genuinely simultaneous claim could still double-assign; closing that needs a
compare-and-set in Redis.

**That photo is set by uploading a file, not pasting a URL.** My profile's
photo field is a file picker (`accept="image/png,image/jpeg,image/webp"`),
resized and center-cropped to a square client-side via `<canvas>`
(`MAX_AVATAR_DIMENSION` 160px, JPEG quality 0.82) and submitted as a
`data:image/jpeg;base64,...` string through the same `POST /api/auth/me` —
there's no separate upload endpoint or file storage, since the whole thing
fits comfortably as one field on the user record. `sanitizeAvatar` in
`lib/users.js` accepts either that data URI shape or an ordinary `http(s)`
link (so the old URL-based value on existing accounts keeps working), and
explicitly rejects `data:image/svg+xml` — SVG can carry embedded scripts,
raster formats can't. Capped at `MAX_AVATAR_DATA_URI_LENGTH` (300KB of
base64) server-side, checked client-side first too so an oversized result
surfaces a clear message instead of a failed request.

**Ending a conversation.** An agent can end a conversation outright
(`POST /api/workspace/sessions/:id/close`), not just hand it back to the
bot. Unlike release (or the automatic pause above), this permanently locks
it — the visitor can never reply again, no reopen — with wording
(`CONVERSATION_CLOSED_MESSAGE` in `lib/sessions.js`) that makes clear a
person chose to end it, not that they were timed out or went quiet.
Available whether the bot is still handling it, it's sitting unclaimed in
the queue, this agent holds it themselves, or it's currently paused (a
paused conversation has no holder, so there's no ownership conflict to
check); a teammate's *active* chat is the one thing off limits, same rule
claim/reply already enforce. The dashboard asks for confirmation before
calling it, since there's no undo.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `SARVAM_API_KEY` — sign up at https://dashboard.sarvam.ai and create a key
  under API Keys (new accounts get free credits, no card required to start)
- `ADMIN_KEY` — set this to a long random string (used to protect the admin
  panel/API)

```bash
npm start
```

Then open:
- http://localhost:3000/demo.html — try the widget as an end user
- http://localhost:3000/app.html — click "Admin" on the login screen to
  onboard a new business (paste their product info, get their embed
  snippet), or sign in with a workspace login to try the Agent Desk itself
- http://localhost:3000/ (the bare domain) redirects straight to `/app.html`
  — nobody in the actual product flow visits root directly, so this exists
  purely so the domain isn't a dead 404 if someone lands on it

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
   project settings: `SARVAM_API_KEY`, `ADMIN_KEY`, `SESSION_SECRET`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (same values as your
   local `.env`). `SESSION_SECRET` in particular is easy to miss since local
   dev works fine without it (see The Agent Desk above) — set it explicitly
   in production so rotating `ADMIN_KEY` later doesn't also sign out every
   workspace login.
3. Deploy. Your Agent Desk and widget are now at
   `https://your-project.vercel.app/app.html` and
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

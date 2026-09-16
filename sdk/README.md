# @branofy/chatbot-sdk

TypeScript client for the chatbot-ai workspace API. Lets an external
system (e.g. a CRM) act as a workspace's agents/owner directly from its own
backend — no human has to log into chatbot-ai's own login screen.

Each workspace has two API keys (generated automatically, retrievable via
the platform admin API):

- **`ownerApiKey`** — can read/write everything: chat actions *and*
  settings/team management. Use for actions your admins take.
- **`agentApiKey`** — chat actions only (claim/reply/release/close). Using
  it against a settings/team endpoint throws a `ChatbotApiError` with
  `status: 403`, the same as a logged-in agent trying it in the browser
  dashboard. Use for actions your regular agents take.

## Install

Not published to a public registry yet — copy the `sdk/` folder into your
own project, or `npm link` / install from a private registry once one's set
up, then:

```bash
npm run build   # compiles src/ -> dist/
```

## Usage

```ts
import { ChatbotClient } from "@branofy/chatbot-sdk";

const agents = new ChatbotClient({
  baseUrl: "https://chatbot-ai-pi-pearl.vercel.app",
  workspaceId: "manumaharani",
  apiKey: process.env.CHATBOT_AGENT_API_KEY!,
});

// Poll this on an interval to keep a chat list live -- there's no
// websocket/push option, the chatbot-ai dashboard itself polls too.
const inbox = await agents.getInbox();
console.log(`${inbox.counts.waiting} visitor(s) waiting for a human`);

// Whoever's using YOUR system right now -- id must be stable across a
// given person's calls (used for the "someone else already has this"
// collision guard), name is what the visitor sees in place of the bot.
const me = { id: "crm-user-42", name: "Priya" };

const claimed = await agents.claim(inbox.sessions[0].id, me, "Hi, how can I help?");
await agents.reply(claimed.id, me, "What can I do for you today?");
// ...
await agents.release(claimed.id, me); // hand back to the AI when done
```

```ts
const admin = new ChatbotClient({
  baseUrl: "https://chatbot-ai-pi-pearl.vercel.app",
  workspaceId: "manumaharani",
  apiKey: process.env.CHATBOT_OWNER_API_KEY!,
});

const config = await admin.getConfig();
await admin.updateConfig({ tone: "warm and a little playful" });
```

## Error handling

Every non-2xx response throws `ChatbotApiError` (`status`, `body`, and a
`message` pulled from the server's own error text):

```ts
import { ChatbotApiError } from "@branofy/chatbot-sdk";

try {
  await agents.reply(sessionId, me, "hello");
} catch (err) {
  if (err instanceof ChatbotApiError && err.status === 409) {
    // a teammate already holds this conversation -- refresh and show who
  }
  throw err;
}
```

## What's NOT covered yet

- Website-crawl / PDF-import endpoints (`/client/crawl`, `/client/extract-pdf`)
  — not wrapped since they're one-time setup actions, not day-to-day CRM
  usage. Easy to add if needed.
- No retry/backoff logic — left to the caller, since a CRM likely already
  has its own conventions for that.
- No streaming/websocket transport. Real-time updates mean polling
  `getInbox()` on an interval, same as the built-in dashboard does (every
  4 seconds).

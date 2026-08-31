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
- `widget/widget.js` — the embeddable script. Vanilla JS, no dependencies, no
  build step. Reads `data-client-id` off its own `<script>` tag and infers the
  API base URL from where it was loaded — so the exact same file works for
  every customer with zero configuration.
- `public/admin.html` — a simple form to create/update a client's knowledge
  base and get the embed snippet to hand to the business.
- `public/demo.html` — a stand-in customer website with the widget embedded,
  for end-to-end testing.
- `server/data/clients/*.json` — one JSON file per business (their knowledge
  base). A `demo.json` is included so you can try it immediately.

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
time the container is rebuilt.

Notes for production:
- Session/rate-limit state is in-memory (`server/lib/history.js`), fine for a
  single instance; move to Redis if you scale horizontally.
- Client knowledge bases are flat JSON files; swap `server/lib/clients.js`
  for a real database if you expect many clients or need concurrent admin
  writes.
- `ALLOWED_ORIGINS=*` in `.env` allows any website to call `/api/chat`, which
  is normal for a public embeddable widget (this is how Tawk.to/Intercom
  work too) — the client's `data-client-id` scopes what knowledge is used,
  not CORS.

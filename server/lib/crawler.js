const dns = require("node:dns").promises;
const net = require("node:net");
const cheerio = require("cheerio");

const MAX_PAGES = 8;
const MAX_CHARS_PER_PAGE = 4000;
const MAX_TOTAL_CHARS = 20000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB per page

// Links whose URL/text hints at useful business content get crawled first,
// as a fallback for whatever a site's own <nav>/<header> didn't already
// surface (see extractNavLinks) -- word-boundary matched, not substring,
// so e.g. "product" doesn't false-positive-match inside "productive" or
// "return" inside a sentence like "...he left, never to return." (both
// real cases seen crawling a hotel site: pulled an unrelated offer page and
// a nearby-attraction history blurb ahead of the site's actual Dining and
// Safari pages, which scored 0 for not containing any of these words at
// all). Precompiled once since scoreLink runs per candidate link.
const PRIORITY_KEYWORDS = [
  "about", "faq", "help", "support", "pricing", "plans", "product",
  "service", "shipping", "return", "refund", "contact",
];
const PRIORITY_KEYWORD_PATTERNS = PRIORITY_KEYWORDS.map((k) => new RegExp(`\\b${k}\\b`, "i"));

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return true; // unrecognized format -> treat as unsafe
}

// Best-effort SSRF guard: refuse to crawl hosts that resolve to a private/
// loopback/link-local address. Doesn't fully close DNS-rebinding races, but
// blocks the common "point the crawler at localhost/internal-ip" case.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Refusing to crawl a private/internal address");
    return;
  }
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error("Refusing to crawl a private/internal address");
  }
}

async function fetchWithLimits(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "chatbot-ai-crawler/1.0 (knowledge-base import)" },
    });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("text/html")) return null;

    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    let received = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_RESPONSE_BYTES) {
        controller.abort();
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, footer, header, iframe, form").remove();
  const text = $("body").text();
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractTitle(html) {
  const $ = cheerio.load(html);
  return $("title").first().text().trim();
}

// Last-resort label when a page has neither usable anchor text nor a
// <title> -- turns "/our-pricing-plans" into "Our Pricing Plans" so the
// button the bot offers still reads like a real page name.
function labelFromUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const segment = path.split("/").filter(Boolean).pop();
    if (!segment) return new URL(url).hostname;
    return segment
      .replace(/\.\w+$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

// `selector` scopes which links get collected -- see the two call sites
// below: once for just <nav>/<header> (a site's own information
// architecture, trusted as-is and always fetched first regardless of
// keyword scoring) and once for everything else (keyword-scored fallback).
function extractSameOriginLinks(html, baseUrl, selector) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const links = new Map(); // href -> anchor text, for keyword scoring / labels

  $(selector).each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, base);
      if (resolved.origin !== base.origin) return;
      resolved.hash = "";
      if (resolved.href === base.href) return;
      if (!links.has(resolved.href)) {
        links.set(resolved.href, $(a).text().trim());
      }
    } catch {
      // ignore malformed hrefs
    }
  });

  return Array.from(links.entries());
}

function scoreLink(href, text) {
  const haystack = (href + " " + text).toLowerCase();
  return PRIORITY_KEYWORD_PATTERNS.some((re) => re.test(haystack)) ? 1 : 0;
}

// Some anchors (card-style "offer" links especially) wrap a whole
// descriptive paragraph as their text, not a short label -- e.g. "Corporate
// Offsite MeetThis thoughtfully planned itinerary combines productive
// business sessions...". Truncating that at 60 chars mid-sentence makes a
// bad button label, so anything implausibly long is treated as "no usable
// anchor text" and falls through to the page's own <title> instead.
const MAX_PLAUSIBLE_ANCHOR_LABEL_LENGTH = 60;

async function crawlWebsite(startUrl) {
  if (!isValidHttpUrl(startUrl)) {
    throw new Error("Please provide a valid http(s) URL");
  }
  const base = new URL(startUrl);
  await assertPublicHost(base.hostname);

  const startHtml = await fetchWithLimits(startUrl);
  if (!startHtml) {
    throw new Error("Couldn't fetch that page (must be a reachable HTML page)");
  }

  const pages = [];
  // Every page the crawl actually reads doubles as a candidate nav
  // button -- label preferring the anchor text a real visitor followed to
  // get there (most natural, e.g. "Pricing"), falling back to that page's
  // own <title>, then a label derived from its URL. This is what makes nav
  // buttons "automatic": importing a site's content this way is already
  // part of onboarding, so the page directory comes along for free instead
  // of needing separate manual entry.
  const navPages = [];
  let totalChars = 0;

  const startText = extractText(startHtml).slice(0, MAX_CHARS_PER_PAGE);
  if (startText) {
    pages.push({ url: startUrl, text: startText });
    totalChars += startText.length;
    const startLabel = extractTitle(startHtml) || labelFromUrl(startUrl);
    navPages.push({ label: startLabel.slice(0, 60), url: startUrl });
  }

  // The site's own <nav>/<header> links go first, in their own order, no
  // keyword scoring involved -- whatever a business put in its main nav
  // *is* the list of pages it considers important, for any industry, which
  // a fixed keyword list can never fully anticipate (a hotel's most
  // important pages are Dining/Safari/Rooms, none of which mention
  // "product" or "service"). Keyword scoring below is then only a fallback
  // for filling remaining budget from the rest of the page once nav links
  // are exhausted -- and only from links not already queued.
  const navLinks = extractSameOriginLinks(startHtml, startUrl, "nav a[href], header a[href]");
  const navHrefs = new Set(navLinks.map(([href]) => href));
  const otherLinks = extractSameOriginLinks(startHtml, startUrl, "a[href]")
    .filter(([href]) => !navHrefs.has(href))
    .sort((a, b) => scoreLink(b[0], b[1]) - scoreLink(a[0], a[1]));

  const candidateLinks = [...navLinks, ...otherLinks].slice(0, (MAX_PAGES - 1) * 2);

  for (const [link, anchorText] of candidateLinks) {
    if (pages.length >= MAX_PAGES || totalChars >= MAX_TOTAL_CHARS) break;
    const html = await fetchWithLimits(link);
    if (!html) continue;
    const text = extractText(html).slice(0, MAX_CHARS_PER_PAGE);
    if (!text) continue;
    pages.push({ url: link, text });
    totalChars += text.length;
    const trimmedAnchor = anchorText.trim();
    const label =
      (trimmedAnchor.length && trimmedAnchor.length <= MAX_PLAUSIBLE_ANCHOR_LABEL_LENGTH ? trimmedAnchor : "") ||
      extractTitle(html) ||
      labelFromUrl(link);
    navPages.push({ label: label.slice(0, 60), url: link });
  }

  if (!pages.length) {
    throw new Error("Found no readable text on that page");
  }

  const combined = pages
    .map((p) => `--- ${p.url} ---\n${p.text}`)
    .join("\n\n")
    .slice(0, MAX_TOTAL_CHARS);

  return { businessInfo: combined, pages: pages.map((p) => p.url), navPages };
}

module.exports = { crawlWebsite };

/*
 * Embeddable AI chat widget.
 *
 * Usage (paste on any page, anywhere in <body>):
 *   <script src="https://YOUR-SERVER.com/widget.js" data-client-id="your-client-id"></script>
 *
 * The script figures out its own API base URL from where it was loaded,
 * so no extra configuration is needed on the embedding site.
 */
(function () {
  "use strict";

  var currentScript = document.currentScript;
  if (!currentScript) return;

  var clientId = currentScript.getAttribute("data-client-id");
  if (!clientId) {
    console.error("[chat-widget] missing required data-client-id attribute on <script> tag");
    return;
  }

  var API_BASE = new URL(currentScript.src).origin;
  var STORAGE_KEY = "chatwidget_session_" + clientId; // holds the VISITOR id (see below)
  var READ_STATE_KEY = "chatwidget_read_" + clientId;

  // Optional: if the embedding site has its own logged-in users, it can pass
  // the user's id plus an HMAC of it (signed server-side with the client's
  // identitySecret) so that person's conversations follow them across
  // devices. Without these, a visitor is identified anonymously and
  // per-browser as usual.
  var userId = currentScript.getAttribute("data-user-id") || "";
  var userHash = currentScript.getAttribute("data-user-hash") || "";

  // A visitor can have several conversations (Home starts new ones, Messages
  // lists past ones) -- visitorId is the stable bucket they all live under,
  // separate from any single conversation's id.
  function getAnonymousVisitorId() {
    try {
      var id = window.localStorage.getItem(STORAGE_KEY);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
        window.localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    } catch (e) {
      return String(Date.now()) + Math.random();
    }
  }

  var visitorId = getAnonymousVisitorId();
  var config = {
    botName: "Assistant",
    welcomeMessage: "Hi! How can I help?",
    brandColor: "#6366f1",
    avatarUrl: "",
    quickReplies: [],
    faqs: [],
  };

  // Who the visitor is currently talking to in the OPEN conversation.
  // Defaults to the AI bot; if the server reports a human agent has joined
  // (reply/poll payload's `agent` field), this swaps to their name/photo.
  var currentResponder = null;

  // Requested-but-not-yet-joined ("connecting…") and ended-and-locked, for
  // the currently open conversation. Both come from the server (poll/chat
  // responses) via applyConversationState -- see server/lib/sessions.js for
  // what sets them (requestAgent, and the idle-timeout auto-close).
  var conversationAgentRequested = false;
  var conversationLocked = false;

  var els = {};
  var isOpen = false;
  var currentView = "home"; // home | messages | faq | chat
  var currentConversationId = null; // set only while view === "chat"

  // Everything up to this sequence number is already on screen for the open
  // conversation. Polling asks only for what's newer, so nothing renders twice.
  var lastSeq = 0;
  var pollTimer = null;
  var sendInFlight = false;
  var POLL_INTERVAL_MS = 4000;

  // The visitor's past conversations (Messages tab) and how far into each
  // they've actually looked -- the latter purely client-side (localStorage),
  // so the unread badge is per-browser even for a cross-device identified
  // visitor. See sessions.js's listVisitorConversations for the server side.
  var conversationsCache = [];
  var readState = loadReadState();

  function loadReadState() {
    try {
      var raw = window.localStorage.getItem(READ_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveReadState() {
    try {
      window.localStorage.setItem(READ_STATE_KEY, JSON.stringify(readState));
    } catch (e) { /* storage unavailable/full; badge just won't persist */ }
  }

  function markRead(conversationId, seq) {
    if (!conversationId || typeof seq !== "number") return;
    if ((readState[conversationId] || 0) >= seq) return;
    readState[conversationId] = seq;
    saveReadState();
    updateBadge();
  }

  // ---- small color helpers, so the widget adapts to any brand color ----

  function parseHex(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 99, g: 102, b: 241 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function shade(hex, percent) {
    var c = parseHex(hex);
    var t = percent < 0 ? 0 : 255;
    var p = Math.abs(percent);
    return (
      "rgb(" +
      Math.round((t - c.r) * p + c.r) + "," +
      Math.round((t - c.g) * p + c.g) + "," +
      Math.round((t - c.b) * p + c.b) + ")"
    );
  }

  function rgba(hex, alpha) {
    var c = parseHex(hex);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
  }

  // Pick readable text for the brand color -- a pale brand color needs dark
  // text, not the usual white.
  function contrastText(hex) {
    var c = parseHex(hex);
    var luminance = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return luminance > 0.65 ? "#1a1a1a" : "#ffffff";
  }

  function initialsOf(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("");
  }

  function relativeTime(ts) {
    var diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + "m ago";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    return Math.floor(diffHr / 24) + "d ago";
  }

  function injectStyles(brand) {
    var onBrand = contrastText(brand);
    var style = document.createElement("style");
    style.textContent =
      "#cw-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}" +

      /* launcher bubble */
      "#cw-bubble{width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg," + brand + "," + shade(brand, -0.2) + ");box-shadow:0 6px 20px " + rgba(brand, 0.45) + ",0 2px 6px rgba(0,0,0,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;border:none;padding:0;transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease}" +
      "#cw-bubble:hover{transform:scale(1.08)}" +
      "#cw-bubble:active{transform:scale(.96)}" +
      "#cw-bubble svg{width:27px;height:27px;transition:transform .25s ease}" +
      "#cw-root.cw-is-open #cw-bubble svg.cw-ico-chat{display:none}" +
      "#cw-root:not(.cw-is-open) #cw-bubble svg.cw-ico-close{display:none}" +

      /* window */
      "#cw-window{position:fixed;bottom:92px;right:20px;width:380px;max-width:calc(100vw - 32px);height:580px;max-height:calc(100vh - 130px);background:#fff;border-radius:20px;box-shadow:0 16px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.97);pointer-events:none;transition:opacity .22s ease,transform .22s cubic-bezier(.34,1.3,.64,1)}" +
      "#cw-window.cw-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}" +

      /* header */
      "#cw-header{background:linear-gradient(135deg," + brand + "," + shade(brand, -0.22) + ");color:" + onBrand + ";padding:16px 18px;display:flex;align-items:center;gap:12px;flex-shrink:0}" +
      "#cw-header-info{flex:1;min-width:0}" +
      "#cw-title{font-weight:650;font-size:15.5px;line-height:1.25;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#cw-status{font-size:12px;opacity:.85;display:flex;align-items:center;gap:5px;margin-top:2px}" +
      "#cw-status i{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;box-shadow:0 0 0 2px " + rgba("#4ade80", 0.3) + "}" +
      "#cw-close{background:rgba(255,255,255,.16);border:none;color:" + onBrand + ";width:30px;height:30px;border-radius:50%;font-size:17px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s ease}" +
      "#cw-close:hover{background:rgba(255,255,255,.3)}" +
      "#cw-back{background:rgba(255,255,255,.16);border:none;width:30px;height:30px;border-radius:50%;cursor:pointer;padding:0;display:none;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s ease}" +
      "#cw-back:hover{background:rgba(255,255,255,.3)}" +
      "#cw-back svg{width:17px;height:17px}" +
      "#cw-root.cw-has-back #cw-back{display:flex}" +
      /* outside an open conversation the avatar lives in the body instead, so the header stays plain */
      "#cw-window:not(.cw-view-chat) #cw-header .cw-avatar{display:none}" +

      /* view switching */
      ".cw-view{display:none;flex:1;flex-direction:column;min-height:0}" +
      ".cw-view.cw-active{display:flex}" +

      /* home */
      "#cw-home-list{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa}" +
      ".cw-menu-head{display:flex;align-items:center;gap:12px;padding:4px 2px 14px}" +
      ".cw-menu-head strong{display:block;font-size:15.5px;color:#1a1c22}" +
      ".cw-menu-head span{display:block;font-size:12.5px;color:#8a8d99;margin-top:1px}" +
      ".cw-tile{display:flex;align-items:center;gap:13px;width:100%;text-align:left;background:#fff;border:1px solid #e8e9ee;border-radius:14px;padding:14px;cursor:pointer;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease,transform .12s ease}" +
      ".cw-tile:hover{border-color:" + rgba(brand, 0.5) + ";box-shadow:0 3px 10px rgba(0,0,0,.06);transform:translateY(-1px)}" +
      ".cw-tile-ico{width:38px;height:38px;border-radius:11px;background:" + rgba(brand, 0.1) + ";color:" + shade(brand, -0.2) + ";display:flex;align-items:center;justify-content:center;flex-shrink:0}" +
      ".cw-tile-ico svg{width:19px;height:19px}" +
      ".cw-tile-text{flex:1;min-width:0}" +
      ".cw-tile-text strong{display:block;font-size:14.5px;color:#1a1c22;font-weight:600}" +
      ".cw-tile-text span{display:block;font-size:12.5px;color:#8a8d99;margin-top:2px}" +
      ".cw-tile-chev{color:#c2c5cf;display:flex;flex-shrink:0}" +
      ".cw-tile-chev svg{width:17px;height:17px}" +
      ".cw-home-subhead{font-size:12.5px;font-weight:650;color:#8a8d99;text-transform:uppercase;letter-spacing:.03em;margin:10px 2px 0}" +
      ".cw-home-quick{display:flex;flex-wrap:wrap;gap:7px}" +

      /* quick-question chips (Home) */
      ".cw-chip{background:#fff;border:1.5px solid " + rgba(brand, 0.35) + ";color:" + shade(brand, -0.25) + ";padding:8px 14px;border-radius:16px;font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s ease;line-height:1.3}" +
      ".cw-chip:hover{background:" + rgba(brand, 0.08) + ";border-color:" + brand + ";transform:translateY(-1px)}" +
      ".cw-chip:active{transform:translateY(0)}" +

      /* messages tab -- holds the "start new" section (CTA + quick chips) */
      /* above the past-conversations list, so it shares Home's spacing     */
      "#cw-messages-list{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa}" +
      ".cw-conv-row{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:#fff;border:1px solid #e8e9ee;border-radius:14px;padding:11px 12px;cursor:pointer;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease,transform .12s ease}" +
      ".cw-conv-row:hover{border-color:" + rgba(brand, 0.5) + ";box-shadow:0 3px 10px rgba(0,0,0,.06);transform:translateY(-1px)}" +
      ".cw-conv-text{flex:1;min-width:0}" +
      ".cw-conv-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}" +
      ".cw-conv-top strong{font-size:14px;color:#1a1c22;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cw-conv-time{font-size:11.5px;color:#a3a6b1;flex-shrink:0}" +
      ".cw-conv-preview{font-size:13px;color:#7d808c;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cw-conv-row.cw-unread .cw-conv-preview{color:#2a2c34;font-weight:550}" +
      ".cw-conv-badge{background:" + brand + ";color:" + contrastText(brand) + ";font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 5px;flex-shrink:0}" +
      ".cw-conv-chev{color:#c2c5cf;display:flex;flex-shrink:0}" +
      ".cw-conv-chev svg{width:16px;height:16px}" +

      /* faq / help */
      "#cw-faq-list{flex:1;overflow-y:auto;padding:14px 16px 18px;display:flex;flex-direction:column;gap:8px;background:#f7f8fa}" +
      "#cw-faq-list::-webkit-scrollbar,#cw-home-list::-webkit-scrollbar,#cw-messages-list::-webkit-scrollbar{width:6px}" +
      "#cw-faq-list::-webkit-scrollbar-thumb,#cw-home-list::-webkit-scrollbar-thumb,#cw-messages-list::-webkit-scrollbar-thumb{background:#d4d6dd;border-radius:3px}" +
      ".cw-faq-item{background:#fff;border:1px solid #e8e9ee;border-radius:12px;overflow:hidden}" +
      ".cw-faq-q{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;padding:13px 14px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:550;color:#1a1c22;line-height:1.4}" +
      ".cw-faq-q span{flex:1}" +
      ".cw-faq-caret{color:#b0b3bd;display:flex;flex-shrink:0;transition:transform .2s ease}" +
      ".cw-faq-caret svg{width:16px;height:16px}" +
      ".cw-faq-item.cw-open .cw-faq-caret{transform:rotate(180deg)}" +
      ".cw-faq-a{display:none;padding:0 14px 14px;font-size:13.8px;line-height:1.55;color:#4a4d59;white-space:pre-wrap}" +
      ".cw-faq-item.cw-open .cw-faq-a{display:block;animation:cw-in .22s ease}" +
      ".cw-faq-cta{margin-top:6px;background:none;border:none;color:" + shade(brand, -0.2) + ";font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;padding:10px;border-radius:10px;transition:background .15s ease}" +
      ".cw-faq-cta:hover{background:" + rgba(brand, 0.08) + "}" +
      ".cw-faq-empty{padding:30px 20px;text-align:center;color:#a3a6b1;font-size:13.5px}" +

      /* bottom tab bar */
      "#cw-tabbar{display:flex;border-top:1px solid #ecedf1;background:#fff;flex-shrink:0}" +
      ".cw-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;padding:9px 4px 8px;cursor:pointer;font-family:inherit;color:#9296a3;position:relative;transition:color .15s ease}" +
      ".cw-tab:hover{color:" + shade(brand, -0.1) + "}" +
      ".cw-tab.cw-tab-active{color:" + brand + "}" +
      ".cw-tab-ico{position:relative;display:flex}" +
      ".cw-tab-ico svg{width:21px;height:21px}" +
      ".cw-tab span{font-size:10.5px;font-weight:600}" +
      ".cw-tab-badge{position:absolute;top:-4px;right:-8px;background:#ef4444;color:#fff;font-size:9.5px;font-weight:700;min-width:15px;height:15px;border-radius:8px;display:none;align-items:center;justify-content:center;padding:0 3px;box-shadow:0 0 0 2px #fff}" +

      /* avatars */
      ".cw-avatar{width:38px;height:38px;border-radius:50%;flex-shrink:0;object-fit:cover;display:flex;align-items:center;justify-content:center;font-weight:650;font-size:14px;overflow:hidden;background:" + shade(brand, 0.75) + ";color:" + shade(brand, -0.35) + "}" +
      "#cw-header .cw-avatar{box-shadow:0 0 0 2px rgba(255,255,255,.35);background:rgba(255,255,255,.22);color:" + onBrand + "}" +
      ".cw-avatar-sm{width:26px;height:26px;font-size:10.5px;align-self:flex-end;margin-bottom:2px}" +
      ".cw-avatar-row{width:34px;height:34px;font-size:12px}" +

      /* messages (chat view) */
      "#cw-messages{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa;scroll-behavior:smooth}" +
      "#cw-messages::-webkit-scrollbar{width:6px}" +
      "#cw-messages::-webkit-scrollbar-thumb{background:#d4d6dd;border-radius:3px}" +
      "#cw-messages::-webkit-scrollbar-track{background:transparent}" +
      ".cw-row{display:flex;gap:8px;align-items:flex-end;animation:cw-in .28s cubic-bezier(.34,1.3,.64,1)}" +
      ".cw-row-user{justify-content:flex-end}" +
      "@keyframes cw-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}" +
      ".cw-msg{max-width:78%;padding:10px 14px;border-radius:18px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}" +
      ".cw-msg-bot{background:#fff;color:#1a1c22;border:1px solid #e8e9ee;border-bottom-left-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.04)}" +
      ".cw-msg-user{background:linear-gradient(135deg," + brand + "," + shade(brand, -0.15) + ");color:" + onBrand + ";border-bottom-right-radius:6px}" +

      /* inline reply chips (quick-start questions + AI-suggested follow-ups) */
      ".cw-inline-chips{display:flex;flex-wrap:wrap;gap:7px;padding:2px 0 2px 34px;animation:cw-in .3s ease}" +

      /* typing indicator */
      ".cw-typing{background:#fff;border:1px solid #e8e9ee;border-bottom-left-radius:6px;border-radius:18px;padding:13px 16px;display:flex;gap:4px;align-items:center}" +
      ".cw-dot{width:7px;height:7px;border-radius:50%;background:#b6b9c4;animation:cw-bounce 1.3s infinite ease-in-out}" +
      ".cw-dot:nth-child(2){animation-delay:.16s}.cw-dot:nth-child(3){animation-delay:.32s}" +
      "@keyframes cw-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}" +

      /* talk-to-a-human bar, shown above the composer while the AI is still handling things */
      "#cw-agent-request-bar{display:flex;justify-content:center;padding:8px 14px;background:#fff;border-top:1px solid #f0f1f4}" +
      "#cw-agent-request-btn{background:none;border:1.5px solid " + rgba(brand, 0.35) + ";color:" + shade(brand, -0.25) + ";font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:7px 14px;border-radius:16px;transition:all .15s ease}" +
      "#cw-agent-request-btn:hover{background:" + rgba(brand, 0.08) + ";border-color:" + brand + "}" +

      /* composer */
      "#cw-inputbar{display:flex;gap:8px;padding:12px 14px;border-top:1px solid #ecedf1;flex-shrink:0;background:#fff;align-items:flex-end}" +
      "#cw-input{flex:1;border:1.5px solid #e2e4ea;border-radius:22px;padding:10px 15px;font-size:14.5px;outline:none;resize:none;max-height:96px;font-family:inherit;line-height:1.45;color:#1a1c22;transition:border-color .15s ease,box-shadow .15s ease;background:#fafbfc}" +
      "#cw-input:focus{border-color:" + brand + ";background:#fff;box-shadow:0 0 0 3px " + rgba(brand, 0.12) + "}" +
      "#cw-input::placeholder{color:#a8abb6}" +
      "#cw-input:disabled{background:#f2f3f5;color:#a3a6b1;cursor:not-allowed}" +
      "#cw-send{background:linear-gradient(135deg," + brand + "," + shade(brand, -0.18) + ");border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease,opacity .15s ease}" +
      "#cw-send:hover:not(:disabled){transform:scale(1.06)}" +
      "#cw-send:disabled{opacity:.45;cursor:default}" +
      "#cw-send svg{width:17px;height:17px}" +
      "#cw-footer{display:flex;align-items:center;justify-content:center;padding:6px 0;background:#fff;border-top:1px solid #f0f1f4}" +
      "#cw-footer-home{background:none;border:none;color:#9296a3;cursor:pointer;padding:6px 16px;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:color .15s ease,background .15s ease}" +
      "#cw-footer-home:hover{color:" + brand + ";background:" + rgba(brand, 0.08) + "}" +
      "#cw-footer-home svg{width:19px;height:19px}" +

      "@media (max-width:480px){#cw-window{right:12px;left:12px;bottom:88px;width:auto;max-width:none;height:calc(100vh - 120px)}#cw-root{right:16px;bottom:16px}}";
    document.head.appendChild(style);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var ICONS = {
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>',
    home: '<path d="M3 11.5L12 4l9 7.5"></path><path d="M5 10v9.5a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"></path>',
    help: '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    send: '<path d="M2 21l21-9L2 3v7l15 2-15 2z"></path>',
  };
  function svg(iconKey, strokeOrFill, filled) {
    var attr = filled ? 'fill="' + strokeOrFill + '"' : 'fill="none" stroke="' + strokeOrFill + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    return '<svg viewBox="0 0 24 24" ' + attr + '>' + ICONS[iconKey] + "</svg>";
  }

  // Builds an avatar for whoever is currently answering (bot, or a human
  // agent if one has taken over). Falls back to initials when there's no
  // usable image. `sender` overrides the "current" responder -- used for
  // individual past messages and for Messages-tab rows, which may belong to
  // a different responder than whoever is live right now.
  function makeAvatar(sizeClass, sender) {
    var responder = sender || currentResponder || { name: config.botName, avatarUrl: config.avatarUrl };
    var cls = "cw-avatar" + (sizeClass ? " " + sizeClass : "");
    if (responder.avatarUrl) {
      var img = el("img", { class: cls, src: responder.avatarUrl, alt: responder.name || "" });
      img.addEventListener("error", function () {
        var fallback = el("div", { class: cls, text: initialsOf(responder.name) });
        if (img.parentNode) img.parentNode.replaceChild(fallback, img);
      });
      return img;
    }
    return el("div", { class: cls, text: initialsOf(responder.name) });
  }

  function refreshHeaderIdentity() {
    var responder = currentResponder || { name: config.botName, avatarUrl: config.avatarUrl };
    els.title.textContent = responder.name || config.botName;
    var fresh = makeAvatar("");
    els.headerAvatar.parentNode.replaceChild(fresh, els.headerAvatar);
    els.headerAvatar = fresh;
  }

  // Status line + "talk to a live agent" bar + composer lock, all driven by
  // the same three bits of state: is an agent attached (currentResponder),
  // has one been requested but not joined yet (conversationAgentRequested),
  // has the conversation auto-ended (conversationLocked). Called whenever
  // any of those change while the chat view is showing.
  function updateChatStatusUI() {
    if (conversationLocked) {
      els.statusText.textContent = "Conversation ended";
    } else if (currentResponder) {
      els.statusText.textContent = "Live agent";
    } else if (conversationAgentRequested) {
      els.statusText.textContent = "Connecting to an agent…";
    } else {
      els.statusText.textContent = "Online";
    }
    els.status.style.display = "";

    var showRequestBtn = !conversationLocked && !conversationAgentRequested && !currentResponder;
    els.agentRequestBar.style.display = showRequestBtn ? "flex" : "none";

    els.input.disabled = conversationLocked;
    els.send.disabled = conversationLocked || sendInFlight;
    els.input.placeholder = conversationLocked ? "This conversation has ended" : "Type a message…";
  }

  // Applies agentRequested/locked from a server response (poll, chat, or
  // request-agent) to the currently open conversation's UI state.
  function applyConversationState(data) {
    if (!data) return;
    if (typeof data.agentRequested === "boolean") conversationAgentRequested = data.agentRequested;
    if (typeof data.locked === "boolean") conversationLocked = data.locked;
    if (currentView === "chat") updateChatStatusUI();
  }

  // ---- building the UI shell -------------------------------------------

  function buildUI() {
    var root = el("div", { id: "cw-root" });

    var bubble = el("button", { id: "cw-bubble", "aria-label": "Open chat" });
    bubble.innerHTML =
      '<svg class="cw-ico-chat" viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + ICONS.chat + "</svg>" +
      '<svg class="cw-ico-close" viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) + '" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"></path></svg>';

    var win = el("div", { id: "cw-window", role: "dialog", "aria-label": "Chat" });

    var backBtn = el("button", { id: "cw-back", "aria-label": "Back" });
    backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) +
      '" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>';

    var headerAvatar = makeAvatar("");
    var title = el("span", { id: "cw-title", text: config.botName });
    var statusDot = el("i", {});
    var statusText = el("span", { text: "Online" });
    var status = el("div", { id: "cw-status" }, [statusDot, statusText]);
    var headerInfo = el("div", { id: "cw-header-info" }, [title, status]);
    var closeBtn = el("button", { id: "cw-close", "aria-label": "Close chat", text: "✕" });
    var header = el("div", { id: "cw-header" }, [backBtn, headerAvatar, headerInfo, closeBtn]);

    // --- chat view: an open conversation ---
    var messages = el("div", { id: "cw-messages" });

    var agentRequestBtn = el("button", { id: "cw-agent-request-btn", type: "button", text: "🙋 Talk to a live agent" });
    agentRequestBtn.addEventListener("click", requestLiveAgent);
    var agentRequestBar = el("div", { id: "cw-agent-request-bar" }, [agentRequestBtn]);

    var input = el("textarea", { id: "cw-input", rows: "1", placeholder: "Type a message…" });
    var send = el("button", { id: "cw-send", "aria-label": "Send" });
    send.innerHTML = svg("send", contrastText(config.brandColor), true);
    var inputBar = el("div", { id: "cw-inputbar" }, [input, send]);
    var footerHome = el("button", { id: "cw-footer-home", type: "button", "aria-label": "Go to Home" });
    footerHome.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS.home + "</svg>";
    footerHome.addEventListener("click", function () { showView("home"); });
    var footer = el("div", { id: "cw-footer" }, [footerHome]);
    var chatView = el("div", { class: "cw-view", "data-view": "chat" }, [messages, agentRequestBar, inputBar, footer]);

    // --- home view ---
    var homeList = el("div", { id: "cw-home-list" });
    var homeView = el("div", { class: "cw-view", "data-view": "home" }, [homeList]);

    // --- messages view (past conversations) ---
    var messagesList = el("div", { id: "cw-messages-list" });
    var messagesView = el("div", { class: "cw-view", "data-view": "messages" }, [messagesList]);

    // --- help view (FAQs) ---
    var faqList = el("div", { id: "cw-faq-list" });
    var faqView = el("div", { class: "cw-view", "data-view": "faq" }, [faqList]);

    // --- bottom tab bar ---
    var tabHome = tabButton("home", ICONS.home, "Home");
    var tabMessages = tabButton("messages", ICONS.chat, "Messages");
    var tabBadge = el("span", { class: "cw-tab-badge" });
    tabMessages.querySelector(".cw-tab-ico").appendChild(tabBadge);
    var tabHelp = tabButton("faq", ICONS.help, "Help");
    var tabbar = el("div", { id: "cw-tabbar" }, [tabHome, tabMessages, tabHelp]);

    win.appendChild(header);
    win.appendChild(homeView);
    win.appendChild(messagesView);
    win.appendChild(faqView);
    win.appendChild(chatView);
    win.appendChild(tabbar);
    root.appendChild(win);
    root.appendChild(bubble);
    document.body.appendChild(root);

    els = {
      root: root, bubble: bubble, window: win, header: header, back: backBtn,
      headerAvatar: headerAvatar, title: title, status: status, statusText: statusText,
      close: closeBtn, messages: messages, input: input, send: send,
      views: { chat: chatView, home: homeView, messages: messagesView, faq: faqView },
      tabbar: tabbar, tabs: { home: tabHome, messages: tabMessages, faq: tabHelp },
      tabBadge: tabBadge,
      homeList: homeList, messagesList: messagesList, faqList: faqList,
      agentRequestBar: agentRequestBar,
    };

    buildHome();
    buildFaq();
    showView("home");

    bubble.addEventListener("click", toggleOpen);
    closeBtn.addEventListener("click", toggleOpen);
    backBtn.addEventListener("click", function () { showView(previousView); });
    send.addEventListener("click", sendMessage);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 96) + "px";
    });
  }

  function tabButton(view, icon, label) {
    var iconWrap = el("div", { class: "cw-tab-ico" });
    iconWrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + icon + "</svg>";
    var btn = el("button", { class: "cw-tab", type: "button", "data-tab": view }, [
      iconWrap, el("span", { text: label }),
    ]);
    btn.addEventListener("click", function () { showView(view); });
    return btn;
  }

  // ---- view navigation: home / messages / help are peer tabs; chat is a --
  // ---- "pushed" screen reached from either, with a back arrow to return --

  var previousView = "home"; // where the back arrow returns to from chat

  var TAB_META = {
    home: { title: "How can we help?" },
    messages: { title: "Messages" },
    faq: { title: "Help" },
  };

  function showView(name) {
    if (name !== "chat") previousView = name;
    currentView = name;
    Object.keys(els.views).forEach(function (k) {
      els.views[k].classList.toggle("cw-active", k === name);
    });
    els.window.classList.toggle("cw-view-chat", name === "chat");
    els.root.classList.toggle("cw-has-back", name === "chat");
    els.tabbar.style.display = name === "chat" ? "none" : "flex";
    Object.keys(els.tabs).forEach(function (k) {
      els.tabs[k].classList.toggle("cw-tab-active", k === name);
    });

    if (name === "chat") {
      refreshHeaderIdentity();
      updateChatStatusUI();
      scrollToBottom();
      setTimeout(function () { els.input.focus(); }, 120);
    } else {
      els.title.textContent = TAB_META[name].title;
      els.status.style.display = "none";
      if (name === "messages") renderMessagesList();
    }
  }

  // Right-pointing chevron, used on anything tappable that navigates
  // somewhere (action tiles, conversation rows) as an affordance hint.
  function chevron(cls) {
    var c = el("div", { class: cls || "cw-tile-chev" });
    c.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg>';
    return c;
  }

  function actionTile(icon, label, sub, onClick) {
    var iconEl = el("div", { class: "cw-tile-ico" });
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + icon + "</svg>";
    var textEl = el("div", { class: "cw-tile-text" }, [
      el("strong", { text: label }),
      el("span", { text: sub }),
    ]);
    var tile = el("button", { class: "cw-tile", type: "button" }, [iconEl, textEl, chevron()]);
    tile.addEventListener("click", onClick);
    return tile;
  }

  // Shared by Home's "Top questions" preview and Help's full list -- an
  // expand/collapse accordion, answer shown inline, no conversation started.
  function renderFaqItems(container, faqs) {
    faqs.forEach(function (faq) {
      var q = el("button", { class: "cw-faq-q", type: "button" }, [el("span", { text: faq.question })]);
      var caret = el("i", { class: "cw-faq-caret" });
      caret.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
      q.appendChild(caret);
      var a = el("div", { class: "cw-faq-a", text: faq.answer });
      var item = el("div", { class: "cw-faq-item" }, [q, a]);
      q.addEventListener("click", function () { item.classList.toggle("cw-open"); });
      container.appendChild(item);
    });
  }

  var HOME_FAQ_COUNT = 3;

  // Home: quick answers without needing to chat. Just the top few FAQs,
  // expandable inline, plus a fallback link for anything not covered.
  function buildHome() {
    els.homeList.innerHTML = "";
    els.homeList.appendChild(el("div", { class: "cw-menu-head" }, [
      makeAvatar(""),
      el("div", {}, [
        el("strong", { text: config.botName }),
        el("span", { text: "Typically replies in a few seconds" }),
      ]),
    ]));

    els.homeList.appendChild(actionTile(
      ICONS.chat, "Message us directly", "Start a new conversation",
      function () { startNewConversation(); }
    ));

    var topFaqs = (config.faqs || []).slice(0, HOME_FAQ_COUNT);
    if (topFaqs.length) {
      els.homeList.appendChild(el("div", { class: "cw-home-subhead", text: "Top questions" }));
      renderFaqItems(els.homeList, topFaqs);
    }
  }

  // Help: the full FAQ library, same accordion, same "ask a human" fallback.
  function buildFaq() {
    els.faqList.innerHTML = "";
    if (!config.faqs || !config.faqs.length) {
      els.faqList.appendChild(el("div", { class: "cw-faq-empty", text: "No help articles yet -- ask us anything and we'll do our best!" }));
    } else {
      renderFaqItems(els.faqList, config.faqs);
    }

    var cta = el("button", { class: "cw-faq-cta", type: "button", text: "Still need help? Ask our assistant →" });
    cta.addEventListener("click", function () { startNewConversation(); });
    els.faqList.appendChild(cta);
  }

  // Messages: where a visitor actually starts or continues talking -- the
  // "Send us a message" CTA and quick-question starters live here (moved
  // off Home, which is now purely the quick-answers screen above), followed
  // by their past conversations. The quick-reply chips used to live here too
  // -- they're now shown inside a freshly-started conversation itself (see
  // startNewConversation), alongside dynamically suggested follow-ups.
  function renderMessagesList() {
    els.messagesList.innerHTML = "";

    els.messagesList.appendChild(actionTile(
      ICONS.chat, "Send us a message", "Start a new conversation",
      function () { startNewConversation(); }
    ));

    els.messagesList.appendChild(el("div", { class: "cw-home-subhead", text: "Past conversations" }));

    if (!conversationsCache.length) {
      els.messagesList.appendChild(el("div", { class: "cw-faq-empty", text: "No conversations yet." }));
      return;
    }

    conversationsCache.forEach(function (conv) {
      var unread = conv.id === currentConversationId ? 0 : Math.max(0, conv.seq - (readState[conv.id] || 0));
      var responder = conv.agent ? { name: conv.agent.name, avatarUrl: conv.agent.avatarUrl } : { name: config.botName, avatarUrl: config.avatarUrl };
      var previewText = conv.lastMessage
        ? (conv.lastMessage.role === "user" ? "You: " : "") + conv.lastMessage.content
        : "New conversation";

      var row = el("button", { class: "cw-conv-row" + (unread > 0 ? " cw-unread" : ""), type: "button" }, [
        makeAvatar("cw-avatar-row", responder),
        el("div", { class: "cw-conv-text" }, [
          el("div", { class: "cw-conv-top" }, [
            el("strong", { text: responder.name }),
            el("span", { class: "cw-conv-time", text: relativeTime(conv.updatedAt) }),
          ]),
          el("div", { class: "cw-conv-preview", text: previewText }),
        ]),
        unread > 0 ? el("span", { class: "cw-conv-badge", text: unread > 9 ? "9+" : String(unread) }) : null,
        chevron("cw-conv-chev"),
      ]);
      row.addEventListener("click", function () { openConversation(conv.id); });
      els.messagesList.appendChild(row);
    });
  }

  function updateBadge() {
    var total = conversationsCache.reduce(function (sum, c) {
      if (c.id === currentConversationId) return sum;
      return sum + Math.max(0, c.seq - (readState[c.id] || 0));
    }, 0);
    els.tabBadge.textContent = total > 9 ? "9+" : String(total);
    els.tabBadge.style.display = total > 0 ? "flex" : "none";
  }

  // Called from several places close together (creating a conversation,
  // right after a reply, every poll tick) -- nothing stops two of those
  // requests from resolving out of order, which would let a request fired
  // BEFORE a reply exists land AFTER one fired after it, clobbering fresh
  // data with stale. Only ever apply the response from the most recently
  // *issued* request.
  var conversationsFetchToken = 0;
  function fetchConversations() {
    var token = ++conversationsFetchToken;
    var url = API_BASE + "/api/visitors/" + encodeURIComponent(visitorId) +
      "/conversations?clientId=" + encodeURIComponent(clientId);
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : { conversations: [] }; })
      .then(function (data) {
        if (token !== conversationsFetchToken) return; // a newer request has since been issued
        conversationsCache = data.conversations || [];
        updateBadge();
        if (currentView === "messages") renderMessagesList();
      })
      .catch(function () { /* transient network issue; next poll tick retries */ });
  }

  function toggleOpen() {
    isOpen = !isOpen;
    els.window.classList.toggle("cw-open", isOpen);
    els.root.classList.toggle("cw-is-open", isOpen);
    els.bubble.setAttribute("aria-label", isOpen ? "Close chat" : "Open chat");
    if (isOpen) {
      fetchConversations();
      startPolling();
      if (currentView === "chat") setTimeout(function () { els.input.focus(); }, 220);
    } else {
      stopPolling();
    }
  }

  // ---- an open conversation: creating, resuming, messaging -------------

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addMessage(role, text, sender) {
    var isUser = role === "user";
    var bubbleEl = el("div", { class: "cw-msg " + (isUser ? "cw-msg-user" : "cw-msg-bot"), text: text });
    var row = el("div", { class: "cw-row" + (isUser ? " cw-row-user" : "") },
      isUser ? [bubbleEl] : [makeAvatar("cw-avatar-sm", sender), bubbleEl]);
    els.messages.appendChild(row);
    scrollToBottom();
  }

  function showTyping() {
    var typing = el("div", { class: "cw-typing" });
    typing.innerHTML = '<span class="cw-dot"></span><span class="cw-dot"></span><span class="cw-dot"></span>';
    var row = el("div", { class: "cw-row", id: "cw-typing-row" }, [makeAvatar("cw-avatar-sm"), typing]);
    els.messages.appendChild(row);
    scrollToBottom();
  }

  function hideTyping() {
    var row = document.getElementById("cw-typing-row");
    if (row) row.remove();
  }

  function resetChatView() {
    els.messages.innerHTML = "";
    lastSeq = 0;
    currentResponder = null;
    conversationAgentRequested = false;
    conversationLocked = false;
  }

  // Tappable reply chips shown inline in the chat -- the client's configured
  // quick-reply questions under the welcome message when a conversation
  // starts, and (separately) up to 2 AI-suggested follow-ups under a bot
  // reply. Only one set is ever on screen: sending anything, by chip or by
  // typing, clears whatever's currently shown.
  function clearReplyChips() {
    var wrap = document.getElementById("cw-reply-chips");
    if (wrap) wrap.remove();
  }

  function renderReplyChips(options) {
    if (!options || !options.length) return;
    clearReplyChips();
    var wrap = el("div", { id: "cw-reply-chips", class: "cw-inline-chips" });
    options.forEach(function (text) {
      var chip = el("button", { class: "cw-chip", type: "button", text: text });
      chip.addEventListener("click", function () { submitText(text); });
      wrap.appendChild(chip);
    });
    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  // Home's "Message us directly", Messages' "Send us a message", and Help's
  // "Ask our assistant" link all land here -- always a genuinely new
  // conversation, never reusing whatever was open before.
  function startNewConversation() {
    resetChatView();
    currentConversationId = null;
    showView("chat");
    addMessage("bot", config.welcomeMessage);

    fetch(API_BASE + "/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId, visitorId: visitorId }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || "Could not start a conversation");
        currentConversationId = res.data.sessionId;
        fetchConversations();
        renderReplyChips(config.quickReplies);
      })
      .catch(function (err) {
        addMessage("bot", "Sorry, I couldn't start a new conversation: " + err.message);
      });
  }

  // Messages tab: reopen a past conversation, replaying its full transcript.
  function openConversation(conversationId) {
    resetChatView();
    currentConversationId = conversationId;
    showView("chat");
    fetchOpenConversationMessages(true);
  }

  function fetchOpenConversationMessages(isInitialLoad) {
    if (!currentConversationId) return Promise.resolve();
    var conversationId = currentConversationId; // guard against switching mid-request
    var url = API_BASE + "/api/sessions/" + encodeURIComponent(conversationId) +
      "/messages?clientId=" + encodeURIComponent(clientId) + "&since=" + lastSeq;
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || conversationId !== currentConversationId) return;
        applyAgent(data.agent);
        applyConversationState(data);
        (data.messages || []).forEach(function (m) {
          if (m.seq <= lastSeq) return;
          addMessage(m.role === "user" ? "user" : "bot", m.content, m.sender);
          lastSeq = m.seq;
        });
        if (isInitialLoad && !data.messages.length) {
          // A conversation that was created but never actually messaged in.
          addMessage("bot", config.welcomeMessage);
        }
        markRead(conversationId, data.seq);
      })
      .catch(function () { /* next poll tick retries */ });
  }

  function applyAgent(agent) {
    var changed = agent
      ? !currentResponder || currentResponder.name !== agent.name
      : !!currentResponder;
    currentResponder = agent ? { name: agent.name, avatarUrl: agent.avatarUrl || "" } : null;
    if (changed && currentView === "chat") {
      refreshHeaderIdentity();
      updateChatStatusUI();
    }
  }

  function pollOnce() {
    fetchConversations(); // keeps the Messages badge/list live from any tab
    if (currentView !== "chat" || sendInFlight) return;
    fetchOpenConversationMessages(false);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function sendMessage() {
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    els.input.style.height = "auto";
    submitText(text);
  }

  function submitText(text) {
    if (!currentConversationId) return; // conversation still being created; ignore stray input
    clearReplyChips();
    addMessage("user", text);
    els.send.disabled = true;
    sendInFlight = true;
    showTyping();

    fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId, sessionId: currentConversationId, message: text }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) {
            var err = new Error(data.error || "Request failed");
            err.locked = !!data.locked;
            throw err;
          }
          return data;
        });
      })
      .then(function (data) {
        hideTyping();
        if (typeof data.seq === "number") lastSeq = Math.max(lastSeq, data.seq);
        if (data.agent && data.agent.name) applyAgent(data.agent);
        applyConversationState(data);

        if (data.pending) {
          // An agent has joined, or the visitor is still waiting for one --
          // either way their answer arrives via polling, there's no instant
          // reply to show.
        } else {
          addMessage("bot", data.reply);
          renderReplyChips(data.suggestions);
        }
        markRead(currentConversationId, data.seq);
        fetchConversations(); // refresh Messages preview/order right away
      })
      .catch(function (err) {
        hideTyping();
        if (err.locked) {
          // The conversation ended (idle timeout) in the moment between our
          // last poll and this send. Pull down the "conversation has ended"
          // message the server already appended, and lock the composer.
          applyConversationState({ locked: true });
          fetchOpenConversationMessages(false);
        } else {
          addMessage("bot", "Sorry, I ran into a problem: " + err.message);
        }
      })
      .finally(function () {
        sendInFlight = false;
        if (currentView === "chat") updateChatStatusUI();
      });
  }

  // "🙋 Talk to a live agent" -- the visitor's side of asking for human
  // help. The AI stops responding to this conversation immediately (server
  // enforces this regardless of what the widget does), well before any
  // specific agent actually joins.
  function requestLiveAgent() {
    if (!currentConversationId || conversationLocked || conversationAgentRequested || currentResponder) return;
    fetch(API_BASE + "/api/sessions/" + encodeURIComponent(currentConversationId) + "/request-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || "Could not connect to an agent");
          return data;
        });
      })
      .then(function (data) {
        clearReplyChips();
        applyConversationState(data);
        fetchConversations();
        // The canned "connecting…" message was appended server-side; pull it
        // down the same way any other new message arrives.
        return fetchOpenConversationMessages(false);
      })
      .catch(function (err) {
        addMessage("bot", "Sorry, I couldn't connect you to an agent: " + err.message);
      });
  }

  // ---- startup -----------------------------------------------------------

  // Resolves which VISITOR this is (not which conversation) -- see
  // /api/visitor/resolve. Anonymous visitors skip the round trip entirely
  // and just use their local id directly.
  function resolveVisitor() {
    if (!userId) return Promise.resolve();
    return fetch(API_BASE + "/api/visitor/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: clientId,
        anonymousVisitorId: visitorId,
        userId: userId,
        userHash: userHash,
      }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.visitorId) visitorId = data.visitorId;
        if (data && userId && !data.identified) {
          console.warn(
            "[chat-widget] data-user-id was supplied but its data-user-hash did not " +
            "verify, so conversations stay per-device. Sign the user id with this " +
            "client's identitySecret on your server."
          );
        }
      })
      .catch(function () { /* stay on the anonymous visitor id */ });
  }

  function init() {
    Promise.all([
      resolveVisitor(),
      fetch(API_BASE + "/api/clients/" + encodeURIComponent(clientId) + "/public")
        .then(function (r) {
          if (!r.ok) throw new Error("client not found");
          return r.json();
        }),
    ])
      .then(function (results) {
        var data = results[1];
        config.botName = data.botName || config.botName;
        config.welcomeMessage = data.welcomeMessage || config.welcomeMessage;
        config.brandColor = data.brandColor || config.brandColor;
        config.avatarUrl = data.avatarUrl || "";
        config.quickReplies = Array.isArray(data.quickReplies) ? data.quickReplies : [];
        config.faqs = Array.isArray(data.faqs) ? data.faqs : [];
      })
      .catch(function () {
        // fall back to defaults; still render the widget so the site owner
        // notices something is wrong rather than the widget silently vanishing
      })
      .finally(function () {
        injectStyles(config.brandColor);
        buildUI();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

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
  var STORAGE_KEY = "chatwidget_session_" + clientId;

  // Optional: if the embedding site has its own logged-in users, it can pass
  // the user's id plus an HMAC of it (signed server-side with the client's
  // identitySecret) so that person's history follows them across devices.
  // Without these, history is anonymous and per-browser as usual.
  var userId = currentScript.getAttribute("data-user-id") || "";
  var userHash = currentScript.getAttribute("data-user-hash") || "";

  // Anonymous per-device id, used when nobody is logged in -- and kept
  // untouched while they are, so logging out returns them to their own
  // anonymous thread rather than leaking the logged-in one.
  function getAnonymousSessionId() {
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

  var sessionId = getAnonymousSessionId();
  var config = {
    botName: "Assistant",
    welcomeMessage: "Hi! How can I help?",
    brandColor: "#6366f1",
    avatarUrl: "",
    quickReplies: [],
    faqs: [],
  };

  // Who the visitor is currently talking to. Defaults to the AI bot; if the
  // server ever reports a human agent has joined (reply payload's `agent`
  // field), this swaps to their name/photo for the header and all subsequent
  // messages.
  var currentResponder = null;

  var els = {};
  var isOpen = false;
  var hasLoadedWelcome = false;

  // Everything up to this sequence number is already on screen. Polling asks
  // only for what's newer, so nothing gets rendered twice.
  var lastSeq = 0;
  var pollTimer = null;
  var sendInFlight = false;
  var POLL_INTERVAL_MS = 4000;

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
      "#cw-window{position:fixed;bottom:92px;right:20px;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 130px);background:#fff;border-radius:20px;box-shadow:0 16px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.97);pointer-events:none;transition:opacity .22s ease,transform .22s cubic-bezier(.34,1.3,.64,1)}" +
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
      /* on the menu the avatar lives in the body instead, so the header stays light */
      "#cw-window.cw-on-menu #cw-header .cw-avatar{display:none}" +

      /* view switching */
      ".cw-view{display:none;flex:1;flex-direction:column;min-height:0}" +
      ".cw-view.cw-active{display:flex}" +

      /* menu */
      "#cw-menu-list{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa}" +
      ".cw-menu-head{display:flex;align-items:center;gap:12px;padding:4px 2px 12px}" +
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

      /* faq */
      "#cw-faq-list{flex:1;overflow-y:auto;padding:14px 16px 18px;display:flex;flex-direction:column;gap:8px;background:#f7f8fa}" +
      "#cw-faq-list::-webkit-scrollbar,#cw-menu-list::-webkit-scrollbar{width:6px}" +
      "#cw-faq-list::-webkit-scrollbar-thumb,#cw-menu-list::-webkit-scrollbar-thumb{background:#d4d6dd;border-radius:3px}" +
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

      /* avatars */
      ".cw-avatar{width:38px;height:38px;border-radius:50%;flex-shrink:0;object-fit:cover;display:flex;align-items:center;justify-content:center;font-weight:650;font-size:14px;overflow:hidden;background:" + shade(brand, 0.75) + ";color:" + shade(brand, -0.35) + "}" +
      "#cw-header .cw-avatar{box-shadow:0 0 0 2px rgba(255,255,255,.35);background:rgba(255,255,255,.22);color:" + onBrand + "}" +
      ".cw-avatar-sm{width:26px;height:26px;font-size:10.5px;align-self:flex-end;margin-bottom:2px}" +

      /* messages */
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

      /* quick replies */
      "#cw-quick{display:flex;flex-wrap:wrap;gap:7px;padding:2px 0 2px 34px;animation:cw-in .3s ease}" +
      ".cw-chip{background:#fff;border:1.5px solid " + rgba(brand, 0.35) + ";color:" + shade(brand, -0.25) + ";padding:7px 13px;border-radius:16px;font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s ease;line-height:1.3}" +
      ".cw-chip:hover{background:" + rgba(brand, 0.08) + ";border-color:" + brand + ";transform:translateY(-1px)}" +
      ".cw-chip:active{transform:translateY(0)}" +

      /* typing indicator */
      ".cw-typing{background:#fff;border:1px solid #e8e9ee;border-bottom-left-radius:6px;border-radius:18px;padding:13px 16px;display:flex;gap:4px;align-items:center}" +
      ".cw-dot{width:7px;height:7px;border-radius:50%;background:#b6b9c4;animation:cw-bounce 1.3s infinite ease-in-out}" +
      ".cw-dot:nth-child(2){animation-delay:.16s}.cw-dot:nth-child(3){animation-delay:.32s}" +
      "@keyframes cw-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}" +

      /* composer */
      "#cw-inputbar{display:flex;gap:8px;padding:12px 14px;border-top:1px solid #ecedf1;flex-shrink:0;background:#fff;align-items:flex-end}" +
      "#cw-input{flex:1;border:1.5px solid #e2e4ea;border-radius:22px;padding:10px 15px;font-size:14.5px;outline:none;resize:none;max-height:96px;font-family:inherit;line-height:1.45;color:#1a1c22;transition:border-color .15s ease,box-shadow .15s ease;background:#fafbfc}" +
      "#cw-input:focus{border-color:" + brand + ";background:#fff;box-shadow:0 0 0 3px " + rgba(brand, 0.12) + "}" +
      "#cw-input::placeholder{color:#a8abb6}" +
      "#cw-send{background:linear-gradient(135deg," + brand + "," + shade(brand, -0.18) + ");border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease,opacity .15s ease}" +
      "#cw-send:hover:not(:disabled){transform:scale(1.06)}" +
      "#cw-send:disabled{opacity:.45;cursor:default}" +
      "#cw-send svg{width:17px;height:17px}" +
      "#cw-footer{text-align:center;font-size:11px;color:#b0b3bd;padding:0 0 9px;background:#fff;letter-spacing:.01em}" +

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
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  // Builds an avatar for whoever is currently answering (bot, or a human
  // agent if one has taken over). Falls back to initials when there's no
  // usable image.
  function makeAvatar(small, sender) {
    var responder = sender || currentResponder ||
      { name: config.botName, avatarUrl: config.avatarUrl };
    var cls = "cw-avatar" + (small ? " cw-avatar-sm" : "");
    if (responder.avatarUrl) {
      var img = el("img", { class: cls, src: responder.avatarUrl, alt: responder.name || "" });
      // If the image 404s or is blocked, swap in initials rather than
      // leaving a broken-image icon in the header.
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
    els.statusText.textContent = currentResponder ? "Live agent" : "Online";
    var fresh = makeAvatar(false);
    els.headerAvatar.parentNode.replaceChild(fresh, els.headerAvatar);
    els.headerAvatar = fresh;
  }

  function buildUI() {
    var root = el("div", { id: "cw-root" });

    var bubble = el("button", { id: "cw-bubble", "aria-label": "Open chat" });
    bubble.innerHTML =
      '<svg class="cw-ico-chat" viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>' +
      '<svg class="cw-ico-close" viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) + '" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"></path></svg>';

    var win = el("div", { id: "cw-window", role: "dialog", "aria-label": "Chat" });

    var backBtn = el("button", { id: "cw-back", "aria-label": "Back to menu" });
    backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="' + contrastText(config.brandColor) +
      '" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>';

    var headerAvatar = makeAvatar(false);
    var title = el("span", { id: "cw-title", text: config.botName });
    var statusDot = el("i", {});
    var statusText = el("span", { text: "Online" });
    var status = el("div", { id: "cw-status" }, [statusDot, statusText]);
    var headerInfo = el("div", { id: "cw-header-info" }, [title, status]);
    var closeBtn = el("button", { id: "cw-close", "aria-label": "Close chat", text: "✕" });
    var header = el("div", { id: "cw-header" }, [backBtn, headerAvatar, headerInfo, closeBtn]);

    // --- chat view ---
    var messages = el("div", { id: "cw-messages" });
    var input = el("textarea", { id: "cw-input", rows: "1", placeholder: "Type a message…" });
    var send = el("button", { id: "cw-send", "aria-label": "Send" });
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="' + contrastText(config.brandColor) + '"><path d="M2 21l21-9L2 3v7l15 2-15 2z"></path></svg>';
    var inputBar = el("div", { id: "cw-inputbar" }, [input, send]);
    var footer = el("div", { id: "cw-footer", text: "Powered by chatbot-ai" });
    var chatView = el("div", { class: "cw-view", "data-view": "chat" }, [messages, inputBar, footer]);

    // --- menu view (what the chat's back arrow leads to) ---
    var menuList = el("div", { id: "cw-menu-list" });
    var menuView = el("div", { class: "cw-view", "data-view": "menu" }, [menuList]);

    // --- faq view ---
    var faqList = el("div", { id: "cw-faq-list" });
    var faqView = el("div", { class: "cw-view", "data-view": "faq" }, [faqList]);

    win.appendChild(header);
    win.appendChild(chatView);
    win.appendChild(menuView);
    win.appendChild(faqView);
    root.appendChild(win);
    root.appendChild(bubble);
    document.body.appendChild(root);

    els = {
      root: root, bubble: bubble, window: win, header: header, back: backBtn,
      headerAvatar: headerAvatar, title: title, status: status, statusText: statusText,
      close: closeBtn, messages: messages, input: input, send: send,
      views: { chat: chatView, menu: menuView, faq: faqView },
      menuList: menuList, faqList: faqList,
    };

    buildMenu();
    buildFaq();
    showView("chat");

    bubble.addEventListener("click", toggleOpen);
    closeBtn.addEventListener("click", toggleOpen);
    backBtn.addEventListener("click", function () { showView("menu"); });
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

  // --- view navigation: chat <-> menu <-> faq ---------------------------
  //
  // The widget opens straight into the chat (that's the point of it). The
  // back arrow goes "up" to a menu, from which the visitor can browse FAQs
  // or drop back into the conversation -- which is still there, since views
  // are hidden rather than torn down.

  var currentView = "chat";

  var VIEW_TITLES = {
    menu: { title: "How can we help?", status: "" },
    faq: { title: "FAQs", status: "" },
  };

  function showView(name) {
    currentView = name;
    Object.keys(els.views).forEach(function (k) {
      els.views[k].classList.toggle("cw-active", k === name);
    });
    // The back arrow only makes sense when there's somewhere to go back to.
    els.root.classList.toggle("cw-has-back", name !== "menu");
    els.window.classList.toggle("cw-on-menu", name === "menu");

    if (name === "chat") {
      refreshHeaderIdentity();
      scrollToBottom();
      setTimeout(function () { els.input.focus(); }, 120);
    } else {
      var meta = VIEW_TITLES[name];
      els.title.textContent = meta.title;
      els.statusText.textContent = meta.status;
      els.status.style.display = meta.status ? "" : "none";
    }
    if (name === "chat") els.status.style.display = "";
  }

  function menuTile(icon, label, sub, onClick) {
    var iconEl = el("div", { class: "cw-tile-ico" });
    iconEl.innerHTML = icon;
    var textEl = el("div", { class: "cw-tile-text" }, [
      el("strong", { text: label }),
      el("span", { text: sub }),
    ]);
    var chevron = el("div", { class: "cw-tile-chev" });
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg>';
    var tile = el("button", { class: "cw-tile", type: "button" }, [iconEl, textEl, chevron]);
    tile.addEventListener("click", onClick);
    return tile;
  }

  function buildMenu() {
    els.menuList.innerHTML = "";
    els.menuList.appendChild(el("div", { class: "cw-menu-head" }, [
      makeAvatar(false),
      el("div", {}, [
        el("strong", { text: config.botName }),
        el("span", { text: "Typically replies in a few seconds" }),
      ]),
    ]));

    els.menuList.appendChild(menuTile(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>',
      "Chat with us",
      "Ask anything and get an instant answer",
      function () { showView("chat"); }
    ));

    if (config.faqs && config.faqs.length) {
      els.menuList.appendChild(menuTile(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
        "FAQs",
        config.faqs.length + " common question" + (config.faqs.length === 1 ? "" : "s"),
        function () { showView("faq"); }
      ));
    }
  }

  function buildFaq() {
    els.faqList.innerHTML = "";
    (config.faqs || []).forEach(function (faq) {
      var q = el("button", { class: "cw-faq-q", type: "button" }, [
        el("span", { text: faq.question }),
      ]);
      var caret = el("i", { class: "cw-faq-caret" });
      caret.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
      q.appendChild(caret);
      var a = el("div", { class: "cw-faq-a", text: faq.answer });
      var item = el("div", { class: "cw-faq-item" }, [q, a]);
      q.addEventListener("click", function () { item.classList.toggle("cw-open"); });
      els.faqList.appendChild(item);
    });

    // Always leave a route back to the bot -- the FAQ is a shortcut, not a
    // dead end, and anything not covered here is exactly what the AI is for.
    var cta = el("button", { class: "cw-faq-cta", type: "button", text: "Still need help? Ask our assistant →" });
    cta.addEventListener("click", function () { showView("chat"); });
    els.faqList.appendChild(cta);
  }

  function toggleOpen() {
    isOpen = !isOpen;
    els.window.classList.toggle("cw-open", isOpen);
    els.root.classList.toggle("cw-is-open", isOpen);
    els.bubble.setAttribute("aria-label", isOpen ? "Close chat" : "Open chat");
    if (isOpen) {
      if (!hasLoadedWelcome) {
        hasLoadedWelcome = true;
        restoreConversation();
      }
      startPolling();
      setTimeout(function () { els.input.focus(); }, 220);
    } else {
      stopPolling();
    }
  }

  // Pull anything the widget hasn't shown yet: the transcript from before a
  // page reload, and any messages a human agent has sent since.
  function fetchNewMessages() {
    var url = API_BASE + "/api/sessions/" + encodeURIComponent(sessionId) +
      "/messages?clientId=" + encodeURIComponent(clientId) + "&since=" + lastSeq;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("poll failed");
      return r.json();
    });
  }

  function applyAgent(agent) {
    var changed = agent
      ? !currentResponder || currentResponder.name !== agent.name
      : !!currentResponder;
    if (!changed) return;
    currentResponder = agent ? { name: agent.name, avatarUrl: agent.avatarUrl || "" } : null;
    refreshHeaderIdentity();
  }

  function renderIncoming(messages) {
    messages.forEach(function (m) {
      if (m.seq <= lastSeq) return;
      addMessage(m.role === "user" ? "user" : "bot", m.content, m.sender);
      lastSeq = m.seq;
    });
  }

  // On first open: if this visitor already has a conversation (they reloaded
  // the page), replay it instead of starting over with the welcome message.
  function restoreConversation() {
    fetchNewMessages()
      .then(function (data) {
        applyAgent(data.agent);
        if (data.messages && data.messages.length) {
          renderIncoming(data.messages);
        } else {
          addMessage("bot", config.welcomeMessage);
          renderQuickReplies();
        }
      })
      .catch(function () {
        addMessage("bot", config.welcomeMessage);
        renderQuickReplies();
      });
  }

  function pollOnce() {
    // Skip while a send is in flight, otherwise the poll can echo back the
    // message we've already rendered optimistically.
    if (sendInFlight) return;
    fetchNewMessages()
      .then(function (data) {
        applyAgent(data.agent);
        renderIncoming(data.messages || []);
      })
      .catch(function () { /* transient network issue; next tick retries */ });
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

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addMessage(role, text, sender) {
    var isUser = role === "user";
    var bubbleEl = el("div", {
      class: "cw-msg " + (isUser ? "cw-msg-user" : "cw-msg-bot"),
      text: text,
    });
    var row = el("div", { class: "cw-row" + (isUser ? " cw-row-user" : "") },
      isUser ? [bubbleEl] : [makeAvatar(true, sender), bubbleEl]);
    els.messages.appendChild(row);
    scrollToBottom();
  }

  function renderQuickReplies() {
    if (!config.quickReplies || !config.quickReplies.length) return;
    var wrap = el("div", { id: "cw-quick" });
    config.quickReplies.forEach(function (text) {
      var chip = el("button", { class: "cw-chip", type: "button", text: text });
      chip.addEventListener("click", function () {
        clearQuickReplies();
        submitText(text);
      });
      wrap.appendChild(chip);
    });
    els.messages.appendChild(wrap);
    scrollToBottom();
  }

  function clearQuickReplies() {
    var wrap = document.getElementById("cw-quick");
    if (wrap) wrap.remove();
  }

  function showTyping() {
    var typing = el("div", { class: "cw-typing" });
    typing.innerHTML = '<span class="cw-dot"></span><span class="cw-dot"></span><span class="cw-dot"></span>';
    var row = el("div", { class: "cw-row", id: "cw-typing-row" }, [makeAvatar(true), typing]);
    els.messages.appendChild(row);
    scrollToBottom();
  }

  function hideTyping() {
    var row = document.getElementById("cw-typing-row");
    if (row) row.remove();
  }

  function sendMessage() {
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    els.input.style.height = "auto";
    clearQuickReplies();
    submitText(text);
  }

  function submitText(text) {
    addMessage("user", text);
    els.send.disabled = true;
    sendInFlight = true;
    showTyping();

    fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId, sessionId: sessionId, message: text }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || "Request failed");
          return data;
        });
      })
      .then(function (data) {
        hideTyping();
        // Everything the server has stored for this turn is now accounted
        // for, so polling should only look past it.
        if (typeof data.seq === "number") lastSeq = Math.max(lastSeq, data.seq);

        if (data.agent && data.agent.name) applyAgent(data.agent);

        if (data.pending) {
          // A human agent owns this conversation -- there's no instant reply
          // to show. Their answer arrives via polling when they send it.
          startPolling();
          return;
        }
        addMessage("bot", data.reply);
      })
      .catch(function (err) {
        hideTyping();
        addMessage("bot", "Sorry, I ran into a problem: " + err.message);
      })
      .finally(function () {
        sendInFlight = false;
        els.send.disabled = false;
      });
  }

  // Ask the server which conversation this visitor owns. With verified
  // identity that's their cross-device thread; otherwise the anonymous one.
  function resolveSession() {
    if (!userId) return Promise.resolve();
    return fetch(API_BASE + "/api/session/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: clientId,
        sessionId: sessionId,
        userId: userId,
        userHash: userHash,
      }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.sessionId) sessionId = data.sessionId;
        if (data && userId && !data.identified) {
          console.warn(
            "[chat-widget] data-user-id was supplied but its data-user-hash did not " +
            "verify, so chat history stays per-device. Sign the user id with this " +
            "client's identitySecret on your server."
          );
        }
      })
      .catch(function () { /* stay on the anonymous session */ });
  }

  function init() {
    Promise.all([
      resolveSession(),
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

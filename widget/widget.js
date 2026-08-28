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

  function getSessionId() {
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

  var sessionId = getSessionId();
  var config = { botName: "Assistant", welcomeMessage: "Hi! How can I help?", brandColor: "#6366f1" };

  var els = {};
  var isOpen = false;
  var hasLoadedWelcome = false;

  function injectStyles(brandColor) {
    var style = document.createElement("style");
    style.textContent =
      "#cw-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}" +
      "#cw-bubble{width:60px;height:60px;border-radius:50%;background:" + brandColor + ";box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center;border:none;transition:transform .15s ease}" +
      "#cw-bubble:hover{transform:scale(1.06)}" +
      "#cw-bubble svg{width:28px;height:28px}" +
      "#cw-window{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 140px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden}" +
      "#cw-window.cw-open{display:flex}" +
      "#cw-header{background:" + brandColor + ";color:#fff;padding:16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}" +
      "#cw-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;opacity:.85}" +
      "#cw-close:hover{opacity:1}" +
      "#cw-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f7f7f9}" +
      ".cw-msg{max-width:80%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
      ".cw-msg-bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #e5e5ea;border-bottom-left-radius:4px}" +
      ".cw-msg-user{align-self:flex-end;background:" + brandColor + ";color:#fff;border-bottom-right-radius:4px}" +
      ".cw-msg-typing{align-self:flex-start;background:#fff;border:1px solid #e5e5ea;border-bottom-left-radius:4px;padding:12px 16px}" +
      ".cw-dot{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#9a9aa2;animation:cw-bounce 1.2s infinite ease-in-out}" +
      ".cw-dot:nth-child(2){animation-delay:.15s}.cw-dot:nth-child(3){animation-delay:.3s}" +
      "@keyframes cw-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}" +
      "#cw-inputbar{display:flex;gap:8px;padding:12px;border-top:1px solid #eee;flex-shrink:0;background:#fff}" +
      "#cw-input{flex:1;border:1px solid #ddd;border-radius:20px;padding:10px 14px;font-size:14px;outline:none;resize:none;max-height:80px;font-family:inherit}" +
      "#cw-input:focus{border-color:" + brandColor + "}" +
      "#cw-send{background:" + brandColor + ";border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}" +
      "#cw-send:disabled{opacity:.5;cursor:default}" +
      "#cw-footer{text-align:center;font-size:11px;color:#aaa;padding:4px 0 8px}" +
      "@media (max-width:480px){#cw-window{right:16px;bottom:88px}}";
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
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function buildUI() {
    var root = el("div", { id: "cw-root" });

    var bubble = el("button", { id: "cw-bubble", "aria-label": "Open chat" });
    bubble.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

    var win = el("div", { id: "cw-window" });
    var header = el("div", { id: "cw-header" }, [
      el("span", { id: "cw-title", text: config.botName }),
      el("button", { id: "cw-close", "aria-label": "Close chat", text: "✕" }),
    ]);
    var messages = el("div", { id: "cw-messages" });
    var inputBar = el("div", { id: "cw-inputbar" }, [
      el("textarea", { id: "cw-input", rows: "1", placeholder: "Type a message..." }),
      (function () {
        var b = el("button", { id: "cw-send", "aria-label": "Send" });
        b.innerHTML =
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="white"><path d="M2 21l21-9L2 3v7l15 2-15 2z"></path></svg>';
        return b;
      })(),
    ]);
    var footer = el("div", { id: "cw-footer", text: "Powered by chatbot-ai" });

    win.appendChild(header);
    win.appendChild(messages);
    win.appendChild(inputBar);
    win.appendChild(footer);

    root.appendChild(win);
    root.appendChild(bubble);
    document.body.appendChild(root);

    els.root = root;
    els.bubble = bubble;
    els.window = win;
    els.header = header;
    els.title = header.querySelector("#cw-title");
    els.close = header.querySelector("#cw-close");
    els.messages = messages;
    els.input = inputBar.querySelector("#cw-input");
    els.send = inputBar.querySelector("#cw-send");

    els.bubble.addEventListener("click", toggleOpen);
    els.close.addEventListener("click", toggleOpen);
    els.send.addEventListener("click", sendMessage);
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    els.input.addEventListener("input", function () {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(els.input.scrollHeight, 80) + "px";
    });
  }

  function toggleOpen() {
    isOpen = !isOpen;
    els.window.classList.toggle("cw-open", isOpen);
    if (isOpen) {
      if (!hasLoadedWelcome) {
        addMessage("bot", config.welcomeMessage);
        hasLoadedWelcome = true;
      }
      els.input.focus();
    }
  }

  function addMessage(role, text) {
    var msg = el("div", {
      class: "cw-msg " + (role === "user" ? "cw-msg-user" : "cw-msg-bot"),
      text: text,
    });
    els.messages.appendChild(msg);
    els.messages.scrollTop = els.messages.scrollHeight;
    return msg;
  }

  function showTyping() {
    var typing = el("div", { class: "cw-msg-typing", id: "cw-typing" });
    typing.innerHTML = '<span class="cw-dot"></span><span class="cw-dot"></span><span class="cw-dot"></span>';
    els.messages.appendChild(typing);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function hideTyping() {
    var typing = document.getElementById("cw-typing");
    if (typing) typing.remove();
  }

  function sendMessage() {
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    els.input.style.height = "auto";
    addMessage("user", text);
    els.send.disabled = true;
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
        addMessage("bot", data.reply);
      })
      .catch(function (err) {
        hideTyping();
        addMessage("bot", "Sorry, I ran into a problem: " + err.message);
      })
      .finally(function () {
        els.send.disabled = false;
      });
  }

  function init() {
    fetch(API_BASE + "/api/clients/" + encodeURIComponent(clientId) + "/public")
      .then(function (r) {
        if (!r.ok) throw new Error("client not found");
        return r.json();
      })
      .then(function (data) {
        config.botName = data.botName || config.botName;
        config.welcomeMessage = data.welcomeMessage || config.welcomeMessage;
        config.brandColor = data.brandColor || config.brandColor;
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

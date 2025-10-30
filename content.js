// content.js — Lógica del bot (sin UI). Requiere ui.js cargado antes.
// FIX 2025-10-29 (v2.1 UI-split): Fallback por sondeo + Observer agresivo. UI delegada a window.VZUI.

(() => {
  "use strict";

  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 1200,
    CLICK_COOLDOWN_MS: 8000,
    REPLY_COOLDOWN_MS: 12000,
    OPEN_UNREAD: true,
    THREAD_LOAD_SILENCE_MS: 600,
    SEND_COOLDOWN_MS: 1200,
    DEFAULT_FALLBACK: "",
    DEBUG: true
  };

  const DEFAULT_RULES = [
    { pattern: "\\b(soy|me llamo)\\s+([a-záéíóúñ]+)\\b", flags: "i", reply: "¡Mucho gusto! 😊 ¿En qué te ayudo?" },
    { pattern: "precio|valor|cu[aá]nto cuesta|costo", flags: "i", reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" },
    { pattern: "(?:\\b|\\s)(horario|hora|atienden)(?:\\b|\\s)", flags: "i", reply: "Horario de atención:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" },
    { pattern: "env[ií]o|entrega|domicilio", flags: "i", reply: "¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizar?" },
    { pattern: "^hola\\b|buen[oa]s|saludos", flags: "i", reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte." }
  ];

  const k = {
    rules: "__vz_rules_json",
    byThread: (tid, name) => `__vz_thread_${tid}_${name}`
  };

  const S = {
    async get(key, fallback = null) {
      try {
        if (chrome?.storage?.local) {
          const out = await chrome.storage.local.get(key);
          return out?.[key] ?? fallback;
        }
      } catch {}
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        const raw = localStorage.getItem(key);
        return raw ?? fallback;
      }
    },
    async set(key, val) {
      try {
        if (chrome?.storage?.local) {
          await chrome.storage.local.set({ [key]: val });
          return;
        }
      } catch {}
      localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
    }
  };

  const log = (...a) => CFG.DEBUG && console.log("[VZ-Bot]", ...a);
  const now = () => Date.now();
  const Q  = (sel, r=document) => r.querySelector(sel);
  const QA = (sel, r=document) => Array.from(r.querySelectorAll(sel));
  const isVisible = (el) => !!(el && el.isConnected && el.offsetParent);

  let enabled = CFG.AUTO_START;
  let lastClickAt = 0;
  let scanTimer = null;
  let msgObserver = null;
  let rules = null;

  let currentTid = null;
  let threadSilenceUntil = 0;

  const inFlight = new Set();
  const newIncomingFlag = new Map();
  const lastBubbleHashMem = new Map();
  const sendCooldownUntil = new Map();

  let pendingAutoOpenTid = null;

  const getCurrentThreadIdFromURL = () => {
    const m = location.pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? m[1] : null;
  };

  const djb2 = (s) => {
    s = String(s);
    let h = 5381;
    for (let i=0;i<s.length;i++) h = ((h<<5)+h) + s.charCodeAt(i);
    return String(h >>> 0);
  };

  const normalize = (s) => String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

  const OUT_HINTS = ["you sent","has enviado","enviaste","tú:","tu:","usted:","you:"];

  const isOutHint = (textOrAria) => {
    const n = normalize(textOrAria);
    return OUT_HINTS.some(h => n.startsWith(h) || n.includes(` ${h} `));
  };

  const getThreadLinks = () => QA('a[href^="/e2ee/t/"], a[href^="/t/"]');
  const getThreadIdFromHref = (href) => href?.match?.(/\/(?:e2ee\/)?t\/([^/?#]+)/)?.[1] || null;

  const looksUnread = (row) => {
    if (!row) return false;
    if (row.querySelector('[data-testid*="unread"]')) return true;
    if (/no\s*le[ií]d[oa]s?|nuevo|unread/i.test(row.textContent || "")) return true;
    for (const n of row.querySelectorAll("span,div")) {
      const fw = parseInt(getComputedStyle(n).fontWeight || "400", 10);
      if (fw >= 600) return true;
    }
    return false;
  };

  const findUnread = () => {
    const unread = [];
    for (const a of getThreadLinks()) {
      const row = a.closest('[role="row"], li, [data-visualcompletion]') || a.parentElement;
      if (row && looksUnread(row)) unread.push(a);
    }
    return unread;
  };

  const clickUnreadDividerIfAny = () => {
    const KEYS = [
      "mensajes no leidos","mensajes no leídos","ver mensajes no leidos","ver mensajes no leídos",
      "nuevos mensajes","new messages","unread messages"
    ].map(normalize);

    for (const el of QA("div,span,button,a")) {
      if (!isVisible(el)) continue;
      const t = normalize(el.innerText || el.textContent || "");
      if (KEYS.some(k => t.includes(k))) {
        try { el.scrollIntoView({ block: "center" }); el.click(); return true; } catch {}
      }
    }
    return false;
  };

  const findComposer = () => {
    const sel = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[aria-label*="Mensaje"]',
      'div[aria-label*="Message"]'
    ].join(",");
    const boxes = QA(sel).filter(isVisible);
    if (!boxes.length) return null;
    return boxes.reduce((a, b) => (a.getBoundingClientRect().top > b.getBoundingClientRect().top ? a : b));
  };

  const emitEnter = (el) => {
    const base = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", which: 13, keyCode: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  };

  const shiftEnter = (el) => {
    const base = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", which: 13, keyCode: 13, shiftKey: true };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  };

  const pasteMultiline = (el, text) => {
    const parts = String(text).replace(/\r\n?/g, "\n").split("\n");
    try { el.focus(); } catch {}
    parts.forEach((t, i) => {
      if (t) {
        const ok = document.execCommand("insertText", false, t);
        if (!ok) el.textContent = (el.textContent || "") + t;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (i < parts.length - 1) shiftEnter(el);
    });
  };

  const realClick = (el) => {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
    } catch { try { el?.click(); } catch {} }
  };

  const getLastBubbleInfo = () => {
    const selector = [
      '[role="grid"] [role="row"]',
      '[data-testid*="message-container"]',
      '[data-testid*="message"]'
    ].join(",");
    const bubbles = QA(selector, document.body).filter(isVisible);
    const count = bubbles.length;

    for (let i = count - 1; i >= 0; i--) {
      const b = bubbles[i];
      const nodes = QA(
        'div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p',
        b
      );
      let text = nodes.map(n => (n.innerText || n.textContent || "").trim())
                      .filter(Boolean)
                      .join("\n")
                      .replace(/\s+\n/g, "\n")
                      .replace(/\n\s+/g, "\n")
                      .replace(/[ \t]+/g, " ")
                      .trim();

      if (!text) continue;

      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const aria   = (b.getAttribute("aria-label") || "").toLowerCase();

      if (isOutHint(text) || isOutHint(aria)) {
        const hash = djb2(`out|${text}|#${count}`);
        return { text, dir: "out", count, hash };
      }

      let dir = null;
      if (/incoming/.test(testid)) dir = "in";
      else if (/outgoing/.test(testid)) dir = "out";

      if (!dir) {
        if (/\b(you|tú|vos|usted)\b/.test(aria)) dir = "out";
        else if (aria) dir = "in";
      }

      if (!dir) {
        const rect = b.getBoundingClientRect();
        const mid = (window.innerWidth || document.documentElement.clientWidth) * 0.5;
        dir = rect.left > mid ? "out" : "in";
      }

      const hash = djb2(`${dir}|${text}|#${count}`);
      return { text, dir, count, hash };
    }
    return { text: "", dir: "in", count: 0, hash: "0" };
  };

  const compile = (r) => { try { return { re: new RegExp(r.pattern, r.flags || "i"), reply: r.reply }; } catch { return null; } };
  const getCompiledRules = () => (Array.isArray(rules) ? rules : []).map(compile).filter(Boolean);

  const lastReplyAtKey      = (tid) => k.byThread(tid, "last_reply_at");
  const lastSentHashKey     = (tid) => k.byThread(tid, "last_sent_hash");
  const lastIncomingHashKey = (tid) => k.byThread(tid, "last_in_hash");
  const baselineHashKey     = (tid) => k.byThread(tid, "baseline_hash");

  const sendText = async (tid, text) => {
    if (!text) return false;
    const composer = findComposer();
    if (!composer) return false;
    sendCooldownUntil.set(tid, now() + CFG.SEND_COOLDOWN_MS);
    pasteMultiline(composer, text);
    setTimeout(() => emitEnter(composer), 30);
    return true;
  };

  const maybeReplyByRules = async (tid) => {
    if (!tid) return false;
    if (!newIncomingFlag.get(tid)) return false;
    if (now() < threadSilenceUntil) return false;
    if (now() < (sendCooldownUntil.get(tid) || 0)) return false;

    if (inFlight.has(tid)) return false;
    inFlight.add(tid);

    try {
      const lastAt = Number(await S.get(lastReplyAtKey(tid), 0));
      if (now() - lastAt < CFG.REPLY_COOLDOWN_MS) { newIncomingFlag.set(tid, false); return false; }

      const { text, dir, hash } = getLastBubbleInfo();
      if (!text || dir !== "in") { newIncomingFlag.set(tid, false); return false; }

      const lastIn = await S.get(lastIncomingHashKey(tid), "");
      if (String(lastIn) === String(hash)) { newIncomingFlag.set(tid, false); return false; }

      const compiled = getCompiledRules();
      let reply = null;
      for (const { re, reply: rep } of compiled) {
        if (re.test(text)) { reply = rep; break; }
      }

      if (!reply) {
        await S.set(lastIncomingHashKey(tid), hash);
        newIncomingFlag.set(tid, false);
        return false;
      }

      const lastSent = await S.get(lastSentHashKey(tid), "");
      const thisHash = djb2(reply);
      if (String(lastSent) === String(thisHash)) {
        await S.set(lastIncomingHashKey(tid), hash);
        newIncomingFlag.set(tid, false);
        return false;
      }

      const ok = await sendText(tid, reply);
      if (ok) {
        const ts = now();
        await S.set(lastReplyAtKey(tid), ts);
        await S.set(lastIncomingHashKey(tid), hash);
        await S.set(lastSentHashKey(tid), thisHash);
        lastBubbleHashMem.set(tid, djb2(`out|${reply}|#${ts}`));
        log("[rules] respuesta enviada");
      }

      newIncomingFlag.set(tid, false);
      return !!ok;
    } finally {
      inFlight.delete(tid);
    }
  };

  const getBaselineHash = () => {
    const { dir, text, count } = getLastBubbleInfo();
    return djb2(`${dir}|${text}|#${count}`);
  };

  const onThreadChanged = async (newTid) => {
    const tid = newTid || "unknown";
    currentTid = tid;
    newIncomingFlag.set(tid, false);
    threadSilenceUntil = now() + CFG.THREAD_LOAD_SILENCE_MS;

    const base = getBaselineHash();

    if (pendingAutoOpenTid && pendingAutoOpenTid === tid) {
      await S.set(baselineHashKey(tid), base);
      setTimeout(() => {
        newIncomingFlag.set(tid, true);
        maybeReplyByRules(tid);
      }, CFG.THREAD_LOAD_SILENCE_MS + 50);

      log("[thread] abierto por NO LEÍDO → procesar último entrante", tid, " baseline:", base);
      pendingAutoOpenTid = null;
    } else {
      lastBubbleHashMem.set(tid, base);
      await S.set(baselineHashKey(tid), base);
      await S.set(lastIncomingHashKey(tid), base);
      log("[thread] cambiado a", tid, " baseline:", base);
    }
  };

  const watchURL = () => {
    let lastPath = location.pathname;
    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        const tid = getCurrentThreadIdFromURL() || "unknown";
        onThreadChanged(tid);
      }
    };
    setInterval(check, 300);
  };

  const processCurrentChat = async () => {
    const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";
    await maybeReplyByRules(tid);
  };

  const tick = async () => {
    if (!enabled) return;

    const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";

    // === FALLBACK POR SONDEO ===
    if (now() >= (sendCooldownUntil.get(tid) || 0) && now() >= threadSilenceUntil) {
      const { text, dir, hash } = getLastBubbleInfo();
      if (text && dir === "in") {
        const lastMem = lastBubbleHashMem.get(tid) || "";
        if (lastMem !== hash) {
          lastBubbleHashMem.set(tid, hash);
          newIncomingFlag.set(tid, true);
        }
      }
    }

    await processCurrentChat();

    if (CFG.OPEN_UNREAD && now() - lastClickAt > CFG.CLICK_COOLDOWN_MS) {
      const links = findUnread();
      if (links.length) {
        const candidate = links.find(a => getThreadIdFromHref(a.getAttribute("href")) !== currentTid) || links[0];
        if (candidate) {
          const hrefTid = getThreadIdFromHref(candidate.getAttribute("href"));
          pendingAutoOpenTid = hrefTid || null;
          lastClickAt = now();
          realClick(candidate);
          setTimeout(() => { clickUnreadDividerIfAny(); }, 200);
        }
      }
    }
  };

  const getMessagesRoot = () => {
    return (
      Q('[role="grid"]') ||
      Q('[data-testid="mwthreadlist"]') ||
      Q('[data-pagelet*="Pagelet"]') ||
      document.body
    );
  };

  const bootMsgObserver = () => {
    if (msgObserver) return;

    const root = getMessagesRoot();

    let moQueued = false;
    msgObserver = new MutationObserver(() => {
      if (moQueued) return;
      moQueued = true;

      setTimeout(async () => {
        moQueued = false;
        if (!enabled) return;
        if (now() < threadSilenceUntil) return;

        const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";
        if (now() < (sendCooldownUntil.get(tid) || 0)) return;

        const { text, dir, hash } = getLastBubbleInfo();
        if (!text || dir !== "in") return;

        const lastMem = lastBubbleHashMem.get(tid) || "";
        if (lastMem === hash) return;

        lastBubbleHashMem.set(tid, hash);
        newIncomingFlag.set(tid, true);
        await processCurrentChat();
      }, 80);
    });

    const opts = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "class", "dir"]
    };

    msgObserver.observe(root, opts);
    if (root !== document.body) msgObserver.observe(document.body, opts);
  };

  // ==== UI BINDINGS (usa window.VZUI de ui.js) ====
  const loadRulesJson = async () => {
    let raw = await S.get(k.rules, null);
    if (!raw) raw = JSON.stringify(DEFAULT_RULES, null, 2);
    return raw;
  };
  const saveRulesJson = async (raw) => {
    rules = JSON.parse(raw);
    await S.set(k.rules, JSON.stringify(rules, null, 2));
    console.log("[VZ-Bot] Reglas guardadas");
  };

  const bindUI = () => {
    if (!window.VZUI) return console.warn("VZUI no encontrado. Asegúrate de cargar ui.js antes que content.js.");

    window.VZUI.injectTopBar({
      getEnabled: () => enabled,
      setEnabled: (v) => { enabled = !!v; },
      onOpenRules: () => window.VZUI.openRulesModal({
        loadRules: () => loadRulesJson(),
        saveRules: (raw) => saveRulesJson(raw)
      })
    });
  };

  // ==== INIT ====
  const init = async () => {
    try {
      const r = await S.get(k.rules, null);
      rules = r ? JSON.parse(r) : DEFAULT_RULES.slice();
    } catch { rules = DEFAULT_RULES.slice(); }

    bindUI();
    bootMsgObserver();
    watchURL();

    await onThreadChanged(getCurrentThreadIdFromURL());

    if (!scanTimer) scanTimer = setInterval(tick, CFG.SCAN_EVERY_MS);
    log("Bot listo (responde SOLO a entrantes NUEVOS). Hilo:", currentTid);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => CFG.AUTO_START && init(), { once: true });
  } else {
    CFG.AUTO_START && init();
  }

  // ==== API debug ====
  window.__vzBot = {
    on: () => { enabled = true; },
    off: () => { enabled = false; },
    tick,
    async rules() { return rules; },
    async setRules(arr) {
      if (!Array.isArray(arr)) throw new Error("setRules espera array");
      rules = arr;
      await S.set(k.rules, JSON.stringify(arr, null, 2));
    }
  };
})();

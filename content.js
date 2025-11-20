// content.js — Bot con COLA FIFO y anti-roaming (solo navega si hay item en cola)
// v2.5 — 2025-11-02

(() => {
  "use strict";

  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 900,
    REPLY_COOLDOWN_MS: 12000,
    THREAD_LOAD_SILENCE_MS: 650,
    SEND_COOLDOWN_MS: 1400,
    DEFAULT_FALLBACK: "",
    DEBUG: true,
    STUCK_REHOOK_MS: 8000,
    QUEUE_RETRY_MS: 800,
    OPEN_RETRY_MS: 700,
    MAX_OPEN_TRIES: 12,

    // 🔒 Anti-roaming: no recorrer chats automáticamente
    AUTO_NAVIGATE_ON_UNREAD: false,  // nunca abrir "no leídos" en tick
  };

  const DEFAULT_RULES = [
    { pattern: "\\b(soy|me llamo)\\s+([a-záéíóúñ]+)\\b", flags: "i", reply: "¡Mucho gusto! 😊 ¿En qué te ayudo?" },
    { pattern: "precio|valor|cu[aá]nto cuesta|costo", flags: "i", reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" },
    { pattern: "(?:\\b|\\s)(horario|hora|atienden)(?:\\b|\\s)", flags: "i", reply: "Horario de atención:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" },
    { pattern: "env[ií]o|entrega|domicilio", flags: "i", reply: "¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizar?" },
    { pattern: "^(hola|buen[oa]s|saludos)\\b", flags: "i", reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte." }
  ];

  /* ===== Utils ===== */
  const log = (...a) => CFG.DEBUG && console.log("[VZ-Bot]", ...a);
  const now = () => Date.now();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const Q  = (sel, r=document) => r.querySelector(sel);
  const QA = (sel, r=document) => Array.from(r.querySelectorAll(sel));
  const isVisible = (el) => !!(el && el.isConnected && el.offsetParent);
  const djb2 = (s) => { s = String(s); let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h)+s.charCodeAt(i); return String(h>>>0); };
  const normalize = (s) => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().trim();

  const OUT_HINTS = ["you sent","has enviado","enviaste","enviado por ti","tú:","tu:","usted:","you:","te:","yo:"];
  const isOutHint = (textOrAria) => {
    const n = normalize(textOrAria);
    return OUT_HINTS.some(h => n.startsWith(h) || n.includes(` ${h} `));
  };
  const isLikelySystem = (t) => {
    const n = normalize(t);
    return n.length < 1 || /\b(visto|missed call|llamada perdida|you reacted|reaccionaste|added|\bagreg[oó]\b|left|sal[ií]o)\b/.test(n);
  };

  /* ===== Storage ===== */
  const k = { rules: "__vz_rules_json", byThread: (tid, name) => `__vz_thread_${tid}_${name}` };
  const S = {
    async get(key, fallback=null){ try{ if(chrome?.storage?.local){ const out=await chrome.storage.local.get(key); return out?.[key] ?? fallback; } }catch{}
      try{ const raw=localStorage.getItem(key); return raw===null?fallback:JSON.parse(raw); }catch{ const raw=localStorage.getItem(key); return raw ?? fallback; } },
    async set(key,val){ try{ if(chrome?.storage?.local){ await chrome.storage.local.set({[key]:val}); return; } }catch{} localStorage.setItem(key, typeof val==="string"? val: JSON.stringify(val)); }
  };

  /* ===== Estado ===== */
  let enabled = CFG.AUTO_START;
  let rules = null;
  let compiledRules = [];
  let scanTimer = null;

  let currentTid = null;
  let threadSilenceUntil = 0;
  let msgObserver = null, lastMutationAt = 0, observedRoot = null;
  let pendingAutoOpenTid = null;

  const inFlightPerThread = new Set();
  const lastBubbleHashMem = new Map(); // tid -> último hash local
  const sendCooldownUntil = new Map(); // tid -> ts

  // Cola global: items { tid, enqueuedAt, tries }
  const queue = [];
  let processing = false;

  // Unread watcher (delta): record de “no leído” previo para no re-encolar
  const unreadSeen = new Set();

  // 🆕 Flag global: hasta cuándo consideramos que el operador está tecleando
  let operatorTypingUntil = 0;
  let lastComposerEl = null;

  /* ===== Messenger helpers ===== */
  const MSG_ROW_SELECTORS = [
    '[role="grid"] [role="row"]',
    '[data-testid*="message-container"]',
    '[data-testid*="message"]'
  ];
  const getCurrentThreadIdFromURL = () => {
    const m = location.pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? m[1] : null;
  };
  const getThreadLinks = () => QA('a[href^="/e2ee/t/"], a[href^="/t/"]');
  const getThreadIdFromHref = (href) => href?.match?.(/\/(?:e2ee\/)?t\/([^/?#]+)/)?.[1] || null;

  const looksUnreadRow = (row) => {
    if (!row) return false;
    if (row.querySelector('[data-testid*="unread"]')) return true;
    if (/no\s*le[ií]d[oa]s?|nuevo|unread/i.test(row.textContent || "")) return true;
    for (const n of row.querySelectorAll("span,div")) {
      const fw = parseInt(getComputedStyle(n).fontWeight || "400", 10);
      if (fw >= 600) return true;
    }
    return false;
  };

  const listUnreadTidsFromSidebar = () => {
    const unread = [];
    for (const a of getThreadLinks()) {
      const row = a.closest('[role="row"], li, [data-visualcompletion]') || a.parentElement;
      if (row && looksUnreadRow(row)) {
        const tid = getThreadIdFromHref(a.getAttribute("href"));
        if (tid) unread.push(tid);
      }
    }
    return unread;
  };

  const clickUnreadDividerIfAny = () => {
    const KEYS = ["mensajes no leidos","mensajes no leídos","ver mensajes no leidos","ver mensajes no leídos","nuevos mensajes","new messages","unread messages"].map(normalize);
    for (const el of QA("div,span,button,a")) {
      if (!isVisible(el)) continue;
      const t = normalize(el.innerText || el.textContent || "");
      if (KEYS.some(k => t.includes(k))) { try { el.scrollIntoView({ block: "center" }); el.click(); return true; } catch {} }
    }
    return false;
  };

  const openThreadById = (tid) => {
    const link = getThreadLinks().find(a => getThreadIdFromHref(a.getAttribute("href")) === tid);
    if (!link) return false;
    try { link.scrollIntoView({ block: "center", inline: "center" }); link.click(); } catch { try { link?.click(); } catch {} }
    pendingAutoOpenTid = tid;
    setTimeout(() => clickUnreadDividerIfAny(), 200);
    return true;
  };

  /* ===== Composer / envío ===== */
  const findComposer = () => {
    const sel = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[aria-label*="Mensaje"]',
      'div[aria-label*="Message"]'
    ].join(",");
    const boxes = QA(sel).filter(isVisible);
    if (!boxes.length) return null;
    const composer = boxes.reduce((a,b)=> (a.getBoundingClientRect().top > b.getBoundingClientRect().top ? a : b));

    // 🆕 Hook para detectar que el operador está tecleando
    if (composer && composer !== lastComposerEl) {
      lastComposerEl = composer;
      try {
        composer.addEventListener("keydown", () => {
          operatorTypingUntil = now() + 5000; // 5s de margen desde la última tecla
        }, { capture: true });
      } catch {}
    }

    return composer;
  };

  const emitEnter = (el) => {
    const base = { bubbles:true, cancelable:true, key:"Enter", code:"Enter", which:13, keyCode:13 };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  };
  const shiftEnter = (el) => {
    const base = { bubbles:true, cancelable:true, key:"Enter", code:"Enter", which:13, keyCode:13, shiftKey:true };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  };
  const pasteMultiline = (el, text) => {
    const parts = String(text).replace(/\r\n?/g,"\n").split("\n");
    try{ el.focus(); }catch{}
    parts.forEach((t,i)=>{ if(t){ const ok=document.execCommand("insertText", false, t); if(!ok) el.textContent=(el.textContent||"")+t;
      el.dispatchEvent(new InputEvent("input",{bubbles:true,cancelable:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
      if(i<parts.length-1) shiftEnter(el); });
  };
  const sendText = async (tid, text) => {
    if (!text) return false;
    const composer = findComposer(); if (!composer) return false;
    sendCooldownUntil.set(tid, now()+CFG.SEND_COOLDOWN_MS);
    pasteMultiline(composer, text);
    setTimeout(()=>emitEnter(composer), 30);
    return true;
  };

  /* ===== Última burbuja ===== */
  const getLastBubbleInfo = () => {
    const bubbles = QA(MSG_ROW_SELECTORS.join(","), document.body).filter(isVisible);
    const count = bubbles.length;
    for (let i = count - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (/\b(reaction|sticker|emoji|system)\b/i.test(b.getAttribute("data-testid") || "")) continue;

      const nodes = QA(
        'div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p',
        b
      );
      let text = nodes
        .map(n => (n.innerText || n.textContent || "").trim())
        .filter(Boolean)
        .join("\n")
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();

      if (!text) continue;

      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const msgId = b.getAttribute("data-message-id") || b.id || i;

      // 1) pistas fuertes de mensaje propio (out)
      if (isOutHint(text) || isOutHint(aria)) {
        const hash = djb2(`out|${text}|#${count}|${msgId}`);
        return { text, dir: "out", count, hash };
      }

      // 2) testid de la plataforma
      let dir = null;
      if (/incoming/.test(testid)) dir = "in";
      else if (/outgoing/.test(testid)) dir = "out";

      // 3) NO asumir "in" solo por tener aria.
      //    Solo marcamos "out" si el aria suena claramente a mensaje propio.
      if (!dir && aria) {
        if (/(you sent|has enviado|enviaste|mensaje enviado|enviado por ti)/.test(aria)) {
          dir = "out";
        }
      }

      // 4) fallback geométrico: derecha = out, izquierda = in
      if (!dir) {
        const rect = b.getBoundingClientRect();
        const mid = (window.innerWidth || document.documentElement.clientWidth) * 0.5;
        dir = rect.left > mid ? "out" : "in";
      }

      const hash = djb2(`${dir}|${text}|#${count}|${msgId}`);
      return { text, dir, count, hash };
    }
    return { text: "", dir: "in", count: 0, hash: "0" };
  };


  /* ===== Reglas ===== */
  const compileRule = (r)=>{ try{ return { re:new RegExp(r.pattern, r.flags||"i"), reply:r.reply }; }catch{ return null; } };
  const compileAll = (arr)=>(Array.isArray(arr)?arr:[]).map(compileRule).filter(Boolean);

  /* ===== Per-thread keys ===== */
  const lastReplyAtKey      = (tid)=> k.byThread(tid,"last_reply_at");
  const lastSentHashKey     = (tid)=> k.byThread(tid,"last_sent_hash");
  const lastIncomingHashKey = (tid)=> k.byThread(tid,"last_in_hash");
  const baselineHashKey     = (tid)=> k.byThread(tid,"baseline_hash");

  /* ===== Cola ===== */
  const enqueueTidOnce = (tid) => {
    // Evita duplicados: solo encola si NO estaba marcado como "no leído" antes
    if (unreadSeen.has(tid)) return;
    unreadSeen.add(tid);
    queue.push({ tid, enqueuedAt: now(), tries: 0 });
    log("[queue] +tid", tid, "len:", queue.length);
    processQueueSoon();
  };

  const processQueueSoon = () => { if (!processing) setTimeout(processQueue, 20); };

  const replyForThread = async (tid) => {
    // Cooldown por hilo
    const lastAt = Number(await S.get(lastReplyAtKey(tid), 0));
    if (now() - lastAt < CFG.REPLY_COOLDOWN_MS) {
      return { done: false, wait: CFG.REPLY_COOLDOWN_MS - (now() - lastAt) };
    }

    // Asegura estar en el hilo objetivo
    if ((getCurrentThreadIdFromURL() || "unknown") !== tid) {
      let tries = 0;
      while (tries < CFG.MAX_OPEN_TRIES) {
        const ok = openThreadById(tid);
        if (!ok) return { done: false, wait: CFG.OPEN_RETRY_MS };
        await sleep(CFG.OPEN_RETRY_MS);
        if ((getCurrentThreadIdFromURL() || "unknown") === tid) break;
        tries++;
      }
      return { done: false, wait: CFG.THREAD_LOAD_SILENCE_MS + 80 };
    }

    if (now() < threadSilenceUntil) return { done: false, wait: threadSilenceUntil - now() };
    if (now() < (sendCooldownUntil.get(tid) || 0)) {
      return { done: false, wait: (sendCooldownUntil.get(tid) || 0) - now() };
    }

    // Tomar último IN visible
    const { text, dir, hash } = getLastBubbleInfo();
    if (!text || dir !== "in" || isLikelySystem(text)) {
      return { done: false, wait: 300 };
    }

    // ¿ya atendido?
    const lastIn = await S.get(lastIncomingHashKey(tid), "");
    if (String(lastIn) === String(hash)) return { done: true };

    // 🆕 Si el operador ha estado tecleando hace poco, NO auto-responder
    if (now() < operatorTypingUntil) {
      await S.set(lastIncomingHashKey(tid), hash);
      log("[reply] operador escribiendo (flag keydown), no auto-responder", tid);
      return { done: true };
    }

    // Reglas
    let reply = null;
    for (const { re, reply: rep } of compiledRules) {
      if (re.test(text)) {
        reply = rep;
        break;
      }
    }
    if (!reply && CFG.DEFAULT_FALLBACK) reply = CFG.DEFAULT_FALLBACK;

    if (!reply) {
      await S.set(lastIncomingHashKey(tid), hash);
      return { done: true };
    }

    const lastSent = await S.get(lastSentHashKey(tid), "");
    const thisHash = djb2(reply);
    if (String(lastSent) === String(thisHash)) {
      await S.set(lastIncomingHashKey(tid), hash);
      return { done: true };
    }

    const ok = await sendText(tid, reply);
    if (ok) {
      const ts = now();
      await S.set(lastReplyAtKey(tid), ts);
      await S.set(lastIncomingHashKey(tid), hash);
      await S.set(lastSentHashKey(tid), thisHash);
      lastBubbleHashMem.set(tid, djb2(`out|${reply}|#${ts}`));
      log("[reply] enviado", tid);
      return { done: true };
    }
    return { done: false, wait: 400 };
  };


  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (enabled && queue.length) {
        const item = queue[0];
        const tid = item.tid;

        if (inFlightPerThread.has(tid)) { await sleep(CFG.QUEUE_RETRY_MS); continue; }
        inFlightPerThread.add(tid);

        let res;
        try { res = await replyForThread(tid); }
        finally { inFlightPerThread.delete(tid); }

        if (res?.done) { queue.shift(); continue; }

        item.tries += 1;
        await sleep(Math.max(CFG.QUEUE_RETRY_MS, res?.wait || 400));
      }
    } finally { processing = false; }
  };

  /* ===== Detección de entrantes (observer + fallback activo) ===== */
  const onNewIncomingInActiveChat = async () => {
    const tid = getCurrentThreadIdFromURL() || "unknown";
    const { text, dir, hash } = getLastBubbleInfo();
    if (!text || dir !== "in" || isLikelySystem(text)) return;

    const lastIn = await S.get(lastIncomingHashKey(tid), "");
    const lastMem = lastBubbleHashMem.get(tid) || "";

    if (hash === lastMem || String(lastIn) === String(hash)) return; // ya visto/atendido
    lastBubbleHashMem.set(tid, hash);

    // Importante: no navegamos; solo encolamos TID (anti-roaming)
    enqueueTidOnce(tid);
  };

  const getMessagesRoot = () => (
    Q('[role="grid"]') || Q('[data-testid="mwthreadlist"]') || Q('[data-pagelet*="Pagelet"]') || document.body
  );

  const attachObserver = () => {
    detachObserver();
    const root = getMessagesRoot();
    observedRoot = root;

    let moQueued = false;
    msgObserver = new MutationObserver(() => {
      lastMutationAt = now();
      if (moQueued) return;
      moQueued = true;

      setTimeout(async () => {
        moQueued = false;
        if (!enabled) return;
        if (now() < threadSilenceUntil) return;

        await onNewIncomingInActiveChat();
      }, 70);
    });

    const opts = { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:["aria-label","data-testid","class","dir"] };
    msgObserver.observe(root, opts);
    if (root !== document.body) msgObserver.observe(document.body, opts);
    lastMutationAt = now();
    log("[observer] enganchado");
  };

  const detachObserver = () => { try{ msgObserver?.disconnect(); }catch{} msgObserver=null; observedRoot=null; };

  const watchdogObserver = () => {
    setInterval(() => {
      const root = getMessagesRoot();
      if (root && root !== observedRoot) { log("[observer] root cambió → rehook"); attachObserver(); return; }
      if (now() - lastMutationAt > CFG.STUCK_REHOOK_MS) { log("[observer] sin mutaciones → rehook"); attachObserver(); }
    }, Math.max(1500, CFG.SCAN_EVERY_MS * 2));
  };

  /* ===== Cambio de hilo / URL ===== */
  const getBaselineHash = () => { const { dir, text, count } = getLastBubbleInfo(); return djb2(`${dir}|${text}|#${count}`); };

  const onThreadChanged = async (newTid) => {
    const tid = newTid || "unknown";
    currentTid = tid;
    threadSilenceUntil = now() + CFG.THREAD_LOAD_SILENCE_MS;
    const base = getBaselineHash();

    if (pendingAutoOpenTid && pendingAutoOpenTid === tid) {
      await S.set(baselineHashKey(tid), base);
      setTimeout(() => { processQueueSoon(); }, CFG.THREAD_LOAD_SILENCE_MS + 60);
      log("[thread] abierto (auto)", tid, "baseline:", base);
      pendingAutoOpenTid = null;
    } else {
      lastBubbleHashMem.set(tid, base);
      await S.set(baselineHashKey(tid), base);
      await S.set(lastIncomingHashKey(tid), base);
      log("[thread] cambiado a", tid, "baseline:", base);
    }
  };

  const watchURL = () => {
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        const tid = getCurrentThreadIdFromURL() || "unknown";
        onThreadChanged(tid);
      }
    }, 300);
  };

  /* ===== Loop principal ===== */
  const tick = async () => {
    if (!enabled) return;

    // 1) Fallback: si estás en un chat y entra algo, encola TID (no navegamos)
    await onNewIncomingInActiveChat();

    // 2) Watcher delta de “no leídos”: solo encola TID cuando aparecen nuevos no leídos
    const unreadTids = listUnreadTidsFromSidebar();
    // marca nuevos (delta)
    for (const tid of unreadTids) {
      if (!unreadSeen.has(tid)) enqueueTidOnce(tid);
    }
    // limpia los que ya no están no leídos
    for (const tid of [...unreadSeen]) {
      if (!unreadTids.includes(tid)) unreadSeen.delete(tid);
    }

    // 3) Procesar cola
    if (queue.length && !processing) processQueueSoon();

    // 4) Anti-roaming: NO abrir no leídos automáticamente
    if (CFG.AUTO_NAVIGATE_ON_UNREAD === true && !queue.length && unreadTids.length) {
      // openThreadById(unreadTids[0]); // ← Desactivado por defecto
    }
  };

  /* ===== UI (opcional) ===== */
  const loadRulesJson = async () => { let raw = await S.get(k.rules, null); if (!raw) raw = JSON.stringify(DEFAULT_RULES, null, 2); return raw; };
  const saveRulesJson = async (raw) => { rules = JSON.parse(raw); compiledRules = compileAll(rules); await S.set(k.rules, JSON.stringify(rules, null, 2)); log("[rules] guardadas/recompiladas"); };
  const bindUI = () => {
    if (!window.VZUI) return;
    window.VZUI.injectTopBar({
      getEnabled: () => enabled,
      setEnabled: (v) => { enabled = !!v; },
      onOpenRules: () => window.VZUI.openRulesModal({ loadRules: () => loadRulesJson(), saveRules: (raw) => saveRulesJson(raw) })
    });
  };

  /* ===== Init ===== */
  const init = async () => {
    try { const r = await S.get(k.rules, null); rules = r ? JSON.parse(r) : DEFAULT_RULES.slice(); }
    catch { rules = DEFAULT_RULES.slice(); }
    compiledRules = compileAll(rules);

    bindUI();
    attachObserver();
    watchdogObserver();
    watchURL();

    await onThreadChanged(getCurrentThreadIdFromURL());

    if (!scanTimer) scanTimer = setInterval(tick, CFG.SCAN_EVERY_MS);
    log("Bot listo (anti-roaming, solo navega con cola). Hilo:", currentTid);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => CFG.AUTO_START && init(), { once: true });
  } else {
    CFG.AUTO_START && init();
  }

  // Debug
  window.__vzBot = {
    on:  () => { enabled = true;  },
    off: () => { enabled = false; },
    tick, queue,
    async rules(){ return rules; },
    async setRules(arr){ if(!Array.isArray(arr)) throw new Error("setRules espera array"); rules=arr; compiledRules=compileAll(rules); await S.set(k.rules, JSON.stringify(rules, null, 2)); }
  };
})();

// content.js — Bot con COLA FIFO y anti-roaming (solo navega si hay item en cola)
// v2.7 — 2026-02-16 (FIX: Respuesta duplicada + mejoras de detección)

(() => {
  "use strict";

  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 700,
    REPLY_COOLDOWN_MS: 3000,
    THREAD_LOAD_SILENCE_MS: 1500, // ✅ REDUCIDO: 1.5 segundos al cargar un hilo (antes 3s)
    SEND_COOLDOWN_MS: 1100,
    DEFAULT_FALLBACK: "",
    DEBUG: false,
    STUCK_REHOOK_MS: 8000,
    QUEUE_RETRY_MS: 800,
    OPEN_RETRY_MS: 700,
    MAX_OPEN_TRIES: 12,

    // 🔒 Anti-roaming DESACTIVADO: SÍ navegamos automáticamente para procesar no leídos
    AUTO_NAVIGATE_ON_UNREAD: false,
    
    // ✅ NUEVO: Tiempo mínimo entre detección de burbujas
    BUBBLE_DETECTION_COOLDOWN_MS: 800,
  };

  const DEFAULT_RULES = [
    {
      pattern: "hola",
      flags: "i",
      reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte."
    },
    {
      pattern: "precio",
      flags: "i",
      reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?"
    }
  ];

  /* ===== Utils ===== */
  const log = (...a) => {
    if (!CFG.DEBUG) return;
    const time = new Date().toLocaleTimeString('es-ES', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    console.log(`[VZ-Bot ${time}]`, ...a);
  };
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

  const isMarketplacePath = () => 
    location.pathname.startsWith("/marketplace/") || 
    location.pathname.includes("/messages/") && location.search.includes("marketplace");

  /* ===== Storage ===== */
  const k = {
    rules: "__vz_rules_json",
    analytics: "__vz_analytics_v1",
    followups: "__vz_followups_v1",
    byThread: (tid, name) => `__vz_thread_${tid}_${name}`
  };
  const S = {
    async get(key, fallback=null){
      try{
        if (chrome?.storage?.local){
          const out = await chrome.storage.local.get(key);
          return out?.[key] ?? fallback;
        }
      }catch{}
      try{
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      }catch{
        const raw = localStorage.getItem(key);
        return raw ?? fallback;
      }
    },
    async set(key,val){
      try{
        if (chrome?.storage?.local){
          await chrome.storage.local.set({[key]:val});
          return;
        }
      }catch{}
      localStorage.setItem(key, typeof val==="string"? val: JSON.stringify(val));
    }
  };

  const emptyAnalytics = () => ({
    totals: {
      incoming: 0,
      replies: 0,
      followups: 0
    },
    rules: {},
    threads: {},
    updatedAt: 0
  });

  const loadAnalytics = async () => {
    const data = await S.get(k.analytics, null);
    if (!data || typeof data !== "object") return emptyAnalytics();
    return {
      totals: {
        incoming: Number(data?.totals?.incoming || 0),
        replies: Number(data?.totals?.replies || 0),
        followups: Number(data?.totals?.followups || 0)
      },
      rules: (data.rules && typeof data.rules === "object") ? data.rules : {},
      threads: (data.threads && typeof data.threads === "object") ? data.threads : {},
      updatedAt: Number(data.updatedAt || 0)
    };
  };

  const saveAnalytics = async (a) => {
    a.updatedAt = now();
    await S.set(k.analytics, a);
  };

  const ensureThreadAnalytics = (a, tid) => {
    if (!a.threads[tid]) {
      a.threads[tid] = {
        tid,
        incomingCount: 0,
        replyCount: 0,
        followupCount: 0,
        lastIncomingAt: 0,
        lastReplyAt: 0,
        lastFollowupAt: 0,
        lastIncomingText: "",
        lastReplyText: "",
        lastRuleId: "",
        lastRuleLabel: "",
        lastFollowupLabel: "",
        followProgress: {}
      };
    }
    return a.threads[tid];
  };

  const normalizeFollowup = (item, idx) => {
    const id = String(item?.id || `fu_${idx + 1}`);
    const name = String(item?.name || `Seguimiento ${idx + 1}`).slice(0, 80);
    const delayMin = Math.max(1, Number(item?.delayMin || 5));
    const text = String(item?.text || "").slice(0, 600);
    const enabled = !!item?.enabled;
    return { id, name, delayMin, text, enabled };
  };

  const loadFollowups = async () => {
    const arr = await S.get(k.followups, []);
    if (!Array.isArray(arr)) return [];
    return arr.map((x, i) => normalizeFollowup(x, i));
  };

  const saveFollowups = async (arr) => {
    const safe = (Array.isArray(arr) ? arr : []).map((x, i) => normalizeFollowup(x, i));
    await S.set(k.followups, safe);
  };

  const trackIncoming = async (tid, text) => {
    const a = await loadAnalytics();
    const t = ensureThreadAnalytics(a, tid);
    t.incomingCount += 1;
    t.lastIncomingAt = now();
    t.lastIncomingText = String(text || "").slice(0, 300);
    a.totals.incoming += 1;
    await saveAnalytics(a);
  };

  const trackReply = async (tid, ruleId, ruleLabel, replyText) => {
    const a = await loadAnalytics();
    const t = ensureThreadAnalytics(a, tid);
    t.replyCount += 1;
    t.lastReplyAt = now();
    t.lastReplyText = String(replyText || "").slice(0, 300);
    t.lastRuleId = String(ruleId || "fallback");
    t.lastRuleLabel = String(ruleLabel || "Fallback");
    a.totals.replies += 1;

    if (!a.rules[t.lastRuleId]) {
      a.rules[t.lastRuleId] = { id: t.lastRuleId, label: t.lastRuleLabel, count: 0, lastAt: 0 };
    }
    a.rules[t.lastRuleId].count += 1;
    a.rules[t.lastRuleId].lastAt = now();
    a.rules[t.lastRuleId].label = t.lastRuleLabel;
    await saveAnalytics(a);
  };

  /* ===== Estado ===== */
  let enabled = CFG.AUTO_START;
  let rules = null;
  let compiledRules = [];
  let scanTimer = null;

  let currentTid = null;
  const threadSilenceUntil = new Map(); // tid -> timestamp (CAMBIADO: era variable global)
  let msgObserver = null, lastMutationAt = 0, observedRoot = null;
  let pendingAutoOpenTid = null;

  const inFlightPerThread = new Set();
  const lastBubbleHashMem = new Map(); // tid -> último hash local
  const sendCooldownUntil = new Map(); // tid -> ts

  // Cola global: items { tid, enqueuedAt, tries }
  const queue = [];
  let processing = false;

  // Watcher de "no leídos" (sidebar)
  const unreadSeen = new Set();

  // Flag: hasta cuándo consideramos que el operador está tecleando
  let operatorTypingUntil = 0;
  let lastComposerEl = null;

  // ✅ NUEVO: Control de detección de burbujas
  let lastBubbleDetectionAt = 0;

  /* ===== Messenger helpers ===== */
  const MSG_ROW_SELECTORS = [
    '[role="grid"] [role="row"]',
    '[data-testid*="message-container"]',
    '[data-testid*="message"]'
  ];
  const getCurrentThreadIdFromURL = () => {
    // Soporta:
    // - /messages/t/123456 (facebook.com)
    // - /messages/e2ee/t/123456 (encriptado)
    const m = location.pathname.match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? m[1] : null;
  };
  const getThreadLinks = () =>
    QA('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href^="/marketplace/t/"]');
  const getThreadIdFromHref = (href) =>
    href?.match?.(/\/(?:messages\/(?:e2ee\/)?t|marketplace\/t)\/([^/?#]+)/)?.[1] || null;
  const getActiveThreadIdFromDOM = () => {
    const activeLink =
      Q('a[aria-current="page"][href*="/messages/t/"]') ||
      Q('a[aria-current="true"][href*="/messages/t/"]') ||
      Q('a[aria-current="page"][href*="/marketplace/t/"]') ||
      Q('a[aria-current="true"][href*="/marketplace/t/"]');
    return getThreadIdFromHref(activeLink?.getAttribute("href"));
  };
  const getActiveTid = () => getCurrentThreadIdFromURL() || getActiveThreadIdFromDOM() || currentTid || "unknown";

  const looksUnreadRow = (row) => {
    if (!row) return false;
    if (row.querySelector('[data-testid*="unread"]')) return true;
    if (/no\s*le[ií]d[oa]s?|nuevo|unread/i.test(row.textContent || "")) return true;
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
    const KEYS = [
      "mensajes no leidos","mensajes no leídos",
      "ver mensajes no leidos","ver mensajes no leídos",
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

  const openThreadById = (tid) => {
    const link = getThreadLinks().find(a => getThreadIdFromHref(a.getAttribute("href")) === tid);
    if (!link) return false;
    try {
      link.scrollIntoView({ block: "center", inline: "center" });
      link.click();
    } catch {
      try { link?.click(); } catch {}
    }
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

    // Hook: cuando el operador teclea, marcamos ventana de 5s
    if (composer && composer !== lastComposerEl) {
      lastComposerEl = composer;
      try {
        // ✅ MEJORADO: Detectar múltiples eventos para capturar actividad del operador
        ['focus', 'input', 'paste', 'keydown'].forEach(evt => {
          composer.addEventListener(evt, (e) => {
            if (!e?.isTrusted) return;
            operatorTypingUntil = now() + 5000; // 5s desde la última actividad
            log("[composer] operador activo, pausando auto-respuesta por 5s");
          }, { capture: true });
        });
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
    parts.forEach((t,i)=>{
      if(t){
        const ok=document.execCommand("insertText", false, t);
        if(!ok) el.textContent=(el.textContent||"")+t;
        el.dispatchEvent(new InputEvent("input",{bubbles:true,cancelable:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
      }
      if(i<parts.length-1) shiftEnter(el);
    });
  };
  const sendText = async (tid, text) => {
    if (!text) return false;
    const composer = findComposer(); if (!composer) return false;
    sendCooldownUntil.set(tid, now()+CFG.SEND_COOLDOWN_MS);
    pasteMultiline(composer, text);
    setTimeout(()=>emitEnter(composer), 30);
    return true;
  };

  /* ===== Última burbuja (MEJORADO) ===== */
  const getLastBubbleInfo = () => {
    const gridRoot =
      Q('[role="grid"][aria-label*="Mensajes de la conversación"]') ||
      Q('[role="grid"][aria-label*="Messages in conversation"]') ||
      document.body;
    const bubbles = QA(MSG_ROW_SELECTORS.join(","), gridRoot).filter(isVisible);
    const count = bubbles.length;
    
    for (let i = count - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (/\b(reaction|sticker|emoji|system)\b/i.test(b.getAttribute("data-testid") || "")) continue;

      const nodes = QA(
        'div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p',
        b
      );
      const rawLines = [];
      for (const n of nodes) {
        // Excluir texto de controles auxiliares (Intro, botones, fecha, etc.)
        if (n.closest('[role="button"], button, [data-scope="date_break"]')) continue;
        const t = (n.innerText || n.textContent || "").trim();
        if (!t) continue;
        rawLines.push(...t.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
      }

      const noise = new Set([
        "intro",
        "cargando...",
        "has enviado",
        "you sent"
      ]);

      const lines = [];
      const seen = new Set();
      for (const line of rawLines) {
        const nl = normalize(line);
        if (!nl) continue;
        if (noise.has(nl)) continue;
        if (nl.startsWith("escribe a ")) continue;
        if (nl.includes("esta escribiendo") || nl.includes("typing")) continue;
        // Filtra separadores de fecha/hora del hilo
        if (/^(hoy|ayer|today|yesterday)\b/.test(nl)) continue;
        if (/^\d{1,2}:\d{2}$/.test(nl)) continue;
        // Evita duplicados como "Hora Hora"
        if (seen.has(nl)) continue;
        seen.add(nl);
        lines.push(line);
      }

      let text = lines
        .join("\n")
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();

      if (!text) continue;
      const nText = normalize(text);
      if (
        nText === "intro" ||
        nText === "cargando..." ||
        nText.startsWith("escribe a ") ||
        nText.includes("esta escribiendo") ||
        nText.includes("typing")
      ) continue;

      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const msgId = b.getAttribute("data-message-id") || b.getAttribute("data-mid") || b.id || "";

      // ✅ MEJORADO: Detección de dirección con más pistas
      let dir = null;

      // 1) Pistas fuertes de mensaje propio (out)
      if (isOutHint(text) || isOutHint(aria)) {
        const stableSig = msgId ? `out|id:${msgId}` : `out|txt:${normalize(text)}`;
        const hash = djb2(stableSig);
        return { text, dir: "out", count, hash };
      }

      // 2) testid de la plataforma
      if (/incoming/.test(testid)) dir = "in";
      else if (/outgoing/.test(testid)) dir = "out";

      // 3) aria label con pistas de enviado
      if (!dir && aria) {
        if (/(you sent|has enviado|enviaste|mensaje enviado|enviado por ti|sent by you)/.test(aria)) {
          dir = "out";
        }
        // ✅ NUEVO: También detectar mensajes recibidos
        if (/(received|recibido|mensaje de)/.test(aria)) {
          dir = "in";
        }
      }

      // 4) ✅ NUEVO: Verificar clases CSS que indican dirección
      const classList = b.className || "";
      if (classList.includes("outgoing") || classList.includes("sent")) dir = "out";
      if (classList.includes("incoming") || classList.includes("received")) dir = "in";

      // 5) Fallback geométrico solo si no hay otra pista
      if (!dir) {
        const rect = b.getBoundingClientRect();
        const mid = (window.innerWidth || document.documentElement.clientWidth) * 0.5;
        dir = rect.left > mid ? "out" : "in";
      }

      const stableSig = msgId ? `${dir}|id:${msgId}` : `${dir}|txt:${normalize(text)}`;
      const hash = djb2(stableSig);
      return { text, dir, count, hash };
    }
    return { text: "", dir: "in", count: 0, hash: "0" };
  };

  /* ===== Reglas ===== */
  const compileRule = (r, idx) => {
    try {
      return {
        re: new RegExp(r.pattern, r.flags || "i"),
        reply: r.reply,
        id: `rule_${idx + 1}`,
        label: `Regla ${idx + 1}`
      };
    } catch {
      return null;
    }
  };
  const compileAll = (arr) => (Array.isArray(arr) ? arr : []).map(compileRule).filter(Boolean);

  /* ===== Per-thread keys ===== */
  const lastReplyAtKey      = (tid)=> k.byThread(tid,"last_reply_at");
  const lastSentHashKey     = (tid)=> k.byThread(tid,"last_sent_hash");
  const lastIncomingHashKey = (tid)=> k.byThread(tid,"last_in_hash");
  const lastTrackedIncomingKey = (tid)=> k.byThread(tid,"last_tracked_in_hash");
  const baselineHashKey     = (tid)=> k.byThread(tid,"baseline_hash");
  // ✅ NUEVO: Key para guardar contenido literal del último mensaje enviado
  const lastSentContentKey  = (tid)=> k.byThread(tid,"last_sent_content");

  /* ===== Cola ===== */

  // ✅ CORREGIDO: Función unificada para encolar sin duplicados
  const enqueueTid = (tid, source = "unknown") => {
    // Verificar si ya está en cola
    if (queue.some(item => item.tid === tid)) {
      log("[queue] tid ya en cola, ignorando:", tid, "source:", source);
      return false;
    }
    
    // Verificar si ya está siendo procesado
    if (inFlightPerThread.has(tid)) {
      log("[queue] tid en proceso, ignorando:", tid, "source:", source);
      return false;
    }
    
    queue.push({ tid, enqueuedAt: now(), tries: 0 });
    log("[queue] +tid", tid, "source:", source, "len:", queue.length);
    processQueueSoon();
    return true;
  };

  // Para "no leídos" (sidebar): una vez por transición a no-leído
  const enqueueTidOnce = (tid) => {
    if (unreadSeen.has(tid)) {
      log("[queue] tid ya en unreadSeen, saltando:", tid);
      return;
    }
    
    unreadSeen.add(tid);
    
    // ✅ Verificar silence period antes de encolar
    const tidSilenceUntil = threadSilenceUntil.get(tid) || 0;
    if (now() < tidSilenceUntil) {
      log("[queue] tid en silence period desde sidebar, NO encolando:", tid);
      return;
    }
    
    enqueueTid(tid, "sidebar-unread");
  };

  // Para chat activo: re-usable, sin depender de unreadSeen
  const enqueueActiveTid = (tid) => {
    enqueueTid(tid, "active-chat");
  };

  const processQueueSoon = () => { if (!processing) setTimeout(processQueue, 20); };

  const replyForThread = async (tid) => {
    // Cooldown por hilo
    const lastAt = Number(await S.get(lastReplyAtKey(tid), 0));
    if (now() - lastAt < CFG.REPLY_COOLDOWN_MS) {
      return { done: false, wait: CFG.REPLY_COOLDOWN_MS - (now() - lastAt) };
    }

    // Asegura estar en el hilo objetivo
    if (getActiveTid() !== tid) {
      let tries = 0;
      while (tries < CFG.MAX_OPEN_TRIES) {
        const ok = openThreadById(tid);
        if (!ok) return { done: false, wait: CFG.OPEN_RETRY_MS };
        await sleep(CFG.OPEN_RETRY_MS);
        if (getActiveTid() === tid) break;
        tries++;
      }
      return { done: false, wait: CFG.THREAD_LOAD_SILENCE_MS + 80 };
    }

    // ✅ Verificar silence period específico de este hilo
    const silenceUntil = threadSilenceUntil.get(tid) || 0;
    if (now() < silenceUntil) {
      log("[reply] hilo en silence period, esperando...", tid);
      return { done: false, wait: silenceUntil - now() };
    }
    
    if (now() < (sendCooldownUntil.get(tid) || 0)) {
      return { done: false, wait: (sendCooldownUntil.get(tid) || 0) - now() };
    }

    // Tomar último mensaje visible
    const { text, dir, hash } = getLastBubbleInfo();
    if (!text || isLikelySystem(text)) {
      return { done: false, wait: 300 };
    }

    // ✅ MEJORADO: Evitar responder a nuestro propio último mensaje (verificación robusta)
    const incomingPlain = djb2(text);
    const lastSentPlain = await S.get(lastSentHashKey(tid), "");
    const lastSentContent = await S.get(lastSentContentKey(tid), "");
    
    // Verificamos si el texto actual es exactamente lo que acabamos de enviar
    const isSameHash = String(lastSentPlain) === String(incomingPlain);
    const isSameContent = lastSentContent && text.trim() === lastSentContent.trim();
    const containsSentText = lastSentContent && 
                             text.includes(lastSentContent.substring(0, Math.min(50, lastSentContent.length)));
    
    if (isSameHash || isSameContent || containsSentText) {
      // Es nuestro propio mensaje, marcar como procesado y salir
      await S.set(lastIncomingHashKey(tid), hash);
      log("[reply] mensaje propio detectado, ignorando", tid);
      return { done: true };
    }

    // En chats normales exigimos dir === "in"; en Marketplace relajamos esa condición
    if (dir === "out") return { done: true };

    // ¿ya atendido este mensaje?
    const lastIn = await S.get(lastIncomingHashKey(tid), "");
    if (String(lastIn) === String(hash)) return { done: true };

    // Operador escribiendo → no auto-responder
    if (now() < operatorTypingUntil) {
      log("[reply] operador escribiendo, posponiendo auto-respuesta", tid);
      return { done: false, wait: 1200 };
    }

    const trackedHash = await S.get(lastTrackedIncomingKey(tid), "");
    if (String(trackedHash) !== String(hash)) {
      await trackIncoming(tid, text);
      await S.set(lastTrackedIncomingKey(tid), hash);
    }

    // Reglas
    let reply = null;
    let matchedRuleId = "fallback";
    let matchedRuleLabel = "Fallback";
    for (const rule of compiledRules) {
      if (rule.re.test(text)) {
        reply = rule.reply;
        matchedRuleId = rule.id;
        matchedRuleLabel = rule.label;
        break;
      }
    }
    if (!reply && CFG.DEFAULT_FALLBACK) reply = CFG.DEFAULT_FALLBACK;

    if (!reply) {
      await S.set(lastIncomingHashKey(tid), hash);
      return { done: true };
    }

    const thisHash = djb2(reply);

    const ok = await sendText(tid, reply);
    if (ok) {
      const ts = now();
      const handledIncomingHash = hash;
      
      // Esperar a que Facebook renderice la burbuja
      await sleep(300); // Reducido de 500ms a 300ms
      
      // Obtener el hash de la burbuja que acabamos de crear
      const { hash: newBubbleHash } = getLastBubbleInfo();
      
      await S.set(lastReplyAtKey(tid), ts);
      await S.set(lastIncomingHashKey(tid), handledIncomingHash);
      await S.set(lastSentHashKey(tid), thisHash);
      await S.set(lastSentContentKey(tid), reply);
      await trackReply(tid, matchedRuleId, matchedRuleLabel, reply);
      
      lastBubbleHashMem.set(tid, newBubbleHash);
      
      // ✅ CRÍTICO: Durante este período, el MutationObserver NO procesará NADA
      const silenceEnd = now() + 4000; // 4 segundos de silencio (reducido de 8s para más velocidad)
      threadSilenceUntil.set(tid, silenceEnd);
      
      log("[reply] enviado", tid, "hash:", newBubbleHash);
      log("[reply] ✅ SILENCE ESTABLECIDO para", tid, "hasta", new Date(silenceEnd).toLocaleTimeString(), "actual:", new Date(now()).toLocaleTimeString());
      log("[reply] threadSilenceUntil Map size:", threadSilenceUntil.size, "keys:", Array.from(threadSilenceUntil.keys()));
      
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

        if (inFlightPerThread.has(tid)) {
          await sleep(CFG.QUEUE_RETRY_MS);
          continue;
        }
        inFlightPerThread.add(tid);

        let res;
        try { res = await replyForThread(tid); }
        finally { inFlightPerThread.delete(tid); }

        if (res?.done) {
          queue.shift();
          continue;
        }

        item.tries += 1;
        await sleep(Math.max(CFG.QUEUE_RETRY_MS, res?.wait || 400));
      }
    } finally { processing = false; }
  };

  /* ===== Detección de entrantes (observer + fallback activo) ===== */
  const onNewIncomingInActiveChat = async () => {
    const tid = getActiveTid();
    const activeSilenceUntil = threadSilenceUntil.get(tid) || 0;
    if (now() < activeSilenceUntil) {
      log("[active-chat] ⛔ hilo activo en silence, abortando:", tid);
      return;
    }
    
    // ✅ Evitar procesamiento muy rápido
    if (now() - lastBubbleDetectionAt < CFG.BUBBLE_DETECTION_COOLDOWN_MS) {
      return;
    }
    lastBubbleDetectionAt = now();
    
    const { text, dir, hash } = getLastBubbleInfo();
    if (!text || isLikelySystem(text)) return;

    // ✅ CRÍTICO: Verificar si el texto coincide con CUALQUIERA de nuestras respuestas configuradas
    // Esto evita que el bot responda a sus propias respuestas
    
    // Función para normalizar: quitar emojis, caracteres especiales, espacios extras
    const normalize = (str) => {
      return str
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emojis emoticones
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Símbolos y pictogramas
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transporte y símbolos de mapa
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Banderas
        .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Símbolos varios
        .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Selectores de variación
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Símbolos suplementarios y pictogramas
        .replace(/[^\w\sáéíóúñü]/gi, '')        // Quitar todo excepto letras, números, espacios
        .replace(/\s+/g, ' ')                   // Espacios múltiples a uno solo
        .trim()
        .toLowerCase();
    };
    
    const textNormalized = normalize(text);
    const lastSentContent = await S.get(lastSentContentKey(tid), "");
    const lastSentNormalized = normalize(lastSentContent || "");
    if (
      lastSentNormalized &&
      (textNormalized === lastSentNormalized ||
       textNormalized.includes(lastSentNormalized.substring(0, Math.min(35, lastSentNormalized.length))))
    ) {
      log("[active-chat] coincide con último enviado, ignorando");
      return;
    }
    
    log("[active-chat] Verificando contra", compiledRules.length, "reglas. Text normalizado:", textNormalized.substring(0, 50));
    
    for (const rule of compiledRules) {
      const replyNormalized = normalize(rule.reply || '');
      const checkPart = replyNormalized.substring(0, Math.min(25, replyNormalized.length));
      
      if (replyNormalized && checkPart.length > 10 && textNormalized.includes(checkPart)) {
        log("[active-chat] ⛔ COINCIDE! Ignorando. Reply:", checkPart);
        return;
      }
    }

    // Verificación adicional: si es "out" lo ignoramos siempre
    if (dir === "out") {
      log("[active-chat] mensaje es 'out', ignorando");
      return;
    }

    if (dir === "out") {
      return;
    }

    const lastIn = await S.get(lastIncomingHashKey(tid), "");
    const lastMem = lastBubbleHashMem.get(tid) || "";

    if (hash === lastMem || String(lastIn) === String(hash)) {
      return; // ya visto/atendido
    }
    lastBubbleHashMem.set(tid, hash);

    // Encolar
    log("[active-chat] Nuevo mensaje entrante, encolando:", tid, "hash:", hash, "text:", text.substring(0, 30));
    enqueueActiveTid(tid);
  };

  const getMessagesRoot = () => (
    Q('[role="grid"][aria-label*="Mensajes de la conversación"]') ||
    Q('[role="grid"][aria-label*="Messages in conversation"]') ||
    Q('[data-pagelet="MWV2MessageList"] [role="grid"]') ||
    Q('[role="main"] [role="grid"]') ||
    Q('[role="grid"]') ||
    Q('[data-testid="mwthreadlist"]') ||
    Q('[data-pagelet*="Pagelet"]') ||
    document.body
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
        
        const tid = getActiveTid();
        const activeSilenceUntil = threadSilenceUntil.get(tid) || 0;
        if (now() < activeSilenceUntil) {
          log("[observer] hilo activo en silence, no procesando:", tid);
          return;
        }

        await onNewIncomingInActiveChat();
      }, 70);
    });

    const opts = {
      childList:true,
      subtree:true,
      characterData:true,
      attributes:true,
      attributeFilter:["aria-label","data-testid","class","dir"]
    };
    msgObserver.observe(root, opts);
    if (root !== document.body) msgObserver.observe(document.body, opts);
    lastMutationAt = now();
    log("[observer] enganchado");
  };

  const detachObserver = () => {
    try{ msgObserver?.disconnect(); }catch{}
    msgObserver=null; observedRoot=null;
  };

  const watchdogObserver = () => {
    setInterval(() => {
      const root = getMessagesRoot();
      if (root && root !== observedRoot) {
        log("[observer] root cambió → rehook");
        attachObserver();
        return;
      }
      if (now() - lastMutationAt > CFG.STUCK_REHOOK_MS) {
        log("[observer] sin mutaciones → rehook");
        attachObserver();
      }
    }, Math.max(1500, CFG.SCAN_EVERY_MS * 2));
  };

  /* ===== Cambio de hilo / URL ===== */
  const getBaselineHash = () => {
    const { hash } = getLastBubbleInfo();
    return hash || "0";
  };

  const onThreadChanged = async (newTid) => {
    const tid = newTid || "unknown";
    currentTid = tid;
    
    // ✅ MEJORADO: Solo establecer silence si no hay uno más largo ya activo
    const existingSilence = threadSilenceUntil.get(tid) || 0;
    const newSilence = now() + CFG.THREAD_LOAD_SILENCE_MS;
    
    if (now() >= existingSilence) {
      // Solo establecer nuevo silence si el existente ya expiró
      threadSilenceUntil.set(tid, newSilence);
      log("[thread] Estableciendo silence de", CFG.THREAD_LOAD_SILENCE_MS, "ms para", tid);
    } else {
      log("[thread] Manteniendo silence existente hasta", new Date(existingSilence).toLocaleTimeString());
    }
    
    const base = getBaselineHash();

    if (pendingAutoOpenTid && pendingAutoOpenTid === tid) {
      await S.set(baselineHashKey(tid), base);
      const prevLastIn = await S.get(lastIncomingHashKey(tid), null);
      if (prevLastIn === null) await S.set(lastIncomingHashKey(tid), "0");
      lastBubbleHashMem.set(tid, base);            // ✅ coherencia memoria
      
      log("[thread] abierto (auto)", tid, "baseline:", base);
      pendingAutoOpenTid = null;
      
      // ✅ MEJORADO: Después del silence, verificar si realmente HAY mensajes nuevos
      setTimeout(async () => {
        // Obtener hash actual después de que el DOM se estabilice
        await sleep(100);
        const { hash: currentHash, dir: currentDir, text: currentText } = getLastBubbleInfo();
        
        log("[thread] ⚙️ Verificación post-apertura:");
        log("[thread]   Current hash:", currentHash);
        log("[thread]   Baseline:", base);
        log("[thread]   Dir:", currentDir);
        log("[thread]   Text preview:", currentText?.substring(0, 50));
        
        // Si hay un mensaje diferente a la baseline Y es entrante
        if (currentHash !== "0" && currentHash !== base && currentDir === "in" && currentText) {
          log("[thread] ✅ Mensaje nuevo detectado después de abrir. Encolando...");
          enqueueActiveTid(tid);
          processQueueSoon();
        } else {
          log("[thread] ⚠️ No hay mensajes nuevos o el último es propio.");
          log("[thread]   Razón:", 
            currentHash === "0" ? "Hash es 0" : 
            currentHash === base ? "Hash igual a baseline" : 
            currentDir !== "in" ? `Dir es '${currentDir}' no 'in'` : 
            !currentText ? "No hay texto" : "Desconocida");
        }
      }, CFG.THREAD_LOAD_SILENCE_MS + 300);
      
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
        const tid = getActiveTid();
        onThreadChanged(tid);
      }
    }, 300);
  };

  /* ===== Loop principal ===== */
  const tick = async () => {
    if (!enabled) return;

    const activeTid = getActiveTid();
    const activeSilenceUntil = threadSilenceUntil.get(activeTid) || 0;
    if (now() < activeSilenceUntil) {
      log("[tick] hilo activo en silence, esperando:", activeTid);
      return;
    }

    // 1) Fallback: si estás en un chat y entra algo, encola TID
    await onNewIncomingInActiveChat();

    // 2) Watcher delta de "no leídos": solo encola TID cuando aparecen nuevos no leídos
    const unreadTids = listUnreadTidsFromSidebar();
    for (const tid of unreadTids) {
      if (!unreadSeen.has(tid)) enqueueTidOnce(tid);
    }
    for (const tid of [...unreadSeen]) {
      if (!unreadTids.includes(tid)) unreadSeen.delete(tid);
    }

    // 3) Procesar cola
    if (queue.length && !processing) processQueueSoon();
    await processScheduledFollowups();

    // 4) ✅ Auto-navegación: SÍ abrir no leídos automáticamente para procesarlos
    if (CFG.AUTO_NAVIGATE_ON_UNREAD === true && !queue.length && unreadTids.length) {
      log("[tick] Abriendo hilo no leído automáticamente:", unreadTids[0]);
      openThreadById(unreadTids[0]);
    }
  };

  /* ===== UI (opcional) ===== */
  const getAnalyticsSummary = async () => {
    const a = await loadAnalytics();
    const followups = await loadFollowups();
    const threads = Object.values(a.threads || {}).sort((x, y) => Number(y.lastIncomingAt || 0) - Number(x.lastIncomingAt || 0));
    const rulesStats = Object.values(a.rules || {}).sort((x, y) => Number(y.count || 0) - Number(x.count || 0));
    return {
      totals: {
        chats: threads.length,
        incoming: Number(a?.totals?.incoming || 0),
        replies: Number(a?.totals?.replies || 0),
        followups: Number(a?.totals?.followups || 0),
        trackingEnabled: followups.filter(f => !!f.enabled).length
      },
      threads,
      rules: rulesStats,
      followups,
      updatedAt: Number(a.updatedAt || 0)
    };
  };

  const sendFollowupForThread = async (tid, text) => {
    if (!text) return false;
    if (getActiveTid() !== tid) {
      let tries = 0;
      while (tries < CFG.MAX_OPEN_TRIES) {
        const ok = openThreadById(tid);
        if (!ok) return false;
        await sleep(CFG.OPEN_RETRY_MS);
        if (getActiveTid() === tid) break;
        tries += 1;
      }
      if (getActiveTid() !== tid) return false;
    }
    const ok = await sendText(tid, text);
    if (!ok) return false;
    await sleep(300);
    const sentHash = djb2(text);
    await S.set(lastReplyAtKey(tid), now());
    await S.set(lastSentHashKey(tid), sentHash);
    await S.set(lastSentContentKey(tid), text);
    return true;
  };

  const processScheduledFollowups = async () => {
    const followups = (await loadFollowups())
      .filter(f => !!f.enabled && String(f.text || "").trim())
      .sort((a, b) => Number(a.delayMin || 0) - Number(b.delayMin || 0));
    if (!followups.length) return;

    const a = await loadAnalytics();
    const entries = Object.values(a.threads || {});
    if (!entries.length) return;

    for (const t of entries) {
      const tid = t.tid;
      const lastIncomingAt = Number(t.lastIncomingAt || 0);
      if (!lastIncomingAt) continue;
      if (!tid) continue;
      if (inFlightPerThread.has(tid) || queue.some(q => q.tid === tid)) continue;

      const progress = (t.followProgress && typeof t.followProgress === "object") ? t.followProgress : {};
      let sentOne = false;

      for (const fu of followups) {
        const delayMs = Math.max(1, Number(fu.delayMin || 5)) * 60 * 1000;
        const dueAt = lastIncomingAt + delayMs;
        if (now() < dueAt) continue;

        const sentForIncomingAt = Number(progress[fu.id] || 0);
        if (sentForIncomingAt >= lastIncomingAt) continue;

        const ok = await sendFollowupForThread(tid, String(fu.text || ""));
        if (!ok) continue;

        const fresh = await loadAnalytics();
        const freshT = ensureThreadAnalytics(fresh, tid);
        freshT.followupCount = Number(freshT.followupCount || 0) + 1;
        freshT.lastFollowupAt = now();
        freshT.lastFollowupLabel = String(fu.name || fu.id);
        if (!freshT.followProgress || typeof freshT.followProgress !== "object") freshT.followProgress = {};
        freshT.followProgress[fu.id] = lastIncomingAt;
        fresh.totals.followups = Number(fresh?.totals?.followups || 0) + 1;
        await saveAnalytics(fresh);
        sentOne = true;
        break;
      }
      if (sentOne) continue;
    }
  };

  const loadRulesJson = async () => {
    let raw = await S.get(k.rules, null);
    if (!raw) raw = JSON.stringify(DEFAULT_RULES, null, 2);
    return raw;
  };
  const saveRulesJson = async (raw) => {
    rules = JSON.parse(raw);
    compiledRules = compileAll(rules);
    await S.set(k.rules, JSON.stringify(rules, null, 2));
    log("[rules] guardadas/recompiladas");
  };
  const bindUI = () => {
    if (!window.VZUI) return;
    window.VZUI.injectTopBar({
      getEnabled: () => enabled,
      setEnabled: (v) => { enabled = !!v; },
      onOpenRules: () => window.VZUI.openRulesModal({
        loadRules: () => loadRulesJson(),
        saveRules: (raw) => saveRulesJson(raw)
      }),
      onOpenTracking: () => window.VZUI.openTrackingModal({
        loadAnalytics: () => getAnalyticsSummary(),
        saveFollowups: (arr) => saveFollowups(arr)
      })
    });
  };

  /* ===== Init ===== */
  const init = async () => {
    try {
      const r = await S.get(k.rules, null);
      rules = r ? JSON.parse(r) : DEFAULT_RULES.slice();
    } catch {
      rules = DEFAULT_RULES.slice();
    }
    compiledRules = compileAll(rules);

    bindUI();

    // ✅ CRÍTICO: Establecer silence period inicial ANTES de cualquier cosa
    const initialTid = getActiveTid();
    threadSilenceUntil.set(initialTid, now() + 5000); // 5 segundos de silence inicial
    
    log("[init] Estableciendo silence inicial de 5s para", initialTid);

    // ✅ Esperar un poco para que Facebook cargue los mensajes en el DOM
    await sleep(500); // Reducido de 1000ms a 500ms

    // ✅ Ahora sí fija baseline/lastIncoming del hilo actual
    await onThreadChanged(initialTid);

    // ✅ Luego engancha observer y watchers
    attachObserver();
    watchdogObserver();
    watchURL();

    if (!scanTimer) scanTimer = setInterval(tick, CFG.SCAN_EVERY_MS);
    log("Bot listo v2.12.0 (ACTUALIZADO: soporte para facebook.com/messages). Hilo:", currentTid, "Baseline establecida");
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
    analytics: () => getAnalyticsSummary(),
    followups: () => loadFollowups(),
    setFollowups: (arr) => saveFollowups(arr),
    async rules(){ return rules; },
    async setRules(arr){
      if(!Array.isArray(arr)) throw new Error("setRules espera array");
      rules=arr; compiledRules=compileAll(rules);
      await S.set(k.rules, JSON.stringify(rules, null, 2));
    }
  };
})();

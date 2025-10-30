// Messenger Chatbot — SOLO REGLAS — Responder SOLO a mensajes entrantes reales
// Fix: NO responde al cambiar/abrir chats, sólo cuando llega un mensaje nuevo.
// Fecha: 2025-10-29

(() => {
  "use strict";

  /* ====================== CONFIG ====================== */
  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 1200,          // loop de escaneo (no dispara envíos)
    CLICK_COOLDOWN_MS: 8000,      // anti-spam al abrir chats no leídos
    REPLY_COOLDOWN_MS: 12000,     // intervalo mínimo entre respuestas por hilo
    OPEN_UNREAD: true,            // abrir no leídos (no enviará solos)
    THREAD_LOAD_SILENCE_MS: 1800, // ventana de silencio tras cambiar de chat
    DEFAULT_FALLBACK: "",         // "" = no enviar nada si no hay match
    DEBUG: true
  };

  // Reglas por defecto (orden: específicas → generales)
  const DEFAULT_RULES = [
    { pattern: "\\b(soy|me llamo)\\s+([a-záéíóúñ]+)\\b", flags: "i", reply: "¡Mucho gusto! 😊 ¿En qué te ayudo?" },
    { pattern: "precio|valor|cu[aá]nto cuesta|costo", flags: "i", reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" },
    { pattern: "horario|hora|atienden", flags: "i", reply: "Horario de atención:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" },
    { pattern: "env[ií]o|entrega|domicilio", flags: "i", reply: "¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizar?" },
    { pattern: "^hola\\b|buen[oa]s|saludos", flags: "i", reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte." }
  ];

  /* ====================== STORAGE ====================== */
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

  /* ====================== LOG ====================== */
  const log = (...a) => CFG.DEBUG && console.log("[VZ-Bot]", ...a);
  const now = () => Date.now();

  /* ====================== STATE ====================== */
  let enabled = CFG.AUTO_START;
  let lastClickAt = 0;
  let scanTimer = null;
  let msgObserver = null;
  let rules = null;

  // Mutex por hilo
  const inFlight = new Set();

  // Bandera: sólo responder si llega NUEVO entrante (marcada por observer)
  const newIncomingFlag = new Map(); // tid -> boolean

  // Control de cambios de chat (URL / selección)
  let currentTid = null;
  let threadSilenceUntil = 0; // timestamp hasta el cual ignoramos mutaciones

  /* ====================== HELPERS ====================== */
  const Q  = (sel, r=document) => r.querySelector(sel);
  const QA = (sel, r=document) => Array.from(r.querySelectorAll(sel));
  const isVisible = (el) => !!(el && el.isConnected && el.offsetParent);

  const getCurrentThreadIdFromURL = () => {
    const m = location.pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? m[1] : null;
  };

  const djb2 = (s) => {
    let h = 5381;
    for (let i=0;i<s.length;i++) h = ((h<<5)+h) + s.charCodeAt(i);
    return String(h >>> 0);
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
    const normalize = (s) => (s || "").toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
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

  /* ====================== REGLAS ====================== */
  const compile = (r) => {
    try { return { re: new RegExp(r.pattern, r.flags || "i"), reply: r.reply }; }
    catch { return null; }
  };

  const getCompiledRules = () => (Array.isArray(rules) ? rules : []).map(compile).filter(Boolean);

  /* ====================== KEYS POR HILO ====================== */
  const lastReplyAtKey      = (tid) => k.byThread(tid, "last_reply_at");
  const lastSentHashKey     = (tid) => k.byThread(tid, "last_sent_hash");
  const lastIncomingHashKey = (tid) => k.byThread(tid, "last_in_hash");      // último entrante atendido
  const baselineHashKey     = (tid) => k.byThread(tid, "baseline_hash");      // snapshot al abrir hilo
  const threadContextKey    = (tid) => k.byThread(tid, "context_text");

  /* ====================== LECTURA ÚLTIMO ENTRANTE ====================== */
  const getLastIncomingText = () => {
    const bubbles = QA('[data-testid*="message"], [data-testid*="message-container"], [role="row"]').filter(isVisible);
    for (let i=bubbles.length-1;i>=0;i--) {
      const b = bubbles[i];
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/\b(you|tú)\b/.test(aria)) continue; // ignorar propios
      const nodes = QA('div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p', b);
      const text = nodes.map(n => (n.innerText || n.textContent || "").trim()).filter(Boolean).join("\n").trim();
      if (text) return text.replace(/\s+/g, " ");
    }
    return null;
  };

  const getSnapshotHash = () => {
    // hash de "último texto entrante + cantidad de burbujas visibles"
    const bubbles = QA('[data-testid*="message"], [data-testid*="message-container"], [role="row"]').filter(isVisible);
    const count = bubbles.length;
    const txt = getLastIncomingText() || "";
    return djb2(`${txt}#${count}`);
  };

  // ¿El nodo agregado parece una burbuja ENTRANTE (del cliente) con texto?
  const isIncomingBubbleNode = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const bubble = node.matches?.('[data-testid*="message"], [data-testid*="message-container"], [role="row"]')
      ? node
      : node.querySelector?.('[data-testid*="message"], [data-testid*="message-container"], [role="row"]');
    if (!bubble || !isVisible(bubble)) return false;
    const aria = (bubble.getAttribute("aria-label") || "").toLowerCase();
    if (/\b(you|tú)\b/.test(aria)) return false; // propio
    const nodes = QA('div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p', bubble);
    const text = nodes.map(n => (n.innerText || n.textContent || "").trim()).filter(Boolean).join("\n").trim();
    return !!text;
  };

  /* ====================== ENVÍO ====================== */
  const sendText = async (text) => {
    if (!text) return false;
    const composer = findComposer();
    if (!composer) return false;
    pasteMultiline(composer, text);
    setTimeout(() => emitEnter(composer), 30);
    return true;
  };

  /* ====================== MOTOR: SOLO con nuevo entrante ====================== */
  const maybeReplyByRules = async (tid) => {
    if (!tid) return false;

    // SOLO si el observer detectó NUEVO entrante y ya pasó la ventana de silencio
    if (!newIncomingFlag.get(tid)) return false;
    if (now() < threadSilenceUntil) return false;

    if (inFlight.has(tid)) return false;
    inFlight.add(tid);

    try {
      const lastAt = Number(await S.get(lastReplyAtKey(tid), 0));
      if (now() - lastAt < CFG.REPLY_COOLDOWN_MS) { newIncomingFlag.set(tid, false); return false; }

      const text = getLastIncomingText();
      if (!text) { newIncomingFlag.set(tid, false); return false; }

      const inHash = djb2(text);
      const lastIn = await S.get(lastIncomingHashKey(tid), "");
      if (String(lastIn) === String(inHash)) { // ya atendido
        newIncomingFlag.set(tid, false);
        return false;
      }

      // Buscar regla
      const compiled = getCompiledRules();
      let reply = null;
      for (const { re, reply: rep } of compiled) {
        if (re.test(text)) { reply = rep; break; }
      }

      if (!reply) {
        await S.set(lastIncomingHashKey(tid), inHash); // marcar procesado sin respuesta
        newIncomingFlag.set(tid, false);
        return false;
      }

      // Anti-repetir misma respuesta consecutiva
      const lastSent = await S.get(lastSentHashKey(tid), "");
      const thisHash = djb2(reply);
      if (String(lastSent) === String(thisHash)) {
        await S.set(lastIncomingHashKey(tid), inHash);
        newIncomingFlag.set(tid, false);
        return false;
      }

      // Contexto opcional
      const ctx = (await S.get(threadContextKey(tid), "") || "").trim();
      const toSend = ctx ? `${ctx}\n\n${reply}` : reply;

      const ok = await sendText(toSend);
      if (ok) {
        const ts = now();
        await S.set(lastReplyAtKey(tid), ts);
        await S.set(lastIncomingHashKey(tid), inHash);
        await S.set(lastSentHashKey(tid), thisHash);
        log("[rules] respuesta enviada");
      }

      newIncomingFlag.set(tid, false); // consumir bandera SIEMPRE
      return !!ok;
    } finally {
      inFlight.delete(tid);
    }
  };

  /* ====================== UI mínima ====================== */
  const injectTopBar = async () => {
    if (Q("#vz-topbar")) return;

    const wrap = document.createElement("div");
    wrap.id = "vz-topbar";
    Object.assign(wrap.style, {
      position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)",
      zIndex: 2147483647, pointerEvents: "none"
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      pointerEvents: "auto",
      background: "rgba(15,15,18,.7)", backdropFilter: "blur(8px)",
      color: "#fff", font: "13px/1 system-ui, -apple-system, Segoe UI, Roboto",
      padding: "6px 10px", borderRadius: "10px",
      display: "flex", gap: "8px", alignItems: "center",
      boxShadow: "0 8px 30px rgba(0,0,0,.35)"
    });

    const status = document.createElement("span");
    status.textContent = enabled ? "Auto: ON" : "Auto: OFF";

    const mkBtn = (label, bg) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        background: bg, color: "#fff", border: "none",
        borderRadius: "8px", padding: "6px 10px", cursor: "pointer",
        opacity: .92
      });
      b.onmouseenter = () => (b.style.opacity = 1);
      b.onmouseleave = () => (b.style.opacity = .92);
      return b;
    };

    const btnToggle = mkBtn(enabled ? "Pausar" : "Reanudar", enabled ? "#22c55e" : "#525252");
    btnToggle.onclick = () => {
      enabled = !enabled;
      status.textContent = enabled ? "Auto: ON" : "Auto: OFF";
      btnToggle.textContent = enabled ? "Pausar" : "Reanudar";
      btnToggle.style.background = enabled ? "#22c55e" : "#525252";
    };

    const btnRules = mkBtn("Editar reglas", "#7c3aed");
    btnRules.onclick = () => openRulesModal();

    const btnCtx = mkBtn("Contexto (chat)", "#3b82f6");
    btnCtx.onclick = () => openContextModal();

    bar.append(status, btnToggle, btnRules, btnCtx);
    wrap.append(bar);
    document.documentElement.append(wrap);
  };

  const openModal = ({ title, initialValue, placeholder, mono=false, onSave }) => {
    const id = "vz-modal-wrap";
    if (Q("#"+id)) Q("#"+id).remove();

    const overlay = document.createElement("div");
    overlay.id = id;
    Object.assign(overlay.style, {
      position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", backdropFilter: "blur(2px)",
      zIndex: 2147483647, display: "flex", alignItems: "center", justifyContent: "center"
    });

    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
      width: "min(96vw, 680px)", background: "rgba(24,24,27,.96)", color: "#fff",
      borderRadius: "14px", border: "1px solid rgba(255,255,255,.08)",
      boxShadow: "0 24px 80px rgba(0,0,0,.35)", padding: "16px",
      font: "14px/1.35 system-ui, -apple-system, Segoe UI, Roboto"
    });

    const h = document.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontWeight: 700, fontSize: "16px", marginBottom: "8px" });

    const ta = document.createElement("textarea");
    ta.value = initialValue || "";
    Object.assign(ta.style, {
      width: "100%", minHeight: "260px", borderRadius: "10px",
      border: "1px solid rgba(255,255,255,.15)",
      background: "rgba(39,39,42,.92)", color: "#fff",
      padding: "10px 12px", outline: "none", resize: "vertical",
      fontFamily: mono ? "ui-monospace, Menlo, Consolas, monospace" : "inherit",
      fontSize: mono ? "13px" : "14px"
    });
    ta.placeholder = placeholder || "";

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", marginTop: "12px", justifyContent: "flex-end" });

    const mkBtn = (txt, bg, bold=false) => {
      const b = document.createElement("button");
      b.textContent = txt;
      Object.assign(b.style, {
        background: bg, color: "#fff", border: "none",
        borderRadius: "10px", padding: "8px 12px", cursor: "pointer",
        fontWeight: bold ? 700 : 500
      });
      return b;
    };

    const cancel = mkBtn("Cancelar", "#6b7280");
    const save = mkBtn("Guardar", "#22c55e", true);

    cancel.onclick = () => overlay.remove();
    save.onclick = async () => {
      try { await onSave(ta.value); overlay.remove(); } catch (e) { alert(e?.message || e); }
    };

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); overlay.remove(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save.click(); }
    });

    dialog.append(h, ta, row);
    row.append(cancel, save);
    overlay.append(dialog);
    document.documentElement.append(overlay);
    setTimeout(() => ta.focus(), 0);
  };

  const openRulesModal = async () => {
    let raw = await S.get(k.rules, null);
    if (!raw) raw = JSON.stringify(DEFAULT_RULES, null, 2);
    openModal({
      title: "Editar reglas del chatbot (JSON: [{ pattern, flags?, reply }])",
      initialValue: raw,
      mono: true,
      onSave: async (val) => {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new Error("El JSON debe ser un array.");
        parsed.forEach(o => {
          if (typeof o.pattern !== "string" || typeof o.reply !== "string") throw new Error("Cada regla requiere 'pattern' (string) y 'reply' (string).");
        });
        rules = parsed;
        await S.set(k.rules, JSON.stringify(parsed, null, 2));
        log("Reglas guardadas");
      }
    });
  };

  const openContextModal = async () => {
    const tid = currentTid || "unknown";
    openModal({
      title: `Contexto del chat (hilo: ${tid})`,
      initialValue: await S.get(k.byThread(tid, "context_text"), "") || "",
      placeholder: "Escribe aquí notas o contexto para este hilo. Se antepondrá a las respuestas.",
      mono: false,
      onSave: async (val) => {
        await S.set(k.byThread(tid, "context_text"), String(val || ""));
        log("Contexto guardado para", tid);
      }
    });
  };

  /* ====================== CAMBIO DE CHAT (barrera + baseline) ====================== */
  const onThreadChanged = async (newTid) => {
    currentTid = newTid || "unknown";
    newIncomingFlag.set(currentTid, false);           // limpiar bandera
    threadSilenceUntil = now() + CFG.THREAD_LOAD_SILENCE_MS; // silenciar mutaciones del load
    // fijar baseline del hilo: hash actual del historial visible
    const base = getSnapshotHash();
    await S.set(baselineHashKey(currentTid), base);
    await S.set(lastIncomingHashKey(currentTid), base); // tratamos el estado visible como "ya atendido"
    log("[thread] cambiado a", currentTid, " baseline:", base);
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

  /* ====================== LOOP (no dispara respuestas) ====================== */
  const processCurrentChat = async () => {
    const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";
    await maybeReplyByRules(tid);
  };

  const tick = async () => {
    if (!enabled) return;

    // Procesa solo si el observer detectó nuevo entrante y pasó la barrera
    await processCurrentChat();

    // Abrir no leídos si corresponde (NO envía nada por sí mismo)
    if (CFG.OPEN_UNREAD && now() - lastClickAt > CFG.CLICK_COOLDOWN_MS) {
      const links = findUnread();
      if (links.length) {
        const candidate = links.find(a => getThreadIdFromHref(a.getAttribute("href")) !== currentTid) || links[0];
        if (candidate) {
          lastClickAt = now();
          realClick(candidate);
          // Tras abrir, se disparará onThreadChanged por watchURL; no respondemos aún (barrera activa).
          setTimeout(() => {
            clickUnreadDividerIfAny();
          }, 200);
        }
      }
    }
  };

  /* ====================== OBSERVER: marca SOLO nuevo entrante real ====================== */
  const bootMsgObserver = () => {
    if (msgObserver) return;

    let moQueued = false;

    const markIfIncoming = (node) => {
      try {
        // Dentro de ventana de silencio: ignorar (historial cargando)
        if (now() < threadSilenceUntil) return false;

        if (isIncomingBubbleNode(node)) {
          // Comprobar que el snapshot actual sea distinto al baseline/lastIncoming
          const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";
          const currentHash = getSnapshotHash();
          // Si coincide con lo ya registrado, no es nuevo
          return S.get(lastIncomingHashKey(tid), "").then(lastIn => {
            if (String(lastIn) === String(currentHash)) return false;
            newIncomingFlag.set(tid, true);
            return true;
          });
        }
      } catch {}
      return false;
    };

    msgObserver = new MutationObserver(async (mutList) => {
      // Evitar congestión
      if (moQueued) return;

      // Evaluar si hay al menos un entrante real fuera de la barrera
      let incomingDetected = false;
      for (const m of mutList) {
        if (m.type === "childList" && m.addedNodes?.length) {
          for (const n of m.addedNodes) {
            const flagged = await markIfIncoming(n);
            if (flagged) { incomingDetected = true; break; }
          }
          if (incomingDetected) break;
        }
      }
      if (!incomingDetected) return;

      moQueued = true;
      setTimeout(() => {
        moQueued = false;
        if (!enabled) return;
        processCurrentChat(); // procesará y consumirá bandera
      }, 100);
    });

    msgObserver.observe(document.body, { childList: true, subtree: true });
  };

  /* ====================== INIT ====================== */
  const init = async () => {
    try {
      const r = await S.get(k.rules, null);
      rules = r ? JSON.parse(r) : DEFAULT_RULES.slice();
    } catch { rules = DEFAULT_RULES.slice(); }

    await injectTopBar();
    bootMsgObserver();
    watchURL();

    // fijar hilo inicial y baseline
    await onThreadChanged(getCurrentThreadIdFromURL());

    if (!scanTimer) scanTimer = setInterval(tick, CFG.SCAN_EVERY_MS);
    log("Bot listo (responde SOLO a entrantes; ignora cambio de chat). Hilo:", currentTid);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enabled && init(), { once: true });
  } else {
    enabled && init();
  }

  /* ====================== CONSOLA (debug) ====================== */
  window.__vzBot = {
    on: () => { enabled = true; },
    off: () => { enabled = false; },
    tick,
    async rules() { return rules; },
    async setRules(arr) {
      if (!Array.isArray(arr)) throw new Error("setRules espera array");
      rules = arr;
      await S.set(k.rules, JSON.stringify(arr, null, 2));
    },
    async context(tid, val) {
      const key = k.byThread(tid, "context_text");
      if (typeof val === "undefined") return S.get(key, "");
      return S.set(key, String(val || ""));
    }
  };
})();

// Messenger Chatbot — SOLO REGLAS — Responder SOLO a mensajes ENTRANTES reales
// FIX 2025-10-29 (v2):
// - Si llega un mensaje NUEVO en otro chat, al abrir el "no leído" se responde de inmediato.
// - No marcamos como atendido (baseline) cuando el hilo se abrió por ser "no leído".
// - Dirección 'in/out' robusta (detecta "Has enviado / You sent" como OUT).
// - Cooldown post-envío para ignorar mutaciones del DOM.
// - Anti-duplicados por hash de entrante y de respuesta.

(() => {
  "use strict";

  /* ====================== CONFIG ====================== */
  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 1200,           // loop ligero (no dispara envíos)
    CLICK_COOLDOWN_MS: 8000,       // anti-spam al abrir no leídos
    REPLY_COOLDOWN_MS: 12000,      // mínimo entre respuestas por hilo
    OPEN_UNREAD: true,             // abrir no leídos (no envía por sí mismo)
    THREAD_LOAD_SILENCE_MS: 600,   // silencio tras cambiar de chat
    SEND_COOLDOWN_MS: 1200,        // silencio tras enviar (mutaciones post-envío)
    DEFAULT_FALLBACK: "",
    DEBUG: true
  };

  // Reglas por defecto
  const DEFAULT_RULES = [
    { pattern: "\\b(soy|me llamo)\\s+([a-záéíóúñ]+)\\b", flags: "i", reply: "¡Mucho gusto! 😊 ¿En qué te ayudo?" },
    { pattern: "precio|valor|cu[aá]nto cuesta|costo", flags: "i", reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" },
    { pattern: "(?:\\b|\\s)(horario|hora|atienden)(?:\\b|\\s)", flags: "i", reply: "Horario de atención:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" },
    { pattern: "env[ií]o|entrega|domicilio", flags: "i", reply: "¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizar?" },
    { pattern: "^hola\\b|buen[oa]s|saludos", flags: "i", reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte." }
  ];

  /* ====================== STORAGE KEYS ====================== */
  const k = {
    rules: "__vz_rules_json",
    byThread: (tid, name) => `__vz_thread_${tid}_${name}`
  };

  /* ====================== STORAGE API ====================== */
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

  let currentTid = null;
  let threadSilenceUntil = 0;

  // Flags/dedup
  const inFlight = new Set();                 // mutex por hilo
  const newIncomingFlag = new Map();          // tid -> boolean (solo procesa si true)
  const lastBubbleHashMem = new Map();        // tid -> hash local (mutaciones)
  const sendCooldownUntil = new Map();        // tid -> ts (ignorar mutaciones post-envío)

  // *** NUEVO: si abrimos un hilo porque era "no leído", lo marcamos aquí para forzar respuesta ***
  let pendingAutoOpenTid = null;

  /* ====================== HELPERS DOM ====================== */
  const Q  = (sel, r=document) => r.querySelector(sel);
  const QA = (sel, r=document) => Array.from(r.querySelectorAll(sel));
  const isVisible = (el) => !!(el && el.isConnected && el.offsetParent);

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

  const OUT_HINTS = [
    "you sent", "has enviado", "enviaste", "tú:", "tu:", "usted:", "you:"
  ];

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

  /* ====================== ÚLTIMO BUBBLE (ROBUSTO) ====================== */
  // Devuelve { text, dir, count, hash }
  const getLastBubbleInfo = () => {
    const container = document.body;
    const bubbles = QA(
      '[data-testid*="message"], [data-testid*="message-container"], [role="row"]',
      container
    ).filter(isVisible);

    const count = bubbles.length;
    for (let i = count - 1; i >= 0; i--) {
      const b = bubbles[i];

      // TEXTO del bubble
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

      // ATRIBUTOS
      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      const aria   = (b.getAttribute("aria-label") || "").toLowerCase();

      // Fuerza OUT si hay indicios de eco ("Has enviado", "You sent", etc.)
      if (isOutHint(text) || isOutHint(aria)) {
        const hash = djb2(`out|${text}|#${count}`);
        return { text, dir: "out", count, hash };
      }

      // Heurística por testid
      let dir = null;
      if (/incoming/.test(testid)) dir = "in";
      else if (/outgoing/.test(testid)) dir = "out";

      // Heurística por aria
      if (!dir) {
        if (/\b(you|tú|vos|usted)\b/.test(aria)) dir = "out";
        else if (aria) dir = "in";
      }

      // Alineación (fallback)
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

  /* ====================== REGLAS ====================== */
  const compile = (r) => { try { return { re: new RegExp(r.pattern, r.flags || "i"), reply: r.reply }; } catch { return null; } };
  const getCompiledRules = () => (Array.isArray(rules) ? rules : []).map(compile).filter(Boolean);

  /* ====================== KEYS POR HILO ====================== */
  const lastReplyAtKey      = (tid) => k.byThread(tid, "last_reply_at");
  const lastSentHashKey     = (tid) => k.byThread(tid, "last_sent_hash");
  const lastIncomingHashKey = (tid) => k.byThread(tid, "last_in_hash");    // último entrante atendido
  const baselineHashKey     = (tid) => k.byThread(tid, "baseline_hash");   // snapshot al abrir

  /* ====================== ENVÍO ====================== */
  const sendText = async (tid, text) => {
    if (!text) return false;
    const composer = findComposer();
    if (!composer) return false;
    // Cooldown post-envío para ignorar mutaciones del DOM
    sendCooldownUntil.set(tid, now() + CFG.SEND_COOLDOWN_MS);
    pasteMultiline(composer, text);
    setTimeout(() => emitEnter(composer), 30);
    return true;
  };

  /* ====================== MOTOR ====================== */
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

      // ¿Ya atendimos este entrante?
      const lastIn = await S.get(lastIncomingHashKey(tid), "");
      if (String(lastIn) === String(hash)) { newIncomingFlag.set(tid, false); return false; }

      // Match de reglas
      const compiled = getCompiledRules();
      let reply = null;
      for (const { re, reply: rep } of compiled) {
        if (re.test(text)) { reply = rep; break; }
      }

      if (!reply) {
        await S.set(lastIncomingHashKey(tid), hash); // marcar como visto
        newIncomingFlag.set(tid, false);
        return false;
      }

      // Anti-repetir MISMA respuesta consecutiva
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
        await S.set(lastIncomingHashKey(tid), hash);   // este entrante quedó atendido
        await S.set(lastSentHashKey(tid), thisHash);
        // Actualizamos memoria local para que el observer no re-procese inmediatamente
        lastBubbleHashMem.set(tid, djb2(`out|${reply}|#${ts}`));
        log("[rules] respuesta enviada");
      }

      newIncomingFlag.set(tid, false);
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

    bar.append(status, btnToggle, btnRules);
    wrap.append(bar);
    document.documentElement.append(wrap);
  };

  const openModal = ({ title, initialValue, mono=false, onSave }) => {
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
          if (typeof o.pattern !== "string" || typeof o.reply !== "string")
            throw new Error("Cada regla requiere 'pattern' (string) y 'reply' (string).");
        });
        rules = parsed;
        await S.set(k.rules, JSON.stringify(parsed, null, 2));
        log("Reglas guardadas");
      }
    });
  };

  /* ====================== CAMBIO DE CHAT ====================== */
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
      // *** Caso: abrimos este hilo porque estaba "no leído" ***
      // No marcamos baseline como "atendido" ni memoria local,
      // y forzamos proceso tras el silencio de carga.
      await S.set(baselineHashKey(tid), base);

      setTimeout(() => {
        // Forzamos que el último bubble entrante se procese
        newIncomingFlag.set(tid, true);
        // Importante: no tocar lastBubbleHashMem para que no bloquee
        maybeReplyByRules(tid);
      }, CFG.THREAD_LOAD_SILENCE_MS + 50);

      log("[thread] abierto por NO LEÍDO → procesar último entrante", tid, " baseline:", base);
      pendingAutoOpenTid = null;
    } else {
      // Cambio normal (manual o por navegación): snapshot y lo marcamos como atendido
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

  /* ====================== LOOP ====================== */
  const processCurrentChat = async () => {
    const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";
    await maybeReplyByRules(tid);
  };

  const tick = async () => {
    if (!enabled) return;
    await processCurrentChat();

    if (CFG.OPEN_UNREAD && now() - lastClickAt > CFG.CLICK_COOLDOWN_MS) {
      const links = findUnread();
      if (links.length) {
        // Elegimos un no leído distinto al actual si es posible
        const candidate = links.find(a => getThreadIdFromHref(a.getAttribute("href")) !== currentTid) || links[0];
        if (candidate) {
          const hrefTid = getThreadIdFromHref(candidate.getAttribute("href"));
          pendingAutoOpenTid = hrefTid || null; // *** clave: marcar que lo abrimos por "no leído"
          lastClickAt = now();
          realClick(candidate);
          setTimeout(() => { clickUnreadDividerIfAny(); }, 200);
        }
      }
    }
  };

  /* ====================== OBSERVER: marca SOLO NUEVO ENTRANTE ====================== */
  const bootMsgObserver = () => {
    if (msgObserver) return;

    let moQueued = false;

    msgObserver = new MutationObserver(() => {
      if (moQueued) return;
      moQueued = true;

      setTimeout(async () => {
        moQueued = false;
        if (!enabled) return;
        if (now() < threadSilenceUntil) return;

        const tid = currentTid || getCurrentThreadIdFromURL() || "unknown";

        // Ignorar mutaciones inmediatamente después de enviar
        if (now() < (sendCooldownUntil.get(tid) || 0)) return;

        const { text, dir, hash } = getLastBubbleInfo();
        if (!text || dir !== "in") return; // último no es entrante ⇒ no hacemos nada

        const lastMem = lastBubbleHashMem.get(tid) || "";
        if (lastMem === hash) return; // misma burbuja (mutaciones internas)

        // ENTRANTE nuevo
        lastBubbleHashMem.set(tid, hash);
        newIncomingFlag.set(tid, true);
        await processCurrentChat(); // proc. inmediato
      }, 80);
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

    await onThreadChanged(getCurrentThreadIdFromURL());

    if (!scanTimer) scanTimer = setInterval(tick, CFG.SCAN_EVERY_MS);
    log("Bot listo (responde SOLO a entrantes NUEVOS). Hilo:", currentTid);
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
    }
  };
})();

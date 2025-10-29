// Messenger Chatbot — abre no leídos + saludo multilínea + respuestas por reglas (UI editable)
(() => {
  /* =============== CONFIG =============== */
  const GREETING_DEFAULT = "Hola 👋\n\nCuéntame, ¿en qué puedo ayudarte?";
  const AUTO_START = true;
  const SCAN_INTERVAL_MS = 1200;
  const CLICK_COOLDOWN_MS = 8000;
  const GREETING_COOLDOWN_MS = 45000;
  const REPLY_COOLDOWN_MS = 15000;   // tiempo mínimo entre respuestas automatizadas por hilo
  const FIRST_TIME_ONLY = false;     // si true, el saludo SOLO se envía una vez por hilo
  const WATCH_THREAD_ID = "";        // p.ej. "1301108227872571" o "" para desactivar
  const DEBUG = true;

  // Reglas por defecto (se pueden editar en el modal "Editar reglas")
  // Formato: [{ pattern: "...", flags: "i", reply: "..." }, ...]
  const DEFAULT_RULES = [
    { pattern: "^hola\\b|buen[oa]s|saludos", flags: "i", reply: "¡Hola! 😊\n\nCuéntame un poco más para ayudarte." },
    { pattern: "precio|valor|cu[aá]nto cuesta|costo", flags: "i", reply: "Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" },
    { pattern: "horario|hora|atienden", flags: "i", reply: "Nuestro horario de atención es:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" },
    { pattern: "env[ií]o|entrega|domicilio", flags: "i", reply: "¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizarlo?" },
    { pattern: "gracias|ok|listo", flags: "i", reply: "¡Gracias a ti! Si necesitas algo más, aquí estoy. 🙌" }
  ];

  /* =============== ESTADO =============== */
  let enabled = AUTO_START;
  let lastClickAt = 0;
  let scanTimer = null;
  let listObserver = null;
  let msgObserver = null;
  let queuedTick = false;

  const LS_GREETING = "__auto_mq_greeting_text";
  const LS_RULES = "__auto_mq_rules_json";
  const LS_THREAD_PREFIX = (name) => `__auto_mq_${name}_${getThreadId()}`;

  // Saludo
  let greetingText = localStorage.getItem(LS_GREETING);
  if (greetingText === null) greetingText = GREETING_DEFAULT;

  // Reglas
  let rules;
  try {
    rules = JSON.parse(localStorage.getItem(LS_RULES) || "null");
    if (!Array.isArray(rules)) throw 0;
  } catch {
    rules = DEFAULT_RULES;
  }

  /* =============== UTILS =============== */
  const log = (...a) => DEBUG && console.log("[Messenger-Chatbot]", ...a);
  const now = () => Date.now();

  const Q  = (s, r=document) => r.querySelector(s);
  const QA = (s, r=document) => Array.from(r.querySelectorAll(s));
  const isVisible = (el) => !!(el && el.isConnected && el.offsetParent);

  const rafDebounce = (fn) => {
    if (queuedTick) return;
    queuedTick = true;
    requestAnimationFrame(() => { queuedTick = false; fn(); });
  };

  const getCurrentThreadId = () => {
    const m = location.pathname.match(/\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? m[1] : null;
  };
  const getThreadId = () => getCurrentThreadId() || "unknown";

  const setGreeting = (text) => {
    greetingText = String(text ?? "");
    localStorage.setItem(LS_GREETING, greetingText);
    const hint = Q("#mq-greeting-hint");
    if (hint) hint.textContent = `Saludo (1ª línea): “${(greetingText.split("\n")[0] || "(vacío)")}”`;
    log("Nuevo saludo:", JSON.stringify(greetingText));
  };

  const setRules = (json) => {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) throw new Error("El JSON debe ser un array de reglas.");
      // validación mínima
      arr.forEach(o => {
        if (typeof o.pattern !== "string" || typeof o.reply !== "string") throw new Error("Cada regla necesita 'pattern' y 'reply'.");
      });
      rules = arr;
      localStorage.setItem(LS_RULES, JSON.stringify(arr));
      log("Reglas actualizadas:", arr);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  };

  /* =============== CLICK REALISTA =============== */
  const realClick = (el) => {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const xy = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const o = { bubbles: true, cancelable: true, view: window, ...xy };
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
    } catch (e) { try { el.click(); } catch {} }
  };

  const getThreadIdFromHref = (href) => href?.match?.(/\/(?:e2ee\/)?t\/([^/?#]+)/)?.[1] || null;

  /* =============== UNREAD (LISTA) =============== */
  const UNREAD_TXT_RE = /unread|no leído|no leidos|nuevo/i;
  const isUnreadRow = (row) => {
    if (!row) return false;
    if (row.querySelector('[data-testid*="unread"]')) return true;
    if (row.querySelector('svg[aria-label*="Unread"], svg[aria-label*="No leído"], svg[aria-label*="Nuevo"]')) return true;
    if (UNREAD_TXT_RE.test(row.textContent || "")) return true;
    for (const n of row.querySelectorAll("span,div")) {
      const fw = parseInt(getComputedStyle(n).fontWeight, 10);
      if (fw >= 600 || String(fw).toLowerCase() === "bold") return true;
    }
    return false;
  };

  const getThreadLinks = () => QA('a[href^="/e2ee/t/"], a[href^="/t/"]');
  const findUnreadThreads = () => {
    const unread = [];
    for (const a of getThreadLinks()) {
      const row = a.closest('[role="row"], li, [data-visualcompletion]') || a.parentElement;
      if (row && isUnreadRow(row)) unread.push(a);
    }
    return unread;
  };

  /* =============== DIVISOR “NUEVOS MENSAJES” =============== */
  const norm = (s) => (s || "").toString().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const UNREAD_KEYWORDS = [
    "mensajes no leidos","mensajes no leídos","ver mensajes no leidos","ver mensajes no leídos",
    "nuevos mensajes","new messages","unread messages"
  ].map(norm);

  const clickUnreadDividerInView = () => {
    for (const el of QA('div, span, a, button')) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText || el.textContent || "");
      if (UNREAD_KEYWORDS.some(k => t.includes(k))) {
        try { el.scrollIntoView({ behavior: "instant", block: "center" }); el.click(); return true; } catch {}
      }
    }
    return false;
  };

  /* =============== INPUT/TECLAS =============== */
  const emitKey = (el, key, { shift=false, ctrl=false, meta=false, alt=false } = {}) => {
    const base = {
      bubbles: true, cancelable: true, key, code: key, which: key === "Enter" ? 13 : undefined, keyCode: key === "Enter" ? 13 : undefined,
      shiftKey: shift, ctrlKey: ctrl, metaKey: meta, altKey: alt
    };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  };
  const pressEnter = (el) => emitKey(el, "Enter");
  const pressShiftEnter = (el) => emitKey(el, "Enter", { shift: true });

  const insertMultiline = (el, text) => {
    const parts = String(text).replace(/\r\n?/g, "\n").split("\n");
    try { el.focus(); document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
    parts.forEach((segment, i) => {
      if (segment) {
        const ok = document.execCommand("insertText", false, segment);
        if (!ok) el.textContent = (el.textContent || "") + segment;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (i < parts.length - 1) pressShiftEnter(el);
    });
  };

  /* =============== COMPOSER & SALUDO =============== */
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

  const maybeSendGreeting = () => {
    if (FIRST_TIME_ONLY && localStorage.getItem(LS_THREAD_PREFIX("greeted_once")) === "1") return false;
    if (now() - Number(localStorage.getItem(LS_THREAD_PREFIX("last_greet_at")) || "0") < GREETING_COOLDOWN_MS) return false;
    const composer = findComposer(); if (!composer) return false;
    insertMultiline(composer, greetingText); setTimeout(() => pressEnter(composer), 60);
    localStorage.setItem(LS_THREAD_PREFIX("last_greet_at"), String(now()));
    localStorage.setItem(LS_THREAD_PREFIX("greeted_once"), "1");
    log("Saludo enviado:", JSON.stringify(greetingText));
    return true;
  };

  /* =============== CAPTURAR ÚLTIMO MENSAJE ENTRANTE =============== */
  // Heurística: buscamos el contenedor del hilo y tomamos el último texto visible
  // que NO parezca ser de "tu" lado. Esto varía por builds; mantenemos genérico.
  const getLastIncomingText = () => {
    // candidatos de burbujas
    const bubbles = QA('[data-testid*="message"], [data-testid*="message-container"], [role="row"]')
      .filter(isVisible);

    // Tomar últimos y buscar texto
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      // Heurística: burbujas del otro lado a menudo no están alineadas a la derecha,
      // y no contienen "You"/"Tú" en aria-label. (Esto NO es perfecto, pero ayuda).
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/\byou\b|\btú\b/.test(aria)) continue;

      // extraer texto interno
      const txtNodes = QA('div[dir="auto"], span[dir="auto"], div[data-lexical-text="true"], span[data-lexical-text="true"], p', b);
      const text = txtNodes.map(n => (n.innerText || n.textContent || "").trim()).filter(Boolean).join("\n").trim();
      if (text) return text;
    }
    return null;
  };

  const hash = (s) => {
    // hash rápido (djb2)
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return String(h >>> 0);
  };

  /* =============== MOTOR DE REGLAS =============== */
  const compileRule = (r) => {
    try { return { re: new RegExp(r.pattern, r.flags || "i"), reply: r.reply }; }
    catch { return null; }
  };
  const compiledRules = () => rules.map(compileRule).filter(Boolean);

  const maybeReplyByRules = () => {
    const t = getThreadId();
    const lastAt = Number(localStorage.getItem(LS_THREAD_PREFIX("last_reply_at")) || "0");
    if (now() - lastAt < REPLY_COOLDOWN_MS) return false;

    const text = getLastIncomingText();
    if (!text) return false;

    // evita re-responder al mismo mensaje
    const h = hash(text);
    const lastHash = localStorage.getItem(LS_THREAD_PREFIX("last_in_hash"));
    if (lastHash === h) return false;

    // aplicar reglas
    for (const { re, reply } of compiledRules()) {
      if (re.test(text)) {
        const composer = findComposer(); if (!composer) return false;
        insertMultiline(composer, reply);
        setTimeout(() => pressEnter(composer), 60);
        localStorage.setItem(LS_THREAD_PREFIX("last_reply_at"), String(now()));
        localStorage.setItem(LS_THREAD_PREFIX("last_in_hash"), h);
        log("Regla aplicada:", re, "→ respuesta enviada.");
        return true;
      }
    }

    // si no matchea ninguna regla, sólo marcamos el hash para no insistir
    localStorage.setItem(LS_THREAD_PREFIX("last_in_hash"), h);
    return false;
  };

  /* =============== MODALES (Saludo / Reglas) =============== */
  const buildGreetingModal = () => {
    if (Q("#mq-greeting-modal-wrap")) return;

    const overlay = document.createElement("div");
    overlay.id = "mq-greeting-modal-wrap";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
      zIndex: "2147483647", display: "none", alignItems: "center", justifyContent: "center"
    });

    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
      width: "min(92vw, 480px)", background: "rgba(24,24,27,0.95)", color: "#fff", borderRadius: "14px",
      boxShadow: "0 24px 80px rgba(0,0,0,.35)", padding: "16px",
      border: "1px solid rgba(255,255,255,0.08)", font: "14px/1.35 system-ui, -apple-system, Segoe UI, Roboto"
    });

    const title = document.createElement("div");
    Object.assign(title.style, { fontWeight: "600", fontSize: "16px", marginBottom: "8px" });
    title.textContent = "Editar saludo (multilínea)";

    const input = document.createElement("textarea");
    input.id = "mq-greeting-input";
    input.value = greetingText;
    Object.assign(input.style, {
      width: "100%", minHeight: "120px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(39,39,42,0.9)", color: "#fff", padding: "10px 12px", outline: "none", resize: "vertical"
    });

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", marginTop: "12px", justifyContent: "flex-end" });

    const mkBtn = (txt, bg, color = "#fff", bold = false) => {
      const b = document.createElement("button");
      b.textContent = txt;
      Object.assign(b.style, {
        background: bg, color, border: "none", borderRadius: "10px", padding: "8px 12px", cursor: "pointer",
        fontWeight: bold ? "700" : "500"
      });
      return b;
    };
    const btnCancel = mkBtn("Cancelar", "#525252");
    const btnSave = mkBtn("Guardar", "#22c55e", "#0b1210", true);

    row.append(btnCancel, btnSave);
    dialog.append(title, input, row);
    overlay.append(dialog);
    document.documentElement.append(overlay);

    const open = () => { overlay.style.display = "flex"; setTimeout(() => input.focus(), 0); };
    const close = () => { overlay.style.display = "none"; };
    const save = () => { setGreeting(input.value); close(); };

    btnCancel.addEventListener("click", close);
    btnSave.addEventListener("click", save);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); }
    });

    const mo = new MutationObserver(() => { document.body.style.overflow = overlay.style.display === "flex" ? "hidden" : ""; });
    mo.observe(overlay, { attributes: true, attributeFilter: ["style"] });

    window.__mqGreetingModal = { open, close };
  };

  const buildRulesModal = () => {
    if (Q("#mq-rules-modal-wrap")) return;

    const overlay = document.createElement("div");
    overlay.id = "mq-rules-modal-wrap";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
      zIndex: "2147483647", display: "none", alignItems: "center", justifyContent: "center"
    });

    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
      width: "min(96vw, 680px)", background: "rgba(24,24,27,0.95)", color: "#fff", borderRadius: "14px",
      boxShadow: "0 24px 80px rgba(0,0,0,.35)", padding: "16px",
      border: "1px solid rgba(255,255,255,0.08)", font: "14px/1.35 system-ui, -apple-system, Segoe UI, Roboto"
    });

    const title = document.createElement("div");
    Object.assign(title.style, { fontWeight: "700", fontSize: "16px", marginBottom: "8px" });
    title.textContent = "Editar reglas del chatbot";

    const hint = document.createElement("div");
    Object.assign(hint.style, { opacity: "0.85", fontSize: "13px", marginBottom: "10px" });
    hint.innerHTML = "Formato JSON de <code>[{ pattern, flags?, reply }]</code>. Ejemplo: <code>{\"pattern\":\"hola\",\"flags\":\"i\",\"reply\":\"¡Hola!\"}</code>";

    const input = document.createElement("textarea");
    input.id = "mq-rules-input";
    input.value = JSON.stringify(rules, null, 2);
    Object.assign(input.style, {
      width: "100%", minHeight: "280px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(39,39,42,0.9)", color: "#fff", padding: "10px 12px", outline: "none", resize: "vertical",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "13px"
    });

    const error = document.createElement("div");
    Object.assign(error.style, { color: "#fecaca", fontSize: "12px", minHeight: "18px", marginTop: "6px" });

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", marginTop: "12px", justifyContent: "space-between", alignItems: "center" });

    const left = document.createElement("div");
    left.textContent = "Consejo: añade reglas de lo más específico a lo más general.";
    left.style.opacity = "0.8";

    const right = document.createElement("div");
    right.style.display = "flex"; right.style.gap = "8px";

    const mkBtn = (txt, bg, color = "#fff", bold = false) => {
      const b = document.createElement("button");
      b.textContent = txt;
      Object.assign(b.style, { background: bg, color, border: "none", borderRadius: "10px", padding: "8px 12px", cursor: "pointer", fontWeight: bold ? "700" : "500" });
      return b;
    };
    const btnReset = mkBtn("Restaurar por defecto", "#525252");
    const btnCancel = mkBtn("Cancelar", "#6b7280");
    const btnSave = mkBtn("Guardar", "#22c55e", "#0b1210", true);

    right.append(btnReset, btnCancel, btnSave);
    row.append(left, right);

    dialog.append(title, hint, input, error, row);
    overlay.append(dialog);
    document.documentElement.append(overlay);

    const open = () => { overlay.style.display = "flex"; setTimeout(() => input.focus(), 0); };
    const close = () => { overlay.style.display = "none"; };

    const save = () => {
      const { ok, error: err } = setRules(input.value);
      if (!ok) { error.textContent = "Error: " + err; return; }
      error.textContent = "";
      close();
    };
    const reset = () => { input.value = JSON.stringify(DEFAULT_RULES, null, 2); error.textContent = ""; };

    btnReset.addEventListener("click", reset);
    btnCancel.addEventListener("click", close);
    btnSave.addEventListener("click", save);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); }
    });

    const mo = new MutationObserver(() => { document.body.style.overflow = overlay.style.display === "flex" ? "hidden" : ""; });
    mo.observe(overlay, { attributes: true, attributeFilter: ["style"] });

    window.__mqRulesModal = { open, close };
  };

  /* =============== TOPBAR =============== */
  const injectTopBar = () => {
    if (Q("#mq-topbar")) return;

    const wrap = document.createElement("div");
    wrap.id = "mq-topbar";
    Object.assign(wrap.style, {
      position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", pointerEvents: "none"
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      pointerEvents: "auto", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)", color: "#fff",
      font: "14px/1.2 system-ui, -apple-system, Segoe UI, Roboto",
      padding: "6px 10px", borderRadius: "10px", display: "flex", gap: "8px",
      alignItems: "center", boxShadow: "0 6px 24px rgba(0,0,0,.25)"
    });

    const status = document.createElement("span");
    status.id = "mq-status";
    status.textContent = enabled ? "Auto: ON" : "Auto: OFF";

    const greetHint = document.createElement("span");
    greetHint.id = "mq-greeting-hint";
    greetHint.style.opacity = "0.85";
    greetHint.textContent = `Saludo (1ª línea): “${(greetingText.split("\n")[0] || "(vacío)")}”`;

    const mkBtn = (txt, bg) => {
      const b = document.createElement("button");
      b.textContent = txt;
      Object.assign(b.style, { background: bg, color: "#fff", border: "none", borderRadius: "8px", padding: "6px 10px", cursor: "pointer", opacity: "0.9" });
      b.onmouseenter = () => (b.style.opacity = "1");
      b.onmouseleave = () => (b.style.opacity = "0.9");
      return b;
    };

    const btnToggle = mkBtn(enabled ? "Pausar" : "Reanudar", enabled ? "#22c55e" : "#525252");
    btnToggle.addEventListener("click", () => {
      enabled = !enabled;
      status.textContent = enabled ? "Auto: ON" : "Auto: OFF";
      btnToggle.textContent = enabled ? "Pausar" : "Reanudar";
      btnToggle.style.background = enabled ? "#22c55e" : "#525252";
    });

    const btnGreeting = mkBtn("Editar saludo", "#3b82f6");
    btnGreeting.addEventListener("click", () => {
      if (!window.__mqGreetingModal) buildGreetingModal();
      window.__mqGreetingModal.open();
      const input = Q("#mq-greeting-input");
      if (input) input.value = greetingText;
    });

    const btnRules = mkBtn("Editar reglas", "#a855f7");
    btnRules.addEventListener("click", () => {
      if (!window.__mqRulesModal) buildRulesModal();
      window.__mqRulesModal.open();
      const input = Q("#mq-rules-input");
      if (input) input.value = JSON.stringify(rules, null, 2);
    });

    bar.append(status, greetHint, btnToggle, btnGreeting, btnRules);
    wrap.append(bar);
    document.documentElement.append(wrap);
  };

  /* =============== OBSERVADORES =============== */
  const bootListObserver = () => {
    if (listObserver) return;
    const container = Q('[role="grid"], [role="treegrid"]') || document.body;
    listObserver = new MutationObserver(() => { if (enabled) rafDebounce(tick); });
    listObserver.observe(container, { childList: true, subtree: true, attributes: true });
  };

  const bootMsgObserver = () => {
    if (msgObserver) return;
    msgObserver = new MutationObserver(() => {
      if (!enabled) return;
      const canClick = now() - lastClickAt > CLICK_COOLDOWN_MS;
      if (canClick && clickUnreadDividerInView()) {
        lastClickAt = now();
        setTimeout(() => { maybeSendGreeting(); maybeReplyByRules(); }, 150);
        return;
      }
      // sin divisor, intentamos responder por reglas y/o saludar con cooldown
      const replied = maybeReplyByRules();
      if (!replied) maybeSendGreeting();
    });
    msgObserver.observe(document.body, { childList: true, subtree: true });
  };

  /* =============== LOOP PRINCIPAL =============== */
  const tick = () => {
    if (!enabled) return;
    try {
      if (now() - lastClickAt < CLICK_COOLDOWN_MS) return;

      // 1) Abrir objetivo si está no leído
      if (WATCH_THREAD_ID) {
        const target = findUnreadThreads().find(a => getThreadIdFromHref(a.getAttribute("href")) === WATCH_THREAD_ID);
        if (target) {
          lastClickAt = now();
          realClick(target);
          setTimeout(() => { clickUnreadDividerInView(); maybeReplyByRules(); maybeSendGreeting(); }, 200);
          return;
        }
      }

      // 2) Abrir primer no leído distinto al actual
      const unread = findUnreadThreads();
      if (!unread.length) return;
      const currentId = getCurrentThreadId();
      const candidate = unread.find(a => getThreadIdFromHref(a.getAttribute("href")) !== currentId) || unread[0];
      if (candidate) {
        lastClickAt = now();
        realClick(candidate);
        setTimeout(() => { clickUnreadDividerInView(); maybeReplyByRules(); maybeSendGreeting(); }, 200);
      }
    } catch (e) {
      log("tick error:", e);
    }
  };

  /* =============== INIT =============== */
  const start = () => {
    injectTopBar();
    buildGreetingModal();
    buildRulesModal();
    bootListObserver();
    bootMsgObserver();
    if (!scanTimer) scanTimer = setInterval(tick, SCAN_INTERVAL_MS);
    log("Chatbot iniciado. Hilo:", getThreadId());
    tick();
  };

  const stop = () => {
    if (scanTimer) clearInterval(scanTimer), (scanTimer = null);
    if (listObserver) listObserver.disconnect(), (listObserver = null);
    if (msgObserver) msgObserver.disconnect(), (msgObserver = null);
    log("Chatbot pausado.");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enabled && start(), { once: true });
  } else {
    enabled && start();
  }

  // helpers consola
  window.__mqBot = {
    start, stop, tick,
    get rules() { return rules; },
    setRules: (arr) => setRules(JSON.stringify(arr)),
    get greeting() { return greetingText; },
    setGreeting: (t) => setGreeting(t),
  };
})();

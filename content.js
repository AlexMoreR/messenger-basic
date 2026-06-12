// content.js — Bot con COLA FIFO y anti-roaming (solo navega si hay item en cola)
// La versión se toma del manifest (chrome.runtime.getManifest().version) — no la dupliques aquí.

(() => {
  "use strict";

  const CFG = {
    AUTO_START: true,
    SCAN_EVERY_MS: 700,
    REPLY_COOLDOWN_MS: 3000,
    HUMAN_REPLY_DELAY_MIN_MS: 2000,
    HUMAN_REPLY_DELAY_MAX_MS: 7000,
    THREAD_LOAD_SILENCE_MS: 1500, // ✅ REDUCIDO: 1.5 segundos al cargar un hilo (antes 3s)
    SEND_COOLDOWN_MS: 1100,
    DEFAULT_FALLBACK: "",
    DEBUG: false,
    STUCK_REHOOK_MS: 8000,
    QUEUE_RETRY_MS: 800,
    OPEN_RETRY_MS: 700,
    MAX_OPEN_TRIES: 12,

    // 🔒 Anti-roaming DESACTIVADO: SÍ navegamos automáticamente para procesar no leídos
    AUTO_NAVIGATE_ON_UNREAD: true,
    AUTO_NAV_COOLDOWN_MS: 5000, // enfriamiento entre auto-aperturas (evita el bucle de reabrir el mismo chat)
    
    // ✅ NUEVO: Tiempo mínimo entre detección de burbujas
    BUBBLE_DETECTION_COOLDOWN_MS: 800,
    SEND_GUARD_MS: 1800,
    SEND_STABILIZE_MS: 220, // espera para confirmar que el cuadro de texto del chat ya cargó (anti cross-chat)
    OPERATOR_PAUSE_MS: 2500,
    // ⬇️ Marketplace endurecido: menos acciones por pasada y mucho más espaciadas
    RENEW_MAX_ACTIONS_PER_PASS: 2,      // (era 4)
    RENEW_ACTION_DELAY_MIN_MS: 3500,    // (era 1200)
    RENEW_ACTION_DELAY_MAX_MS: 8000,    // (era 2600)
    RENEW_PASS_COOLDOWN_MIN_MS: 20000,  // (era 12000)
    RENEW_PASS_COOLDOWN_MAX_MS: 45000,  // (era 24000)
    RENEW_RELOAD_DELAY_MIN_MS: 1400,
    RENEW_RELOAD_DELAY_MAX_MS: 2600,
    // 🛡️ Tope DURO de acciones de renovación por día (anti-bloqueo de Marketplace)
    RENEW_DAILY_MAX_ACTIONS: 40,
    RENEW_DAILY_CAP_COOLDOWN_MS: 7200000, // 2h de pausa al tocar el tope

    // 🛡️ Anti-bloqueo de Messenger
    // Throttle GLOBAL por cuenta: tiempo mínimo entre CUALQUIER envío (mata las ráfagas)
    GLOBAL_SEND_MIN_GAP_MS: 5000,
    GLOBAL_SEND_MAX_GAP_MS: 20000,
    // Simulación de tecleo humano (el texto se escribe por trozos, no de golpe)
    TYPING_CHUNK_MIN: 2,
    TYPING_CHUNK_MAX: 5,
    TYPING_DELAY_PER_CHUNK_MIN_MS: 45,
    TYPING_DELAY_PER_CHUNK_MAX_MS: 130,
    TYPING_TOTAL_MAX_MS: 12000, // tope de tiempo de tecleo para respuestas muy largas
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
  const randBetween = (min, max) => Math.floor(min + Math.random() * Math.max(1, max - min + 1));
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
  const isRenewDialogRoute = () => String(location.search || "").includes("is_routable_dialog=true");
  const isMarketplaceBulkActionPage = () =>
    location.pathname.startsWith("/marketplace/selling/renew_listings") ||
    location.pathname.startsWith("/marketplace/selling/relist_items");
  const isMessagesPage = () => location.pathname.startsWith("/messages/");
  const isAutomationPage = () => isMessagesPage() || isMarketplaceBulkActionPage();

  /* ===== Storage ===== */
  const k = {
    rules: "__vz_rules_json",
    analytics: "__vz_analytics_v1",
    followups: "__vz_followups_v1",
    renewFinished: "__vz_renew_finished_v1",
    renewDaily: "__vz_renew_daily_v1",
    byThread: (tid, name) => `__vz_thread_${tid}_${name}`
  };
  const SETTINGS_KEY = "__vz_settings_v1";
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

  /* ===== Envío a Google Sheet (opcional) ===== */
  // URL del Web App de Apps Script. Vacío = desactivado. Se carga desde los ajustes.
  let sheetWebhookUrl = "";
  // Fire-and-forget: el navegador no puede leer la respuesta (no-cors), pero la fila se escribe igual.
  const sendToSheet = (payload) => {
    if (!sheetWebhookUrl) return;
    try {
      fetch(sheetWebhookUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch {}
  };

  /* ===== Agente IA (opcional) — saludo con pregunta y contacto en el 2º mensaje ===== */
  let aiEnabled = false;
  let openaiKey = "";
  let openaiModel = "gpt-4o-mini";
  let aiMaxReplies = 5; // máximo de respuestas de la IA por chat (0 = sin límite)
  let aiSystemPrompt = `Eres un agente de atención al cliente de Magilus por Facebook Marketplace.

Reglas:
- Nunca inventes precios, productos ni datos: todo lo que requiera detalle se gestiona por WhatsApp 304 648 1994.
- El número siempre como texto, nunca como enlace (no uses "https").
- No repitas el saludo de bienvenida.
- Responde siempre breve y en español.
- si el cliente indica que no tiene para whatsapp puede llamar a este mismo numero 3046481994
- si el cliente  insiste que le de informacion por este medio indiquele por comodida de nuestros clientes, ya que envamos cotizaciones, facturas detalle de envios

Pasos:

1. Siempre debes saludar con Primer mensaje (saludo):

'Bienvenid@ a Magilus 👑

¿Deseas este producto o quieres cotizar uno en particular?'

2. Si el cliente muestra interés, o pregunta precio, valor, detalles o cualquier información del producto:
¡Genial! 😊 Para brindarte una atención más rápida y personalizada, por favor escríbenos al WhatsApp. ✍️

304 648 1994

3. Si pregunta por ubicación, ciudad o dónde está la fábrica:
Tenemos sede en Cali y Bogotá.
¿Usted está en cuál ciudad? Así le confirmo si aplica despacho inmediato o fabricación.

   Y si responde una ciudad distinta de Cali o Bogotá:
Claro que sí, hacemos envío gratis a ciudades principales. Para confirmar, escríbenos por WhatsApp: 304 648 1994

4. Si el mensaje no encaja en ningún paso anterior: responde breve y amable, sin inventar datos, e invítalo a escribir por WhatsApp: 304 648 1994`;

  // Saludos de respaldo si la IA falla (sin key, sin red, error) — así el flujo nunca se rompe.
  const DEFAULT_GREETINGS = [
    "¡Hola! 😊 ¿En qué te puedo ayudar?",
    "¡Hola! Cuéntame, ¿qué estás buscando?",
    "¡Hola! 👋 ¿Sobre qué producto te gustaría saber?",
    "¡Hola! Con gusto te ayudo. ¿Qué necesitas?"
  ];
  const pickGreeting = () => DEFAULT_GREETINGS[Math.floor(Math.random() * DEFAULT_GREETINGS.length)];

  // Llama a la API de OpenAI (chat completions) con el historial de la conversación.
  // Devuelve el texto o null si falla.
  const callOpenAI = async (history) => {
    if (!openaiKey) return null;
    const model = openaiModel || "gpt-4o-mini";
    const isReasoning = /^o\d/i.test(model); // o1 / o3 / o4-mini... usan otros parámetros
    const msgs = [{ role: "system", content: aiSystemPrompt }];
    for (const m of (Array.isArray(history) ? history : [])) {
      if (m && (m.role === "user" || m.role === "assistant") && m.content) {
        msgs.push({ role: m.role, content: String(m.content).slice(0, 600) });
      }
    }
    const body = { model, messages: msgs };
    if (isReasoning) {
      body.max_completion_tokens = 200;
    } else {
      body.max_tokens = 150;
      body.temperature = 0.8;
    }
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + openaiKey },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        log("[ai] error HTTP", res.status, await res.text().catch(() => ""));
        return null;
      }
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content;
      return out ? String(out).trim() : null;
    } catch (e) {
      log("[ai] fetch error", e);
      return null;
    }
  };

  // Aplica los ajustes del agente IA (guardados) a las variables en uso.
  const applyAiSettings = (s) => {
    if (!s || typeof s !== "object") return;
    if (typeof s.aiEnabled === "boolean") aiEnabled = s.aiEnabled;
    if (s.openaiKey != null) openaiKey = String(s.openaiKey);
    if (s.openaiModel) openaiModel = String(s.openaiModel);
    if (s.aiMaxReplies != null && Number.isFinite(Number(s.aiMaxReplies))) aiMaxReplies = Math.max(0, Math.floor(Number(s.aiMaxReplies)));
    if (s.aiSystemPrompt != null && String(s.aiSystemPrompt).trim()) aiSystemPrompt = String(s.aiSystemPrompt);
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
    sendToSheet({ tid, tipo: "entrante", regla: "", texto: String(text || "").slice(0, 500) });
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
    sendToSheet({ tid, tipo: "respuesta", regla: String(ruleLabel || ""), texto: String(replyText || "").slice(0, 500) });
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
  const pendingReplyHash = new Map(); // tid -> hash entrante pendiente
  const pendingReplyReadyAt = new Map(); // tid -> ts listo para responder

  // Cola global: items { tid, enqueuedAt, tries }
  const queue = [];
  let processing = false;

  // Watcher de "no leídos" (sidebar)
  const unreadSeen = new Set();

  // Flag: hasta cuándo consideramos que el operador está tecleando
  let operatorTypingUntil = 0;
  let lastComposerEl = null;

  // 🛡️ Anti-ráfaga: hasta cuándo NO se permite el siguiente envío (a nivel de toda la cuenta)
  let globalSendReadyAt = 0;

  // Enfriamiento de la auto-navegación a no leídos (evita reabrir el mismo chat en bucle)
  let autoNavCooldownUntil = 0;

  // ✅ NUEVO: Control de detección de burbujas
  let lastBubbleDetectionAt = 0;
  let renewFlowRunning = false;
  let renewCooldownUntil = 0;
  let renewFinished = false;

  const normActionText = (el) => normalize(
    String(el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
  );

  const clickSmart = (el) => {
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
    try { el.click(); } catch {}
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {}
  };

  const hasNoMoreRelistMessage = () => {
    const n = normalize(document.body?.innerText || "");
    return (
      n.includes("no tienes mas publicaciones que puedan eliminarse y volver a realizarse") ||
      n.includes("no tienes mas publicaciones que puedan eliminarse y volver a publicarse") ||
      n.includes("no tienes mas publicaciones para renovar") ||
      n.includes("no hay publicaciones para renovar") ||
      n.includes("no hay mas publicaciones para renovar") ||
      n.includes("no listings to renew") ||
      n.includes("you have no more listings that can be deleted and relisted")
    );
  };

  const hasTemporaryBlockMessage = () => {
    const n = normalize(document.body?.innerText || "");
    return (
      n.includes("se te bloqueo temporalmente") ||
      n.includes("bloqueo temporalmente") ||
      n.includes("uso indebido de esta funcion") ||
      n.includes("blocked temporarily") ||
      n.includes("youre temporarily blocked")
    );
  };

  const getRenewCompletionButtons = () => {
    const controls = QA('button, [role="button"], a, div, span').filter(isVisible);
    const out = [];
    const seen = new Set();
    for (const el of controls) {
      const t = normActionText(el);
      if (!t) continue;
      const isDone =
        t === "listo" ||
        t.startsWith("listo ") ||
        t === "done" ||
        t.startsWith("done ") ||
        t === "aceptar" ||
        t.startsWith("aceptar ");
      if (!isDone) continue;
      const target =
        el.closest('button, [role="button"], a, [tabindex]') ||
        el;
      if (!target || !isVisible(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
    return out;
  };

  const getRenewDialogCloseButtons = () => {
    const selectors = [
      '[aria-label*="Cerrar"]',
      '[aria-label*="cerrar"]',
      '[aria-label*="Close"]',
      '[aria-label*="close"]'
    ].join(",");
    const labeled = QA(selectors).filter(isVisible);
    const dialogs = QA('[role="dialog"], [aria-modal="true"], div').filter(isVisible);
    const out = [];
    const seen = new Set();

    for (const el of labeled) {
      const target = el.closest('button, [role="button"], a, [tabindex]') || el;
      if (!target || !isVisible(target) || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }

    const renewDialogs = dialogs.filter((el) => {
      const t = normalize(el.innerText || el.textContent || "");
      return (
        t.includes("volver a publicar articulos") ||
        t.includes("renovar publicaciones") ||
        t.includes("no tienes mas publicaciones que puedan eliminarse y volver a realizarse") ||
        t.includes("problema al renovar la publicacion")
      );
    });

    for (const dlg of renewDialogs) {
      const localClose = QA('button, [role="button"], a, [tabindex]', dlg)
        .filter(isVisible)
        .find((el) => {
          const t = normActionText(el);
          const aria = normalize(el.getAttribute?.("aria-label") || "");
          return aria.includes("cerrar") || aria.includes("close") || t === "cerrar" || t === "x";
        });
      if (localClose && !seen.has(localClose)) {
        seen.add(localClose);
        out.push(localClose);
      }
    }

    return out;
  };

  const closeRenewCompletionDialogs = async () => {
    let clicked = false;
    for (let pass = 0; pass < 3; pass++) {
      const buttons = [
        ...getRenewCompletionButtons(),
        ...getRenewDialogCloseButtons()
      ];
      if (!buttons.length) break;
      for (const btn of buttons) {
        const label = normActionText(btn);
        try {
          clickSmart(btn);
          clicked = true;
          log("[renew] cierre de dialogo:", label || "(sin texto)");
        } catch {}
        await sleep(600);
      }
      await sleep(900);
    }
    return clicked;
  };

  const hardNavigateToRenewBase = () => {
    const target = "https://www.facebook.com/marketplace/selling/renew_listings/";
    try {
      location.assign(target);
    } catch {
      try {
        location.href = target;
      } catch {}
    }
  };

  const getRenewFinishedState = () => {
    try {
      return sessionStorage.getItem(k.renewFinished) === "1";
    } catch {
      return false;
    }
  };

  const setRenewFinishedState = (value) => {
    renewFinished = !!value;
    try {
      if (renewFinished) sessionStorage.setItem(k.renewFinished, "1");
      else sessionStorage.removeItem(k.renewFinished);
    } catch {}
  };

  // 🛡️ Contador diario de acciones de renovación (persistente, se reinicia cada día)
  const todayStr = () => {
    try { return new Date().toISOString().slice(0, 10); } catch { return "0"; }
  };
  const getRenewDaily = async () => {
    const d = await S.get(k.renewDaily, null);
    if (!d || typeof d !== "object" || d.date !== todayStr()) {
      return { date: todayStr(), count: 0 };
    }
    return { date: d.date, count: Number(d.count || 0) };
  };
  const bumpRenewDaily = async (n = 1) => {
    const cur = await getRenewDaily();
    cur.count += n;
    await S.set(k.renewDaily, cur);
    return cur.count;
  };

  const shouldResetRenewView = () => {
    const inDialogRoute = String(location.search || "").includes("is_routable_dialog=true");
    const inRelistRoute = String(location.pathname || "").startsWith("/marketplace/selling/relist_items");
    return inDialogRoute || inRelistRoute || hasNoMoreRelistMessage();
  };

  const getRenewSearchRoots = () => {
    const dialogs = QA('[role="dialog"], [aria-modal="true"]').filter(isVisible);
    return dialogs.length ? dialogs : [document.body];
  };

  const isSummaryRenewCard = (el) => {
    const card = el.closest('[role="button"], button, a, [role="link"], [data-visualcompletion], li, article, section, div');
    const t = normalize(card?.innerText || card?.textContent || "");
    if (!t) return false;
    return (
      t.includes("para renovar") ||
      t.includes("crear publicacion") ||
      t.includes("publicaciones vendidas y agotadas") ||
      t.includes("publicaciones activas") ||
      t.includes("estadisticas") ||
      t.includes("insights")
    );
  };

  const getMarketplaceActionButtons = () => {
    const roots = getRenewSearchRoots();
    const labeled = roots.flatMap((root) => QA(
      '[aria-label*="Eliminar y volver a publicar"], [aria-label*="Volver a publicar"], [aria-label*="Renovar"], [aria-label*="Delete and relist"], [aria-label*="Relist"], [aria-label*="Renew"]',
      root
    )).filter(isVisible);
    const actionables = roots.flatMap((root) => QA('button, [role="button"], a', root)).filter(isVisible);
    const textNodes = roots.flatMap((root) => QA('div[role="none"], span, div', root)).filter(isVisible);
    const out = [];
    const seen = new Set();

    const collectIfMatch = (el) => {
      const t = normActionText(el);
      if (!t) return;
      // Evitar falsos positivos de botones no relacionados
      if (
        t.includes("no renovar") ||
        t.includes("cannot renew") ||
        t.includes("no se puede") ||
        t.includes("cancelar") ||
        t.includes("cerrar")
      ) return;

      // Acciones permitidas en este flujo:
      // - Renovar
      // - Eliminar y volver a publicar
      const isRenew =
        t === "renovar" ||
        t.startsWith("renovar ") ||
        t.includes(" renovar ") ||
        t === "renew" ||
        t.startsWith("renew ");

      const isDeleteRelist =
        t.includes("eliminar y volver a publicar") ||
        t.includes("volver a publicar") ||
        t.includes("delete and relist") ||
        t.includes("relist");

      if (!(isRenew || isDeleteRelist)) return;
      // Importante: priorizar siempre controles accionables (role=button/button/a)
      const target = (el.matches('button, [role="button"], a')
        ? el
        : el.closest('button, [role="button"], a'));
      if (!target || !isVisible(target)) return;
      if (isSummaryRenewCard(target)) return;
      if (seen.has(target)) return;
      seen.add(target);
      out.push(target);
    };

    for (const el of labeled) collectIfMatch(el);
    for (const el of actionables) collectIfMatch(el);
    for (const el of textNodes) collectIfMatch(el);
    return out;
  };

  const runRenewListingsFlow = async () => {
    if (!isMarketplaceBulkActionPage() || renewFlowRunning) return;
    if (renewFinished) return;
    if (now() < renewCooldownUntil) return;
    renewFlowRunning = true;
    try {
      if (hasTemporaryBlockMessage()) {
        enabled = false;
        renewCooldownUntil = now() + (12 * 60 * 60 * 1000);
        log("[renew] bloqueo temporal detectado. Automatizacion pausada.");
        return;
      }

      // 🛡️ Respeta el tope diario antes de empezar la pasada
      const dailyStart = await getRenewDaily();
      if (dailyStart.count >= CFG.RENEW_DAILY_MAX_ACTIONS) {
        renewCooldownUntil = now() + CFG.RENEW_DAILY_CAP_COOLDOWN_MS;
        setRenewFinishedState(true);
        log("[renew] tope diario alcanzado (", dailyStart.count, "). Pausando renovación hasta mañana.");
        return;
      }

      let totalClicked = 0;
      let idleRounds = 0;

      for (let round = 0; round < 8; round++) {
        if (!enabled) {
          log("[renew] pausado por operador.");
          break;
        }

        const buttons = getMarketplaceActionButtons().filter((b) => !b.dataset.vzRenewClicked);
        if (buttons.length) {
          idleRounds = 0;
          for (const btn of buttons.slice(0, CFG.RENEW_MAX_ACTIONS_PER_PASS)) {
            if (!enabled) {
              log("[renew] pausa detectada durante el lote.");
              break;
            }
            btn.dataset.vzRenewClicked = "1";
            try {
              const label = normActionText(btn);
              clickSmart(btn);
              totalClicked += 1;
              const dailyCount = await bumpRenewDaily(1);
              log("[renew] click acción:", label || "(sin texto)", "total:", totalClicked, "hoy:", dailyCount);
              // 🛡️ Si tocamos el tope diario en medio del lote, cortamos en seco
              if (dailyCount >= CFG.RENEW_DAILY_MAX_ACTIONS) {
                renewCooldownUntil = now() + CFG.RENEW_DAILY_CAP_COOLDOWN_MS;
                setRenewFinishedState(true);
                log("[renew] tope diario alcanzado durante el lote (", dailyCount, "). Pausando.");
                return;
              }
            } catch {}
            await sleep(randBetween(CFG.RENEW_ACTION_DELAY_MIN_MS, CFG.RENEW_ACTION_DELAY_MAX_MS));
            if (hasTemporaryBlockMessage()) {
              enabled = false;
              renewCooldownUntil = now() + (12 * 60 * 60 * 1000);
              log("[renew] bloqueo detectado durante el lote. Automatizacion pausada.");
              return;
            }
          }
        } else {
          idleRounds += 1;
          if (idleRounds >= 2) break;
        }
        await sleep(randBetween(3000, 6500));
      }

      await sleep(1200);
      const closedDialog = await closeRenewCompletionDialogs();
      const shouldResetView = shouldResetRenewView();

      if (enabled && (totalClicked > 0 || shouldResetView)) {
        const reloadDelay = randBetween(CFG.RENEW_RELOAD_DELAY_MIN_MS, CFG.RENEW_RELOAD_DELAY_MAX_MS);
        renewCooldownUntil = now() + randBetween(CFG.RENEW_PASS_COOLDOWN_MIN_MS, CFG.RENEW_PASS_COOLDOWN_MAX_MS);
        setRenewFinishedState(true);
        log("[renew] lote finalizado.", closedDialog ? "Dialogo cerrado." : "Sin dialogo final.", shouldResetView ? "Forzando salida limpia." : "", "Navegando limpio en", reloadDelay, "ms");
        await sleep(reloadDelay);
        hardNavigateToRenewBase();
        return;
      } else {
        renewCooldownUntil = now() + randBetween(8000, 15000);
        if (hasNoMoreRelistMessage()) {
          setRenewFinishedState(true);
          log("[renew] fin detectado al cerrar lote: sin mas publicaciones para renovar.");
          hardNavigateToRenewBase();
          return;
        }
        else log("[renew] no hay botones 'Renovar' pendientes.");
      }
    } finally {
      renewFlowRunning = false;
    }
  };

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

  // 🔒 Anti cross-chat: ¿alguna señal del DOM/URL apunta a un hilo DISTINTO de tid?
  // (la URL cambia antes que el panel; el enlace aria-current refleja qué chat está seleccionado)
  const conflictsThread = (tid) => {
    const url = getCurrentThreadIdFromURL();
    const dom = getActiveThreadIdFromDOM();
    return !!((url && url !== tid) || (dom && dom !== tid));
  };
  // Confirmación POSITIVA de que el panel abierto es realmente el de tid (requisito para enviar)
  const isThreadActiveStrict = (tid) => {
    if (conflictsThread(tid)) return false;
    const url = getCurrentThreadIdFromURL();
    const dom = getActiveThreadIdFromDOM();
    return url === tid || dom === tid;
  };

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
        ['keydown', 'paste', 'beforeinput'].forEach(evt => {
          composer.addEventListener(evt, (e) => {
            if (!e?.isTrusted) return;
            if (evt === "keydown") {
              const k = String(e.key || "");
              if (!k || k.length > 1) return; // solo teclas de texto reales
            }
            operatorTypingUntil = now() + CFG.OPERATOR_PAUSE_MS;
            log("[composer] operador activo, pausando auto-respuesta");
          }, { capture: true });
        });
      } catch {}
    }

    return composer;
  };

  const emitEnter = (el) => {
    const base = { bubbles:true, cancelable:true, key:"Enter", code:"Enter", which:13, keyCode:13 };
    // Evita doble/triple envio: un solo evento Enter.
    el.dispatchEvent(new KeyboardEvent("keydown", base));
  };
  const shiftEnter = (el) => {
    const base = { bubbles:true, cancelable:true, key:"Enter", code:"Enter", which:13, keyCode:13, shiftKey:true };
    el.dispatchEvent(new KeyboardEvent("keydown", base));
  };
  const findSendButton = (composer) => {
    const selectors = [
      'div[role="button"][aria-label*="Enviar"]',
      'div[role="button"][aria-label*="Send"]',
      'button[aria-label*="Enviar"]',
      'button[aria-label*="Send"]'
    ].join(",");
    const list = QA(selectors).filter(isVisible);
    if (!list.length) return null;
    const cRect = composer?.getBoundingClientRect?.();
    if (!cRect) return list[0] || null;
    return list
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, d: Math.abs(r.left - cRect.right) + Math.abs(r.top - cRect.top) };
      })
      .sort((a, b) => a.d - b.d)[0]?.el || null;
  };
  const insertChunk = (el, chunk) => {
    const ok = document.execCommand("insertText", false, chunk);
    if (!ok) el.textContent = (el.textContent || "") + chunk;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // ✅ Escribe el texto por trozos con pausas (cadencia humana) en lugar de pegarlo de golpe.
  //    El tiempo total escala con el largo del mensaje, con un tope para respuestas muy largas.
  const typeLikeHuman = async (el, text) => {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");

    // ✅ Coloca foco + cursor DENTRO del cuadro antes de escribir.
    //    Sin esto, Facebook pierde el primer trozo del mensaje (faltaban los primeros caracteres).
    try { el.focus(); } catch {}
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // cursor al final del contenido
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
    await sleep(70); // pequeño respiro para que el editor registre el cursor

    // Estima el delay por trozo y escálalo hacia abajo si el mensaje es muy largo (respeta el tope total)
    const approxChunks = Math.max(1, Math.ceil(String(text).length / CFG.TYPING_CHUNK_MAX));
    let perChunkBase = randBetween(CFG.TYPING_DELAY_PER_CHUNK_MIN_MS, CFG.TYPING_DELAY_PER_CHUNK_MAX_MS);
    if (approxChunks * perChunkBase > CFG.TYPING_TOTAL_MAX_MS) {
      perChunkBase = Math.max(8, Math.floor(CFG.TYPING_TOTAL_MAX_MS / approxChunks));
    }

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let i = 0;
      while (i < line.length) {
        const size = randBetween(CFG.TYPING_CHUNK_MIN, CFG.TYPING_CHUNK_MAX);
        const chunk = line.slice(i, i + size);
        i += size;
        insertChunk(el, chunk);
        await sleep(Math.max(8, perChunkBase + randBetween(-15, 25)));
      }
      if (li < lines.length - 1) shiftEnter(el);
    }
  };
  const sendText = async (tid, text) => {
    if (!text) return false;

    // 🔒 ANTI CROSS-CHAT (1/2): solo escribir si el panel abierto es REALMENTE el de tid.
    //    Evita que la respuesta del chat B se escriba en el chat A (URL ya cambió pero el panel no).
    if (!isThreadActiveStrict(tid)) {
      log("[send] ABORTADO (cross-chat): el chat abierto no es", tid, "| url:", getCurrentThreadIdFromURL(), "dom:", getActiveThreadIdFromDOM());
      return false;
    }

    // Guard anti-duplicado: solo LECTURA aquí. Se MARCA más abajo, justo antes de enviar,
    // para que un aborto por cross-chat NO bloquee el reintento legítimo.
    const guardKey = k.byThread(tid, "recent_send_guard");
    const norm = normalize(text).slice(0, 240);
    const prev = await S.get(guardKey, null);
    if (prev && String(prev.text || "") === norm && (now() - Number(prev.at || 0) < CFG.SEND_GUARD_MS)) {
      log("[send] bloqueado por guard anti-duplicado", tid);
      return false;
    }

    const composer = findComposer(); if (!composer) return false;

    // 🔒 ESTABILIZACIÓN: el panel puede estar terminando de cambiar. Esperamos un poco y
    //    confirmamos que (a) seguimos en tid y (b) el cuadro de texto NO se re-montó.
    //    Si el elemento cambió, el chat aún se está cargando → abortamos y se reintenta.
    await sleep(CFG.SEND_STABILIZE_MS);
    if (!isThreadActiveStrict(tid)) {
      log("[send] ABORTADO: el chat cambió durante la estabilización", tid);
      return false;
    }
    const composerNow = findComposer();
    if (!composerNow || composerNow !== composer) {
      log("[send] cuadro de texto aún inestable (panel cargando), reintentando", tid);
      return false;
    }

    sendCooldownUntil.set(tid, now()+CFG.SEND_COOLDOWN_MS);
    await typeLikeHuman(composerNow, text);
    await sleep(randBetween(150, 400));

    // 🔒 ANTI CROSS-CHAT (2/2): el tecleo tarda segundos; re-verifica que seguimos en tid
    //    ANTES de pulsar enviar. Si el chat cambió, no enviamos (se reintentará en el correcto).
    if (!isThreadActiveStrict(tid)) {
      log("[send] ABORTADO antes de enviar: el chat cambió | activo:", getActiveTid(), "esperado:", tid);
      return false;
    }

    // Ya estamos comprometidos a enviar: marca el guard anti-duplicado ahora.
    await S.set(guardKey, { text: norm, at: now() });

    const sendBtn = findSendButton(composerNow);
    if (sendBtn) clickSmart(sendBtn);
    else emitEnter(composerNow);
    // 🛡️ Anti-ráfaga: separa este envío del siguiente a nivel de TODA la cuenta
    globalSendReadyAt = now() + randBetween(CFG.GLOBAL_SEND_MIN_GAP_MS, CFG.GLOBAL_SEND_MAX_GAP_MS);
    return true;
  };

  /* ===== Última burbuja (MEJORADO) ===== */
  // Raíz del PANEL de mensajes del chat abierto. Clave: NUNCA caer en document.body,
  // porque entonces se leerían las filas de la lista lateral de chats como si fueran mensajes
  // (el bug de Marketplace, donde el aria-label del grid no coincide con el de Messenger normal).
  // Panel del hilo abierto (contiene mensajes + cuadro de texto, NUNCA la lista lateral de chats)
  const getThreadPanel = () => {
    const composer = Q('div[contenteditable="true"][role="textbox"]');
    return (composer && composer.closest('[role="main"]')) || Q('[role="main"]') || null;
  };

  const getThreadGridRoot = () => {
    // 1) Por aria-label (varía según idioma)
    const byLabel =
      Q('[role="grid"][aria-label*="Mensajes de la conversación"]') ||
      Q('[role="grid"][aria-label*="Messages in conversation"]') ||
      Q('[data-pagelet="MWV2MessageList"] [role="grid"]');
    if (byLabel) return byLabel;
    // 2) El grid dentro del panel del cuadro de texto (excluye la barra lateral)
    const panel = getThreadPanel();
    if (panel) {
      const g = panel.querySelector('[role="grid"]');
      if (g) return g;
      return panel; // sin grid reconocible (Marketplace): usamos el panel directo
    }
    // 3) Fallback acotado a [role="main"] (jamás document.body)
    return Q('[role="main"] [role="grid"]') || Q('[role="main"]') || document.body;
  };

  // 🔽 Baja el chat hasta el fondo para que el ÚLTIMO mensaje sea siempre el más reciente.
  //    Sin esto, si el chat no está scrolleado abajo, el bot puede leer su propia respuesta
  //    vieja como si fuera el último mensaje (y creer que no hay nada nuevo). Si ya está
  //    abajo, asignar scrollTop = scrollHeight no hace nada (sin parpadeo).
  const scrollThreadToBottom = () => {
    try {
      let el = getThreadGridRoot();
      for (let i = 0; i < 6 && el && el !== document.body; i++) {
        if (el.scrollHeight > el.clientHeight + 20) { el.scrollTop = el.scrollHeight; return; }
        el = el.parentElement;
      }
    } catch {}
  };

  // 🔁 Plan B (p.ej. Marketplace): sin "filas" reconocibles, deduce el último mensaje
  //    tomando el texto dir="auto" visualmente MÁS ABAJO del panel del hilo (= último mensaje).
  const getLastBubbleFallback = () => {
    const root = getThreadPanel() || getThreadGridRoot();
    if (!root) return null;
    const nodes = QA('div[dir="auto"], span[dir="auto"]', root).filter(n =>
      isVisible(n) &&
      !n.closest('[role="button"], button, [contenteditable="true"], [data-scope="date_break"]') &&
      (n.innerText || n.textContent || "").trim()
    );
    if (!nodes.length) return null;
    let best = null, bestTop = -Infinity;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.top > bestTop) { bestTop = r.top; best = n; }
    }
    if (!best) return null;
    const text = (best.innerText || best.textContent || "").trim().replace(/[ \t]+/g, " ");
    if (!text || isLikelySystem(text)) return null;
    const r = best.getBoundingClientRect();
    // Dirección por geometría usando como referencia el CUADRO DE TEXTO (ocupa el ancho del panel
    // del chat), NO la ventana completa. Así un mensaje del cliente (izquierda del panel) no se
    // confunde con uno propio solo porque el panel esté en la mitad derecha de la pantalla.
    const composerEl = Q('div[contenteditable="true"][role="textbox"]');
    const refRect = composerEl ? composerEl.getBoundingClientRect() : root.getBoundingClientRect();
    const refCenter = refRect.left + refRect.width / 2;
    const bubbleCenter = r.left + r.width / 2;
    const dir = isOutHint(text) ? "out" : (bubbleCenter > refCenter ? "out" : "in");
    // Huella ESTABLE (solo texto + dirección). NO incluimos el nº de nodos porque fluctúa
    // mientras FB carga el chat y haría que la huella cambiara en cada lectura.
    const hash = djb2(`${dir}|fb:${normalize(text)}`);
    log("[bubble] usando plan B (Marketplace):", text.slice(0, 40), "dir:", dir);
    return { text, dir, count: 1, hash };
  };

  const getLastBubbleInfo = () => {
    const gridRoot = getThreadGridRoot();
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
        const stableSig = msgId ? `out|id:${msgId}` : `out|txt:${normalize(text)}|n:${count}`;
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

      // Si FB no expone message-id, agregamos count para diferenciar mensajes repetidos (ej: "hola" dos veces).
      const stableSig = msgId ? `${dir}|id:${msgId}` : `${dir}|txt:${normalize(text)}|n:${count}`;
      const hash = djb2(stableSig);
      return { text, dir, count, hash };
    }
    // Nada encontrado por el método normal → intentar plan B (Marketplace)
    const fb = getLastBubbleFallback();
    if (fb) return fb;
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
  // Historial de la conversación con el agente IA por chat (memoria, para no re-saludar)
  const aiHistoryKey        = (tid)=> k.byThread(tid,"ai_history");
  // Nº de respuestas que la IA ya envió en este chat (para el tope por chat)
  const aiReplyCountKey     = (tid)=> k.byThread(tid,"ai_reply_count");

  // Agente IA con UN solo prompt + memoria por chat: la IA decide todo (saludo, preguntas,
  // cuándo dar el contacto, seguir conversando) según las instrucciones que escribe el usuario.
  const buildAiReply = async (tid, incomingText) => {
    // Tope de respuestas por chat: si ya llegó al máximo, no responde más.
    const replyCount = Number(await S.get(aiReplyCountKey(tid), 0));
    if (aiMaxReplies > 0 && replyCount >= aiMaxReplies) {
      log("[ai] tope de", aiMaxReplies, "respuestas por chat alcanzado:", tid);
      return null;
    }

    let history = await S.get(aiHistoryKey(tid), []);
    if (!Array.isArray(history)) history = [];
    history.push({ role: "user", content: String(incomingText || "").slice(0, 600) });
    if (history.length > 12) history = history.slice(-12);

    let reply = await callOpenAI(history);
    if (!reply) {
      // Respaldo solo en el primer contacto (si la IA falla por key/red); luego, no respondemos.
      const noBotYet = !history.some(m => m.role === "assistant");
      if (noBotYet) reply = pickGreeting();
      else return null;
    }
    history.push({ role: "assistant", content: reply });
    if (history.length > 12) history = history.slice(-12);
    await S.set(aiHistoryKey(tid), history);
    await S.set(aiReplyCountKey(tid), replyCount + 1);
    return { text: reply, label: "IA" };
  };

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
    if (tid === getActiveTid()) {
      log("[queue] tid activo detectado en sidebar, ignorando:", tid);
      return;
    }
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

    // 🔑 Facebook marcó el chat como NO LEÍDO ⇒ hay un mensaje nuevo. Limpiamos el dedup
    //    por si el texto coincide con uno ya respondido antes (ej. "hola" repetido),
    //    para que SÍ se responda. La señal de "no leído" es más fiable que la huella del texto.
    S.set(lastIncomingHashKey(tid), "");
    log("[queue] no leído nuevo → dedup limpiado para responder:", tid);

    enqueueTid(tid, "sidebar-unread");
  };

  // Para chat activo: re-usable, sin depender de unreadSeen
  const enqueueActiveTid = (tid) => {
    enqueueTid(tid, "active-chat");
  };

  const processQueueSoon = () => { if (!processing) setTimeout(processQueue, 20); };

  const scheduleHumanReplyDelay = (tid, hash) => {
    const delay = randBetween(CFG.HUMAN_REPLY_DELAY_MIN_MS, CFG.HUMAN_REPLY_DELAY_MAX_MS);
    const readyAt = now() + delay;
    pendingReplyHash.set(tid, String(hash));
    pendingReplyReadyAt.set(tid, readyAt);
    log("[reply] demora humana programada:", tid, "en", delay, "ms");
    return readyAt;
  };

  const clearPendingReplyDelay = (tid) => {
    pendingReplyHash.delete(tid);
    pendingReplyReadyAt.delete(tid);
  };

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

    // 🔒 Si el DOM/URL apunta a otro hilo, el panel aún no terminó de cambiar a tid:
    //    NO leemos ni respondemos todavía (evita leer/responder el chat equivocado).
    if (conflictsThread(tid)) {
      log("[reply] panel aún no confirmado para", tid, "→ esperando swap del DOM");
      return { done: false, wait: 500 };
    }

    // 🔽 Aseguramos estar al fondo para leer el mensaje MÁS reciente (no una respuesta vieja)
    scrollThreadToBottom();

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

    // El último mensaje es del bot (su propia respuesta): ya respondió.
    // Reseteamos el "ya atendido" para que el PRÓXIMO entrante (aunque diga lo mismo) sea nuevo.
    if (dir === "out") {
      await S.set(lastIncomingHashKey(tid), "");
      return { done: true };
    }

    // ¿ya atendido este mensaje?
    const lastIn = await S.get(lastIncomingHashKey(tid), "");
    if (String(lastIn) === String(hash)) return { done: true };

    const pendingHash = pendingReplyHash.get(tid);
    const pendingReady = Number(pendingReplyReadyAt.get(tid) || 0);
    if (String(pendingHash || "") !== String(hash)) {
      const readyAt = scheduleHumanReplyDelay(tid, hash);
      return { done: false, wait: Math.max(500, readyAt - now()) };
    }
    if (now() < pendingReady) {
      return { done: false, wait: Math.max(500, pendingReady - now()) };
    }

    // Operador escribiendo → no auto-responder
    if (now() < operatorTypingUntil) {
      log("[reply] operador escribiendo, posponiendo auto-respuesta", tid);
      return { done: false, wait: 1200 };
    }

    // 🛡️ Throttle GLOBAL por cuenta: evita ráfagas de envíos entre chats distintos
    if (now() < globalSendReadyAt) {
      const wait = globalSendReadyAt - now();
      log("[reply] throttle global activo, esperando", wait, "ms antes de responder", tid);
      return { done: false, wait: Math.max(500, wait) };
    }

    const trackedHash = await S.get(lastTrackedIncomingKey(tid), "");
    if (String(trackedHash) !== String(hash)) {
      await trackIncoming(tid, text);
      await S.set(lastTrackedIncomingKey(tid), hash);
    }

    // Respuesta: por Agente IA (si está activo) o por Reglas
    let reply = null;
    let matchedRuleId = "fallback";
    let matchedRuleLabel = "Fallback";
    let aiNextStage = null;

    if (aiEnabled) {
      // Agente IA: 1º saludo con pregunta (sin contacto), 2º envía contacto, después nada.
      const aiRes = await buildAiReply(tid, text);
      if (aiRes && aiRes.text) {
        reply = aiRes.text;
        matchedRuleId = "ai";
        matchedRuleLabel = aiRes.label || "IA";
        aiNextStage = aiRes.stage;
      }
    } else {
      for (const rule of compiledRules) {
        if (rule.re.test(text)) {
          reply = rule.reply;
          matchedRuleId = rule.id;
          matchedRuleLabel = rule.label;
          break;
        }
      }
      if (!reply && CFG.DEFAULT_FALLBACK) reply = CFG.DEFAULT_FALLBACK;
    }

    if (!reply) {
      clearPendingReplyDelay(tid);
      await S.set(lastIncomingHashKey(tid), hash);
      return { done: true };
    }

    const thisHash = djb2(reply);

    const ok = await sendText(tid, reply);
    if (ok) {
      const ts = now();
      const handledIncomingHash = hash;
      clearPendingReplyDelay(tid);
      
      // Esperar a que Facebook renderice la burbuja
      await sleep(300); // Reducido de 500ms a 300ms
      
      // Obtener el hash de la burbuja que acabamos de crear
      const { hash: newBubbleHash } = getLastBubbleInfo();
      
      await S.set(lastReplyAtKey(tid), ts);
      await S.set(lastIncomingHashKey(tid), handledIncomingHash);
      await S.set(lastSentHashKey(tid), thisHash);
      await S.set(lastSentContentKey(tid), reply);
      if (aiNextStage != null) await S.set(aiStageKey(tid), aiNextStage); // avanza la etapa del agente IA
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

    // Verificación adicional: si es "out" lo ignoramos siempre.
    // Además: como el bot ya respondió, reseteamos el "ya atendido" y marcamos esta burbuja
    // como vista, para que el PRÓXIMO entrante (aunque diga lo mismo) se trate como nuevo.
    if (dir === "out") {
      await S.set(lastIncomingHashKey(tid), "");
      lastBubbleHashMem.set(tid, hash);
      log("[active-chat] mensaje es 'out', ignorando");
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
    clearPendingReplyDelay(tid);

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
        scrollThreadToBottom(); // leer el mensaje más reciente, no una respuesta vieja
        await sleep(120);
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
        if (!isMarketplaceBulkActionPage()) setRenewFinishedState(false);
        lastPath = location.pathname;
        const tid = getActiveTid();
        onThreadChanged(tid);
      }
    }, 300);
  };

  /* ===== Loop principal ===== */
  const tick = async () => {
    if (!enabled) return;
    if (isMarketplaceBulkActionPage()) {
      await runRenewListingsFlow();
      return;
    }

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
      if (tid === activeTid) continue;
      if (!unreadSeen.has(tid)) enqueueTidOnce(tid);
    }
    for (const tid of [...unreadSeen]) {
      if (!unreadTids.includes(tid)) unreadSeen.delete(tid);
    }

    // 3) Procesar cola
    if (queue.length && !processing) processQueueSoon();
    await processScheduledFollowups();

    // 4) Auto-navegación: abrir un NO leído (DISTINTO del activo) para procesarlo.
    //    Con enfriamiento + exclusión del chat activo para no entrar en bucle si no se resuelve.
    //    NO navegamos si hay una respuesta programada (evita rebotar entre 2 chats y dejar a
    //    medias el que estaba a punto de responder).
    if (CFG.AUTO_NAVIGATE_ON_UNREAD === true && !queue.length && pendingReplyReadyAt.size === 0 && now() >= autoNavCooldownUntil) {
      const target = unreadTids.find(t => t && t !== activeTid && !inFlightPerThread.has(t));
      if (target) {
        autoNavCooldownUntil = now() + CFG.AUTO_NAV_COOLDOWN_MS;
        log("[tick] Abriendo hilo no leído automáticamente:", target);
        openThreadById(target);
      }
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

        // 🛡️ Respeta el throttle global por cuenta también para los seguimientos
        if (now() < globalSendReadyAt) return;

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

  /* ===== Ajustes configurables desde la UI ===== */
  // Mapea cada clave de la UI a un campo de CFG y su factor de escala (segundos→ms, o 1 para conteos)
  const SETTINGS_MAP = {
    replyDelayMin:  ["HUMAN_REPLY_DELAY_MIN_MS", 1000],
    replyDelayMax:  ["HUMAN_REPLY_DELAY_MAX_MS", 1000],
    globalGapMin:   ["GLOBAL_SEND_MIN_GAP_MS", 1000],
    globalGapMax:   ["GLOBAL_SEND_MAX_GAP_MS", 1000],
    renewPerPass:   ["RENEW_MAX_ACTIONS_PER_PASS", 1],
    renewActionMin: ["RENEW_ACTION_DELAY_MIN_MS", 1000],
    renewActionMax: ["RENEW_ACTION_DELAY_MAX_MS", 1000],
    renewDailyMax:  ["RENEW_DAILY_MAX_ACTIONS", 1],
  };

  // Aplica en caliente los ajustes guardados sobre CFG (no requiere recargar)
  const applySettingsToCfg = (s) => {
    if (!s || typeof s !== "object") return;
    for (const key in SETTINGS_MAP) {
      if (s[key] == null) continue;
      const [cfgKey, scale] = SETTINGS_MAP[key];
      const num = Number(s[key]);
      if (!Number.isFinite(num) || num < 0) continue;
      CFG[cfgKey] = Math.round(num * scale);
    }
  };

  // Devuelve los valores actuales en unidades de UI (segundos / conteos) + la URL de la hoja
  const getSettings = async () => {
    const saved = (await S.get(SETTINGS_KEY, null)) || {};
    const out = {};
    for (const key in SETTINGS_MAP) {
      const [cfgKey, scale] = SETTINGS_MAP[key];
      out[key] = saved[key] != null ? Number(saved[key]) : (CFG[cfgKey] / scale);
    }
    out.sheetUrl = String(saved.sheetUrl || "");
    out.aiEnabled = !!saved.aiEnabled;
    out.openaiKey = String(saved.openaiKey || "");
    out.openaiModel = String(saved.openaiModel || openaiModel);
    out.aiMaxReplies = Number(saved.aiMaxReplies != null ? saved.aiMaxReplies : aiMaxReplies);
    out.aiSystemPrompt = String(saved.aiSystemPrompt || aiSystemPrompt); // vacío → vuelve al prompt por defecto
    return out;
  };

  // Sanea, garantiza min<=max por par, persiste (fusionando con lo previo) y aplica
  const saveSettings = async (obj) => {
    const clean = {};
    for (const key in SETTINGS_MAP) {
      const num = Number(obj?.[key]);
      if (Number.isFinite(num) && num >= 0) clean[key] = num;
    }
    const pairs = [["replyDelayMin","replyDelayMax"],["globalGapMin","globalGapMax"],["renewActionMin","renewActionMax"]];
    for (const [mn, mx] of pairs) {
      if (clean[mn] != null && clean[mx] != null && clean[mn] > clean[mx]) clean[mx] = clean[mn];
    }
    if (obj && typeof obj.sheetUrl === "string") clean.sheetUrl = obj.sheetUrl.trim();
    // Campos del agente IA
    if (obj && typeof obj.aiEnabled === "boolean") clean.aiEnabled = obj.aiEnabled;
    if (obj && typeof obj.openaiKey === "string") clean.openaiKey = obj.openaiKey.trim();
    if (obj && typeof obj.openaiModel === "string") clean.openaiModel = obj.openaiModel.trim();
    if (obj && obj.aiMaxReplies != null && Number.isFinite(Number(obj.aiMaxReplies))) clean.aiMaxReplies = Math.max(0, Math.floor(Number(obj.aiMaxReplies)));
    if (obj && typeof obj.aiSystemPrompt === "string") clean.aiSystemPrompt = obj.aiSystemPrompt;

    // Fusiona con lo ya guardado para no borrar campos no enviados
    const prev = (await S.get(SETTINGS_KEY, null)) || {};
    const merged = { ...prev, ...clean };
    await S.set(SETTINGS_KEY, merged);
    applySettingsToCfg(merged);
    sheetWebhookUrl = String(merged.sheetUrl || "");
    applyAiSettings(merged);
    log("[settings] guardados y aplicados", merged);
    return merged;
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
      }),
      onGoMessenger: () => { location.href = "https://www.facebook.com/messages/"; },
      onGoRenew: () => {
        setRenewFinishedState(false);
        location.href = "https://www.facebook.com/marketplace/selling/renew_listings/";
      },
      onOpenSettings: () => window.VZUI.openSettingsModal({
        loadSettings: () => getSettings(),
        saveSettings: (obj) => saveSettings(obj)
      }),
      onOpenAi: () => window.VZUI.openAiModal({
        loadSettings: () => getSettings(),
        saveSettings: (obj) => saveSettings(obj)
      })
    });
  };

  /* ===== Init ===== */
  const init = async () => {
    renewFinished = getRenewFinishedState();
    try {
      const r = await S.get(k.rules, null);
      rules = r ? JSON.parse(r) : DEFAULT_RULES.slice();
    } catch {
      rules = DEFAULT_RULES.slice();
    }
    compiledRules = compileAll(rules);

    // Carga y aplica los ajustes guardados por el usuario sobre CFG (+ URL de la hoja)
    try {
      const savedSettings = (await S.get(SETTINGS_KEY, null)) || {};
      applySettingsToCfg(savedSettings);
      sheetWebhookUrl = String(savedSettings.sheetUrl || "");
      applyAiSettings(savedSettings);
    } catch {}

    bindUI();
    if (!isAutomationPage()) return;

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
    const ver = (() => { try { return chrome?.runtime?.getManifest?.().version || "?"; } catch { return "?"; } })();
    log("Bot listo v" + ver + ". Hilo:", currentTid, "Baseline establecida");
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

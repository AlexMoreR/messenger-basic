// ui.js — Panel visual de reglas (simple, con modo "Cualquiera") para VZ-Bot
// - Sin dependencias externas
// - Guarda UI propia en __vz_rules_ui y publica reglas compiladas en __vz_rules_json
// - Compatible con content.js existente (usa window.VZUI.injectTopBar / openRulesModal)

(() => {
  "use strict";

  /* =========================
     Helpers
  ========================== */
  const Q  = (sel, r=document) => r.querySelector(sel);
  const QA = (sel, r=document) => Array.from(r.querySelectorAll(sel));
  const cssOnce = (id, css) => {
    if (Q("#"+id)) return;
    const s = document.createElement("style");
    s.id = id; s.textContent = css; document.documentElement.appendChild(s);
  };
  const S = {
    async get(key, fallback=null){
      try { if (chrome?.storage?.local){ const o = await chrome.storage.local.get(key); return o?.[key] ?? fallback; } } catch {}
      try { const raw = localStorage.getItem(key); return raw===null?fallback:JSON.parse(raw); } catch { return fallback; }
    },
    async set(key, val){
      try { if (chrome?.storage?.local){ await chrome.storage.local.set({[key]:val}); return; } } catch {}
      localStorage.setItem(key, typeof val==="string" ? val : JSON.stringify(val));
    }
  };
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const now = () => Date.now();

  /* =========================
     Estilos
  ========================== */
  cssOnce("vz-ui-simple-css", `
  #vz-topbar{all:initial}
  .vz-wrap{position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.45); backdrop-filter: blur(2px);}
  .vz-dialog{width:min(1000px,96vw); max-height:92vh; background:#0f0f12; color:#fff; border:1px solid rgba(255,255,255,.08); border-radius:14px; box-shadow:0 24px 80px rgba(0,0,0,.35); display:flex; flex-direction:column;}
  .vz-hd{display:flex; gap:10px; align-items:center; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,.08);}
  .vz-ttl{font:600 15px/1.2 system-ui, -apple-system, Segoe UI, Roboto}
  .vz-sp{flex:1}
  .vz-btn{background:#1f2937; border:none; color:#fff; border-radius:10px; padding:8px 10px; font:500 13px system-ui; cursor:pointer}
  .vz-btn:hover{filter:brightness(1.1)}
  .vz-btn.pr{background:#22c55e}
  .vz-btn.ghost{background:#374151}
  .vz-btn.icon{padding:6px; width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; border-radius:8px}
  .vz-btn.icon svg{width:16px; height:16px; display:block}
  .vz-icon{fill:#fff; opacity:.9}
  .vz-icon.warn{fill:#fff}
  .vz-bd{display:grid; grid-template-columns:280px 1fr; gap:0; min-height:0}
  .vz-colL{border-right:1px solid rgba(255,255,255,.06); padding:12px; display:flex; flex-direction:column; gap:10px; min-height:0}
  .vz-colR{padding:12px; min-height:0; display:flex; flex-direction:column; gap:10px}
  .vz-field{display:flex; flex-direction:column; gap:6px}
  .vz-label{font:600 12px system-ui; opacity:.9}
  .vz-input,.vz-select,.vz-textarea{background:#17171b; border:1px solid rgba(255,255,255,.12); color:#fff; border-radius:10px; padding:8px 10px; font:13px system-ui; outline:none}
  .vz-input:focus,.vz-select:focus,.vz-textarea:focus{border-color:#7c3aed}
  .vz-textarea{min-height:90px; resize:vertical}
  .vz-list{display:flex; flex-direction:column; gap:10px; overflow:auto; min-height:0}
  .vz-card{background:#121216; border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px; display:flex; gap:10px}
  .vz-cardTitle{font:600 12px system-ui; opacity:.8}
  .vz-row{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
  .vz-templateRow{display:flex; gap:6px; flex-wrap:wrap}
  .vz-reorder{display:flex; gap:4px}
  .vz-note{font:12px system-ui; opacity:.75}
  .vz-tester{background:#0d0d11; border:1px dashed rgba(255,255,255,.12); border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:8px}
  .vz-hit{border-left:3px solid #22c55e; padding-left:8px}
  .vz-nohit{border-left:3px solid #ef4444; padding-left:8px}
  .vz-chip{display:inline-flex; gap:6px; align-items:center; background:#1f2937; border:1px solid rgba(255,255,255,.08); color:#fff; padding:6px 10px; border-radius:999px; font:12px system-ui; cursor:pointer}
  .vz-newpulse{outline:2px solid #22c55e; box-shadow:0 0 0 0 rgba(34,197,94,.6); animation:vzPulse 1.1s ease-out 2}
  @keyframes vzPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}100%{box-shadow:0 0 0 14px rgba(34,197,94,0)}}
  `);

  /* =========================
     Estado y conversión
  ========================== */
  const UI_KEY = "__vz_rules_ui";

  // Modelo UI por regla
  // { enabled, mode, text, rawRegex, reply }
  let uiRules = [];
  let filterText = "";
  let panelOpen = false;

  const templates = [
    { label:"Saludo",   prefill:{ enabled:true, mode:"Regex",   rawRegex:"^(hola|buen[oa]s|saludos)\\b", text:"", reply:"¡Hola! 😊\n\nCuéntame un poco más para ayudarte." } },
    { label:"Precio",   prefill:{ enabled:true, mode:"Regex",   rawRegex:"precio|valor|cu[aá]nto cuesta|costo", text:"", reply:"Nuestros precios varían según el producto/servicio.\n¿De qué producto te interesa saber el precio?" } },
    { label:"Horarios", prefill:{ enabled:true, mode:"Regex",   rawRegex:"(?:\\b|\\s)(horario|hora|atienden)(?:\\b|\\s)", text:"", reply:"Horario de atención:\nLun–Vie: 8:00–18:00\nSáb: 9:00–13:00" } },
    { label:"Envíos",   prefill:{ enabled:true, mode:"Regex",   rawRegex:"env[ií]o|entrega|domicilio", text:"", reply:"¡Sí! Realizamos envíos. ¿Cuál es tu ciudad o dirección aproximada para cotizar?" } },
    { label:"Nombre",   prefill:{ enabled:true, mode:"Regex",   rawRegex:"\\b(soy|me llamo)\\s+([a-záéíóúñ]+)\\b", text:"", reply:"¡Mucho gusto! 😊 ¿En qué te ayudo?" } },
    // Plantilla modo "Cualquiera"
    { label:"Cualquiera", prefill:{ enabled:true, mode:"Cualquiera", text:"", rawRegex:"", reply:"Gracias por tu mensaje 🙌\n\nEn un momento un asesor revisará tu consulta." } },
  ];

  // Exporta al motor: SIEMPRE insensible a mayúsculas (flag i)
  function compileForEngine(list){
    const out = [];
    for (const r of list) {
      if (!r.enabled) continue;
      let pattern = "";
      const mode = r.mode || "Contiene";

      if (mode === "Cualquiera") {
        // Cualquier mensaje (no vacío). Internamente usamos [\s\S]+
        pattern = "[\\s\\S]+";
      } else if (mode === "Regex") {
        pattern = String(r.rawRegex || "").trim();
        if (!pattern) continue;
      } else {
        const esc = escapeRegExp(String(r.text||""));
        if (!esc) continue;
        switch(mode){
          case "Contiene":   pattern = esc; break;
          case "Empieza":    pattern = `^${esc}`; break;
          case "Termina":    pattern = `${esc}$`; break;
          case "Igual a":    pattern = `^${esc}$`; break;
          default:           pattern = esc;
        }
      }

      const flags = "i"; // case-insensitive
      out.push({ pattern, flags, reply: String(r.reply||"") });
    }
    return out;
  }

  // Intento de inflar desde compilado previo
  function inflateFromCompiled(compiled){
    const arr = [];
    for (const r of (compiled || [])) {
      const patt = String(r.pattern||"");
      let mode = "Regex";
      let text = "";
      let rawRegex = patt;

      // Detectar "Cualquiera" viniendo de [\s\S]+
      if (patt === "[\\s\\S]+") {
        mode = "Cualquiera";
        text = "";
        rawRegex = "";
      }
      else if (/^\^.*\$$/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(1,-1))) {
        mode = "Igual a"; text = patt.slice(1,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (/^\^.+/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(1))) {
        mode = "Empieza"; text = patt.slice(1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (/.+\$$/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(0,-1))) {
        mode = "Termina"; text = patt.slice(0,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (!/[.*+?()|[\]\\^$]/.test(patt)) {
        mode = "Contiene"; text = patt;
      }

      arr.push({
        enabled: true,
        mode,
        text,
        rawRegex,
        reply: String(r.reply||"")
      });
    }
    return arr;
  }

  /* =========================
     Panel UI
  ========================== */
  function openRulesPanel({ loadRules, saveRules }){
    if (panelOpen) return;
    panelOpen = true;

    const id = "vz-panel-wrap";
    Q("#"+id)?.remove();

    const wrap = document.createElement("div");
    wrap.className = "vz-wrap"; wrap.id = id;

    const dlg = document.createElement("div");
    dlg.className = "vz-dialog";

    /* Header */
    const hd  = document.createElement("div"); hd.className = "vz-hd";
    const ttl = document.createElement("div"); ttl.className = "vz-ttl"; ttl.textContent = "Reglas del chatbot (prioridad de arriba hacia abajo)";
    const sp  = document.createElement("div"); sp.className = "vz-sp";

    const btnClose = mkBtn("Cerrar", "ghost");
    btnClose.onclick = () => { wrap.remove(); panelOpen = false; };

    const btnExport = mkBtn("Exportar JSON", "ghost");
    btnExport.onclick = async () => {
      const compiled = compileForEngine(uiRules);
      const blob = new Blob([JSON.stringify(compiled, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `vz-rules-${Date.now()}.json`;
      a.click(); setTimeout(()=>URL.revokeObjectURL(url), 5000);
    };

    const btnPublish = mkBtn("Guardar y activar", "pr");
    btnPublish.title = "Publica las reglas al motor (content.js) respetando el orden y solo las activas";
    btnPublish.onclick = async () => {
      const compiled = compileForEngine(uiRules);
      await saveRules(JSON.stringify(compiled, null, 2));
      await S.set(UI_KEY, uiRules);
      flash(btnPublish, "Guardado");
    };

    hd.append(ttl, sp, btnExport, btnPublish, btnClose);

    /* Body (2 columnas) */
    const bd  = document.createElement("div"); bd.className = "vz-bd";
    const L   = document.createElement("div"); L.className   = "vz-colL";
    const R   = document.createElement("div"); R.className   = "vz-colR";

    // Izquierda: buscar + plantillas + tester
    const searchField = field("Buscar", input({placeholder:"filtra por texto o respuesta…"}));
    const search = searchField.querySelector("input");
    search.oninput = () => { filterText = String(search.value||"").toLowerCase().trim(); renderList(); };

    const addRow = document.createElement("div"); addRow.className = "vz-templateRow";
    const btnAddEmpty = mkBtn("+ Nueva regla");
    btnAddEmpty.onclick = () => addRule();

    addRow.append(btnAddEmpty);
    for (const t of templates) {
      const b = mkBtn(t.label, "ghost");
      b.onclick = () => addRule(t.prefill);
      addRow.append(b);
    }

    const tester = testerBox();

    L.append(searchField, addRow, tester);

    // Derecha: lista
    const listWrap = document.createElement("div"); listWrap.className = "vz-list";
    R.append(listWrap);

    bd.append(L, R);
    dlg.append(hd, bd);
    wrap.append(dlg);
    document.documentElement.append(wrap);

    // Cerrar por fondo / ESC
    wrap.addEventListener("click", (e)=>{ if (e.target === wrap){ wrap.remove(); panelOpen=false; }});
    wrap.addEventListener("keydown", (e)=>{ if (e.key==="Escape"){ e.preventDefault(); wrap.remove(); panelOpen=false; }});

    // Carga
    (async () => {
      const uiSaved = await S.get(UI_KEY, null);
      if (Array.isArray(uiSaved) && uiSaved.length) {
        uiRules = uiSaved;
      } else {
        try {
          const compiled = JSON.parse(await loadRules());
          uiRules = inflateFromCompiled(compiled);
        } catch {
          uiRules = [];
        }
        await S.set(UI_KEY, uiRules);
      }
      renderList();
    })();

    /* ====== funciones internas ====== */
    function renderList(){
      listWrap.innerHTML = "";
      const term = filterText;
      let view = uiRules.map((it, idx) => ({...it, _idx:idx}));
      if (term) {
        view = view.filter(r =>
          String(r.text||"").toLowerCase().includes(term) ||
          String(r.rawRegex||"").toLowerCase().includes(term) ||
          String(r.reply||"").toLowerCase().includes(term)
        );
      }
      if (!view.length){
        const empty = document.createElement("div");
        empty.className = "vz-note"; empty.textContent = "No hay reglas (o el filtro no coincide).";
        listWrap.append(empty);
        return;
      }
      for (const r of view) listWrap.append(ruleCard(r));
    }

    function ruleCard(r){
      const i = r._idx;
      const card = document.createElement("div"); card.className = "vz-card";

      // Col izquierda: ON/OFF + prioridad + mover
      const left = document.createElement("div");
      left.style.display="flex"; left.style.flexDirection="column"; left.style.gap="8px"; left.style.alignItems="center"; left.style.minWidth="70px";

      const enChk = document.createElement("input"); enChk.type="checkbox"; enChk.checked = !!uiRules[i].enabled;
      enChk.onchange = () => { uiRules[i].enabled = enChk.checked; saveDraft(); };

      const prio = document.createElement("div"); prio.textContent = `#${i+1}`; prio.style.opacity=.7; prio.style.font="600 12px system-ui";

      const reorder = document.createElement("div"); reorder.className="vz-reorder";
      const up = mkIconBtn(svgChevronUp(), "Subir prioridad", "#374151");
      const down = mkIconBtn(svgChevronDown(), "Bajar prioridad", "#374151");
      up.onclick = () => { if (i>0){ const t=uiRules[i]; uiRules.splice(i,1); uiRules.splice(i-1,0,t); saveDraft(); renderList(); } };
      down.onclick = () => { if (i<uiRules.length-1){ const t=uiRules[i]; uiRules.splice(i,1); uiRules.splice(i+1,0,t); saveDraft(); renderList(); } };

      reorder.append(up,down);
      left.append(enChk, prio, reorder);

      // Centro: config
      const center = document.createElement("div"); center.style.flex="1"; center.style.display="flex"; center.style.flexDirection="column"; center.style.gap="8px";

      const title = document.createElement("div"); title.className="vz-cardTitle";

      const row1 = document.createElement("div"); row1.className="vz-row";

      const mode = select(["Contiene","Igual a","Empieza","Termina","Regex","Cualquiera"], uiRules[i].mode || "Contiene");
      mode.onchange = () => { uiRules[i].mode = mode.value; updateTitle(); saveDraft(); syncInputs(); };

      const txt = input({placeholder:"texto a buscar…"}); txt.value = uiRules[i].text || "";
      txt.oninput = () => { uiRules[i].text = txt.value; saveDraft(); };

      const rx = input({placeholder:"expresión regular…"}); rx.value = uiRules[i].rawRegex || "";
      rx.oninput = () => { uiRules[i].rawRegex = rx.value; saveDraft(); };

      const replyField = field("Respuesta", textarea()); replyField.querySelector("textarea").value = uiRules[i].reply || "";
      replyField.querySelector("textarea").oninput = (e)=>{ uiRules[i].reply = e.target.value; saveDraft(); };

      row1.append(label("Modo"), mode, spacer(), label("Texto/Regex"), txt, rx);
      center.append(title, row1, replyField);

      // Derecha: acciones (iconos)
      const right = document.createElement("div"); right.style.display="flex"; right.style.gap="6px"; right.style.alignItems="center";

      const dup = mkIconBtn(svgDuplicate(), "Duplicar", "#374151");
      dup.onclick = () => { const c = structuredClone(uiRules[i]); uiRules.splice(i+1, 0, c); saveDraft(); renderList(); };

      const del = mkIconBtn(svgTrash(), "Eliminar", "#ef4444");
      del.onclick = () => { if (confirm("¿Eliminar esta regla?")){ uiRules.splice(i,1); saveDraft(); renderList(); } };

      right.append(dup, del);
      card.append(left, center, right);

      function updateTitle(){
        const m = uiRules[i].mode || "Contiene";
        if (m === "Regex") {
          title.textContent = "Coincidencia: Expresión regular";
        } else if (m === "Cualquiera") {
          title.textContent = "Coincidencia: Cualquiera (cualquier mensaje)";
        } else {
          title.textContent = `Coincidencia: ${m}`;
        }
      }

      function syncInputs(){
        const m = mode.value;
        if (m === "Regex"){
          txt.style.display="none";
          rx.style.display="";
        } else if (m === "Cualquiera") {
          txt.style.display="none";
          rx.style.display="none";
        } else {
          txt.style.display="";
          rx.style.display="none";
        }
      }

      updateTitle();
      syncInputs();
      return card;
    }

    function addRule(prefill){
      // Inserta al INICIO (primera prioridad) y limpia filtro para que se vea
      filterText = ""; const s = Q(".vz-colL input[type='text']"); if (s) s.value = "";
      const item = prefill ? structuredClone(prefill) : { enabled:true, mode:"Contiene", text:"", rawRegex:"", reply:"" };
      uiRules.unshift(item);
      renderList();
      saveDraft();
      requestAnimationFrame(() => {
        const first = listWrap?.firstElementChild;
        if (first){
          first.classList.add("vz-newpulse");
          first.scrollIntoView({ behavior:"smooth", block:"nearest" });
          setTimeout(()=>first.classList.remove("vz-newpulse"), 1400);
        }
      });
    }

    function testerBox(){
      const box = document.createElement("div"); box.className="vz-tester";
      const h = document.createElement("div"); h.className="vz-label"; h.textContent="Probador rápido";
      const inp = input({placeholder:"Escribe un mensaje entrante (simulado) y verás qué regla coincide primero…"});
      const note = document.createElement("div"); note.className="vz-note"; note.textContent = "La primera coincidencia (arriba) es la que se usa. Ajusta el orden con los chevrons.";

      const out = document.createElement("div"); out.className="vz-note";

      function runTest(){
        const msg = String(inp.value||"");
        if (!msg.trim()){ out.textContent=""; return; }
        const compiled = compileForEngine(uiRules);
        let matched = null;
        for (let i=0;i<compiled.length;i++){
          try{
            const re = new RegExp(compiled[i].pattern, compiled[i].flags);
            if (re.test(msg)){ matched = { idx:i, rule:compiled[i] }; break; }
          }catch{}
        }
        if (matched){
          out.className = "vz-note vz-hit";
          out.innerHTML = `✔ Coincide la <b>regla #${matched.idx+1}</b>. Respondería:<br><pre style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(matched.rule.reply)}</pre>`;
          const card = listWrap.children[matched.idx];
          if (card) { card.classList.add("vz-newpulse"); setTimeout(()=>card.classList.remove("vz-newpulse"), 1400); card.scrollIntoView({behavior:"smooth", block:"nearest"}); }
        } else {
          out.className = "vz-note vz-nohit";
          out.textContent = "✖ Ninguna regla coincide.";
        }
      }

      inp.oninput = runTest;
      box.append(h, inp, note, out);
      return box;
    }

    function saveDraft(){ S.set(UI_KEY, uiRules); }

    /* ---- helpers UI ---- */
    function mkBtn(label, kind="default"){
      const b = document.createElement("button");
      b.className = "vz-btn" + (kind? " " + kind : "");
      b.textContent = label;
      return b;
    }
    function mkIconBtn(svgNode, ariaLabel, bg){
      const b = document.createElement("button");
      b.className = "vz-btn icon";
      b.style.background = bg || "#374151";
      b.setAttribute("title", ariaLabel);
      b.setAttribute("aria-label", ariaLabel);
      b.append(svgNode);
      return b;
    }
    function svgDuplicate(){
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 24 24");
      svg.innerHTML = `
        <path class="vz-icon" d="M8 7a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3V7z"/>
        <path class="vz-icon" d="M3 10a3 3 0 0 1 3-3h1v7a5 5 0 0 0 5 5h7v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-10z" opacity=".55"/>
      `;
      return svg;
    }
    function svgTrash(){
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 24 24");
      svg.innerHTML = `
        <path class="vz-icon warn" d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1z"/>
        <path class="vz-icon warn" d="M6 8h12l-1 11a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3L6 8zm4 3v7h2v-7h-2zm4 0v7h2v-7h-2z" opacity=".95"/>
      `;
      return svg;
    }
    function svgChevronUp(){
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 24 24");
      svg.innerHTML = `<path class="vz-icon" d="M7.41 14.59 12 10l4.59 4.59L18 13.17 12 7l-6 6z"/>`;
      return svg;
    }
    function svgChevronDown(){
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 24 24");
      svg.innerHTML = `<path class="vz-icon" d="M7.41 8.59 12 13l4.59-4.41L18 10.83 12 17 6 10.83z"/>`;
      return svg;
    }
    function input(attrs={}){
      const i = document.createElement("input");
      i.className = "vz-input";
      Object.assign(i, attrs);
      if (attrs.style) i.setAttribute("style", attrs.style);
      return i;
    }
    function textarea(){
      const t = document.createElement("textarea");
      t.className = "vz-textarea";
      return t;
    }
    function select(options, value){
      const s = document.createElement("select");
      s.className = "vz-select";
      for (const o of options){
        const opt = document.createElement("option"); opt.value = o; opt.textContent = o; s.append(opt);
      }
      s.value = value;
      return s;
    }
    function field(labelText, el){
      const f = document.createElement("div"); f.className="vz-field";
      const l = document.createElement("div"); l.className="vz-label"; l.textContent = labelText;
      f.append(l, el); return f;
    }
    function label(txt){
      const s = document.createElement("span"); s.className="vz-label"; s.textContent = txt; return s;
    }
    function spacer(){ const s = document.createElement("span"); s.style.flex="0 0 8px"; return s; }
    function flash(btn, txt){
      const old = btn.textContent; btn.textContent = "✓ " + (txt||"OK"); btn.disabled = true;
      setTimeout(()=>{ btn.textContent = old; btn.disabled = false; }, 900);
    }
    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    }
  }

  /* =========================
     API pública para content.js
  ========================== */
  function injectTopBar({ getEnabled, setEnabled, onOpenRules }){
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
    status.textContent = getEnabled() ? "Auto: ON" : "Auto: OFF";

    const mkBtnTop = (label, bg) => {
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

    const btnToggle = mkBtnTop(getEnabled() ? "Pausar" : "Reanudar", getEnabled() ? "#22c55e" : "#525252");
    btnToggle.onclick = () => {
      const next = !getEnabled();
      setEnabled(next);
      status.textContent = next ? "Auto: ON" : "Auto: OFF";
      btnToggle.textContent = next ? "Pausar" : "Reanudar";
      btnToggle.style.background = next ? "#22c55e" : "#525252";
    };

    const btnRules = mkBtnTop("Reglas", "#7c3aed");
    btnRules.onclick = () => onOpenRules?.();

    bar.append(status, btnToggle, btnRules);
    wrap.append(bar);
    document.documentElement.append(wrap);
  }

  async function openRulesModal({ loadRules, saveRules }){
    openRulesPanel({ loadRules, saveRules });
  }

  window.VZUI = { injectTopBar, openRulesModal };
})();

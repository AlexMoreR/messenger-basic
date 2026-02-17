// ui.js - Panel visual de reglas para VZ-Bot
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
      try {
        if (chrome?.storage?.local){
          const o = await chrome.storage.local.get(key);
          return o?.[key] ?? fallback;
        }
      } catch {}
      try {
        const raw = localStorage.getItem(key);
        return raw===null?fallback:JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    async set(key, val){
      try {
        if (chrome?.storage?.local){
          await chrome.storage.local.set({[key]:val});
          return;
        }
      } catch {}
      localStorage.setItem(key, typeof val==="string" ? val : JSON.stringify(val));
    }
  };
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const now = () => Date.now();

  /* =========================
     Estilos
  ========================== */
  cssOnce("vz-ui-saas-css", `
  .vz2-wrap{position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; background:radial-gradient(1200px 700px at 90% -10%, rgba(56,189,248,.18), transparent),rgba(2,6,23,.72)}
  .vz2-dialog{width:min(920px,96vw); max-height:92vh; display:flex; flex-direction:column; background:linear-gradient(170deg,#0b1220,#0a1426); border:1px solid rgba(148,163,184,.28); border-radius:16px; color:#e2e8f0; box-shadow:0 28px 90px rgba(0,0,0,.55); animation:vz2FadeUp .2s ease-out}
  .vz2-hd{display:flex; align-items:center; gap:10px; padding:14px; border-bottom:1px solid rgba(148,163,184,.2)}
  .vz2-title{font:700 16px/1.2 system-ui; color:#f8fafc; display:flex; align-items:center; gap:8px}
  .vz2-titleIcon{width:18px; height:18px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; background:#0b2540; color:#7dd3fc; border:1px solid rgba(125,211,252,.35); font:700 12px/1 system-ui}
  .vz2-sub{font:12px/1.2 system-ui; opacity:.8}
  .vz2-sp{flex:1}
  .vz2-btn{background:#1e293b; color:#f8fafc; border:1px solid rgba(148,163,184,.28); border-radius:10px; padding:8px 10px; font:600 13px system-ui; cursor:pointer}
  .vz2-btn:hover{filter:brightness(1.1)}
  .vz2-btn.pr{background:#059669}
  .vz2-btn.info{background:#0e7490}
  .vz2-btn.warn{background:#b91c1c}
  .vz2-bd{padding:14px; overflow:auto; min-height:0}
  .vz2-grid{display:flex; flex-direction:column; gap:12px; align-items:center}
  .vz2-card{background:#0f172a; border:1px solid rgba(148,163,184,.22); border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:10px; width:min(500px,100%)}
  .vz2-card{position:relative; cursor:pointer; transition:transform .16s ease, border-color .16s ease, box-shadow .16s ease; animation:vz2CardIn .24s ease both; overflow:visible}
  .vz2-card.menu-open{z-index:40}
  .vz2-card:hover{border-color:rgba(56,189,248,.55); box-shadow:0 0 0 1px rgba(56,189,248,.18) inset; transform:translateY(-1px)}
  .vz2-cardHead{display:flex; align-items:center; gap:8px; justify-content:space-between}
  .vz2-topMeta{display:flex; align-items:center; gap:6px; justify-content:flex-end; flex:0 0 auto}
  .vz2-name{font:700 14px/1.2 system-ui; color:#f8fafc}
  .vz2-preview{font:12px/1.3 system-ui; color:#94a3b8; margin-top:2px}
  .vz2-chips{display:flex; gap:6px; flex-wrap:wrap}
  .vz2-chip{font:600 11px/1.1 system-ui; border-radius:999px; padding:5px 8px; border:1px solid rgba(148,163,184,.3); background:#1e293b}
  .vz2-chip.on{background:#065f46; border-color:#10b981}
  .vz2-chip.off{background:#3f3f46; border-color:#71717a}
  .vz2-row{display:flex; gap:8px; align-items:center}
  .vz2-menuBtn{width:30px; height:30px; border-radius:8px; background:#111827; border:1px solid rgba(148,163,184,.35); color:#cbd5e1; cursor:pointer}
  .vz2-menu{position:absolute; right:8px; top:46px; min-width:150px; background:#0b1220; border:1px solid rgba(148,163,184,.35); border-radius:10px; padding:6px; display:none; flex-direction:column; gap:4px; z-index:60; transform-origin:top right}
  .vz2-menu.open{display:flex; animation:vz2Pop .14s ease-out}
  .vz2-menuItem{background:#111827; border:1px solid rgba(148,163,184,.2); color:#e2e8f0; border-radius:8px; padding:8px 10px; font:600 12px system-ui; text-align:left; cursor:pointer}
  .vz2-menuItem:hover{filter:brightness(1.08)}
  .vz2-menuItem.warn{background:#3f1d1d; border-color:#7f1d1d}
  .vz2-empty{padding:20px; text-align:center; border:1px dashed rgba(148,163,184,.3); border-radius:12px; color:#94a3b8}
  .vz2-iconBtn{width:32px; height:32px; border-radius:8px; border:1px solid rgba(148,163,184,.28); background:#111827; color:#e2e8f0; cursor:pointer; font:700 14px/1 system-ui; display:inline-flex; align-items:center; justify-content:center}
  .vz2-iconBtn:hover{filter:brightness(1.1)}
  .vz2-iconBtn.warn{background:#3f1d1d; border-color:#7f1d1d}

  .vz2-modal{position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; background:rgba(2,6,23,.62)}
  .vz2-panel{width:min(620px,94vw); max-height:90vh; overflow:auto; background:#0f172a; border:1px solid rgba(148,163,184,.32); border-radius:16px; box-shadow:0 24px 80px rgba(0,0,0,.55); animation:vz2Pop .18s ease-out}
  .vz2-helpFrame{width:min(620px,92vw); aspect-ratio:16/9; border:0; border-radius:12px; background:#000}
  .vz2-phd{display:flex; align-items:center; gap:10px; padding:14px; border-bottom:1px solid rgba(148,163,184,.2)}
  .vz2-pbd{padding:14px; display:flex; flex-direction:column; gap:12px}
  .vz2-field{display:flex; flex-direction:column; gap:6px}
  .vz2-label{font:600 12px system-ui; color:#cbd5e1}
  .vz2-input,.vz2-select,.vz2-ta{background:#0b1220; color:#e2e8f0; border:1px solid rgba(148,163,184,.3); border-radius:10px; padding:9px 10px; font:13px system-ui; outline:none}
  .vz2-input:focus,.vz2-select:focus,.vz2-ta:focus{border-color:#38bdf8}
  .vz2-ta{min-height:120px; resize:vertical}
  .vz2-actions{display:flex; gap:8px; justify-content:flex-end; padding-top:4px}
  .vz2-trackStats{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px}
  .vz2-stat{background:#0b1220; border:1px solid rgba(148,163,184,.28); border-radius:10px; padding:10px}
  .vz2-statK{font:600 11px/1 system-ui; color:#94a3b8}
  .vz2-statV{font:700 18px/1.1 system-ui; color:#f8fafc; margin-top:6px}
  .vz2-trackList{display:flex; flex-direction:column; gap:8px}
  .vz2-trackItem{background:#0b1220; border:1px solid rgba(148,163,184,.28); border-radius:10px; padding:10px; display:flex; flex-direction:column; gap:8px}
  .vz2-trackHead{display:flex; justify-content:space-between; align-items:center; gap:8px}
  .vz2-trackTid{font:600 12px/1.2 system-ui; color:#f8fafc}
  .vz2-trackMeta{font:12px/1.3 system-ui; color:#94a3b8}
  .vz2-trackRule{font:600 11px/1.2 system-ui; color:#7dd3fc}
  .vz2-trackInput{background:#0f172a; color:#e2e8f0; border:1px solid rgba(148,163,184,.3); border-radius:8px; padding:7px 8px; font:12px system-ui}
  .vz2-trackEmpty{font:12px/1.4 system-ui; color:#94a3b8; border:1px dashed rgba(148,163,184,.28); border-radius:10px; padding:10px}
  .vz2-trackSection{margin-top:8px}
  .vz2-trackSection .vz2-label{margin-bottom:4px}
  .vz2-tabs{display:flex; gap:8px}
  .vz2-tab{background:#1e293b; color:#cbd5e1; border:1px solid rgba(148,163,184,.25); border-radius:8px; padding:7px 10px; font:600 12px system-ui; cursor:pointer}
  .vz2-tab.active{background:#0e7490; color:#fff; border-color:#38bdf8}
  @keyframes vz2FadeUp{from{opacity:0; transform:translateY(10px)}to{opacity:1; transform:translateY(0)}}
  @keyframes vz2Pop{from{opacity:0; transform:translateY(-6px) scale(.98)}to{opacity:1; transform:translateY(0) scale(1)}}
  @keyframes vz2CardIn{from{opacity:0; transform:translateY(6px)}to{opacity:1; transform:translateY(0)}}
  `);

  /* =========================
     Estado y conversion
  ========================== */
  const UI_KEY = "__vz_rules_ui";

  // Modelo UI por regla
  // { enabled, mode, text, rawRegex, reply }
  let uiRules = [];
  let filterText = "";
  let panelOpen = false;

  const templates = [
    { label:"Saludo",   prefill:{ enabled:true, mode:"Regex",      rawRegex:"^(hola|buen[oa]s|saludos)\\b", text:"", reply:"Â¡Hola! ðŸ˜Š\n\nCuÃ©ntame un poco mÃ¡s para ayudarte." } },
    { label:"Precio",   prefill:{ enabled:true, mode:"Regex",      rawRegex:"precio|valor|cu[aÃ¡]nto cuesta|costo", text:"", reply:"Nuestros precios varÃ­an segÃºn el producto/servicio.\nÂ¿De quÃ© producto te interesa saber el precio?" } },
    { label:"Horarios", prefill:{ enabled:true, mode:"Regex",      rawRegex:"(?:\\b|\\s)(horario|hora|atienden)(?:\\b|\\s)", text:"", reply:"Horario de atenciÃ³n:\nLunâ€“Vie: 8:00â€“18:00\nSÃ¡b: 9:00â€“13:00" } },
    { label:"EnvÃ­os",   prefill:{ enabled:true, mode:"Regex",      rawRegex:"env[iÃ­]o|entrega|domicilio", text:"", reply:"Â¡SÃ­! Realizamos envÃ­os. Â¿CuÃ¡l es tu ciudad o direcciÃ³n aproximada para cotizar?" } },
    { label:"Nombre",   prefill:{ enabled:true, mode:"Regex",      rawRegex:"\\b(soy|me llamo)\\s+([a-zÃ¡Ã©Ã­Ã³ÃºÃ±]+)\\b", text:"", reply:"Â¡Mucho gusto! ðŸ˜Š Â¿En quÃ© te ayudo?" } },
    { label:"Cualquiera", prefill:{ enabled:true, mode:"Cualquiera", rawRegex:"", text:"", reply:"Gracias por tu mensaje ðŸ™Œ\n\nEn un momento un asesor revisarÃ¡ tu consulta." } },
  ];

  // Exporta al motor: modo "Cualquiera" genera [\s\S]+, siempre con flag i
  function compileForEngine(list){
    const out = [];
    for (const r of list) {
      if (!r.enabled) continue;
      let pattern = "";
      if (r.mode === "Cualquiera") {
        pattern = "[\\s\\S]+";
      } else if (r.mode === "Regex") {
        pattern = String(r.rawRegex || "").trim();
        if (!pattern) continue;
      } else {
        const esc = escapeRegExp(String(r.text||""));
        if (!esc) continue;
        switch(r.mode){
          case "Contiene":   pattern = esc; break;
          case "Empieza":    pattern = `^${esc}`; break;
          case "Termina":    pattern = `${esc}$`; break;
          case "Igual a":    pattern = `^${esc}$`; break;
          default:           pattern = esc;
        }
      }
      const flags = "i"; // siempre case-insensitive
      out.push({ pattern, flags, reply: String(r.reply||"") });
    }
    return out;
  }

  // Intento de inflar desde compilado previo (incluye detectar "Cualquiera")
  function inflateFromCompiled(compiled){
    const arr = [];
    for (const r of (compiled || [])) {
      const patt = String(r.pattern||"");
      let mode = "Regex";
      let text = "";
      let rawRegex = patt;

      if (patt === "[\\s\\S]+" || patt === "[\\s\\S]+?") {
        mode = "Cualquiera";
        rawRegex = "";
      }
      else if (/^\^.*\$$/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(1,-1))) {
        mode = "Igual a";
        text = patt.slice(1,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (/^\^.+/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(1))) {
        mode = "Empieza";
        text = patt.slice(1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (/.+\$$/.test(patt) && !/[.*+?()|[\]\\]/.test(patt.slice(0,-1))) {
        mode = "Termina";
        text = patt.slice(0,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }
      else if (!/[.*+?()|[\]\\^$]/.test(patt)) {
        mode = "Contiene";
        text = patt.replace(/\\([.*+?^${}()|[\]\\])/g,"$1");
      }

      arr.push({
        enabled: true,
        mode, text, rawRegex,
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
    const saveHint = document.createElement("span"); saveHint.className = "vz-kbd"; saveHint.textContent = "Ctrl/Cmd + S";
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

    hd.append(ttl, saveHint, sp, btnExport, btnPublish, btnClose);

    /* Body (2 columnas) */
    const bd  = document.createElement("div"); bd.className = "vz-bd";
    const L   = document.createElement("div"); L.className   = "vz-colL";
    const R   = document.createElement("div"); R.className   = "vz-colR";

    // Izquierda: buscar + plantillas + tester
    const searchField = field("Buscar", input({placeholder:"filtra por texto o respuesta..."}));
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

    const quick = quickBuilder();
    const tester = testerBox();

    L.append(searchField, addRow, quick, tester);

    // Derecha: lista
    const listWrap = document.createElement("div"); listWrap.className = "vz-list";
    R.append(listWrap);

    bd.append(L, R);
    dlg.append(hd, bd);
    wrap.append(dlg);
    document.documentElement.append(wrap);

    // Cerrar por fondo / ESC
    wrap.addEventListener("click", (e)=>{ if (e.target === wrap){ wrap.remove(); panelOpen=false; }});
    wrap.addEventListener("keydown", (e)=>{
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s"){
        e.preventDefault();
        btnPublish.click();
        return;
      }
      if (e.key==="Escape"){ e.preventDefault(); wrap.remove(); panelOpen=false; }
    });

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
      up.onclick = () => {
        if (i>0){
          const t=uiRules[i];
          uiRules.splice(i,1);
          uiRules.splice(i-1,0,t);
          saveDraft(); renderList();
        }
      };
      down.onclick = () => {
        if (i<uiRules.length-1){
          const t=uiRules[i];
          uiRules.splice(i,1);
          uiRules.splice(i+1,0,t);
          saveDraft(); renderList();
        }
      };

      reorder.append(up,down);
      left.append(enChk, prio, reorder);

      // Centro: config
      const center = document.createElement("div"); center.style.flex="1"; center.style.display="flex"; center.style.flexDirection="column"; center.style.gap="8px";

      const title = document.createElement("div"); title.className="vz-cardTitle";
      title.textContent = uiRules[i].mode === "Regex"
        ? "Coincidencia: ExpresiÃ³n regular"
        : `Coincidencia: ${uiRules[i].mode}`;

      const row1 = document.createElement("div"); row1.className = "vz-row";

      const mode = select(["Cualquiera","Contiene","Igual a","Empieza","Termina","Regex"], uiRules[i].mode || "Contiene");
      mode.onchange = () => {
        uiRules[i].mode = mode.value;
        title.textContent = uiRules[i].mode === "Regex"
          ? "Coincidencia: ExpresiÃ³n regular"
          : `Coincidencia: ${uiRules[i].mode}`;
        saveDraft(); syncInputs();
      };

      const txt = input({placeholder:"texto a buscar..."}); txt.value = uiRules[i].text || "";
      txt.oninput = () => { uiRules[i].text = txt.value; saveDraft(); };

      const rx = input({placeholder:"expresiÃ³n regular..."}); rx.value = uiRules[i].rawRegex || "";
      rx.oninput = () => { uiRules[i].rawRegex = rx.value; saveDraft(); };

      const replyField = field("Respuesta", textarea());
      replyField.querySelector("textarea").value = uiRules[i].reply || "";
      replyField.querySelector("textarea").oninput = (e)=>{ uiRules[i].reply = e.target.value; saveDraft(); };

      row1.append(label("Modo"), mode, spacer(), label("Texto/Regex"), txt, rx);
      center.append(title, row1, replyField);

      // Derecha: acciones (iconos)
      const right = document.createElement("div"); right.style.display="flex"; right.style.gap="6px"; right.style.alignItems="center";

      const dup = mkIconBtn(svgDuplicate(), "Duplicar", "#374151");
      dup.onclick = () => {
        const c = structuredClone(uiRules[i]);
        uiRules.splice(i+1, 0, c);
        saveDraft(); renderList();
      };

      const del = mkIconBtn(svgTrash(), "Eliminar", "#ef4444");
      del.onclick = () => {
        if (confirm("Â¿Eliminar esta regla?")){
          uiRules.splice(i,1);
          saveDraft(); renderList();
        }
      };

      right.append(dup, del);
      card.append(left, center, right);

      function syncInputs(){
        if (mode.value === "Regex"){
          txt.style.display="none";
          rx.style.display="";
        } else if (mode.value === "Cualquiera"){
          txt.style.display="none";
          rx.style.display="none";
        } else {
          txt.style.display="";
          rx.style.display="none";
        }
      }
      syncInputs();
      return card;
    }

    function addRule(prefill){
      // Inserta al INICIO (primera prioridad) y limpia filtro para que se vea
      filterText = "";
      const s = Q(".vz-colL input[type='text']");
      if (s) s.value = "";
      const item = prefill ? structuredClone(prefill) : {
        enabled:true, mode:"Contiene", text:"", rawRegex:"", reply:""
      };
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
      const h = document.createElement("div"); h.className="vz-label"; h.textContent="Probador rÃ¡pido";
      const inp = input({placeholder:"Escribe un mensaje entrante (simulado) y verÃ¡s quÃ© regla coincide primero..."});
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
          out.innerHTML = `âœ” Coincide la <b>regla #${matched.idx+1}</b>. ResponderÃ­a:<br><pre style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(matched.rule.reply)}</pre>`;
          const card = listWrap.children[matched.idx];
          if (card) {
            card.classList.add("vz-newpulse");
            setTimeout(()=>card.classList.remove("vz-newpulse"), 1400);
            card.scrollIntoView({behavior:"smooth", block:"nearest"});
          }
        } else {
          out.className = "vz-note vz-nohit";
          out.textContent = "âœ– Ninguna regla coincide.";
        }
      }

      inp.oninput = runTest;
      box.append(h, inp, note, out);
      return box;
    }

    function quickBuilder(){
      const box = document.createElement("div"); box.className = "vz-quick";
      const h = document.createElement("div"); h.className = "vz-label"; h.textContent = "Crear regla rÃ¡pida";

      const mode = select(["Contiene","Igual a","Empieza","Termina","Regex","Cualquiera"], "Contiene");
      const trigger = input({placeholder:"Disparador (ej: precio, horario, hola)"});
      const reply = textarea();
      reply.placeholder = "Respuesta automÃ¡tica...";

      const row = document.createElement("div"); row.className = "vz-row";
      const add = mkBtn("Agregar arriba", "pr");
      const clear = mkBtn("Limpiar", "ghost");

      clear.onclick = () => {
        mode.value = "Contiene";
        trigger.value = "";
        reply.value = "";
      };

      add.onclick = () => {
        const m = mode.value;
        const trig = String(trigger.value || "").trim();
        const rep = String(reply.value || "").trim();
        if (!rep) { alert("Escribe una respuesta."); return; }
        if (m !== "Cualquiera" && !trig) { alert("Escribe un disparador."); return; }
        addRule({
          enabled: true,
          mode: m,
          text: m === "Regex" ? "" : trig,
          rawRegex: m === "Regex" ? trig : "",
          reply: rep
        });
      };

      row.append(label("Modo"), mode, add, clear);
      box.append(h, row, trigger, reply);
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
      const old = btn.textContent; btn.textContent = "âœ“ " + (txt||"OK"); btn.disabled = true;
      setTimeout(()=>{ btn.textContent = old; btn.disabled = false; }, 900);
    }
    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    }
  }

  /* =========================
     API pÃºblica para content.js
  ========================== */
  function injectTopBar({ getEnabled, setEnabled, onOpenRules, onOpenTracking }){
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

    const btnToggle = mkBtn(getEnabled() ? "Pausar" : "Reanudar", getEnabled() ? "#22c55e" : "#525252");
    btnToggle.onclick = () => {
      const next = !getEnabled();
      setEnabled(next);
      status.textContent = next ? "Auto: ON" : "Auto: OFF";
      btnToggle.textContent = next ? "Pausar" : "Reanudar";
      btnToggle.style.background = next ? "#22c55e" : "#525252";
    };

    const btnRules = mkBtn("Reglas", "#7c3aed");
    btnRules.onclick = () => onOpenRules?.();
    const btnTracking = mkBtn("Seguimiento", "#0e7490");
    btnTracking.onclick = () => onOpenTracking?.();

    bar.append(status, btnToggle, btnRules, btnTracking);
    wrap.append(bar);
    document.documentElement.append(wrap);
  }

  function openRulesPanelV2({ loadRules, saveRules }){
    if (panelOpen) return;
    panelOpen = true;
    Q("#vz2-root")?.remove();

    const wrap = document.createElement("div");
    wrap.id = "vz2-root";
    wrap.className = "vz2-wrap";

    const dlg = document.createElement("div");
    dlg.className = "vz2-dialog";

    const hd = document.createElement("div");
    hd.className = "vz2-hd";
    hd.innerHTML = `
      <div>
        <div class="vz2-title"><span class="vz2-titleIcon">&#9881;</span>Gestion de reglas</div>
      </div>
      <div class="vz2-sp"></div>
    `;

    const mkBtn = (label, cls="") => {
      const b = document.createElement("button");
      b.className = "vz2-btn" + (cls ? ` ${cls}` : "");
      b.textContent = label;
      return b;
    };
    const esc = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

    const btnNew = mkBtn("Nueva regla", "pr");
    const btnHelp = mkBtn("Ayuda", "info");
    const btnClose = mkBtn("Cerrar");
    const btnExport = mkBtn("Exportar");
    hd.append(btnNew, btnExport, btnHelp, btnClose);

    const bd = document.createElement("div");
    bd.className = "vz2-bd";
    const grid = document.createElement("div");
    grid.className = "vz2-grid";
    bd.append(grid);

    dlg.append(hd, bd);
    wrap.append(dlg);
    document.documentElement.append(wrap);

    const closePanel = () => { wrap.remove(); panelOpen = false; };
    btnClose.onclick = closePanel;
    wrap.addEventListener("click", (e)=>{ if (e.target === wrap) closePanel(); });
    document.addEventListener("click", (e) => {
      if (!Q("#vz2-root")) return;
      if (!e.target.closest(".vz2-menu") && !e.target.closest(".vz2-menuBtn")) {
        QA(".vz2-menu.open", wrap).forEach(m => m.classList.remove("open"));
      }
    });
    wrap.addEventListener("keydown", (e)=>{
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s"){
        e.preventDefault();
        publishRules();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const m = Q(".vz2-modal", wrap);
        if (m) m.remove(); else closePanel();
      }
    });

    const summarize = (r, i) => {
      const nm = String(r.name || "").trim() || `Regla ${i + 1}`;
      const preview = r.mode === "Regex" ? String(r.rawRegex || "") : String(r.text || "");
      return { nm, preview };
    };

    const saveDraft = async () => { await S.set(UI_KEY, uiRules); };
    const publishRules = async () => {
      const compiled = compileForEngine(uiRules);
      await saveRules(JSON.stringify(compiled, null, 2));
      await saveDraft();
    };

    btnExport.onclick = async () => {
      const compiled = compileForEngine(uiRules);
      const blob = new Blob([JSON.stringify(compiled, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `vz-rules-${Date.now()}.json`; a.click();
      setTimeout(()=>URL.revokeObjectURL(url), 5000);
    };

    btnNew.onclick = () => {
      uiRules.push({ name:"", enabled:true, mode:"Contiene", text:"", rawRegex:"", reply:"" });
      openEditor(uiRules.length - 1, true);
    };

    btnHelp.onclick = () => {
      Q(".vz2-modal", wrap)?.remove();
      const help = document.createElement("div");
      help.className = "vz2-modal";
      help.innerHTML = `
        <div class="vz2-panel">
          <div class="vz2-phd">
            <div class="vz2-title"><span class="vz2-titleIcon">?</span>Ayuda</div>
            <div class="vz2-sp"></div>
            <button class="vz2-btn" data-close-help>Cerrar</button>
          </div>
          <div class="vz2-pbd" style="align-items:center">
            <iframe class="vz2-helpFrame" src="https://www.youtube.com/embed/M7lc1UVf-VE" title="Ayuda reglas" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
          </div>
        </div>
      `;
      Q("[data-close-help]", help).onclick = () => help.remove();
      help.addEventListener("click", (e) => { if (e.target === help) help.remove(); });
      wrap.append(help);
    };

    const render = () => {
      grid.innerHTML = "";
      if (!uiRules.length) {
        const e = document.createElement("div");
        e.className = "vz2-empty";
        e.textContent = "No hay reglas. Crea una con 'Nueva regla'.";
        grid.append(e);
        return;
      }

      uiRules.forEach((r, i) => {
        const s = summarize(r, i);
        const card = document.createElement("div");
        card.className = "vz2-card";
        card.onclick = (e) => {
          if (e.target.closest(".vz2-menuBtn") || e.target.closest(".vz2-menu")) return;
          openEditor(i, false);
        };
        card.innerHTML = `
          <div class="vz2-cardHead">
            <div class="vz2-name">${esc(s.nm)}</div>
            <div class="vz2-topMeta">
              <span class="vz2-chip ${r.enabled ? "on" : "off"}">${r.enabled ? "Activo" : "Inactivo"}</span>
              <span class="vz2-chip">${esc(r.mode || "Contiene")}</span>
              <button class="vz2-menuBtn" title="Acciones" aria-label="Acciones">&#8942;</button>
            </div>
          </div>
          <div class="vz2-preview">${esc(s.preview || "(sin condicion)")}</div>
          <div class="vz2-menu">
            <button class="vz2-menuItem" data-action="toggle">${r.enabled ? "Desactivar" : "Activar"}</button>
            <button class="vz2-menuItem warn" data-action="delete">Eliminar</button>
          </div>
        `;

        const menuBtn = Q(".vz2-menuBtn", card);
        const menu = Q(".vz2-menu", card);
        const toggleBtn = Q('[data-action="toggle"]', card);
        const deleteBtn = Q('[data-action="delete"]', card);

        menuBtn.onclick = (e) => {
          e.stopPropagation();
          QA(".vz2-menu.open", grid).forEach(m => {
            if (m !== menu) {
              m.classList.remove("open");
              m.closest(".vz2-card")?.classList.remove("menu-open");
            }
          });
          menu.classList.toggle("open");
          card.classList.toggle("menu-open", menu.classList.contains("open"));
        };

        toggleBtn.onclick = async (e) => {
          e.stopPropagation();
          uiRules[i].enabled = !uiRules[i].enabled;
          await publishRules();
          render();
        };

        deleteBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm("Eliminar esta regla?")) return;
          uiRules.splice(i, 1);
          await publishRules();
          render();
        };

        card.addEventListener("mouseleave", () => menu.classList.remove("open"));
        card.addEventListener("mouseleave", () => card.classList.remove("menu-open"));
        grid.append(card);
      });
    };

    const openEditor = (idx, isNew) => {
      Q(".vz2-modal", wrap)?.remove();
      const r = uiRules[idx];
      const modal = document.createElement("div");
      modal.className = "vz2-modal";
      modal.innerHTML = `
        <div class="vz2-panel">
          <div class="vz2-phd">
            <div class="vz2-title"><span class="vz2-titleIcon">${isNew ? "+" : "&#9998;"}</span>${isNew ? "Nueva regla" : "Editar regla"}</div>
            <div class="vz2-sp"></div>
            <button class="vz2-btn" data-close>Cerrar</button>
          </div>
          <div class="vz2-pbd">
            <div class="vz2-field">
              <div class="vz2-label">Nombre</div>
              <input class="vz2-input" data-name placeholder="Ej: Regla de saludo">
            </div>
            <div class="vz2-row">
              <input type="checkbox" data-enabled>
              <span class="vz2-label">Regla activa</span>
            </div>
            <div class="vz2-field">
              <div class="vz2-label">Modo</div>
              <select class="vz2-select" data-mode>
                <option>Cualquiera</option><option>Contiene</option><option>Igual a</option>
                <option>Empieza</option><option>Termina</option><option>Regex</option>
              </select>
            </div>
            <div class="vz2-field">
              <div class="vz2-label" data-pattern-label>Patron / condicion</div>
              <input class="vz2-input" data-pattern placeholder="Ej: precio">
            </div>
            <div class="vz2-field">
              <div class="vz2-label">Respuesta automatica</div>
              <textarea class="vz2-ta" data-reply></textarea>
            </div>
            <div class="vz2-actions">
              <button class="vz2-btn warn" data-delete>Eliminar</button>
              <button class="vz2-btn" data-cancel>Cancelar</button>
              <button class="vz2-btn pr" data-save>Guardar</button>
            </div>
          </div>
        </div>
      `;

      const name = Q("[data-name]", modal);
      const enabled = Q("[data-enabled]", modal);
      const mode = Q("[data-mode]", modal);
      const pattern = Q("[data-pattern]", modal);
      const pl = Q("[data-pattern-label]", modal);
      const reply = Q("[data-reply]", modal);

      name.value = r.name || "";
      enabled.checked = !!r.enabled;
      mode.value = r.mode || "Contiene";
      pattern.value = mode.value === "Regex" ? (r.rawRegex || "") : (r.text || "");
      reply.value = r.reply || "";

      const sync = () => {
        pl.textContent = mode.value === "Regex" ? "Expresion regular" : "Patron / condicion";
        pattern.disabled = mode.value === "Cualquiera";
      };
      mode.onchange = sync;
      sync();

      Q("[data-close]", modal).onclick = () => modal.remove();
      Q("[data-cancel]", modal).onclick = () => modal.remove();
      Q("[data-delete]", modal).onclick = async () => {
        if (!confirm("Eliminar esta regla?")) return;
        uiRules.splice(idx, 1);
        await publishRules();
        render();
        modal.remove();
      };
      Q("[data-save]", modal).onclick = async () => {
        const m = mode.value;
        const p = String(pattern.value || "").trim();
        const rep = String(reply.value || "").trim();
        if (!rep) { alert("La respuesta no puede estar vacia."); return; }
        if (m !== "Cualquiera" && !p) { alert("La condicion no puede estar vacia."); return; }
        uiRules[idx] = {
          ...uiRules[idx],
          name: String(name.value || "").trim(),
          enabled: enabled.checked,
          mode: m,
          text: m === "Regex" || m === "Cualquiera" ? "" : p,
          rawRegex: m === "Regex" ? p : "",
          reply: rep
        };
        await publishRules();
        render();
        modal.remove();
      };
      modal.addEventListener("click", (e)=>{ if (e.target === modal) modal.remove(); });
      wrap.append(modal);
    };

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
      }
      await saveDraft();
      render();
    })();
  }

  async function openTrackingModal({ loadAnalytics, saveFollowups }){
    Q("#vz2-track-root")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "vz2-track-root";
    wrap.className = "vz2-modal";
    wrap.innerHTML = `
      <div class="vz2-panel">
        <div class="vz2-phd">
          <div class="vz2-title"><span class="vz2-titleIcon">#</span>Seguimiento</div>
          <div class="vz2-sp"></div>
          <div class="vz2-tabs">
            <button class="vz2-tab active" data-tab="chats">Chats</button>
            <button class="vz2-tab" data-tab="followups">Seguimientos</button>
          </div>
          <button class="vz2-btn" data-close>Cerrar</button>
        </div>
        <div class="vz2-pbd">
          <div data-view="chats">
            <div class="vz2-trackStats" data-stats></div>
            <div class="vz2-field vz2-trackSection">
              <div class="vz2-label">Reglas mas usadas</div>
              <div class="vz2-trackList" data-rules></div>
            </div>
            <div class="vz2-field vz2-trackSection">
              <div class="vz2-label">Chats</div>
              <div class="vz2-trackList" data-threads></div>
            </div>
          </div>
          <div data-view="followups" style="display:none">
            <div class="vz2-field">
              <div class="vz2-label">Crear seguimiento global</div>
              <button class="vz2-btn pr" data-open-add-followup>Nuevo seguimiento</button>
            </div>
            <div class="vz2-field vz2-trackSection">
              <div class="vz2-label">Plantillas de seguimiento (se aplican a todos los chats entrantes)</div>
              <div class="vz2-trackList" data-followups></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const close = () => wrap.remove();
    Q("[data-close]", wrap).onclick = close;
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

    const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[m]));
    const fmtTs = (ts) => ts ? new Date(ts).toLocaleString() : "-";

    let activeTab = "chats";
    const setTab = (tab) => {
      activeTab = tab;
      QA("[data-tab]", wrap).forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
      QA("[data-view]", wrap).forEach((v) => v.style.display = (v.getAttribute("data-view") === tab ? "" : "none"));
    };
    QA("[data-tab]", wrap).forEach((b) => {
      b.onclick = () => setTab(b.getAttribute("data-tab"));
    });

    const render = async () => {
      const data = await loadAnalytics();
      const totals = data?.totals || {};
      const rules = Array.isArray(data?.rules) ? data.rules : [];
      const threads = Array.isArray(data?.threads) ? data.threads : [];
      const followups = Array.isArray(data?.followups) ? data.followups : [];

      Q("[data-stats]", wrap).innerHTML = `
        <div class="vz2-stat"><div class="vz2-statK">Chats</div><div class="vz2-statV">${totals.chats || 0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Entrantes</div><div class="vz2-statV">${totals.incoming || 0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Respuestas</div><div class="vz2-statV">${totals.replies || 0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Seguimientos</div><div class="vz2-statV">${totals.followups || 0}</div></div>
      `;

      const rulesBox = Q("[data-rules]", wrap);
      if (!rules.length) {
        rulesBox.innerHTML = `<div class="vz2-trackEmpty">Sin datos aun.</div>`;
      } else {
        rulesBox.innerHTML = rules.slice(0, 8).map((r) => `
          <div class="vz2-trackItem">
            <div class="vz2-trackHead">
              <div class="vz2-trackTid">${esc(r.label || r.id)}</div>
              <div class="vz2-trackMeta">${r.count || 0} usos</div>
            </div>
            <div class="vz2-trackMeta">Ultimo uso: ${fmtTs(r.lastAt)}</div>
          </div>
        `).join("");
      }

      const threadsBox = Q("[data-threads]", wrap);
      threadsBox.innerHTML = "";
      if (!threads.length) {
        threadsBox.innerHTML = `<div class="vz2-trackEmpty">Aun no hay chats detectados.</div>`;
      } else {
        threads.forEach((t) => {
          const item = document.createElement("div");
          item.className = "vz2-trackItem";
          item.innerHTML = `
            <div class="vz2-trackHead">
              <div class="vz2-trackTid">${esc(t.tid || "-")}</div>
              <div class="vz2-trackMeta">${fmtTs(t.lastIncomingAt)}</div>
            </div>
            <div class="vz2-trackMeta">Entrantes: ${t.incomingCount || 0} | Respuestas: ${t.replyCount || 0} | Seguimientos: ${t.followupCount || 0}</div>
            <div class="vz2-trackRule">Ultima regla: ${esc(t.lastRuleLabel || "-")}</div>
            <div class="vz2-trackMeta">Ultimo seguimiento: ${esc(t.lastFollowupLabel || "-")}</div>
            <div class="vz2-trackMeta">Ultimo mensaje: ${esc((t.lastIncomingText || "").slice(0, 160))}</div>
          `;
          threadsBox.append(item);
        });
      }

      const followupsBox = Q("[data-followups]", wrap);
      followupsBox.innerHTML = "";
      if (!followups.length) {
        followupsBox.innerHTML = `<div class="vz2-trackEmpty">Aun no creas seguimientos.</div>`;
      } else {
        followups.forEach((f, idx) => {
          const row = document.createElement("div");
          row.className = "vz2-trackItem";
          row.innerHTML = `
            <div class="vz2-trackHead">
              <div class="vz2-trackTid">${esc(f.name || `Seguimiento ${idx + 1}`)}</div>
              <label class="vz2-trackMeta"><input type="checkbox" data-enabled ${f.enabled ? "checked" : ""}> Activo</label>
            </div>
            <div class="vz2-row">
              <input class="vz2-trackInput" data-name value="${esc(f.name || "")}" placeholder="Nombre" style="width:150px">
              <input class="vz2-trackInput" data-min type="number" min="1" value="${Number(f.delayMin || 5)}" title="Minutos" placeholder="Min" style="width:90px">
              <input class="vz2-trackInput" data-text value="${esc(f.text || "")}" placeholder="Mensaje" style="flex:1">
              <button class="vz2-iconBtn" data-save title="Guardar seguimiento" aria-label="Guardar seguimiento">💾</button>
              <button class="vz2-iconBtn warn" data-del title="Eliminar seguimiento" aria-label="Eliminar seguimiento">🗑</button>
            </div>
          `;
          Q("[data-save]", row).onclick = async () => {
            const next = [...followups];
            next[idx] = {
              ...next[idx],
              enabled: !!Q("[data-enabled]", row).checked,
              name: String(Q("[data-name]", row).value || "").trim(),
              delayMin: Number(Q("[data-min]", row).value || 5),
              text: String(Q("[data-text]", row).value || "")
            };
            await saveFollowups(next);
            await render();
          };
          Q("[data-del]", row).onclick = async () => {
            const next = followups.filter((_, i) => i !== idx);
            await saveFollowups(next);
            await render();
          };
          followupsBox.append(row);
        });
      }
    };

    Q("[data-open-add-followup]", wrap).onclick = async () => {
      const modal = document.createElement("div");
      modal.className = "vz2-modal";
      modal.innerHTML = `
        <div class="vz2-panel" style="max-width:520px">
          <div class="vz2-phd">
            <div class="vz2-title"><span class="vz2-titleIcon">+</span>Nuevo seguimiento</div>
            <div class="vz2-sp"></div>
            <button class="vz2-btn" data-close-add>Cerrar</button>
          </div>
          <div class="vz2-pbd">
            <div class="vz2-field">
              <div class="vz2-label">Nombre</div>
              <input class="vz2-input" data-add-name placeholder="Seguimiento 1">
            </div>
            <div class="vz2-field">
              <div class="vz2-label">Tiempo de espera (minutos)</div>
              <input class="vz2-input" data-add-min type="number" min="1" value="5" placeholder="5">
            </div>
            <div class="vz2-field">
              <div class="vz2-label">Mensaje</div>
              <textarea class="vz2-ta" data-add-text placeholder="Mensaje que se enviara automaticamente"></textarea>
            </div>
            <div class="vz2-actions">
              <button class="vz2-btn" data-cancel-add>Cancelar</button>
              <button class="vz2-btn pr" data-save-add>Guardar</button>
            </div>
          </div>
        </div>
      `;

      const closeAdd = () => modal.remove();
      Q("[data-close-add]", modal).onclick = closeAdd;
      Q("[data-cancel-add]", modal).onclick = closeAdd;
      modal.addEventListener("click", (e) => { if (e.target === modal) closeAdd(); });

      Q("[data-save-add]", modal).onclick = async () => {
        const data = await loadAnalytics();
        const curr = Array.isArray(data?.followups) ? data.followups : [];
        const nameInput = String(Q("[data-add-name]", modal).value || "").trim();
        const name = nameInput || `Seguimiento ${curr.length + 1}`;
        const delayMin = Math.max(1, Number(Q("[data-add-min]", modal).value || 5));
        const text = String(Q("[data-add-text]", modal).value || "").trim();
        if (!text) { alert("Escribe el mensaje de seguimiento."); return; }
        const item = { id: `fu_${Date.now()}`, name, delayMin, text, enabled: true };
        await saveFollowups([...curr, item]);
        closeAdd();
        await render();
        setTab("followups");
      };

      document.documentElement.append(modal);
      Q("[data-add-name]", modal)?.focus();
    };

    document.documentElement.append(wrap);
    setTab(activeTab);
    await render();
  }

  async function openRulesModal({ loadRules, saveRules }){
    openRulesPanelV2({ loadRules, saveRules });
  }

  window.VZUI = { injectTopBar, openRulesModal, openTrackingModal };
})();



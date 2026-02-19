// ui.js - Panel visual de reglas para VZ-Bot
// v3 — injectTopBar con spacer fisico + observer agresivo para FB

(() => {
  "use strict";

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

  cssOnce("vz-ui-saas-css", `
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
  .vz2-wrap,.vz2-wrap *,.vz2-modal,.vz2-modal *,#vz-topbar,#vz-topbar *{font-family:'Poppins',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif !important}
  .vz2-wrap{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 700px at 90% -10%,rgba(56,189,248,.18),transparent),rgba(2,6,23,.72)}
  .vz2-dialog{width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:column;background:linear-gradient(170deg,#0b1220,#0a1426);border:1px solid rgba(148,163,184,.28);border-radius:16px;color:#e2e8f0;box-shadow:0 28px 90px rgba(0,0,0,.55);animation:vz2FadeUp .2s ease-out}
  .vz2-hd{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid rgba(148,163,184,.2)}
  .vz2-title{font:700 16px/1.2 system-ui;color:#f8fafc;display:flex;align-items:center;gap:8px}
  .vz2-titleIcon{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;background:#0b2540;color:#7dd3fc;border:1px solid rgba(125,211,252,.35);font:700 12px/1 system-ui}
  .vz2-sp{flex:1}
  .vz2-btn{background:#1e293b;color:#f8fafc;border:1px solid rgba(148,163,184,.28);border-radius:10px;padding:8px 10px;font:600 13px system-ui;cursor:pointer}
  .vz2-btn:hover{filter:brightness(1.1)}
  .vz2-btn.pr{background:#059669}
  .vz2-btn.info{background:#0e7490}
  .vz2-btn.warn{background:#b91c1c}
  .vz2-bd{padding:14px;overflow:auto;min-height:0}
  .vz2-grid{display:flex;flex-direction:column;gap:12px;align-items:center}
  .vz2-card{background:#0f172a;border:1px solid rgba(148,163,184,.22);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;width:min(500px,100%);position:relative;cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;animation:vz2CardIn .24s ease both;overflow:visible}
  .vz2-card.menu-open{z-index:40}
  .vz2-card:hover{border-color:rgba(56,189,248,.55);box-shadow:0 0 0 1px rgba(56,189,248,.18) inset;transform:translateY(-1px)}
  .vz2-cardHead{display:flex;align-items:center;gap:8px;justify-content:space-between}
  .vz2-topMeta{display:flex;align-items:center;gap:6px;justify-content:flex-end;flex:0 0 auto}
  .vz2-name{font:700 14px/1.2 system-ui;color:#f8fafc}
  .vz2-preview{font:12px/1.3 system-ui;color:#94a3b8;margin-top:2px}
  .vz2-chips{display:flex;gap:6px;flex-wrap:wrap}
  .vz2-chip{font:600 11px/1.1 system-ui;border-radius:999px;padding:5px 8px;border:1px solid rgba(148,163,184,.3);background:#1e293b}
  .vz2-chip.kw{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;background:#0b2540;border-color:rgba(125,211,252,.45);color:#cfefff}
  .vz2-chipX{border:0;background:transparent;color:#9ad8ff;font:700 12px/1 system-ui;cursor:pointer;padding:0;width:14px;height:14px;line-height:14px}
  .vz2-chip.on{background:#065f46;border-color:#10b981}
  .vz2-chip.off{background:#3f3f46;border-color:#71717a}
  .vz2-row{display:flex;gap:8px;align-items:center}
  .vz2-menuBtn{width:30px;height:30px;border-radius:8px;background:#111827;border:1px solid rgba(148,163,184,.35);color:#cbd5e1;cursor:pointer}
  .vz2-menu{position:absolute;right:8px;top:46px;min-width:150px;background:#0b1220;border:1px solid rgba(148,163,184,.35);border-radius:10px;padding:6px;display:none;flex-direction:column;gap:4px;z-index:60;transform-origin:top right}
  .vz2-menu.open{display:flex;animation:vz2Pop .14s ease-out}
  .vz2-menuItem{background:#111827;border:1px solid rgba(148,163,184,.2);color:#e2e8f0;border-radius:8px;padding:8px 10px;font:600 12px system-ui;text-align:left;cursor:pointer}
  .vz2-menuItem:hover{filter:brightness(1.08)}
  .vz2-menuItem.warn{background:#3f1d1d;border-color:#7f1d1d}
  .vz2-empty{padding:20px;text-align:center;border:1px dashed rgba(148,163,184,.3);border-radius:12px;color:#94a3b8}
  .vz2-iconBtn{width:32px;height:32px;border-radius:8px;border:1px solid rgba(148,163,184,.28);background:#111827;color:#e2e8f0;cursor:pointer;font:700 14px/1 system-ui;display:inline-flex;align-items:center;justify-content:center}
  .vz2-iconBtn:hover{filter:brightness(1.1)}
  .vz2-iconBtn.warn{background:#3f1d1d;border-color:#7f1d1d}
  .vz2-modal{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.62)}
  .vz2-panel{width:min(620px,94vw);max-height:90vh;overflow:auto;background:#0f172a;border:1px solid rgba(148,163,184,.32);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.55);animation:vz2Pop .18s ease-out}
  .vz2-helpFrame{width:min(620px,92vw);aspect-ratio:16/9;border:0;border-radius:12px;background:#000}
  .vz2-phd{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid rgba(148,163,184,.2)}
  .vz2-pbd{padding:14px;display:flex;flex-direction:column;gap:12px}
  .vz2-field{display:flex;flex-direction:column;gap:6px}
  .vz2-label{font:600 12px system-ui;color:#cbd5e1}
  .vz2-input,.vz2-select,.vz2-ta{background:#0b1220;color:#e2e8f0;border:1px solid rgba(148,163,184,.3);border-radius:10px;padding:9px 10px;font:13px system-ui;outline:none}
  .vz2-input:focus,.vz2-select:focus,.vz2-ta:focus{border-color:#38bdf8}
  .vz2-ta{min-height:120px;resize:vertical}
  .vz2-actions{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
  .vz2-trackStats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  .vz2-stat{background:#0b1220;border:1px solid rgba(148,163,184,.28);border-radius:10px;padding:10px}
  .vz2-statK{font:600 11px/1 system-ui;color:#94a3b8}
  .vz2-statV{font:700 18px/1.1 system-ui;color:#f8fafc;margin-top:6px}
  .vz2-trackList{display:flex;flex-direction:column;gap:8px}
  .vz2-trackItem{background:#0b1220;border:1px solid rgba(148,163,184,.28);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
  .vz2-trackHead{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .vz2-trackTid{font:600 12px/1.2 system-ui;color:#f8fafc}
  .vz2-trackMeta{font:12px/1.3 system-ui;color:#94a3b8}
  .vz2-trackRule{font:600 11px/1.2 system-ui;color:#7dd3fc}
  .vz2-trackInput{background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.3);border-radius:8px;padding:7px 8px;font:12px system-ui}
  .vz2-trackEmpty{font:12px/1.4 system-ui;color:#94a3b8;border:1px dashed rgba(148,163,184,.28);border-radius:10px;padding:10px}
  .vz2-trackSection{margin-top:8px}
  .vz2-trackSection .vz2-label{margin-bottom:4px}
  .vz2-tabs{display:flex;gap:8px}
  .vz2-tab{background:#1e293b;color:#cbd5e1;border:1px solid rgba(148,163,184,.25);border-radius:8px;padding:7px 10px;font:600 12px system-ui;cursor:pointer}
  .vz2-tab.active{background:#0e7490;color:#fff;border-color:#38bdf8}
  @keyframes vz2FadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes vz2Pop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
  @keyframes vz2CardIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  `);

  const UI_KEY = "__vz_rules_ui";
  let uiRules = [], panelOpen = false;

  const templates = [
    { label:"Saludo",     prefill:{ enabled:true, mode:"Contiene", text:"hola",     words:["hola","buenas","saludos"], rawRegex:"", reply:"Hola! Cuentame un poco mas para ayudarte." } },
    { label:"Precio",     prefill:{ enabled:true, mode:"Contiene", text:"precio",   words:["precio","valor","costo"],  rawRegex:"", reply:"Nuestros precios varian segun el producto.\nDe que producto te interesa saber el precio?" } },
    { label:"Horarios",   prefill:{ enabled:true, mode:"Contiene", text:"horario",  words:["horario","hora","atienden"], rawRegex:"", reply:"Horario de atencion:\nLun-Vie: 8:00-18:00\nSab: 9:00-13:00" } },
    { label:"Envios",     prefill:{ enabled:true, mode:"Contiene", text:"envio",    words:["envio","entrega","domicilio"], rawRegex:"", reply:"Si! Realizamos envios. Cual es tu ciudad para cotizar?" } },
    { label:"Nombre",     prefill:{ enabled:true, mode:"Contiene", text:"me llamo", words:["soy","me llamo"], rawRegex:"", reply:"Mucho gusto! En que te ayudo?" } },
    { label:"Cualquiera", prefill:{ enabled:true, mode:"Cualquiera", rawRegex:"", text:"", words:[], reply:"Gracias por tu mensaje! En un momento un asesor revisara tu consulta." } },
  ];

  function compileForEngine(list){
    const out = [];
    for (const r of list) {
      if (!r.enabled) continue;
      let pattern = "";
      if (r.mode === "Cualquiera") { pattern = "[\\s\\S]+"; }
      else if (r.mode === "Regex") { pattern = String(r.rawRegex||"").trim(); if (!pattern) continue; }
      else {
        const words = Array.isArray(r.words) ? r.words.map(w=>String(w||"").trim()).filter(Boolean) : [];
        const source = words.length ? words : [String(r.text||"").trim()];
        const escaped = source.map(w=>escapeRegExp(w)).filter(Boolean);
        if (!escaped.length) continue;
        const e = escaped.length===1 ? escaped[0] : `(?:${escaped.join("|")})`;
        switch(r.mode){
          case "Contiene": pattern=e; break; case "Empieza": pattern=`^${e}`; break;
          case "Termina":  pattern=`${e}$`; break; case "Igual a": pattern=`^${e}$`; break;
          default: pattern=e;
        }
      }
      out.push({ pattern, flags:"i", reply:String(r.reply||"") });
    }
    return out;
  }

  function inflateFromCompiled(compiled){
    return (compiled||[]).map(r=>{
      const patt=String(r.pattern||""); let mode="Regex",text="",rawRegex=patt;
      if(patt==="[\\s\\S]+"||patt==="[\\s\\S]+?"){mode="Cualquiera";rawRegex="";}
      else if(/^\^.*\$$/.test(patt)&&!/[.*+?()|[\]\\]/.test(patt.slice(1,-1))){mode="Igual a";text=patt.slice(1,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");}
      else if(/^\^.+/.test(patt)&&!/[.*+?()|[\]\\]/.test(patt.slice(1))){mode="Empieza";text=patt.slice(1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");}
      else if(/.+\$$/.test(patt)&&!/[.*+?()|[\]\\]/.test(patt.slice(0,-1))){mode="Termina";text=patt.slice(0,-1).replace(/\\([.*+?^${}()|[\]\\])/g,"$1");}
      else if(!/[.*+?()|[\]\\^$]/.test(patt)){mode="Contiene";text=patt.replace(/\\([.*+?^${}()|[\]\\])/g,"$1");}
      return {enabled:true,mode,text,rawRegex,words:text?[text]:[],reply:String(r.reply||"")};
    });
  }

  /* ══════════════════════════════════════════════════════════════
     injectTopBar v4 — DEFINITIVA

     FB tiene DOS layers de headers fixed independientes:
       1. Header top  (logo, busqueda, notificaciones) — top:0
       2. Nav iconos  (Inicio, Marketplace, etc.)      — top:56px

     Estrategia:
       A) body { margin-top: BAR_H } + spacer fisico en body
          → empuja el flujo estatico del documento
       B) Observer sin filtro de ancho que guarda el top original
          de cada elemento y le suma BAR_H de forma incremental.
          Asi header1 (0→44) y nav (56→100) se compensan ambos.
  ══════════════════════════════════════════════════════════════ */
  function injectTopBar({ getEnabled, setEnabled, onOpenRules, onOpenTracking, onGoMessenger, onGoRenew }) {
    const BAR_ID    = "vz-topbar";
    const SPACER_ID = "vz-topbar-spacer";
    const STYLE_ID  = "vz-topbar-style";
    const BAR_H     = 44;

    if (document.getElementById(BAR_ID)) return;

    /* CSS */
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = `
        body { margin-top: ${BAR_H}px !important; }
        #${SPACER_ID} {
          display: block !important; width: 100% !important;
          height: ${BAR_H}px !important; min-height: ${BAR_H}px !important;
          flex-shrink: 0 !important; pointer-events: none !important;
          background: transparent !important; position: static !important;
        }
        #${BAR_ID} {
          position: fixed !important; top: 0 !important;
          left: 0 !important; right: 0 !important;
          height: ${BAR_H}px !important; z-index: 2147483646 !important;
          display: flex !important; align-items: center !important;
          gap: 8px !important; padding: 0 12px !important;
          overflow-x: auto !important; overflow-y: hidden !important;
          white-space: nowrap !important; scrollbar-width: none !important;
          background: linear-gradient(90deg,#0f172a 0%,#1e293b 100%) !important;
          border-bottom: 1px solid rgba(148,163,184,.25) !important;
          box-shadow: 0 2px 12px rgba(0,0,0,.45) !important;
          color: #f8fafc !important;
          font: 600 13px/1 'Poppins',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif !important;
          user-select: none !important; box-sizing: border-box !important;
        }
        #${BAR_ID}::-webkit-scrollbar { display: none !important; }
      `;
      document.documentElement.appendChild(st);
    }

    /* Spacer fisico */
    const insertSpacer = () => {
      if (document.getElementById(SPACER_ID)) return;
      const sp = document.createElement("div"); sp.id = SPACER_ID;
      if (document.body) document.body.insertBefore(sp, document.body.firstChild);
    };
    if (document.body) insertSpacer();
    else document.addEventListener("DOMContentLoaded", insertSpacer, { once: true });

    /* Barra visual */
    const bar = document.createElement("div"); bar.id = BAR_ID;
    const path = String(location.pathname || "");
    const isMessagesPage = path.startsWith("/messages/");
    const isRenewPage = path.startsWith("/marketplace/selling/renew_listings") || path.startsWith("/marketplace/selling/relist_items");
    const isAutomationPage = isMessagesPage || isRenewPage;

    const brand = document.createElement("span");
    brand.textContent = "NETMAGI";
    Object.assign(brand.style, { color:"#7dd3fc", fontWeight:"700", marginRight:"4px", letterSpacing:".3px" });

    const sep = () => {
      const d = document.createElement("div");
      Object.assign(d.style, { width:"1px", height:"20px", background:"rgba(148,163,184,.3)", margin:"0 4px", flexShrink:"0" });
      return d;
    };

    const status = document.createElement("span");
    const updateStatus = (on) => {
      status.textContent = on ? "Auto: ON" : "Auto: OFF";
      Object.assign(status.style, {
        padding:"3px 10px", borderRadius:"99px", fontSize:"12px", fontWeight:"700",
        background: on ? "rgba(16,185,129,.18)" : "rgba(107,114,128,.18)",
        border: `1px solid ${on ? "#10b981" : "#6b7280"}`,
        color:  on ? "#6ee7b7" : "#9ca3af",
      });
    };
    updateStatus(getEnabled());

    const mkBtn = (label, bg, border) => {
      const b = document.createElement("button"); b.textContent = label;
      Object.assign(b.style, { padding:"5px 13px", borderRadius:"8px", border:`1px solid ${border}`, background:bg, color:"#fff", font:"600 12px system-ui", cursor:"pointer", transition:"filter .15s", flexShrink:"0" });
      b.onmouseenter = () => (b.style.filter = "brightness(1.15)");
      b.onmouseleave = () => (b.style.filter = "");
      return b;
    };

    const btnToggle = mkBtn(getEnabled() ? "Pausar" : "Reanudar", getEnabled() ? "#065f46" : "#374151", getEnabled() ? "#10b981" : "#6b7280");
    btnToggle.onclick = () => {
      const next = !getEnabled(); setEnabled(next); updateStatus(next);
      btnToggle.textContent = next ? "Pausar" : "Reanudar";
      btnToggle.style.background  = next ? "#065f46" : "#374151";
      btnToggle.style.borderColor = next ? "#10b981" : "#6b7280";
    };
    const btnRules    = mkBtn("Reglas",      "#4c1d95", "#7c3aed"); btnRules.onclick    = () => onOpenRules?.();
    const btnTracking = mkBtn("Seguimiento", "#0c4a6e", "#0e7490"); btnTracking.onclick = () => onOpenTracking?.();
    const goTo = (url) => { try { location.href = url; } catch { window.open(url, "_self"); } };
    const btnMessenger = mkBtn("Messenger", "#1d4ed8", "#3b82f6");
    btnMessenger.onclick = () => onGoMessenger?.() ?? goTo("https://www.facebook.com/messages/");
    const btnRenew = mkBtn("Renovar", "#92400e", "#f59e0b");
    btnRenew.onclick = () => onGoRenew?.() ?? goTo("https://www.facebook.com/marketplace/selling/renew_listings/");

    const helper = document.createElement("span");
    helper.textContent = isAutomationPage ? "Panel activo" : "Accesos directos";
    Object.assign(helper.style, { color:"#cbd5e1", fontSize:"12px", fontWeight:"600", marginRight:"2px", flexShrink:"0" });

    if (isAutomationPage) {
      bar.append(brand, sep(), status, sep(), btnToggle, btnRules, btnTracking, sep(), helper);
      if (!isMessagesPage) bar.append(btnMessenger);
      if (!isRenewPage) bar.append(btnRenew);
    } else {
      bar.append(brand, sep(), helper, btnMessenger, btnRenew);
    }
    document.documentElement.appendChild(bar); // fuera del body

    /* Observer: guarda top original y suma BAR_H a cada header fixed/sticky */
    const OUR_IDS  = new Set([BAR_ID, SPACER_ID, STYLE_ID]);
    const origTops = new WeakMap();

    const compensate = () => {
      if (!document.getElementById(SPACER_ID)) insertSpacer();

      const els = document.querySelectorAll("div,nav,header,aside,section,ul");
      for (const el of els) {
        if (OUR_IDS.has(el.id)) continue;
        if (el.closest("#" + BAR_ID)) continue;

        const cs = window.getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (cs.display  === "none") continue;

        // Guardar top original la PRIMERA vez que vemos el elemento
        if (!origTops.has(el)) {
          // Leer el valor del atributo data si ya lo marcamos antes
          const saved = el.getAttribute("data-vz-orig");
          if (saved !== null) {
            origTops.set(el, parseFloat(saved));
          } else {
            const raw = parseFloat(cs.top) || 0;
            // Solo guardar si aun no esta compensado por nosotros
            const orig = raw >= BAR_H ? raw - BAR_H : raw;
            origTops.set(el, orig);
            el.setAttribute("data-vz-orig", String(orig));
          }
        }

        const orig      = origTops.get(el);
        const targetTop = orig + BAR_H;
        const current   = parseFloat(cs.top) || 0;

        // Actuar solo si el elemento esta visualmente en los primeros 400px
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0) continue;
        if (rect.top > 400)  continue;

        if (Math.abs(current - targetTop) > 2) {
          el.style.setProperty("top", targetTop + "px", "important");
        }
      }
    };

    let rafPending = false;
    const scheduleCompensate = () => {
      if (rafPending) return; rafPending = true;
      requestAnimationFrame(() => { rafPending = false; compensate(); });
    };

    new MutationObserver(scheduleCompensate).observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["style", "class"],
    });

    compensate();
    [100, 300, 700, 1500, 3000, 6000].forEach(ms => setTimeout(compensate, ms));
  }
  /* ══════════════════════════════════════════════════════════════
     openRulesPanelV2
  ══════════════════════════════════════════════════════════════ */
  function openRulesPanelV2({ loadRules, saveRules }){
    if (panelOpen) return;
    panelOpen = true;
    Q("#vz2-root")?.remove();

    const wrap = document.createElement("div"); wrap.id="vz2-root"; wrap.className="vz2-wrap";
    const dlg  = document.createElement("div"); dlg.className="vz2-dialog";
    const hd   = document.createElement("div"); hd.className="vz2-hd";
    hd.innerHTML=`<div><div class="vz2-title"><span class="vz2-titleIcon">&#9881;</span>Gestion de reglas</div></div><div class="vz2-sp"></div>`;

    const mkBH=(l,c="")=>{const b=document.createElement("button");b.className="vz2-btn"+(c?` ${c}`:"");b.textContent=l;return b;};
    const esc=(s)=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

    const btnNew=mkBH("Nueva regla","pr"),btnHelp=mkBH("Ayuda","info"),btnClose=mkBH("Cerrar"),btnExport=mkBH("Exportar");
    hd.append(btnNew,btnExport,btnHelp,btnClose);
    const bd=document.createElement("div");bd.className="vz2-bd";
    const grid=document.createElement("div");grid.className="vz2-grid";
    bd.append(grid);dlg.append(hd,bd);wrap.append(dlg);document.documentElement.append(wrap);

    const closePanel=()=>{wrap.remove();panelOpen=false;};
    btnClose.onclick=closePanel;
    wrap.addEventListener("click",(e)=>{if(e.target===wrap)closePanel();});
    document.addEventListener("click",(e)=>{
      if(!Q("#vz2-root"))return;
      if(!e.target.closest(".vz2-menu")&&!e.target.closest(".vz2-menuBtn"))
        QA(".vz2-menu.open",wrap).forEach(m=>m.classList.remove("open"));
    });
    wrap.addEventListener("keydown",(e)=>{
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();publishRules();}
      if(e.key==="Escape"){e.preventDefault();const m=Q(".vz2-modal",wrap);if(m)m.remove();else closePanel();}
    });

    const summarize=(r,i)=>({nm:String(r.name||"").trim()||`Regla ${i+1}`,preview:r.mode==="Regex"?String(r.rawRegex||""):(Array.isArray(r.words)&&r.words.length?r.words.join(" | "):String(r.text||""))});
    const saveDraft=async()=>{await S.set(UI_KEY,uiRules);};
    const publishRules=async()=>{await saveRules(JSON.stringify(compileForEngine(uiRules),null,2));await saveDraft();};

    btnExport.onclick=async()=>{
      const blob=new Blob([JSON.stringify(compileForEngine(uiRules),null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);const a=document.createElement("a");
      a.href=url;a.download=`vz-rules-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
    };
    btnNew.onclick=()=>{uiRules.push({name:"",enabled:true,mode:"Contiene",text:"",words:[],rawRegex:"",reply:""});openEditor(uiRules.length-1,true);};
    btnHelp.onclick=()=>{
      Q(".vz2-modal",wrap)?.remove();
      const help=document.createElement("div");help.className="vz2-modal";
      help.innerHTML=`<div class="vz2-panel"><div class="vz2-phd"><div class="vz2-title"><span class="vz2-titleIcon">?</span>Ayuda</div><div class="vz2-sp"></div><button class="vz2-btn" data-close-help>Cerrar</button></div><div class="vz2-pbd" style="align-items:center"><iframe class="vz2-helpFrame" src="https://www.youtube.com/embed/M7lc1UVf-VE" title="Ayuda" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen></iframe></div></div>`;
      Q("[data-close-help]",help).onclick=()=>help.remove();
      help.addEventListener("click",(e)=>{if(e.target===help)help.remove();});
      wrap.append(help);
    };

    const render=()=>{
      grid.innerHTML="";
      if(!uiRules.length){const e=document.createElement("div");e.className="vz2-empty";e.textContent="No hay reglas. Crea una con 'Nueva regla'.";grid.append(e);return;}
      uiRules.forEach((r,i)=>{
        const s=summarize(r,i);
        const card=document.createElement("div");card.className="vz2-card";
        card.onclick=(e)=>{if(e.target.closest(".vz2-menuBtn")||e.target.closest(".vz2-menu"))return;openEditor(i,false);};
        card.innerHTML=`
          <div class="vz2-cardHead">
            <div class="vz2-name">${esc(s.nm)}</div>
            <div class="vz2-topMeta">
              <span class="vz2-chip ${r.enabled?"on":"off"}">${r.enabled?"Activo":"Inactivo"}</span>
              <span class="vz2-chip">${esc(r.mode||"Contiene")}</span>
              <button class="vz2-menuBtn" title="Acciones">&#8942;</button>
            </div>
          </div>
          <div class="vz2-preview">${esc(s.preview||"(sin condicion)")}</div>
          <div class="vz2-menu">
            <button class="vz2-menuItem" data-action="toggle">${r.enabled?"Desactivar":"Activar"}</button>
            <button class="vz2-menuItem warn" data-action="delete">Eliminar</button>
          </div>`;
        const menuBtn=Q(".vz2-menuBtn",card),menu=Q(".vz2-menu",card);
        menuBtn.onclick=(e)=>{
          e.stopPropagation();
          QA(".vz2-menu.open",grid).forEach(m=>{if(m!==menu){m.classList.remove("open");m.closest(".vz2-card")?.classList.remove("menu-open");}});
          menu.classList.toggle("open");card.classList.toggle("menu-open",menu.classList.contains("open"));
        };
        Q('[data-action="toggle"]',card).onclick=async(e)=>{e.stopPropagation();uiRules[i].enabled=!uiRules[i].enabled;await publishRules();render();};
        Q('[data-action="delete"]',card).onclick=async(e)=>{e.stopPropagation();if(!confirm("Eliminar esta regla?"))return;uiRules.splice(i,1);await publishRules();render();};
        card.addEventListener("mouseleave",()=>{menu.classList.remove("open");card.classList.remove("menu-open");});
        grid.append(card);
      });
    };

    const openEditor=(idx,isNew)=>{
      Q(".vz2-modal",wrap)?.remove();
      const r=uiRules[idx];
      const modal=document.createElement("div");modal.className="vz2-modal";
      modal.innerHTML=`
        <div class="vz2-panel">
          <div class="vz2-phd">
            <div class="vz2-title"><span class="vz2-titleIcon">${isNew?"+":"&#9998;"}</span>${isNew?"Nueva regla":"Editar regla"}</div>
            <div class="vz2-sp"></div><button class="vz2-btn" data-close>Cerrar</button>
          </div>
          <div class="vz2-pbd">
            <div class="vz2-field"><div class="vz2-label">Nombre</div><input class="vz2-input" data-name placeholder="Ej: Regla de saludo"></div>
            <div class="vz2-row"><input type="checkbox" data-enabled><span class="vz2-label">Regla activa</span></div>
            <div class="vz2-field"><div class="vz2-label">Modo</div>
              <select class="vz2-select" data-mode><option>Cualquiera</option><option>Contiene</option><option>Igual a</option><option>Empieza</option><option>Termina</option></select>
            </div>
            <div class="vz2-field">
              <div class="vz2-label" data-pattern-label>Patron / condicion</div>
              <div class="vz2-row"><input class="vz2-input" data-pattern placeholder="Ej: precio" style="flex:1"><button class="vz2-btn" data-pattern-add>+</button></div>
              <div class="vz2-chips" data-pattern-chips></div>
            </div>
            <div class="vz2-field"><div class="vz2-label">Respuesta automatica</div><textarea class="vz2-ta" data-reply></textarea></div>
            <div class="vz2-actions">
              <button class="vz2-btn warn" data-delete>Eliminar</button>
              <button class="vz2-btn" data-cancel>Cancelar</button>
              <button class="vz2-btn pr" data-save>Guardar</button>
            </div>
          </div>
        </div>`;
      const nameEl=Q("[data-name]",modal),enabledEl=Q("[data-enabled]",modal),modeEl=Q("[data-mode]",modal);
      const patEl=Q("[data-pattern]",modal),addBtn=Q("[data-pattern-add]",modal);
      const chipsEl=Q("[data-pattern-chips]",modal),plEl=Q("[data-pattern-label]",modal),replyEl=Q("[data-reply]",modal);
      let words=Array.isArray(r.words)?[...r.words]:[];
      if(!words.length&&r.text&&r.mode!=="Cualquiera")words=[String(r.text)];
      nameEl.value=r.name||"";enabledEl.checked=!!r.enabled;
      modeEl.value=(r.mode==="Regex"?"Contiene":(r.mode||"Contiene"));replyEl.value=r.reply||"";
      const addWord=()=>{const w=String(patEl.value||"").trim();if(!w)return;if(words.some(x=>String(x).toLowerCase()===w.toLowerCase())){patEl.value="";return;}words.push(w);patEl.value="";renderWords();};
      const removeWordAt=(i)=>{words.splice(i,1);renderWords();};
      const renderWords=()=>{
        chipsEl.innerHTML="";
        if(!words.length){chipsEl.innerHTML=`<span class="vz2-trackMeta">Sin palabras agregadas.</span>`;return;}
        words.forEach((w,i)=>{const chip=document.createElement("span");chip.className="vz2-chip kw";chip.innerHTML=`${esc(w)} <button class="vz2-chipX">&times;</button>`;Q(".vz2-chipX",chip).onclick=()=>removeWordAt(i);chipsEl.append(chip);});
      };
      const syncMode=()=>{
        if(modeEl.value==="Cualquiera"){plEl.textContent="Sin condicion (responde a cualquiera)";patEl.disabled=true;patEl.value="";addBtn.style.display="none";chipsEl.style.display="none";}
        else{plEl.textContent="Palabras a coincidir (Enter o +)";patEl.disabled=false;patEl.placeholder="Ej: precio";addBtn.style.display="";chipsEl.style.display="";}
      };
      modeEl.onchange=syncMode;addBtn.onclick=addWord;
      patEl.addEventListener("keydown",(e)=>{if(e.key==="Enter"){e.preventDefault();addWord();}});
      renderWords();syncMode();
      Q("[data-close]",modal).onclick=()=>modal.remove();
      Q("[data-cancel]",modal).onclick=()=>modal.remove();
      Q("[data-delete]",modal).onclick=async()=>{if(!confirm("Eliminar esta regla?"))return;uiRules.splice(idx,1);await publishRules();render();modal.remove();};
      Q("[data-save]",modal).onclick=async()=>{
        const m=modeEl.value,p=String(patEl.value||"").trim();
        if(m!=="Cualquiera"&&p)addWord();
        const rep=String(replyEl.value||"").trim();
        if(!rep){alert("La respuesta no puede estar vacia.");return;}
        if(m!=="Cualquiera"&&!words.length){alert("La condicion no puede estar vacia.");return;}
        uiRules[idx]={...uiRules[idx],name:String(nameEl.value||"").trim(),enabled:enabledEl.checked,mode:m,words:m==="Cualquiera"?[]:words,text:m==="Cualquiera"?"":(words[0]||""),rawRegex:"",reply:rep};
        await publishRules();render();modal.remove();
      };
      modal.addEventListener("click",(e)=>{if(e.target===modal)modal.remove();});
      wrap.append(modal);
    };

    (async()=>{
      const uiSaved=await S.get(UI_KEY,null);
      if(Array.isArray(uiSaved)&&uiSaved.length){uiRules=uiSaved;}
      else{try{const compiled=JSON.parse(await loadRules());uiRules=inflateFromCompiled(compiled);}catch{uiRules=[];}}
      uiRules=uiRules.map(r=>{
        const next={...r};
        if(next.mode==="Regex"){next.mode="Contiene";const seed=String(next.text||next.rawRegex||"").trim();next.words=seed?[seed]:[];next.text=seed;next.rawRegex="";}
        else if(!Array.isArray(next.words)){const seed=String(next.text||"").trim();next.words=seed?[seed]:[];}
        return next;
      });
      await saveDraft();render();
    })();
  }

  /* ══════════════════════════════════════════════════════════════
     openTrackingModal
  ══════════════════════════════════════════════════════════════ */
  async function openTrackingModal({ loadAnalytics, saveFollowups }){
    Q("#vz2-track-root")?.remove();
    const wrap=document.createElement("div");wrap.id="vz2-track-root";wrap.className="vz2-modal";
    wrap.innerHTML=`
      <div class="vz2-panel">
        <div class="vz2-phd">
          <div class="vz2-title"><span class="vz2-titleIcon">#</span>Seguimiento</div>
          <div class="vz2-sp"></div>
          <div class="vz2-tabs"><button class="vz2-tab active" data-tab="chats">Chats</button><button class="vz2-tab" data-tab="followups">Seguimientos</button></div>
          <button class="vz2-btn" data-close>Cerrar</button>
        </div>
        <div class="vz2-pbd">
          <div data-view="chats">
            <div class="vz2-trackStats" data-stats></div>
            <div class="vz2-field vz2-trackSection"><div class="vz2-label">Reglas mas usadas</div><div class="vz2-trackList" data-rules></div></div>
            <div class="vz2-field vz2-trackSection"><div class="vz2-label">Chats</div><div class="vz2-trackList" data-threads></div></div>
          </div>
          <div data-view="followups" style="display:none">
            <div class="vz2-field"><div class="vz2-label">Crear seguimiento global</div><button class="vz2-btn pr" data-open-add-followup>Nuevo seguimiento</button></div>
            <div class="vz2-field vz2-trackSection"><div class="vz2-label">Plantillas de seguimiento</div><div class="vz2-trackList" data-followups></div></div>
          </div>
        </div>
      </div>`;
    const close=()=>wrap.remove();
    Q("[data-close]",wrap).onclick=close;
    wrap.addEventListener("click",(e)=>{if(e.target===wrap)close();});
    const esc=(s)=>String(s).replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":'&#39;'}[m]));
    const fmtTs=(ts)=>ts?new Date(ts).toLocaleString():"-";
    let activeTab="chats";
    const setTab=(tab)=>{activeTab=tab;QA("[data-tab]",wrap).forEach(b=>b.classList.toggle("active",b.getAttribute("data-tab")===tab));QA("[data-view]",wrap).forEach(v=>v.style.display=(v.getAttribute("data-view")===tab?"":"none"));};
    QA("[data-tab]",wrap).forEach(b=>{b.onclick=()=>setTab(b.getAttribute("data-tab"));});

    const render=async()=>{
      const data=await loadAnalytics();
      const totals=data?.totals||{},rules=Array.isArray(data?.rules)?data.rules:[],threads=Array.isArray(data?.threads)?data.threads:[],followups=Array.isArray(data?.followups)?data.followups:[];
      Q("[data-stats]",wrap).innerHTML=`
        <div class="vz2-stat"><div class="vz2-statK">Chats</div><div class="vz2-statV">${totals.chats||0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Entrantes</div><div class="vz2-statV">${totals.incoming||0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Respuestas</div><div class="vz2-statV">${totals.replies||0}</div></div>
        <div class="vz2-stat"><div class="vz2-statK">Seguimientos</div><div class="vz2-statV">${totals.followups||0}</div></div>`;
      const rulesBox=Q("[data-rules]",wrap);
      rulesBox.innerHTML=!rules.length?`<div class="vz2-trackEmpty">Sin datos aun.</div>`:rules.slice(0,8).map(r=>`<div class="vz2-trackItem"><div class="vz2-trackHead"><div class="vz2-trackTid">${esc(r.label||r.id)}</div><div class="vz2-trackMeta">${r.count||0} usos</div></div><div class="vz2-trackMeta">Ultimo uso: ${fmtTs(r.lastAt)}</div></div>`).join("");
      const threadsBox=Q("[data-threads]",wrap);threadsBox.innerHTML="";
      if(!threads.length){threadsBox.innerHTML=`<div class="vz2-trackEmpty">Aun no hay chats detectados.</div>`;}
      else threads.forEach(t=>{const item=document.createElement("div");item.className="vz2-trackItem";item.innerHTML=`<div class="vz2-trackHead"><div class="vz2-trackTid">${esc(t.tid||"-")}</div><div class="vz2-trackMeta">${fmtTs(t.lastIncomingAt)}</div></div><div class="vz2-trackMeta">Entrantes: ${t.incomingCount||0} | Respuestas: ${t.replyCount||0} | Seguimientos: ${t.followupCount||0}</div><div class="vz2-trackRule">Ultima regla: ${esc(t.lastRuleLabel||"-")}</div><div class="vz2-trackMeta">Ultimo seguimiento: ${esc(t.lastFollowupLabel||"-")}</div><div class="vz2-trackMeta">Ultimo mensaje: ${esc((t.lastIncomingText||"").slice(0,160))}</div>`;threadsBox.append(item);});
      const followupsBox=Q("[data-followups]",wrap);followupsBox.innerHTML="";
      if(!followups.length){followupsBox.innerHTML=`<div class="vz2-trackEmpty">Aun no creas seguimientos.</div>`;}
      else followups.forEach((f,idx)=>{
        const row=document.createElement("div");row.className="vz2-trackItem";
        row.innerHTML=`<div class="vz2-trackHead"><div class="vz2-trackTid">${esc(f.name||`Seguimiento ${idx+1}`)}</div><label class="vz2-trackMeta"><input type="checkbox" data-enabled ${f.enabled?"checked":""}> Activo</label></div><div class="vz2-row"><input class="vz2-trackInput" data-name value="${esc(f.name||"")}" placeholder="Nombre" style="width:150px"><input class="vz2-trackInput" data-min type="number" min="1" value="${Number(f.delayMin||5)}" style="width:90px"><input class="vz2-trackInput" data-text value="${esc(f.text||"")}" placeholder="Mensaje" style="flex:1"><button class="vz2-iconBtn" data-save title="Guardar">save</button><button class="vz2-iconBtn warn" data-del title="Eliminar">del</button></div>`;
        Q("[data-save]",row).onclick=async()=>{const next=[...followups];next[idx]={...next[idx],enabled:!!Q("[data-enabled]",row).checked,name:String(Q("[data-name]",row).value||"").trim(),delayMin:Number(Q("[data-min]",row).value||5),text:String(Q("[data-text]",row).value||"")};await saveFollowups(next);await render();};
        Q("[data-del]",row).onclick=async()=>{const next=followups.filter((_,i)=>i!==idx);await saveFollowups(next);await render();};
        followupsBox.append(row);
      });
    };

    Q("[data-open-add-followup]",wrap).onclick=async()=>{
      const modal=document.createElement("div");modal.className="vz2-modal";
      modal.innerHTML=`<div class="vz2-panel" style="max-width:520px"><div class="vz2-phd"><div class="vz2-title"><span class="vz2-titleIcon">+</span>Nuevo seguimiento</div><div class="vz2-sp"></div><button class="vz2-btn" data-close-add>Cerrar</button></div><div class="vz2-pbd"><div class="vz2-field"><div class="vz2-label">Nombre</div><input class="vz2-input" data-add-name placeholder="Seguimiento 1"></div><div class="vz2-field"><div class="vz2-label">Tiempo de espera (minutos)</div><input class="vz2-input" data-add-min type="number" min="1" value="5"></div><div class="vz2-field"><div class="vz2-label">Mensaje</div><textarea class="vz2-ta" data-add-text placeholder="Mensaje automatico"></textarea></div><div class="vz2-actions"><button class="vz2-btn" data-cancel-add>Cancelar</button><button class="vz2-btn pr" data-save-add>Guardar</button></div></div></div>`;
      const closeAdd=()=>modal.remove();
      Q("[data-close-add]",modal).onclick=closeAdd;Q("[data-cancel-add]",modal).onclick=closeAdd;
      modal.addEventListener("click",(e)=>{if(e.target===modal)closeAdd();});
      Q("[data-save-add]",modal).onclick=async()=>{
        const data=await loadAnalytics();const curr=Array.isArray(data?.followups)?data.followups:[];
        const nameInput=String(Q("[data-add-name]",modal).value||"").trim();
        const name=nameInput||`Seguimiento ${curr.length+1}`;
        const delayMin=Math.max(1,Number(Q("[data-add-min]",modal).value||5));
        const text=String(Q("[data-add-text]",modal).value||"").trim();
        if(!text){alert("Escribe el mensaje de seguimiento.");return;}
        await saveFollowups([...curr,{id:`fu_${Date.now()}`,name,delayMin,text,enabled:true}]);
        closeAdd();await render();setTab("followups");
      };
      document.documentElement.append(modal);Q("[data-add-name]",modal)?.focus();
    };

    document.documentElement.append(wrap);setTab(activeTab);await render();
  }

  async function openRulesModal({ loadRules, saveRules }){ openRulesPanelV2({ loadRules, saveRules }); }
  window.VZUI = { injectTopBar, openRulesModal, openTrackingModal };
})();

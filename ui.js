// ui.js — Utilidades de UI para VZ-Bot
(() => {
  "use strict";

  const Q  = (sel, r=document) => r.querySelector(sel);

  function openModal({ title, initialValue, mono=false, onSave }) {
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
  }

  function injectTopBar({ getEnabled, setEnabled, onOpenRules }) {
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

    const btnRules = mkBtn("Editar reglas", "#7c3aed");
    btnRules.onclick = () => onOpenRules?.();

    bar.append(status, btnToggle, btnRules);
    wrap.append(bar);
    document.documentElement.append(wrap);
  }

  async function openRulesModal({ loadRules, saveRules }) {
    let raw = await loadRules();
    if (!raw) raw = "[]";
    openModal({
      title: "Editar reglas del chatbot (JSON: [{ pattern, flags?, reply }])",
      initialValue: raw,
      mono: true,
      onSave: async (val) => {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new Error("El JSON debe ser un array.");
        parsed.forEach(o => {
          if (typeof o.pattern !== "string" || typeof o.reply !== "string") {
            throw new Error("Cada regla requiere 'pattern' (string) y 'reply' (string).");
          }
        });
        await saveRules(JSON.stringify(parsed, null, 2));
      }
    });
  }

  window.VZUI = { injectTopBar, openModal, openRulesModal };
})();

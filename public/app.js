// app.js — Milton chat UI. Zero dependencies.
(function () {
  "use strict";
  const chat = document.getElementById("chat");
  const chipsEl = document.getElementById("chips");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");

  let sid = localStorage.getItem("milton_sid");
  if (!sid) { sid = "s-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("milton_sid", sid); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function md(s) {
    // tiny markdown: **bold**, `code`, line breaks
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .split("\n").map((l) => (l.trim() ? "<p>" + l + "</p>" : "")).join("");
  }
  function scroll() { chat.scrollTop = chat.scrollHeight; }

  function stagePill(stage) {
    const cls = stage === "closed_won" ? "pill won" : stage === "closed_lost" ? "pill lost" : "pill";
    const label = stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `<span class="${cls}">${esc(label)}</span>`;
  }
  function money(n) {
    if (!n) return "—";
    const a = Math.abs(n);
    if (a >= 1e6) return "$" + (Math.round(n / 1e5) / 10) + "M";
    if (a >= 1e3) return "$" + (Math.round(n / 100) / 10) + "k";
    return "$" + n;
  }

  function cardHTML(card) {
    let h = `<div class="card">`;
    if (card.title) h += `<h4>${esc(card.title)}</h4>`;
    switch (card.kind) {
      case "pipeline":
        h += (card.rows || []).map((r) =>
          `<div class="row"><span>${stagePill(r.stage)} ${esc(r.label)}</span><span class="v">${r.count} · ${money(r.value)}</span></div>`).join("");
        break;
      case "deals":
        h += (card.items || []).map((d) =>
          `<div class="row"><span><b>${esc(d.title)}</b>${d.company_name ? ` <span style="color:var(--muted)">· ${esc(d.company_name)}</span>` : ""}<br><small style="color:var(--muted)">${esc(d.sub || "")}</small></span><span class="v">${stagePill(d.stage)}<br>${money(d.value)}</span></div>`).join("");
        break;
      case "kpis":
        h += `<div class="kv">` + (card.stats || []).map((s) =>
          `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("") + `</div>`;
        break;
      case "tasks":
        h += (card.items || []).map((t) =>
          `<div class="row"><span>${t.done ? "✅" : "⬜"} ${esc(t.title)}</span><span class="v">${esc(t.due_date || "no due date")}</span></div>`).join("");
        break;
      case "contacts":
        h += (card.items || []).map((c) =>
          `<div class="row"><span><b>${esc(c.name)}</b>${c.company_name ? ` · ${esc(c.company_name)}` : ""}<br><small style="color:var(--muted)">${esc(c.email || "")}${c.phone ? " · " + esc(c.phone) : ""}</small></span></div>`).join("");
        break;
      case "companies":
        h += (card.items || []).map((c) =>
          `<div class="row"><span><b>${esc(c.name)}</b>${c.industry ? ` · ${esc(c.industry)}` : ""}</span><span class="v">${esc(c.sub || "")}</span></div>`).join("");
        break;
      case "activities":
      case "webhooks":
        h += (card.items || []).map((a) =>
          `<div class="row"><span>${esc(a.text || a.name || "")}<br><small style="color:var(--muted)">${esc(a.sub || a.kind || "")} ${esc(a.created_at || "")}</small></span></div>`).join("");
        break;
      case "choices":
        h += (card.options || []).map((o) =>
          `<button class="opt" data-pick="${o.n}"><span class="n">${o.n}</span>${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</button>`).join("");
        break;
      case "confirm":
        h += (card.options || []).map((o) =>
          `<button class="opt" data-confirm="${esc(o.label)}"><span class="n">${o.n}</span>${esc(o.label)}</button>`).join("");
        break;
      case "findings":
        h += (card.items || []).map((f) => `<div class="finding">${esc(f.icon || "•")} ${esc(f.text)}</div>`).join("");
        break;
    }
    return h + `</div>`;
  }

  function addMsg(role, reply) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML = md(reply.text || "");
    (reply.cards || []).forEach((c) => { div.insertAdjacentHTML("beforeend", cardHTML(c)); });
    chat.appendChild(div);
    scroll();
    return div;
  }

  function setChips(chips) {
    chipsEl.innerHTML = "";
    (chips || []).forEach((c) => {
      const b = document.createElement("button");
      b.className = "chip"; b.type = "button"; b.textContent = c;
      b.addEventListener("click", () => send(c));
      chipsEl.appendChild(b);
    });
  }

  chat.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) { send(pick.getAttribute("data-pick")); return; }
    const conf = e.target.closest("[data-confirm]");
    if (conf) {
      const label = conf.getAttribute("data-confirm") || "";
      send(/cancel/i.test(label) ? "No" : "Yes");
    }
  });

  async function send(text) {
    text = (text || "").trim();
    if (!text) return;
    input.value = "";
    addMsg("user", { text });
    setChips([]);
    const typing = document.createElement("div");
    typing.className = "msg milton typing"; typing.textContent = "Milton is thinking…";
    chat.appendChild(typing); scroll();
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sid, message: text }),
      });
      const reply = await res.json();
      typing.remove();
      if (reply.error) addMsg("milton", { text: "Hmm, that didn't go through: " + reply.error });
      else { addMsg("milton", reply); setChips(reply.chips); }
    } catch (err) {
      typing.remove();
      addMsg("milton", { text: "I couldn't reach the Milton server. Is it running?" });
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  document.getElementById("help-btn").addEventListener("click", () => send("help"));

  // status + history restore
  (async function init() {
    try {
      const h = await fetch("/api/health").then((r) => r.json());
      if (h.crm) { statusDot.className = "dot ok"; statusText.textContent = "connected to exec-crm" + (h.llm ? " · AI on" : ""); }
      else { statusDot.className = "dot bad"; statusText.textContent = "exec-crm unreachable"; }
    } catch { statusDot.className = "dot bad"; statusText.textContent = "offline"; }
    try {
      const hist = await fetch("/api/history?session=" + encodeURIComponent(sid)).then((r) => r.json());
      (hist.messages || []).forEach((m) => addMsg(m.role === "user" ? "user" : "milton", { text: m.text }));
    } catch { /* fresh start */ }
    if (!chat.children.length) {
      addMsg("milton", { text: "Hey, I'm **Milton** — your copilot inside exec-crm. Ask for a **morning brief**, check the **pipeline**, or tell me to move a deal. What are we working on?" });
      setChips(["Morning brief", "Show pipeline", "My tasks", "Help"]);
    }
    input.focus();
  })();
})();

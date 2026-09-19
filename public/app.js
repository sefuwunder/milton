// app.js — Milton chat UI. Zero dependencies.
(function () {
  "use strict";
  const chat = document.getElementById("chat");
  const chipsEl = document.getElementById("chips");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const camBtn = document.getElementById("cam-btn");
  const photoInput = document.getElementById("photo-input");
  const tray = document.getElementById("tray");
  const bellBtn = document.getElementById("bell-btn");
  const bellBadge = document.getElementById("bell-badge");
  const autoBtn = document.getElementById("auto-btn");
  const autoView = document.getElementById("auto-view");
  const autoTabs = document.getElementById("auto-tabs");
  const autoBody = document.getElementById("auto-body");
  const toastEl = document.getElementById("toast");
  const wsSelect = document.getElementById("ws-select");
  let wsList = []; // cached exec-crm workspaces: {id, name, color}

  // photos uploaded and waiting to be sent with the next message
  const pending = []; // { id, url, objUrl }

  const fileUrl = (card) => card.imageUrl ? card.imageUrl + "?session=" + encodeURIComponent(sid) : "";

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
      case "transcription": {
        const pct = Math.round((card.confidence || 0) * 100);
        const script = card.script === "handwriting" ? "Handwriting" : card.script === "mixed" ? "Mixed print + handwriting" : "Printed text";
        if (card.imageUrl) h += `<img class="shot" src="${esc(fileUrl(card))}" alt="Uploaded photo">`;
        h += `<div class="ocr-head"><span class="conf">${pct}% confidence</span><span class="script">${esc(script)}</span></div>`;
        h += `<div class="confbar"><div style="width:${pct}%"></div></div>`;
        h += `<pre class="ocr-text">${esc(card.ocrText || "")}</pre>`;
        break;
      }
      case "handwriting": {
        const m = card.metrics || {};
        if (card.imageUrl) h += `<img class="shot" src="${esc(fileUrl(card))}" alt="Uploaded photo">`;
        const rows = [
          ["Slant", (m.slantDeg ?? 0) + "°"],
          ["Stroke width", (m.strokeMedian ?? 0) + " px (σ " + (m.strokeStd ?? 0) + ")"],
          ["Letter height", (m.heightMean ?? 0) + " px (σ " + (m.heightStd ?? 0) + ")"],
          ["Spacing ratio", (m.spacingRatio ?? 0) + "×"],
          ["Baseline drift", (m.baselineDrift ?? 0) + "°"],
          ["Ink density", ((m.inkDensity ?? 0) * 100).toFixed(1) + "%"],
          ["Measured", `${m.chars ?? 0} chars · ${m.words ?? 0} words · ${m.lines ?? 0} lines`],
        ];
        h += `<div class="metrics">` + rows.map((r) =>
          `<div class="mrow"><span>${esc(r[0])}</span><b>${esc(String(r[1]))}</b></div>`).join("") + `</div>`;
        h += `<ul class="notes">` + (card.notes || []).map((n) => `<li>${esc(n)}</li>`).join("") + `</ul>`;
        break;
      }
    }
    return h + `</div>`;
  }

  function addMsg(role, reply) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    (reply.photos || []).forEach((p) => { div.insertAdjacentHTML("beforeend", `<img class="thumb" src="${esc(p)}" alt="Uploaded photo">`); });
    div.innerHTML += md(reply.text || "");
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

  // ---- camera uploads ------------------------------------------------------------
  function renderTray() {
    tray.hidden = !tray.querySelector(".tray-item");
  }

  function addTrayItem(file) {
    const item = document.createElement("div");
    item.className = "tray-item";
    const objUrl = URL.createObjectURL(file);
    item.innerHTML =
      `<img src="${esc(objUrl)}" alt="Photo to send">` +
      `<div class="prog"><div class="bar"></div></div>` +
      `<button type="button" class="rm" aria-label="Remove photo">×</button>`;
    const bar = item.querySelector(".bar");
    const rm = item.querySelector(".rm");
    const entry = { id: null, url: null, objUrl, item };
    rm.addEventListener("click", () => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      URL.revokeObjectURL(objUrl);
      item.remove();
      renderTray();
    });
    tray.appendChild(item);
    renderTray();
    uploadPhoto(file,
      (frac) => { bar.style.width = Math.round(frac * 100) + "%"; },
    ).then(({ id, url }) => {
      entry.id = id; entry.url = url;
      pending.push(entry);
      item.classList.add("done");
      bar.parentElement.hidden = true;
    }).catch((err) => {
      item.classList.add("failed");
      bar.parentElement.hidden = true;
      const e = document.createElement("span");
      e.className = "err"; e.textContent = err.message || "Upload failed";
      item.appendChild(e);
    });
  }

  function uploadPhoto(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload?session=" + encodeURIComponent(sid));
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error("Bad server response")); }
        } else {
          let msg = "Upload failed";
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
          reject(new Error(msg));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
      const fd = new FormData();
      fd.append("photo", file, file.name || "photo.jpg");
      xhr.send(fd);
    });
  }

  camBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", () => {
    Array.from(photoInput.files || []).slice(0, 4).forEach((f) => {
      if (f.size > 10 * 1024 * 1024) {
        addMsg("milton", { text: `"${f.name}" is over the 10 MB limit — pick a smaller photo.` });
        return;
      }
      addTrayItem(f);
    });
    photoInput.value = "";
  });

  function clearTray() {
    pending.length = 0;
    tray.querySelectorAll(".tray-item").forEach((el) => {
      const img = el.querySelector("img");
      if (img && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
      el.remove();
    });
    renderTray();
  }

  // ---- automations view ------------------------------------------------------------
  let autoTab = "routines";
  const statusIcon = (st) => st === "ok" ? "✅" : st === "partial" ? "⚠️" : st === "skipped" ? "⏭️" : "❌";

  function routineRow(r) {
    return `<div class="arow"><span><b>${esc(r.name)}</b><br><small style="color:var(--muted)">${r.steps.length} step${r.steps.length === 1 ? "" : "s"}: ${esc(r.steps.join("; ").slice(0, 80))}</small></span>` +
      `<span class="ops"><button class="mini" data-arun="${esc(r.name)}">Run</button>` +
      `<button class="mini danger" data-ardel="${esc(r.name)}">Delete</button></span></div>`;
  }
  function scheduleRow(s) {
    const next = new Date(s.next_run).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<div class="arow"><span><b>#${s.id} ${esc(s.routine_name)}</b><br><small style="color:var(--muted)">${esc(s.spec_text)}${wsTag(s.workspace_id)} · next ${esc(next)}${s.active ? "" : " · paused"}</small></span>` +
      `<span class="ops"><button class="mini" data-spause="${s.id}" data-active="${s.active ? 0 : 1}">${s.active ? "Pause" : "Resume"}</button>` +
      `<button class="mini danger" data-sdel="${s.id}">Delete</button></span></div>`;
  }
  function triggerRow(t) {
    const f = Object.entries(t.filter || {}).map(([k, v]) => `${k}=${v}`).join(", ");
    return `<div class="arow"><span><b>#${t.id} ${esc(t.event)}</b>${f ? ` <small>(${esc(f)})</small>` : ""}<br><small style="color:var(--muted)">→ ${esc(t.routine_name)}${wsTag(t.workspace_id)}</small></span>` +
      `<span class="ops"><button class="mini danger" data-tdel="${t.id}">Delete</button></span></div>`;
  }
  function runRow(r) {
    const when = new Date((r.ran_at || "").replace(" ", "T") + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<div class="arow"><span>${statusIcon(r.status)} <b>${esc(r.routine_name)}</b> <small style="color:var(--muted)">[${esc(r.kind)}]</small><br><small style="color:var(--muted)">${esc(r.summary || "")} · ${esc(when)}</small></span></div>`;
  }

  async function refreshAutoTab() {
    autoTabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === autoTab));
    autoBody.innerHTML = `<div class="aloading">Loading…</div>`;
    try {
      if (autoTab === "routines") {
        const j = await fetch("/api/routines").then((r) => r.json());
        autoBody.innerHTML = (j.routines || []).length
          ? (j.routines || []).map(routineRow).join("")
          : `<div class="ahint">No routines yet. In chat: <code>save routine EOD: my tasks; pipeline hygiene</code></div>`;
      } else if (autoTab === "schedules") {
        const j = await fetch("/api/schedules").then((r) => r.json());
        autoBody.innerHTML = (j.schedules || []).length
          ? (j.schedules || []).map(scheduleRow).join("")
          : `<div class="ahint">No schedules yet. In chat: <code>schedule EOD daily at 6pm</code></div>`;
      } else if (autoTab === "triggers") {
        const j = await fetch("/api/triggers").then((r) => r.json());
        autoBody.innerHTML = `<div class="ahint">Point an exec-crm outgoing webhook at <code>POST /api/hooks/exec-crm</code> with header <code>X-Milton-Secret</code>. In chat: <code>when deal won run celebrate</code></div>` +
          ((j.triggers || []).map(triggerRow).join("") || `<div class="ahint">No triggers yet.</div>`);
      } else {
        const j = await fetch("/api/automation-runs?limit=50").then((r) => r.json());
        autoBody.innerHTML = (j.runs || []).length
          ? (j.runs || []).map(runRow).join("")
          : `<div class="ahint">No automation runs yet.</div>`;
      }
    } catch { autoBody.innerHTML = `<div class="ahint">Couldn't load.</div>`; }
  }

  function showAuto(tab) {
    autoTab = tab || autoTab;
    chat.hidden = true;
    chipsEl.hidden = true;
    autoView.hidden = false;
    refreshAutoTab();
  }
  function hideAuto() {
    autoView.hidden = true;
    chat.hidden = false;
    chipsEl.hidden = false;
    scroll();
  }

  autoBtn.addEventListener("click", () => (autoView.hidden ? showAuto() : hideAuto()));
  autoTabs.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) showAuto(t.getAttribute("data-tab"));
  });
  autoBody.addEventListener("click", async (e) => {
    const run = e.target.closest("[data-arun]");
    if (run) { hideAuto(); send("run " + run.getAttribute("data-arun")); return; }
    const ardel = e.target.closest("[data-ardel]");
    if (ardel && confirm(`Delete routine "${ardel.getAttribute("data-ardel")}"?`)) {
      await fetch("/api/routines/" + encodeURIComponent(ardel.getAttribute("data-ardel")), { method: "DELETE" });
      refreshAutoTab(); return;
    }
    const pause = e.target.closest("[data-spause]");
    if (pause) {
      await fetch("/api/schedules/" + pause.getAttribute("data-spause"), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: pause.getAttribute("data-active") === "1" }),
      });
      refreshAutoTab(); return;
    }
    const sdel = e.target.closest("[data-sdel]");
    if (sdel && confirm("Delete this schedule?")) {
      await fetch("/api/schedules/" + sdel.getAttribute("data-sdel"), { method: "DELETE" });
      refreshAutoTab(); return;
    }
    const tdel = e.target.closest("[data-tdel]");
    if (tdel && confirm("Delete this trigger?")) {
      await fetch("/api/triggers/" + tdel.getAttribute("data-tdel"), { method: "DELETE" });
      refreshAutoTab(); return;
    }
  });

  // ---- automation runs: badge, toast, SSE ----------------------------------------
  function updateBadge(runs) {
    const seen = Number(localStorage.getItem("milton_runs_seen") || 0);
    const unread = (runs || []).filter((r) => r.id > seen).length;
    if (unread > 0) { bellBadge.hidden = false; bellBadge.textContent = unread > 9 ? "9+" : String(unread); }
    else bellBadge.hidden = true;
    return unread;
  }
  function refreshBadge() {
    fetch("/api/automation-runs?limit=50").then((r) => r.json())
      .then((j) => updateBadge(j.runs || []))
      .catch(() => {});
  }
  function markRunsSeen() {
    fetch("/api/automation-runs?limit=1").then((r) => r.json()).then((j) => {
      const max = Math.max(0, ...((j.runs || []).map((r) => r.id)));
      localStorage.setItem("milton_runs_seen", String(max));
      bellBadge.hidden = true;
    }).catch(() => {});
  }
  bellBtn.addEventListener("click", () => { showAuto("runs"); markRunsSeen(); });

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
  }

  if (typeof EventSource !== "undefined") {
    const es = new EventSource("/api/events");
    es.addEventListener("automation-run", (ev) => {
      try {
        const run = JSON.parse(ev.data);
        toast(`⚡ ${run.routine_name} (${run.kind}): ${run.summary}`);
        refreshBadge();
        if (!autoView.hidden && autoTab === "runs") refreshAutoTab();
      } catch { /* ignore malformed */ }
    });
  }

  async function send(text) {
    text = (text || "").trim();
    const atts = pending.filter((p) => p.id);
    if (!text && !atts.length) return;
    input.value = "";
    const photos = atts.map((a) => a.url + "?session=" + encodeURIComponent(sid));
    addMsg("user", { text, photos });
    setChips([]);
    // keep the tray until the send succeeds so a failed send doesn't lose uploads
    const typing = document.createElement("div");
    typing.className = "msg milton typing";
    typing.textContent = atts.length ? "Milton is reading your photo…" : "Milton is thinking…";
    chat.appendChild(typing); scroll();
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sid, message: text, attachments: atts.map((a) => a.id) }),
      });
      const reply = await res.json();
      typing.remove();
      if (reply.error) addMsg("milton", { text: "Hmm, that didn't go through: " + reply.error });
      else { addMsg("milton", reply); setChips(reply.chips); clearTray(); syncWsSelect(reply); }
    } catch (err) {
      typing.remove();
      addMsg("milton", { text: "I couldn't reach the Milton server. Is it running?" });
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  document.getElementById("help-btn").addEventListener("click", () => send("help"));

  // ---- exec-crm workspaces -------------------------------------------------------
  function wsOptionsHtml(list, currentId) {
    return list.map((w) => `<option value="${w.id}"${w.id === currentId ? " selected" : ""}>${esc(w.name)}</option>`).join("");
  }
  function wsTag(id) {
    if (id == null) return "";
    const w = wsList.find((x) => x.id === id);
    return " · " + esc(w ? w.name : "#" + id);
  }
  function syncWsSelect(reply) {
    if (reply && reply.workspace_id !== undefined && !wsSelect.hidden) {
      wsSelect.value = reply.workspace_id == null ? "" : String(reply.workspace_id);
    }
  }
  async function loadWorkspaces() {
    try {
      const j = await fetch("/api/workspaces").then((r) => r.json());
      wsList = j.workspaces || [];
      if (!wsList.length) { wsSelect.hidden = true; return; }
      let currentId = null;
      try {
        const cur = await fetch("/api/session/workspace?session=" + encodeURIComponent(sid)).then((r) => r.json());
        currentId = cur.workspace_id ?? null;
      } catch { /* stay on default */ }
      wsSelect.innerHTML = `<option value="">Default workspace</option>` + wsOptionsHtml(wsList, currentId);
      wsSelect.hidden = false;
    } catch { wsSelect.hidden = true; }
  }
  wsSelect.addEventListener("change", async () => {
    const id = wsSelect.value === "" ? null : Number(wsSelect.value);
    try {
      const j = await fetch("/api/session/workspace", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sid, workspace_id: id }),
      }).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      toast("Workspace: " + (j.workspace_name || "default"));
    } catch (err) {
      toast("Couldn't switch workspace.");
      loadWorkspaces();
    }
  });

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
      addMsg("milton", { text: "Hey, I'm **Milton** — your copilot inside exec-crm. Ask for a **morning brief**, check the **pipeline**, move a deal — or tap 📷 to snap a photo of text and I'll read it. What are we working on?" });
      setChips(["Morning brief", "Show pipeline", "My tasks", "Help"]);
    }
    refreshBadge();
    loadWorkspaces();
    input.focus();
  })();
})();

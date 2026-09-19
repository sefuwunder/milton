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
      else { addMsg("milton", reply); setChips(reply.chips); clearTray(); }
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
      addMsg("milton", { text: "Hey, I'm **Milton** — your copilot inside exec-crm. Ask for a **morning brief**, check the **pipeline**, move a deal — or tap 📷 to snap a photo of text and I'll read it. What are we working on?" });
      setChips(["Morning brief", "Show pipeline", "My tasks", "Help"]);
    }
    input.focus();
  })();
})();

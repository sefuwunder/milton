// ui.test.ts — DOM-stubbed smoke test for public/app.js (zero-dependency UI).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";

function mkEl(tag: string): any {
  return {
    tag, children: [] as any[], innerHTML: "", textContent: "", value: "", className: "",
    appendChild(c: any) { this.children.push(c); return c; },
    insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
    addEventListener(t, h) { (this._l ||= {})[t] = h; }, remove() {}, focus() {}, scrollTop: 0, scrollHeight: 100,
    closest() { return null; }, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    hidden: false, style: {},
  };
}

let T: any;
let els: Record<string, any>;

beforeAll(async () => {
  els = {};
  ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
   "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "auto-badge", "auto-btn",
   "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "palette",
   "avatar-btn", "session-overlay", "session-list", "session-create", "session-manage-link",
   "session-picker-close", "manage-overlay", "manage-list", "manage-close"].forEach((id) => (els[id] = mkEl("div")));
  (globalThis as any).document = {
    getElementById: (id: string) => els[id] || null,
    createElement: (t: string) => mkEl(t),
    addEventListener() {},
  };
  (globalThis as any).localStorage = { _s: {}, getItem(k: string) { return this._s[k] || null; }, setItem(k: string, v: string) { this._s[k] = v; } };
  // stub fetch for the DOM smoke test only — restored afterwards so later
  // test files (e.g. upload.test.ts) get the real fetch back
  const prevFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string) => {
    const ok = (d: any) => ({ json: async () => d });
    if (String(url).includes("/api/health")) return ok({ crm: true, llm: false });
    if (String(url).includes("/api/history")) return ok({ messages: [{ role: "milton", text: "**hi** there" }] });
    return ok({});
  };
  afterAll(() => { (globalThis as any).fetch = prevFetch; });
  let src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  src = src.replace("})();", ";globalThis.__t={cardHTML,md,money,esc,routineRow,scheduleRow,triggerRow,runRow,updateBadge,showAuto,hideAuto,addTrayItem,addMsg,switchSession,openPicker,closePicker};})();");
  eval(src);
  await new Promise((r) => setTimeout(r, 50));
  T = (globalThis as any).__t;
});

describe("init", () => {
  test("restores history and renders markdown", () => {
    const html = els["chat"].children.map((c: any) => c.innerHTML).join("\n");
    expect(html).toContain("hi");
    expect(html).toContain("<b>hi</b>");
  });
  test("status dot reflects CRM health", () => {
    expect(els["status-dot"].className).toContain("ok");
  });
});

describe("cards", () => {
  test("every card kind renders without throwing", () => {
    const cards = [
      { kind: "pipeline", title: "P", rows: [{ stage: "proposal", label: "Proposal", count: 2, value: 70000 }, { stage: "closed_won", label: "Won", count: 1, value: 20000 }] },
      { kind: "deals", items: [{ title: "Acme", company_name: "Acme", stage: "negotiation", value: 1500, sub: "x" }] },
      { kind: "kpis", stats: [{ label: "Win rate", value: "42%" }] },
      { kind: "tasks", items: [{ title: "Call", done: 0, due_date: "2026-09-19" }] },
      { kind: "contacts", items: [{ name: "Jane", email: "j@a.com" }] },
      { kind: "companies", items: [{ name: "Acme", sub: "2 open deals" }] },
      { kind: "activities", items: [{ text: "Deal updated", kind: "deal" }] },
      { kind: "choices", options: [{ n: 1, label: "One", sub: "sub" }] },
      { kind: "confirm", options: [{ n: 1, label: "Yes, delete" }] },
      { kind: "findings", items: [{ icon: "📅", text: "gap" }] },
      { kind: "suggestions", title: "Did you mean…", items: [{ name: "undo", description: "Undo the last change", usage: "undo" }, { name: "deal_journey", description: "Stage-history timeline for a deal", usage: "deal journey Acme" }] },
      { kind: "transcription", title: "Photo transcription", ocrText: "HELLO 123", confidence: 0.93, script: "print", imageUrl: "/api/file/abc" },
      { kind: "handwriting", title: "Handwriting analysis", metrics: { slantDeg: 8.5, strokeMedian: 4.2, strokeStd: 1.1, heightMean: 22.4, heightStd: 3.3, spacingRatio: 2.8, baselineDrift: -1.2, inkDensity: 0.14, chars: 42, words: 9, lines: 3 }, notes: ["Slant: leans right by 8.5°."], imageUrl: "/api/file/abc" },
    ];
    for (const c of cards) expect(() => T.cardHTML(c)).not.toThrow();
  });
  test("transcription card shows text, confidence and script", () => {
    const h = T.cardHTML({ kind: "transcription", ocrText: "HELLO", confidence: 0.93, script: "handwriting", imageUrl: "/api/file/abc" });
    expect(h).toContain("HELLO");
    expect(h).toContain("93%");
    expect(h).toContain("Handwriting");
    expect(h).toContain("/api/file/abc?session=");
  });
  test("transcription card escapes OCR text (XSS)", () => {
    const h = T.cardHTML({ kind: "transcription", ocrText: "<script>alert(1)</script>", confidence: 0.5, script: "print" });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
  test("handwriting card shows raw metrics and notes", () => {
    const h = T.cardHTML({ kind: "handwriting", metrics: { slantDeg: -6, strokeMedian: 3, strokeStd: 1, heightMean: 20, heightStd: 4, spacingRatio: 2.1, baselineDrift: 0.5, inkDensity: 0.12, chars: 10, words: 2, lines: 1 }, notes: ["Slant: leans left by 6.0°."] });
    expect(h).toContain("-6°");
    expect(h).toContain("Slant: leans left");
  });
  test("escapes HTML in entity names (XSS)", () => {
    const h = T.cardHTML({ kind: "deals", items: [{ title: "<img src=x onerror=y>", stage: "proposal", value: 1 }] });
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
  test("money formatting", () => {
    expect(T.money(2500000)).toBe("$2.5M");
    expect(T.money(50000)).toBe("$50k");
    expect(T.money(0)).toBe("—");
  });
});

describe("automations UI", () => {
  test("routine row renders name, steps, Run/Delete", () => {
    const h = T.routineRow({ name: "eod", steps: ["my tasks", "kpis"] });
    expect(h).toContain("eod");
    expect(h).toContain("my tasks; kpis");
    expect(h).toContain("data-arun");
    expect(h).toContain("data-ardel");
  });
  test("routine row escapes HTML (XSS)", () => {
    const h = T.routineRow({ name: "<img src=x>", steps: ["<script>"] });
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
  test("schedule row shows pause/resume by state", () => {
    const on = T.scheduleRow({ id: 3, routine_name: "eod", spec_text: "daily at 6:00 PM", next_run: Date.now() + 3600000, active: 1 });
    expect(on).toContain("#3");
    expect(on).toContain("Pause");
    const off = T.scheduleRow({ id: 3, routine_name: "eod", spec_text: "daily at 6:00 PM", next_run: Date.now() + 3600000, active: 0 });
    expect(off).toContain("Resume");
    expect(off).toContain("paused");
  });
  test("trigger row shows event, filter and routine", () => {
    const h = T.triggerRow({ id: 7, event: "deal.stage_changed", filter: { stage: "closed_won" }, routine_name: "celebrate" });
    expect(h).toContain("deal.stage_changed");
    expect(h).toContain("stage=closed_won");
    expect(h).toContain("celebrate");
  });
  test("run row shows status icon, kind and summary", () => {
    const h = T.runRow({ status: "partial", kind: "schedule", routine_name: "eod", summary: "1/2 steps ok", ran_at: "2026-09-19 12:00:00" });
    expect(h).toContain('class="st st-warn"');
    expect(h).toContain("<svg");
    expect(h).toContain("eod");
    expect(h).toContain("1/2 steps ok");
    expect(T.runRow({ status: "ok", kind: "trigger", routine_name: "x", summary: "", ran_at: "2026-09-19 12:00:00" })).toContain('class="st st-ok"');
  });
  test("updateBadge counts runs newer than last-seen", () => {
    (globalThis as any).localStorage.setItem("milton_runs_seen", "10");
    const n = T.updateBadge([{ id: 9 }, { id: 11 }, { id: 12 }]);
    expect(n).toBe(2);
    expect(els["auto-badge"].hidden).toBe(false);
    expect(els["auto-badge"].textContent).toBe("2");
    const n2 = T.updateBadge([{ id: 5 }]);
    expect(n2).toBe(0);
    expect(els["auto-badge"].hidden).toBe(true);
  });
  test("showAuto/hideAuto toggle the views", () => {
    T.showAuto("runs");
    expect(els["auto-view"].hidden).toBe(false);
    expect(els["chat"].hidden).toBe(true);
    T.hideAuto();
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
});

describe("vCard attachments", () => {
  beforeAll(() => {
    // addTrayItem fires uploadPhoto -> XMLHttpRequest; fake it so the tray
    // item HTML can be asserted without a network round-trip.
    (globalThis as any).XMLHttpRequest = class {
      upload = { addEventListener() {} };
      open() {}
      addEventListener() {}
      send() {}
    };
    const doc = (globalThis as any).document;
    const realCreate = doc.createElement;
    doc.createElement = (t: string) => {
      const el = realCreate(t);
      const q = el.querySelector;
      el.querySelector = (sel: string) =>
        sel === ".bar" ? { style: {}, parentElement: { hidden: false } } : sel === ".rm" ? { addEventListener() {} } : q(sel);
      return el;
    };
  });

  test("vcf file renders a file chip, not a broken image", () => {
    els["tray"].children.length = 0;
    T.addTrayItem({ name: "contacts.vcf", type: "text/vcard", size: 100 });
    const item = els["tray"].children[els["tray"].children.length - 1];
    expect(item.innerHTML).toContain("file-chip");
    expect(item.innerHTML).toContain("<svg");
    expect(item.innerHTML).toContain("contacts.vcf");
    expect(item.innerHTML).not.toContain("<img");
  });

  test("image file still renders an <img> thumbnail", () => {
    (globalThis as any).URL.createObjectURL = () => "blob:fake";
    els["tray"].children.length = 0;
    T.addTrayItem({ name: "photo.png", type: "image/png", size: 100 });
    const item = els["tray"].children[els["tray"].children.length - 1];
    expect(item.innerHTML).toContain("<img");
    expect(item.innerHTML).not.toContain("file-chip");
  });

  test("user message echoes vcf attachments as chips", () => {
    const div = T.addMsg("user", { text: "", photos: [], files: ["contacts.vcf"] });
    expect(div.innerHTML).toContain("file-chip");
    expect(div.innerHTML).toContain("<svg");
    expect(div.innerHTML).not.toContain("<img");
  });
});

describe("analyst replies", () => {
  const analysisReply = {
    text: "📊 **Pipeline analysis** — 3 open deals · $190k\n• **Negotiation** — 1 deal · $120k\n**Win rate:** 100%\n\n**Analyst read** _(from your analyst model)_:\n- Stub insight: negotiation holds most open value",
    chips: ["Forecast", "Plan my day"],
  };
  test("analysis brief renders markdown, analyst section, and chips", () => {
    const div = T.addMsg("milton", analysisReply);
    expect(div.className).toContain("milton");
    expect(div.innerHTML).toContain("Pipeline analysis");
    expect(div.innerHTML).toContain("<b>");
    expect(div.innerHTML).toContain("Analyst read");
    expect(div.innerHTML).toContain("Stub insight");
  });
  test("breakdown confirm card renders yes/no picks", () => {
    const html = T.cardHTML({ kind: "confirm", options: [{ n: 1, label: "Yes, create 3 tasks" }, { n: 2, label: "Cancel" }] });
    expect(html).toContain("Yes, create 3 tasks");
    expect(html).toContain("data-confirm");
  });
});

describe("vcf import button", () => {
  function fire(el: any, type: string, ev: any = {}) {
    const h = el._l && el._l[type];
    expect(typeof h).toBe("function");
    h(ev);
  }

  test("vcf button is wired next to the camera button", () => {
    expect(els["vcf-btn"]).toBeTruthy();
    expect(els["vcf-input"]).toBeTruthy();
    expect(typeof els["vcf-btn"]._l?.click).toBe("function");
    expect(typeof els["vcf-input"]._l?.change).toBe("function");
  });

  test("clicking the vcf button opens the vcf file picker", () => {
    let picked = false;
    els["vcf-input"].click = () => { picked = true; };
    fire(els["vcf-btn"], "click");
    expect(picked).toBe(true);
  });

  test("choosing a .vcf stages it as a contacts file chip", () => {
    (globalThis as any).XMLHttpRequest = class {
      upload = { addEventListener() {} };
      open() {}
      addEventListener() {}
      send() {}
    };
    els["tray"].children.length = 0;
    els["vcf-input"].files = [{ name: "team.vcf", type: "text/vcard", size: 512 }];
    fire(els["vcf-input"], "change");
    const item = els["tray"].children[els["tray"].children.length - 1];
    expect(item.innerHTML).toContain("file-chip");
    expect(item.innerHTML).toContain("<svg");
    expect(item.innerHTML).toContain("team.vcf");
    expect(els["vcf-input"].value).toBe("");
  });

  test("oversize .vcf is rejected with a contacts-file message", () => {
    const before = els["chat"].children.length;
    els["tray"].children.length = 0;
    els["vcf-input"].files = [{ name: "huge.vcf", type: "text/vcard", size: 11 * 1024 * 1024 }];
    fire(els["vcf-input"], "change");
    expect(els["tray"].children.length).toBe(0);
    const html = els["chat"].children.slice(before).map((c: any) => c.innerHTML).join("\n");
    expect(html).toContain("huge.vcf");
    expect(html).toContain("10 MB");
    expect(html).toContain("contacts file");
  });
});

describe("session picker", () => {
  const outerFetch = (globalThis as any).fetch;
  const SESSIONS = [
    { id: "s-a", name: "General", created_at: "", last_active_at: "", messageCount: 1, workspace: { id: null, name: "" } },
    { id: "s-b", name: "Pipeline", created_at: "", last_active_at: "", messageCount: 0, workspace: { id: 2, name: "Acme", } },
  ];
  beforeAll(() => {
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      const ok = (d: any) => ({ json: async () => d });
      const u = String(url);
      if (u.includes("/api/chat-sessions") && opts?.method === "POST") {
        const created = { id: "s-c", name: "Session 3", created_at: "", last_active_at: "", messageCount: 0, workspace: { id: 2, name: "Acme" } };
        SESSIONS.unshift(created);
        return ok({ session: created });
      }
      if (u.includes("/api/chat-sessions")) return ok({ sessions: SESSIONS });
      if (u.includes("/api/history")) {
        const sid = new URL(u, "http://x").searchParams.get("session");
        return ok({ messages: [{ role: "milton", text: `history for ${sid}` }] });
      }
      return ok({});
    };
  });
  afterAll(() => { (globalThis as any).fetch = outerFetch; });

  test("avatar click opens the picker listing sessions with their workspaces", async () => {
    // real markup starts the overlay hidden
    els["session-overlay"].hidden = true;
    els["manage-overlay"].hidden = true;
    els["avatar-btn"]._l.click();
    await new Promise((r) => setTimeout(r, 60));
    expect(els["session-overlay"].hidden).toBe(false);
    expect(els["session-list"].innerHTML).toContain("Pipeline");
    expect(els["session-list"].innerHTML).toContain("ws-badge");
    expect(els["session-list"].innerHTML).toContain("Acme");
    expect(els["session-list"].innerHTML).toContain("default");
    // active session is marked
    expect(els["session-list"].innerHTML).toContain("active");
    // picker has the New session button and the management link
    expect(typeof els["session-create"]._l.click).toBe("function");
    expect(typeof els["session-manage-link"]._l.click).toBe("function");
  });

  test("second avatar click closes the picker", async () => {
    els["avatar-btn"]._l.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(els["session-overlay"].hidden).toBe(true);
  });

  test("switchSession swaps sid and reloads history", async () => {
    T.switchSession("s-b");
    await new Promise((r) => setTimeout(r, 60));
    expect((globalThis as any).localStorage.getItem("milton_sid")).toBe("s-b");
    expect(els["session-overlay"].hidden).toBe(true);
    const html = els["chat"].children.map((c: any) => c.innerHTML).join("\n");
    expect(html).toContain("history for s-b");
  });

  test("New session button creates a bound session and switches to it", async () => {
    els["session-create"]._l.click();
    await new Promise((r) => setTimeout(r, 60));
    expect((globalThis as any).localStorage.getItem("milton_sid")).toBe("s-c");
  });

  test("Manage link opens the management modal with rename/delete rows", async () => {
    els["session-manage-link"]._l.click();
    await new Promise((r) => setTimeout(r, 60));
    expect(els["manage-overlay"].hidden).toBe(false);
    expect(els["session-overlay"].hidden).toBe(true);
    expect(els["manage-list"].innerHTML).toContain("Pipeline");
    expect(els["manage-list"].innerHTML).toContain("Rename");
    expect(els["manage-list"].innerHTML).toContain("Delete");
  });

  test("single automations button: no bell button in the header", () => {
    expect(document.getElementById("bell-btn")).toBeNull();
    expect(typeof els["auto-btn"]._l.click).toBe("function");
    expect(els["auto-badge"]).toBeTruthy();
  });
});

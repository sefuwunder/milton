// ui.test.ts — DOM-stubbed smoke test for public/app.js (zero-dependency UI).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";

function mkEl(tag: string): any {
  return {
    tag, children: [] as any[], innerHTML: "", textContent: "", value: "", className: "",
    appendChild(c: any) { this.children.push(c); return c; },
    insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
    addEventListener() {}, remove() {}, focus() {}, scrollTop: 0, scrollHeight: 100,
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
   "cam-btn", "photo-input", "tray", "bell-btn", "bell-badge", "auto-btn",
   "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "ws-select"].forEach((id) => (els[id] = mkEl("div")));
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
  src = src.replace("})();", ";globalThis.__t={cardHTML,md,money,esc,routineRow,scheduleRow,triggerRow,runRow,updateBadge,showAuto,hideAuto};})();");
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
    expect(h).toContain("⚠️");
    expect(h).toContain("eod");
    expect(h).toContain("1/2 steps ok");
    expect(T.runRow({ status: "ok", kind: "trigger", routine_name: "x", summary: "", ran_at: "2026-09-19 12:00:00" })).toContain("✅");
  });
  test("updateBadge counts runs newer than last-seen", () => {
    (globalThis as any).localStorage.setItem("milton_runs_seen", "10");
    const n = T.updateBadge([{ id: 9 }, { id: 11 }, { id: 12 }]);
    expect(n).toBe(2);
    expect(els["bell-badge"].hidden).toBe(false);
    expect(els["bell-badge"].textContent).toBe("2");
    const n2 = T.updateBadge([{ id: 5 }]);
    expect(n2).toBe(0);
    expect(els["bell-badge"].hidden).toBe(true);
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

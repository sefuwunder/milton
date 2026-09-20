// auto-panel.test.ts — DOM-stubbed checks for the automations panel dismiss behavior.
// The panel is a docked view (#auto-view) that replaces the chat; it must be
// dismissible (close button, Esc, sending a message) and must never open unprompted.
//
// BUN QUIRKS (2026-09-19, verified by experiment):
// 1. An afterAll registered INSIDE beforeAll fires immediately after beforeAll
//    completes. Hooks must be registered at describe/module top level.
// 2. Bun resets its well-known web-API globals (fetch, localStorage) on
//    globalThis between beforeAll and the first beforeEach — a stub assigned in
//    beforeAll is silently replaced by the native by the time tests run, while
//    custom-named globals pass through untouched. So stubs are smuggled in via
//    custom __stub* globals and shadowed as IIFE-local vars inside the eval'd
//    bundle, which is immune to the reset.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";

function mkEl(tag: string): any {
  const listeners: Record<string, Function[]> = {};
  return {
    tag, children: [] as any[], innerHTML: "", textContent: "", value: "", className: "",
    appendChild(c: any) { this.children.push(c); return c; },
    insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
    addEventListener(t: string, fn: Function) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t: string, ev: any = {}) { (listeners[t] || []).forEach((fn) => fn(ev)); },
    remove() {}, focus() {}, scrollTop: 0, scrollHeight: 100,
    closest() { return null; }, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    hidden: false, style: {},
  };
}

let T: any;
let els: Record<string, any>;
let docListeners: Record<string, Function[]>;
let esListeners: Record<string, Function[]>;
let lsStore: Record<string, string>;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
  delete (globalThis as any).__stubFetch;
  delete (globalThis as any).__stubLS;
  delete (globalThis as any).__stubES;
  delete (globalThis as any).__stubDoc;
});

beforeAll(async () => {
  els = {};
  ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
   "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "bell-btn", "bell-badge", "auto-btn",
   "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "ws-select", "palette"].forEach((id) => (els[id] = mkEl("div")));
  // mirror the HTML: panel starts hidden, chat starts visible
  els["auto-view"].hidden = true;
  els["chat"].hidden = false;
  docListeners = {};
  (globalThis as any).__stubDoc = {
    getElementById: (id: string) => els[id] || null,
    createElement: (t: string) => mkEl(t),
    addEventListener(t: string, fn: Function) { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  lsStore = {};
  (globalThis as any).__stubLS = {
    getItem(k: string) { return k in lsStore ? lsStore[k] : null; },
    setItem(k: string, v: string) { lsStore[k] = String(v); },
    removeItem(k: string) { delete lsStore[k]; },
  };
  esListeners = {};
  (globalThis as any).__stubES = class {
    addEventListener(t: string, fn: Function) { (esListeners[t] = esListeners[t] || []).push(fn); }
    close() {}
  };
  (globalThis as any).__stubFetch = async (url: string) => {
    const ok = (d: any) => ({ json: async () => d });
    const u = String(url);
    if (u.includes("/api/health")) return ok({ crm: true, llm: false });
    if (u.includes("/api/history")) return ok({ messages: [] });
    if (u.includes("/api/routines")) return ok({ routines: [] });
    if (u.includes("/api/automation-runs")) return ok({ runs: [{ id: 7, routine_name: "EOD", kind: "routine", status: "ok", summary: "2 steps ok", ran_at: "2026-09-19 08:00:00" }] });
    if (u.includes("/api/chat")) return ok({ text: "done" });
    return ok({});
  };
  let src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  src = src.replace(
    '"use strict";',
    '"use strict";\nvar fetch=globalThis.__stubFetch,localStorage=globalThis.__stubLS,EventSource=globalThis.__stubES,document=globalThis.__stubDoc;'
  );
  src = src.replace("})();", ";globalThis.__t={showAuto,hideAuto,updateBadge};})();");
  eval(src);
  await tick(50);
  T = (globalThis as any).__t;
});

beforeEach(() => {
  // reset: panel closed, chat visible, no seen-runs marker
  T.hideAuto();
  Object.keys(lsStore).forEach((k) => delete lsStore[k]);
  els["toast"].hidden = true;
  els["bell-badge"].hidden = true;
});

function openPanel() { els["auto-btn"].fire("click"); }
function sseRun(run: any) {
  (esListeners["automation-run"] || []).forEach((fn) => fn({ data: JSON.stringify(run) }));
}

describe("automations panel dismiss behavior", () => {
  test("panel starts hidden and chat is visible", () => {
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
  test("⚙️ opens the panel and hides the chat", async () => {
    openPanel();
    await tick();
    expect(els["auto-view"].hidden).toBe(false);
    expect(els["chat"].hidden).toBe(true);
  });
  test("⚙️ toggles the panel closed again", async () => {
    openPanel(); await tick();
    els["auto-btn"].fire("click");
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
  test("× close button dismisses the panel and restores chat", async () => {
    openPanel(); await tick();
    els["auto-close"].fire("click");
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
  test("Esc dismisses the panel", async () => {
    openPanel(); await tick();
    (docListeners["keydown"] || []).forEach((fn) => fn({ key: "Escape" }));
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
  test("Esc with the panel closed is a no-op", () => {
    expect(() => (docListeners["keydown"] || []).forEach((fn) => fn({ key: "Escape" }))).not.toThrow();
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
  });
  test("non-Escape keys do not dismiss the panel", async () => {
    openPanel(); await tick();
    (docListeners["keydown"] || []).forEach((fn) => fn({ key: "Enter" }));
    expect(els["auto-view"].hidden).toBe(false);
  });
  test("sending a message dismisses the panel and the message lands in chat", async () => {
    openPanel(); await tick();
    const before = els["chat"].children.length;
    els["input"].value = "morning brief";
    els["composer"].fire("submit", { preventDefault() {} });
    await tick(50);
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["chat"].hidden).toBe(false);
    expect(els["chat"].children.length).toBeGreaterThan(before + 1); // user msg + reply
  });
  test("SSE automation-run toast does not open the panel", async () => {
    sseRun({ id: 9, routine_name: "EOD", kind: "routine", summary: "done" });
    await tick(50);
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["toast"].hidden).toBe(false);
    expect(els["toast"].textContent).toContain("EOD");
  });
  test("SSE run refreshes the bell badge without opening the panel", async () => {
    sseRun({ id: 9, routine_name: "EOD", kind: "routine", summary: "done" });
    await tick(50);
    expect(els["auto-view"].hidden).toBe(true);
    expect(els["bell-badge"].hidden).toBe(false);
    expect(els["bell-badge"].textContent).toBe("1");
  });
  test("updateBadge hides the bell when everything was seen", () => {
    lsStore["milton_runs_seen"] = "7";
    T.updateBadge([{ id: 7, routine_name: "EOD", kind: "routine", status: "ok", summary: "2 steps ok" }]);
    expect(els["bell-badge"].hidden).toBe(true);
  });
  test("panel open on the runs tab stays open through an SSE event", async () => {
    els["bell-btn"].fire("click");
    await tick(50);
    expect(els["auto-view"].hidden).toBe(false);
    sseRun({ id: 9, routine_name: "EOD", kind: "routine", summary: "done" });
    await tick(50);
    expect(els["auto-view"].hidden).toBe(false); // refreshed, not closed
    els["auto-close"].fire("click");
    expect(els["auto-view"].hidden).toBe(true);
  });
  test("chat stays interactive after dismiss (input focusable, composer works)", async () => {
    openPanel(); await tick();
    els["auto-close"].fire("click");
    expect(els["chat"].hidden).toBe(false);
    expect(typeof els["input"].focus).toBe("function");
    const before = els["chat"].children.length;
    els["input"].value = "kpis";
    els["composer"].fire("submit", { preventDefault() {} });
    await tick(50);
    expect(els["chat"].children.length).toBeGreaterThan(before);
  });
});

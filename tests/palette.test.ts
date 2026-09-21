// palette.test.ts — DOM-stubbed interaction tests for the slash-command
// palette in public/app.js: open, live filter, keyboard, click-to-insert.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
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

let els: Record<string, any>;
let commandCalls = 0;

const COMMANDS = [
  { name: "undo", description: "Undo the last change", usage: "undo", examples: [] },
  { name: "add_deal", description: "Create a deal", usage: "add deal Website redesign for Acme worth 50k", examples: [] },
  { name: "wizard_start", description: "Guided setup for a new record", usage: "new deal", examples: [] },
];

function fireInput(v: string) {
  els["input"].value = v;
  els["input"]._l["input"]();
  return new Promise((r) => setTimeout(r, 30)); // loadCommands is async
}
function fireKey(key: string) {
  els["input"]._l["keydown"]({ key, preventDefault() {} });
}

function installFetch() {
  (globalThis as any).fetch = async (url: string) => {
    const ok = (d: any) => ({ json: async () => d });
    if (String(url).includes("/api/health")) return ok({ crm: true, llm: false });
    if (String(url).includes("/api/history")) return ok({ messages: [] });
    if (String(url).includes("/api/commands")) { commandCalls++; return ok({ commands: COMMANDS }); }
    return ok({});
  };
}

beforeAll(async () => {
  els = {};
  ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
   "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "auto-badge", "auto-btn",
   "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "palette"].forEach((id) => (els[id] = mkEl("div")));
  (globalThis as any).document = {
    getElementById: (id: string) => els[id] || null,
    createElement: (t: string) => mkEl(t),
    addEventListener() {},
  };
  (globalThis as any).localStorage = { _s: {}, getItem(k: string) { return this._s[k] || null; }, setItem(k: string, v: string) { this._s[k] = v; } };
  installFetch(); // boot needs fetch too
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  eval(src);
  await new Promise((r) => setTimeout(r, 50));
});

// reset-proof: bun resets well-known globals (fetch) between beforeAll and
// the first test, so reinstall the stub in a top-level beforeEach (theme.test.ts pattern)
const __prevFetch = (globalThis as any).fetch;
beforeEach(() => { installFetch(); });
afterAll(() => { (globalThis as any).fetch = __prevFetch; });

describe("slash-command palette", () => {
  test("typing / opens the palette with every command", async () => {
    await fireInput("/");
    expect(els["palette"].hidden).toBe(false);
    expect(els["palette"].innerHTML).toContain("pal-row");
    expect(els["palette"].innerHTML).toContain("add deal Website redesign");
    expect(els["palette"].innerHTML).toContain("new deal");
  });
  test("typing narrows the list live", async () => {
    await fireInput("/und");
    const html = els["palette"].innerHTML;
    expect(html).toContain("Undo the last change");
    expect(html).not.toContain("Create a deal");
  });
  test("no match closes the palette", async () => {
    await fireInput("/zzz-no-such-command");
    expect(els["palette"].hidden).toBe(true);
  });
  test("ArrowDown + Enter inserts the highlighted usage", async () => {
    await fireInput("/");
    fireKey("ArrowDown"); // highlight second row
    fireKey("Enter");
    expect(els["input"].value).toBe("add deal Website redesign for Acme worth 50k");
    expect(els["palette"].hidden).toBe(true);
  });
  test("plain Enter without arrow navigation does not insert", async () => {
    await fireInput("/und");
    const before = els["input"].value;
    fireKey("Enter");
    expect(els["input"].value).toBe(before); // still "/und" — send() would run instead
    expect(els["palette"].hidden).toBe(false);
  });
  test("Escape closes the palette", async () => {
    await fireInput("/");
    expect(els["palette"].hidden).toBe(false);
    fireKey("Escape");
    expect(els["palette"].hidden).toBe(true);
  });
  test("clicking a row inserts its usage", async () => {
    await fireInput("/");
    const btn = { getAttribute: () => "2" };
    els["palette"]._l["click"]({ target: { closest: (sel: string) => (sel === "[data-pal]" ? btn : null) } });
    expect(els["input"].value).toBe("new deal");
    expect(els["palette"].hidden).toBe(true);
  });
  test("clearing the slash hides the palette", async () => {
    await fireInput("/");
    expect(els["palette"].hidden).toBe(false);
    await fireInput("hello");
    expect(els["palette"].hidden).toBe(true);
  });
  test("commands are fetched once and cached", async () => {
    const n = commandCalls;
    await fireInput("/a");
    await fireInput("/ad");
    expect(commandCalls).toBe(n); // no refetch
  });
});

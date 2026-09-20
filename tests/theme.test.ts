// theme.test.ts — DOM-stubbed checks for the auto light/dark Tokyo theme in public/app.js.
// Follows the Bun quirks in ~/AGENTS.md: stubs ride in on custom __stub* globals and
// are (re)installed in beforeEach, because Bun resets well-known globals between
// beforeAll and the first beforeEach.
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";

// theme.test.ts installs a fetch stub in beforeEach and never leaks it: restore
// the previous fetch when done so later test files get the real fetch back.
const prevThemeFetch = (globalThis as any).fetch;
afterAll(() => { (globalThis as any).fetch = prevThemeFetch; });

function mkEl(tag: string): any {
  const attrs: Record<string, string> = {};
  return {
    tag, attrs, children: [] as any[], innerHTML: "", textContent: "", value: "",
    className: "", title: "", hidden: false, style: {}, scrollTop: 0, scrollHeight: 100,
    dataset: {} as Record<string, string>,
    listeners: {} as Record<string, Function[]>,
    appendChild(c: any) { this.children.push(c); return c; },
    insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
    addEventListener(t: string, cb: Function) { (this.listeners[t] = this.listeners[t] || []).push(cb); },
    remove() {}, focus() {},
    closest() { return null; }, getAttribute(k: string) { return attrs[k] ?? null; },
    setAttribute(k: string, v: string) { attrs[k] = String(v); },
    removeAttribute(k: string) { delete attrs[k]; },
    hasAttribute(k: string) { return k in attrs; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
  };
}

function mkStore(): any {
  return {
    _s: {} as Record<string, string>,
    getItem(k: string) { return k in this._s ? this._s[k] : null; },
    setItem(k: string, v: string) { this._s[k] = String(v); },
    removeItem(k: string) { delete this._s[k]; },
  };
}

let mm: any; // stubbed matchMedia controller
let els: Record<string, any>;
let rootEl: any;

function installStubs() {
  const store = mkStore();
  (globalThis as any).__stubLS = store;
  mm = { matches: false, listeners: [] as Function[] };
  (globalThis as any).__stubMM = {
    lastQuery: "",
    factory: (q: string) => {
      (globalThis as any).__stubMM.lastQuery = q;
      return {
        matches: mm.matches,
        addEventListener: (_t: string, cb: Function) => mm.listeners.push(cb),
        removeEventListener() {},
      };
    },
  };
  els = {};
  ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
   "theme-btn", "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "bell-btn", "bell-badge", "auto-btn",
   "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "ws-select", "palette"].forEach((id) => (els[id] = mkEl("div")));
  rootEl = mkEl("html");
  (globalThis as any).document = {
    getElementById: (id: string) => els[id] || null,
    createElement: (t: string) => mkEl(t),
    addEventListener() {},
    documentElement: rootEl,
  };
  // reset-proof: assign the well-known globals here, in beforeEach
  (globalThis as any).localStorage = (globalThis as any).__stubLS;
  (globalThis as any).matchMedia = (globalThis as any).__stubMM.factory;
  (globalThis as any).fetch = async (url: string) => {
    const ok = (d: any) => ({ json: async () => d });
    if (String(url).includes("/api/health")) return ok({ crm: true, llm: false });
    if (String(url).includes("/api/history")) return ok({ messages: [] });
    if (String(url).includes("/api/automation-runs")) return ok({ runs: [] });
    if (String(url).includes("/api/workspaces")) return ok({ workspaces: [] });
    return ok({});
  };
  return store;
}

function boot() {
  // fresh eval = fresh page load; theme init runs synchronously at IIFE top level.
  // NOTE: anchor the export to the END of the file — the source contains an inner
  // async IIFE whose own "})();" would catch a naive first-occurrence replace and
  // defer the export until after the first await.
  let src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  src = src.replace(/\}\)\(\);[ \t]*\n?$/, ";globalThis.__theme={getTheme,setTheme,applyTheme};})();\n");
  eval(src);
  const T = (globalThis as any).__theme;
  delete (globalThis as any).__theme; // never leak a stale export into the next boot
  return T;
}

let store: any;
beforeEach(() => { store = installStubs(); });

describe("theme default + explicit modes", () => {
  test("default is auto: no stored value, no data-theme attribute", () => {
    const T = boot();
    expect(T.getTheme()).toBe("auto");
    expect(rootEl.hasAttribute("data-theme")).toBe(false);
  });
  test("matchMedia is queried for prefers-color-scheme", () => {
    boot();
    expect((globalThis as any).__stubMM.lastQuery).toContain("prefers-color-scheme");
  });
  test("explicit light applies data-theme and persists", () => {
    const T = boot();
    T.setTheme("light");
    expect(rootEl.getAttribute("data-theme")).toBe("light");
    expect(store.getItem("milton_theme")).toBe("light");
  });
  test("explicit dark applies data-theme and persists", () => {
    const T = boot();
    T.setTheme("dark");
    expect(rootEl.getAttribute("data-theme")).toBe("dark");
    expect(store.getItem("milton_theme")).toBe("dark");
  });
  test("junk stored value is treated as auto", () => {
    store.setItem("milton_theme", "neon");
    const T = boot();
    expect(T.getTheme()).toBe("auto");
    expect(rootEl.hasAttribute("data-theme")).toBe(false);
  });
  test("setTheme('auto') removes the key and the attribute", () => {
    const T = boot();
    T.setTheme("dark");
    expect(rootEl.getAttribute("data-theme")).toBe("dark");
    T.setTheme("auto");
    expect(store.getItem("milton_theme")).toBe(null);
    expect(rootEl.hasAttribute("data-theme")).toBe(false);
  });
});

describe("theme toggle cycling", () => {
  test("Auto → Light → Dark → Auto", () => {
    const T = boot();
    const click = els["theme-btn"].listeners["click"][0];
    expect(T.getTheme()).toBe("auto");
    click(); expect(T.getTheme()).toBe("light"); expect(rootEl.getAttribute("data-theme")).toBe("light");
    click(); expect(T.getTheme()).toBe("dark"); expect(rootEl.getAttribute("data-theme")).toBe("dark");
    click(); expect(T.getTheme()).toBe("auto"); expect(rootEl.hasAttribute("data-theme")).toBe(false);
  });
  test("button icon and label reflect the current mode", () => {
    const T = boot();
    const btn = els["theme-btn"];
    expect(btn.textContent).toBe("🌓");
    T.setTheme("light");
    expect(btn.textContent).toBe("☀️");
    expect(btn.title).toContain("Light");
    T.setTheme("dark");
    expect(btn.textContent).toBe("🌙");
    expect(btn.title).toContain("Dark");
    T.setTheme("auto");
    expect(btn.textContent).toBe("🌓");
    expect(btn.getAttribute("aria-label")).toContain("Auto");
  });
});

describe("theme persistence + OS changes", () => {
  test("choice survives a reload (re-eval applies stored theme at init)", () => {
    const T = boot();
    T.setTheme("dark");
    const T2 = boot(); // fresh page load
    expect(T2.getTheme()).toBe("dark");
    expect(rootEl.getAttribute("data-theme")).toBe("dark");
  });
  test("OS change in auto mode keeps auto (attribute stays absent for CSS to follow)", () => {
    const T = boot();
    expect(T.getTheme()).toBe("auto");
    mm.matches = true;
    mm.listeners.forEach((cb: Function) => cb({ matches: true }));
    expect(T.getTheme()).toBe("auto");
    expect(rootEl.hasAttribute("data-theme")).toBe(false);
  });
  test("OS change in explicit mode does not touch the theme", () => {
    const T = boot();
    T.setTheme("dark");
    mm.matches = false;
    mm.listeners.forEach((cb: Function) => cb({ matches: false }));
    expect(T.getTheme()).toBe("dark");
    expect(rootEl.getAttribute("data-theme")).toBe("dark");
  });
});

describe("theme CSS + pre-paint markup", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  test("light and dark palettes define distinct backgrounds", () => {
    const light = /:root,\s*:root\[data-theme="light"\]\s*{([^}]*)}/.exec(css)![1];
    const dark = /:root\[data-theme="dark"\]\s*{([^}]*)}/.exec(css)![1];
    const bg = (b: string) => /--bg0:\s*(#[0-9a-f]{6})/i.exec(b)![1];
    const lb = bg(light), db = bg(dark);
    expect(lb).not.toBe(db);
    expect(lum(lb)).toBeGreaterThan(0.7); // washi paper is light
    expect(lum(db)).toBeLessThan(0.15);   // ink night is dark
  });
  test("both palettes set text, accent and bubble variables", () => {
    for (const v of ["--text", "--muted", "--accent", "--user-bubble", "--milton-bubble", "--danger"]) {
      expect(css).toContain(v + ":");
    }
    expect(css).toContain("color-scheme: light");
    expect(css).toContain("color-scheme: dark");
  });
  test("no hardcoded hex/rgba colors survive outside variable definitions and photo overlays", () => {
    const stripped = css.replace(/:root[^{]*{[^}]*}/g, ""); // variable definitions (incl. the one nested in @media)
    // known photo-overlay literals are intentional: they sit on top of user photos
    const allowed = new Set(["rgba(0,0,0,.45)", "rgba(0,0,0,.55)", "rgba(0,0,0,.6)", "#fff", "#ffb3b3"]);
    const lits = stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [];
    const bad = lits.filter((l) => !allowed.has(l));
    expect(bad).toEqual([]);
  });
  test("index.html applies the stored theme before first paint", () => {
    const head = html.split("</head>")[0];
    expect(head).toContain('localStorage.getItem("milton_theme")');
    expect(head).toContain('setAttribute("data-theme"');
    // pre-paint script must run before the stylesheet loads
    expect(head.indexOf("milton_theme")).toBeLessThan(head.indexOf('href="styles.css"'));
  });
  test("theme button exists in the topbar", () => {
    expect(html).toContain('id="theme-btn"');
  });
});

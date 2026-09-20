// workspace.test.ts — exec-crm workspace switching: discovery, intents,
// CRM scoping, session store, automation pinning, migration, UI bits.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { parseIntent } from "../src/intents";
import * as auto from "../src/automation";
import * as wss from "../src/workspace";
import { getDeals, getKpis } from "../src/crm";
import { handleMessage, runRoutineUnattended, type Session } from "../src/brain";

let mem: Database;
beforeAll(() => {
  mem = new Database(":memory:");
  auto.initAutomationDb(mem);
  wss.initWorkspaceDb(new Database(":memory:"));
  auto.saveRoutine("wseod", ["kpis"]);
});

// ---- stub exec-crm ---------------------------------------------------------------
const calls: { method: string; url: string }[] = [];
let workspacesDown = false;
const realFetch = globalThis.fetch.bind(globalThis);

const stubWorkspaces = [
  { id: 1, name: "Main", color: "#579bfc", companies: 2, contacts: 3, deals: 1, tasks: 0, campaigns: 0 },
  { id: 2, name: "Acme Corp", color: "#ff0000", companies: 1, contacts: 1, deals: 4, tasks: 2, campaigns: 0 },
  { id: 3, name: "Acme Labs", color: "#00ff00", companies: 0, contacts: 0, deals: 0, tasks: 0, campaigns: 0 },
];

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const fullPath = url.replace("http://localhost:3001", "");
  const path = fullPath.split("?")[0];
  calls.push({ method, url });
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (path === "/api/workspaces") {
    if (workspacesDown) return Promise.reject(new Error("fetch failed"));
    return ok({ workspaces: stubWorkspaces });
  }
  if (path === "/api/kpis") return ok({ pipeline_value: 1000, open_deals: 1 });
  if (path === "/api/deals") return ok({ deals: [] });
  if (path === "/api/tasks") return ok({ tasks: [] });
  if (path === "/api/contacts") return ok({ contacts: [] });
  if (path === "/api/companies") return ok({ companies: [] });
  if (path === "/api/activities") return ok({ activities: [] });
  return ok({});
}

beforeAll(() => { (globalThis as any).fetch = stubFetch; });
afterAll(() => { (globalThis as any).fetch = realFetch; });

const sess = (id = "ws-test"): Session => ({ id, history: [], notes: [] });
const lastCall = () => calls[calls.length - 1];

// ---- intent parsing ----------------------------------------------------------------
describe("workspace intents", () => {
  test("workspaces / current workspace", () => {
    expect(parseIntent("workspaces").name).toBe("list_workspaces");
    expect(parseIntent("list workspaces").name).toBe("list_workspaces");
    expect(parseIntent("current workspace").name).toBe("current_workspace");
  });
  test("switch phrasings", () => {
    expect(parseIntent("switch to acme").name).toBe("switch_workspace");
    expect(parseIntent("switch to acme").slots.name).toBe("acme");
    expect(parseIntent("use workspace acme").name).toBe("switch_workspace");
    expect(parseIntent("switch workspace to acme").name).toBe("switch_workspace");
  });
});

// ---- discovery -----------------------------------------------------------------------
describe("discovery", () => {
  test("parses the exec-crm workspace list", async () => {
    wss.clearWorkspaceCache();
    const list = await wss.listWorkspaces();
    expect(list?.length).toBe(3);
    expect(list?.[1]).toMatchObject({ id: 2, name: "Acme Corp" });
  });
  test("caches for 60s (one fetch for two calls)", async () => {
    wss.clearWorkspaceCache();
    const n = calls.length;
    await wss.listWorkspaces();
    await wss.listWorkspaces();
    expect(calls.length - n).toBe(1);
  });
  test("null when exec-crm is unreachable", async () => {
    wss.clearWorkspaceCache();
    workspacesDown = true;
    try {
      expect(await wss.listWorkspaces()).toBeNull();
    } finally {
      workspacesDown = false;
      wss.clearWorkspaceCache();
    }
  });
  test("findWorkspace: exact, fuzzy, id, unknown", async () => {
    wss.clearWorkspaceCache();
    const exact = (await wss.findWorkspace("Acme Corp"))!;
    expect(exact.length).toBe(1);
    expect(exact[0].ws.id).toBe(2);
    const fuzzy = (await wss.findWorkspace("labs"))!;
    expect(fuzzy[0].ws.id).toBe(3);
    const byId = (await wss.findWorkspace("2"))!;
    expect(byId.length).toBe(1);
    expect(byId[0].ws.id).toBe(2);
    expect(await wss.findWorkspace("zzz")).toEqual([]);
  });
  test("findWorkspace: ambiguous query returns both", async () => {
    wss.clearWorkspaceCache();
    const m = (await wss.findWorkspace("acme"))!;
    expect(m.length).toBe(2);
  });
});

// ---- CRM scoping -----------------------------------------------------------------------
describe("crm workspace scoping", () => {
  test("non-default workspace is sent as ?workspace=<id>", async () => {
    await wss.runWithWorkspace(2, () => getDeals());
    expect(lastCall().url).toContain("workspace=2");
  });
  test("default workspace sends nothing", async () => {
    await wss.runWithWorkspace(null, () => getDeals());
    expect(lastCall().url).not.toContain("workspace=");
  });
  test("ambient defaults to null outside runWithWorkspace", async () => {
    await getKpis();
    expect(lastCall().url).not.toContain("workspace=");
  });
  test("nested contexts restore", async () => {
    await wss.runWithWorkspace(2, async () => {
      await wss.runWithWorkspace(null, () => getDeals());
      expect(lastCall().url).not.toContain("workspace=");
      await getDeals();
      expect(lastCall().url).toContain("workspace=2");
    });
  });
});

// ---- session store -----------------------------------------------------------------------
describe("session workspace store", () => {
  test("round-trip set/get/clear", () => {
    wss.setSessionWorkspace("s-store", 2, "Acme Corp");
    expect(wss.getSessionWorkspace("s-store")).toEqual({ id: 2, name: "Acme Corp" });
    wss.setSessionWorkspace("s-store", 3, "Acme Labs");
    expect(wss.getSessionWorkspace("s-store").id).toBe(3);
    wss.setSessionWorkspace("s-store", null, "");
    expect(wss.getSessionWorkspace("s-store")).toEqual({ id: null, name: "" });
  });
  test("unknown session defaults", () => {
    expect(wss.getSessionWorkspace("nope")).toEqual({ id: null, name: "" });
  });
});

// ---- chat flows -----------------------------------------------------------------------
describe("workspace chat flows", () => {
  test("workspaces lists with ids", async () => {
    const r = await handleMessage(sess("s-ws1"), "workspaces");
    expect(r.text).toContain("Acme Corp");
    expect(r.text).toContain("id 2");
  });
  test("switch to <name> fuzzy-matches and persists", async () => {
    const s = sess("s-ws2");
    const r = await handleMessage(s, "switch to Acme Corp");
    expect(r.text).toContain("Acme Corp");
    expect(s.workspaceId).toBe(2);
    expect(s.workspaceName).toBe("Acme Corp");
    expect(wss.getSessionWorkspace("s-ws2").id).toBe(2);
  });
  test("ambiguous name asks with numbered choices", async () => {
    const s = sess("s-ws3");
    const r = await handleMessage(s, "switch to acme");
    expect(r.cards?.[0]?.kind).toBe("choices");
    expect(s.choice?.kind).toBe("workspace");
    expect(s.workspaceId ?? null).toBeNull();
    const r2 = await handleMessage(s, "2");
    expect(s.workspaceId).toBe(3);
    expect(r2.text).toContain("Acme Labs");
  });
  test("unknown name is reported", async () => {
    const r = await handleMessage(sess("s-ws4"), "switch to zzz");
    expect(r.text).toContain('No workspace matching "zzz"');
  });
  test("switch to default clears", async () => {
    const s = sess("s-ws5");
    await handleMessage(s, "switch to Acme Corp");
    expect(s.workspaceId).toBe(2);
    const r = await handleMessage(s, "switch to default");
    expect(s.workspaceId ?? null).toBeNull();
    expect(r.text).toContain("default workspace");
  });
  test("current workspace reflects the session", async () => {
    const s = sess("s-ws6");
    expect((await handleMessage(s, "current workspace")).text).toContain("default workspace");
    await handleMessage(s, "switch to Acme Corp");
    expect((await handleMessage(s, "current workspace")).text).toContain("Acme Corp");
  });
  test("entity commands run inside the session workspace", async () => {
    const s = sess("s-ws7");
    await handleMessage(s, "switch to Acme Corp");
    await handleMessage(s, "kpis");
    expect(lastCall().url).toContain("workspace=2");
  });
  test("graceful when exec-crm is down", async () => {
    wss.clearWorkspaceCache();
    workspacesDown = true;
    try {
      const r1 = await handleMessage(sess("s-ws8"), "workspaces");
      expect(r1.text).toMatch(/can't reach exec-crm/);
      const r2 = await handleMessage(sess("s-ws9"), "switch to acme");
      expect(r2.text).toMatch(/staying where you are/);
    } finally {
      workspacesDown = false;
      wss.clearWorkspaceCache();
    }
  });
});

// ---- automation pinning -----------------------------------------------------------------------
describe("automation workspace pinning", () => {
  test("schedule captures the creating session's workspace", async () => {
    const s = sess("s-ws10");
    s.workspaceId = 2; s.workspaceName = "Acme Corp";
    const r = await handleMessage(s, "schedule wseod every 30 minutes");
    expect(r.text).toContain("Acme Corp");
    const sch = auto.listSchedules().find((x) => x.routine_name === "wseod")!;
    expect(sch.workspace_id).toBe(2);
    const listed = await handleMessage(sess("s-ws11"), "list schedules");
    expect(listed.text).toContain("Acme Corp");
  });
  test("trigger captures the creating session's workspace", async () => {
    const s = sess("s-ws12");
    s.workspaceId = 3; s.workspaceName = "Acme Labs";
    const r = await handleMessage(s, "when deal won run wseod");
    expect(r.text).toContain("Acme Labs");
    const t = auto.listTriggers().find((x) => x.routine_name === "wseod")!;
    expect(t.workspace_id).toBe(3);
    const listed = await handleMessage(sess("s-ws13"), "list triggers");
    expect(listed.text).toContain("Acme Labs");
  });
  test("unattended run executes inside the pinned workspace", async () => {
    const n = calls.length;
    const run = await runRoutineUnattended("wseod", "schedule", "pin-test", 2);
    expect(run.status).toBe("ok");
    const kpisCalls = calls.slice(n).filter((c) => c.url.includes("/api/kpis"));
    expect(kpisCalls.length).toBeGreaterThan(0);
    expect(kpisCalls.every((c) => c.url.includes("workspace=2"))).toBe(true);
  });
  test("destructive guard still skips unattended with a workspace", async () => {
    auto.saveRoutine("wsdel", ["kpis", "delete deal Ghost"]);
    const run = await runRoutineUnattended("wsdel", "schedule", "pin-test-2", 3);
    expect(run.status).toBe("partial");
    expect(run.summary).toContain("1/2");
    expect(run.summary).toContain("needs confirmation");
  });
});

// ---- migration -----------------------------------------------------------------------
describe("migration", () => {
  test("adds workspace_id to pre-existing schedules/triggers tables", () => {
    const d = new Database(":memory:");
    d.exec(`
      CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, routine_name TEXT NOT NULL, spec TEXT NOT NULL, spec_text TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'server', next_run INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, filter TEXT NOT NULL DEFAULT '{}', routine_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE routines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, steps TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE automation_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', routine_name TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', ran_at TEXT DEFAULT (datetime('now')));
    `);
    d.query("INSERT INTO schedules (routine_name, spec, spec_text, next_run) VALUES (?,?,?,?)").run("old", "{}", "daily", 123);
    d.query("INSERT INTO triggers (event, routine_name) VALUES (?,?)").run("deal.created", "old");
    auto.initAutomationDb(d);
    const sCols = d.query("PRAGMA table_info(schedules)").all() as any[];
    const tCols = d.query("PRAGMA table_info(triggers)").all() as any[];
    expect(sCols.some((c) => c.name === "workspace_id")).toBe(true);
    expect(tCols.some((c) => c.name === "workspace_id")).toBe(true);
    expect(auto.getSchedule(1)?.workspace_id).toBeNull();
    expect(auto.getTrigger(1)?.workspace_id).toBeNull();
    // idempotent: second init is a no-op
    auto.initAutomationDb(d);
    auto.initAutomationDb(mem); // restore the suite DB
  });
});

// ---- UI bits -----------------------------------------------------------------------
describe("workspace UI", () => {
  let W: any;
  beforeAll(async () => {
    const mkEl = (tag: string): any => ({
      tag, children: [] as any[], innerHTML: "", textContent: "", value: "", className: "",
      hidden: false, style: {}, scrollTop: 0, scrollHeight: 0,
      appendChild(c: any) { this.children.push(c); return c; },
      addEventListener() {}, remove() {}, focus() {},
      closest() { return null; }, getAttribute() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    });
    const els: Record<string, any> = {};
    ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
     "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "bell-btn", "bell-badge", "auto-btn",
     "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "ws-select", "palette"].forEach((id) => (els[id] = mkEl("div")));
    (globalThis as any).document = {
      getElementById: (id: string) => els[id] || null,
      createElement: (t: string) => mkEl(t),
      addEventListener() {},
    };
    (globalThis as any).localStorage = { _s: {}, getItem(k: string) { return this._s[k] || null; }, setItem(k: string, v: string) { this._s[k] = String(v); } };
    const prevFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({ json: async () => ({}) });
    let src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    src = src.replace("})();", ";globalThis.__wsx={wsOptionsHtml,wsTag,loadWorkspaces,wsSelectEl:wsSelect};})();");
    eval(src);
    await new Promise((r) => setTimeout(r, 50));
    W = (globalThis as any).__wsx;
    (globalThis as any).fetch = prevFetch;
  });
  test("wsOptionsHtml renders options with selection and escaping", () => {
    const html = W.wsOptionsHtml([{ id: 1, name: "Main" }, { id: 2, name: "A<B" }], 2);
    expect(html).toContain('value="2" selected');
    expect(html).toContain("A&lt;B");
    expect(html).not.toContain('value="1" selected');
  });
  test("wsTag falls back to #id when unknown", () => {
    expect(W.wsTag(null)).toBe("");
    expect(W.wsTag(7)).toBe(" · #7");
  });
  test("loadWorkspaces populates and reveals the select", async () => {
    (globalThis as any).fetch = async (url: string) => ({
      json: async () => url.includes("/api/workspaces")
        ? { workspaces: [{ id: 1, name: "Main", color: "#579bfc" }, { id: 7, name: "Beta", color: "#00ff00" }] }
        : { workspace_id: 7, workspace_name: "Beta" },
    });
    await W.loadWorkspaces();
    expect(W.wsSelectEl.hidden).toBe(false);
    expect(W.wsSelectEl.innerHTML).toContain("Default workspace");
    expect(W.wsSelectEl.innerHTML).toContain('value="7" selected');
    expect(W.wsSelectEl.innerHTML).toContain("Beta");
    // exec-crm down -> select stays hidden, no throw
    (globalThis as any).fetch = async () => { throw new Error("fetch failed"); };
    await W.loadWorkspaces();
    expect(W.wsSelectEl.hidden).toBe(true);
  });
});

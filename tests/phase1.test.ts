// phase1.test.ts — Phase 1 chat behavior: deal blockers, reach, key
// accounts/champions, deterministic day layout. Stubbed exec-crm.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session, todayStr } from "/home/hatch/workspace/your_files/milton/src/brain";
import * as auto from "/home/hatch/workspace/your_files/milton/src/automation";
import { initSettingsDb, setSetting, getSetting } from "/home/hatch/workspace/your_files/milton/src/settings";
import { clearWorkspaceCache } from "/home/hatch/workspace/your_files/milton/src/workspace";

let __sid = 0;
function freshSession(): Session { return { id: `phase1-${++__sid}`, history: [] }; }

// ---- stub data (mutable per test) ------------------------------------------------
let stubTasks: any[] = [];
const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-10-15", owner: "", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Globex Audit", company_id: 2, contact_id: null, company_name: "Globex", contact_name: null, value: 120000, stage: "qualification", probability: 30, expected_close: "2026-11-15", owner: "", created_at: "2026-09-10", updated_at: "2026-09-19" },
];
const stubContacts = [
  { id: 1, name: "Jane Doe", email: "jane@acme.com", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
  { id: 2, name: "Tom Reyes", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
  { id: 3, name: "Dana Cole", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
];
const stubCompanies = [
  { id: 1, name: "Acme", industry: "Software", website: "", notes: "" },
  { id: 2, name: "Globex", industry: "", website: "", notes: "" },
];
const stubStages = [
  { slug: "proposal", name: "Proposal", position: 0, color: "#888", deals: 1 },
  { slug: "qualification", name: "Qualification", position: 1, color: "#888", deals: 1 },
];
function task(id: number, title: string, deal_id: number | null, done: number, owner: string, blocked_by: any[] = [], due_date = "") {
  return { id, title, deal_id, campaign_id: null, due_date, done, owner, created_at: "2026-09-15", blocked_by };
}
function seedTasks() {
  stubTasks = [
    task(1, "Sign SOW", 1, 0, "Dana", []),
    task(2, "Ship v2", 1, 0, "", [{ id: 1, title: "Sign SOW", done: 0 }]),
    task(3, "Launch", 1, 0, "Sam", [{ id: 2, title: "Ship v2", done: 0 }]),
  ];
}

function ok(data: any, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
}
async function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const path = url.replace("http://localhost:3001", "").split("?")[0];
  if (path === "/api/kpis") return ok({ pipeline_value: 170000, open_deals: 2, win_rate: 42 });
  if (path === "/api/deals") return ok({ deals: stubDeals });
  if (path === "/api/contacts") return ok({ contacts: stubContacts });
  if (path === "/api/companies") return ok({ companies: stubCompanies });
  if (path === "/api/tasks") return ok({ tasks: stubTasks });
  if (path === "/api/stages") return ok({ stages: stubStages });
  if (path === "/api/activities") return ok({ activities: [] });
  if (path === "/api/workspaces") return ok({ workspaces: [] });
  return ok({ error: "not found" }, 404);
}
const realFetch = globalThis.fetch.bind(globalThis);

let settingsDb: Database;
beforeAll(() => {
  settingsDb = new Database(":memory:");
  initSettingsDb(settingsDb);
});
beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  clearWorkspaceCache();
  seedTasks();
  settingsDb.exec("DELETE FROM settings;");
  auto.initAutomationDb(new Database(":memory:"));
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

// ---- P1a ----------------------------------------------------------------------------
describe("what's blocking <deal>", () => {
  test("blocker frontier with owners, ready list, critical chain", async () => {
    const r = await handleMessage(freshSession(), "what's blocking acme website");
    expect(r.text).toContain("What's blocking");
    expect(r.text).toContain("Acme Website");
    expect(r.text).toContain("Ship v2");
    expect(r.text).toContain("Sign SOW");
    expect(r.text).toContain("Dana"); // owner shown
    expect(r.text).toContain("Ready now");
    expect(r.text).toContain("Critical chain");
  });
  test("task query still takes the task path", async () => {
    const r = await handleMessage(freshSession(), "what's blocking ship v2");
    expect(r.text).toContain("Ship v2");
    expect(r.text).toContain("Sign SOW");
  });
  test("circular dependencies are reported, not hung on", async () => {
    stubTasks.push(
      task(4, "Loop A", 1, 0, "", [{ id: 5, title: "Loop B", done: 0 }]),
      task(5, "Loop B", 1, 0, "", [{ id: 4, title: "Loop A", done: 0 }]),
    );
    const r = await handleMessage(freshSession(), "what's blocking acme website");
    expect(r.text).toContain("Circular dependency");
    expect(r.text).toContain("Loop A");
  });
  test("deal with no open tasks says so", async () => {
    stubTasks = stubTasks.filter((t) => t.deal_id !== 1);
    const r = await handleMessage(freshSession(), "what's blocking acme website");
    expect(r.text).toContain("no open tasks");
  });
  test("unknown name reports no match", async () => {
    const r = await handleMessage(freshSession(), "what's blocking zzz-no-such-thing");
    expect(r.text).toMatch(/couldn't find|Which deal/i);
  });
});

// ---- P1b -------------------------------------------------------------------------------
describe("reach", () => {
  test("ask-first UX when my_contact_id is unset", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "how do I reach Dana Cole");
    expect(r1.text).toContain("who should I start from");
    const r2 = await handleMessage(s, "Tom Reyes");
    expect(r2.text).toContain("How to reach Dana Cole");
    expect(r2.text).toContain("Tom Reyes");
    expect(r2.text).toContain("Acme");
    expect(r2.text).toContain("works at");
  });
  test("my_contact_id skips the question", async () => {
    setSetting("my_contact_id", "2");
    expect(getSetting("my_contact_id")).toBe("2");
    const r = await handleMessage(freshSession(), "how do I reach Jane Doe");
    expect(r.text).toContain("How to reach Jane Doe");
    expect(r.text).toContain("you");
    expect(r.text).not.toContain("who should I start from");
  });
  test("path from A to B takes both sides explicitly", async () => {
    const r = await handleMessage(freshSession(), "path from Tom Reyes to Dana Cole");
    expect(r.text).toContain("How to reach Dana Cole");
    expect(r.text).toContain("2 hop");
  });
  test("unreachable target says so plainly", async () => {
    // Globex has no links to anyone: Dana Cole (Acme) -> Globex company
    const r = await handleMessage(freshSession(), "path from Dana Cole to Globex");
    expect(r.text).toContain("No path within 4 hops");
  });
  test("unknown target is handled", async () => {
    const r = await handleMessage(freshSession(), "how do I reach zzz-no-such-person");
    expect(r.text).toContain("couldn't pin down");
  });
});

// ---- P1c ---------------------------------------------------------------------------------
describe("key accounts + champions", () => {
  test("key accounts ranks with decomposition", async () => {
    const r = await handleMessage(freshSession(), "key accounts");
    expect(r.text).toContain("Key accounts");
    expect(r.text).toContain("Acme");
    expect(r.text).toContain("rank driven");
    expect(r.text).toContain("deal value");
  });
  test("champions surface connected contacts", async () => {
    const r = await handleMessage(freshSession(), "champions");
    expect(r.text).toContain("Champions");
    // Jane is contact on Acme's $50k deal; Tom/Dana ride the company
    expect(r.text).toMatch(/Jane Doe|Tom Reyes/);
  });
});

// ---- P1d ------------------------------------------------------------------------------------
describe("deterministic day layout", () => {
  function withDayTasks() {
    const today = todayStr();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yesterday = todayStr(y);
    stubTasks = [
      task(10, "Overdue call", null, 0, "", [], yesterday),
      task(11, "Today proposal", null, 0, "", [], today),
      task(12, "Later thing", null, 0, "", [], "2099-01-01"),
    ];
  }
  test("plan my day includes a deterministic time layout", async () => {
    withDayTasks();
    const r = await handleMessage(freshSession(), "plan my day");
    expect(r.text).toContain("Your day");
    expect(r.text).toContain("09:00–09:30");
    expect(r.text).toContain("Overdue call");
    // overdue first
    expect(r.text.indexOf("Overdue call")).toBeLessThan(r.text.indexOf("Today proposal"));
  });
  test("reminder anchors split blocks and render inline", async () => {
    withDayTasks();
    const s = freshSession();
    const now = new Date();
    const fireAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15).getTime();
    auto.createReminder(s.id, "take meds", fireAt);
    const r = await handleMessage(s, "plan my day");
    expect(r.text).toContain("⏰ 09:15 — take meds");
    // first block pushed past the 09:15 anchor
    expect(r.text).toContain("09:15–09:45");
  });
  test("overflow lands in Didn't fit today", async () => {
    withDayTasks();
    setSetting("workday_start", "09:00");
    setSetting("workday_end", "09:40"); // only one 30-min block fits + 10 min
    const r = await handleMessage(freshSession(), "plan my day");
    expect(r.text).toContain("Didn't fit today");
  });
  test("workday window and task_minutes come from settings", async () => {
    withDayTasks();
    setSetting("workday_start", "08:00");
    setSetting("task_minutes", "60");
    const r = await handleMessage(freshSession(), "plan my day");
    expect(r.text).toContain("08:00–09:00");
  });
  test("weighted layout orders by priority weight", async () => {
    withDayTasks();
    setSetting("day_layout_weighted", "1");
    const r = await handleMessage(freshSession(), "plan my day");
    const iOverdue = r.text.indexOf("Overdue call");
    const iToday = r.text.indexOf("Today proposal");
    expect(iOverdue).toBeGreaterThan(-1);
    expect(iToday).toBeGreaterThan(-1);
    expect(iOverdue).toBeLessThan(iToday); // weight 3 beats weight 2
  });
  test("no due tasks -> no layout section", async () => {
    stubTasks = [task(12, "Later thing", null, 0, "", [], "2099-01-01")];
    const r = await handleMessage(freshSession(), "plan my day");
    expect(r.text).not.toContain("Your day");
  });
});

// ---- intent parsing ---------------------------------------------------------------------------
describe("phase 1 intent parsing", () => {
  test("reach variants", async () => {
    expect((await handleMessage(freshSession(), "how to reach Dana Cole")).text).toContain("who should I start from");
  });
});

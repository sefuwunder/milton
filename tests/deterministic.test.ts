// deterministic.test.ts — the offline deterministic abilities build: sales
// cycle, top deals, campaign stats, closing soon, contact detail, search, deal
// notes, campaign creation, won/lost confirmation, stage filtering, and the
// template-based goal breakdown. All against a stubbed exec-crm with
// relative dates so the suite is time-independent.
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent } from "../src/intents";
import { handleMessage, runRoutineUnattended, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initOutcomesDb } from "../src/outcomes";
import { initPlaybookDb } from "../src/playbook";

// ---- fixtures ---------------------------------------------------------------
const dstr = (offsetDays: number): string => {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
};
const ddate = (offsetDays: number): string => dstr(offsetDays).slice(0, 10);

const stubDeals: any[] = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 50000, stage: "proposal", probability: 60, expected_close: ddate(10), owner: "", created_at: dstr(-40), updated_at: dstr(-2) },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 20000, stage: "negotiation", probability: 80, expected_close: ddate(60), owner: "", created_at: dstr(-90), updated_at: dstr(-40) },
  { id: 3, title: "Globex Audit", company_id: 2, contact_id: null, campaign_id: 2, company_name: "Globex", contact_name: null, value: 120000, stage: "qualification", probability: 30, expected_close: "", owner: "", created_at: dstr(-20), updated_at: dstr(-5) },
  { id: 4, title: "Acme Legacy", company_id: 1, contact_id: null, campaign_id: 1, company_name: "Acme", contact_name: null, value: 0, stage: "closed_won", probability: 100, expected_close: "", owner: "", created_at: dstr(-60), updated_at: dstr(-10) },
  { id: 5, title: "Globex Small", company_id: 2, contact_id: null, campaign_id: 2, company_name: "Globex", contact_name: null, value: 8000, stage: "closed_won", probability: 100, expected_close: "", owner: "", created_at: dstr(-40), updated_at: dstr(-10) },
  { id: 6, title: "Acme Lost", company_id: 1, contact_id: null, campaign_id: 1, company_name: "Acme", contact_name: null, value: 10000, stage: "closed_lost", probability: 0, expected_close: "", owner: "", created_at: dstr(-50), updated_at: dstr(-20) },
  { id: 7, title: "Globex Intro", company_id: 2, contact_id: null, campaign_id: null, company_name: "Globex", contact_name: null, value: 0, stage: "prospecting", probability: 10, expected_close: "", owner: "", created_at: dstr(-3), updated_at: dstr(-1) },
  { id: 8, title: "Acme Discovery", company_id: 1, contact_id: null, campaign_id: null, company_name: "Acme", contact_name: null, value: 5000, stage: "pre_negotiation", probability: 15, expected_close: "", owner: "", created_at: dstr(-6), updated_at: dstr(-4) },
];
const stubContacts: any[] = [
  { id: 1, name: "Jane Doe", email: "jane@acme.com", phone: "555-0100", company_id: 1, company_name: "Acme", title: "CTO", notes: "Loves email" },
];
const stubCompanies: any[] = [
  { id: 1, name: "Acme", industry: "Software", website: "", notes: "" },
  { id: 2, name: "Globex", industry: "", website: "", notes: "" },
];
const stubTasks: any[] = [
  { id: 1, title: "Call Acme", deal_id: 1, campaign_id: null, due_date: ddate(-1), done: 0, owner: "", created_at: dstr(-5) },
  { id: 2, title: "Send invoice", deal_id: null, campaign_id: null, due_date: "", done: 1, owner: "", created_at: dstr(-9) },
];
const stubStages = [
  { slug: "prospecting", name: "Prospecting", position: 0, color: "#579bfc", deals: 1 },
  { slug: "qualification", name: "Qualification", position: 1, color: "#579bfc", deals: 1 },
  { slug: "proposal", name: "Proposal", position: 2, color: "#579bfc", deals: 1 },
  { slug: "negotiation", name: "Negotiation", position: 3, color: "#ffcb00", deals: 1 },
  { slug: "pre_negotiation", name: "Pre-Negotiation", position: 4, color: "#a9bee8", deals: 0 },
  { slug: "closed_won", name: "Closed Won", position: 4, color: "#00ca72", deals: 2 },
  { slug: "closed_lost", name: "Closed Lost", position: 5, color: "#c00000", deals: 1 },
];
const stubCampaigns = [
  { id: 1, name: "Q4 Push" },
  { id: 2, name: "Summer Blast" },
];

const calls: { method: string; path: string; body?: any }[] = [];
const realFetch = globalThis.fetch.bind(globalThis);

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace("http://localhost:3001", "");
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path, body });
  const ok = (data: any, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (method === "GET" && path === "/api/kpis") return ok({ pipeline_value: 190000, open_deals: 4, win_rate: 50 });
  if (method === "GET" && path === "/api/deals") return ok({ deals: stubDeals });
  if (method === "GET" && path === "/api/contacts") return ok({ contacts: stubContacts });
  if (method === "GET" && path === "/api/companies") return ok({ companies: stubCompanies });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: stubTasks });
  if (method === "GET" && path === "/api/stages") return ok({ stages: stubStages });
  if (method === "GET" && path === "/api/campaigns") return ok({ campaigns: stubCampaigns });
  if (method === "GET" && path === "/api/activities") return ok({ activities: [] });
  if (method === "GET" && path === "/api/webhooks") return ok({ webhooks: [] });
  if (method === "GET" && path === "/api/hooks") return ok({ hooks: [] });
  if (method === "GET" && path === "/api/deliveries") return ok({ deliveries: [] });
  if (method === "POST" && path === "/api/campaigns") return ok({ campaign: { id: 9, name: body?.name, company_id: body?.company_id } }, 201);
  const dealPatch = path.match(/^\/api\/deals\/(\d+)$/);
  if (dealPatch && method === "PATCH") {
    const d = stubDeals.find((x) => x.id === Number(dealPatch[1]));
    return ok({ deal: { ...d, ...body } });
  }
  if (method === "POST" && path === "/api/tasks") return ok({ task: { id: 9, done: 0, ...body } }, 201);
  const taskPatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (taskPatch && method === "PATCH") return ok({ task: { id: Number(taskPatch[1]), ...body } });
  return Promise.resolve(new Response("not found", { status: 404 }));
}

const sess = (id = "det-test"): Session => ({ id, history: [], notes: [], workspaceId: null });

beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  calls.length = 0;
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initOutcomesDb(new Database(":memory:"));
  initPlaybookDb(new Database(":memory:"));
});

// ---- intent parsing ---------------------------------------------------------
describe("deterministic intents parse", () => {
  const cases: [string, string][] = [
    ["sales cycle", "sales_cycle"], ["deal velocity", "sales_cycle"], ["where do deals stall", "sales_cycle"],
    ["top deals", "top_deals"], ["biggest deals", "top_deals"], ["leaderboard", "top_deals"],
    ["campaign performance", "campaign_stats"], ["campaign roi", "campaign_stats"],
    ["closing soon", "closing_soon"], ["closing this month", "closing_soon"], ["upcoming closes", "closing_soon"],
    ["stale deals", "hygiene"], ["what needs attention", "hygiene"], ["pipeline hygiene", "hygiene"],
  ];
  for (const [input, want] of cases) {
    test(`"${input}" -> ${want}`, () => expect(parseIntent(input).name).toBe(want));
  }
  test("who is jane doe -> contact_detail", () => {
    const i = parseIntent("who is jane doe");
    expect(i.name).toBe("contact_detail");
    expect(i.slots.query).toBe("jane doe");
  });
  test("show negotiation deals -> deals with editable-stage slug", () => {
    const i = parseIntent("show negotiation deals");
    expect(i.name).toBe("deals");
    expect(i.slots.stage).toBe("negotiation");
  });
  test("deals in pre negotiation -> deals with raw stage_name for editable-stage resolution", () => {
    const i = parseIntent("deals in pre negotiation");
    expect(i.name).toBe("deals");
    expect(i.slots.stage_name).toBe("pre negotiation");
  });
  test("show pre negotiation deals -> deals with raw stage_name", () => {
    const i = parseIntent("show pre negotiation deals");
    expect(i.name).toBe("deals");
    expect(i.slots.stage_name).toBe("pre negotiation");
  });
  test("search acme -> search", () => {
    const i = parseIntent("search acme");
    expect(i.name).toBe("search");
    expect(i.slots.query).toBe("acme");
  });
  test("note colon form -> add_note", () => {
    const i = parseIntent("note on acme website: called today");
    expect(i.name).toBe("add_note");
    expect(i.slots.query).toBe("acme website");
    expect(i.slots.text).toBe("called today");
  });
  test("note space form -> add_note rest", () => {
    const i = parseIntent("add note to acme website called today");
    expect(i.name).toBe("add_note");
    expect(i.slots.rest).toContain("acme website");
  });
  test("new campaign -> add_campaign keeps case", () => {
    const i = parseIntent("new campaign Q4 Push");
    expect(i.name).toBe("add_campaign");
    expect(i.slots.name).toBe("Q4 Push");
    expect(i.slots.company).toBe("");
  });
  test("new campaign for acme -> add_campaign with company", () => {
    const i = parseIntent("new campaign q4 push for acme");
    expect(i.name).toBe("add_campaign");
    expect(i.slots.name).toBe("q4 push");
    expect(i.slots.company).toBe("acme");
  });
  test("close as won / mark as lost -> close_deal", () => {
    expect(parseIntent("close acme deal as won").name).toBe("close_deal");
    expect(parseIntent("close acme deal as won").slots.result).toBe("won");
    expect(parseIntent("mark acme deal as lost").slots.result).toBe("lost");
  });
});

// ---- sales cycle ------------------------------------------------------------
describe("sales cycle", () => {
  test("average cycle, median, range, stalest stage, honesty disclaimer", async () => {
    const r = await handleMessage(sess(), "sales cycle");
    expect(r.text).toContain("Average: 40 days");
    expect(r.text).toContain("median 40d");
    expect(r.text).toContain("range 30–50d");
    expect(r.text).toContain("Stalest stage: Negotiation");
    expect(r.text).toContain("exec-crm doesn't record stage history");
    expect(r.text).toContain("stall proxy");
  });
});

// ---- top deals --------------------------------------------------------------
describe("top deals", () => {
  test("top open deals by value, stage + recency", async () => {
    const r = await handleMessage(sess(), "top deals");
    const i1 = r.text.indexOf("Globex Audit"), i2 = r.text.indexOf("Acme Website"), i3 = r.text.indexOf("Acme Retainer");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2); expect(i2).toBeLessThan(i3); // value-descending
    expect(r.text).toContain("Qualification");
    expect(r.text).toContain("since update");
    expect(r.text).not.toContain("Acme Legacy"); // closed, excluded
  });
});

// ---- campaign stats ---------------------------------------------------------
describe("campaign stats", () => {
  test("open/won/lost, win rate, ranked by open pipeline", async () => {
    const r = await handleMessage(sess(), "campaign performance");
    expect(r.text).toContain("Q4 Push");
    expect(r.text).toContain("Summer Blast");
    expect(r.text.indexOf("Summer Blast")).toBeLessThan(r.text.indexOf("Q4 Push")); // 120k > 70k open
    expect(r.text).toContain("2 open");
    expect(r.text).toContain("1 won");
    expect(r.text).toContain("1 lost");
    expect(r.text).toContain("win rate 50%");
  });
});

// ---- closing soon -----------------------------------------------------------
describe("closing soon", () => {
  test("30-day window, weighted values, excludes far-out and undated", async () => {
    const r = await handleMessage(sess(), "closing soon");
    expect(r.text).toContain("Acme Website");
    expect(r.text).toContain("**$30k** weighted"); // 50k * 0.6 probability
    expect(r.text).not.toContain("Acme Retainer"); // 60 days out
    expect(r.text).not.toContain("Globex Audit"); // no close date
  });
});

// ---- hygiene: stale oldest-first + missing value ----------------------------
describe("stale deals hygiene", () => {
  test("stale oldest first, missing close dates and values", async () => {
    const r = await handleMessage(sess(), "stale deals");
    const items = (r.cards?.[0] as any)?.items || [];
    expect(items.some((f: any) => f.text.includes("1 stale deal") && f.text.includes("Acme Retainer"))).toBe(true);
    expect(items.some((f: any) => f.text.includes("no expected close date"))).toBe(true);
    expect(items.some((f: any) => f.text.includes("no value set") && f.text.includes("Globex Intro"))).toBe(true);
  });
});

// ---- contact detail ---------------------------------------------------------
describe("contact detail", () => {
  test("who is jane doe: company, deals, honest last touch", async () => {
    const r = await handleMessage(sess(), "who is jane doe");
    expect(r.text).toContain("Jane Doe");
    expect(r.text).toContain("jane@acme.com");
    expect(r.text).toContain("🏢 **Acme**");
    expect(r.text).toContain("Acme Website");
    expect(r.text).toContain("Open tasks");
    expect(r.text).toContain("Call Acme");
    expect(r.text).toContain("Last touch");
    expect(r.text).toContain("most recent linked-deal update");
  });
});

// ---- search -----------------------------------------------------------------
describe("search", () => {
  test("groups deals, contacts, companies, tasks", async () => {
    const r = await handleMessage(sess(), "search acme");
    expect(r.text).toContain("8 hits");
    const body = ((r.cards?.[0] as any)?.items || []).map((f: any) => f.text).join("\n");
    expect(body).toContain("Deals (5)");
    expect(body).toContain("Contacts (1)");
    expect(body).toContain("Companies (1)");
    expect(body).toContain("Tasks (1)");
  });
  test("no matches", async () => {
    const r = await handleMessage(sess(), "search zzzzzzzz");
    expect(r.text).toContain("Nothing matched");
  });
});

// ---- deal notes -------------------------------------------------------------
describe("deal notes", () => {
  test("colon form stores and deal lookup shows it", async () => {
    const s = sess();
    const r = await handleMessage(s, "note on acme website: called today about the proposal");
    expect(r.text).toContain("Noted on");
    expect(r.text).toContain("called today about the proposal");
    const r2 = await handleMessage(s, "show deal acme website");
    expect(r2.text).toContain("Notes on this deal");
    expect(r2.text).toContain("called today about the proposal");
  });
  test("space form splits on the longest deal title", async () => {
    const r = await handleMessage(sess(), "add note to acme website called about pricing");
    expect(r.text).toContain("Noted on");
    expect(r.text).toContain("called about pricing");
  });
  test("empty note text asks for content", async () => {
    const r = await handleMessage(sess(), "note on acme website:");
    expect(r.text).toContain("What should I note");
  });
});

// ---- campaigns --------------------------------------------------------------
describe("campaigns", () => {
  test("with for <company>: creates immediately with the matched company", async () => {
    const r = await handleMessage(sess(), "new campaign q4 push for acme");
    expect(r.text).toContain("Created campaign");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/campaigns");
    expect(post?.body?.company_id).toBe(1);
    expect(post?.body?.name).toBe("q4 push");
  });
  test("bare name asks for the company, then creates", async () => {
    const s = sess();
    const r = await handleMessage(s, "new campaign Q4 Push");
    expect(r.text).toContain("Which company");
    expect(s.pending?.type).toBe("add_campaign_company");
    calls.length = 0;
    const r2 = await handleMessage(s, "acme");
    expect(r2.text).toContain("Created campaign");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/campaigns");
    expect(post?.body?.company_id).toBe(1);
    expect(post?.body?.name).toBe("Q4 Push");
  });
  test("unknown company: honest message, no campaign created", async () => {
    const r = await handleMessage(sess(), "new campaign q4 push for nobody");
    expect(r.text).toContain("No company matching");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/campaigns")).toBe(false);
  });
});

// ---- close won / lost confirmation ------------------------------------------
describe("close deal confirmation", () => {
  test("close as won asks first; yes patches won with probability 100", async () => {
    const s = sess();
    const r = await handleMessage(s, "close acme website as won");
    expect(r.text).toContain('Mark "Acme Website" as **won** ($50k)?');
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("close_won");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    calls.length = 0;
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain("is **won**");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/deals/1");
    expect(patch?.body?.stage).toBe("closed_won");
    expect(patch?.body?.probability).toBe(100);
  });
  test("no cancels the won close with no write", async () => {
    const s = sess();
    await handleMessage(s, "close acme website as won");
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
  test("mark as lost still asks first and patches on yes", async () => {
    const s = sess();
    const r = await handleMessage(s, "mark acme retainer as lost");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("close_lost");
    calls.length = 0;
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain("lost");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/deals/2");
    expect(patch?.body?.stage).toBe("closed_lost");
  });
  test("unattended routine skips the won close with a needs-confirmation note", async () => {
    await handleMessage(sess(), "save routine cw: close acme website as won; kpis");
    calls.length = 0;
    const run = await runRoutineUnattended("cw", "manual", "test");
    expect(run.status).toBe("partial");
    expect(run.summary).toMatch(/needs confirmation/i);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await handleMessage(sess(), "delete routine cw");
  });
});

// ---- stage-filtered deal listing --------------------------------------------
describe("deals in stage", () => {
  test("show negotiation deals lists only that stage", async () => {
    const r = await handleMessage(sess(), "show negotiation deals");
    expect(r.text).toContain("Deals in Negotiation");
    const titles = ((r.cards?.[0] as any)?.items || []).map((d: any) => d.title);
    expect(titles).toEqual(["Acme Retainer"]);
  });
  test("deals in pre negotiation resolves the editable stage by fuzzy name", async () => {
    const r = await handleMessage(sess(), "deals in pre negotiation");
    expect(r.text).toContain("Deals in Pre-Negotiation");
    const titles = ((r.cards?.[0] as any)?.items || []).map((d: any) => d.title);
    expect(titles).toEqual(["Acme Discovery"]);
  });
  test("unknown stage is honest, not silent", async () => {
    const r = await handleMessage(sess(), "deals in atlantis");
    expect(r.text).toContain('couldn\'t find a stage called "atlantis"');
  });
});

// ---- deterministic goal breakdown -------------------------------------------
describe("goal breakdown without a model", () => {
  test("template plan + confirm card; yes creates one task per step", async () => {
    const s = sess();
    const r = await handleMessage(s, "break down launch event");
    expect(r.text).toContain("Here's a plan");
    expect(r.text).toContain("generated offline from a template");
    expect(r.text).toContain("analyst model will make these smarter");
    expect(r.text).toContain("1.");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("plan_tasks");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks")).toBe(false);
    const steps = (s.pending as any).payload.steps as string[];
    expect(steps.length).toBeGreaterThanOrEqual(4);
    calls.length = 0;
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain(`Created ${steps.length} tasks`);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/tasks").length).toBe(steps.length);
  });
  test("multi-part goal splits execution pieces", async () => {
    const s = sess();
    const r = await handleMessage(s, "break down redesign website and hire contractor");
    const steps = (s.pending as any).payload.steps as string[];
    expect(steps.some((x) => x.toLowerCase().includes("redesign website"))).toBe(true);
    expect(steps.some((x) => x.toLowerCase().includes("hire contractor"))).toBe(true);
    expect(r.text).toContain("Should I create these");
  });
  test("no cancels with no writes", async () => {
    const s = sess();
    await handleMessage(s, "break down launch event");
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

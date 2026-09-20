// prep.test.ts — meeting prep brief: intent parsing, brief assembly vs a
// stubbed exec-crm, disambiguation, no-match, workspace scoping, the
// Meridian pointer, and the optional LLM talking-points section.
import { describe, test, expect, beforeEach } from "bun:test";
import { parseIntent } from "../src/intents";
import * as mer from "../src/meridian";
import { handleMessage, type Session } from "../src/brain";

const sess = (id: string, workspaceId: number | null = null): Session =>
  ({ id, history: [], notes: [], workspaceId });

const dstr = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
};

const stubContacts = [
  { id: 1, name: "Jane Doe", title: "VP Sales", email: "jane@acme.com", phone: "555-0100", company_id: 1, company_name: "Acme Corp", notes: "" },
  { id: 2, name: "Bob Smith", title: "Engineer", email: "", phone: "", company_id: 2, company_name: "Globex", notes: "" },
  { id: 3, name: "Jane Smith", title: "", email: "", phone: "", company_id: null, company_name: "", notes: "" },
];
const stubCompanies = [
  { id: 1, name: "Acme Corp", industry: "SaaS", website: "acme.com", notes: "HQ in Austin" },
  { id: 2, name: "Globex", industry: "", website: "", notes: "" },
];
const stubDeals = [
  { id: 1, title: "Acme pilot", company_id: 1, contact_id: 1, company_name: "Acme Corp", contact_name: "Jane Doe", value: 120000, stage: "negotiation", probability: 60, expected_close: "2026-10-01", owner: "", created_at: "2026-01-01 10:00:00", updated_at: dstr(-45) },
  { id: 2, title: "Acme expansion", company_id: 1, contact_id: null, company_name: "Acme Corp", contact_name: "", value: 60000, stage: "proposal", probability: 40, expected_close: "", owner: "", created_at: "2026-09-01 10:00:00", updated_at: dstr(-2) },
  { id: 3, title: "Globex rollout", company_id: 2, contact_id: 2, company_name: "Globex", contact_name: "Bob Smith", value: 5000, stage: "closed_won", probability: 100, expected_close: "", owner: "", created_at: "", updated_at: dstr(-90) },
];
const stubTasks = [
  { id: 1, title: "Send proposal", deal_id: 1, campaign_id: null, due_date: dstr(-4).slice(0, 10), done: 0, owner: "", created_at: "" }, // 4 calendar days ago -> "4d overdue"
  { id: 2, title: "Call Jane", deal_id: 2, campaign_id: null, due_date: dstr(2).slice(0, 10), done: 0, owner: "", created_at: "" },
  { id: 3, title: "Old done thing", deal_id: 1, campaign_id: null, due_date: dstr(-10).slice(0, 10), done: 1, owner: "", created_at: "" },
];
const stubRecons = [
  { id: "r1", city: "Austin", country: "US", status: "done", created_at: "", updated_at: "", nodes: 4, edges: 3 },
];

const calls: { method: string; url: string }[] = [];
let llmMode: "ok" | "fail" | "down" = "ok";
const realFetch = globalThis.fetch.bind(globalThis);

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (url.startsWith("http://localhost:3001")) {
    const path = url.slice("http://localhost:3001".length).split("?")[0];
    calls.push({ method, url });
    if (path === "/api/deals") return ok({ deals: stubDeals });
    if (path === "/api/contacts") return ok({ contacts: stubContacts });
    if (path === "/api/companies") return ok({ companies: stubCompanies });
    if (path === "/api/tasks") return ok({ tasks: stubTasks });
    return ok({});
  }
  if (url.startsWith("http://localhost:3005")) {
    const path = url.slice("http://localhost:3005".length).split("?")[0];
    if (path === "/api/recon") return ok({ recons: stubRecons });
    return ok({ error: "not found" }, 404);
  }
  if (url.startsWith("http://llm.test")) {
    if (llmMode === "down") return Promise.reject(new Error("fetch failed"));
    if (llmMode === "fail") return ok({ error: "boom" }, 500);
    return ok({ choices: [{ message: { content: "- Ask about the pilot timeline\n- Confirm the expansion budget" } }] });
  }
  return realFetch(input, init);
}

// Assign in beforeEach (not just beforeAll): Bun resets well-known globals
// like fetch between beforeAll and the first test.
beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  mer.clearReconCache();
  calls.length = 0;
  llmMode = "ok";
  delete process.env.MILTON_LLM_URL;
});

// ---- intent parsing ---------------------------------------------------------------
describe("prep intent parsing", () => {
  test("prep me for my call with <name>", () => {
    const i = parseIntent("prep me for my call with Jane Doe");
    expect(i.name).toBe("prep_brief");
    expect(i.slots.name).toBe("Jane Doe"); // casing preserved for display
  });
  test("brief me on <name>", () => {
    const i = parseIntent("brief me on Acme");
    expect(i.name).toBe("prep_brief");
    expect(i.slots.name).toBe("Acme");
  });
  test("meeting prep <name> and meeting prep for <name>", () => {
    expect(parseIntent("meeting prep Acme").name).toBe("prep_brief");
    expect(parseIntent("meeting prep for Acme").name).toBe("prep_brief");
  });
  test("prep for <name>", () => {
    expect(parseIntent("prep for Acme").name).toBe("prep_brief");
  });
  test("bare 'brief me' still means the morning brief", () => {
    expect(parseIntent("brief me").name).toBe("brief");
    expect(parseIntent("morning brief").name).toBe("brief");
  });
});

// ---- brief assembly -----------------------------------------------------------------
describe("prep brief assembly", () => {
  test("contact brief: who, deals sorted by value, stale flag, tasks, bottom line", async () => {
    const r = await handleMessage(sess("p-1"), "prep me for my call with Jane Doe");
    expect(r.text).toContain("Meeting prep: Jane Doe");
    expect(r.text).toContain("VP Sales");
    expect(r.text).toContain("jane@acme.com");
    expect(r.text).toContain("Acme Corp");
    // deals sorted by value desc: pilot ($120k) before expansion ($60k)
    const pilotAt = r.text.indexOf("Acme pilot");
    const expAt = r.text.indexOf("Acme expansion");
    expect(pilotAt).toBeGreaterThan(-1);
    expect(expAt).toBeGreaterThan(pilotAt);
    // stale deal flagged (45 days since update — exact day count varies
    // with time of day, so match the pattern, not the number)
    expect(r.text).toContain("⚠️");
    expect(r.text).toMatch(/\d+d since update ⚠️/);
    // tasks: overdue called out, done task excluded
    expect(r.text).toContain("Send proposal");
    expect(r.text).toContain("4d overdue");
    expect(r.text).not.toContain("Old done thing");
    // bottom line
    expect(r.text).toContain("2 open deals ($180k), 1 stuck 30+ days, 1 overdue task.");
    // cards rendered for the UI
    expect(r.cards?.some((c) => c.kind === "deals")).toBe(true);
    expect(r.cards?.some((c) => c.kind === "tasks")).toBe(true);
  });
  test("company brief: primary contact, closed deals excluded", async () => {
    const r = await handleMessage(sess("p-2"), "brief me on Globex");
    expect(r.text).toContain("Meeting prep: Globex");
    expect(r.text).toContain("Bob Smith"); // primary contact at the company
    expect(r.text).not.toContain("Globex rollout"); // closed_won: not open
    expect(r.text).toContain("No open deals linked.");
    expect(r.text).toContain("0 open deals (—), 0 stuck 30+ days, 0 overdue tasks.");
  });
  test("meridian pointer appears only when a recon city is in the record", async () => {
    const withCity = await handleMessage(sess("p-3"), "prep me for my call with Jane Doe");
    expect(withCity.text).toContain("Meridian has a recon on **Austin**");
    expect(withCity.text).toContain("meridian dossier Austin");
    const noCity = await handleMessage(sess("p-4"), "brief me on Globex");
    expect(noCity.text).not.toContain("Meridian has a recon");
  });
  test("no match gives a clean message with working create chips", async () => {
    const r = await handleMessage(sess("p-5"), "prep me for my call with Zzzzzz");
    expect(r.text).toContain('couldn\'t find any contact or company matching "Zzzzzz"');
    expect(parseIntent(r.chips![0]).name).toBe("add_contact");
    expect(parseIntent(r.chips![1]).name).toBe("add_company");
  });
  test("ambiguous name asks, then the choice resolves to a brief", async () => {
    const s = sess("p-6");
    const r1 = await handleMessage(s, "prep me for my call with Jane");
    expect(r1.cards?.[0]?.kind).toBe("choices");
    expect(r1.text).toContain("who are you meeting with?");
    const r2 = await handleMessage(s, "1");
    expect(r2.text).toContain("Meeting prep: Jane Doe");
  });
  test("workspace scoping: every exec-crm call carries ?workspace=", async () => {
    const s = sess("p-7", 2);
    await handleMessage(s, "prep me for my call with Jane Doe");
    const crmCalls = calls.filter((c) => c.url.startsWith("http://localhost:3001"));
    expect(crmCalls.length).toBeGreaterThan(0);
    for (const c of crmCalls) expect(c.url).toContain("workspace=2");
  });
});

// ---- optional LLM talking points ----------------------------------------------------
describe("prep LLM talking points", () => {
  test("LLM configured: talking points section appears", async () => {
    process.env.MILTON_LLM_URL = "http://llm.test";
    const r = await handleMessage(sess("p-8"), "prep me for my call with Jane Doe");
    expect(r.text).toContain("Talking points");
    expect(r.text).toContain("pilot timeline");
    expect(r.text).toContain("Bottom line"); // deterministic brief intact
  });
  test("LLM failing: brief still complete, one-line note", async () => {
    process.env.MILTON_LLM_URL = "http://llm.test";
    llmMode = "fail";
    const r = await handleMessage(sess("p-9"), "prep me for my call with Jane Doe");
    expect(r.text).not.toContain("pilot timeline");
    expect(r.text).toContain("Talking points skipped");
    expect(r.text).toContain("Bottom line");
    expect(r.text).toContain("Meeting prep: Jane Doe");
  });
  test("LLM unreachable: brief still complete, one-line note", async () => {
    process.env.MILTON_LLM_URL = "http://llm.test";
    llmMode = "down";
    const r = await handleMessage(sess("p-10"), "prep me for my call with Jane Doe");
    expect(r.text).toContain("Talking points skipped");
    expect(r.text).toContain("Bottom line");
  });
  test("LLM not configured: no talking points section at all", async () => {
    const r = await handleMessage(sess("p-11"), "prep me for my call with Jane Doe");
    expect(r.text).not.toContain("Talking points");
    expect(r.text).toContain("Bottom line");
  });
});

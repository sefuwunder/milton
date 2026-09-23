// tests/widgets.test.ts — Milton widget pinning: stashing, pin intent, POST flow.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import { parseIntent } from "../src/intents";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initPlaybookDb } from "../src/playbook";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); initPlaybookDb(new Database(":memory:")); });

const BASE = "http://localhost:3001";
let failPost = false;
const calls: { method: string; path: string; body?: any }[] = [];

const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-09-25", owner: "", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", value: 20000, stage: "negotiation", probability: 80, expected_close: "", owner: "", created_at: "2026-09-05", updated_at: "2026-08-01" },
  { id: 3, title: "Globex Audit", company_id: 2, contact_id: null, campaign_id: 2, company_name: "Globex", value: 120000, stage: "qualification", probability: 30, expected_close: "2026-10-15", owner: "", created_at: "2026-09-10", updated_at: "2026-09-19" },
];
const stubCampaigns = [{ id: 1, name: "Q4 Push" }, { id: 2, name: "Audit Outreach" }];

const realFetch = globalThis.fetch;
async function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith(BASE)) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace(BASE, "").split("?")[0];
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path, body });
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (failPost && method === "POST" && path === "/api/milton/widgets") throw new Error("connection refused");
  if (method === "GET" && path === "/api/kpis") return ok({ pipeline_value: 190000, open_deals: 3, win_rate: 42 });
  if (method === "GET" && path === "/api/deals") return ok({ deals: stubDeals });
  if (method === "GET" && path === "/api/campaigns") return ok({ campaigns: stubCampaigns });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: [] });
  if (method === "GET" && path === "/api/stages") return ok({ stages: [] });
  if (method === "POST" && path === "/api/milton/widgets") {
    return ok({ widget: { id: 7, kind: body.kind, title: body.title, payload: body.payload, source: body.source, created_at: Date.now() } }, 201);
  }
  return ok({});
}
(globalThis as any).fetch = stubFetch;

function freshSession(): Session { return { id: "test", history: [] }; }

describe("pin_widget intent parsing", () => {
  for (const cmd of ["pin this as a widget", "pin it as a widget", "pin widget", "add widget", "add a widget", "save this as a widget", "save it as a widget", "pin it"]) {
    test(`"${cmd}" → pin_widget`, () => {
      expect(parseIntent(cmd).name).toBe("pin_widget");
    });
  }
});

describe("widget stashing", () => {
  test("top deals stashes a table widget", async () => {
    const s = freshSession();
    const r = await handleMessage(s, "top deals");
    expect(r.text).toMatch(/Top/);
    expect(s.lastWidgetable).toMatchObject({ kind: "table", title: "Top deals", source: "milton:top-deals" });
    expect(s.lastWidgetable!.payload.headers).toEqual(["Deal", "Stage", "Value", "Updated"]);
    expect(s.lastWidgetable!.payload.rows.length).toBeGreaterThan(0);
    for (const row of s.lastWidgetable!.payload.rows) {
      expect(row).toHaveLength(4);
      expect(row.every((c: any) => typeof c === "string")).toBe(true);
    }
  });

  test("kpis stashes a stat widget", async () => {
    const s = freshSession();
    await handleMessage(s, "kpis");
    expect(s.lastWidgetable).toMatchObject({ kind: "stat", title: "KPIs", source: "milton:kpis" });
    expect(typeof s.lastWidgetable!.payload.value).toBe("string");
    expect(typeof s.lastWidgetable!.payload.label).toBe("string");
  });

  test("campaign stats stashes a bars widget", async () => {
    const s = freshSession();
    await handleMessage(s, "campaign stats");
    expect(s.lastWidgetable).toMatchObject({ kind: "bars", title: "Campaign performance", source: "milton:campaign-stats" });
    expect(s.lastWidgetable!.payload.format).toBe("currency");
    expect(s.lastWidgetable!.payload.items[0]).toEqual({ label: "Audit Outreach", value: 120000 });
    expect(s.lastWidgetable!.payload.items[1]).toEqual({ label: "Q4 Push", value: 70000 });
  });

  test("closing soon stashes a list widget", async () => {
    const s = freshSession();
    await handleMessage(s, "closing soon");
    expect(s.lastWidgetable).toMatchObject({ kind: "list", title: "Closing soon", source: "milton:closing-soon" });
    expect(s.lastWidgetable!.payload.items.length).toBeGreaterThan(0);
    expect(s.lastWidgetable!.payload.items[0].text).toBe("Acme Website");
  });

  test("pipeline hygiene stashes a list widget", async () => {
    const s = freshSession();
    await handleMessage(s, "pipeline hygiene");
    expect(s.lastWidgetable).toMatchObject({ kind: "list", title: "Pipeline hygiene", source: "milton:hygiene" });
    expect(s.lastWidgetable!.payload.items.length).toBeGreaterThan(0);
  });

  test("conversational answers don't stash", async () => {
    const s = freshSession();
    await handleMessage(s, "tell me a joke about crm");
    expect(s.lastWidgetable).toBeUndefined();
  });
});

describe("pin flow", () => {
  test("pin with a stashed widget POSTs and confirms", async () => {
    calls.length = 0;
    const s = freshSession();
    await handleMessage(s, "top deals");
    const r = await handleMessage(s, "pin this as a widget");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/milton/widgets");
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ kind: "table", title: "Top deals", source: "milton:top-deals" });
    expect(r.text).toMatch(/Pinned “Top deals” to your Milton tab 📌/);
  });

  test("pin with nothing stashed says so plainly", async () => {
    calls.length = 0;
    const s = freshSession();
    const r = await handleMessage(s, "pin this as a widget");
    expect(r.text).toMatch(/Nothing to pin yet/);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/milton/widgets")).toBe(false);
  });

  test("exec-crm down reports plainly", async () => {
    const s = freshSession();
    await handleMessage(s, "kpis");
    failPost = true;
    try {
      const r = await handleMessage(s, "pin it as a widget");
      expect(r.text).toMatch(/Couldn't reach exec-crm/);
    } finally {
      failPost = false;
    }
  });
});

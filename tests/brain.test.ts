// brain.test.ts — Milton behavior tests against a stubbed exec-crm.
import { describe, test, expect, beforeEach } from "bun:test";
import { handleMessage, type Session } from "../src/brain";

// ---- stub exec-crm ------------------------------------------------------------
const calls: { method: string; path: string; body?: any }[] = [];

const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-09-25", owner: "", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 20000, stage: "negotiation", probability: 80, expected_close: "", owner: "", created_at: "2026-09-05", updated_at: "2026-08-01" },
  { id: 3, title: "Globex Audit", company_id: 2, contact_id: null, company_name: "Globex", contact_name: null, value: 120000, stage: "qualification", probability: 30, expected_close: "2026-10-15", owner: "", created_at: "2026-09-10", updated_at: "2026-09-19" },
];
const stubContacts = [
  { id: 1, name: "Jane Doe", email: "jane@acme.com", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
];
const stubCompanies = [
  { id: 1, name: "Acme", industry: "Software", website: "", notes: "" },
  { id: 2, name: "Globex", industry: "", website: "", notes: "" },
];
const stubTasks = [
  { id: 1, title: "Call Acme", deal_id: 1, campaign_id: null, due_date: "2026-09-18", done: 0, owner: "", created_at: "2026-09-15" },
  { id: 2, title: "Send invoice", deal_id: null, campaign_id: null, due_date: "", done: 1, owner: "", created_at: "2026-09-10" },
];

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  // pass through anything that isn't the stubbed exec-crm (lets other test
  // files, e.g. upload.test.ts, reach their own live servers)
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace("http://localhost:3001", "");
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path, body });
  const ok = (data: any, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

  if (method === "GET" && path === "/api/kpis") return ok({ pipeline_value: 190000, open_deals: 3, win_rate: 42 });
  if (method === "GET" && path === "/api/deals") return ok({ deals: stubDeals });
  if (method === "GET" && path === "/api/contacts") return ok({ contacts: stubContacts });
  if (method === "GET" && path === "/api/companies") return ok({ companies: stubCompanies });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: stubTasks });
  if (method === "GET" && path === "/api/activities") return ok({ activities: [{ id: 1, kind: "deal", text: "Deal updated", created_at: "2026-09-19" }] });
  if (method === "GET" && path === "/api/webhooks") return ok({ webhooks: [] });
  if (method === "GET" && path === "/api/hooks") return ok({ hooks: [] });
  if (method === "GET" && path === "/api/deliveries") return ok({ deliveries: [] });

  if (method === "POST" && path === "/api/deals") return ok({ deal: { id: 9, stage: "prospecting", probability: 10, ...body } }, 201);
  const dealPatch = path.match(/^\/api\/deals\/(\d+)$/);
  if (dealPatch && method === "PATCH") {
    const d = stubDeals.find((x) => x.id === Number(dealPatch[1]));
    return ok({ deal: { ...d, ...body } });
  }
  if (dealPatch && method === "DELETE") return ok({ ok: true });
  if (method === "POST" && path === "/api/contacts") return ok({ contact: { id: 9, ...body } }, 201);
  if (method === "POST" && path === "/api/companies") return ok({ company: { id: 9, ...body } }, 201);
  if (method === "POST" && path === "/api/tasks") return ok({ task: { id: 9, done: 0, ...body } }, 201);
  const taskPatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (taskPatch && method === "PATCH") return ok({ task: { id: Number(taskPatch[1]), ...body } });
  if (taskPatch && method === "DELETE") return ok({ ok: true });

  return Promise.resolve(new Response("not found", { status: 404 }));
}

const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as any).fetch = stubFetch;

function freshSession(): Session { return { id: "test", history: [] }; }
beforeEach(() => { calls.length = 0; });

describe("reads", () => {
  test("pipeline summary", async () => {
    const r = await handleMessage(freshSession(), "show pipeline");
    expect(r.text).toContain("3 open deals");
    expect(r.cards?.[0].kind).toBe("pipeline");
    expect(r.cards?.[0].rows?.find((x) => x.stage === "proposal")?.count).toBe(1);
  });
  test("deal detail (unambiguous)", async () => {
    const r = await handleMessage(freshSession(), "show deal globex audit");
    expect(r.cards?.[0].kind).toBe("deals");
    expect(r.text).toContain("Globex Audit");
  });
  test("morning brief", async () => {
    const r = await handleMessage(freshSession(), "morning brief");
    expect(r.text).toContain("open deals");
    expect(r.cards?.some((c) => c.kind === "tasks")).toBe(true); // overdue Call Acme
  });
  test("pipeline hygiene flags gaps", async () => {
    const r = await handleMessage(freshSession(), "pipeline hygiene");
    expect(r.text).toContain("worth fixing");
    const items = r.cards?.[0].items || [];
    expect(items.some((f: any) => f.text.includes("no expected close date"))).toBe(true);
    expect(items.some((f: any) => f.text.includes("stale"))).toBe(true);
  });
  test("unknown falls back gracefully", async () => {
    const r = await handleMessage(freshSession(), "tell me a joke about crm");
    expect(r.text).toContain("not sure");
    expect(r.chips?.length).toBeGreaterThan(0);
  });
});

describe("deal writes", () => {
  test("move deal (unambiguous)", async () => {
    const r = await handleMessage(freshSession(), "move globex audit to proposal");
    expect(r.text).toContain("Proposal");
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/deals/3" && c.body.stage === "proposal")).toBe(true);
  });
  test("ambiguous deal -> choice -> number", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "move acme to negotiation");
    expect(r1.cards?.[0].kind).toBe("choices");
    expect(r1.cards?.[0].options?.length).toBe(2);
    const r2 = await handleMessage(s, "1");
    expect(r2.text).toContain("Negotiation");
    // option 1 is "Acme Retainer" (id 2): tied fuzzy scores break alphabetically
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/deals/2" && c.body.stage === "negotiation")).toBe(true);
  });
  test("mark won", async () => {
    const r = await handleMessage(freshSession(), "mark globex audit as won");
    expect(r.text).toContain("won");
    expect(calls.some((c) => c.method === "PATCH" && c.body.stage === "closed_won")).toBe(true);
  });
  test("mark lost asks for confirmation", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "mark globex audit as lost");
    expect(r1.cards?.[0].kind).toBe("confirm");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const r2 = await handleMessage(s, "no");
    expect(r2.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const r3 = await handleMessage(s, "mark globex audit as lost");
    expect(r3.cards?.[0].kind).toBe("confirm");
    const r4 = await handleMessage(s, "yes");
    expect(calls.some((c) => c.method === "PATCH" && c.body.stage === "closed_lost")).toBe(true);
    expect(r4.text).toContain("lost");
  });
  test("delete deal confirms", async () => {
    const s = freshSession();
    await handleMessage(s, "delete deal globex audit");
    expect(s.pending?.type).toBe("delete_deal");
    await handleMessage(s, "yes");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/deals/3")).toBe(true);
  });
  test("add deal", async () => {
    const r = await handleMessage(freshSession(), "add deal New Logo for Acme worth 25k");
    expect(r.text).toContain("Created deal");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/deals");
    expect(post?.body.title).toContain("new logo");
    expect(post?.body.value).toBe(25000);
    expect(post?.body.company_id).toBe(1);
  });
  test("set deal value", async () => {
    const r = await handleMessage(freshSession(), "set globex audit value to 150k");
    expect(calls.some((c) => c.method === "PATCH" && c.body.value === 150000)).toBe(true);
    expect(r.text).toContain("Updated");
  });
});

describe("task writes", () => {
  test("add task with due date", async () => {
    const r = await handleMessage(freshSession(), "add task Call Acme tomorrow");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/tasks");
    expect(post?.body.title).toBe("call acme");
    expect(post?.body.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.text).toContain("Added task");
  });
  test("complete task by id", async () => {
    await handleMessage(freshSession(), "complete task 1");
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/tasks/1" && c.body.done === 1)).toBe(true);
  });
  test("remind me creates a task", async () => {
    await handleMessage(freshSession(), "remind me to send the proposal friday");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/tasks");
    expect(post?.body.title).toContain("send the proposal");
    expect(post?.body.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("people writes", () => {
  test("add contact resolves company", async () => {
    await handleMessage(freshSession(), "add contact John Smith at Acme john@acme.com");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(post?.body.company_id).toBe(1);
    expect(post?.body.email).toBe("john@acme.com");
  });
});

describe("photo notes", () => {
  test("save note with no transcription asks for a photo first", async () => {
    const r = await handleMessage(freshSession(), "save note to a deal");
    expect(r.text).toMatch(/no transcription/i);
  });

  test("save note flow: ask deal, then file under the named deal", async () => {
    const s = freshSession();
    s.lastOcr = { text: "HELLO 123", uploadId: "u1" };
    const ask = await handleMessage(s, "save note to a deal");
    expect(ask.text).toMatch(/which deal/i);
    expect(s.pending?.type).toBe("save_note");
    const done = await handleMessage(s, "acme website");
    expect(done.text).toMatch(/Saved to.*Acme Website/);
    expect(s.notes?.length).toBe(1);
    expect(s.notes?.[0].text).toBe("HELLO 123");
    expect(s.notes?.[0].dealTitle).toBe("Acme Website");
  });

  test("my notes lists saved notes", async () => {
    const s = freshSession();
    s.notes = [{ dealId: 1, dealTitle: "Acme Website", text: "HELLO 123", at: new Date().toISOString() }];
    const r = await handleMessage(s, "my notes");
    expect(r.text).toMatch(/1 saved note/);
    expect(r.cards?.[0]?.kind).toBe("findings");
  });

  test("ocr_read / handwriting with no photo point at the camera button", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "read this", {});
    expect(r1.text).toMatch(/camera button/);
    const r2 = await handleMessage(s, "analyze the handwriting", {});
    expect(r2.text).toMatch(/camera button/);
  });
});

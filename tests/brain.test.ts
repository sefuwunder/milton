// brain.test.ts — Milton behavior tests against a stubbed exec-crm.
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initOutcomesDb } from "../src/outcomes";
import { initPlaybookDb } from "../src/playbook";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); initOutcomesDb(new Database(":memory:")); initPlaybookDb(new Database(":memory:")); });

// ---- stub exec-crm ------------------------------------------------------------
const calls: { method: string; path: string; body?: any }[] = [];

const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-09-25", owner: "", source: "Referral", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 20000, stage: "negotiation", probability: 80, expected_close: "", owner: "", source: "Website", created_at: "2026-09-05", updated_at: "2026-08-01" },
  { id: 3, title: "Globex Audit", company_id: 2, contact_id: null, campaign_id: 2, company_name: "Globex", contact_name: null, value: 120000, stage: "qualification", probability: 30, expected_close: "2026-10-15", owner: "", source: "Website", created_at: "2026-09-10", updated_at: "2026-09-19" },
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
const stubStages = [
  { slug: "prospecting", name: "Prospecting", position: 0, color: "#579bfc", deals: 0 },
  { slug: "negotiation", name: "Negotiation", position: 1, color: "#ffcb00", deals: 2 },
  { slug: "pre_negotiation", name: "Pre-Negotiation", position: 2, color: "#a9bee8", deals: 0 },
  { slug: "closed_won", name: "Closed Won", position: 3, color: "#00ca72", deals: 0 },
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
  // deal sources + source filtering
  if (method === "GET" && path === "/api/deal-sources") return ok({ sources: ["Referral", "Website"] });
  const dealSrc = path.match(/^\/api\/deals\?source=(.+)$/);
  if (method === "GET" && dealSrc) {
    const src = decodeURIComponent(dealSrc[1]);
    return ok({ deals: stubDeals.filter((d) => (d as any).source === src) });
  }
  // duplicate pairs
  if (method === "GET" && path === "/api/duplicates?type=contact")
    return ok({ pairs: [{ a: { id: 1, name: "Jane Doe", email: "jane@acme.com" }, b: { id: 5, name: "Jane D.", email: "jane@acme.com" }, reason: "same email address" }] });
  if (method === "GET" && path === "/api/duplicates?type=company") return ok({ pairs: [] });
  // deal stage history
  const dealHist = path.match(/^\/api\/deals\/(\d+)\/history$/);
  if (method === "GET" && dealHist)
    return ok({ history: [
      { id: 1, from_stage: null, to_stage: "prospecting", created_at: "2026-09-01" },
      { id: 2, from_stage: "prospecting", to_stage: "qualification", created_at: "2026-09-10" },
      { id: 3, from_stage: "qualification", to_stage: "proposal", created_at: "2026-09-18" },
    ] });
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
  if (method === "GET" && path === "/api/campaigns") return ok({ campaigns: [{ id: 1, name: "Q4 Push" }, { id: 2, name: "Summer Blast" }] });
  if (method === "POST" && path === "/api/campaigns") return ok({ campaign: { id: 9, name: body.name, company_id: body.company_id } }, 201);
  if (method === "POST" && path === "/api/contacts") return ok({ contact: { id: 9, ...body } }, 201);
  if (method === "POST" && path === "/api/companies") return ok({ company: { id: 9, ...body } }, 201);
  if (method === "POST" && path === "/api/tasks") return ok({ task: { id: 9, done: 0, ...body } }, 201);
  const err = (data: any, status: number) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  const taskPatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (taskPatch && method === "PATCH") return ok({ task: { id: Number(taskPatch[1]), ...body } });
  if (taskPatch && method === "DELETE") return ok({ ok: true });
  // completion contract: POST /api/tasks/:id/toggle flips done; 409 with
  // {error:"blocked", blocked_by} when open blockers exist and no confirm
  const taskToggle = path.match(/^\/api\/tasks\/(\d+)\/toggle$/);
  if (taskToggle && method === "POST") {
    const t = stubTasks.find((x) => x.id === Number(taskToggle[1]));
    const open = (t?.blocked_by || []).filter((b: any) => !b.done);
    if (open.length && !body?.confirm) {
      return err({ error: "blocked", blocked_by: open.map((b: any) => ({ id: b.id, title: b.title })) }, 409);
    }
    return ok({ task: { ...t, done: t && t.done ? 0 : 1 } });
  }

  // pipeline stages (query-stripped so ?workspace= scoping still matches)
  const base = path.split("?")[0];
  if (method === "GET" && base === "/api/stages") return ok({ stages: stubStages });
  if (method === "POST" && base === "/api/stages") {
    const slug = String(body.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (stubStages.some((s) => s.slug === slug)) return err({ error: `stage "${slug}" already exists` }, 409);
    return ok({ stage: { slug, name: body.name, position: 9, color: "#579bfc", deals: 0 } }, 201);
  }
  const stageRec = base.match(/^\/api\/stages\/([a-z0-9_]+)$/);
  if (stageRec && method === "PATCH") {
    const st = stubStages.find((s) => s.slug === stageRec[1]);
    if (!st) return err({ error: "unknown stage" }, 404);
    return ok({ stage: { ...st, ...(body.name ? { name: body.name } : {}) } });
  }
  if (stageRec && method === "DELETE") return ok({ ok: true, moved: 0 });

  return Promise.resolve(new Response("not found", { status: 404 }));
}

const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as any).fetch = stubFetch;

// unique session per test: wizard/mention/undo state is keyed by session id,
// so sharing one id would leak state between tests.
let __sid = 0;
function freshSession(): Session { return { id: `test-${++__sid}`, history: [] }; }
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
    expect(r.text).toContain("worth a look");
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
  test("mark won asks for confirmation, then closes on yes", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "mark globex audit as won");
    expect(r1.text).toContain("won");
    expect(r1.cards?.[0].kind).toBe("confirm");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain("won");
    expect(calls.some((c) => c.method === "PATCH" && c.body.stage === "closed_won" && c.body.probability === 100)).toBe(true);
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
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks/1/toggle")).toBe(true);
  });
  test("complete blocked task asks before overriding", async () => {
    (stubTasks[0] as any).blocked_by = [{ id: 7, title: "Sign NDA", done: 0 }];
    (stubTasks[0] as any).is_blocked = true;
    const s = freshSession();
    const r1 = await handleMessage(s, "complete task 1");
    expect(r1.text).toContain("blocked by");
    expect(s.pending?.type).toBe("complete_blocked_task");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks/1/toggle" && c.body?.confirm === true)).toBe(false);
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain("done");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks/1/toggle" && c.body?.confirm === true)).toBe(true);
    delete (stubTasks[0] as any).blocked_by;
    delete (stubTasks[0] as any).is_blocked;
  });
  test("remind me asks for confirmation, then stores a one-shot reminder", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "remind me in 20 minutes to send the proposal");
    expect(r1.text).toMatch(/send the proposal/);
    expect((r1.cards || []).some((c) => c.kind === "confirm")).toBe(true);
    expect(s.pending?.type).toBe("reminder_add");
    // nothing stored before confirmation, and no exec-crm task is created
    expect(auto.listReminders(s.id)).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks")).toBe(false);
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toMatch(/remind you to/);
    const rs = auto.listReminders(s.id);
    expect(rs).toHaveLength(1);
    expect(rs[0].text).toBe("send the proposal");
    expect(rs[0].fire_at).toBeGreaterThan(Date.now() + 19 * 60000);
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

describe("pipeline stages", () => {
  test("lists stages in order with deal counts", async () => {
    const r = await handleMessage(freshSession(), "stages");
    expect(r.text).toContain("Prospecting");
    expect(r.text).toContain("Negotiation");
    expect(r.text).toContain("2 deal(s)");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/stages")).toBe(true);
  });

  test("workspace id is passed through on schema calls", async () => {
    const s = freshSession();
    s.workspaceId = 2;
    await handleMessage(s, "stages");
    expect(calls.some((c) => c.path.includes("workspace=2"))).toBe(true);
  });

  test("add stage", async () => {
    const r = await handleMessage(freshSession(), "add stage Discovery");
    expect(r.text).toContain("Added stage");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/stages");
    expect(post?.body.name).toBe("Discovery");
  });

  test("add stage before another", async () => {
    await handleMessage(freshSession(), "add stage Discovery before Negotiation");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/stages");
    expect(post?.body.before).toBe("negotiation");
  });

  test("add duplicate stage is refused gracefully", async () => {
    const r = await handleMessage(freshSession(), "add stage Negotiation");
    expect(r.text).toMatch(/already a stage/i);
    expect(r.text).not.toMatch(/Something went wrong/);
  });

  test("rename stage", async () => {
    const r = await handleMessage(freshSession(), "rename stage Negotiation to Haggling");
    expect(r.text).toContain("Haggling");
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/api/stages/negotiation");
    expect(patch?.body.name).toBe("Haggling");
  });

  test("ambiguous stage name offers numbered choices", async () => {
    const s = freshSession();
    const r = await handleMessage(s, "rename stage egotiat to Haggling");
    expect(r.cards?.[0].kind).toBe("choices");
    expect(s.choice?.kind).toBe("stage");
    const r2 = await handleMessage(s, "1");
    const patch = calls.find((c) => c.method === "PATCH" && c.path.startsWith("/api/stages/"));
    expect(patch).toBeTruthy();
    expect(r2.text).toContain("Haggling");
  });

  test("unknown stage name is reported", async () => {
    const r = await handleMessage(freshSession(), "delete stage zzz-nope");
    expect(r.text).toMatch(/couldn't find a stage/i);
  });

  test("delete empty stage confirms then deletes", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "delete stage closed won");
    expect(r1.cards?.[0].kind).toBe("confirm");
    expect(s.pending?.type).toBe("delete_stage");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain("Deleted stage");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/api/stages/closed_won");
  });

  test("delete stage with deals asks for a target, then confirms", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "delete stage negotiation");
    expect(r1.text).toMatch(/holds 2 deal\(s\)/);
    expect(r1.text).toMatch(/which stage should i move them into/i);
    expect(s.pending?.type).toBe("delete_stage_target");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const r2 = await handleMessage(s, "prospecting");
    expect(r2.cards?.[0].kind).toBe("confirm");
    expect(r2.text).toMatch(/move 2 deal\(s\) from "Negotiation" to "Prospecting"/i);
    const r3 = await handleMessage(s, "yes");
    expect(r3.text).toContain("Deleted stage");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toContain("/api/stages/negotiation");
    expect(del?.path).toContain("move_to=prospecting");
  });

  test("delete stage target can be cancelled", async () => {
    const s = freshSession();
    await handleMessage(s, "delete stage negotiation");
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("delete stage rejects an unknown target", async () => {
    const s = freshSession();
    await handleMessage(s, "delete stage negotiation");
    const r = await handleMessage(s, "zzz-nope");
    expect(r.text).toMatch(/don't know a stage/i);
    expect(s.pending?.type).toBe("delete_stage_target");
  });

  test("move stage before another", async () => {
    const r = await handleMessage(freshSession(), "move stage closed won before negotiation");
    expect(r.text).toMatch(/before.*Negotiation/);
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/api/stages/closed_won");
    expect(patch?.body.before).toBe("negotiation");
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

describe("usability batch", () => {
  test("new deal wizard: four steps then creates", async () => {
    const s = freshSession();
    const r1 = await handleMessage(s, "new deal");
    expect(r1.text).toContain("1 of 4");
    await handleMessage(s, "Acme Website");
    const r3 = await handleMessage(s, "50k");
    expect(r3.text).toContain("3 of 4");
    await handleMessage(s, "skip"); // company
    const r = await handleMessage(s, "skip"); // close date
    expect(r.text).toContain("Created deal");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/deals");
    expect(post?.body.title).toBe("Acme Website");
    expect(post?.body.value).toBe(50000);
  });
  test("wizard: invalid value re-asks, cancel stops", async () => {
    const s = freshSession();
    await handleMessage(s, "new deal");
    await handleMessage(s, "Acme");
    const bad = await handleMessage(s, "lots");
    expect(bad.text).toContain("doesn't look like an amount");
    const c = await handleMessage(s, "cancel");
    expect(c.text).toContain("Wizard cancelled");
    expect(calls.some((x) => x.method === "POST" && x.path === "/api/deals")).toBe(false);
  });
  test("mid-wizard intent answers then resumes the wizard", async () => {
    const s = freshSession();
    await handleMessage(s, "new deal");
    const r = await handleMessage(s, "my tasks");
    expect(r.cards?.[0]?.kind).toBe("tasks");
    expect(r.cards?.[0]?.items?.[0]?.title).toBe("Call Acme");
    expect(r.text).toContain("1 of 4"); // wizard prompt resumed
    // and the wizard is still alive afterwards
    const r2 = await handleMessage(s, "Acme Website");
    expect(r2.text).toContain("2 of 4");
  });
  test("pronoun: show deal then move it", async () => {
    const s = freshSession();
    await handleMessage(s, "show deal acme website");
    const r1 = await handleMessage(s, "move it to negotiation");
    expect(r1.text).toContain("Moved");
    expect(r1.text).toContain("Negotiation");
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/deals/1" && c.body.stage === "negotiation")).toBe(true);
  });
  test("pronoun: who's her email resolves the contact", async () => {
    const s = freshSession();
    await handleMessage(s, "who is jane doe");
    const r = await handleMessage(s, "what's her email");
    expect(r.text).toContain("jane@acme.com");
  });
  test("pronoun with no mention asks which one", async () => {
    const r = await handleMessage(freshSession(), "move it to negotiation");
    expect(r.text).toContain("Which deal do you mean?");
  });
  test("undo deal create round-trips a delete", async () => {
    const s = freshSession();
    await handleMessage(s, "add deal Undo Me worth 5k");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/deals")).toBe(true);
    const r = await handleMessage(s, "undo");
    expect(r.text).toContain("Undid: Created deal");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/deals/9")).toBe(true);
  });
  test("undo task toggle flips it back", async () => {
    const s = freshSession();
    await handleMessage(s, "complete task 1");
    const r = await handleMessage(s, "undo");
    expect(r.text).toContain("Undid");
    const toggles = calls.filter((c) => c.method === "POST" && c.path === "/api/tasks/1/toggle");
    expect(toggles.length).toBe(2); // complete + undo
  });
  test("undo with nothing journaled", async () => {
    const r = await handleMessage(freshSession(), "undo");
    expect(r.text).toContain("Nothing to undo");
  });
  test("undo contact create is honest about exec-crm limits", async () => {
    const s = freshSession();
    await handleMessage(s, "add contact Bob at Acme");
    const r = await handleMessage(s, "undo");
    expect(r.text).toContain("can't undo that one");
  });
  test("deal journey shows the stage timeline", async () => {
    const r = await handleMessage(freshSession(), "deal journey acme website");
    expect(r.text).toContain("Journey");
    expect(r.text).toContain("Qualification");
    expect(r.text).toContain("Proposal");
  });
  test("task blockers: unblocked task says so", async () => {
    const r = await handleMessage(freshSession(), "what's blocking call acme");
    expect(r.text).toContain("isn't blocked");
  });
  test("show duplicates lists contact pairs with merge guidance", async () => {
    const r = await handleMessage(freshSession(), "show duplicates");
    expect(r.text).toContain("Possible duplicates");
    expect(r.text).toContain("Jane Doe");
    expect(r.text).toContain("exec-crm");
  });
  test("deals from a source filters", async () => {
    const r = await handleMessage(freshSession(), "deals from referral");
    expect(r.text).toContain("Acme Website");
    expect(r.text).not.toContain("Acme Retainer");
  });
  test("unknown input suggests slash commands as fill-in chips", async () => {
    const r = await handleMessage(freshSession(), "updo");
    expect(r.text).toContain("Did you mean");
    expect(r.cards?.[0]?.kind).toBe("suggestions");
    const chips = r.chips || [];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => c.startsWith("/"))).toBe(true);
  });
  test("pure gibberish falls back to generic chips (no noise suggestions)", async () => {
    const r = await handleMessage(freshSession(), "frobnicator");
    expect(r.text).toContain("Did you mean");
    expect(r.cards || []).toEqual([]);
    expect(r.chips).toContain("Show pipeline");
  });
});

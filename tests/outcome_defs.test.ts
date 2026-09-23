// outcome_defs.test.ts — the "Create outcome" / "Activate outcome" doc screens
// as Milton chat workflows.
//
// Covers: (1) outcome_defs.ts store — CRUD, duplicate names, workspace
// isolation; (2) doc vocabulary mappings (method/category); (3) pure parsers
// — parseMultiSelect (incl. multi-word labels like "voice call"),
// parseRecycleDays, parseOutcomeDateTime, fmt/addDays; (4) intent parsing
// with case-preserved names; (5) the create-outcome chat flow end to end;
// (6) the activate-outcome chat flow for recycle / complete / no_effect /
// schedule_appointment, incl. functions (reassign/redirect/pipeline), note,
// SUBMIT effects against the stub CRM, and cancellation.
//
// Test-hygiene notes (see ~/AGENTS.md): every store this file touches is
// initialized in its own top-level beforeAll; the fetch stub is installed in
// beforeEach and restored in afterEach; LLM env is scrubbed.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import { parseIntent } from "../src/intents";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initMissLogDb } from "../src/intent_misses";
import { initOutcomesDb, getOutcomes } from "../src/outcomes";
import { initPlaybookDb } from "../src/playbook";
import * as odef from "../src/outcome_defs";

delete process.env.MILTON_LLM_URL;
delete process.env.MILTON_LLM_MODEL;
delete process.env.MILTON_LLM_KEY;

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initMissLogDb(new Database(":memory:"));
  initPlaybookDb(new Database(":memory:"));
  initOutcomesDb(new Database(":memory:"));
  odef.initOutcomeDefsDb(new Database(":memory:"));
});

// ---- CRM fixture (mutable per test) --------------------------------------------
let fx: { deals: any[]; contacts: any[]; stages: any[]; taskSeq: number } =
  { deals: [], contacts: [], stages: [], taskSeq: 100 };
const calls: { method: string; path: string; body?: any }[] = [];

const realFetch = (globalThis as any).fetch;
function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace("http://localhost:3001", "").split("?")[0];
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path, body });
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (method === "GET" && path === "/api/deals") return ok({ deals: fx.deals });
  if (method === "GET" && path === "/api/contacts") return ok({ contacts: fx.contacts });
  if (method === "GET" && path === "/api/stages") return ok({ stages: fx.stages });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: [] });
  if (method === "POST" && path === "/api/tasks") {
    fx.taskSeq += 1;
    return ok({ task: { id: fx.taskSeq, done: 0, ...body } }, 201);
  }
  let m = path.match(/^\/api\/deals\/(\d+)$/);
  if (m && method === "PATCH") {
    const d = fx.deals.find((x) => x.id === Number(m![1]));
    if (!d) return ok({ error: "not found" }, 404);
    Object.assign(d, body);
    return ok({ deal: d });
  }
  m = path.match(/^\/api\/tasks\/(\d+)$/);
  if (m && method === "DELETE") return ok({ ok: true });
  return ok({});
}
beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  calls.length = 0;
  fx = {
    deals: [
      { id: 1, title: "Acme Website", stage: "proposal", owner: "sam", contact_id: 1, probability: 60, value: 50000 },
      { id: 2, title: "Globex Audit", stage: "qualification", owner: "sam", contact_id: null, probability: 30, value: 120000 },
    ],
    contacts: [{ id: 1, name: "Jane Doe", email: "jane@acme.com", company_id: 1, company_name: "Acme" }],
    stages: [
      { slug: "prospecting", name: "Prospecting", position: 0 },
      { slug: "negotiation", name: "Negotiation", position: 1 },
      { slug: "closed_won", name: "Closed Won", position: 2 },
      { slug: "closed_lost", name: "Closed Lost", position: 3 },
    ],
    taskSeq: 100,
  };
  // fresh definition store per test (module-level db handle)
  odef.initOutcomeDefsDb(new Database(":memory:"));
  initOutcomesDb(new Database(":memory:"));
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

let sessN = 0;
function freshSession(): Session { sessN += 1; return { id: `odefs-test-${sessN}`, history: [] }; }
async function say(s: Session, text: string) { return handleMessage(s, text); }
/** Drive a script of user turns; returns all replies. */
async function convo(s: Session, turns: string[]) {
  const replies = [];
  for (const t of turns) replies.push(await say(s, t));
  return replies;
}
function lastText(replies: any[]) { return replies[replies.length - 1].text as string; }
/** If the reply is a *deal* disambiguation card, answer with option 1 (used where
 *  fuzzy deal resolution may or may not disambiguate on its own). Other
 *  choice cards (completion reason, stage) are left for the test to answer. */
async function pickDealIfChoice(s: Session, r: any): Promise<any> {
  if (r.cards?.[0]?.kind === "choices" && (s.choice as any)?.then?.action === "activate_outcome_deal") {
    return say(s, "1");
  }
  return r;
}
/** Local-calendar today + n days, mirroring outcome_defs.addDays. */
function localPlusDays(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function seedDef(o: Partial<odef.NewOutcomeDef> = {}): odef.OutcomeDef {
  return odef.createOutcomeDef({
    name: "Voicemail", cycle_action: "recycle", default_recycle_days: 3,
    functions: ["reassign", "pipeline"], applicable_actions: ["voice_call"], ...o,
  }, null);
}

// ---- 1) store ------------------------------------------------------------------
describe("outcome_defs store", () => {
  test("create/get roundtrip keeps every doc field", () => {
    const d = odef.createOutcomeDef({
      name: "Voicemail", cycle_action: "recycle", default_recycle_days: 3,
      functions: ["reassign", "pipeline"], applicable_actions: ["voice_call", "email"],
    }, null);
    expect(d.id).toBeGreaterThan(0);
    const got = odef.getOutcomeDef(d.id, null)!;
    expect(got.name).toBe("Voicemail");
    expect(got.cycle_action).toBe("recycle");
    expect(got.default_recycle_days).toBe(3);
    expect(got.completion_reason).toBeNull();
    expect(got.functions).toEqual(["reassign", "pipeline"]);
    expect(got.applicable_actions).toEqual(["voice_call", "email"]);
  });
  test("duplicate name in the same workspace throws; other workspaces are independent", () => {
    odef.createOutcomeDef({ name: "Voicemail", cycle_action: "no_effect" }, null);
    expect(() => odef.createOutcomeDef({ name: "voicemail", cycle_action: "no_effect" }, null))
      .toThrow("duplicate_name");
    // same name in another workspace is fine
    const other = odef.createOutcomeDef({ name: "Voicemail", cycle_action: "no_effect" }, 7);
    expect(other.id).toBeGreaterThan(0);
    expect(odef.listOutcomeDefs(null).length).toBe(1);
    expect(odef.listOutcomeDefs(7).length).toBe(1);
  });
  test("get/find/delete are workspace-scoped", () => {
    const a = odef.createOutcomeDef({ name: "Alpha", cycle_action: "no_effect" }, null);
    odef.createOutcomeDef({ name: "Beta", cycle_action: "no_effect" }, 7);
    expect(odef.getOutcomeDef(a.id, 7)).toBeUndefined();
    expect(odef.findOutcomeDefs("alp", null).map((d) => d.name)).toEqual(["Alpha"]);
    expect(odef.findOutcomeDefs("alp", 7)).toEqual([]);
    expect(odef.deleteOutcomeDef(a.id, 7)).toBe(false);
    expect(odef.deleteOutcomeDef(a.id, null)).toBe(true);
    expect(odef.deleteOutcomeDef(a.id, null)).toBe(false);
    expect(odef.listOutcomeDefs(null)).toEqual([]);
  });
  test("describeDef mirrors the Create screen's fields", () => {
    const d = seedDef();
    const t = odef.describeDef(d);
    expect(t).toContain("**Voicemail**");
    expect(t).toContain("Recycle");
    expect(t).toContain("3 day(s)");
    expect(t).toContain("Reassign");
    expect(t).toContain("Voice call");
  });
  test("method/category mappings feed the outcome log + playbook", () => {
    const d = seedDef({ applicable_actions: ["voice_call"] });
    expect(odef.methodForDef(d)).toBe("call");
    expect(odef.methodForDef(seedDef({ name: "M2", applicable_actions: ["text_message"] }))).toBe("social");
    expect(odef.methodForDef(seedDef({ name: "M3", applicable_actions: [] }))).toBe("call");
    expect(odef.categoryForCycle("recycle")).toBe("recycle");
    expect(odef.categoryForCycle("complete")).toBe("complete");
    expect(odef.categoryForCycle("schedule_appointment")).toBe("pipeline");
    expect(odef.categoryForCycle("no_effect")).toBe("no_effect");
  });
});

// ---- 2) pure parsers -------------------------------------------------------------
describe("outcome_defs parsers", () => {
  test("parseMultiSelect: numbers, commas, all, none, labels", () => {
    expect(odef.parseMultiSelect("1 3", odef.OUTCOME_FUNCTIONS)).toEqual({ ids: ["reassign", "pipeline"] });
    expect(odef.parseMultiSelect("1,3", odef.OUTCOME_FUNCTIONS)).toEqual({ ids: ["reassign", "pipeline"] });
    expect(odef.parseMultiSelect("all", odef.OUTCOME_FUNCTIONS)).toEqual({ ids: ["reassign", "redirect", "pipeline"] });
    expect(odef.parseMultiSelect("none", odef.OUTCOME_FUNCTIONS)).toEqual({ ids: [] });
    expect(odef.parseMultiSelect("email", odef.APPLICABLE_ACTIONS)).toEqual({ ids: ["email"] });
    expect(odef.parseMultiSelect("1 1 2", odef.APPLICABLE_ACTIONS)).toEqual({ ids: ["email", "in_person"] });
    const bad = odef.parseMultiSelect("9", odef.OUTCOME_FUNCTIONS) as { error: string };
    expect("error" in bad).toBe(true);
    const bad2 = odef.parseMultiSelect("bogus", odef.OUTCOME_FUNCTIONS) as { error: string };
    expect("error" in bad2).toBe(true);
  });
  test("parseMultiSelect: multi-word labels work as phrases", () => {
    expect(odef.parseMultiSelect("voice call", odef.APPLICABLE_ACTIONS)).toEqual({ ids: ["voice_call"] });
    expect(odef.parseMultiSelect("snail mail, email", odef.APPLICABLE_ACTIONS)).toEqual({ ids: ["snail_mail", "email"] });
    expect(odef.parseMultiSelect("text message 6", odef.APPLICABLE_ACTIONS)).toEqual({ ids: ["text_message", "voice_call"] });
  });
  test("parseRecycleDays: the Default Recycle Period field", () => {
    expect(odef.parseRecycleDays("3")).toBe(3);
    expect(odef.parseRecycleDays("3 days")).toBe(3);
    expect(odef.parseRecycleDays("two")).toBeNull();
    expect(odef.parseRecycleDays("0")).toBeNull();
    expect(odef.parseRecycleDays("400")).toBeNull();
    expect(odef.parseRecycleDays("")).toBeNull();
  });
  test("parseOutcomeDateTime: doc-format date + time", () => {
    const pd = (s: string) => (/^09\/28\/2026$/.test(s) ? "2026-09-28" : s === "tomorrow" ? localPlusDays(1) : null);
    expect(odef.parseOutcomeDateTime("09/28/2026 2:30 pm", pd)).toEqual({ date: "2026-09-28", time: "14:30" });
    expect(odef.parseOutcomeDateTime("tomorrow 10am", pd)).toEqual({ date: localPlusDays(1), time: "10:00" });
    expect(odef.parseOutcomeDateTime("09/28/2026 12:00 am", pd)).toEqual({ date: "2026-09-28", time: "00:00" });
    expect(odef.parseOutcomeDateTime("09/28/2026 12:00 pm", pd)).toEqual({ date: "2026-09-28", time: "12:00" });
    expect(odef.parseOutcomeDateTime("09/28/2026", pd)).toBeNull();
    expect(odef.parseOutcomeDateTime("soonish", pd)).toBeNull();
  });
  test("fmtMDY / fmtMDYTime / addDays use local calendar days", () => {
    expect(odef.fmtMDY("2026-09-28")).toBe("09/28/2026");
    expect(odef.fmtMDYTime("2026-09-28", "14:30")).toBe("09/28/2026 2:30 pm");
    expect(odef.fmtMDYTime("2026-09-28", "00:00")).toBe("09/28/2026 12:00 am");
    expect(odef.addDays("2026-09-23", 3)).toBe("2026-09-26");
    expect(odef.addDays("2026-01-31", 1)).toBe("2026-02-01");
  });
});

// ---- 3) intent parsing -------------------------------------------------------------
describe("outcome intents", () => {
  const p = (s: string) => parseIntent(s);
  test("create outcome keeps the name's case", () => {
    expect(p("create outcome")).toMatchObject({ name: "create_outcome", slots: { name: "" } });
    expect(p("new outcome")).toMatchObject({ name: "create_outcome" });
    expect(p("create outcome named Voicemail").slots).toMatchObject({ name: "Voicemail" });
    expect(p("create an outcome called No Interest").slots).toMatchObject({ name: "No Interest" });
  });
  test("list / show / delete / activate", () => {
    expect(p("outcomes").name).toBe("list_outcomes");
    expect(p("list outcomes").name).toBe("list_outcomes");
    expect(p("show outcomes").name).toBe("list_outcomes");
    expect(p("show outcome Voicemail").slots).toMatchObject({ name: "Voicemail" });
    expect(p("outcome Voicemail").slots).toMatchObject({ name: "Voicemail" });
    expect(p("delete outcome Voicemail")).toMatchObject({ name: "delete_outcome", slots: { name: "Voicemail" } });
    expect(p("activate outcome Voicemail for Acme Website").slots).toMatchObject({ name: "Voicemail", deal: "Acme Website" });
    expect(p("activate outcome Voicemail").slots).toMatchObject({ name: "Voicemail", deal: "" });
  });
});

// ---- 4) create-outcome chat flow -----------------------------------------------------
describe("create outcome chat flow", () => {
  test("full recycle flow: name → cycle → days → functions → actions → CONFIRM", async () => {
    const s = freshSession();
    let r = await say(s, "create outcome");
    expect(r.text).toContain("What should it be called");
    r = await say(s, "Voicemail");
    expect(r.cards?.[0]).toMatchObject({ kind: "choices" });
    expect(r.text).toContain("Contact Cycle Action");
    r = await say(s, "1"); // Recycle
    expect(r.text).toContain("Default Recycle Period");
    r = await say(s, "3");
    expect(r.text).toContain("Functions");
    r = await say(s, "1 3");
    expect(r.text).toContain("Applicable actions");
    r = await say(s, "1 2 6");
    expect(r.text).toContain("CONFIRM");
    expect(r.text).toContain("Voicemail");
    r = await say(s, "Yes");
    expect(r.text).toContain("Outcome created");
    const defs = odef.listOutcomeDefs(null);
    expect(defs.length).toBe(1);
    expect(defs[0]).toMatchObject({
      name: "Voicemail", cycle_action: "recycle", default_recycle_days: 3,
      functions: ["reassign", "pipeline"], applicable_actions: ["email", "in_person", "voice_call"],
    });
  });
  test("complete flow with completion reason; no cancels the CONFIRM", async () => {
    const s = freshSession();
    const replies = await convo(s, [
      "create outcome named No Interest", "2", // Complete
      "2", // Rejected
      "none", // no functions
      "all", // all actions
      "No", // cancel the confirm
    ]);
    expect(lastText(replies)).toContain("Cancelled");
    expect(odef.listOutcomeDefs(null)).toEqual([]);
  });
  test("cancel mid-flow leaves nothing behind", async () => {
    const s = freshSession();
    await say(s, "create outcome");
    const r = await say(s, "cancel");
    expect(r.text).toContain("Cancelled");
    expect(odef.listOutcomeDefs(null)).toEqual([]);
  });
  test("no at the recycle-day step cancels instead of re-asking", async () => {
    const s = freshSession();
    await say(s, "create outcome");
    await say(s, "Voicemail");
    await say(s, "1");
    const r = await say(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(odef.listOutcomeDefs(null)).toEqual([]);
  });
  test("duplicate name is rejected at the name step", async () => {
    seedDef();
    const s = freshSession();
    await say(s, "create outcome");
    const r = await say(s, "voicemail");
    expect(r.text).toContain("already an outcome");
    expect(odef.listOutcomeDefs(null).length).toBe(1);
  });
  test("bad multi-select input re-asks; outcomes lists and shows the def", async () => {
    const s = freshSession();
    await convo(s, ["create outcome", "Ping", "3"]); // No effect
    let r = await say(s, "bogus");
    expect(r.text).toContain("I didn't get that");
    r = await say(s, "none");
    expect(r.text).toContain("Applicable actions");
    await convo(s, ["voice call", "Yes"]);
    expect(odef.listOutcomeDefs(null)[0].applicable_actions).toEqual(["voice_call"]);
    r = await say(s, "outcomes");
    expect(r.text).toContain("Ping");
    r = await say(s, "show outcome Ping");
    expect(r.text).toContain("No effect");
  });
});

// ---- 5) delete-outcome chat flow -------------------------------------------------------
describe("delete outcome chat flow", () => {
  test("delete asks for confirmation, then removes", async () => {
    seedDef();
    const s = freshSession();
    let r = await say(s, "delete outcome Voicemail");
    expect(r.text).toContain("Delete outcome");
    r = await say(s, "Yes");
    expect(r.text).toContain("Deleted outcome");
    expect(odef.listOutcomeDefs(null)).toEqual([]);
  });
  test("no keeps it; unknown name says so", async () => {
    seedDef();
    const s = freshSession();
    let r = await say(s, "delete outcome Voicemail");
    r = await say(s, "No");
    expect(r.text).toContain("Cancelled");
    expect(odef.listOutcomeDefs(null).length).toBe(1);
    r = await say(s, "delete outcome Bogus");
    expect(r.text).toContain("No outcome matching");
  });
});

// ---- 6) activate-outcome chat flow -------------------------------------------------------
describe("activate outcome chat flow", () => {
  test("recycle: default date via ok → reassign → pipeline stage → note → SUBMIT", async () => {
    seedDef(); // recycle, default 3 days, functions reassign+pipeline, action voice_call
    const s = freshSession();
    let r = await say(s, "activate outcome Voicemail for Acme");
    r = await pickDealIfChoice(s, r); // "Acme" resolves straight to Acme Website
    expect(r.text).toContain("Recycle");
    expect(r.text).toContain("Default recycle date");
    r = await say(s, "ok");
    expect(r.text).toContain("Reassign");
    r = await say(s, "Jordan");
    expect(r.text).toContain("different stage");
    r = await say(s, "2"); // Negotiation
    expect(r.text).toContain("Note");
    r = await say(s, "skip");
    expect(r.text).toContain("SUBMIT");
    expect(r.text).toContain("Voicemail");
    expect(r.text).toContain("Acme Website");
    const before = calls.length;
    r = await say(s, "Yes");
    expect(r.text).toContain("Activated **Voicemail**");
    // recycle follow-up task due today+3
    const taskPost = calls.slice(before).find((c) => c.method === "POST" && c.path === "/api/tasks");
    expect(taskPost).toBeDefined();
    expect(taskPost!.body.due_date).toBe(localPlusDays(3));
    expect(taskPost!.body.deal_id).toBe(1);
    // one PATCH carrying owner + stage
    const patch = calls.slice(before).find((c) => c.method === "PATCH" && c.path === "/api/deals/1");
    expect(patch).toBeDefined();
    expect(patch!.body.owner).toBe("Jordan");
    expect(patch!.body.stage).toBe("negotiation");
    // outcome log entry feeds the playbook
    const logged = getOutcomes(1, null);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ label: "Voicemail", category: "recycle", method: "call" });
  });
  test("complete (successful) marks the deal won and logs", async () => {
    seedDef({ name: "Signed", cycle_action: "complete", completion_reason: "successful", functions: [], applicable_actions: ["email"] });
    const s = freshSession();
    let r = await say(s, "activate outcome Signed for Globex Audit");
    r = await pickDealIfChoice(s, r);
    expect(r.text).toContain("completion reason");
    r = await say(s, "2"); // Successful
    expect(r.text).toContain("Note");
    r = await say(s, "skip");
    expect(r.text).toContain("SUBMIT");
    const before = calls.length;
    r = await say(s, "Yes");
    expect(r.text).toContain("marked **won**");
    const patch = calls.slice(before).find((c) => c.method === "PATCH" && c.path === "/api/deals/2");
    expect(patch!.body).toMatchObject({ stage: "closed_won", probability: 100 });
    expect(calls.slice(before).some((c) => c.method === "POST" && c.path === "/api/tasks")).toBe(false);
    expect(getOutcomes(2, null)[0]).toMatchObject({ label: "Signed", category: "complete" });
  });
  test("no_effect logs only — no CRM writes", async () => {
    seedDef({ name: "FYI", cycle_action: "no_effect", functions: [], applicable_actions: [] });
    const s = freshSession();
    let r0 = await say(s, "activate outcome FYI for Globex Audit");
    r0 = await pickDealIfChoice(s, r0);
    const replies = [r0, await say(s, "test note for the log"), await say(s, "Yes")];
    expect(lastText(replies)).toContain("Activated **FYI**");
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
    const logged = getOutcomes(2, null);
    expect(logged.length).toBe(1);
    expect(logged[0].note).toContain("test note for the log");
    expect(logged[0].category).toBe("no_effect");
  });
  test("schedule_appointment: start/end, end-before-start re-asks, redirect contact", async () => {
    seedDef({
      name: "Demo", cycle_action: "schedule_appointment",
      functions: ["redirect"], applicable_actions: ["in_person"],
    });
    const s = freshSession();
    let r = await say(s, "activate outcome Demo for Globex Audit");
    expect(r.text).toContain("when does it start");
    r = await say(s, "09/28/2026 2:30 pm");
    expect(r.text).toContain("when does it end");
    r = await say(s, "09/28/2026 1:30 pm");
    expect(r.text).toContain("has to be after the start");
    r = await say(s, "09/28/2026 3:30 pm");
    expect(r.text).toContain("Pipeline stage");
    r = await say(s, "5"); // No stage change
    expect(r.text).toContain("Redirect");
    r = await say(s, "Jane");
    r = await pickDealIfChoice(s, r);
    expect(r.text).toContain("Note");
    r = await say(s, "skip");
    expect(r.text).toContain("SUBMIT");
    expect(r.text).toContain("2:30 pm");
    const before = calls.length;
    r = await say(s, "Yes");
    expect(r.text).toContain("Activated **Demo**");
    const taskPost = calls.slice(before).find((c) => c.method === "POST" && c.path === "/api/tasks");
    expect(taskPost).toBeDefined();
    expect(taskPost!.body.title).toContain("Appointment");
    expect(taskPost!.body.due_date).toBe("2026-09-28");
    const patch = calls.slice(before).find((c) => c.method === "PATCH" && c.path === "/api/deals/2");
    expect(patch!.body).toMatchObject({ contact_id: 1 });
    expect(patch!.body.stage).toBeUndefined();
    expect(getOutcomes(2, null)[0]).toMatchObject({ label: "Demo", category: "pipeline" });
  });
  test("no at SUBMIT cancels with zero CRM writes", async () => {
    seedDef({ name: "Signed", cycle_action: "complete", completion_reason: "successful", functions: [], applicable_actions: [] });
    const s = freshSession();
    let r0 = await say(s, "activate outcome Signed for Globex Audit");
    r0 = await pickDealIfChoice(s, r0);
    const replies = [r0, await say(s, "2"), await say(s, "skip"), await say(s, "No")];
    expect(lastText(replies)).toContain("Cancelled");
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
    expect(getOutcomes(2, null)).toEqual([]);
  });
  test("unknown outcome name suggests outcomes / create", async () => {
    const s = freshSession();
    const r = await say(s, "activate outcome Bogus for Acme");
    expect(r.text).toContain("No outcome matching");
  });
  test("activation asks for the deal when for <deal> is missing", async () => {
    seedDef({ name: "FYI", cycle_action: "no_effect", functions: [], applicable_actions: [] });
    const s = freshSession();
    let r = await say(s, "activate outcome FYI");
    expect(r.text).toContain("which deal");
    r = await say(s, "Globex Audit");
    r = await pickDealIfChoice(s, r);
    expect(r.text).toContain("Note");
  });
});

// outcome_phase.test.ts — the Review / Action / Outcome normalization.
//
// Covers: (1) outcomes.ts store — log/get/delete, workspace isolation,
// taxonomy integrity; (2) phase validation + phase-first conflict resolution;
// (3) starter-rule phase assignments incl. R11–R18; (4) R11–R18 firing;
// (5) the guided `log outcome` chat flow end to end; (6) intent parsing.
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
import {
  initOutcomesDb, logOutcome, getOutcomes, getAllOutcomes, deleteOutcome,
  OUTCOME_METHODS, OUTCOME_CATEGORIES, humanizeLabel, methodName,
} from "../src/outcomes";
import {
  initPlaybookDb, loadRules, extractFacts, runPlaybook, validateRule,
  type Rule, type FactSet,
} from "../src/playbook";

delete process.env.MILTON_LLM_URL;
delete process.env.MILTON_LLM_MODEL;
delete process.env.MILTON_LLM_KEY;

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initMissLogDb(new Database(":memory:"));
  initPlaybookDb(new Database(":memory:"));
  initOutcomesDb(new Database(":memory:"));
});

// ---- CRM fixture (mutable per test) ---------------------------------------------
let fx: { deals: any[]; tasks: any[]; activities: any[]; stages: any[] } =
  { deals: [], tasks: [], activities: [], stages: [] };

const realFetch = (globalThis as any).fetch;
function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const path = url.replace("http://localhost:3001", "").split("?")[0];
  const ok = (data: any) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  if (path === "/api/deals") return ok({ deals: fx.deals });
  if (path === "/api/tasks") return ok({ tasks: fx.tasks });
  if (path === "/api/activities") return ok({ activities: fx.activities });
  if (path === "/api/contacts") return ok({ contacts: [] });
  if (path === "/api/stages") return ok({ stages: fx.stages });
  if (path === "/api/companies") return ok({ companies: [] });
  return ok({});
}
beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  fx = { deals: [], tasks: [], activities: [], stages: [] };
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

function freshSession(id = "outcome-test"): Session { return { id, history: [] }; }
function isoDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10) + "T09:00:00";
}
function deal(o: any) {
  return {
    id: 0, title: "", value: 0, stage: "qualification", owner: "sam",
    company_id: null, contact_id: null, expected_close: "",
    created_at: isoDaysAgo(60), updated_at: isoDaysAgo(1), ...o,
  };
}
function task(o: any) {
  return { id: 0, title: "", deal_id: null, due_date: "", done: false, owner: "sam", ...o };
}
const stubStages = [
  { slug: "prospecting", name: "Prospecting", position: 0 },
  { slug: "qualification", name: "Qualification", position: 1 },
  { slug: "negotiation", name: "Negotiation", position: 3 },
];
const NOW = new Date("2026-09-23T12:00:00").getTime();

function mkOutcome(o: any) {
  return { id: 0, deal_id: 1, method: "call", category: "no_contact", label: "voicemail", note: "", at: "2026-09-23 10:00:00", ...o };
}

// ---- outcome store ---------------------------------------------------------------
describe("outcome store", () => {
  test("log + get round trip, ordered by id", () => {
    const a = logOutcome(7, "call", "voicemail", "no_contact", null);
    const b = logOutcome(7, "email", "bounced", "recycle", null);
    const rows = getOutcomes(7, null);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ deal_id: 7, method: "call", label: "voicemail", category: "no_contact" });
    expect(rows[1].at).toBeTruthy();
    expect(deleteOutcome(a.id)).toBe(true);
    expect(getOutcomes(7, null).map((r) => r.id)).toEqual([b.id]);
    expect(deleteOutcome(999999)).toBe(false);
    deleteOutcome(b.id);
  });

  test("workspace isolation", () => {
    const a = logOutcome(8, "call", "voicemail", "no_contact", 1);
    const b = logOutcome(8, "call", "voicemail", "no_contact", null);
    expect(getOutcomes(8, 1).map((r) => r.id)).toEqual([a.id]);
    expect(getOutcomes(8, null).map((r) => r.id).includes(b.id)).toBe(true);
    expect(getOutcomes(8, 2)).toEqual([]);
    expect(getAllOutcomes(1).every((r) => r.deal_id === 8)).toBe(true);
    deleteOutcome(a.id); deleteOutcome(b.id);
  });

  test("taxonomy integrity: every label has a known category, names render", () => {
    for (const [method, def] of Object.entries(OUTCOME_METHODS)) {
      expect(def.labels.length).toBeGreaterThan(0);
      for (const l of def.labels) {
        expect(OUTCOME_CATEGORIES).toContain(l.category);
        expect(humanizeLabel(l.label)).not.toContain("_");
      }
      expect(methodName(method)).toBe(def.name);
    }
    expect(humanizeLabel("meeting_scheduled")).toBe("Meeting Scheduled");
    expect(methodName("in_person")).toBe("In person");
  });
});

// ---- phase validation + ordering --------------------------------------------------
describe("phase validation", () => {
  const base: Rule = {
    id: "PX", name: "Phase test", when: [{ subject: "deal", as: "d", all: [{ fact: "d.open", operator: "equal", value: true }] }],
    then: [{ finding: "x", icon: "🔍", text: "x" }],
  };
  test("phase is required and validated", () => {
    expect(validateRule({ ...base, phase: "review" })).toEqual([]);
    expect(validateRule({ ...base, phase: "action" })).toEqual([]);
    expect(validateRule({ ...base, phase: "outcome" })).toEqual([]);
    const noPhase = validateRule({ ...base, phase: undefined as any });
    expect(noPhase.some((e) => e.includes("phase"))).toBe(true);
    expect(validateRule({ ...base, phase: "banana" as any }).some((e) => e.includes("phase"))).toBe(true);
  });

  test("phase orders the agenda before salience and specificity", () => {
    const mk = (id: string, phase: "review" | "action" | "outcome", salience: number): Rule => ({
      ...base, id, name: id, phase, salience,
    });
    // Outcome rule has the highest salience — review must still fire first.
    const rules = [mk("O", "outcome", 999), mk("A", "action", 500), mk("R", "review", 1)];
    const facts = extractFacts({
      deals: [deal({ id: 1, title: "D", value: 100, updated_at: isoDaysAgo(1) })],
      tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const res = runPlaybook({ rules, facts });
    expect(res.findings.map((f) => f.ruleId)).toEqual(["R", "A", "O"]);
    expect(res.findings.map((f) => f.phase)).toEqual(["review", "action", "outcome"]);
  });
});

// ---- starter rule phases -----------------------------------------------------------
describe("starter rule phases", () => {
  test("R1–R10 retagged, R11–R18 present with phases", () => {
    const rules = loadRules();
    const byId = new Map(rules.map((r) => [r.id, r]));
    const want: Record<string, "review" | "action" | "outcome"> = {
      R1: "review", R2: "review", R3: "action", R4: "review", R5: "action",
      R6: "action", R7: "action", R8a: "outcome", R8b: "outcome", R9: "review", R10: "action",
      R11: "review", R12: "review", R13: "action", R14: "action",
      R15: "outcome", R16: "outcome", R17: "outcome", R18: "outcome",
    };
    for (const [id, phase] of Object.entries(want)) {
      const r = byId.get(id);
      expect(r).toBeDefined();
      expect(r!.rule.phase).toBe(phase);
      expect(r!.active).toBe(true);
    }
    expect(rules.length).toBe(19);
  });
});

// ---- R11–R18 firing -----------------------------------------------------------------
function engineFacts(o: { deals?: any[]; tasks?: any[]; outcomes?: any[]; noteCounts?: Record<number, number> }): FactSet {
  return extractFacts({
    deals: o.deals ?? [], tasks: o.tasks ?? [], activities: [], stages: stubStages,
    nowMs: NOW, outcomes: o.outcomes ?? [], noteCounts: o.noteCounts ?? {},
  });
}
function fired(ruleIds: string[], facts: FactSet): string[] {
  const rules = loadRules().filter((r) => ruleIds.includes(r.id) && r.active);
  const res = runPlaybook({ rules, facts });
  return [...res.findings.map((f) => f.ruleId), ...res.suggestions.map((s) => s.ruleId)];
}

describe("R11–R18", () => {
  test("R11: high-value deal with contact and no notes needs research", () => {
    const d = deal({ id: 1, title: "Whale", value: 20000, contact_id: 5, updated_at: isoDaysAgo(1) });
    expect(fired(["R11"], engineFacts({ deals: [d] }))).toContain("R11");
    expect(fired(["R11"], engineFacts({ deals: [d], noteCounts: { 1: 2 } }))).not.toContain("R11");
    expect(fired(["R11"], engineFacts({ deals: [{ ...d, contact_id: null }] }))).not.toContain("R11");
    expect(fired(["R11"], engineFacts({ deals: [{ ...d, value: 5000 }] }))).not.toContain("R11");
  });

  test("R12: open deal with no linked open task needs a strategy", () => {
    const d = deal({ id: 1, title: "Adrift", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(5) });
    expect(fired(["R12"], engineFacts({ deals: [d] }))).toContain("R12");
    expect(fired(["R12"], engineFacts({ deals: [d], tasks: [task({ id: 1, deal_id: 1, done: false })] }))).not.toContain("R12");
    expect(fired(["R12"], engineFacts({ deals: [{ ...d, updated_at: isoDaysAgo(40) }] }))).not.toContain("R12");
    expect(fired(["R12"], engineFacts({ deals: [{ ...d, stage: "closed_won" }] }))).not.toContain("R12");
  });

  test("R13: early-stage deals go quiet sooner than the 30-day stale rule", () => {
    const d = deal({ id: 1, title: "Early", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(20) });
    expect(fired(["R13"], engineFacts({ deals: [d] }))).toContain("R13");
    expect(fired(["R13"], engineFacts({ deals: [{ ...d, stage: "negotiation" }] }))).not.toContain("R13");
    expect(fired(["R13"], engineFacts({ deals: [{ ...d, updated_at: isoDaysAgo(10) }] }))).not.toContain("R13");
    expect(fired(["R13"], engineFacts({ deals: [{ ...d, updated_at: isoDaysAgo(40) }] }))).not.toContain("R13");
  });

  test("R14: three touches with no conversation → rotate channel or pause", () => {
    const d = deal({ id: 1, title: "Ghost", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(2) });
    const three = [mkOutcome({ label: "voicemail" }), mkOutcome({ label: "no_answer" }), mkOutcome({ label: "left_message" })];
    const res = fired(["R14"], engineFacts({ deals: [d], outcomes: three }));
    expect(res).toContain("R14");
    const two = three.slice(0, 2);
    expect(fired(["R14"], engineFacts({ deals: [d], outcomes: two }))).not.toContain("R14");
    const withChat = [...two, mkOutcome({ label: "conversation", category: "conversation" })];
    expect(fired(["R14"], engineFacts({ deals: [d], outcomes: withChat }))).not.toContain("R14");
    // summaries are open-deal only: a closed deal's outcomes never fire R14
    expect(fired(["R14"], engineFacts({ deals: [{ ...d, stage: "closed_lost" }], outcomes: three }))).not.toContain("R14");
  });

  test("R15: voicemail within 7 days → 3-day callback", () => {
    const d = deal({ id: 1, title: "VM", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(2) });
    expect(fired(["R15"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "voicemail" })] }))).toContain("R15");
    expect(fired(["R15"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "voicemail", at: "2026-09-10 10:00:00" })] }))).not.toContain("R15");
    expect(fired(["R15"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "no_answer" })] }))).not.toContain("R15");
  });

  test("R16: bounced email → verify or redirect", () => {
    const d = deal({ id: 1, title: "Bounce", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(2) });
    const out = fired(["R16"], engineFacts({ deals: [d], outcomes: [mkOutcome({ method: "email", label: "bounced", category: "recycle" })] }));
    expect(out).toContain("R16");
  });

  test("R17: meeting scheduled → prep the brief", () => {
    const d = deal({ id: 1, title: "Booked", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(2) });
    expect(fired(["R17"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "meeting_scheduled", category: "pipeline" })] }))).toContain("R17");
  });

  test("R18: retired outcome → retire or recycle, rep's call", () => {
    const d = deal({ id: 1, title: "Dead", value: 1000, contact_id: 5, expected_close: "2026-12-31", updated_at: isoDaysAgo(2) });
    expect(fired(["R18"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "no_interest", category: "retired" })] }))).toContain("R18");
    expect(fired(["R18"], engineFacts({ deals: [d], outcomes: [mkOutcome({ label: "call_back_later", category: "recycle" })] }))).not.toContain("R18");
  });
});

// ---- intent parsing -----------------------------------------------------------------
describe("log outcome intent parsing", () => {
  test("bare and qualified forms", () => {
    expect(parseIntent("log outcome for Acme").name).toBe("log_outcome");
    expect(parseIntent("log outcome for Acme").slots.query).toBe("acme");
    expect(parseIntent("log an outcome for Beta Launch").name).toBe("log_outcome");
    expect(parseIntent("log an outcome for Beta Launch").slots.query).toBe("beta launch");
    const bare = parseIntent("log outcome");
    expect(bare.name).toBe("log_outcome");
    expect(bare.slots.query).toBe("");
  });
});

// ---- guided log-outcome flow -----------------------------------------------------------
describe("guided log outcome", () => {
  beforeEach(() => {
    fx.stages = stubStages;
    fx.deals = [deal({ id: 1, title: "Acme Website", value: 5000, contact_id: 7, expected_close: "2026-12-31", updated_at: isoDaysAgo(1) })];
    fx.tasks = [task({ id: 1, title: "Follow up", deal_id: 1, due_date: "2026-12-31", done: false })];
  });
  afterEach(() => { for (const o of getAllOutcomes(null)) deleteOutcome(o.id); });

  test("deal → method → label logs the outcome and R16 picks it up in hygiene", async () => {
    const sess = freshSession("outcome-flow");
    let r = await handleMessage(sess, "log outcome for Acme");
    expect(sess.choice?.kind).toBe("outcome");
    expect(sess.choice!.options.map((o) => o.label)).toEqual(["Call", "Email", "Social message", "Video call", "In person"]);

    r = await handleMessage(sess, "2"); // Email
    expect(r.text).toContain("What happened");
    expect(sess.choice!.options.map((o) => o.label)).toContain("Bounced");

    r = await handleMessage(sess, "2"); // Bounced
    expect(r.text).toContain("Logged: Email → Bounced");
    expect(r.text).toContain("Acme Website");

    const logged = getOutcomes(1, null);
    expect(logged.some((o) => o.method === "email" && o.label === "bounced" && o.category === "recycle")).toBe(true);

    const h = await handleMessage(freshSession("outcome-hygiene"), "check hygiene");
    expect(JSON.stringify(h.cards)).toContain("Email to Acme Website bounced");
  });

  test("bare 'log outcome' asks which deal", async () => {
    const r = await handleMessage(freshSession("outcome-bare"), "log outcome");
    expect(r.text).toContain("Which deal");
  });

  test("unknown deal is explained, not logged", async () => {
    const r = await handleMessage(freshSession("outcome-unknown"), "log outcome for Zzznope");
    expect(r.text).toContain("couldn't find any deal matching");
    expect(getAllOutcomes(null)).toEqual([]);
  });
});

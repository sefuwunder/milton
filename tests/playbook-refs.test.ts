// tests/playbook-refs.test.ts — structured deal/contact refs on playbook
// findings & suggestions, so other surfaces (exec-crm's Outreach screen)
// can turn Milton insights into clickable actions without parsing text.
//
// Refs are derived from each activation's bindings: `deal`-subject facts by
// `id` (plus their `contact_id`), `deal_outcome`-subject facts by `deal_id`.
// The `ref` key is omitted entirely when a rule binds no deal.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initPlaybookDb, loadRules, extractFacts, runPlaybook,
  type Rule, type FactSet,
} from "../src/playbook";
import { initDealNotesDb } from "../src/deal_notes";
import { initOutcomesDb } from "../src/outcomes";
import { hygieneData } from "../src/brain";
import starterJson from "../src/playbook-rules.json";

delete process.env.MILTON_LLM_URL;
delete process.env.MILTON_LLM_MODEL;
delete process.env.MILTON_LLM_KEY;

const STARTER = starterJson as unknown as Rule[];

beforeAll(() => {
  initPlaybookDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initOutcomesDb(new Database(":memory:"));
});

const NOW = new Date("2026-09-23T12:00:00").getTime();
const isoDaysAgo = (n: number): string => {
  const d = new Date(NOW); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10) + "T12:00:00";
};
const deal = (o: any) => ({
  id: 0, title: "", value: 0, stage: "qualification", owner: "sam",
  company_id: null, contact_id: null, expected_close: "",
  created_at: isoDaysAgo(60), updated_at: isoDaysAgo(1), ...o,
});
const stubStages = [
  { slug: "prospecting", name: "Prospecting", position: 0 },
  { slug: "qualification", name: "Qualification", position: 1 },
  { slug: "negotiation", name: "Negotiation", position: 3 },
];
const mkOutcome = (o: any) => ({
  id: 0, deal_id: 1, method: "call", category: "no_contact",
  label: "voicemail", note: "", at: "2026-09-23 10:00:00", ...o,
});
function facts(o: { deals?: any[]; tasks?: any[]; activities?: any[]; outcomes?: any[] }): FactSet {
  return extractFacts({
    deals: o.deals ?? [], tasks: o.tasks ?? [], activities: o.activities ?? [],
    stages: stubStages, nowMs: NOW, outcomes: o.outcomes ?? [], noteCounts: {},
  });
}
function byId(ids: string[]): Rule[] {
  return loadRules().filter((r) => ids.includes(r.id) && r.active).map((r) => r.rule);
}

// ---- CRM fetch stub for hygieneData -------------------------------------------
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

describe("finding refs", () => {
  test("per-deal finding carries deal_id + contact_id (R6 quiet negotiation)", () => {
    const r6 = byId(["R6"]);
    const d = deal({ id: 21, title: "QuietCo", stage: "negotiation", contact_id: 9, updated_at: isoDaysAgo(40) });
    const res = runPlaybook({ rules: r6, facts: facts({ deals: [d] }) });
    expect(res.findings.length).toBe(1);
    expect(res.findings[0].ref).toEqual({ deal_id: 21, contact_id: 9 });
    // text is untouched by the ref machinery
    expect(res.findings[0].text).toContain("QuietCo");
  });

  test("deal without a linked contact carries deal_id only", () => {
    const r6 = byId(["R6"]);
    const d = deal({ id: 22, title: "Solo", stage: "negotiation", contact_id: null, updated_at: isoDaysAgo(40) });
    const res = runPlaybook({ rules: r6, facts: facts({ deals: [d] }) });
    expect(res.findings[0].ref).toEqual({ deal_id: 22 });
  });

  test("aggregate finding carries deal_ids (R3 stale deals)", () => {
    const r3 = byId(["R3"]);
    const ds = [
      deal({ id: 31, title: "OldA", stage: "prospecting", updated_at: isoDaysAgo(40) }),
      deal({ id: 32, title: "OldB", stage: "qualification", updated_at: isoDaysAgo(50) }),
    ];
    const res = runPlaybook({ rules: r3, facts: facts({ deals: ds }) });
    expect(res.findings.length).toBe(1);
    expect(res.findings[0].ref).toEqual({ deal_ids: [31, 32] });
    expect(res.findings[0].text).toContain("2 stale deals");
  });

  test("no ref key at all when the rule binds no deal (R5 overdue task)", () => {
    const r5 = byId(["R5"]);
    const t = { id: 7, title: "Call back", deal_id: null, due_date: isoDaysAgo(3).slice(0, 10), done: false, owner: "sam" };
    const res = runPlaybook({ rules: r5, facts: facts({ tasks: [t] }) });
    expect(res.findings.length).toBe(1);
    expect("ref" in res.findings[0]).toBe(false);
  });

  test("task-subject rule with a deal_id on the task still carries no deal ref", () => {
    // deriveRef only honors deal / deal_outcome subjects — a task's
    // deal_id is not a binding and must not leak into the ref.
    const r5 = byId(["R5"]);
    const t = { id: 8, title: "Follow up", deal_id: 99, due_date: isoDaysAgo(3).slice(0, 10), done: false, owner: "sam" };
    const res = runPlaybook({ rules: r5, facts: facts({ tasks: [t] }) });
    expect(res.findings.length).toBe(1);
    expect("ref" in res.findings[0]).toBe(false);
  });
});

describe("suggestion refs", () => {
  test("deal_outcome suggestion carries deal_id (R14 touches, no conversation)", () => {
    const r14 = byId(["R14"]);
    const d = deal({ id: 1, title: "Ghost", contact_id: 5, updated_at: isoDaysAgo(2) });
    const three = [mkOutcome({ label: "voicemail" }), mkOutcome({ label: "no_answer" }), mkOutcome({ label: "left_message" })];
    const res = runPlaybook({ rules: r14, facts: facts({ deals: [d], outcomes: three }) });
    expect(res.suggestions.length).toBe(1);
    expect(res.suggestions[0].ref).toEqual({ deal_id: 1 });
    expect(res.suggestions[0].text).toContain("Ghost");
  });

  test("outcome suggestion carries deal_id (R15 voicemail callback)", () => {
    const r15 = byId(["R15"]);
    const d = deal({ id: 2, title: "VM", contact_id: 6, updated_at: isoDaysAgo(2) });
    const res = runPlaybook({
      rules: r15,
      facts: facts({ deals: [d], outcomes: [mkOutcome({ deal_id: 2, label: "voicemail" })] }),
    });
    expect(res.suggestions.length).toBe(1);
    expect(res.suggestions[0].ref).toEqual({ deal_id: 2 });
  });
});

describe("hygieneData passes refs through", () => {
  test("action items carry refs; review items without deals carry none", async () => {
    fx = {
      deals: [
        deal({ id: 5, title: "QuietDeal", stage: "negotiation", contact_id: 11, updated_at: isoDaysAgo(40) }),
      ],
      tasks: [], activities: [], stages: stubStages,
    };
    const data = await hygieneData(null);
    // R3 stale aggregate → a single stale deal normalizes to deal_id
    const stale = data.items.find((i) => i.kind === "stale");
    expect(stale).toBeDefined();
    expect(stale!.ref).toEqual({ deal_id: 5 });
    // R6 quiet negotiation → deal_id + contact_id
    const quiet = data.items.find((i) => i.kind === "quiet_negotiation");
    expect(quiet).toBeDefined();
    expect(quiet!.ref).toEqual({ deal_id: 5, contact_id: 11 });
    // every item has a kind; items without refs omit the key
    for (const it of data.items) {
      expect(typeof it.kind).toBe("string");
      if (it.ref === undefined) expect("ref" in it).toBe(false);
    }
  });
});

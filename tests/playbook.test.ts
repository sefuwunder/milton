// playbook.test.ts — rule-engine core: DSL matching, agenda/conflict
// resolution, chaining, fact extraction, and SQLite storage. Pure engine +
// storage only: no fetch stubbing, no brain.ts import (the parent owns chat
// integration).
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deal, Task, Stage } from "../src/crm";
import {
  initPlaybookDb, loadRules, listRules, getRule, setRuleActive, reloadPlaybook,
  validateRule, extractFacts, runPlaybook,
  type Rule,
} from "../src/playbook";
import starterJson from "../src/playbook-rules.json";

const STARTER = starterJson as unknown as Rule[];

beforeAll(() => {
  initPlaybookDb(new Database(":memory:"));
});

// ---- fixtures -------------------------------------------------------------------

const NOW = Date.now();

/** Local noon on the day `offsetDays` from NOW, as a CRM-style timestamp. */
const dstr = (offsetDays: number): string => {
  const d = new Date(NOW); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00:00`;
};
const dday = (offsetDays: number): string => dstr(offsetDays).slice(0, 10);

let dealSeq = 100;
const mkDeal = (over: Partial<Deal> = {}): Deal => {
  const id = dealSeq++;
  return {
    id, title: `Deal ${id}`, company_id: null, contact_id: 7,
    value: 5000, stage: "negotiation", probability: 0,
    expected_close: dday(30), owner: "Sam",
    created_at: dstr(-60), updated_at: dstr(-5),
    ...over,
  };
};

let taskSeq = 100;
const mkTask = (over: Partial<Task> = {}): Task => {
  const id = taskSeq++;
  return {
    id, title: `Task ${id}`, deal_id: null, campaign_id: null,
    due_date: dday(5), done: 0, owner: "Sam", created_at: dstr(-2),
    ...over,
  };
};

const stubStages: Stage[] = [
  { slug: "prospecting", name: "Prospecting", position: 0, color: "#888" },
  { slug: "qualification", name: "Qualification", position: 1, color: "#888" },
  { slug: "proposal", name: "Proposal", position: 2, color: "#888" },
  { slug: "negotiation", name: "Negotiation", position: 3, color: "#888" },
  { slug: "closed_won", name: "Closed won", position: 4, color: "#888" },
  { slug: "closed_lost", name: "Closed lost", position: 5, color: "#888" },
];

const dealOpen: Rule["when"][number] = {
  subject: "deal", as: "d",
  all: [{ fact: "d.open", operator: "equal", value: true }],
};

// ---- validateRule -----------------------------------------------------------------

describe("validateRule", () => {
  test("accepts every starter rule", () => {
    for (const r of STARTER) expect(validateRule(r)).toEqual([]);
  });

  test("rejects structural problems", () => {
    expect(validateRule(null)).not.toEqual([]);
    expect(validateRule("nope")).not.toEqual([]);
    expect(validateRule({})).not.toEqual([]);
    expect(validateRule({ id: "X", name: "x", when: [], then: [] }))
      .toContain("then must be a non-empty array");
    expect(validateRule({
      id: "X", name: "x",
      when: [{ fact: "d.open", operator: "bogus", value: true } as never],
      then: [{ suggest: "s" }],
    }).some((e) => e.includes("unknown operator"))).toBe(true);
    expect(validateRule({
      id: "X", name: "x",
      when: [{ all: [] } as never],
      then: [{ suggest: "s" }],
    }).some((e) => e.includes("subject"))).toBe(true);
    expect(validateRule({
      id: "X", name: "x", when: [],
      then: [{ finding: "k" } as never],
    }).some((e) => e.includes("icon"))).toBe(true);
    expect(validateRule({
      id: "X", name: "x", when: [],
      then: [{ assert: "" }],
    }).some((e) => e.includes("collection"))).toBe(true);
    expect(validateRule({
      id: "X", name: "x", when: [],
      then: [{ nope: 1 } as never],
    }).some((e) => e.includes("unknown action"))).toBe(true);
  });
});

// ---- extractFacts -----------------------------------------------------------------

describe("extractFacts", () => {
  test("derives deal/task/activity/dwell/owner_load fields", () => {
    const deals = [
      mkDeal({ id: 1, title: "Acme", value: 120000, stage: "negotiation", updated_at: dstr(-5), expected_close: dday(7) }),
      mkDeal({ id: 2, title: "Old", stage: "proposal", updated_at: dstr(-10), expected_close: "" }),
      mkDeal({ id: 3, title: "Older", stage: "proposal", updated_at: dstr(-20), expected_close: "" }),
      mkDeal({ id: 4, title: "Won", stage: "closed_won", updated_at: dstr(-3), expected_close: "" }),
      mkDeal({ id: 5, title: "NoVal", value: undefined, contact_id: undefined, updated_at: dstr(-1), expected_close: "" }),
    ];
    const tasks = [
      mkTask({ id: 1, title: "Call", due_date: dday(-1), done: 0, owner: "Sam" }),
      mkTask({ id: 2, title: "Mail", due_date: dday(-2), done: 0, owner: "Sam" }),
      mkTask({ id: 3, title: "Done", due_date: dday(-9), done: 1, owner: "Sam" }),
      mkTask({ id: 4, title: "Future", due_date: dday(2), done: 0, owner: "Alex" }),
    ];
    const activities = [
      { id: 1, kind: "note", text: "x", ref_type: "deal", ref_id: 1, created_at: dstr(-3) },
    ];
    const facts = extractFacts({ deals, tasks, activities, stages: stubStages, nowMs: NOW });

    const acme = facts.deal.find((d) => d.id === 1)!;
    expect(acme.days_since_update).toBe(5);
    expect(acme.days_until_close).toBe(7);
    expect(acme.open).toBe(true);
    expect(acme.value).toBe(120000);
    expect(facts.deal.find((d) => d.id === 4)!.open).toBe(false);

    const noval = facts.deal.find((d) => d.id === 5)!;
    expect(noval.value).toBe(0);
    expect(noval.contact_id).toBeNull();
    expect(noval.expected_close).toBe("");
    expect(noval.days_until_close).toBeNull();

    const t1 = facts.task.find((t) => t.id === 1)!;
    expect(t1.overdue).toBe(true);
    expect(t1.open).toBe(true);
    expect(facts.task.find((t) => t.id === 3)!.overdue).toBe(false); // done
    expect(facts.task.find((t) => t.id === 4)!.overdue).toBe(false); // future

    const a = facts.activity[0];
    expect(a.days_ago).toBe(3);
    expect(a.ref_type).toBe("deal");
    expect(a.ref_id).toBe(1);

    // dwell: proposal has open deals 10 and 20 days untouched → median 15
    expect(facts.dwell.find((d) => d.stage === "proposal")!.median_dwell).toBe(15);
    expect(facts.dwell.some((d) => d.stage === "prospecting")).toBe(false);

    // owner_load: Sam has 2 overdue; Alex's only task is in the future
    expect(facts.owner_load.find((o) => o.owner === "Sam")!.overdue_count).toBe(2);
    expect(facts.owner_load.some((o) => o.owner === "Alex")).toBe(false);

    expect(facts.event).toBeUndefined();
  });

  test("dwell medians are pinned to the frozen nowMs, not the wall clock", () => {
    // Fixed history: frozen at local noon on 2024-07-02. A wall-clock
    // implementation would report ~844 days of dwell for these deals.
    const nowMs = new Date(2024, 6, 2, 12, 0).getTime();
    const deals = [
      mkDeal({ id: 1, title: "A", stage: "negotiation", updated_at: "2024-06-01T09:00:00" }),
      mkDeal({ id: 2, title: "B", stage: "negotiation", updated_at: "2024-06-21T18:30:00" }),
      mkDeal({ id: 3, title: "C", stage: "proposal", updated_at: "2024-07-01T00:00:00" }),
    ];
    const a = extractFacts({ deals, tasks: [], activities: [], stages: stubStages, nowMs });
    const b = extractFacts({ deals, tasks: [], activities: [], stages: stubStages, nowMs });
    // 2024-06-01 -> 2024-07-02 is 31 days; 2024-06-21 -> 2024-07-02 is 11 days;
    // median(31, 11) = 21. 2024-07-01 -> 2024-07-02 is 1 day.
    expect(a.dwell.find((d) => d.stage === "negotiation")!.median_dwell).toBe(21);
    expect(a.dwell.find((d) => d.stage === "proposal")!.median_dwell).toBe(1);
    // Same input, same frozen time → identical output (reproducible runs).
    expect(b.dwell).toEqual(a.dwell);
  });

  test("adds the event fact when an event is provided", () => {
    const facts = extractFacts({
      deals: [], tasks: [], activities: [], stages: [], nowMs: NOW,
      event: { name: "deal.stage_changed", deal_id: 9 },
    });
    expect(facts.event).toEqual([{ name: "deal.stage_changed", deal_id: 9 }]);
  });
});

// ---- engine: matching, interpolation, negation --------------------------------------

describe("engine", () => {
  test("simple match + interpolation (literal $ survives)", () => {
    const rule: Rule = {
      id: "t1", name: "t1",
      when: [{
        subject: "deal", as: "d",
        all: [
          { fact: "d.open", operator: "equal", value: true },
          { fact: "d.value", operator: "greaterThan", value: 1000 },
        ],
      }],
      then: [{
        suggest: "Big deal: {d.title} (${d.value}) owned by {d.owner} — flat $5 fee",
        chips: ["Show pipeline"],
      }],
    };
    const facts = extractFacts({
      deals: [mkDeal({ title: "Acme", value: 5000 })],
      tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const res = runPlaybook({ rules: [rule], facts });
    expect(res.suggestions.length).toBe(1);
    expect(res.suggestions[0].text).toBe("Big deal: Acme ($5000) owned by Sam — flat $5 fee");
    expect(res.suggestions[0].why).toContain("rule t1");
    expect(res.suggestions[0].why).toContain("Acme");
  });

  test("${...} keeps its literal dollar", () => {
    const rule: Rule = {
      id: "t1b", name: "t1b", when: [dealOpen],
      then: [{ suggest: "Worth ${d.value} today" }],
    };
    const facts = extractFacts({
      deals: [mkDeal({ value: 7500 })], tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const res = runPlaybook({ rules: [rule], facts });
    expect(res.suggestions[0].text).toBe("Worth $7500 today");
  });

  test("negation-as-failure: R6 fires when quiet, silent with recent activity", () => {
    const r6 = STARTER.find((r) => r.id === "R6")!;
    const deal = mkDeal({ id: 21, title: "QuietCo", stage: "negotiation", updated_at: dstr(-40) });

    const quiet = extractFacts({
      deals: [deal], tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const resQuiet = runPlaybook({ rules: [r6], facts: quiet });
    expect(resQuiet.findings.length).toBe(1);
    expect(resQuiet.findings[0].text).toContain("QuietCo");
    expect(resQuiet.findings[0].text).toContain("no activity in 14 days");
    expect(resQuiet.findings[0].why).toContain("rule R6");
    expect(resQuiet.findings[0].why).toContain("QuietCo");
    expect(resQuiet.findings[0].why).toContain("no activity");
    expect(resQuiet.asserted["at_risk"]).toBe(1);

    const busy = extractFacts({
      deals: [deal], tasks: [],
      activities: [{ id: 1, kind: "note", text: "x", ref_type: "deal", ref_id: 21, created_at: dstr(-2) }],
      stages: stubStages, nowMs: NOW,
    });
    const resBusy = runPlaybook({ rules: [r6], facts: busy });
    expect(resBusy.findings.length).toBe(0);
    expect(resBusy.asserted["at_risk"] ?? 0).toBe(0);
  });

  test("$ refs + where + /2 arithmetic: R7 high-value stall", () => {
    const r7 = STARTER.find((r) => r.id === "R7")!;
    // dwell baseline: negotiation deals untouched 4, 6, 8 days → median 6
    const base = [
      mkDeal({ stage: "negotiation", value: 1000, updated_at: dstr(-4) }),
      mkDeal({ stage: "negotiation", value: 1000, updated_at: dstr(-6) }),
      mkDeal({ stage: "negotiation", value: 1000, updated_at: dstr(-8) }),
    ];
    const mkFacts = (staleDays: number) => extractFacts({
      deals: [...base, mkDeal({ title: "BigOne", stage: "negotiation", value: 50000, updated_at: dstr(-staleDays) })],
      tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    // 20 days untouched > 2× median 7 (incl. the target itself) → fires
    const hot = runPlaybook({ rules: [r7], facts: mkFacts(20) });
    expect(hot.findings.length).toBe(1);
    expect(hot.findings[0].text).toContain("BigOne");
    expect(hot.findings[0].text).toContain("2× past median dwell");
    expect(hot.findings[0].fix).toContain("Sam");
    expect(hot.asserted["at_risk"]).toBe(1);
    // 5 days untouched < 2× median → silent
    const cold = runPlaybook({ rules: [r7], facts: mkFacts(5) });
    expect(cold.findings.length).toBe(0);
  });

  test("conflict resolution: salience, then specificity, then id", () => {
    const mk = (id: string, salience: number, extraLeaves: Rule["when"] = []): Rule => ({
      id, name: id, salience,
      when: [dealOpen, ...extraLeaves],
      then: [{ suggest: `from-${id}` }],
    });
    const rules = [
      mk("ord-d", 10),
      mk("ord-b", 90),
      mk("ord-c", 90, [{ fact: "d.value", operator: "greaterThan", value: 1 }]), // more specific
      mk("ord-a", 90),
    ];
    const facts = extractFacts({
      deals: [mkDeal({ value: 5000 })], tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const res = runPlaybook({ rules, facts });
    expect(res.suggestions.map((s) => s.text)).toEqual([
      "from-ord-c", // salience 90, specificity 2
      "from-ord-a", // salience 90, specificity 1, id first
      "from-ord-b", // salience 90, specificity 1
      "from-ord-d", // salience 10
    ]);
  });

  test("refraction: no refire within a run", () => {
    // The rule asserts back into the collection it matches; without
    // refraction this would loop forever. Each asserted copy is identical to
    // an already-fired activation, so the run must stop after 2 firings.
    const rule: Rule = {
      id: "refr", name: "refr", when: [dealOpen],
      then: [{ assert: "deal", facts: { id: "{d.id}", title: "{d.title}", open: true } }],
    };
    const facts = extractFacts({
      deals: [mkDeal({ title: "Solo" })], tasks: [], activities: [], stages: stubStages, nowMs: NOW,
    });
    const res = runPlaybook({ rules: [rule], facts });
    expect(res.capped).toBe(false);
    expect(res.fired).toBe(2);
    expect(res.asserted["deal"]).toBe(2);
  });

  test("100-iteration cap trips on an assert loop", () => {
    const loop: Rule = {
      id: "loop", name: "loop",
      when: [{ subject: "tick", as: "t" }],
      then: [{ assert: "tick", facts: { n: "{t.n}x" } }],
    };
    const res = runPlaybook({ rules: [loop], facts: { tick: [{ n: "0" }] } });
    expect(res.capped).toBe(true);
    expect(res.fired).toBe(100);
    expect(res.asserted["tick"]).toBe(100);
  });

  test("chaining: R8a asserts won, R8b suggests follow-through", () => {
    const r8a = STARTER.find((r) => r.id === "R8a")!;
    const r8b = STARTER.find((r) => r.id === "R8b")!;
    const facts = extractFacts({
      deals: [], tasks: [], activities: [], stages: [], nowMs: NOW,
      event: {
        name: "deal.stage_changed", deal_id: 7, deal_title: "Acme Corp",
        stage_from: "negotiation", stage_to: "closed_won",
      },
    });
    const res = runPlaybook({ rules: [r8a, r8b], facts, eventName: "deal.stage_changed" });
    expect(res.asserted["won"]).toBe(1);
    expect(res.suggestions.length).toBe(1);
    expect(res.suggestions[0].text).toContain("Acme Corp");
    expect(res.suggestions[0].text).toContain("referral");
    expect(res.suggestions[0].chips).toEqual(["Show pipeline", "Morning brief"]);
  });

  test("event scoping: on-rules only run with a matching eventName", () => {
    const facts = extractFacts({
      deals: [mkDeal({ title: "NoClose", expected_close: "" })],
      tasks: [], activities: [], stages: stubStages, nowMs: NOW,
      event: {
        name: "deal.stage_changed", deal_id: 7, deal_title: "Acme",
        stage_from: "negotiation", stage_to: "closed_won",
      },
    });
    // Normal run: R1 fires, event-scoped R8a/R8b do not.
    const normal = runPlaybook({ rules: STARTER, facts });
    expect(normal.findings.some((f) => f.ruleId === "R1")).toBe(true);
    expect(normal.suggestions.some((s) => s.ruleId === "R8b")).toBe(false);
    expect(normal.asserted["won"] ?? 0).toBe(0);
    // Matching event run: R8a+R8b fire, R1 does not.
    const evt = runPlaybook({ rules: STARTER, facts, eventName: "deal.stage_changed" });
    expect(evt.asserted["won"]).toBe(1);
    expect(evt.suggestions.some((s) => s.ruleId === "R8b")).toBe(true);
    expect(evt.findings.some((f) => f.ruleId === "R1")).toBe(false);
    // Non-matching event name: nothing fires.
    const other = runPlaybook({ rules: STARTER, facts, eventName: "task.completed" });
    expect(other.asserted["won"] ?? 0).toBe(0);
    expect(other.findings.length).toBe(0);
    expect(other.suggestions.length).toBe(0);
  });

  test("deterministic: two runs produce identical JSON", () => {
    const facts = extractFacts({
      deals: [
        mkDeal({ title: "A", value: 0 }),
        mkDeal({ title: "B", expected_close: "", updated_at: dstr(-40) }),
      ],
      tasks: [mkTask({ due_date: dday(-1) })],
      activities: [], stages: stubStages, nowMs: NOW,
    });
    const a = runPlaybook({ rules: STARTER, facts });
    const b = runPlaybook({ rules: STARTER, facts });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("migrated-hygiene equivalence: R1–R5 match the legacy predicates", () => {
    // Legacy brain.ts hygieneReply predicates, reimplemented verbatim.
    const daysUntil = (dateStr: string): number | null => {
      const m = dateStr.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      const r = new Date(NOW); r.setHours(0, 0, 0, 0);
      return Math.round((d.getTime() - r.getTime()) / 86400000);
    };
    const deals = [
      mkDeal({ title: "D1", expected_close: "" }),                       // no close date
      mkDeal({ title: "D2", value: 0 }),                                 // no value
      mkDeal({ title: "D3", contact_id: null, updated_at: dstr(-40) }),  // stale + no contact
      mkDeal({ title: "D4", stage: "closed_won", expected_close: "" }),  // closed: excluded
      mkDeal({ title: "D5" }),                                          // clean
    ];
    const tasks = [
      mkTask({ title: "T1", due_date: dday(-1), done: 0 }),  // overdue
      mkTask({ title: "T2", due_date: dday(-1), done: 1 }),  // done: not overdue
      mkTask({ title: "T3", due_date: dday(3), done: 0 }),   // future: not overdue
      mkTask({ title: "T4", due_date: "", done: 0 }),        // no date: not overdue
    ];
    const open = deals.filter((d) => !d.stage.startsWith("closed_"));
    const todayUtc = new Date(NOW).toISOString().slice(0, 10);
    const legacy = {
      noClose: open.filter((d) => !d.expected_close).length,
      noValue: open.filter((d) => !d.value).length,
      stale: open.filter((d) => { const n = daysUntil(d.updated_at.slice(0, 10)); return n !== null && n < -30; }).length,
      noContact: open.filter((d) => !d.contact_id).length,
      overdue: tasks.filter((t) => !t.done && t.due_date && t.due_date < todayUtc).length,
    };
    expect(legacy).toEqual({ noClose: 1, noValue: 1, stale: 1, noContact: 1, overdue: 1 });

    const facts = extractFacts({ deals, tasks, activities: [], stages: stubStages, nowMs: NOW });
    const res = runPlaybook({ rules: STARTER, facts });
    const count = (kind: string): number => {
      const f = res.findings.find((x) => x.kind === kind)!;
      expect(f).toBeDefined();
      return parseInt(f.text, 10);
    };
    expect(count("no_close")).toBe(legacy.noClose);
    expect(count("no_value")).toBe(legacy.noValue);
    expect(count("stale")).toBe(legacy.stale);
    expect(count("no_contact")).toBe(legacy.noContact);
    expect(count("overdue")).toBe(legacy.overdue);
    // R3 orders oldest-first via orderBy
    expect(res.findings.find((x) => x.kind === "stale")!.text).toContain("D3");
  });
});

// ---- storage ----------------------------------------------------------------------

describe("storage", () => {
  test("seeds the starter set on first init", () => {
    const rules = listRules();
    expect(rules.length).toBeGreaterThanOrEqual(11);
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8a", "R8b", "R9", "R10"]) {
      expect(rules.some((r) => r.id === id)).toBe(true);
    }
    const r1 = getRule("R1")!;
    expect(r1.builtin).toBe(true);
    expect(r1.active).toBe(true);
    expect(r1.salience).toBe(50);
    expect(r1.name).toBe("Deal has no expected close date");
    expect(getRule("NOPE")).toBeUndefined();
  });

  test("setRuleActive toggles; reloadPlaybook preserves the flag", () => {
    expect(setRuleActive("R1", false)).toBe(true);
    expect(getRule("R1")?.active).toBe(false);
    expect(setRuleActive("NOPE", true)).toBe(false); // unknown id

    const { builtins, overrides } = reloadPlaybook();
    expect(builtins).toBeGreaterThanOrEqual(11);
    expect(overrides).toBe(0);
    expect(getRule("R1")?.active).toBe(false); // preserved across reload

    expect(setRuleActive("R1", true)).toBe(true);
    expect(getRule("R1")?.active).toBe(true);
  });

  test("user overrides overlay from MILTON_DATA; malformed JSON is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-user-"));
    const prev = process.env.MILTON_DATA;
    try {
      process.env.MILTON_DATA = dir;
      const r2override = { ...(STARTER.find((r) => r.id === "R2")!), salience: 99, active: false };
      const custom: Rule = {
        id: "RX", name: "Custom rule", when: [dealOpen], then: [{ suggest: "hi from RX" }],
      };
      writeFileSync(join(dir, "playbook.user.json"), JSON.stringify([r2override, custom]));

      const rules = loadRules();
      const r2 = rules.find((r) => r.id === "R2")!;
      expect(r2.salience).toBe(99);
      expect(r2.active).toBe(false); // explicit active in the user file wins
      expect(r2.builtin).toBe(false);
      const rx = rules.find((r) => r.id === "RX")!;
      expect(rx.builtin).toBe(false);
      expect(rx.active).toBe(true); // default when not specified

      // The engine honors the overlay: RX fires, deactivated R2 does not.
      const facts = extractFacts({
        deals: [mkDeal({ title: "ZeroVal", value: 0 })],
        tasks: [], activities: [], stages: stubStages, nowMs: NOW,
      });
      const res = runPlaybook({ rules: loadRules(), facts });
      expect(res.suggestions.some((s) => s.text === "hi from RX")).toBe(true);
      expect(res.findings.some((f) => f.ruleId === "R2")).toBe(false);

      // Malformed JSON: warned + ignored, never crashes.
      writeFileSync(join(dir, "playbook.user.json"), "{ not json");
      expect(loadRules().length).toBeGreaterThanOrEqual(11);
      expect(getRule("R1")?.active).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MILTON_DATA;
      else process.env.MILTON_DATA = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setRuleActive returns false for a user-file-only rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-user-"));
    const prev = process.env.MILTON_DATA;
    try {
      process.env.MILTON_DATA = dir;
      writeFileSync(join(dir, "playbook.user.json"), JSON.stringify([
        { id: "RY", name: "File only", when: [dealOpen], then: [{ suggest: "yo" }] },
      ]));
      expect(getRule("RY")?.builtin).toBe(false);
      expect(setRuleActive("RY", false)).toBe(false); // not in the DB
      expect(getRule("RY")?.active).toBe(true); // unchanged
    } finally {
      if (prev === undefined) delete process.env.MILTON_DATA;
      else process.env.MILTON_DATA = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

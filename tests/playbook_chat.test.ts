// playbook_chat.test.ts — rule engine wired through chat + webhooks.
//
// Covers: (1) hygieneReply runs the five migrated checks through the engine and
// renders byte-identical legacy output; (2) new playbook coverage (quiet deals,
// close-date fantasy, task pile-up) appears in the hygiene reply; (3) show /
// pause / resume / reload playbook intents; (4) event-scoped win follow-through
// (R8a→R8b) on deal.stage_changed webhooks broadcasts a toast via the existing
// SSE channel.
//
// Test-hygiene notes (see ~/AGENTS.md): every store this file touches is
// initialized in its own top-level beforeAll; the fetch stub is installed in
// beforeEach and restored in afterEach; LLM env is scrubbed because llm.test.ts
// sets MILTON_LLM_URL at module scope and runs before this file alphabetically.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, handleWebhookEvent, daysUntil, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initMissLogDb } from "../src/intent_misses";
import { initPlaybookDb, setRuleActive, loadRules } from "../src/playbook";

delete process.env.MILTON_LLM_URL;
delete process.env.MILTON_LLM_MODEL;
delete process.env.MILTON_LLM_KEY;

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initMissLogDb(new Database(":memory:"));
  initPlaybookDb(new Database(":memory:"));
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
  // reset any rule toggles from earlier tests so each test starts from seed
  for (const r of loadRules()) if (!r.active) setRuleActive(r.id, true);
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

function freshSession(id = "pb-chat-test"): Session { return { id, history: [] }; }

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

// ---- legacy hygiene, reimplemented verbatim from the pre-engine brain.ts --------
function legacyHygieneReply(deals: any[], tasks: any[]) {
  const today = new Date().toISOString().slice(0, 10);
  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const findings: { icon: string; text: string; fix?: string }[] = [];
  const noClose = open.filter((d) => !d.expected_close);
  if (noClose.length) findings.push({ icon: "📅", text: `${noClose.length} deal${noClose.length === 1 ? "" : "s"} with no expected close date: ${noClose.slice(0, 4).map((d) => d.title).join(", ")}${noClose.length > 4 ? "…" : ""}`, fix: `Set ${noClose[0].title} close date to …` });
  const noValue = open.filter((d) => !d.value);
  if (noValue.length) findings.push({ icon: "💰", text: `${noValue.length} deal${noValue.length === 1 ? "" : "s"} with no value set: ${noValue.slice(0, 4).map((d) => d.title).join(", ")}${noValue.length > 4 ? "…" : ""}`, fix: `Set ${noValue[0].title} value to …` });
  const stale = open
    .filter((d) => { const n = daysUntil(d.updated_at.slice(0, 10)); return n !== null && n < -30; })
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  if (stale.length) findings.push({ icon: "🕸️", text: `${stale.length} stale deal${stale.length === 1 ? "" : "s"} untouched for 30+ days (oldest first): ${stale.slice(0, 4).map((d) => d.title).join(", ")}${stale.length > 4 ? "…" : ""}` });
  const noContact = open.filter((d) => !d.contact_id);
  if (noContact.length) findings.push({ icon: "👤", text: `${noContact.length} deal${noContact.length === 1 ? "" : "s"} with no contact attached: ${noContact.slice(0, 4).map((d) => d.title).join(", ")}${noContact.length > 4 ? "…" : ""}` });
  const overdue = tasks.filter((t) => !t.done && t.due_date && t.due_date < today);
  if (overdue.length) findings.push({ icon: "⏰", text: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}` });
  if (!findings.length) {
    return { text: "Pipeline is clean — every open deal has a close date, a contact, and recent activity. Nice.", chips: ["Show pipeline", "Morning brief"] };
  }
  const hygieneWidget = {
    kind: "list", title: "Pipeline hygiene", source: "milton:hygiene",
    payload: {
      items: findings.slice(0, 15).map((f) => ({
        text: `${f.icon} ${f.text}`,
        ...(f.fix ? { sub: f.fix } : {}),
      })),
    },
  };
  return {
    text: `Found ${findings.length} thing${findings.length === 1 ? "" : "s"} worth fixing:`,
    cards: [{ kind: "findings", title: "Pipeline hygiene", items: findings }],
    chips: ["Show pipeline", "My tasks"],
    widget: hygieneWidget,
  };
}

// Fixture for the byte-equivalence test: triggers all five legacy checks, none
// of the new rules (no negotiation/proposal stages, no value > 10000, no close
// date within 7 days, fewer than 5 overdue tasks per owner).
function legacyFixture() {
  fx.stages = [
    { slug: "qualification", name: "Qualification", position: 1 },
    { slug: "discovery", name: "Discovery", position: 0 },
  ];
  fx.deals = [
    deal({ id: 1, title: "Acme Website", value: 5000, stage: "qualification", expected_close: "", contact_id: 7, owner: "sam", updated_at: isoDaysAgo(1) }),
    deal({ id: 2, title: "Beta Launch", value: 0, stage: "discovery", expected_close: "2026-12-31", contact_id: null, owner: "sam", updated_at: isoDaysAgo(44) }),
    deal({ id: 3, title: "Gamma Rollout", value: 8000, stage: "qualification", expected_close: "", contact_id: 3, owner: "jo", updated_at: isoDaysAgo(53) }),
    deal({ id: 4, title: "Won Already", value: 9000, stage: "closed_won", expected_close: "", contact_id: null, owner: "sam", updated_at: isoDaysAgo(90) }),
  ];
  fx.tasks = [
    task({ id: 1, title: "Send proposal", deal_id: 1, due_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), done: false, owner: "sam" }),
    task({ id: 2, title: "Old done thing", deal_id: 2, due_date: "2026-01-01", done: true, owner: "sam" }),
  ];
}

describe("hygiene via the rule engine", () => {
  test("byte-identical to the legacy hard-coded checks", async () => {
    legacyFixture();
    const got = await handleMessage(freshSession(), "check hygiene");
    const want = legacyHygieneReply(fx.deals, fx.tasks);
    expect(got.text).toBe(want.text);
    expect(got.cards).toEqual(want.cards);
    expect(got.chips).toEqual(want.chips);
  });

  test("empty CRM reports a clean pipeline", async () => {
    const r = await handleMessage(freshSession(), "pipeline hygiene");
    expect(r.text).toContain("Pipeline is clean");
  });

  test("clean pipeline message preserved", async () => {
    fx.deals = [deal({ id: 1, title: "Tidy Deal", value: 1000, stage: "qualification", expected_close: "2026-12-31", contact_id: 9, updated_at: isoDaysAgo(2) })];
    fx.tasks = [task({ id: 1, title: "Future task", due_date: "2026-12-31", done: false })];
    const r = await handleMessage(freshSession(), "check hygiene");
    expect(r.text).toContain("Pipeline is clean");
  });

  test("new playbook coverage appears: quiet negotiation + close-date fantasy + pile-up", async () => {
    fx.stages = [
      { slug: "negotiation", name: "Negotiation", position: 3 },
      { slug: "qualification", name: "Qualification", position: 1 },
    ];
    const closeSoon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    fx.deals = [
      // quiet in negotiation, no activities at all
      deal({ id: 10, title: "Quiet Corp", value: 9000, stage: "negotiation", expected_close: "2026-12-31", contact_id: 5, updated_at: isoDaysAgo(20) }),
      // closes in 3 days but still in qualification
      deal({ id: 11, title: "Fantasy Inc", value: 4000, stage: "qualification", expected_close: closeSoon, contact_id: 6, updated_at: isoDaysAgo(2) }),
    ];
    fx.tasks = [1, 2, 3, 4, 5].map((i) => task({ id: 100 + i, title: `Overdue ${i}`, due_date: past, done: false, owner: "sam" }));
    const r = await handleMessage(freshSession(), "check hygiene");
    const cardText = JSON.stringify(r.cards);
    expect(cardText).toContain("is quiet in negotiation");
    expect(cardText).toContain("closes in 3d but is still in qualification");
    expect(r.chips).toContain("Plan my day");
  });

  test("high-value stall fires via dwell chaining", async () => {
    fx.stages = [{ slug: "negotiation", name: "Negotiation", position: 3 }];
    fx.deals = [
      deal({ id: 20, title: "Big Stall", value: 20000, stage: "negotiation", expected_close: "2026-12-31", contact_id: 5, updated_at: isoDaysAgo(30) }),
      deal({ id: 21, title: "Fresh A", value: 1000, stage: "negotiation", expected_close: "2026-12-31", contact_id: 5, updated_at: isoDaysAgo(2) }),
      deal({ id: 22, title: "Fresh B", value: 1000, stage: "negotiation", expected_close: "2026-12-31", contact_id: 5, updated_at: isoDaysAgo(2) }),
    ];
    const r = await handleMessage(freshSession(), "check hygiene");
    expect(JSON.stringify(r.cards)).toContain("2× past median dwell");
  });
});

describe("playbook chat intents", () => {
  test("show playbook lists the starter rules", async () => {
    const r = await handleMessage(freshSession(), "show playbook");
    expect(r.text).toContain("**R1**");
    expect(r.text).toContain("Quiet negotiation");
    expect(r.text).toContain("salience 85");
    expect(r.text).toContain("Playbook rules (11)");
  });

  test("pause and resume a rule (case-insensitive id)", async () => {
    legacyFixture();
    let r = await handleMessage(freshSession(), "pause rule r3");
    expect(r.text).toContain("Paused rule **R3**");
    const quiet = await handleMessage(freshSession(), "check hygiene");
    expect(JSON.stringify(quiet.cards)).not.toContain("untouched for 30+ days");
    // the other four checks still fire
    expect(quiet.text).toBe("Found 4 things worth fixing:");
    r = await handleMessage(freshSession(), "resume rule R3");
    expect(r.text).toContain("Resumed rule **R3**");
    const back = await handleMessage(freshSession(), "check hygiene");
    expect(back.text).toBe("Found 5 things worth fixing:");
  });

  test("pausing twice is idempotent; unknown id is explained", async () => {
    await handleMessage(freshSession(), "pause rule R4");
    const r = await handleMessage(freshSession(), "pause rule R4");
    expect(r.text).toMatch(/already paused/i);
    const u = await handleMessage(freshSession(), "pause rule R99");
    expect(u.text).toContain('No rule "r99"');
  });

  test("reload playbook reports counts and preserves flags", async () => {
    await handleMessage(freshSession(), "pause rule R2");
    const r = await handleMessage(freshSession(), "reload playbook");
    expect(r.text).toContain("**11** built-in rules");
    expect(r.text).toMatch(/paused\/active flags were kept/i);
    expect(loadRules().find((x) => x.id === "R2")!.active).toBe(false);
    // and R2 stays paused in hygiene output
    legacyFixture();
    const h = await handleMessage(freshSession(), "check hygiene");
    expect(h.text).toBe("Found 4 things worth fixing:");
    expect(JSON.stringify(h.cards)).not.toContain("no value set");
  });
});

describe("webhook event rules (win follow-through)", () => {
  test("deal.stage_changed to closed_won broadcasts the R8b suggestion", async () => {
    const seen: string[] = [];
    const sink = { enqueue(c: Uint8Array) { seen.push(new TextDecoder().decode(c)); } };
    auto.sseAdd(sink as any);
    try {
      await handleWebhookEvent("deal.stage_changed", {
        deal_id: 42, deal_title: "Acme Website", stage_from: "negotiation", stage_to: "closed_won",
      });
    } finally {
      auto.sseRemove(sink as any);
    }
    const joined = seen.join("\n");
    expect(joined).toContain("automation-run");
    expect(joined).toContain("Acme Website");
    expect(joined).toContain("ask for a referral");
  });

  test("a lost deal does not trigger the win playbook", async () => {
    const seen: string[] = [];
    const sink = { enqueue(c: Uint8Array) { seen.push(new TextDecoder().decode(c)); } };
    auto.sseAdd(sink as any);
    try {
      await handleWebhookEvent("deal.stage_changed", {
        deal_id: 43, deal_title: "Lost Corp", stage_from: "negotiation", stage_to: "closed_lost",
      });
    } finally {
      auto.sseRemove(sink as any);
    }
    expect(seen.join("\n")).not.toContain("ask for a referral");
  });

  test("unrelated events never touch the playbook path", async () => {
    const seen: string[] = [];
    const sink = { enqueue(c: Uint8Array) { seen.push(new TextDecoder().decode(c)); } };
    auto.sseAdd(sink as any);
    try {
      const res = await handleWebhookEvent("task.created", { task_id: 7, task_title: "Call back" });
      expect(res.matched).toBe(0);
    } finally {
      auto.sseRemove(sink as any);
    }
    expect(seen.length).toBe(0);
  });
});

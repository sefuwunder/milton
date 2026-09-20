// tests/tutorial.test.ts — interactive tutorial mode: lesson engine, controls,
// fuzzy entry, off-script behavior, graduation, persistence, real-command audit.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import { parseIntent } from "../src/intents";
import { parseIntentFuzzy } from "../src/fuzzy";
import {
  TUTORIAL_STEPS, tutorialControl, tutorialFollowup, renderStep, graduationText,
  type TutorialState,
} from "../src/tutorial";
import * as auto from "../src/automation";
import * as chats from "../src/chat_sessions";
import { initDealNotesDb } from "../src/deal_notes";

const N = TUTORIAL_STEPS.length; // 13

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE uploads (id TEXT PRIMARY KEY, session TEXT NOT NULL, filename TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE session_workspaces (session_id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL,
    workspace_name TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    text TEXT NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')), fired_at TEXT);`);
  chats.initChatSessionDb(db);
});

const BASE = "http://localhost:3001";
const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-09-25", owner: "", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, campaign_id: 1, company_name: "Acme", value: 20000, stage: "negotiation", probability: 80, expected_close: "", owner: "", created_at: "2026-09-05", updated_at: "2026-08-01" },
];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init: any = {}): Promise<Response> => {
  const url = String(input);
  if (!url.startsWith(BASE)) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace(BASE, "").split("?")[0];
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (method === "GET" && path === "/api/kpis") return ok({ pipeline_value: 70000, open_deals: 2, win_rate: 50 });
  if (method === "GET" && path === "/api/deals") return ok({ deals: stubDeals });
  if (method === "GET" && path === "/api/deals/1/history") return ok({ history: [] });
  if (method === "GET" && path === "/api/campaigns") return ok({ campaigns: [{ id: 1, name: "Q4 Push" }] });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: [] });
  if (method === "GET" && path === "/api/stages") return ok({ stages: [] });
  if (method === "GET" && path === "/api/workspaces") return ok({ workspaces: [] });
  if (method === "GET" && path === "/api/custom-fields") return ok({ fields: [] });
  if (method === "POST" && path === "/api/milton/widgets") {
    let body: any; try { body = JSON.parse(init.body); } catch { body = {}; }
    return ok({ widget: { id: 1, ...body, created_at: Date.now() } }, 201);
  }
  return ok({});
};

function freshSession(): Session { return { id: "tutorial-test", history: [] }; }

// ---- exact control parsing ---------------------------------------------------
describe("tutorial control parsing (exact)", () => {
  const cases: [string, string][] = [
    ["tutorial", "start"], ["start tutorial", "start"], ["teach me milton", "start"],
    ["restart tutorial", "restart"], ["tutorial status", "status"], ["tutorial progress", "status"],
    ["skip", "skip"], ["next", "skip"], ["skip this step", "skip"],
    ["back", "back"], ["go back", "back"], ["previous step", "back"],
    ["exit tutorial", "exit"], ["quit tutorial", "exit"], ["stop tutorial", "exit"],
    ["leave tutorial", "exit"], ["quit", "exit"], ["exit", "exit"],
  ];
  for (const [cmd, action] of cases) {
    test(`"${cmd}" → tutorial/${action}`, () => {
      const i = parseIntent(cmd);
      expect(i.name).toBe("tutorial");
      expect(i.slots.action).toBe(action);
    });
  }
});

// ---- fuzzy entry -------------------------------------------------------------
describe("tutorial fuzzy entry", () => {
  const cases: [string, string][] = [
    ["start the tutorial", "start"], ["begin the tutorial", "start"],
    ["walk me through milton", "start"], ["teach me how to use this", "start"],
    ["show me around", "start"], ["exit the tutorial", "exit"],
    ["skip the tutorial step", "skip"], ["move to the next step", "skip"],
    ["go back a step", "back"], ["restart the tutorial", "restart"],
    ["how is my tutorial going", "status"],
  ];
  for (const [cmd, action] of cases) {
    test(`"${cmd}" → tutorial/${action}`, () => {
      const i = parseIntentFuzzy(cmd);
      expect(i.name).toBe("tutorial");
      expect(i.slots.action).toBe(action);
    });
  }
  test("chatter veto: 'tell me a joke about crm' stays unknown (pre-existing)", () => {
    expect(parseIntentFuzzy("tell me a joke about crm").name).toBe("unknown");
  });
  test("tutorial matcher does not claim chatter", () => {
    const i = parseIntentFuzzy("teach me a joke");
    expect(i.name).not.toBe("tutorial");
  });
});

// ---- real-command audit: every tryThis parses to an expected intent ----------
describe("real-command audit", () => {
  test("every step tryThis parses (exact+fuzzy) to one of its expectIntents", () => {
    for (const s of TUTORIAL_STEPS) {
      const i = parseIntentFuzzy(s.tryThis);
      expect(s.expectIntents, `step "${s.id}" tryThis "${s.tryThis}"`).toContain(i.name);
    }
  });
  test("lesson arc covers the required progression", () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(ids).toEqual([
      "reads", "wizards", "followups", "writes", "undo", "typos", "sessions",
      "fields", "meridian", "stages", "analysis", "widgets", "automations",
    ]);
  });
  test("every step has a unique id and a non-empty hint", () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of TUTORIAL_STEPS) {
      expect(s.hint.trim().length, s.id).toBeGreaterThan(0);
      expect(s.explain.trim().length, s.id).toBeGreaterThan(0);
    }
  });
});

// ---- engine: controls ----------------------------------------------------------
describe("tutorial controls via chat", () => {
  test("enter → step 1 rendered", async () => {
    const s = freshSession();
    const r = await handleMessage(s, "tutorial");
    expect(s.tutorial).toMatchObject({ active: true, step: 0 });
    expect(r.text).toContain(`step 1 of ${N}`);
    expect(r.text).toContain("show my top deals");
  });
  test("paraphrased step-1 command advances (fuzzy counts)", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    const r = await handleMessage(s, "what are my biggest deals"); // fuzzy → top_deals
    expect(s.tutorial).toMatchObject({ active: true, step: 1 });
    expect(r.text).toContain(`step 2 of ${N}`);
    expect(r.text).toContain("Guided creating");
  });
  test("skip / back / status / exit", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    let r = await handleMessage(s, "skip");
    expect(s.tutorial!.step).toBe(1);
    expect(r.text).toContain(`step 2 of ${N}`);
    r = await handleMessage(s, "back");
    expect(s.tutorial!.step).toBe(0);
    expect(r.text).toContain(`step 1 of ${N}`);
    r = await handleMessage(s, "tutorial status");
    expect(r.text).toContain(`step 1 of ${N}`);
    r = await handleMessage(s, "exit tutorial");
    expect(s.tutorial).toMatchObject({ active: false, step: 0 });
    expect(r.text).toMatch(/Paused.*progress is kept/);
  });
  test("re-enter resumes where you left off", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "skip"); // step 2
    await handleMessage(s, "exit tutorial");
    const r = await handleMessage(s, "tutorial");
    expect(s.tutorial).toMatchObject({ active: true, step: 1 });
    expect(r.text).toContain(`step 2 of ${N}`);
  });
  test("restart starts over", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "skip");
    const r = await handleMessage(s, "restart tutorial");
    expect(s.tutorial).toMatchObject({ active: true, step: 0 });
    expect(r.text).toContain(`step 1 of ${N}`);
  });
  test("controls outside tutorial get a nudge, not a trap", async () => {
    const s = freshSession();
    const r = await handleMessage(s, "skip");
    expect(r.text).toContain("no tutorial running");
    expect(s.tutorial?.active).not.toBe(true);
  });
});

// ---- engine: off-script commands ----------------------------------------------
describe("off-script behavior", () => {
  test("off-script command runs normally, mode stays, step re-offered", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "what are my biggest deals"); // step 1 done, now on step 2 (wizards)
    const r = await handleMessage(s, "kpis");
    expect(r.text).toContain("Here's how the business looks right now"); // normal KPI reply intact
    expect(s.tutorial).toMatchObject({ active: true, step: 1 }); // not advanced, not broken
    expect(r.text).toContain("Still on tutorial step 2");
    expect(r.text).toContain("new deal");
  });
  test("unknown input mid-tutorial gets the re-offer too", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    const r = await handleMessage(s, "blorptastic wombats");
    expect(s.tutorial).toMatchObject({ active: true, step: 0 });
    expect(r.text).toContain("Still on tutorial step 1");
  });
});

// ---- engine: persistence --------------------------------------------------------
describe("progress persistence", () => {
  test("TutorialState survives a JSON round-trip (SQLite shape)", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "top deals");
    const saved = JSON.parse(JSON.stringify({ tutorial: s.tutorial }));
    const s2 = freshSession();
    s2.tutorial = saved.tutorial;
    const r = await handleMessage(s2, "tutorial");
    expect(s2.tutorial).toMatchObject({ active: true, step: 1 });
    expect(r.text).toContain(`step 2 of ${N}`);
  });
  test("progress is per named-chat session, not global", async () => {
    const a: Session = { id: "sess-a", history: [] };
    const b: Session = { id: "sess-b", history: [] };
    await handleMessage(a, "tutorial");
    await handleMessage(a, "top deals");
    await handleMessage(a, "new deal");
    await handleMessage(a, "cancel");
    expect(a.tutorial).toMatchObject({ active: true, step: 2 });
    await handleMessage(b, "tutorial");
    expect(b.tutorial).toMatchObject({ active: true, step: 0 });
    // advancing b does not move a
    await handleMessage(b, "top deals");
    expect(b.tutorial).toMatchObject({ step: 1 });
    expect(a.tutorial).toMatchObject({ step: 2 });
  });
});

// ---- engine: full walk to graduation --------------------------------------------
describe("graduation walk", () => {
  test("all thirteen steps → graduation summary", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "top deals");                                   // 1 reads
    expect(s.tutorial).toMatchObject({ active: true, step: 1 });
    await handleMessage(s, "new deal");                                    // 2 wizards (wizard opens)
    expect(s.tutorial).toMatchObject({ active: true, step: 2 });
    await handleMessage(s, "cancel");                                      // leave the wizard; tutorial unaffected
    await handleMessage(s, "deal journey Acme Website");                   // 3 followups
    expect(s.tutorial).toMatchObject({ active: true, step: 3 });
    await handleMessage(s, "note on Acme Website: called today");          // 4 writes
    expect(s.tutorial).toMatchObject({ active: true, step: 4 });
    await handleMessage(s, "undo");                                        // 5 undo
    expect(s.tutorial).toMatchObject({ active: true, step: 5 });
    await handleMessage(s, "show my top daels");                           // 6 typos (fuzzy)
    expect(s.tutorial).toMatchObject({ active: true, step: 6 });
    await handleMessage(s, "sessions");                                    // 7 sessions
    expect(s.tutorial).toMatchObject({ active: true, step: 7 });
    await handleMessage(s, "list custom fields for contacts");             // 8 fields
    expect(s.tutorial).toMatchObject({ active: true, step: 8 });
    const mr = await handleMessage(s, "meridian recons");                  // 9 meridian (down → graceful)
    expect(s.tutorial).toMatchObject({ active: true, step: 9 });
    expect(mr.text).toMatch(/meridian/i);
    await handleMessage(s, "list stages");                                 // 10 stages
    expect(s.tutorial).toMatchObject({ active: true, step: 10 });
    await handleMessage(s, "campaign stats");                              // 11 analysis
    expect(s.tutorial).toMatchObject({ active: true, step: 11 });
    await handleMessage(s, "pin this as a widget");                        // 12 widgets
    expect(s.tutorial).toMatchObject({ active: true, step: 12 });
    const r = await handleMessage(s, "list routines");                     // 13 automations
    expect(s.tutorial).toMatchObject({ active: false, step: N, done: true });
    expect(r.text).toContain("Tutorial complete");
    expect(r.text).toContain("pin this as a widget");
    expect(r.text).toContain("meridian recons");
  });
  test("graduated state: tutorial offers restart", async () => {
    const s: Session = { id: "t", history: [], tutorial: { active: false, step: N, done: true } };
    const r = await handleMessage(s, "tutorial");
    expect(r.text).toContain("already finished");
  });
});

// ---- new-lesson spot checks ------------------------------------------------------
describe("new lesson spot checks", () => {
  test("wizard lesson: 'cancel' clears the wizard without breaking the tutorial", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    await handleMessage(s, "top deals");
    const r = await handleMessage(s, "new deal");
    expect(s.tutorial).toMatchObject({ step: 2 });
    expect(r.text).toContain(`step 3 of ${N}`);
    const c = await handleMessage(s, "cancel");
    expect(c.text).toContain("Wizard cancelled");
    expect(s.tutorial).toMatchObject({ active: true, step: 2 }); // tutorial untouched
  });
  test("undo lesson advances even with nothing to undo", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    for (let i = 0; i < 4; i++) await handleMessage(s, "skip"); // land on undo (step 5)
    expect(s.tutorial).toMatchObject({ step: 4 });
    const r = await handleMessage(s, "undo");
    expect(r.text).toContain("Nothing to undo");
    expect(s.tutorial).toMatchObject({ active: true, step: 5 });
  });
  test("typo lesson advances on the fuzzy intent", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    for (let i = 0; i < 5; i++) await handleMessage(s, "skip"); // land on typos (step 6)
    const r = await handleMessage(s, "show my top daels");
    expect(s.tutorial).toMatchObject({ active: true, step: 6 });
    expect(r.text).toContain("Named chat sessions"); // next step rendered after the ack
  });
  test("meridian lesson: unreachable Meridian still advances the step", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    for (let i = 0; i < 8; i++) await handleMessage(s, "skip"); // land on meridian (step 9)
    const r = await handleMessage(s, "meridian recons");
    expect(s.tutorial).toMatchObject({ active: true, step: 9 });
    expect(r.text).toMatch(/can't reach meridian/i);
  });
  test("sessions lesson lists chat sessions", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    for (let i = 0; i < 6; i++) await handleMessage(s, "skip"); // land on sessions (step 7)
    const r = await handleMessage(s, "sessions");
    expect(s.tutorial).toMatchObject({ active: true, step: 7 });
    expect(r.text).toMatch(/chat session/i);
  });
  test("fields lesson: empty custom fields still advances", async () => {
    const s = freshSession();
    await handleMessage(s, "tutorial");
    for (let i = 0; i < 7; i++) await handleMessage(s, "skip"); // land on fields (step 8)
    const r = await handleMessage(s, "list custom fields for contacts");
    expect(s.tutorial).toMatchObject({ active: true, step: 8 });
    expect(r.text).toMatch(/no custom fields/i);
  });
});

// ---- unit: engine functions ------------------------------------------------------
describe("engine units", () => {
  test("renderStep formats all steps without throwing", () => {
    for (let i = 0; i < TUTORIAL_STEPS.length; i++) {
      const t = renderStep(i);
      expect(t).toContain(`step ${i + 1} of ${TUTORIAL_STEPS.length}`);
      expect(t).toContain(TUTORIAL_STEPS[i].tryThis);
    }
  });
  test("tutorialFollowup is a no-op when inactive", () => {
    const st: TutorialState = { active: false, step: 0 };
    const f = tutorialFollowup(st, "kpis", "hello", ["x"]);
    expect(f.text).toBe("hello");
    expect(f.chips).toEqual(["x"]);
  });
  test("tutorialControl start on finished state offers restart", () => {
    const st: TutorialState = { active: false, step: N, done: true };
    const r = tutorialControl(st, "start");
    expect(r.text).toContain("restart tutorial");
  });
  test("graduationText names every layer", () => {
    const g = graduationText();
    for (const w of ["Reading", "Creating", "Follow-ups", "Managing", "Forgiving input", "Sessions", "Structure", "Outside world", "Analysis & widgets", "Automations", "restart tutorial"]) {
      expect(g).toContain(w);
    }
  });
});

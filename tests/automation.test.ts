// automation.test.ts — routines, schedules, triggers, webhook, and the scheduler.
// Pure-logic tests use an isolated :memory: automation DB; the webhook tests use
// a live server booted from ../src/server.ts (shared module — do NOT stop it here,
// upload.test.ts reuses it and stops it in its own afterAll).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent } from "../src/intents";
import * as auto from "../src/automation";
import { handleMessage, tickAutomation, runRoutineUnattended, type Session } from "../src/brain";

// ---- isolated automation DB for the logic tests ---------------------------------
beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
});

// ---- stub exec-crm ---------------------------------------------------------------
const calls: { method: string; path: string; body?: any }[] = [];
const realFetch = globalThis.fetch.bind(globalThis);

const stubDeals = [
  { id: 1, title: "Acme Website", company_id: 1, contact_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 50000, stage: "proposal", probability: 60, expected_close: "2026-09-25", owner: "", created_at: "2026-09-01", updated_at: "2026-09-18" },
  { id: 2, title: "Acme Retainer", company_id: 1, contact_id: 1, company_name: "Acme", contact_name: "Jane Doe", value: 20000, stage: "negotiation", probability: 80, expected_close: "", owner: "", created_at: "2026-09-05", updated_at: "2026-08-01" },
  { id: 3, title: "Globex Audit", company_id: 2, contact_id: null, company_name: "Globex", contact_name: null, value: 120000, stage: "qualification", probability: 30, expected_close: "2026-10-15", owner: "", created_at: "2026-09-10", updated_at: "2026-08-01" },
];

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const path = url.replace("http://localhost:3001", "");
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path, body });
  const ok = (data: any, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (method === "GET" && path === "/api/kpis") return ok({ pipeline_value: 190000, open_deals: 3, win_rate: 42 });
  if (method === "GET" && path === "/api/deals") return ok({ deals: stubDeals });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: [] });
  if (method === "GET" && path === "/api/contacts") return ok({ contacts: [] });
  if (method === "GET" && path === "/api/companies") return ok({ companies: [] });
  if (method === "GET" && path === "/api/activities") return ok({ activities: [] });
  if (method === "GET" && path === "/api/webhooks") return ok({ webhooks: [] });
  if (method === "GET" && path === "/api/hooks") return ok({ hooks: [] });
  if (method === "GET" && path === "/api/deliveries") return ok({ deliveries: [] });
  const dealPatch = path.match(/^\/api\/deals\/(\d+)$/);
  if (dealPatch && method === "PATCH") return ok({ deal: { ...stubDeals.find((x) => x.id === Number(dealPatch[1])), ...body } });
  if (dealPatch && method === "DELETE") return ok({ ok: true });
  return ok({});
}

beforeAll(() => { (globalThis as any).fetch = stubFetch; });

const sess = (): Session => ({ id: "auto-test", history: [], notes: [] });

// ---- intent parsing ----------------------------------------------------------------
describe("automation intents", () => {
  test("save routine", () => {
    const i = parseIntent("save routine EOD: my tasks; pipeline hygiene");
    expect(i.name).toBe("save_routine");
    expect(i.slots.name).toBe("eod");
    expect(i.slots.steps).toBe("my tasks; pipeline hygiene");
  });
  test("run routine", () => {
    expect(parseIntent("run EOD").name).toBe("run_routine");
    expect(parseIntent("run EOD").slots.name).toBe("eod");
  });
  test("list/show routines", () => {
    expect(parseIntent("list routines").name).toBe("list_routines");
    expect(parseIntent("routines").name).toBe("list_routines");
  });
  test("delete routine beats delete_task", () => {
    const i = parseIntent("delete routine EOD");
    expect(i.name).toBe("delete_routine");
    expect(i.slots.name).toBe("eod");
  });
  test("show routine", () => {
    expect(parseIntent("show routine EOD").slots.name).toBe("eod");
  });
  test("schedule parsing beats morning-brief matcher", () => {
    const i = parseIntent("schedule morning brief every weekday at 8am");
    expect(i.name).toBe("schedule_add");
    expect(i.slots.routine).toBe("morning brief");
    expect(i.slots.when).toBe("every weekday at 8am");
  });
  test("schedule variants", () => {
    expect(parseIntent("schedule EOD daily at 6pm").slots.when).toBe("daily at 6pm");
    expect(parseIntent("schedule EOD every monday at 9am").slots.when).toBe("every monday at 9am");
    expect(parseIntent("schedule EOD every 2 hours").slots.when).toBe("every 2 hours");
  });
  test("unschedule / pause / resume", () => {
    expect(parseIntent("unschedule 3").name).toBe("unschedule");
    expect(parseIntent("pause schedule 3").name).toBe("pause_schedule");
    expect(parseIntent("resume schedule EOD").slots.ref).toBe("eod");
  });
  test("trigger add", () => {
    const i = parseIntent("when deal won run celebrate");
    expect(i.name).toBe("trigger_add");
    expect(i.slots.event).toBe("deal won");
    expect(i.slots.routine).toBe("celebrate");
  });
  test("trigger help / list / delete", () => {
    expect(parseIntent("trigger help").name).toBe("trigger_help");
    expect(parseIntent("list triggers").name).toBe("list_triggers");
    expect(parseIntent("delete trigger 4").slots.id).toBe("4");
  });
  test("list runs", () => {
    expect(parseIntent("automation runs").name).toBe("list_runs");
  });
});

// ---- schedule spec parser ------------------------------------------------------------
describe("parseScheduleSpec", () => {
  test("daily", () => {
    expect(auto.parseScheduleSpec("daily at 6pm")).toEqual({ type: "daily", hour: 18, minute: 0 });
    expect(auto.parseScheduleSpec("daily at 8:30am")).toEqual({ type: "daily", hour: 8, minute: 30 });
    expect(auto.parseScheduleSpec("daily at 14:05")).toEqual({ type: "daily", hour: 14, minute: 5 });
  });
  test("weekday", () => {
    expect(auto.parseScheduleSpec("every weekday at 8am")).toEqual({ type: "weekday", hour: 8, minute: 0 });
  });
  test("named day", () => {
    expect(auto.parseScheduleSpec("every monday at 9am")).toEqual({ type: "weekly", day: 1, hour: 9, minute: 0 });
    expect(auto.parseScheduleSpec("every sunday at 11:15pm")).toEqual({ type: "weekly", day: 0, hour: 23, minute: 15 });
  });
  test("interval", () => {
    expect(auto.parseScheduleSpec("every 2 hours")).toEqual({ type: "interval", everyMs: 7200000 });
    expect(auto.parseScheduleSpec("every 30 minutes")).toEqual({ type: "interval", everyMs: 1800000 });
    expect(auto.parseScheduleSpec("every 1 hour")).toEqual({ type: "interval", everyMs: 3600000 });
  });
  test("rejects junk", () => {
    expect(auto.parseScheduleSpec("sometime never")).toBeNull();
    expect(auto.parseScheduleSpec("daily at 25pm")).toBeNull();
    expect(auto.parseScheduleSpec("every 0 hours")).toBeNull();
  });
  test("specText round-trips", () => {
    expect(auto.specText({ type: "daily", hour: 18, minute: 0 })).toBe("daily at 6:00 PM");
    expect(auto.specText({ type: "weekday", hour: 8, minute: 0 })).toBe("every weekday at 8:00 AM");
    expect(auto.specText({ type: "weekly", day: 1, hour: 9, minute: 0 })).toBe("every Monday at 9:00 AM");
    expect(auto.specText({ type: "interval", everyMs: 7200000 })).toBe("every 2 hours");
  });
});

describe("nextRunAfter", () => {
  // 2026-09-19 is a Saturday (local time components)
  const satNoon = new Date(2026, 8, 19, 12, 0, 0).getTime();
  const friEvening = new Date(2026, 8, 18, 19, 0, 0).getTime();
  const monEarly = new Date(2026, 8, 21, 7, 0, 0).getTime();
  const at = (ms: number) => { const d = new Date(ms); return [d.getDay(), d.getHours(), d.getMinutes()]; };

  test("daily later today", () => {
    expect(at(auto.nextRunAfter({ type: "daily", hour: 18, minute: 0 }, satNoon))).toEqual([6, 18, 0]);
  });
  test("daily rolls to tomorrow", () => {
    const n = auto.nextRunAfter({ type: "daily", hour: 18, minute: 0 }, new Date(2026, 8, 19, 19, 0).getTime());
    const d = new Date(n);
    expect([d.getDate(), d.getHours()]).toEqual([20, 18]);
  });
  test("weekday skips weekend", () => {
    const n = auto.nextRunAfter({ type: "weekday", hour: 8, minute: 0 }, friEvening);
    const d = new Date(n);
    expect([d.getDay(), d.getDate(), d.getHours()]).toEqual([1, 21, 8]); // Monday
  });
  test("weekday same morning", () => {
    expect(at(auto.nextRunAfter({ type: "weekday", hour: 8, minute: 0 }, monEarly))).toEqual([1, 8, 0]);
  });
  test("weekly next monday", () => {
    const n = auto.nextRunAfter({ type: "weekly", day: 1, hour: 9, minute: 0 }, satNoon);
    const d = new Date(n);
    expect([d.getDay(), d.getDate(), d.getHours()]).toEqual([1, 21, 9]);
  });
  test("interval adds duration", () => {
    expect(auto.nextRunAfter({ type: "interval", everyMs: 3600000 }, satNoon)).toBe(satNoon + 3600000);
  });
});

// ---- routines via chat -----------------------------------------------------------------
describe("routines", () => {
  test("save + list + show + delete", async () => {
    let r = await handleMessage(sess(), "save routine EOD: my tasks; kpis");
    expect(r.text).toContain("Saved routine **EOD**");
    expect(r.text).toContain("2 steps");
    r = await handleMessage(sess(), "list routines");
    expect(r.text).toContain("EOD");
    r = await handleMessage(sess(), "show routine eod");
    expect(r.text).toContain("my tasks");
    r = await handleMessage(sess(), "delete routine eod");
    expect(r.text).toContain("Deleted routine");
    r = await handleMessage(sess(), "list routines");
    expect(r.text).toContain("No routines yet");
  });
  test("saveRoutine validates name and steps", () => {
    expect(() => auto.saveRoutine("", ["kpis"])).toThrow();
    expect(() => auto.saveRoutine("!!!", ["kpis"])).toThrow();
    expect(() => auto.saveRoutine("ok", [])).toThrow();
  });
  test("save is case-insensitive unique (update in place)", async () => {
    await handleMessage(sess(), "save routine EOD: my tasks");
    await handleMessage(sess(), "save routine eod: kpis");
    const r = await handleMessage(sess(), "show routine EOD");
    expect(r.text).toContain("kpis");
    expect(r.text).not.toContain("my tasks");
    await handleMessage(sess(), "delete routine eod");
  });
  test("run executes steps in order and combines output", async () => {
    await handleMessage(sess(), "save routine morn: kpis; my tasks");
    const r = await handleMessage(sess(), "run morn");
    expect(r.text).toContain("**morn**");
    expect(r.text).toContain("1. kpis");
    expect(r.text).toContain("2. my tasks");
    expect(r.text).not.toContain("⚠️");
    await handleMessage(sess(), "delete routine morn");
  });
  test("run of unknown routine", async () => {
    const r = await handleMessage(sess(), "run nosuchroutine");
    expect(r.text).toContain('No routine named "nosuchroutine"');
  });
  test("failing step is reported and the rest continue", async () => {
    // "move deal Acme to negotiation" is ambiguous (2 Acme deals) -> skipped, kpis still runs
    await handleMessage(sess(), "save routine amb: move deal Acme to negotiation; kpis");
    const r = await handleMessage(sess(), "run amb");
    expect(r.text).toContain("⚠️");
    expect(r.text).toContain("1. move deal Acme to negotiation");
    expect(JSON.stringify(r.cards)).toContain("Win rate"); // kpis output present
    await handleMessage(sess(), "delete routine amb");
  });
  test("erroring step is marked failed and the rest continue", async () => {
    await handleMessage(sess(), "save routine errdemo: kpis; list routines");
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = () => Promise.reject(new Error("fetch failed"));
    try {
      const r = await handleMessage(sess(), "run errdemo");
      expect(r.text).toContain("1/2 steps ok");
      expect(r.text).toContain("⚠️");
      expect(r.text).toContain("failed: I can't reach exec-crm");
      expect(r.text).toContain("1 routine:"); // list routines still ran
    } finally {
      (globalThis as any).fetch = real;
    }
    await handleMessage(sess(), "delete routine errdemo");
  });
  test("nested routine recursion is guarded", async () => {
    await handleMessage(sess(), "save routine loop: run loop; kpis");
    const r = await handleMessage(sess(), "run loop");
    expect(r.text).toContain("recursive");
    expect(JSON.stringify(r.cards)).toContain("Win rate");
    await handleMessage(sess(), "delete routine loop");
  });
});

// ---- destructive guard -------------------------------------------------------------------
describe("destructive guard", () => {
  test("interactive run asks once up front", async () => {
    await handleMessage(sess(), "save routine cleanup: delete deal Acme Website; my tasks");
    const s = sess();
    const r = await handleMessage(s, "run cleanup");
    expect(r.text).toContain("destructive");
    expect(r.text).toContain("delete deal Acme Website");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await handleMessage(sess(), "delete routine cleanup");
  });
  test("confirming executes the destructive step", async () => {
    await handleMessage(sess(), "save routine cleanup: delete deal Acme Website; my tasks");
    const s = sess();
    await handleMessage(s, "run cleanup");
    calls.length = 0;
    const r = await handleMessage(s, "yes");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/deals/1")).toBe(true);
    expect(r.text).toContain("Deleted deal");
    expect(r.text).toContain("2/2 steps ok");
    await handleMessage(sess(), "delete routine cleanup");
  });
  test("declining cancels without changes", async () => {
    await handleMessage(sess(), "save routine cleanup: delete deal Acme Website");
    const s = sess();
    await handleMessage(s, "run cleanup");
    calls.length = 0;
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await handleMessage(sess(), "delete routine cleanup");
  });
  test("unattended run skips destructive steps with a note", async () => {
    await handleMessage(sess(), "save routine cleanup: delete deal Acme Website; kpis");
    calls.length = 0;
    const run = await runRoutineUnattended("cleanup", "manual", "test");
    expect(run.status).toBe("partial");
    expect(run.summary).toContain("1/2 steps ok");
    expect(run.summary).toContain("skipped: needs confirmation");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await handleMessage(sess(), "delete routine cleanup");
  });
  test("mark-lost counts as destructive", async () => {
    await handleMessage(sess(), "save routine endit: mark Acme Website as lost");
    const r = await handleMessage(sess(), "run endit");
    expect(r.text).toContain("destructive");
    await handleMessage(sess(), "delete routine endit");
  });
});

// ---- schedules via chat + tick ----------------------------------------------------------------
describe("schedules", () => {
  test("schedule add / list / pause / resume / unschedule", async () => {
    await handleMessage(sess(), "save routine eod: kpis");
    let r = await handleMessage(sess(), "schedule eod daily at 6pm");
    expect(r.text).toContain("Scheduled **eod** daily at 6:00 PM");
    r = await handleMessage(sess(), "list schedules");
    expect(r.text).toContain("eod");
    expect(r.text).toContain("daily at 6:00 PM");
    r = await handleMessage(sess(), "pause schedule eod");
    expect(r.text).toContain("Paused");
    r = await handleMessage(sess(), "list schedules");
    expect(r.text).toContain("paused");
    r = await handleMessage(sess(), "resume schedule eod");
    expect(r.text).toContain("Resumed");
    r = await handleMessage(sess(), "unschedule eod");
    expect(r.text).toContain("Removed 1 schedule");
    await handleMessage(sess(), "delete routine eod");
  });
  test("schedule requires an existing routine", async () => {
    const r = await handleMessage(sess(), "schedule ghost daily at 6pm");
    expect(r.text).toContain('No routine named "ghost"');
  });
  test("schedule rejects unparseable when", async () => {
    await handleMessage(sess(), "save routine eod: kpis");
    const r = await handleMessage(sess(), "schedule eod daily at 6pm sometime");
    expect(r.text).toMatch(/not sure|parse/i);
    await handleMessage(sess(), "delete routine eod");
  });
  test("tick runs due schedules, records the run, advances next_run", async () => {
    await handleMessage(sess(), "save routine tickme: kpis");
    const past = Date.now() - 120000;
    const sch = auto.createSchedule("tickme", { type: "interval", everyMs: 60000 }, past);
    expect(sch.next_run).toBeLessThanOrEqual(Date.now());
    const before = auto.listRuns().length;
    await tickAutomation(Date.now());
    const runs = auto.listRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs[0].kind).toBe("schedule");
    expect(runs[0].routine_name).toBe("tickme");
    expect(runs[0].status).toBe("ok");
    const after = auto.getSchedule(sch.id)!;
    expect(after.next_run).toBeGreaterThan(Date.now());
    await handleMessage(sess(), "delete routine tickme");
  });
  test("paused schedules don't fire", async () => {
    await handleMessage(sess(), "save routine tickme: kpis");
    const sch = auto.createSchedule("tickme", { type: "interval", everyMs: 60000 }, Date.now() - 120000);
    auto.setScheduleActive(sch.id, false);
    const before = auto.listRuns().length;
    await tickAutomation(Date.now());
    expect(auto.listRuns().length).toBe(before);
    await handleMessage(sess(), "delete routine tickme");
  });
});

// ---- triggers -------------------------------------------------------------------------------------
describe("triggers", () => {
  test("resolveTriggerEvent aliases and filters", () => {
    expect(auto.resolveTriggerEvent("deal won")).toEqual({ event: "deal.stage_changed", filter: { stage: "closed_won" } });
    expect(auto.resolveTriggerEvent("deal.stage_changed where stage=negotiation"))
      .toEqual({ event: "deal.stage_changed", filter: { stage: "negotiation" } });
    expect(auto.resolveTriggerEvent("task completed")).toEqual({ event: "task.completed", filter: {} });
    expect(auto.resolveTriggerEvent("nope nothing")).toBeNull();
  });
  test("matchTriggers honors event + filter", () => {
    const t = auto.createTrigger("deal.stage_changed", { stage: "closed_won" }, "celebrate");
    expect(auto.matchTriggers("deal.stage_changed", { stage: "closed_won", title: "X" }).map((x) => x.id)).toContain(t.id);
    expect(auto.matchTriggers("deal.stage_changed", { stage: "proposal", title: "X" })).toHaveLength(0);
    expect(auto.matchTriggers("deal.created", { stage: "closed_won" })).toHaveLength(0);
    auto.deleteTrigger(t.id);
  });
  test("chat: add / list / delete trigger, trigger help", async () => {
    await handleMessage(sess(), "save routine celebrate: kpis");
    let r = await handleMessage(sess(), "when deal won run celebrate");
    expect(r.text).toContain("Trigger #");
    expect(r.text).toContain("deal.stage_changed");
    expect(r.text).toContain("closed_won");
    r = await handleMessage(sess(), "list triggers");
    expect(r.text).toContain("deal.stage_changed");
    const id = r.text.match(/#(\d+)/)![1];
    r = await handleMessage(sess(), `delete trigger ${id}`);
    expect(r.text).toContain(`Deleted trigger #${id}`);
    r = await handleMessage(sess(), "trigger help");
    expect(r.text).toContain("deal.created");
    expect(r.text).toContain("task.completed");
    await handleMessage(sess(), "delete routine celebrate");
  });
  test("deleting a routine cascades to its schedules and triggers", async () => {
    await handleMessage(sess(), "save routine tmp: kpis");
    auto.createSchedule("tmp", { type: "interval", everyMs: 60000 }, Date.now());
    auto.createTrigger("deal.created", {}, "tmp");
    const r = await handleMessage(sess(), "delete routine tmp");
    expect(r.text).toContain("1 schedule");
    expect(r.text).toContain("1 trigger");
    expect(auto.listSchedules().filter((s) => s.routine_name === "tmp")).toHaveLength(0);
  });
  test("list runs shows recorded runs", async () => {
    auto.recordRun({ kind: "manual", ref: "t", routine_name: "demo", status: "ok", summary: "2/2 steps ok" });
    const r = await handleMessage(sess(), "automation runs");
    expect(r.text).toContain("demo");
    expect(r.text).toContain("2/2 steps ok");
  });
});

// ---- webhook endpoint (isolated server process) ----------------------------------------------------
// Spawns its own `bun src/server.ts` on a random port so these tests are independent of
// upload.test.ts's shared server module (which stops its server in afterAll).
describe("POST /api/hooks/exec-crm", () => {
  let base = "";
  let proc: any = null;
  const SID = "hook-test-session";
  const dataDir = `/tmp/milton-automation-test-${process.pid}`;

  beforeAll(async () => {
    const root = new URL("../", import.meta.url).pathname;
    proc = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: root,
      env: {
        ...process.env,
        MILTON_DATA: dataDir,
        MILTON_HOOK_SECRET: "test-hook-secret",
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (value) {
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/milton listening on http:\/\/localhost:(\d+)/);
        if (m) { base = `http://localhost:${m[1]}`; break; }
      }
      if (done) break;
    }
    reader.releaseLock();
    if (!base) throw new Error("webhook test server did not start. output: " + buf.slice(-800));
  });

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
  });

  const post = (secret?: string, body: any = {}) =>
    fetch(`${base}/api/hooks/exec-crm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Milton-Secret": secret } : {}) },
      body: JSON.stringify(body),
    });

  const chat = (message: string) =>
    fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SID, message }),
    }).then((r) => r.json());

  test("401 without secret", async () => {
    const res = await post(undefined, { event: "deal.created", data: {} });
    expect(res.status).toBe(401);
  });
  test("401 with wrong secret", async () => {
    const res = await post("wrong", { event: "deal.created", data: {} });
    expect(res.status).toBe(401);
  });
  test("400 with missing event", async () => {
    const res = await post("test-hook-secret", { data: {} });
    expect(res.status).toBe(400);
  });
  test("matching trigger runs the routine and records a run", async () => {
    // "help" is a local reply — the spawned server has no exec-crm to call.
    await chat("save routine celebrate: help");
    await chat("when deal won run celebrate");
    const res = await post("test-hook-secret", {
      event: "deal.stage_changed",
      sent_at: new Date().toISOString(),
      data: { id: 9, title: "Big Deal", stage: "closed_won" },
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.matched).toBe(1);
    const runs: any = await fetch(`${base}/api/automation-runs?limit=5`).then((r) => r.json());
    const run = runs.runs[0];
    expect(run.kind).toBe("trigger");
    expect(run.routine_name).toBe("celebrate");
    expect(run.status).toBe("ok");
    expect(run.summary).toContain("1/1 steps ok");
  });
  test("non-matching filter fires nothing", async () => {
    const before: any = await fetch(`${base}/api/automation-runs?limit=1`).then((r) => r.json());
    const res = await post("test-hook-secret", {
      event: "deal.stage_changed",
      data: { id: 9, title: "Small Deal", stage: "proposal" },
    });
    const j: any = await res.json();
    expect(j.matched).toBe(0);
    const after: any = await fetch(`${base}/api/automation-runs?limit=1`).then((r) => r.json());
    expect(after.runs[0]?.id).toBe(before.runs[0]?.id);
  });
  test("REST: routines/schedules/triggers/runs endpoints", async () => {
    await chat("save routine eod2: kpis");
    let r: any = await fetch(`${base}/api/routines`).then((x) => x.json());
    expect(r.routines.some((x: any) => x.name === "eod2")).toBe(true);
    r = await fetch(`${base}/api/schedules`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routine: "eod2", when: "every 2 hours" }),
    });
    expect(r.status).toBe(201);
    const sch: any = await r.json();
    expect(sch.schedule.spec_text).toBe("every 2 hours");
    r = await fetch(`${base}/api/schedules/${sch.schedule.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect((await r.json()).schedule.active).toBe(0);
    r = await fetch(`${base}/api/triggers`).then((x) => x.json());
    expect(Array.isArray(r.events)).toBe(true);
    expect(r.events).toContain("deal.created");
  });
  test("SSE endpoint streams", async () => {
    const res = await fetch(`${base}/api/events`, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});

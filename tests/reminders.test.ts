// reminders.test.ts — one-shot reminders: time parsing, confirmation-gated
// creation, listing/cancel, and the scheduler sweep (fires exactly once via
// the automation-run SSE path).
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent, parseReminderTime, formatWhen } from "../src/intents";
import * as auto from "../src/automation";
import { handleMessage, tickAutomation, type Session } from "../src/brain";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); });

const sess = (id = "rem-test"): Session => ({ id, history: [], notes: [] });

// ---- time parsing ------------------------------------------------------------------
describe("parseReminderTime", () => {
  const now = new Date(2026, 8, 19, 12, 0, 0).getTime(); // Sat 2026-09-19 12:00 local

  test("relative: in 20 minutes", () => {
    const p = parseReminderTime("to check the oven in 20 minutes", now)!;
    expect(p).not.toBeNull();
    expect(p.fireAt).toBe(now + 20 * 60000);
    expect(p.text).toBe("check the oven");
  });

  test("relative: in 2 hours, time-first phrasing", () => {
    const p = parseReminderTime("in 2 hours to call the dentist", now)!;
    expect(p.fireAt).toBe(now + 2 * 3600000);
    expect(p.text).toBe("call the dentist");
  });

  test("absolute: tomorrow at 9am", () => {
    const p = parseReminderTime("to call sarah tomorrow at 9am", now)!;
    const d = new Date(p.fireAt);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(p.text).toBe("call sarah");
  });

  test("absolute: friday at 2:30pm", () => {
    const p = parseReminderTime("send the proposal friday at 2:30pm", now)!;
    const d = new Date(p.fireAt);
    expect(d.getDay()).toBe(5); // Friday
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
    expect(p.text).toBe("send the proposal");
  });

  test("bare date defaults to 9am", () => {
    const p = parseReminderTime("to water the plants tomorrow", now)!;
    expect(new Date(p.fireAt).getHours()).toBe(9);
    expect(p.text).toBe("water the plants");
  });

  test("no time expression -> null", () => {
    expect(parseReminderTime("to stretch sometime", now)).toBeNull();
    expect(parseReminderTime("", now)).toBeNull();
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 8, 19, 12, 0, 0).getTime();
  test("today / tomorrow / later", () => {
    expect(formatWhen(now + 3600000, now)).toBe("today at 1:00 PM");
    expect(formatWhen(now + 86400000 + 3600000, now)).toBe("tomorrow at 1:00 PM");
    expect(formatWhen(new Date(2026, 8, 25, 14, 30).getTime(), now)).toBe("Fri, Sep 25 at 2:30 PM");
  });
});

// ---- intent routing -----------------------------------------------------------------
describe("reminder intents", () => {
  test("remind me -> remind_add", () => {
    expect(parseIntent("remind me to call Sarah tomorrow at 9am").name).toBe("remind_add");
    expect(parseIntent("remind me in 20 minutes to check the oven").name).toBe("remind_add");
  });
  test("list phrasings -> remind_list", () => {
    for (const t of ["reminders", "list reminders", "my reminders", "show reminders"]) {
      expect(parseIntent(t).name).toBe("remind_list");
    }
  });
  test("cancel phrasings -> remind_cancel with id", () => {
    for (const t of ["cancel reminder 2", "delete reminder 2", "remove reminder 2"]) {
      const i = parseIntent(t);
      expect(i.name).toBe("remind_cancel");
      expect(i.slots.id).toBe("2");
    }
  });
  test("delete reminder does not parse as delete_task", () => {
    expect(parseIntent("delete reminder 2").name).not.toBe("delete_task");
  });
});

// ---- chat flow -----------------------------------------------------------------------
describe("reminder chat flow", () => {
  test("missing time asks when", async () => {
    const r = await handleMessage(sess(), "remind me to stretch");
    expect(r.text).toMatch(/When should I remind you/);
  });

  test("past time is rejected cleanly", async () => {
    const r = await handleMessage(sess(), "remind me to file taxes on 2020-01-01 at 9am");
    expect(r.text).toMatch(/already past/);
  });

  test("list shows pending reminders with numbers", async () => {
    const s = sess("rem-list");
    const r0 = await handleMessage(s, "reminders");
    expect(r0.text).toMatch(/No pending reminders/);
    await handleMessage(s, "remind me in 30 minutes to water the plants");
    await handleMessage(s, "yes");
    const r1 = await handleMessage(s, "reminders");
    expect(r1.text).toMatch(/water the plants/);
    expect(r1.text).toMatch(/1\./);
  });

  test("cancel by number; unknown id; session scoping", async () => {
    const s = sess("rem-cancel");
    await handleMessage(s, "remind me in 30 minutes to take a break");
    await handleMessage(s, "yes");
    const [r] = auto.listReminders(s.id);
    const nope = await handleMessage(s, "cancel reminder 999");
    expect(nope.text).toMatch(/No pending reminder/);
    const other = await handleMessage(sess("rem-other"), `cancel reminder ${r.id}`);
    expect(other.text).toMatch(/No pending reminder/); // another session can't cancel it
    const ok = await handleMessage(s, `cancel reminder ${r.id}`);
    expect(ok.text).toMatch(/Cancelled reminder/);
    expect(auto.listReminders(s.id)).toHaveLength(0);
  });

  test("routine steps needing reminder confirmation are skipped", async () => {
    const s = sess("rem-routine");
    await handleMessage(s, "save routine stretch: remind me in 5 minutes to stretch");
    const r = await handleMessage(s, "run stretch");
    expect(r.text).toMatch(/needs follow-up input/);
    expect(auto.listReminders(s.id)).toHaveLength(0); // never stored without confirmation
  });
});

// ---- scheduler sweep ------------------------------------------------------------------
describe("reminder sweep", () => {
  const seen: string[] = [];
  const sink = { enqueue(c: Uint8Array) { seen.push(new TextDecoder().decode(c)); } };

  afterEach(() => { auto.sseRemove(sink); seen.length = 0; });

  test("due reminder fires once through the automation-run path", async () => {
    const s = sess("rem-sweep");
    auto.createReminder(s.id, "take out the trash", Date.now() - 1000);
    auto.sseAdd(sink);
    await tickAutomation(Date.now());
    const runs = auto.listRuns(50).filter((r) => r.kind === "reminder");
    expect(runs).toHaveLength(1);
    expect(runs[0].summary).toBe("take out the trash");
    expect(runs[0].ref).toMatch(/^reminder:/);
    expect(seen.some((m) => m.includes("automation-run") && m.includes("take out the trash"))).toBe(true);
    // second sweep: never refires
    await tickAutomation(Date.now());
    expect(auto.listRuns(50).filter((r) => r.kind === "reminder")).toHaveLength(1);
    expect(auto.listReminders(s.id)).toHaveLength(0);
  });

  test("future reminders don't fire early", async () => {
    const s = sess("rem-future");
    auto.createReminder(s.id, "not yet", Date.now() + 3600000);
    await tickAutomation(Date.now());
    expect(auto.listRuns(50).filter((r) => r.kind === "reminder" && r.summary === "not yet")).toHaveLength(0);
    expect(auto.listReminders(s.id)).toHaveLength(1);
  });

  test("cancelled reminders never fire", async () => {
    const s = sess("rem-cancelled");
    const r = auto.createReminder(s.id, "never mind", Date.now() - 1000);
    expect(auto.cancelReminder(r.id, s.id)).toBe(true);
    await tickAutomation(Date.now());
    expect(auto.listRuns(50).filter((x) => x.kind === "reminder" && x.summary === "never mind")).toHaveLength(0);
  });
});

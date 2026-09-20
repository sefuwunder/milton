// overdue.test.ts — regression: chat-based overdue lookup must agree with the
// exec-crm widget. The widget (exec-crm public/app.js daily feed) computes
// "today" with local getFullYear/getMonth/getDate; the chat brain used
// Date.toISOString() (UTC), so the two disagreed whenever the UTC date
// differed from the local date. Chat also had no overdue intent at all —
// "overdue tasks" parsed to `unknown`.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, todayStr, type Session } from "../src/brain";
import { parseIntent } from "../src/intents";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); });

const p = (n: number) => String(n).padStart(2, "0");
// Exact copy of the exec-crm widget's toISODate (public/app.js): local day.
const widgetToday = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const shiftLocalDay = (base: Date, off: number) => { const d = new Date(base); d.setDate(d.getDate() + off); return widgetToday(d); };

type Seed = { id: number; title: string; deal_id: null; campaign_id: null; due_date: string; done: number; owner: string; created_at: string };
function seedsFor(ref: Date): Seed[] {
  const t = (id: number, title: string, due_date: string, done: number): Seed =>
    ({ id, title, deal_id: null, campaign_id: null, due_date, done, owner: "", created_at: "" });
  return [
    t(1, "Overdue yesterday", shiftLocalDay(ref, -1), 0),
    t(2, "Due today", shiftLocalDay(ref, 0), 0),
    t(3, "Due tomorrow", shiftLocalDay(ref, 1), 0),
    t(4, "No due date", "", 0),
    t(5, "Done but past due", shiftLocalDay(ref, -2), 1),
  ];
}

// Chat's overdue rule, factored the same way tasksReply applies it.
const chatOverdue = (tasks: Seed[], ref: Date) => {
  const today = todayStr(ref);
  return tasks.filter((t) => !t.done && t.due_date && t.due_date < today).map((t) => t.title).sort();
};
// Widget's overdue rule (exec-crm daily feed): open && due_date < local today.
const widgetOverdue = (tasks: Seed[], ref: Date) => {
  const today = widgetToday(ref);
  return tasks.filter((t) => !t.done && t.due_date && t.due_date < today).map((t) => t.title).sort();
};

// ---- stub exec-crm ----
const realFetch = globalThis.fetch.bind(globalThis);
let liveSeeds: Seed[] = [];
function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const path = url.replace("http://localhost:3001", "");
  const ok = (data: any) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (path === "/api/tasks") return ok({ tasks: liveSeeds });
  if (path === "/api/deals") return ok({ deals: [] });
  return Promise.resolve(new Response("not found", { status: 404 }));
}
beforeAll(() => { (globalThis as any).fetch = stubFetch; });
afterAll(() => { (globalThis as any).fetch = realFetch; });

let __sid = 0;
function freshSession(): Session { return { id: `overdue-test-${++__sid}`, history: [] }; }

describe("overdue intent", () => {
  test("overdue phrasings parse to the tasks intent with the overdue filter", () => {
    for (const q of ["overdue", "overdue tasks", "my overdue tasks", "show overdue", "list overdue tasks", "what's overdue", "what is overdue"]) {
      const it: any = parseIntent(q);
      expect(it.name).toBe("tasks");
      expect(it.slots?.filter).toBe("overdue");
    }
  });

  test("todayStr returns the local calendar day, not UTC", () => {
    const oldTZ = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      // 9pm local Sep 20 EDT = 1am Sep 21 UTC: local and UTC days differ.
      const ref = new Date(2026, 8, 20, 21, 0);
      expect(widgetToday(ref)).toBe("2026-09-20");
      expect(ref.toISOString().slice(0, 10)).toBe("2026-09-21"); // what the old code returned
      expect(todayStr(ref)).toBe("2026-09-20");
    } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
  });

  test("chat and widget overdue sets agree at every hour of the day", () => {
    const oldTZ = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      for (let h = 0; h < 24; h++) {
        const ref = new Date(2026, 8, 20, h, 30); // local hour h on Sep 20
        const seeds = seedsFor(ref);
        expect(chatOverdue(seeds, ref)).toEqual(widgetOverdue(seeds, ref));
        expect(chatOverdue(seeds, ref)).toEqual(["Overdue yesterday"]);
      }
    } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
  });
});

describe("overdue chat reply", () => {
  test("overdue tasks lists exactly the overdue open tasks", async () => {
    liveSeeds = seedsFor(new Date());
    const r = await handleMessage(freshSession(), "overdue tasks");
    expect(r.text).toContain("Overdue tasks");
    const items = r.cards?.[0]?.items || [];
    expect(items.map((t: any) => t.title)).toEqual(["Overdue yesterday"]);
    expect(r.text).not.toContain("Due today");
    expect(r.text).not.toContain("Due tomorrow");
  });

  test("chat reply matches the widget's overdue set on the same seeds", async () => {
    liveSeeds = seedsFor(new Date());
    const r = await handleMessage(freshSession(), "show overdue");
    const chatTitles = ((r.cards?.[0]?.items || []) as any[]).map((t) => t.title).sort();
    expect(chatTitles).toEqual(widgetOverdue(liveSeeds, new Date()));
  });

  test("no overdue tasks reports all-clear", async () => {
    const ref = new Date();
    liveSeeds = seedsFor(ref).filter((t) => t.title !== "Overdue yesterday");
    const r = await handleMessage(freshSession(), "overdue tasks");
    expect(r.text).toContain("No overdue tasks");
  });

  test("my tasks still lists all open tasks (done excluded)", async () => {
    liveSeeds = seedsFor(new Date());
    const r = await handleMessage(freshSession(), "my tasks");
    const items = r.cards?.[0]?.items || [];
    expect(items.map((t: any) => t.title).sort()).toEqual(
      ["Due today", "Due tomorrow", "No due date", "Overdue yesterday"].sort(),
    );
  });
});

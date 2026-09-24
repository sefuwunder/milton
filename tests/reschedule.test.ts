// tests/reschedule.test.ts — group + single task rescheduling:
// "push all tasks from this week to the same time next week" -> confirm ->
// PATCH each task's due_date. Undo restores the old dates.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseIntent } from "../src/intents";

describe("reschedule_tasks intent", () => {
  const cases: [string, Record<string, string>][] = [
    ["push all tasks from this week to the same time next week", { selector: "this_week", shift: "7" }],
    ["move this week's tasks to next week", { selector: "this_week", shift: "7" }],
    ["push all overdue tasks to next monday", { selector: "overdue", shift: "" }],
    ["defer today's tasks by 3 days", { selector: "today", shift: "3" }],
    ["bump tomorrow's tasks to next friday", { selector: "tomorrow", shift: "" }],
    ["reschedule task Call Acme to friday", { selector: "single", task: "call acme", shift: "" }],
    ["postpone my overdue tasks by 2 weeks", { selector: "overdue", shift: "14" }],
    ["push all overdue tasks by friday", { selector: "overdue", shift: "" }],
    ["shift all the tasks due this week to 2026-10-15", { selector: "this_week", date: "2026-10-15" }],
  ];
  for (const [text, want] of cases) {
    test(`parses "${text}"`, () => {
      const i = parseIntent(text);
      expect(i.name).toBe("reschedule_tasks");
      for (const [k, v] of Object.entries(want)) expect(i.slots[k]).toBe(v);
      if (want.shift === "") expect(i.slots.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  }
  test("does not steal move_deal / move_stage / add_task", () => {
    expect(parseIntent("move Acme deal to negotiation").name).toBe("move_deal");
    expect(parseIntent("move stage Proposal before Negotiation").name).toBe("move_stage");
    expect(parseIntent("add task Call Acme tomorrow").name).toBe("add_task");
    expect(parseIntent("push the launch").name).not.toBe("reschedule_tasks");
  });
});

// ---- end-to-end: chat -> confirm -> PATCH -> undo, against a stub exec-crm ----
const root = new URL("..", import.meta.url).pathname;

function mondayOfThisWeek(): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return fmt(x); };

const MON = mondayOfThisWeek();
let tasks = [
  { id: 1, title: "Call Acme", due_date: plus(MON, 1), done: false },   // this week
  { id: 2, title: "Send deck", due_date: plus(MON, 3), done: false },   // this week
  { id: 3, title: "Old follow-up", due_date: "2026-01-05", done: false }, // overdue
  { id: 4, title: "Done thing", due_date: plus(MON, 2), done: true },    // done -> excluded
  { id: 5, title: "Undated", due_date: "", done: false },
];
const patches: { id: number; due_date: string }[] = [];

const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/tasks" && req.method === "GET") return Response.json({ tasks });
    const pm = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (pm && req.method === "PATCH") {
      const body: any = await req.json();
      const t = tasks.find((x) => x.id === Number(pm[1]));
      if (!t) return Response.json({ error: "not found" }, { status: 404 });
      t.due_date = body.due_date;
      patches.push({ id: t.id, due_date: body.due_date });
      return Response.json({ task: t });
    }
    return Response.json({});
  },
});

let dir = "";
let proc: any = null;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "milton-resched-"));
  proc = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: root,
    env: { ...process.env, MILTON_DATA: dir, PORT: "0", EXEC_CRM_URL: `http://localhost:${stub.port}` },
    stdout: "pipe", stderr: "pipe",
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
  if (!base) throw new Error("reschedule test server did not start: " + buf.slice(-800));
});

afterAll(async () => {
  try { proc?.kill(); } catch {}
  stub.stop();
  await rm(dir, { recursive: true, force: true });
});

async function chat(session: string, message: string): Promise<any> {
  const r = await fetch(base + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, message }),
  });
  return r.json();
}

describe("chat end-to-end", () => {
  test("group shift asks for confirmation, then moves on yes", async () => {
    const ask: any = await chat("rs1", "push all tasks from this week to the same time next week");
    expect(ask.text).toMatch(/Move these 2 tasks due this week\?/);
    expect(ask.text).toContain("Call Acme");
    expect(ask.text).toContain("Send deck");
    expect(ask.text).not.toContain("Old follow-up");
    expect(ask.text).not.toContain("Done thing");
    // each task shifts +7 from its own due date (same time next week)
    expect(ask.text).toContain(plus(MON, 8));
    expect(ask.text).toContain(plus(MON, 10));
    expect(patches.length).toBe(0); // nothing moved before confirmation

    const go: any = await chat("rs1", "yes");
    expect(go.text).toMatch(/✅ Moved 2 tasks/);
    expect(patches).toEqual([
      { id: 1, due_date: plus(MON, 8) },
      { id: 2, due_date: plus(MON, 10) },
    ]);
  });

  test("undo restores the old due dates", async () => {
    const u: any = await chat("rs1", "undo");
    expect(u.text).toMatch(/Undid/);
    expect(patches.slice(2)).toEqual([
      { id: 1, due_date: plus(MON, 1) },
      { id: 2, due_date: plus(MON, 3) },
    ]);
  });

  test("no cancels without moving", async () => {
    // Call Acme (due Tue, now overdue) + Old follow-up are both overdue
    const ask: any = await chat("rs2", "push all overdue tasks to next monday");
    expect(ask.text).toMatch(/Move these 2 overdue tasks\?/);
    expect(ask.text).toContain("Call Acme");
    expect(ask.text).toContain("Old follow-up");
    const no: any = await chat("rs2", "no");
    expect(no.text).toMatch(/Cancelled/);
    expect(patches.length).toBe(4); // no new patches
  });

  test("empty group reports nothing to move", async () => {
    const r: any = await chat("rs3", "move tasks due tomorrow to friday");
    expect(r.text).toMatch(/No tasks due tomorrow to move/);
  });

  test("single task reschedules to an absolute date", async () => {
    const ask: any = await chat("rs4", "move task Send deck to friday");
    expect(ask.text).toMatch(/Move this task\?/);
    expect(ask.text).toContain("Send deck");
    const go: any = await chat("rs4", "yes");
    expect(go.text).toMatch(/✅ Moved 1 task/);
    const last = patches[patches.length - 1];
    expect(last.id).toBe(2);
    expect(last.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

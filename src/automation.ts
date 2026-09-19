// automation.ts — Milton's automation layer: routines, schedules, triggers, runs.
// Zero dependencies. Storage + schedule math + trigger matching + SSE fan-out.
// This module never imports brain.ts (brain imports this); the step runner for
// unattended execution lives in brain.ts and calls back into these stores.

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initAutomationDb(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_name ON routines (lower(name));
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_name TEXT NOT NULL,
      spec TEXT NOT NULL,
      spec_text TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'server',
      next_run INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      filter TEXT NOT NULL DEFAULT '{}',
      routine_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      routine_name TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '{}',
      ran_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function needDb(): Database {
  if (!db) throw new Error("automation store not initialized");
  return db;
}

// ---- routines ------------------------------------------------------------------
export interface Routine { id: number; name: string; steps: string[]; created_at: string }

function rowToRoutine(r: any): Routine {
  return { id: r.id, name: r.name, steps: JSON.parse(r.steps), created_at: r.created_at };
}

export function saveRoutine(name: string, steps: string[]): Routine {
  const d = needDb();
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new Error("Routine name can't be empty.");
  if (!/^[a-z0-9][a-z0-9 _\-]*$/i.test(clean)) throw new Error(`"${name}" isn't a valid routine name — use letters, numbers, spaces, dashes.`);
  const stepList = steps.map((s) => s.trim()).filter(Boolean).slice(0, 12);
  if (!stepList.length) throw new Error("A routine needs at least one step.");
  const existing = getRoutine(clean);
  if (existing) {
    d.query("UPDATE routines SET steps = ? WHERE id = ?").run(JSON.stringify(stepList), existing.id);
  } else {
    d.query("INSERT INTO routines (name, steps) VALUES (?, ?)").run(clean, JSON.stringify(stepList));
  }
  return getRoutine(clean)!;
}

export function getRoutine(name: string): Routine | null {
  const r = needDb().query("SELECT * FROM routines WHERE lower(name) = lower(?)").get(name.trim()) as any;
  return r ? rowToRoutine(r) : null;
}

export function listRoutines(): Routine[] {
  return (needDb().query("SELECT * FROM routines ORDER BY lower(name)").all() as any[]).map(rowToRoutine);
}

/** Delete a routine and anything scheduled/triggered off it. Returns counts. */
export function deleteRoutine(name: string): { deleted: boolean; schedules: number; triggers: number } {
  const d = needDb();
  const r = getRoutine(name);
  if (!r) return { deleted: false, schedules: 0, triggers: 0 };
  const s = d.query("DELETE FROM schedules WHERE lower(routine_name) = lower(?)").run(r.name);
  const t = d.query("DELETE FROM triggers WHERE lower(routine_name) = lower(?)").run(r.name);
  d.query("DELETE FROM routines WHERE id = ?").run(r.id);
  return { deleted: true, schedules: Number(s.changes), triggers: Number(t.changes) };
}

// ---- schedule specs -------------------------------------------------------------
export type ScheduleSpec =
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekday"; hour: number; minute: number }
  | { type: "weekly"; day: number; hour: number; minute: number }
  | { type: "interval"; everyMs: number };

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseTime(s: string): { hour: number; minute: number } | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === "pm") h += 12;
    const min = Number(m[2] || 0);
    if (Number(m[1]) > 12 || min > 59) return null;
    return { hour: h, minute: min };
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  return null;
}

/** Parse "daily at 6pm" / "every weekday at 8am" / "every monday at 9am" / "every 2 hours" / "every 30 minutes". */
export function parseScheduleSpec(when: string): ScheduleSpec | null {
  const t = when.trim().toLowerCase().replace(/\s+/g, " ");
  let m = t.match(/^(?:daily|each day) at (.+)$/);
  if (m) { const tm = parseTime(m[1]); return tm ? { type: "daily", ...tm } : null; }
  m = t.match(/^every weekday at (.+)$/);
  if (m) { const tm = parseTime(m[1]); return tm ? { type: "weekday", ...tm } : null; }
  m = t.match(/^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (.+)$/);
  if (m) { const tm = parseTime(m[2]); return tm ? { type: "weekly", day: DAY_NAMES.indexOf(m[1]), ...tm } : null; }
  m = t.match(/^every (\d+) (minutes?|hours?)$/);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 24 * 7) return null;
    const everyMs = /hour/.test(m[2]) ? n * 3600000 : n * 60000;
    return { type: "interval", everyMs };
  }
  return null;
}

export function specText(spec: ScheduleSpec): string {
  const hm = (h: number, m: number) => {
    const ap = h >= 12 ? "PM" : "AM";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
  };
  switch (spec.type) {
    case "daily": return `daily at ${hm(spec.hour, spec.minute)}`;
    case "weekday": return `every weekday at ${hm(spec.hour, spec.minute)}`;
    case "weekly": return `every ${DAY_NAMES[spec.day][0].toUpperCase() + DAY_NAMES[spec.day].slice(1)} at ${hm(spec.hour, spec.minute)}`;
    case "interval": {
      const mins = spec.everyMs / 60000;
      return mins % 60 === 0 ? `every ${mins / 60} hour${mins === 60 ? "" : "s"}` : `every ${mins} minute${mins === 1 ? "" : "s"}`;
    }
  }
}

/** Next occurrence strictly after fromMs, in server-local time. */
export function nextRunAfter(spec: ScheduleSpec, fromMs: number): number {
  if (spec.type === "interval") return fromMs + spec.everyMs;
  const at = (d: Date) => { d.setHours(spec.hour, spec.minute, 0, 0); return d.getTime(); };
  const base = new Date(fromMs);
  if (spec.type === "daily") {
    let n = at(new Date(base));
    if (n <= fromMs) { const d = new Date(base); d.setDate(d.getDate() + 1); n = at(d); }
    return n;
  }
  if (spec.type === "weekday") {
    const d = new Date(base);
    for (let i = 0; i < 8; i++) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        const n = at(new Date(d));
        if (n > fromMs) return n;
      }
      d.setDate(d.getDate() + 1);
    }
    return at(d);
  }
  // weekly
  const d = new Date(base);
  for (let i = 0; i < 8; i++) {
    if (d.getDay() === spec.day) {
      const n = at(new Date(d));
      if (n > fromMs) return n;
    }
    d.setDate(d.getDate() + 1);
  }
  return at(d);
}

// ---- schedules -------------------------------------------------------------------
export interface Schedule { id: number; routine_name: string; spec: ScheduleSpec; spec_text: string; tz: string; next_run: number; active: number; created_at: string }

function rowToSchedule(r: any): Schedule {
  return { id: r.id, routine_name: r.routine_name, spec: JSON.parse(r.spec), spec_text: r.spec_text, tz: r.tz, next_run: r.next_run, active: r.active, created_at: r.created_at };
}

export function createSchedule(routineName: string, spec: ScheduleSpec, nowMs: number): Schedule {
  const d = needDb();
  const r = d.query("INSERT INTO schedules (routine_name, spec, spec_text, next_run) VALUES (?, ?, ?, ?)")
    .run(routineName, JSON.stringify(spec), specText(spec), nextRunAfter(spec, nowMs));
  return getSchedule(Number(r.lastInsertRowid))!;
}

export function getSchedule(id: number): Schedule | null {
  const r = needDb().query("SELECT * FROM schedules WHERE id = ?").get(id) as any;
  return r ? rowToSchedule(r) : null;
}

export function listSchedules(): Schedule[] {
  return (needDb().query("SELECT * FROM schedules ORDER BY next_run").all() as any[]).map(rowToSchedule);
}

export function setScheduleActive(id: number, active: boolean): boolean {
  return needDb().query("UPDATE schedules SET active = ? WHERE id = ?").run(active ? 1 : 0, id).changes > 0;
}

export function deleteScheduleByRef(ref: string): number {
  const d = needDb();
  const id = Number(ref);
  if (Number.isInteger(id) && id > 0) return d.query("DELETE FROM schedules WHERE id = ?").run(id).changes as number;
  return d.query("DELETE FROM schedules WHERE lower(routine_name) = lower(?)").run(ref.trim()).changes as number;
}

export function dueSchedules(nowMs: number): Schedule[] {
  return (needDb().query("SELECT * FROM schedules WHERE active = 1 AND next_run <= ? ORDER BY next_run").all(nowMs) as any[]).map(rowToSchedule);
}

export function advanceSchedule(id: number, nowMs: number): number {
  const s = getSchedule(id);
  if (!s) return 0;
  const next = nextRunAfter(s.spec, nowMs);
  needDb().query("UPDATE schedules SET next_run = ? WHERE id = ?").run(next, id);
  return next;
}

// ---- triggers ----------------------------------------------------------------------
export interface Trigger { id: number; event: string; filter: Record<string, string>; routine_name: string; active: number; created_at: string }

// Event names exec-crm fires on its outgoing webhooks (from exec-crm/src/server.ts).
export const CRM_EVENTS = [
  "deal.created", "deal.stage_changed", "deal.updated",
  "contact.created",
  "campaign.created", "campaign.updated", "campaign.deleted",
  "task.created", "task.completed", "task.deleted",
];

// Friendly aliases for `when <phrase> run <routine>`.
const EVENT_ALIASES: Record<string, { event: string; filter?: Record<string, string> }> = {
  "deal won": { event: "deal.stage_changed", filter: { stage: "closed_won" } },
  "deal lost": { event: "deal.stage_changed", filter: { stage: "closed_lost" } },
  "deal created": { event: "deal.created" },
  "deal updated": { event: "deal.updated" },
  "deal moved": { event: "deal.stage_changed" },
  "stage changed": { event: "deal.stage_changed" },
  "contact created": { event: "contact.created" },
  "task created": { event: "task.created" },
  "task completed": { event: "task.completed" },
  "task done": { event: "task.completed" },
  "task deleted": { event: "task.deleted" },
  "campaign created": { event: "campaign.created" },
  "campaign updated": { event: "campaign.updated" },
  "campaign deleted": { event: "campaign.deleted" },
};

/** Resolve "deal won" / "deal.stage_changed where stage=closed_won" -> { event, filter }. */
export function resolveTriggerEvent(phrase: string): { event: string; filter: Record<string, string> } | null {
  const t = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const [head, where] = t.split(/\s+where\s+/);
  const filter: Record<string, string> = {};
  if (where) {
    for (const pair of where.split(",")) {
      const m = pair.trim().match(/^([\w.]+)\s*=\s*(.+)$/);
      if (!m) return null;
      filter[m[1]] = m[2].trim();
    }
  }
  if (CRM_EVENTS.includes(head)) return { event: head, filter };
  const alias = EVENT_ALIASES[head];
  if (alias) return { event: alias.event, filter: { ...(alias.filter || {}), ...filter } };
  return null;
}

export function createTrigger(event: string, filter: Record<string, string>, routineName: string): Trigger {
  const d = needDb();
  const r = d.query("INSERT INTO triggers (event, filter, routine_name) VALUES (?, ?, ?)")
    .run(event, JSON.stringify(filter), routineName);
  return getTrigger(Number(r.lastInsertRowid))!;
}

export function getTrigger(id: number): Trigger | null {
  const r = needDb().query("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  return r ? { id: r.id, event: r.event, filter: JSON.parse(r.filter || "{}"), routine_name: r.routine_name, active: r.active, created_at: r.created_at } : null;
}

export function listTriggers(): Trigger[] {
  return (needDb().query("SELECT * FROM triggers ORDER BY id").all() as any[]).map((r) => ({
    id: r.id, event: r.event, filter: JSON.parse(r.filter || "{}"), routine_name: r.routine_name, active: r.active, created_at: r.created_at,
  }));
}

export function deleteTrigger(id: number): boolean {
  return needDb().query("DELETE FROM triggers WHERE id = ?").run(id).changes > 0;
}

/** Triggers whose event matches and whose filter shallow-matches the payload data. */
export function matchTriggers(event: string, data: Record<string, any>): Trigger[] {
  return listTriggers().filter((t) => {
    if (!t.active || t.event !== event) return false;
    return Object.entries(t.filter).every(([k, v]) => String(data?.[k] ?? "") === String(v));
  });
}

// ---- runs ----------------------------------------------------------------------------
export interface AutomationRun { id: number; kind: string; ref: string; routine_name: string; status: string; summary: string; detail: any; ran_at: string }

export function recordRun(r: { kind: string; ref?: string; routine_name: string; status: string; summary?: string; detail?: any }): AutomationRun {
  const d = needDb();
  const res = d.query(
    "INSERT INTO automation_runs (kind, ref, routine_name, status, summary, detail) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(r.kind, r.ref || "", r.routine_name, r.status, r.summary || "", JSON.stringify(r.detail || {}));
  const row = d.query("SELECT * FROM automation_runs WHERE id = ?").get(Number(res.lastInsertRowid)) as any;
  const run: AutomationRun = { ...row, detail: JSON.parse(row.detail || "{}") };
  broadcastRun(run);
  return run;
}

export function listRuns(limit = 50): AutomationRun[] {
  return (needDb().query("SELECT * FROM automation_runs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    ...r, detail: JSON.parse(r.detail || "{}"),
  }));
}

export function latestRunId(): number {
  const r = needDb().query("SELECT MAX(id) AS m FROM automation_runs").get() as any;
  return Number(r?.m || 0);
}

// ---- SSE fan-out -----------------------------------------------------------------------
type SseSink = { enqueue(chunk: Uint8Array): void };
const sseClients = new Set<SseSink>();

export function sseAdd(c: SseSink) { sseClients.add(c); }
export function sseRemove(c: SseSink) { sseClients.delete(c); }
export function sseCount(): number { return sseClients.size; }

function broadcastRun(run: AutomationRun) {
  if (!sseClients.size) return;
  const msg = new TextEncoder().encode(`event: automation-run\ndata: ${JSON.stringify(run)}\n\n`);
  for (const c of [...sseClients]) {
    try { c.enqueue(msg); } catch { sseClients.delete(c); }
  }
}

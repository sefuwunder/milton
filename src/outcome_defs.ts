// outcome_defs.ts — outcome definitions: the "Create outcome" screen as data.
//
// DESIGN DECISION: the outcome builder doc defines an outcome as
// Name + Contact Cycle Action (recycle | complete | no effect | schedule
// appointment) + conditional fields (default recycle period, completion
// reason) + Functions (reassign | redirect | pipeline) + Applicable actions
// (email | in person | review | snail mail | text message | voice call).
// Definitions live in Milton's own SQLite, workspace-scoped like outcomes
// and deal notes. The `activate outcome` chat flow (brain.ts) walks the
// "Activate outcome" screen: cycle-action prompts, function prompts, note,
// then SUBMIT — logging to the outcome log and performing the cycle action
// against exec-crm (recycle → follow-up task, complete → won/lost stage,
// schedule appointment → appointment task + optional stage, no effect →
// note only; reassign → deal owner, redirect → deal contact, pipeline →
// deal stage).

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initOutcomeDefsDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_defs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER,
      name TEXT NOT NULL,
      cycle_action TEXT NOT NULL,
      default_recycle_days INTEGER,
      completion_reason TEXT,
      functions TEXT NOT NULL DEFAULT '',
      applicable_actions TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (workspace_id, name)
    );
  `);
}

function needDb(): Database {
  if (!db) throw new Error("outcome_defs DB not initialized");
  return db;
}

export type CycleAction = "recycle" | "complete" | "no_effect" | "schedule_appointment";

export interface OutcomeDef {
  id: number; name: string; cycle_action: CycleAction;
  default_recycle_days: number | null;
  completion_reason: string | null;
  functions: string[]; applicable_actions: string[];
  created_at: string;
}

export interface NewOutcomeDef {
  name: string; cycle_action: CycleAction;
  default_recycle_days?: number | null;
  completion_reason?: string | null;
  functions?: string[]; applicable_actions?: string[];
}

// ---- the doc's vocabulary -------------------------------------------------

export const CYCLE_ACTIONS: { id: CycleAction; label: string }[] = [
  { id: "recycle", label: "Recycle" },
  { id: "complete", label: "Complete" },
  { id: "no_effect", label: "No effect" },
  { id: "schedule_appointment", label: "Schedule appointment" },
];

export const COMPLETION_REASONS = [
  { id: "rejected", label: "Rejected" },
  { id: "successful", label: "Successful" },
];

export const OUTCOME_FUNCTIONS = [
  { id: "reassign", label: "Reassign" },
  { id: "redirect", label: "Redirect" },
  { id: "pipeline", label: "Pipeline" },
];

export const APPLICABLE_ACTIONS = [
  { id: "email", label: "Email" },
  { id: "in_person", label: "In person" },
  { id: "review", label: "Review" },
  { id: "snail_mail", label: "Snail mail" },
  { id: "text_message", label: "Text message" },
  { id: "voice_call", label: "Voice call" },
];

export function cycleActionLabel(id: string): string {
  return CYCLE_ACTIONS.find((a) => a.id === id)?.label ?? id;
}
export function functionLabel(id: string): string {
  return OUTCOME_FUNCTIONS.find((f) => f.id === id)?.label ?? id;
}
export function actionLabel(id: string): string {
  return APPLICABLE_ACTIONS.find((a) => a.id === id)?.label ?? id;
}
export function completionReasonLabel(id: string | null): string {
  return COMPLETION_REASONS.find((r) => r.id === id)?.label ?? id ?? "—";
}

/** Map a definition's first applicable action onto the outcome-log method
 *  vocabulary (outcomes.ts). Unmapped actions are kept verbatim — the log
 *  stores them fine and the playbook matches on category, not method. */
const METHOD_MAP: Record<string, string> = {
  voice_call: "call", email: "email", text_message: "social", in_person: "in_person",
};
export function methodForDef(def: OutcomeDef): string {
  const first = def.applicable_actions[0];
  if (!first) return "call";
  return METHOD_MAP[first] ?? first;
}

/** Cycle action → outcome-log category, so activations feed the outcome
 *  phase rules (R14–R18) exactly like manual `log outcome` entries. */
export function categoryForCycle(action: CycleAction): string {
  switch (action) {
    case "recycle": return "recycle";
    case "complete": return "complete";
    case "schedule_appointment": return "pipeline";
    default: return "no_effect";
  }
}

// ---- store ---------------------------------------------------------------

function rowToDef(r: any): OutcomeDef {
  const split = (s: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
  return {
    id: r.id, name: r.name, cycle_action: r.cycle_action,
    default_recycle_days: r.default_recycle_days ?? null,
    completion_reason: r.completion_reason ?? null,
    functions: split(r.functions), applicable_actions: split(r.applicable_actions),
    created_at: r.created_at,
  };
}

export function createOutcomeDef(d: NewOutcomeDef, workspaceId: number | null): OutcomeDef {
  const name = d.name.trim();
  if (!name) throw new Error("empty_name");
  if (listOutcomeDefs(workspaceId).some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error("duplicate_name");
  const r = needDb().query(
    `INSERT INTO outcome_defs
       (workspace_id, name, cycle_action, default_recycle_days, completion_reason, functions, applicable_actions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workspaceId, name, d.cycle_action,
    d.cycle_action === "recycle" ? (d.default_recycle_days ?? 3) : null,
    d.cycle_action === "complete" ? (d.completion_reason ?? "rejected") : null,
    (d.functions ?? []).join(","), (d.applicable_actions ?? []).join(","),
  );
  return getOutcomeDef(Number(r.lastInsertRowid), workspaceId)!;
}

export function getOutcomeDef(id: number, workspaceId: number | null): OutcomeDef | undefined {
  const r = needDb().query(
    "SELECT * FROM outcome_defs WHERE id = ? AND workspace_id IS ?"
  ).get(id, workspaceId) as any;
  return r ? rowToDef(r) : undefined;
}

export function listOutcomeDefs(workspaceId: number | null): OutcomeDef[] {
  return (needDb().query(
    "SELECT * FROM outcome_defs WHERE workspace_id IS ? ORDER BY name ASC"
  ).all(workspaceId) as any[]).map(rowToDef);
}

/** Case-insensitive substring match for `activate outcome <name>` /
 *  `show outcome <name>` resolution. */
export function findOutcomeDefs(query: string, workspaceId: number | null): OutcomeDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return listOutcomeDefs(workspaceId).filter((d) => d.name.toLowerCase().includes(q));
}

export function deleteOutcomeDef(id: number, workspaceId: number | null): boolean {
  const r = needDb().query(
    "DELETE FROM outcome_defs WHERE id = ? AND workspace_id IS ?"
  ).run(id, workspaceId);
  return Number(r.changes) > 0;
}

// ---- pure chat-flow helpers (unit-tested) ---------------------------------

/** Parse a multi-select reply ("1 3", "1,3", "all", "none", or English
 *  labels like "email, voice call") against a vocabulary list. */
export function parseMultiSelect(
  raw: string, vocab: { id: string; label: string }[],
): { ids: string[] } | { error: string } {
  let t = raw.trim().toLowerCase();
  if (!t) return { error: "empty" };
  if (t === "none" || t === "no" || t === "skip") return { ids: [] };
  if (t === "all" || t === "every") return { ids: vocab.map((v) => v.id) };
  // Multi-word labels ("voice call", "snail mail") match as phrases:
  // substitute them for their id before tokenizing on whitespace.
  for (const v of vocab) {
    const phrase = v.label.toLowerCase();
    if (phrase.includes(" ")) t = t.split(phrase).join(v.id);
  }
  const ids: string[] = [];
  const bad: string[] = [];
  for (const tok of t.split(/[\s,;]+/).filter(Boolean)) {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= vocab.length) {
      const id = vocab[n - 1].id;
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    const v = vocab.find((x) => x.id === tok || x.label.toLowerCase() === tok || x.label.toLowerCase().replace(/ /g, "_") === tok);
    if (v && !ids.includes(v.id)) ids.push(v.id);
    else bad.push(tok);
  }
  if (bad.length) return { error: `bad:${bad.join(",")}` };
  return { ids };
}

/** Parse the Default Recycle Period field: a positive whole number of days. */
export function parseRecycleDays(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(?:days?)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 365 ? n : null;
}

/** "09/28/2026 2:30 pm" / "tomorrow 10am" → { date: "2026-09-28", time: "14:30" }.
 *  Date part reuses the shared deterministic parser; a missing or unparsable
 *  time returns null so the flow can ask again. */
export function parseOutcomeDateTime(raw: string, parseDate: (s: string, ref?: Date) => string | null): { date: string; time: string } | null {
  const t = raw.trim();
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!tm) return null;
  let h = Number(tm[1]);
  const min = tm[2] ? Number(tm[2]) : 0;
  if (h < 1 || h > 12 || min > 59) return null;
  const ap = tm[3].toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const dateOnly = t.slice(0, tm.index).trim() || t;
  const date = parseDate(dateOnly);
  if (!date) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return { date, time: `${p(h)}:${p(min)}` };
}

/** "2026-09-28" → "09/28/2026", the format on the doc's Activate screen. */
export function fmtMDY(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ymd;
}

/** "2026-09-28" + "14:30" → "09/28/2026 2:30 pm" for the SUBMIT card. */
export function fmtMDYTime(ymd: string, hm: string): string {
  const m = hm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return fmtMDY(ymd);
  let h = Number(m[1]);
  const ap = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${fmtMDY(ymd)} ${h}:${m[2]} ${ap}`;
}

/** Local-calendar-day addition: "2026-09-23" + 3 → "2026-09-26". */
export function addDays(ymd: string, days: number): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  const d = base && !isNaN(base.getTime()) ? base : new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  const out = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return out;
}

/** One-line summary of a definition, mirroring the Create screen's fields. */
export function describeDef(d: OutcomeDef): string {
  const lines = [
    `**${d.name}** — ${cycleActionLabel(d.cycle_action)}`,
    d.cycle_action === "recycle" ? `• Default recycle period: ${d.default_recycle_days} day(s)` : "",
    d.cycle_action === "complete" ? `• Completion reason: ${completionReasonLabel(d.completion_reason)}` : "",
    d.functions.length ? `• Functions: ${d.functions.map(functionLabel).join(", ")}` : "• Functions: —",
    d.applicable_actions.length ? `• Applicable actions: ${d.applicable_actions.map(actionLabel).join(", ")}` : "• Applicable actions: any",
  ];
  return lines.filter(Boolean).join("\n");
}

// outcomes.ts — Milton-local prospecting outcome log.
//
// DESIGN DECISION: exec-crm has no outcome-logging endpoint (outcomes are the
// ProspectStream flowchart's vocabulary: what happened on a touch — voicemail,
// bounced, meeting set, no interest…), so "log outcome" persists here in
// Milton's own SQLite, keyed by (deal_id, workspace_id), exactly like
// deal_notes.ts. The outcome phase of the playbook rule engine (R14–R18)
// reads these facts; the guided `log outcome` chat flow writes them.
//
// Category vocabulary mirrors the flowchart's Level 3–4 groupings:
// no_contact / conversation / abrupt_end / no_effect / recycle / pipeline /
// complete / retired / reassigned / redirected.

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initOutcomesDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER NOT NULL,
      workspace_id INTEGER,
      method TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_deal ON outcomes (deal_id, workspace_id);
  `);
}

function needDb(): Database {
  if (!db) throw new Error("outcomes DB not initialized");
  return db;
}

export interface Outcome {
  id: number; deal_id: number; method: string; category: string;
  label: string; note: string; at: string;
}

export interface OutcomeLabel { label: string; category: string }

const M = (label: string, category: string): OutcomeLabel => ({ label, category });

/** The guided `log outcome` flow walks method → label. Every label carries
 *  its ProspectStream category, which is what the outcome-phase rules match. */
export const OUTCOME_METHODS: Record<string, { name: string; labels: OutcomeLabel[] }> = {
  call: { name: "Call", labels: [
    M("voicemail", "no_contact"), M("no_answer", "no_contact"),
    M("left_message", "no_contact"), M("conversation", "conversation"),
    M("meeting_scheduled", "pipeline"), M("proposal_requested", "pipeline"),
    M("info_sent", "recycle"), M("call_back_later", "recycle"),
    M("wrong_number", "recycle"), M("hung_up", "abrupt_end"),
    M("no_interest", "retired"), M("disconnected", "retired"),
    M("reassigned", "reassigned"), M("redirected", "redirected"),
    M("contract_signed", "complete"),
  ]},
  email: { name: "Email", labels: [
    M("sent", "no_effect"), M("bounced", "recycle"), M("no_reply", "recycle"),
    M("reply_received", "conversation"), M("meeting_scheduled", "pipeline"),
    M("proposal_sent", "pipeline"), M("info_sent", "recycle"),
    M("unsubscribed", "retired"), M("no_interest", "retired"),
  ]},
  social: { name: "Social message", labels: [
    M("message_sent", "no_effect"), M("no_reply", "recycle"),
    M("reply_received", "conversation"), M("meeting_scheduled", "pipeline"),
    M("no_interest", "retired"),
  ]},
  video: { name: "Video call", labels: [
    M("meeting_held", "conversation"), M("meeting_scheduled", "pipeline"),
    M("no_show_prospect", "recycle"), M("technical_issues", "recycle"),
    M("no_interest", "retired"),
  ]},
  in_person: { name: "In person", labels: [
    M("meeting_held", "conversation"), M("meeting_scheduled", "pipeline"),
    M("could_not_find", "recycle"), M("no_interest", "retired"),
  ]},
};

export const OUTCOME_CATEGORIES = [
  "no_contact", "conversation", "abrupt_end", "no_effect", "recycle",
  "pipeline", "complete", "retired", "reassigned", "redirected",
];

/** "voicemail" → "Voicemail"; "no_show_prospect" → "No show prospect". */
export function humanizeLabel(label: string): string {
  return label.split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

export function methodName(method: string): string {
  return OUTCOME_METHODS[method]?.name ?? method;
}

export function logOutcome(
  dealId: number, method: string, label: string, category: string,
  workspaceId: number | null, note = "",
): Outcome {
  const d = needDb();
  const r = d.query(
    "INSERT INTO outcomes (deal_id, workspace_id, method, category, label, note) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(dealId, workspaceId, method, category, label, note.slice(0, 2000));
  return d.query("SELECT id, deal_id, method, category, label, note, at FROM outcomes WHERE id = ?")
    .get(Number(r.lastInsertRowid)) as Outcome;
}

/** Delete one outcome (undo of a log). Returns true when one was removed. */
export function deleteOutcome(id: number): boolean {
  const r = needDb().query("DELETE FROM outcomes WHERE id = ?").run(id);
  return Number(r.changes) > 0;
}

export function getOutcomes(dealId: number, workspaceId: number | null): Outcome[] {
  return needDb().query(
    "SELECT id, deal_id, method, category, label, note, at FROM outcomes WHERE deal_id = ? AND workspace_id IS ? ORDER BY id ASC"
  ).all(dealId, workspaceId) as Outcome[];
}

/** Every outcome in the workspace, newest last — feeds the rule engine. */
export function getAllOutcomes(workspaceId: number | null, limit = 2000): Outcome[] {
  return needDb().query(
    "SELECT id, deal_id, method, category, label, note, at FROM outcomes WHERE workspace_id IS ? ORDER BY id ASC LIMIT ?"
  ).all(workspaceId, limit) as Outcome[];
}

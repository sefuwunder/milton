// intent_misses.ts — local log of utterances Milton's deterministic parser
// could not classify ("unknown" intents).
//
// DESIGN DECISION: the chat layer calls logMiss() with the raw utterance
// whenever the parser returns unknown. Nothing ever leaves the box — this is
// a pure local review queue for later classifier tuning. Rant-spam is
// suppressed: a repeat of the same utterance in the same session within 24h
// while it still has an unreviewed row is skipped.

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initMissLogDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT DEFAULT (datetime('now')),
      utterance TEXT NOT NULL,
      session_id TEXT NOT NULL,
      guess TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_intent_misses_reviewed ON intent_misses (reviewed, id);
  `);
}

function needDb(): Database {
  if (!db) throw new Error("intent-misses DB not initialized");
  return db;
}

export interface Miss {
  id: number;
  at: string;
  utterance: string;
  session_id: string;
  guess: string | null;
  reviewed: number;
}

const MAX_UTTERANCE_LEN = 1000;

export function logMiss(utterance: string, sessionId: string, guess: string | null = null): Miss | null {
  const text = utterance.trim().slice(0, MAX_UTTERANCE_LEN);
  if (!text) return null;
  const d = needDb();
  const dupe = d.query(
    `SELECT id FROM intent_misses
     WHERE session_id = ? AND utterance = ? AND reviewed = 0
       AND at >= datetime('now', '-24 hours')`
  ).get(sessionId, text) as { id: number } | null;
  if (dupe) return null;
  const r = d.query(
    "INSERT INTO intent_misses (utterance, session_id, guess) VALUES (?, ?, ?)"
  ).run(text, sessionId, guess);
  return d.query(
    "SELECT id, at, utterance, session_id, guess, reviewed FROM intent_misses WHERE id = ?"
  ).get(Number(r.lastInsertRowid)) as Miss;
}

export function listMisses(opts?: { unreviewedOnly?: boolean; limit?: number }): Miss[] {
  const unreviewedOnly = opts?.unreviewedOnly ?? true;
  const limit = Math.max(1, opts?.limit ?? 20);
  const d = needDb();
  if (unreviewedOnly) {
    return d.query(
      "SELECT id, at, utterance, session_id, guess, reviewed FROM intent_misses WHERE reviewed = 0 ORDER BY id DESC LIMIT ?"
    ).all(limit) as Miss[];
  }
  return d.query(
    "SELECT id, at, utterance, session_id, guess, reviewed FROM intent_misses ORDER BY id DESC LIMIT ?"
  ).all(limit) as Miss[];
}

export function countUnreviewed(): number {
  const row = needDb().query(
    "SELECT COUNT(*) AS n FROM intent_misses WHERE reviewed = 0"
  ).get() as { n: number } | null;
  return Number(row?.n || 0);
}

export function markReviewed(id: number): boolean {
  const r = needDb().query(
    "UPDATE intent_misses SET reviewed = 1 WHERE id = ?"
  ).run(id);
  return r.changes > 0;
}

export function dismissMiss(id: number): boolean {
  const r = needDb().query(
    "DELETE FROM intent_misses WHERE id = ?"
  ).run(id);
  return r.changes > 0;
}

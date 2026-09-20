// deal_notes.ts — Milton-local deal notes.
//
// DESIGN DECISION: exec-crm has no deal-notes endpoint (checked its REST
// surface — deals expose no notes field and there is no /api/notes route), so
// "note on <deal> <text>" persists here in Milton's own SQLite, keyed by
// (deal_id, workspace_id). Notes therefore follow the workspace scoping Milton
// already uses for exec-crm calls, and survive across chat sessions. brain.ts
// surfaces them on deal lookups ("show deal X").

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initDealNotesDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS deal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER NOT NULL,
      workspace_id INTEGER,
      text TEXT NOT NULL,
      at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deal_notes_deal ON deal_notes (deal_id, workspace_id);
  `);
}

function needDb(): Database {
  if (!db) throw new Error("deal-notes DB not initialized");
  return db;
}

export interface DealNote { id: number; deal_id: number; text: string; at: string }

export function addDealNote(dealId: number, text: string, workspaceId: number | null): DealNote {
  const d = needDb();
  const r = d.query("INSERT INTO deal_notes (deal_id, workspace_id, text) VALUES (?, ?, ?)")
    .run(dealId, workspaceId, text.slice(0, 2000));
  return d.query("SELECT id, deal_id, text, at FROM deal_notes WHERE id = ?")
    .get(Number(r.lastInsertRowid)) as DealNote;
}

export function getDealNotes(dealId: number, workspaceId: number | null): DealNote[] {
  return needDb().query(
    "SELECT id, deal_id, text, at FROM deal_notes WHERE deal_id = ? AND workspace_id IS ? ORDER BY id ASC"
  ).all(dealId, workspaceId) as DealNote[];
}

export function countDealNotes(dealId: number, workspaceId: number | null): number {
  const row = needDb().query(
    "SELECT COUNT(*) AS n FROM deal_notes WHERE deal_id = ? AND workspace_id IS ?"
  ).get(dealId, workspaceId) as any;
  return Number(row?.n || 0);
}

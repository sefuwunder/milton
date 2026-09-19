// recon_runs.ts — Milton's pending Meridian recon-run store.
// A run requested through chat ("meridian recon Austin") lives here until
// Meridian's completion callback arrives at POST /api/hooks/meridian.
// Runs are pinned to the requesting session's workspace, like schedules and
// triggers are.

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initReconRunsDb(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS meridian_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      city TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      requested_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      nodes INTEGER NOT NULL DEFAULT 0,
      edges INTEGER NOT NULL DEFAULT 0,
      result_url TEXT NOT NULL DEFAULT '',
      export_url TEXT NOT NULL DEFAULT ''
    );
  `);
}

function needDb(): Database {
  if (!db) throw new Error("recon-run store not initialized");
  return db;
}

export interface ReconRunRequest {
  run_id: string;
  workspace_id: number | null;
  city: string;
  label: string;
  status: string;
  requested_at: string;
  completed_at: string | null;
  nodes: number;
  edges: number;
  result_url: string;
  export_url: string;
}

function rowToRun(r: any): ReconRunRequest {
  return {
    run_id: r.run_id,
    workspace_id: r.workspace_id == null ? null : Number(r.workspace_id),
    city: r.city || "",
    label: r.label || "",
    status: r.status || "",
    requested_at: r.requested_at || "",
    completed_at: r.completed_at || null,
    nodes: Number(r.nodes || 0),
    edges: Number(r.edges || 0),
    result_url: r.result_url || "",
    export_url: r.export_url || "",
  };
}

/** Persist a newly requested run. Re-requesting the same run_id replaces it. */
export function saveRunRequest(r: { runId: string; workspaceId: number | null; city: string; label?: string; status?: string }): ReconRunRequest {
  const d = needDb();
  d.query(
    "INSERT OR REPLACE INTO meridian_runs (run_id, workspace_id, city, label, status, requested_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  ).run(r.runId, r.workspaceId, r.city, r.label || "", r.status || "");
  return getRunRequest(r.runId)!;
}

export function getRunRequest(runId: string): ReconRunRequest | null {
  const r = needDb().query("SELECT * FROM meridian_runs WHERE run_id = ?").get(runId) as any;
  return r ? rowToRun(r) : null;
}

/** Mark a pending run completed. Returns false when the run_id was unknown. */
export function completeRunRequest(
  runId: string,
  c: { status: string; nodes: number; edges: number; resultUrl: string; exportUrl: string }
): boolean {
  const ch = needDb().query(
    "UPDATE meridian_runs SET status = ?, completed_at = datetime('now'), nodes = ?, edges = ?, result_url = ?, export_url = ? WHERE run_id = ?"
  ).run(c.status, c.nodes, c.edges, c.resultUrl, c.exportUrl, runId);
  return ch.changes > 0;
}

export function listRunRequests(): ReconRunRequest[] {
  return (needDb().query("SELECT * FROM meridian_runs ORDER BY rowid DESC").all() as any[]).map(rowToRun);
}

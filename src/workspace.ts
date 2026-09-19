// workspace.ts — exec-crm workspace support.
// - Discovery: GET /api/workspaces on exec-crm, cached 60s in memory.
// - Ambient workspace: AsyncLocalStorage so every crm.ts call carries the
//   session's workspace (?workspace=<id>, which wins in exec-crm's needWs)
//   without threading a parameter through all of brain.ts. Concurrency-safe.
// - Per-session store: session_workspaces table keyed by Milton session id.
//   null = exec-crm's default workspace (nothing is sent).

import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";

export interface CrmWorkspace { id: number; name: string; color: string }

const BASE = process.env.EXEC_CRM_URL || process.env.MILTON_CRM_URL || "http://localhost:3001";

// ---- ambient workspace ------------------------------------------------------------
const als = new AsyncLocalStorage<{ ws: number | null }>();

/** Run fn with `ws` as the workspace for every exec-crm call it makes. */
export function runWithWorkspace<T>(ws: number | null, fn: () => T): T {
  return als.run({ ws }, fn);
}

/** Workspace id for the current async context, or null for the default. */
export function currentWorkspaceId(): number | null {
  return als.getStore()?.ws ?? null;
}

// ---- discovery --------------------------------------------------------------------
let cache: { at: number; list: CrmWorkspace[] } | null = null;
export const WORKSPACE_CACHE_MS = 60000;

/** Workspace list from exec-crm, or null when unreachable. */
export async function listWorkspaces(): Promise<CrmWorkspace[] | null> {
  const now = Date.now();
  if (cache && now - cache.at < WORKSPACE_CACHE_MS) return cache.list;
  try {
    const res = await fetch(BASE + "/api/workspaces", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j: any = await res.json();
    const list: CrmWorkspace[] = (j.workspaces || []).map((w: any) => ({
      id: Number(w.id),
      name: String(w.name || `Workspace ${w.id}`),
      color: String(w.color || "#579bfc"),
    }));
    cache = { at: now, list };
    return list;
  } catch {
    return null;
  }
}

/** Test helper: drop the in-memory list cache. */
export function clearWorkspaceCache(): void {
  cache = null;
}

// ---- fuzzy matching (same scoring as crm.ts matchByName) ---------------------------
function scoreName(name: string, query: string): number {
  const n = name.toLowerCase(), q = query.toLowerCase().trim();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  const words = n.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 70;
  if (n.includes(q)) return 50;
  const qt = q.split(/\s+/);
  if (qt.length > 1 && qt.every((t) => n.includes(t))) return 40;
  return 0;
}

export interface WorkspaceMatch { ws: CrmWorkspace; score: number }

/**
 * Find workspaces for a user query. Returns null when exec-crm is unreachable.
 * A bare number matching an id wins outright.
 */
export async function findWorkspace(query: string): Promise<WorkspaceMatch[] | null> {
  const list = await listWorkspaces();
  if (!list) return null;
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const byId = list.find((w) => w.id === Number(q));
    if (byId) return [{ ws: byId, score: 100 }];
  }
  return list
    .map((ws) => ({ ws, score: scoreName(ws.name, q) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.ws.name.localeCompare(b.ws.name));
}

/** Human label for a workspace id: cached name, "default", or "#id" fallback. */
export async function workspaceLabel(id: number | null): Promise<string> {
  if (id == null) return "default";
  const w = (await listWorkspaces())?.find((x) => x.id === id);
  return w ? w.name : `#${id}`;
}

// ---- per-session store ---------------------------------------------------------------
let db: Database | null = null;

export function initWorkspaceDb(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_workspaces (
      session_id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      workspace_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function needDb(): Database {
  if (!db) throw new Error("workspace store not initialized");
  return db;
}

/** { id: null } means the default workspace (nothing is sent to exec-crm). */
export function getSessionWorkspace(sid: string): { id: number | null; name: string } {
  const r = needDb()
    .query("SELECT workspace_id, workspace_name FROM session_workspaces WHERE session_id = ?")
    .get(sid) as any;
  if (!r) return { id: null, name: "" };
  return { id: Number(r.workspace_id), name: String(r.workspace_name || "") };
}

export function setSessionWorkspace(sid: string, id: number | null, name: string): void {
  const d = needDb();
  if (id == null) {
    d.query("DELETE FROM session_workspaces WHERE session_id = ?").run(sid);
  } else {
    d.query(
      `INSERT INTO session_workspaces (session_id, workspace_id, workspace_name, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         workspace_name = excluded.workspace_name,
         updated_at = datetime('now')`
    ).run(sid, id, name);
  }
}

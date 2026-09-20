// chat_sessions.ts — user-facing named chat sessions (ChatGPT-style conversation
// list, deterministic and local).
//
// Storage: the existing `sessions` table gains `name` and `last_active_at`
// columns (idempotent ALTERs). Legacy rows (pre-feature) are backfilled:
// oldest becomes "General", later ones "General 2", "General 3", …
//
// Everything else session-scoped (messages, uploads, session_workspaces,
// reminders, the JSON `state` blob with tutorial/lastWidgetable/history)
// is already keyed by session id, so naming + switching is all this adds.

import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";

export interface ChatSessionInfo {
  id: string;
  name: string;
  created_at: string;
  last_active_at: string;
  messageCount: number;
}

let db: Database | null = null;
let uploadsRoot: string | null = null;

export function initChatSessionDb(database: Database, uploadsDir?: string): void {
  db = database;
  uploadsRoot = uploadsDir ?? null;
  const cols = db.query("PRAGMA table_info(sessions)").all() as any[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("name")) db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
  if (!names.has("last_active_at")) db.exec("ALTER TABLE sessions ADD COLUMN last_active_at TEXT");
  // Backfill legacy rows: oldest unnamed session becomes "General".
  const unnamed = db.query(
    "SELECT id FROM sessions WHERE name IS NULL OR name = '' ORDER BY created_at ASC, rowid ASC"
  ).all() as any[];
  const taken = new Set(
    (db.query("SELECT name FROM sessions WHERE name IS NOT NULL AND name != ''").all() as any[])
      .map((r: any) => String(r.name).toLowerCase())
  );
  unnamed.forEach((r: any, i: number) => {
    let n = i === 0 && !taken.has("general") ? "General" : `General ${i + 1}`;
    // (i===0, taken) edge: if "General" taken, fall through to numbered form
    if (i === 0 && taken.has("general")) n = `General ${unnamed.length + 1}`;
    let candidate = n, k = 2;
    while (taken.has(candidate.toLowerCase())) candidate = `${n} ${k++}`;
    taken.add(candidate.toLowerCase());
    db!.query("UPDATE sessions SET name = ?, last_active_at = COALESCE(last_active_at, updated_at, datetime('now')) WHERE id = ?")
      .run(candidate, r.id);
  });
}

function needDb(): Database {
  if (!db) throw new Error("chat session store not initialized");
  return db;
}

function rowToInfo(r: any, messageCount: number): ChatSessionInfo {
  return {
    id: String(r.id),
    name: String(r.name || "General"),
    created_at: String(r.created_at || ""),
    last_active_at: String(r.last_active_at || r.created_at || ""),
    messageCount,
  };
}

/** Sessions newest-activity-first (the order `sessions` prints and numbers use). */
export function listChatSessions(): ChatSessionInfo[] {
  const d = needDb();
  const rows = d.query(
    "SELECT id, name, created_at, last_active_at FROM sessions ORDER BY last_active_at DESC, rowid DESC"
  ).all() as any[];
  return rows.map((r) => {
    const c = d.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(r.id) as any;
    return rowToInfo(r, Number(c?.n || 0));
  });
}

export function getChatSession(id: string): ChatSessionInfo | null {
  const d = needDb();
  const r = d.query("SELECT id, name, created_at, last_active_at FROM sessions WHERE id = ?").get(id) as any;
  if (!r) return null;
  const c = d.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(id) as any;
  return rowToInfo(r, Number(c?.n || 0));
}

function nameTaken(name: string, exceptId?: string): boolean {
  const d = needDb();
  const r = d.query(
    "SELECT id FROM sessions WHERE lower(name) = lower(?) AND id != ?"
  ).get(name, exceptId || "") as any;
  return !!r;
}

function autoName(): string {
  const d = needDb();
  const rows = d.query("SELECT name FROM sessions").all() as any[];
  const taken = new Set(rows.map((r: any) => String(r.name || "").toLowerCase()));
  if (!taken.has("general")) return "General";
  let n = rows.length + 1;
  if (n < 2) n = 2;
  while (taken.has(`session ${n}`)) n++;
  return `Session ${n}`;
}

/** Create a session row (id must be fresh). Returns the info record. */
export function createChatSession(id: string, name?: string): ChatSessionInfo {
  const d = needDb();
  const clean = (name || "").trim().slice(0, 60);
  const finalName = clean || autoName();
  if (nameTaken(finalName)) throw new Error(`There's already a session named "${finalName}".`);
  d.query(
    "INSERT INTO sessions (id, name, state, created_at, last_active_at) VALUES (?, ?, '{}', datetime('now'), datetime('now'))"
  ).run(id, finalName);
  return getChatSession(id)!;
}

/** Ensure a session id has a named row (legacy loadSession path creates bare rows). */
export function ensureChatSession(id: string): ChatSessionInfo {
  const existing = getChatSession(id);
  if (existing) return existing;
  return createChatSession(id);
}

export function renameChatSession(id: string, name: string): ChatSessionInfo {
  const d = needDb();
  const cur = getChatSession(id);
  if (!cur) throw new Error("That session no longer exists.");
  const clean = (name || "").trim().slice(0, 60);
  if (!clean) throw new Error("Give the session a name — e.g. `rename session to Pipeline review`.");
  if (nameTaken(clean, id)) throw new Error(`There's already a session named "${clean}".`);
  d.query("UPDATE sessions SET name = ? WHERE id = ?").run(clean, id);
  return getChatSession(id)!;
}

/**
 * Delete a session and everything scoped to it (messages, uploads + files,
 * workspace pin, reminders). Refuses when it's the last session standing.
 */
export function deleteChatSession(id: string): { name: string; remaining: ChatSessionInfo[] } {
  const d = needDb();
  const cur = getChatSession(id);
  if (!cur) throw new Error("That session no longer exists.");
  const count = (d.query("SELECT COUNT(*) AS n FROM sessions").get() as any).n as number;
  if (count <= 1) throw new Error(`Can't delete "${cur.name}" — it's your only session.`);
  d.query("DELETE FROM messages WHERE session_id = ?").run(id);
  d.query("DELETE FROM uploads WHERE session = ?").run(id);
  d.query("DELETE FROM session_workspaces WHERE session_id = ?").run(id);
  d.query("DELETE FROM reminders WHERE session_id = ?").run(id);
  d.query("DELETE FROM sessions WHERE id = ?").run(id);
  if (uploadsRoot) {
    try { rmSync(`${uploadsRoot}/${id}`, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { name: cur.name, remaining: listChatSessions() };
}

export function touchChatSession(id: string): void {
  needDb().query("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?").run(id);
}

// ---- lookup: bare number (1-based into list order) or fuzzy name -------------------

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

export interface SessionMatch { info: ChatSessionInfo; score: number }

/**
 * Resolve a user's target to sessions. A bare number is a 1-based position in
 * the `sessions` list order and wins outright; otherwise fuzzy name matching.
 */
export function findChatSession(query: string): SessionMatch[] {
  const list = listChatSessions();
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const idx = Number(q) - 1;
    if (idx >= 0 && idx < list.length) return [{ info: list[idx], score: 100 }];
    return [];
  }
  // Raw session ids (e.g. from the REST API) match exactly, case-insensitively.
  const byId = list.find((s) => s.id.toLowerCase() === q.toLowerCase());
  if (byId) return [{ info: byId, score: 100 }];
  return list
    .map((info) => ({ info, score: scoreName(info.name, q) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.info.name.localeCompare(b.info.name));
}

/** "5m ago", "3h ago", "2d ago", or a short date for older. */
export function relTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse((iso || "").replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "—";
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

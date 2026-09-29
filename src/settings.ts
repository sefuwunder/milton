// settings.ts — F1: Milton-owned key/value settings in milton.db.
//
// Gate 0 foundation piece. `key TEXT PRIMARY KEY, value TEXT` — the single
// most load-bearing unbuilt piece: unlocks the planner's workday windows,
// the remind_add conflict window, the assign-tasks roster, my_contact_id,
// and the observer's run bookkeeping. Values are opaque strings; the JSON
// helpers cover structured settings without a second table.

import type { Database } from "bun:sqlite";

let db: Database | null = null;

export function initSettingsDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function needDb(): Database {
  if (!db) throw new Error("settings DB not initialized");
  return db;
}

/** Raw string value, or null when the key was never set. */
export function getSetting(key: string): string | null {
  const row = needDb().query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : null;
}

/** Insert or replace. Empty-string keys are rejected. */
export function setSetting(key: string, value: string): void {
  if (!key) throw new Error("settings key must not be empty");
  needDb().query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

/** Delete a key. Returns true when a row was removed. */
export function delSetting(key: string): boolean {
  const r = needDb().query("DELETE FROM settings WHERE key = ?").run(key);
  return r.changes > 0;
}

/** JSON-decoded value, or `fallback` when unset or unparseable. */
export function getSettingJSON<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Store any JSON-serializable value. */
export function setSettingJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

/** All settings as a plain object, keys sorted. Mostly for debugging. */
export function allSettings(): Record<string, string> {
  const rows = needDb().query("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

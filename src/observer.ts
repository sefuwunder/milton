// observer.ts — F2: the deal observer (Gate 0 foundation piece).
//
// Snapshots every deal's stage/value per workspace on each run and diffs
// against the previous snapshot:
//   - stage changed        -> a row in stage_transitions (from -> to, at)
//   - moved to closed_won/lost -> a terminal row in close_log, attributed to
//     the last open stage it was seen in (that's what forecast weights mean)
//   - first sighting       -> snapshot + a birth transition (from NULL)
//
// First run also backfills stage history from exec-crm's activity stream
// ("<title> moved to <stage name>" lines), joined on (workspace, exact
// title); ambiguous titles are dropped, never guessed. The snapshot differ
// remains the durable source — activities just shorten the cold start.
//
// Everything is Milton-owned tables in milton.db; exec-crm is only read
// over HTTP, never written. Deterministic: workspaces, deals, and events
// are always processed in sorted order.

import type { Database } from "bun:sqlite";
import * as crm from "./crm";
import { listWorkspaces, runWithWorkspace } from "./workspace";
import { getSetting, setSetting } from "./settings";

let db: Database | null = null;

export function initObserverDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS deal_snapshots (
      workspace_id INTEGER NOT NULL,
      deal_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      value REAL NOT NULL,
      updated_at TEXT NOT NULL,
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, deal_id)
    );
    CREATE TABLE IF NOT EXISTS stage_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      deal_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'diff'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_transitions_dedupe
      ON stage_transitions (workspace_id, deal_id, to_stage, at);
    CREATE TABLE IF NOT EXISTS close_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      deal_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('won','lost')),
      last_stage TEXT NOT NULL,
      value REAL NOT NULL,
      value_band TEXT NOT NULL,
      owner TEXT NOT NULL,
      industry TEXT NOT NULL,
      dwell_bucket TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_close_log_dedupe
      ON close_log (workspace_id, deal_id, closed_at);
  `);
}

function needDb(): Database {
  if (!db) throw new Error("observer DB not initialized");
  return db;
}

/** Stored workspace id: exec-crm ids are positive, so 0 = default workspace.
 *  (SQLite treats NULLs as distinct in UNIQUE/PK constraints, which would
 *  silently break INSERT OR IGNORE dedupe for the default workspace.) */
function wsid(ws: number | null): number {
  return ws === null ? 0 : ws;
}

// ---- pure helpers (exported for tests) ------------------------------------------

const TERMINAL: Record<string, "won" | "lost"> = { closed_won: "won", closed_lost: "lost" };

/** Value bands per the research spec: <1k, 1-10k, 10-50k, >50k. */
export function valueBand(v: number): string {
  if (v < 1000) return "<1k";
  if (v < 10000) return "1-10k";
  if (v < 50000) return "10-50k";
  return ">50k";
}

/** Dwell bucket relative to the stage median: <median/2, median-2x, >2x median. */
export function dwellBucketFor(dwellDays: number, medianDays: number | null): string {
  if (medianDays == null || medianDays <= 0) return "median-2xmedian";
  if (dwellDays < medianDays / 2) return "lt-half-median";
  if (dwellDays > medianDays * 2) return "gt-2xmedian";
  return "median-2xmedian";
}

/** Parse `"Acme deal moved to Negotiation"` -> { title, stageName }. Greedy
 *  title so a title containing " moved to " still splits on the last one. */
export function parseMoveActivity(text: string): { title: string; stageName: string } | null {
  const m = /^(.*) moved to (.+)$/.exec((text || "").trim());
  if (!m) return null;
  const title = m[1].trim(), stageName = m[2].trim();
  if (!title || !stageName) return null;
  return { title, stageName };
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, ms / 86400000);
}

// ---- report ---------------------------------------------------------------------

export interface ObserveReport {
  ok: boolean;
  reason?: string;
  workspaces: number;
  deals: number;
  snapshots: number;
  transitions: number;
  closes: number;
  backfilledTransitions: number;
  skippedAmbiguous: number;
  skippedStage: number;
  errors: string[];
}

// ---- internals ------------------------------------------------------------------

interface Snap { stage: string; value: number; updated_at: string; seen_at: string }

function getSnap(ws: number | null, dealId: number): Snap | null {
  return needDb().query(
    "SELECT stage, value, updated_at, seen_at FROM deal_snapshots WHERE workspace_id = ? AND deal_id = ?"
  ).get(wsid(ws), dealId) as Snap | null;
}

function putSnap(ws: number | null, dealId: number, stage: string, value: number, updatedAt: string): void {
  needDb().query(
    `INSERT INTO deal_snapshots (workspace_id, deal_id, stage, value, updated_at, seen_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (workspace_id, deal_id) DO UPDATE SET
       stage = excluded.stage, value = excluded.value,
       updated_at = excluded.updated_at, seen_at = datetime('now')`
  ).run(wsid(ws), dealId, stage, value, updatedAt);
}

function addTransition(ws: number | null, dealId: number, from: string | null, to: string, at: string, source: "diff" | "backfill"): boolean {
  const r = needDb().query(
    `INSERT OR IGNORE INTO stage_transitions
       (workspace_id, deal_id, from_stage, to_stage, at, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsid(ws), dealId, from, to, at, source);
  return r.changes > 0;
}

/** Median completed dwell (days) for a stage: for each deal, every entry
 *  into the stage ends at the deal's next transition (to any stage). */
function medianStageDwell(ws: number | null, stage: string): number | null {
  const rows = needDb().query(
    `SELECT deal_id, to_stage, at FROM stage_transitions
     WHERE workspace_id = ? ORDER BY deal_id, at, id`
  ).all(wsid(ws)) as { deal_id: number; to_stage: string; at: string }[];
  const dwells: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].to_stage !== stage) continue;
    const next = rows[i + 1];
    if (!next || next.deal_id !== rows[i].deal_id) continue;
    const d = daysBetween(rows[i].at, next.at);
    if (d > 0) dwells.push(d);
  }
  if (!dwells.length) return null;
  dwells.sort((a, b) => a - b);
  const mid = Math.floor(dwells.length / 2);
  return dwells.length % 2 ? dwells[mid] : (dwells[mid - 1] + dwells[mid]) / 2;
}

/** Last time the deal entered `stage` (transition or birth), or null. */
function lastStageEntryAt(ws: number | null, dealId: number, stage: string): string | null {
  const r = needDb().query(
    `SELECT at FROM stage_transitions
     WHERE workspace_id = ? AND deal_id = ? AND to_stage = ?
     ORDER BY at DESC, id DESC LIMIT 1`
  ).get(wsid(ws), dealId, stage) as { at: string } | null;
  return r ? r.at : null;
}

function logClose(
  ws: number | null, deal: crm.Deal, outcome: "won" | "lost",
  lastStage: string, industry: string, closedAt: string,
): boolean {
  const entryAt = lastStageEntryAt(ws, deal.id, lastStage) || deal.created_at || closedAt;
  const dwellDays = daysBetween(entryAt, closedAt);
  const bucket = dwellBucketFor(dwellDays, medianStageDwell(ws, lastStage));
  const r = needDb().query(
    `INSERT OR IGNORE INTO close_log
       (workspace_id, deal_id, title, closed_at, outcome, last_stage, value,
        value_band, owner, industry, dwell_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wsid(ws), deal.id, deal.title, closedAt, outcome, lastStage,
    deal.value, valueBand(deal.value), deal.owner || "", industry, bucket);
  return r.changes > 0;
}

/** Backfill stage history from exec-crm's activity stream (first run only). */
async function backfillWorkspace(ws: number | null): Promise<{ transitions: number; skippedAmbiguous: number; skippedStage: number }> {
  const out = { transitions: 0, skippedAmbiguous: 0, skippedStage: 0 };
  const { activities, deals, stages } = await runWithWorkspace(ws, async () => ({
    activities: await crm.getActivities(),
    deals: await crm.getDeals(),
    stages: await crm.getStages(),
  }));
  const nameToSlug = new Map<string, string>();
  for (const s of stages) {
    nameToSlug.set(s.name.trim().toLowerCase(), s.slug);
    nameToSlug.set(s.slug.trim().toLowerCase(), s.slug);
  }
  const byTitle = new Map<string, crm.Deal[]>();
  for (const d of deals) {
    const arr = byTitle.get(d.title) || [];
    arr.push(d);
    byTitle.set(d.title, arr);
  }
  const ordered = [...activities].sort((a, b) => a.id - b.id);
  for (const a of ordered) {
    if (a.kind !== "deal") continue;
    const parsed = parseMoveActivity(a.text);
    if (!parsed) continue;
    const slug = nameToSlug.get(parsed.stageName.toLowerCase());
    if (!slug) { out.skippedStage++; continue; }
    const matches = byTitle.get(parsed.title) || [];
    if (matches.length !== 1) { out.skippedAmbiguous++; continue; }
    const deal = matches[0];
    // A backfilled "moved to X" is a transition into X; the from-stage is
    // whatever the previous event/snapshot said — NULL keeps it honest.
    if (addTransition(ws, deal.id, null, slug, a.created_at, "backfill")) out.transitions++;
  }
  return out;
}

async function observeWorkspace(ws: number | null, rep: ObserveReport): Promise<void> {
  const { deals, companies } = await runWithWorkspace(ws, async () => ({
    deals: await crm.getDeals(),
    companies: await crm.getCompanies().catch(() => [] as crm.Company[]),
  }));
  const industryById = new Map<number, string>();
  for (const c of companies) industryById.set(c.id, c.industry || "");
  const ordered = [...deals].sort((a, b) => a.id - b.id);
  rep.deals += ordered.length;
  for (const deal of ordered) {
    const prev = getSnap(ws, deal.id);
    const terminal = TERMINAL[deal.stage];
    if (!prev) {
      putSnap(ws, deal.id, deal.stage, deal.value, deal.updated_at);
      rep.snapshots++;
      addTransition(ws, deal.id, null, deal.stage, deal.created_at || deal.updated_at, "diff");
      rep.transitions++;
      if (terminal) {
        // First sighting is already closed: attribute to backfilled last
        // stage when the backfill found one, else leave it unknown ("").
        const lastOpen = needDb().query(
          `SELECT to_stage AS s FROM stage_transitions
           WHERE workspace_id = ? AND deal_id = ? AND to_stage NOT IN ('closed_won','closed_lost')
           ORDER BY at DESC, id DESC LIMIT 1`
        ).get(wsid(ws), deal.id) as { s: string } | null;
        if (logClose(ws, deal, terminal, lastOpen ? lastOpen.s : "", industryById.get(deal.company_id || -1) || "", deal.updated_at)) rep.closes++;
      }
      continue;
    }
    if (prev.stage !== deal.stage) {
      if (addTransition(ws, deal.id, prev.stage, deal.stage, deal.updated_at, "diff")) rep.transitions++;
      putSnap(ws, deal.id, deal.stage, deal.value, deal.updated_at);
      rep.snapshots++;
      if (terminal && !TERMINAL[prev.stage]) {
        if (logClose(ws, deal, terminal, prev.stage, industryById.get(deal.company_id || -1) || "", deal.updated_at)) rep.closes++;
      }
    } else {
      // No change: refresh the seen marker so staleness is detectable.
      putSnap(ws, deal.id, deal.stage, deal.value, deal.updated_at);
    }
  }
}

/** One full observer pass over every workspace. Never throws for CRM
 *  outages — records them in the report and keeps going. */
export async function observeOnce(): Promise<ObserveReport> {
  const rep: ObserveReport = {
    ok: true, workspaces: 0, deals: 0, snapshots: 0, transitions: 0,
    closes: 0, backfilledTransitions: 0, skippedAmbiguous: 0, skippedStage: 0,
    errors: [],
  };
  needDb();
  let list: { id: number }[] | null;
  try {
    list = await listWorkspaces();
  } catch (e) {
    rep.ok = false;
    rep.reason = `workspace list failed: ${(e as Error).message}`;
    return rep;
  }
  if (!list) {
    rep.ok = false;
    rep.reason = "exec-crm unreachable";
    return rep;
  }
  const backfilled = getSetting("observer.backfilled_at");
  const workspaces: (number | null)[] = [null, ...list.map((w) => w.id).sort((a, b) => a - b)];
  for (const ws of workspaces) {
    try {
      if (!backfilled) {
        const b = await backfillWorkspace(ws);
        rep.backfilledTransitions += b.transitions;
        rep.skippedAmbiguous += b.skippedAmbiguous;
        rep.skippedStage += b.skippedStage;
      }
      await observeWorkspace(ws, rep);
      rep.workspaces++;
    } catch (e) {
      rep.errors.push(`workspace ${ws === null ? "default" : ws}: ${(e as Error).message}`);
    }
  }
  if (!backfilled) setSetting("observer.backfilled_at", new Date().toISOString());
  if (rep.errors.length && rep.workspaces === 0) rep.ok = false;
  return rep;
}

// ---- cadence gate ---------------------------------------------------------------

export const OBSERVER_INTERVAL_MS = 3600_000; // hourly snapshots; deals move slowly

/** Run observeOnce() at most once per OBSERVER_INTERVAL_MS. Safe to call
 *  from the 30s sweep: cheap settings read when idle, full pass when due. */
export async function maybeObserve(nowMs: number = Date.now()): Promise<{ ran: boolean; report?: ObserveReport }> {
  const last = Number(getSetting("observer.last_run_ms") || 0);
  if (nowMs - last < OBSERVER_INTERVAL_MS) return { ran: false };
  let report: ObserveReport;
  try {
    report = await observeOnce();
  } catch (e) {
    report = {
      ok: false, reason: `observer crashed: ${(e as Error).message}`,
      workspaces: 0, deals: 0, snapshots: 0, transitions: 0, closes: 0,
      backfilledTransitions: 0, skippedAmbiguous: 0, skippedStage: 0, errors: [],
    };
  }
  setSetting("observer.last_run_ms", String(Date.now()));
  return { ran: true, report };
}

// usability.ts — Milton's conversational memory, in one place:
//   1. entity mentions: the last entities discussed per session, so pronouns
//      ("it", "that deal", "her") resolve to the right record.
//   2. undo journal: the last mutations per session, each with an inverse op.
//   3. wizard state: multi-turn guided setup (new deal/contact/company/task).
//
// SQLite-backed once initUsabilityDb() runs (server boot). Until then a lazy
// in-memory fallback keeps everything working — unit tests that never boot
// the server exercise the same code paths without touching SQLite.

import type { Database } from "bun:sqlite";
import { parseMoney, parseDate } from "./intents";

let db: Database | null = null;

export function initUsabilityDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_session ON mentions (session_id, id);
    CREATE TABLE IF NOT EXISTS undo_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      inverse TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_undo_session ON undo_journal (session_id, id);
    CREATE TABLE IF NOT EXISTS wizards (
      session_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ---- in-memory fallback (no initUsabilityDb yet) -------------------------------
interface Mention { entity_type: string; entity_id: number; name: string }
const memMentions = new Map<string, Mention[]>();
interface UndoEntry { label: string; inverse: any }
const memUndo = new Map<string, UndoEntry[]>();
export interface WizardState { kind: string; step: number; data: Record<string, string> }
const memWizards = new Map<string, WizardState>();

const MAX_MENTIONS = 10;
const MAX_UNDO = 20;

// ---- 1. mentions ----------------------------------------------------------------
export function trackMention(sessionId: string, entityType: string, entityId: number, name: string): void {
  if (!name) return;
  if (db) {
    const d = db;
    d.query("INSERT INTO mentions (session_id, entity_type, entity_id, name) VALUES (?, ?, ?, ?)")
      .run(sessionId, entityType, entityId, name);
    // keep the last MAX_MENTIONS per session
    d.query(`DELETE FROM mentions WHERE session_id = ? AND id NOT IN (
      SELECT id FROM mentions WHERE session_id = ? ORDER BY id DESC LIMIT ${MAX_MENTIONS}
    )`).run(sessionId, sessionId);
    return;
  }
  const list = memMentions.get(sessionId) || [];
  // re-mentioning bumps to the front; same entity isn't duplicated
  const rest = list.filter((m) => !(m.entity_type === entityType && m.entity_id === entityId));
  rest.unshift({ entity_type: entityType, entity_id: entityId, name });
  memMentions.set(sessionId, rest.slice(0, MAX_MENTIONS));
}

export function latestMention(sessionId: string, entityType: string): Mention | null {
  if (db) {
    const row = db.query(
      "SELECT entity_type, entity_id, name FROM mentions WHERE session_id = ? AND entity_type = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId, entityType) as Mention | undefined;
    return row || null;
  }
  return (memMentions.get(sessionId) || []).find((m) => m.entity_type === entityType) || null;
}

// ---- 2. undo journal ---------------------------------------------------------------
export function pushUndo(sessionId: string, label: string, inverse: any): void {
  if (db) {
    const d = db;
    d.query("INSERT INTO undo_journal (session_id, label, inverse) VALUES (?, ?, ?)")
      .run(sessionId, label, JSON.stringify(inverse));
    d.query(`DELETE FROM undo_journal WHERE session_id = ? AND id NOT IN (
      SELECT id FROM undo_journal WHERE session_id = ? ORDER BY id DESC LIMIT ${MAX_UNDO}
    )`).run(sessionId, sessionId);
    return;
  }
  const list = memUndo.get(sessionId) || [];
  list.push({ label, inverse });
  memUndo.set(sessionId, list.slice(-MAX_UNDO));
}

/** Pop the most recent journal entry. Undo is never journaled (no redo). */
export function popUndo(sessionId: string): UndoEntry | null {
  if (db) {
    const row = db.query(
      "SELECT id, label, inverse FROM undo_journal WHERE session_id = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId) as any;
    if (!row) return null;
    db.query("DELETE FROM undo_journal WHERE id = ?").run(row.id);
    try {
      return { label: row.label, inverse: JSON.parse(row.inverse) };
    } catch {
      return null;
    }
  }
  const list = memUndo.get(sessionId) || [];
  const e = list.pop();
  return e || null;
}

export function undoDepth(sessionId: string): number {
  if (db) {
    const row = db.query("SELECT COUNT(*) AS n FROM undo_journal WHERE session_id = ?").get(sessionId) as any;
    return Number(row?.n || 0);
  }
  return (memUndo.get(sessionId) || []).length;
}

// ---- 3. wizards --------------------------------------------------------------------
export interface WizardSlot {
  key: string;
  prompt: string;
  def: string; // default shown in the prompt; "" means required
  required: boolean;
  validate: (raw: string) => { value?: string; error?: string };
}

export interface WizardDef {
  kind: string;
  title: string;
  intro: string;
  slots: WizardSlot[];
}

const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;
const optText = (raw: string) => ({ value: raw.trim() });
const reqText = (raw: string) =>
  raw.trim() ? { value: raw.trim() } : { error: "I need a value here — what should it be?" };
const optMoney = (raw: string) => {
  const t = raw.trim().toLowerCase();
  if (!t || t === "none" || t === "0") return { value: "" };
  const v = parseMoney(raw);
  return v === null ? { error: `"${raw.trim()}" doesn't look like an amount — try e.g. "50k".` } : { value: String(v) };
};
const optDate = (raw: string) => {
  const t = raw.trim().toLowerCase();
  if (!t || t === "none") return { value: "" };
  const d = parseDate(raw);
  return d ? { value: d } : { error: `"${raw.trim()}" doesn't look like a date — try "Friday" or "2026-10-02".` };
};
const optEmail = (raw: string) => {
  const t = raw.trim();
  if (!t || t.toLowerCase() === "none") return { value: "" };
  return EMAIL_RE.test(t) ? { value: t } : { error: `"${t}" doesn't look like an email address.` };
};

function slot(key: string, prompt: string, def: string, validate: WizardSlot["validate"]): WizardSlot {
  return { key, prompt, def, required: !def, validate };
}

export const WIZARDS: Record<string, WizardDef> = {
  deal: {
    kind: "deal", title: "New deal", intro: "Let's set up the deal — one question at a time.",
    slots: [
      slot("title", "What's the deal called?", "", reqText),
      slot("value", "What's it worth?", "0", optMoney),
      slot("company", "Which company is it for?", "none", optText),
      slot("close", "Expected close date?", "none", optDate),
    ],
  },
  contact: {
    kind: "contact", title: "New contact", intro: "Let's add the contact — one question at a time.",
    slots: [
      slot("name", "What's their name?", "", reqText),
      slot("company", "Which company are they at?", "none", optText),
      slot("email", "Email address?", "none", optEmail),
      slot("phone", "Phone number?", "none", optText),
    ],
  },
  company: {
    kind: "company", title: "New company", intro: "Let's add the company.",
    slots: [
      slot("name", "What's the company called?", "", reqText),
      slot("industry", "What industry?", "none", optText),
      slot("website", "Website?", "none", optText),
    ],
  },
  task: {
    kind: "task", title: "New task", intro: "Let's add the task — one question at a time.",
    slots: [
      slot("title", "What's the task?", "", reqText),
      slot("due", "When is it due?", "none", optDate),
      slot("deal", "Link it to a deal?", "none", optText),
    ],
  },
};

export interface WizardMsg { text: string; chips: string[] }

export function wizardPrompt(wiz: WizardState): WizardMsg {
  const def = WIZARDS[wiz.kind];
  const s = def.slots[wiz.step];
  const head = wiz.step === 0 ? `**${def.title}** — ${def.intro}\n\n` : "";
  const defNote = s.def ? ` (default: ${s.def})` : "";
  return {
    text: `${head}**${wiz.step + 1} of ${def.slots.length}** — ${s.prompt}${defNote}\n\nType \`skip\` for the default, \`cancel\` to stop.`,
    chips: s.def ? ["Skip", "Cancel"] : ["Cancel"],
  };
}

export function getWizard(sessionId: string): WizardState | null {
  if (db) {
    const row = db.query("SELECT kind, step, data FROM wizards WHERE session_id = ?").get(sessionId) as any;
    if (!row) return null;
    try {
      return { kind: row.kind, step: row.step, data: JSON.parse(row.data || "{}") };
    } catch {
      return null;
    }
  }
  return memWizards.get(sessionId) || null;
}

export function setWizard(sessionId: string, wiz: WizardState): void {
  if (db) {
    db.query(`INSERT INTO wizards (session_id, kind, step, data, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, step = excluded.step,
      data = excluded.data, updated_at = datetime('now')`)
      .run(sessionId, wiz.kind, wiz.step, JSON.stringify(wiz.data));
    return;
  }
  memWizards.set(sessionId, { ...wiz, data: { ...wiz.data } });
}

export function clearWizard(sessionId: string): void {
  if (db) { db.query("DELETE FROM wizards WHERE session_id = ?").run(sessionId); return; }
  memWizards.delete(sessionId);
}

export interface WizardTurn {
  finished: boolean;
  reply?: WizardMsg;
  kind?: string;
  slots?: Record<string, string>;
}

/** Feed one user reply into the active wizard. "__skip__" takes the default. */
export function wizardAnswer(sessionId: string, wiz: WizardState, raw: string): WizardTurn {
  const def = WIZARDS[wiz.kind];
  if (!def) { clearWizard(sessionId); return { finished: false, reply: { text: "I lost track of that wizard — let's start over.", chips: [] } }; }
  const s = def.slots[wiz.step];
  const data = { ...wiz.data };
  if (raw === "__skip__") {
    if (s.required) {
      return { finished: false, reply: { text: `I need an answer here — ${s.prompt.toLowerCase()}`, chips: ["Cancel"] } };
    }
    data[s.key] = "";
  } else {
    const v = s.validate(raw);
    if (v.error) {
      return {
        finished: false,
        reply: {
          text: `${v.error}\n\n**${wiz.step + 1} of ${def.slots.length}** — ${s.prompt}${s.def ? ` (default: ${s.def})` : ""}`,
          chips: s.def ? ["Skip", "Cancel"] : ["Cancel"],
        },
      };
    }
    data[s.key] = v.value || "";
  }
  const next = wiz.step + 1;
  if (next >= def.slots.length) {
    return { finished: true, kind: wiz.kind, slots: data };
  }
  const nw = { kind: wiz.kind, step: next, data };
  setWizard(sessionId, nw);
  return { finished: false, reply: wizardPrompt(nw) };
}

// ---- pronoun resolution --------------------------------------------------------------
// Maps intents to the entity-carrying slot + the mention type it needs.
// "it/that/them/him/her/this deal/the contact/…" resolve to the most recent
// mention of that type; anything else (including cross-type guesses) is left
// alone and reported as missing instead of guessed.
const PRONOUN_RE = /^(it|that|this|these|those|them|they|him|her|his|hers|its|theirs?|that deal|this deal|the deal|that contact|this contact|the contact|that company|this company|the company|that task|this task|the task)$/i;

const PRONOUN_SLOTS: Record<string, { slot: string; type: string }[]> = {
  deal_detail: [{ slot: "query", type: "deal" }],
  move_deal: [{ slot: "query", type: "deal" }],
  close_deal: [{ slot: "query", type: "deal" }],
  delete_deal: [{ slot: "query", type: "deal" }],
  set_deal_field: [{ slot: "query", type: "deal" }],
  deal_journey: [{ slot: "query", type: "deal" }],
  add_note: [{ slot: "query", type: "deal" }, { slot: "rest", type: "deal" }],
  contact_detail: [{ slot: "query", type: "contact" }],
  complete_task: [{ slot: "query", type: "task" }],
  reopen_task: [{ slot: "query", type: "task" }],
  delete_task: [{ slot: "query", type: "task" }],
  task_blockers: [{ slot: "query", type: "task" }],
  companies: [{ slot: "search", type: "company" }],
  add_task: [{ slot: "deal", type: "deal" }],
};

export interface PronounResult { intent: any; missing?: string }

/** Replace pronoun/demonstrative entity slots with the latest mention name. */
export function applyPronouns(sessionId: string, intent: any): PronounResult {
  const maps = PRONOUN_SLOTS[intent.name];
  if (!maps) return { intent };
  for (const { slot, type } of maps) {
    const val = (intent.slots?.[slot] || "").trim();
    if (!val || !PRONOUN_RE.test(val)) continue;
    const m = latestMention(sessionId, type);
    if (!m) return { intent, missing: type };
    intent.slots[slot] = m.name;
    intent.pronounResolved = true;
  }
  return { intent };
}

// ---- test helper: reset the in-memory fallback between cases -------------------------
export function __resetMemory(): void {
  memMentions.clear();
  memUndo.clear();
  memWizards.clear();
}

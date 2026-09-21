// slash-commands.test.ts — a leading "/" never changes a command:
//
//   - "/help" ≡ "help" through the full handleMessage funnel
//   - "/save routine X: /kpis" saves (covers the re-parse of opts.raw in
//     saveRoutineReply, which re-matches with a ^-anchored regex)
//   - "/switch to <workspace>" forks a fresh bound session (re-parse in
//     switchWorkspaceReply)
//   - "/meridian dossier <q>" reaches the dossier path (re-parse in
//     meridianDossierReply)
//   - a lone "/" is just unknown, not a crash
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as auto from "../src/automation";
import * as wss from "../src/workspace";
import * as chats from "../src/chat_sessions";
import * as mer from "../src/meridian";
import { initDealNotesDb } from "../src/deal_notes";
import { parseIntent } from "../src/intents";
import { handleMessage, type Session } from "../src/brain";

const stubWorkspaces = [
  { id: 1, name: "Main", color: "#579bfc" },
  { id: 2, name: "Acme Corp", color: "#ff0000" },
];

const stubRecon = {
  id: "r1", city: "Austin", country: "US", status: "done",
  created_at: "2026-09-18 10:00:00", updated_at: "2026-09-18 12:00:00",
  facts: { population: "974,447" }, sources: [], nodes: [
    { id: "n1", label: "Acme Corp", type: "org", source: "news", detail: "Holding company" },
  ], edges: [],
};

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  wss.initWorkspaceDb(new Database(":memory:"));
  const csdb = new Database(":memory:");
  csdb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE uploads (id TEXT PRIMARY KEY, session TEXT NOT NULL, filename TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE session_workspaces (session_id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL,
    workspace_name TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    text TEXT NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')), fired_at TEXT);`);
  chats.initChatSessionDb(csdb);
  wss.clearWorkspaceCache();
  mer.clearReconCache();
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    const ok = (data: any) =>
      Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url.startsWith(mer.meridianBase())) {
      const path = url.slice(mer.meridianBase().length).split("?")[0];
      if (path === "/api/recon") return ok({ recons: [stubRecon] });
      if (path === "/api/recon/r1") return ok({ recon: stubRecon });
      return ok({});
    }
    if (url.includes("/api/workspaces")) return ok({ workspaces: stubWorkspaces });
    return realFetch(input);
  };
});
afterAll(() => { (globalThis as any).fetch = realFetch; });

const sess = (id: string): Session => ({ id, history: [], notes: [] });

describe("slash-prefixed commands through handleMessage", () => {
  test('"/help" returns the help text, identical to "help"', async () => {
    const a = await handleMessage(sess("slash-help-1"), "/help");
    const b = await handleMessage(sess("slash-help-2"), "help");
    expect(a.text).toContain("Milton — what I can do");
    expect(a.text).toContain("leading slash");
    expect(a.text).toBe(b.text);
  });

  test('"/save routine X: /kpis" saves (covers the ^-anchored re-parse)', async () => {
    const r = await handleMessage(sess("slash-save-1"), "/save routine slashrt: /kpis");
    expect(r.text).toMatch(/Saved routine \*\*slashrt\*\*/);
    const saved = auto.getRoutine("slashrt");
    expect(saved).toBeTruthy();
    expect(saved!.steps).toEqual(["/kpis"]);
    // and the saved slash step parses to the same intent (confirmation gating sees it)
    expect(parseIntent("/kpis").name).toBe(parseIntent("kpis").name);
  });

  test('"/switch to Acme Corp" forks a fresh bound session, like the bare form', async () => {
    const s = sess("slash-sw-1");
    const r = await handleMessage(s, "/switch to Acme Corp");
    expect(r.text).toMatch(/fresh session/i);
    expect(r.activeSession).toBeTruthy();
    expect(r.activeSession!.id).not.toBe("slash-sw-1");
    // the origin session keeps its (default) workspace — no commingling
    expect(wss.getSessionWorkspace("slash-sw-1")).toEqual({ id: null, name: "" });
  });

  test('"/meridian dossier Austin" reaches the dossier path', async () => {
    const r = await handleMessage(sess("slash-mer-1"), "/meridian dossier Austin");
    expect(r.text).toContain("Recon: Austin");
  });

  test('a lone "/" is unknown, not a crash', async () => {
    const r = await handleMessage(sess("slash-lone-1"), "/");
    expect(typeof r.text).toBe("string");
    expect(r.text.length).toBeGreaterThan(0);
  });
});

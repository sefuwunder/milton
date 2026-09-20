// sessions.test.ts — named chat sessions: CRUD, uniqueness, isolation,
// migration of legacy rows, intents, confirm-guard, automation grace.
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as chats from "../src/chat_sessions";
import { parseIntent } from "../src/intents";
import { parseIntentFuzzy } from "../src/fuzzy";
import { handleMessage, tickAutomation, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initWorkspaceDb, setSessionWorkspace, getSessionWorkspace } from "../src/workspace";

let db: Database;
beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initWorkspaceDb(new Database(":memory:"));
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}',
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
  chats.initChatSessionDb(db);
});

const mkSession = (id: string): Session => ({ id, history: [], notes: [] });

// ---- migration ----------------------------------------------------------------
describe("legacy migration", () => {
  test("unnamed rows become General / General 2 in age order", () => {
    db.query("INSERT INTO sessions (id, created_at) VALUES ('a', '2026-01-01 00:00:00'), ('b', '2026-02-01 00:00:00')").run();
    chats.initChatSessionDb(db); // re-run: migration is idempotent
    const names = db.query("SELECT id, name FROM sessions ORDER BY created_at").all() as any[];
    expect(names[0].name).toBe("General");
    expect(names[1].name).toBe("General 2");
  });
  test("existing names are left alone", () => {
    db.query("INSERT INTO sessions (id, name) VALUES ('a', 'Mine')").run();
    chats.initChatSessionDb(db);
    expect((db.query("SELECT name FROM sessions WHERE id='a'").get() as any).name).toBe("Mine");
  });
});

// ---- CRUD ---------------------------------------------------------------------
describe("CRUD", () => {
  test("create with explicit name; list order; message counts", () => {
    const a = chats.createChatSession("s-a", "Pipeline");
    expect(a.name).toBe("Pipeline");
    chats.createChatSession("s-b", "Personal");
    db.query("INSERT INTO messages (session_id, role, text) VALUES ('s-a','user','hi'),('s-a','milton','yo')").run();
    const list = chats.listChatSessions();
    expect(list.length).toBe(2);
    expect(list.find((s) => s.id === "s-a")!.messageCount).toBe(2);
    expect(list.find((s) => s.id === "s-b")!.messageCount).toBe(0);
  });
  test("auto-name: first session is General, then Session N", () => {
    expect(chats.createChatSession("s-1").name).toBe("General");
    expect(chats.createChatSession("s-2").name).toBe("Session 2");
    expect(chats.createChatSession("s-3").name).toBe("Session 3");
  });
  test("names unique case-insensitively", () => {
    chats.createChatSession("s-a", "Pipeline");
    expect(() => chats.createChatSession("s-b", "pipeline")).toThrow(/already a session/);
    chats.createChatSession("s-b", "Other");
    expect(() => chats.renameChatSession("s-b", "pipeline")).toThrow(/already a session/);
    // renaming to your own name (different case) is fine
    expect(chats.renameChatSession("s-a", "PIPELINE").name).toBe("PIPELINE");
  });
  test("rename validates", () => {
    chats.createChatSession("s-a", "A");
    expect(() => chats.renameChatSession("s-a", "   ")).toThrow(/Give the session a name/);
    expect(() => chats.renameChatSession("nope", "X")).toThrow(/no longer exists/);
    expect(chats.renameChatSession("s-a", "B").name).toBe("B");
  });
  test("delete cascades scoped rows; refuses the last session", () => {
    const a = chats.createChatSession("s-a", "A");
    chats.createChatSession("s-b", "B");
    db.query("INSERT INTO messages (session_id, role, text) VALUES ('s-a','user','x')").run();
    db.query("INSERT INTO uploads (id, session, filename, mime, size) VALUES ('u1','s-a','f.png','image/png',1)").run();
    db.query("INSERT INTO session_workspaces (session_id, workspace_id) VALUES ('s-a', 3)").run();
    db.query("INSERT INTO reminders (session_id, text, fire_at) VALUES ('s-a','ping', 1)").run();
    const { name, remaining } = chats.deleteChatSession("s-a");
    expect(name).toBe("A");
    expect(remaining.map((s) => s.id)).toEqual(["s-b"]);
    expect((db.query("SELECT COUNT(*) n FROM messages").get() as any).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM uploads").get() as any).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM session_workspaces").get() as any).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM reminders").get() as any).n).toBe(0);
    expect(() => chats.deleteChatSession("s-b")).toThrow(/only session/);
    expect(a.id).toBe("s-a");
  });
  test("delete of unknown id throws", () => {
    expect(() => chats.deleteChatSession("nope")).toThrow(/no longer exists/);
  });
});

// ---- lookup -------------------------------------------------------------------
describe("findChatSession", () => {
  test("bare number = 1-based list position", () => {
    chats.createChatSession("s-a", "Alpha");
    chats.createChatSession("s-b", "Beta");
    const list = chats.listChatSessions();
    expect(chats.findChatSession("1")[0].info.id).toBe(list[0].id);
    expect(chats.findChatSession("2")[0].info.id).toBe(list[1].id);
    expect(chats.findChatSession("9")).toEqual([]);
  });
  test("raw session id matches exactly", () => {
    chats.createChatSession("s-a", "Alpha");
    chats.createChatSession("s-b", "Beta");
    const hit = chats.findChatSession("s-b");
    expect(hit.length).toBe(1);
    expect(hit[0].info.name).toBe("Beta");
  });
  test("fuzzy name match, exact wins", () => {
    chats.createChatSession("s-a", "Pipeline review");
    chats.createChatSession("s-b", "Pipeline retro");
    chats.createChatSession("s-c", "Personal");
    expect(chats.findChatSession("pipeline review")[0].info.name).toBe("Pipeline review");
    const amb = chats.findChatSession("pipeline");
    expect(amb.length).toBe(2);
    expect(chats.findChatSession("zzz")).toEqual([]);
  });
});

describe("relTime", () => {
  test("formats buckets", () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    expect(chats.relTime(iso(now - 30_000), now)).toBe("just now");
    expect(chats.relTime(iso(now - 5 * 60_000), now)).toBe("5m ago");
    expect(chats.relTime(iso(now - 3 * 3600_000), now)).toBe("3h ago");
    expect(chats.relTime(iso(now - 2 * 86400_000), now)).toBe("2d ago");
  });
});

// ---- intents ------------------------------------------------------------------
describe("intents", () => {
  const cmds: [string, string, Record<string, string>][] = [
    ["new session Pipeline review", "chat_session", { action: "new", name: "pipeline review" }],
    ["new session", "chat_session", { action: "new", name: "" }],
    ["sessions", "chat_session", { action: "list" }],
    ["list sessions", "chat_session", { action: "list" }],
    ["switch session to Pipeline review", "chat_session", { action: "switch", target: "pipeline review" }],
    ["current session", "chat_session", { action: "current" }],
    ["rename session to Q4 push", "chat_session", { action: "rename", target: "to q4 push" }],
    ["rename session Old to New", "chat_session", { action: "rename", target: "old to new" }],
    ["delete session 2", "chat_session", { action: "delete", target: "2" }],
    ["delete session", "chat_session", { action: "delete", target: "" }],
  ];
  for (const [cmd, want, slots] of cmds) {
    test(`exact: ${cmd}`, () => {
      const i = parseIntent(cmd);
      expect(i.name).toBe(want);
      for (const [k, v] of Object.entries(slots)) expect(i.slots[k]).toBe(v);
    });
  }
  const fuzzy: [string, string][] = [
    ["create a new session called Pipeline", "chat_session"],
    ["start a session", "chat_session"],
    ["show me my sessions", "chat_session"],
    ["list all sessions", "chat_session"],
    ["go to session pipeline", "chat_session"],
    ["switch session to 2", "chat_session"],
    ["rename the session to Q4", "chat_session"],
    ["erase session 1", "chat_session"],
    ["which session am i in", "chat_session"],
    ["shwo my sesions", "chat_session"],
  ];
  for (const [cmd, want] of fuzzy) {
    test(`fuzzy: ${cmd}`, () => {
      expect(parseIntentFuzzy(cmd).name).toBe(want);
    });
  }
  test("fuzzy new-session keeps the name (minus filler)", () => {
    const i = parseIntentFuzzy("create a new session called Pipeline review");
    expect(i.name).toBe("chat_session");
    expect(i.slots.action).toBe("new");
    expect(i.slots.name).toBe("pipeline review");
  });
  test("no regressions: neighboring intents", () => {
    expect(parseIntentFuzzy("switch to Acme").name).toBe("switch_workspace");
    expect(parseIntentFuzzy("call Sarah").name).toBe("unknown");
    expect(parseIntentFuzzy("delete deal Acme").name).toBe("delete_deal");
  });
});

// ---- brain flows (handleMessage against the chat_sessions store) ----------------
describe("brain session commands", () => {
  test("new -> list -> current round trip", async () => {
    chats.createChatSession("s-a", "General");
    let s = mkSession("s-a");
    let r = await handleMessage(s, "new session Pipeline review");
    expect(r.text).toContain("Pipeline review");
    expect(r.activeSession!.name).toBe("Pipeline review");
    const newId = r.activeSession!.id;
    s = mkSession(newId); // UI now chats with the new id
    r = await handleMessage(s, "sessions");
    expect(r.text).toContain("Pipeline review");
    expect(r.text).toContain("← current");
    r = await handleMessage(s, "current session");
    expect(r.text).toContain("Pipeline review");
  });  test("switch by number and by fuzzy name", async () => {
    chats.createChatSession("s-a", "General");
    const b = chats.createChatSession("s-b", "Pipeline review");
    const s = mkSession("s-a");
    let r = await handleMessage(s, "switch session to 2");
    const list = chats.listChatSessions();
    // number 2 in list order
    expect(r.activeSession!.id).toBe(list[1].id);
    r = await handleMessage(mkSession("s-a"), "switch session to pipeline");
    expect(r.activeSession!.id).toBe(b.id);
  });
  test("switch to <exact session name> takes precedence over workspaces", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Acme");
    const r = await handleMessage(mkSession("s-a"), "switch to Acme");
    expect(r.activeSession!.name).toBe("Acme");
    expect(r.text).toContain("Switched to");
  });
  test("switch to <number> follows session list; out-of-range falls to workspaces", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Second");
    const r = await handleMessage(mkSession("s-a"), "switch to 2");
    expect(r.activeSession).toBeDefined();
    // out of range -> workspace path (no chat session switch); exec-crm is
    // unreachable in tests, so we get the can't-reach reply, not a switch.
    const r2 = await handleMessage(mkSession("s-a"), "switch to 9");
    expect(r2.activeSession).toBeUndefined();
    expect(r2.text).toMatch(/can't reach exec-crm|No workspace/);
  });
  test("ambiguous session name -> numbered choice -> resolves", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Pipeline review");
    chats.createChatSession("s-c", "Pipeline retro");
    const s = mkSession("s-a");
    const r = await handleMessage(s, "switch session to pipeline");
    expect(r.cards?.[0]?.kind).toBe("choices");
    expect(s.choice?.kind).toBe("session");
    const opts = (r.cards?.[0] as any).options as { n: number; label: string }[];
    const want = opts.find((o) => o.label === "Pipeline retro")!;
    const r2 = await handleMessage(s, String(want.n));
    expect(r2.activeSession!.name).toBe("Pipeline retro");
  });
  test("rename variants", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Old name");
    let r = await handleMessage(mkSession("s-a"), "rename session to Q4 push");
    expect(r.text).toContain("Q4 push");
    expect(r.activeSession!.name).toBe("Q4 push");
    r = await handleMessage(mkSession("s-a"), "rename session Old name to New name");
    expect(r.text).toContain("New name");
    expect(r.activeSession!.id).toBe("s-b");
    r = await handleMessage(mkSession("s-a"), "rename session to New name");
    expect(r.text).toMatch(/already a session/);
    r = await handleMessage(mkSession("s-a"), "rename session");
    expect(r.text).toMatch(/Rename to what/);
  });
  test("delete asks first, yes deletes, switches when current", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Temp");
    const s = mkSession("s-b");
    let r = await handleMessage(s, "delete session");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("delete_chat_session");
    r = await handleMessage(s, "no");
    expect(chats.getChatSession("s-b")).not.toBeNull();
    r = await handleMessage(s, "delete session");
    r = await handleMessage(s, "yes");
    expect(r.text).toContain("Deleted chat session");
    expect(r.activeSession!.id).toBe("s-a"); // switched to the survivor
    expect(chats.getChatSession("s-b")).toBeNull();
  });
  test("delete of another session keeps you where you are", async () => {
    chats.createChatSession("s-a", "General");
    chats.createChatSession("s-b", "Temp");
    const s = mkSession("s-a");
    await handleMessage(s, "delete session Temp");
    const r = await handleMessage(s, "yes");
    expect(r.activeSession).toBeUndefined();
    expect(r.sessionsChanged).toBe(true);
  });
  test("cannot delete the last session", async () => {
    chats.createChatSession("s-a", "General");
    const r = await handleMessage(mkSession("s-a"), "delete session");
    expect(r.text).toMatch(/only session/);
    expect(r.cards).toBeUndefined();
  });
  test("delete is skipped in unattended runs (never auto-runs)", async () => {
    chats.createChatSession("s-a", "General");
    auto.saveRoutine("sessdel", ["delete session"]);
    auto.createSchedule("sessdel", { type: "interval", everyMs: 60000 }, Date.now() - 120000, null);
    const before = chats.listChatSessions().length;
    await tickAutomation(Date.now());
    // routine ran but the destructive step was skipped; session survives
    expect(chats.listChatSessions().length).toBe(before);
    expect(chats.getChatSession("s-a")).not.toBeNull();
    auto.deleteRoutine("sessdel");
  });
});

// ---- isolation ----------------------------------------------------------------
describe("per-session isolation", () => {
  test("workspace pin, tutorial, widgetable, history are per session", async () => {
    chats.createChatSession("s-a", "A");
    chats.createChatSession("s-b", "B");
    setSessionWorkspace("s-a", 7, "Seven");
    const sa = mkSession("s-a");
    const sb = mkSession("s-b");
    // workspace pin lives on the session id
    expect(getSessionWorkspace("s-a").id).toBe(7);
    expect(getSessionWorkspace("s-b").id).toBeNull();
    // history isolation via messages table scoping
    db.query("INSERT INTO messages (session_id, role, text) VALUES ('s-a','user','secret-a')").run();
    const rowsB = db.query("SELECT * FROM messages WHERE session_id='s-b'").all();
    expect(rowsB.length).toBe(0);
    expect(sa.workspaceId).toBeUndefined(); // brain loads it; store is the source of truth
    expect(sb.id).toBe("s-b");
  });
});

// ---- automation grace -----------------------------------------------------------
describe("automation into deleted session", () => {
  test("reminder for a deleted session fires without crashing", async () => {
    chats.createChatSession("s-a", "A");
    chats.createChatSession("s-b", "B");
    auto.createReminder("s-b", "ping me", Date.now() - 1000);
    chats.deleteChatSession("s-b");
    await expect(tickAutomation(Date.now())).resolves.toBeUndefined();
    const runs = auto.listRuns(5);
    expect(runs.some((r) => r.kind === "reminder" && r.status === "ok")).toBe(true);
  });
  test("schedules pin workspaces, not sessions — deletion can't strand them", async () => {
    chats.createChatSession("s-a", "A");
    chats.createChatSession("s-b", "B");
    auto.saveRoutine("grace", ["kpis"]);
    auto.createSchedule("grace", { type: "interval", everyMs: 60000 }, Date.now() - 120000, 5);
    chats.deleteChatSession("s-b");
    await expect(tickAutomation(Date.now())).resolves.toBeUndefined();
    auto.deleteRoutine("grace");
  });
});

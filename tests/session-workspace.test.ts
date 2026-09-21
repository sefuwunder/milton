// session-workspace.test.ts — one workspace per session, enforced:
//
//   - switching workspaces never re-scopes the current session: it starts a
//     fresh session bound to the target workspace and returns it as
//     activeSession; the originating session keeps its workspace and history.
//   - switching to the workspace the session is already bound to is a no-op.
//   - "new session" inherits the current session's workspace.
//   - session management: rename renames, delete removes messages, the last
//     remaining session cannot be deleted.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as auto from "../src/automation";
import * as wss from "../src/workspace";
import * as chats from "../src/chat_sessions";
import { handleMessage, type Session } from "../src/brain";

const stubWorkspaces = [
  { id: 1, name: "Main", color: "#579bfc" },
  { id: 2, name: "Acme Corp", color: "#ff0000" },
];

let memDb: Database;
const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  wss.initWorkspaceDb(new Database(":memory:"));
  const csdb = memDb = new Database(":memory:");
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
  (globalThis as any).fetch = async (input: any) =>
    new Response(JSON.stringify(String(input).includes("/api/workspaces") ? { workspaces: stubWorkspaces } : {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
});
afterAll(() => { (globalThis as any).fetch = realFetch; });

const sess = (id: string, workspaceId: number | null = null): Session =>
  ({ id, history: [], notes: [], workspaceId, workspaceName: workspaceId === 2 ? "Acme Corp" : "" }) as Session;

describe("one workspace per session", () => {
  test("switching workspace forks a fresh bound session; the origin is untouched", async () => {
    const s = sess("sws-1"); // default workspace
    const r = await handleMessage(s, "switch to Acme Corp");
    expect(r.text).toMatch(/fresh session/i);
    const freshId = r.activeSession!.id;
    expect(freshId).not.toBe("sws-1");
    // the originating session keeps its workspace and any history
    expect(wss.getSessionWorkspace("sws-1")).toEqual({ id: null, name: "" });
    // the fresh session is bound to the target workspace
    expect(wss.getSessionWorkspace(freshId)).toEqual({ id: 2, name: "Acme Corp" });
  });

  test("re-switching to the bound workspace is a no-op", async () => {
    const s = sess("sws-2", 2);
    const r = await handleMessage(s, "switch to Acme Corp");
    expect(r.text).toMatch(/Already in/);
    expect(r.activeSession).toBeUndefined();
  });

  test("new session inherits the current session's workspace", async () => {
    const s = sess("sws-3", 2);
    const r = await handleMessage(s, "new session Prospect review");
    expect(r.text).toContain("Prospect review");
    const nid = r.activeSession!.id;
    expect(nid).not.toBe("sws-3");
    expect(wss.getSessionWorkspace(nid)).toEqual({ id: 2, name: "Acme Corp" });
    expect(r.text).toContain("Acme Corp");
  });

  test("new session in the default workspace stays unbound", async () => {
    const s = sess("sws-4");
    const r = await handleMessage(s, "new session Plain session");
    const nid = r.activeSession!.id;
    expect(wss.getSessionWorkspace(nid)).toEqual({ id: null, name: "" });
  });

  test("session list shows each session's workspace", async () => {
    const s = sess("sws-5", 2);
    const r1 = await handleMessage(s, "new session Acme notes");
    const r = await handleMessage(s, "sessions");
    expect(r.text).toContain("Acme notes");
    expect(r.text).toContain("Acme Corp");
    expect(r.activeSession).toBeUndefined();
    expect(r1.activeSession!.id).toBeTruthy();
  });
});

describe("session management via chat", () => {
  test("rename renames the session", async () => {
    const a = chats.createChatSession("swm-a", "Old name");
    const s = sess("swm-a");
    const r = await handleMessage(s, "rename session to Shiny name");
    expect(r.activeSession!.name).toBe("Shiny name");
    expect(chats.getChatSession(a.id)!.name).toBe("Shiny name");
  });

  test("delete removes the session and its messages, then confirms", async () => {
    const a = chats.createChatSession("swm-del", "Doomed");
    const b = chats.createChatSession("swm-keep", "Keeps");
    memDb.query("INSERT INTO messages (session_id, role, text) VALUES (?,?,?)").run("swm-del", "user", "hello");
    const s = sess("swm-del");
    const r1 = await handleMessage(s, "delete session Doomed");
    expect(r1.text).toMatch(/Delete chat session/);
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toMatch(/Deleted chat session/);
    expect(chats.getChatSession(a.id)).toBeNull();
    expect((memDb.query("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get("swm-del") as any).n).toBe(0);
    expect(chats.getChatSession(b.id)).not.toBeNull();
  });

  test("the last remaining session cannot be deleted", async () => {
    // shrink the store to a single session (the store itself protects count==1,
    // so keep a survivor while clearing the rest)
    chats.createChatSession("swm-last", "Final");
    const ids = chats.listChatSessions().map((i) => i.id).filter((id) => id !== "swm-last");
    while (ids.length) chats.deleteChatSession(ids.pop()!);
    const r = await handleMessage(sess("swm-last"), "delete session Final");
    expect(r.text).toMatch(/only session/);
    expect(chats.getChatSession("swm-last")).not.toBeNull();
  });
});

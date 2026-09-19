// server.ts — Milton: self-hosted chat bot for exec-crm.
// Bun + zero dependencies + SQLite. Everything stays on your machine.

import { Database } from "bun:sqlite";
import { handleMessage, type Session, type Reply } from "./brain";
import { ping, crmBase } from "./crm";
import { helpText } from "./intents";

const PORT = Number(process.env.PORT || 3009);
const DATA_DIR = process.env.MILTON_DATA || "./data";

await Bun.$`mkdir -p ${DATA_DIR}`.quiet().catch(() => {});

const db = new Database(`${DATA_DIR}/milton.db`);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function loadSession(id: string): Session {
  const row = db.query("SELECT state FROM sessions WHERE id = ?").get(id) as any;
  if (row) {
    try {
      const s = JSON.parse(row.state);
      return { id, pending: s.pending, choice: s.choice, history: s.history || [] };
    } catch { /* fall through to fresh */ }
  }
  const fresh: Session = { id, history: [] };
  db.query("INSERT INTO sessions (id, state) VALUES (?, ?)").run(id, JSON.stringify({ history: [] }));
  return fresh;
}

function saveSession(s: Session) {
  db.query("UPDATE sessions SET state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ pending: s.pending, choice: s.choice, history: s.history.slice(-40) }), s.id);
}

function logMessage(sessionId: string, role: string, text: string) {
  db.query("INSERT INTO messages (session_id, role, text) VALUES (?, ?, ?)").run(sessionId, role, text.slice(0, 4000));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

async function serveStatic(path: string): Promise<Response | null> {
  const file = path === "/" ? "/index.html" : path;
  // block path traversal
  if (file.includes("..")) return new Response("Not found", { status: 404 });
  const f = Bun.file(`./public${file}`);
  if (!(await f.exists())) return null;
  const ext = file.slice(file.lastIndexOf("."));
  return new Response(f, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const crmOk = await ping();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (!path.startsWith("/api/")) {
      return (await serveStatic(path)) || new Response("Not found", { status: 404 });
    }

    if (path === "/api/health" && method === "GET") {
      return json({ ok: true, crm: crmOk, crm_url: crmBase(), llm: Boolean(process.env.MILTON_LLM_URL) });
    }

    if (path === "/api/history" && method === "GET") {
      const sid = url.searchParams.get("session") || "";
      const rows = db.query("SELECT role, text, created_at FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").all(sid) as any[];
      return json({ messages: rows });
    }

    if (path === "/api/chat" && method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const sid = String(body.session || "default").slice(0, 64);
      const text = String(body.message || "").slice(0, 2000).trim();
      if (!text) return json({ error: "empty message" }, 400);

      const session = loadSession(sid);
      const t0 = Date.now();
      const reply: Reply = await handleMessage(session, text);
      saveSession(session);
      logMessage(sid, "user", text);
      logMessage(sid, "milton", reply.text);

      return json({ ...reply, ms: Date.now() - t0 });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`milton listening on http://localhost:${server.port}`);
console.log(`exec-crm: ${crmBase()} (${crmOk ? "reachable" : "UNREACHABLE"})`);
console.log(`LLM mode: ${process.env.MILTON_LLM_URL ? "enabled" : "local-only (set MILTON_LLM_URL for freeform chat)"}`);
if (!crmOk) console.log("Hint: start exec-crm first, or set MILTON_CRM_URL to its address.");

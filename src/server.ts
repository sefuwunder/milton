// server.ts — Milton: self-hosted chat bot for exec-crm.
// Bun + zero dependencies + SQLite. Everything stays on your machine.

import { Database } from "bun:sqlite";
import { handleMessage, type Session, type Reply, type UploadRef } from "./brain";
import { ping, crmBase } from "./crm";
import { helpText } from "./intents";
import { detectKind } from "./ocr";

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
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function loadSession(id: string): Session {
  const row = db.query("SELECT state FROM sessions WHERE id = ?").get(id) as any;
  if (row) {
    try {
      const s = JSON.parse(row.state);
      return { id, pending: s.pending, choice: s.choice, history: s.history || [], lastOcr: s.lastOcr, notes: s.notes || [] };
    } catch { /* fall through to fresh */ }
  }
  const fresh: Session = { id, history: [], notes: [] };
  db.query("INSERT INTO sessions (id, state) VALUES (?, ?)").run(id, JSON.stringify({ history: [], notes: [] }));
  return fresh;
}

function saveSession(s: Session) {
  db.query("UPDATE sessions SET state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ pending: s.pending, choice: s.choice, history: s.history.slice(-40), lastOcr: s.lastOcr, notes: (s.notes || []).slice(-20) }), s.id);
}

function logMessage(sessionId: string, role: string, text: string) {
  db.query("INSERT INTO messages (session_id, role, text) VALUES (?, ?, ?)").run(sessionId, role, text.slice(0, 4000));
}

// ---- camera uploads: manual multipart parsing, zero dependencies -----------------
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB
const CRLF2 = new Uint8Array([13, 10, 13, 10]);

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

interface UploadedFile { field: string; filename: string; bytes: Uint8Array }

function parseMultipart(body: Uint8Array, boundary: string): { fields: Record<string, string>; files: UploadedFile[] } {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  const delim = new TextEncoder().encode("--" + boundary);
  let pos = indexOfBytes(body, delim, 0);
  if (pos < 0) return { fields, files };
  pos += delim.length;
  const dec = new TextDecoder();
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headEnd = indexOfBytes(body, CRLF2, pos);
    if (headEnd < 0) break;
    const head = dec.decode(body.slice(pos, headEnd));
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    const dataStart = headEnd + 4;
    const next = indexOfBytes(body, delim, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = body.slice(dataStart, dataEnd);
    if (nameM && fileM) files.push({ field: nameM[1], filename: fileM[1], bytes: data });
    else if (nameM) fields[nameM[1]] = dec.decode(data);
    pos = next + delim.length;
  }
  return { fields, files };
}

function uploadRef(sid: string, row: any): UploadRef | null {
  if (!row) return null;
  return { id: row.id, mime: row.mime, size: row.size, path: `${DATA_DIR}/uploads/${sid}/${row.filename}` };
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
      return json({
        ok: true, crm: crmOk, crm_url: crmBase(),
        llm: Boolean(process.env.MILTON_LLM_URL),
        llm_url: process.env.MILTON_LLM_URL || null,
        llm_model: process.env.MILTON_LLM_MODEL || null,
      });
    }

    if (path === "/api/history" && method === "GET") {
      const sid = url.searchParams.get("session") || "";
      const rows = db.query("SELECT role, text, created_at FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").all(sid) as any[];
      return json({ messages: rows });
    }

    if (path === "/api/upload" && method === "POST") {
      const sid = String(url.searchParams.get("session") || "").slice(0, 64);
      if (!sid) return json({ error: "missing session" }, 400);
      const ctype = req.headers.get("content-type") || "";
      const bm = /boundary=([^;]+)/.exec(ctype);
      if (!bm) return json({ error: "expected multipart/form-data" }, 400);
      const boundary = bm[1].trim().replace(/^"|"$/g, "");
      const raw = new Uint8Array(await req.arrayBuffer());
      if (raw.length > MAX_UPLOAD + 65536) return json({ error: "file too large (10 MB max)" }, 413);
      const { files } = parseMultipart(raw, boundary);
      const file = files.find((f) => f.field === "photo" || f.field === "file");
      if (!file || !file.bytes.length) return json({ error: "no photo attached" }, 400);
      if (file.bytes.length > MAX_UPLOAD) return json({ error: "file too large (10 MB max)" }, 413);
      const kind = detectKind(file.bytes);
      const mime = kind === "png" ? "image/png" : kind === "jpeg" ? "image/jpeg" : kind === "webp" ? "image/webp" : null;
      if (!mime) return json({ error: "only JPEG, PNG, and WebP photos are accepted" }, 415);
      const id = crypto.randomUUID();
      const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
      const dir = `${DATA_DIR}/uploads/${sid}`;
      await Bun.$`mkdir -p ${dir}`.quiet().catch(() => {});
      // stored under the random id: the client-supplied filename never touches the disk
      await Bun.write(`${dir}/${id}.${ext}`, file.bytes);
      db.query("INSERT INTO uploads (id, session, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run(id, sid, `${id}.${ext}`, mime, file.bytes.length);
      return json({ id, url: `/api/file/${id}` });
    }

    if (path.startsWith("/api/file/") && method === "GET") {
      const sid = String(url.searchParams.get("session") || "").slice(0, 64);
      const id = path.slice("/api/file/".length).split("/")[0].slice(0, 64);
      const row = db.query("SELECT session, filename, mime FROM uploads WHERE id = ?").get(id) as any;
      // session-scoped: another session's id is indistinguishable from "not found"
      if (!row || row.session !== sid) return new Response("Not found", { status: 404 });
      const f = Bun.file(`${DATA_DIR}/uploads/${row.session}/${row.filename}`);
      if (!(await f.exists())) return new Response("Not found", { status: 404 });
      return new Response(f, { headers: { "Content-Type": row.mime, "Cache-Control": "private, max-age=3600" } });
    }

    if (path === "/api/chat" && method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const sid = String(body.session || "default").slice(0, 64);
      const text = String(body.message || "").slice(0, 2000).trim();
      const wanted: string[] = Array.isArray(body.attachments)
        ? body.attachments.map((a: any) => String(a).slice(0, 64)).slice(0, 4)
        : [];
      const attachments: UploadRef[] = [];
      for (const aid of wanted) {
        const ref = uploadRef(sid, db.query("SELECT id, filename, mime, size FROM uploads WHERE id = ? AND session = ?").get(aid, sid));
        if (ref) attachments.push(ref);
      }
      if (!text && !attachments.length) return json({ error: "empty message" }, 400);

      const session = loadSession(sid);
      const latest = db.query("SELECT id, filename, mime, size FROM uploads WHERE session = ? ORDER BY rowid DESC LIMIT 1").get(sid);
      const t0 = Date.now();
      const reply: Reply = await handleMessage(session, text, { attachments, latestUpload: uploadRef(sid, latest) });
      saveSession(session);
      logMessage(sid, "user", text || `[photo${attachments.length > 1 ? "s" : ""}]`);
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

// exported for tests (boots the server against MILTON_DATA on import)
export { server };

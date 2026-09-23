// server.ts — Milton: self-hosted chat bot for exec-crm.
// Bun + zero dependencies + SQLite. Everything stays on your machine.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { handleMessage, tickAutomation, handleWebhookEvent, handleMeridianCallback, enrichTerminalReply, enrichTickDecision, prospectTerminalReply, prospectTickDecision, type Session, type Reply, type UploadRef, type EnrichJobState, type ProspectJobState } from "./brain";
import { getEnrichJob, getProspectJob } from "./meridian";
import { ping, crmBase } from "./crm";
import { helpText } from "./intents";
import { detectKind } from "./ocr";
import * as auto from "./automation";
import { initWorkspaceDb, listWorkspaces, getSessionWorkspace, setSessionWorkspace, runWithWorkspace } from "./workspace";
import { initChatSessionDb, listChatSessions, getChatSession, createChatSession, renameChatSession, deleteChatSession, ensureChatSession, touchChatSession } from "./chat_sessions";
import { initReconRunsDb } from "./recon_runs";
import { initDealNotesDb } from "./deal_notes";
import { initMissLogDb } from "./intent_misses";
import { initPlaybookDb } from "./playbook";
import { initUsabilityDb } from "./usability";
import { commandRegistry } from "./commands";
import { hookSecret, verifyHookSecret } from "./hookauth";
import { embeddedDecision, startEmbedded, type EmbeddedServer } from "./embedded";
import { llmEndpointBase, analystModel } from "./analyst";

const PORT = Number(process.env.PORT || 3009);

let db!: Database;
function initDataDir(dataDir: string) {
  // NOTE: the previous handle is intentionally left open, not closed: the
  // per-domain init*Db() helpers keep their own reference to it, and closing
  // it out from under them breaks their modules. Abandoning a test-only
  // SQLite handle is harmless (reclaimed on process exit).
  db = new Database(`${dataDir}/milton.db`);
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
  auto.initAutomationDb(db);
  initWorkspaceDb(db);
  initChatSessionDb(db, `${dataDir}/uploads`);
  initReconRunsDb(db);
  initDealNotesDb(db);
  initMissLogDb(db);
  initPlaybookDb(db);
  initUsabilityDb(db);
}

const DATA_DIR = process.env.MILTON_DATA || "./data";
await Bun.$`mkdir -p ${DATA_DIR}`.quiet().catch(() => {});
initDataDir(DATA_DIR);

/**
 * Test-only hook: re-point the server — sessions, uploads, automation,
 * workspace, chat-session, recon-run, deal-note and usability stores — at a
 * fresh data dir. bun shares module state across test files and server.ts
 * binds its database on first import, so without this a test file that
 * imports server.ts after another file did silently reuses the other file's
 * MILTON_DATA, and tests pass or fail depending on test-file order.
 */
export function __resetDataDirForTests(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  initDataDir(dataDir);
}

// Incoming webhooks share one auth pattern: 503 when MILTON_HOOK_SECRET isn't
// configured, 401 on a bad X-Milton-Secret (constant-time comparison).
function hookAuth(req: Request): Response | null {
  if (!hookSecret()) return json({ error: "hook secret not configured (set MILTON_HOOK_SECRET)" }, 503);
  if (!verifyHookSecret(req.headers.get("x-milton-secret") || "")) return json({ error: "bad secret" }, 401);
  return null;
}

function loadSession(id: string): Session {
  // Named chat sessions: every id gets a row with a human name ("General"
  // for legacy rows). This also runs the one-time legacy migration.
  const info = ensureChatSession(id);
  touchChatSession(id);
  const row = db.query("SELECT state FROM sessions WHERE id = ?").get(id) as any;
  let s: Session;
  if (row) {
    try {
      const st = JSON.parse(row.state);
      s = { id, pending: st.pending, choice: st.choice, enrichJob: st.enrichJob, prospectJob: st.prospectJob, history: st.history || [], lastOcr: st.lastOcr, notes: st.notes || [], lastWidgetable: st.lastWidgetable, tutorial: st.tutorial };
    } catch {
      s = { id, history: [], notes: [] };
      db.query("UPDATE sessions SET state = ? WHERE id = ?").run(JSON.stringify({ history: [], notes: [] }), id);
    }
  } else {
    // unreachable: ensureChatSession above guarantees the row exists
    s = { id, history: [], notes: [] };
  }
  const w = getSessionWorkspace(id);
  s.workspaceId = w.id;
  s.workspaceName = w.name;
  s.chatName = info.name;
  return s;
}

function saveSession(s: Session) {
  db.query("UPDATE sessions SET state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ pending: s.pending, choice: s.choice, enrichJob: s.enrichJob, prospectJob: s.prospectJob, history: s.history.slice(-40), lastOcr: s.lastOcr, notes: (s.notes || []).slice(-20), lastWidgetable: s.lastWidgetable, tutorial: s.tutorial }), s.id);
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

// Self-contained mode: spawn the llama-server sidecar when MILTON_EMBEDDED=1,
// or auto-detect it when models/ holds a .gguf + binary and no MILTON_LLM_URL
// is set. All LLM traffic (chat + analyst) then routes at the sidecar.
let embedded: EmbeddedServer | null = null;
try {
  const plan = embeddedDecision("models");
  if (plan) {
    console.log(`starting embedded model (${plan.gguf})…`);
    embedded = await startEmbedded(plan);
    console.log(`embedded model ready (${embedded.label})`);
  }
} catch (e: any) {
  console.error(`embedded model failed: ${e?.message || e}`);
  process.exit(1);
}
const stopEmbedded = () => { try { embedded?.stop(); } catch { /* already gone */ } };
process.on("SIGINT", () => { stopEmbedded(); process.exit(0); });
process.on("SIGTERM", () => { stopEmbedded(); process.exit(0); });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // SSE streams stay open; 25s keep-alive pings refresh it
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
        llm: Boolean(llmEndpointBase()),
        llm_url: process.env.MILTON_LLM_URL || null,
        llm_model: process.env.MILTON_LLM_MODEL || null,
        llm_source: embedded ? "embedded" : (process.env.MILTON_LLM_URL ? "env" : "none"),
        analyst_model: analystModel(),
      });
    }

    if (path === "/api/commands" && method === "GET") {
      return json({ commands: commandRegistry() });
    }

    if (path === "/api/history" && method === "GET") {
      const sid = url.searchParams.get("session") || "";
      const rows = db.query("SELECT role, text, created_at FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").all(sid) as any[];
      return json({ messages: rows });
    }

    // ---- chat sessions: named conversations ---------------------------------------
    if (path === "/api/chat-sessions" && method === "GET") {
      return json({
        sessions: listChatSessions().map((s) => ({
          ...s,
          workspace: (() => { const w = getSessionWorkspace(s.id); return { id: w.id, name: w.name }; })(),
        })),
      });
    }
    if (path === "/api/chat-sessions" && method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      // A new session is bound to exactly one workspace at creation (null =
      // exec-crm's default). Validate before creating anything.
      const wid = body.workspace_id == null || body.workspace_id === "" ? null : Number(body.workspace_id);
      if (wid !== null && (!Number.isInteger(wid) || wid <= 0)) return json({ error: "bad workspace_id" }, 400);
      let wname = "";
      if (wid !== null) {
        const w = (await listWorkspaces())?.find((x) => x.id === wid);
        if (!w) return json({ error: `unknown workspace ${wid}` }, 400);
        wname = w.name;
      }
      const id = "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try {
        const info = createChatSession(id, String(body.name || ""));
        setSessionWorkspace(id, wid, wname);
        return json({ session: { ...info, workspace: { id: wid, name: wname } } }, 201);
      } catch (e: any) { return json({ error: String(e?.message || e) }, 400); }
    }
    if (path.startsWith("/api/chat-sessions/") && (method === "PATCH" || method === "DELETE")) {
      const id = decodeURIComponent(path.slice("/api/chat-sessions/".length).split("/")[0]).slice(0, 64);
      if (!getChatSession(id)) return json({ error: "not found" }, 404);
      if (method === "DELETE") {
        try { return json({ ok: true, ...deleteChatSession(id) }); }
        catch (e: any) { return json({ error: String(e?.message || e) }, 400); }
      }
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      try { return json({ session: renameChatSession(id, String(body.name || "")) }); }
      catch (e: any) { return json({ error: String(e?.message || e) }, 400); }
    }

    // ---- automations: SSE live events -------------------------------------------
    if (path === "/api/events" && method === "GET") {
      // NB: ReadableStream.cancel() receives the cancellation *reason*, not the
      // controller — so capture the controller in the closure for cleanup.
      let ctrl: ReadableStreamDefaultController | null = null;
      let ping: ReturnType<typeof setInterval> | null = null;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          ctrl = c as ReadableStreamDefaultController;
          auto.sseAdd(c as any);
          c.enqueue(enc.encode(": connected\n\n"));
          // keep-alive: Bun drops requests idle longer than `idleTimeout`
          ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 25000);
        },
        cancel() {
          if (ping) clearInterval(ping);
          if (ctrl) auto.sseRemove(ctrl as any);
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    // ---- automations: REST for the UI -------------------------------------------
    if (path === "/api/routines" && method === "GET") return json({ routines: auto.listRoutines() });
    if (path.startsWith("/api/routines/") && method === "DELETE") {
      const name = decodeURIComponent(path.slice("/api/routines/".length));
      const d = auto.deleteRoutine(name);
      if (!d.deleted) return json({ error: "not found" }, 404);
      return json({ ok: true, ...d });
    }
    if (path === "/api/schedules" && method === "GET") return json({ schedules: auto.listSchedules() });
    if (path === "/api/schedules" && method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const r = auto.getRoutine(String(body.routine || ""));
      if (!r) return json({ error: `no routine named "${body.routine}"` }, 400);
      const spec = auto.parseScheduleSpec(String(body.when || ""));
      if (!spec) return json({ error: `couldn't parse schedule "${body.when}"` }, 400);
      const wsId = body.workspace_id == null || body.workspace_id === "" ? null : Number(body.workspace_id);
      if (wsId !== null && (!Number.isInteger(wsId) || wsId <= 0)) return json({ error: "bad workspace_id" }, 400);
      return json({ schedule: auto.createSchedule(r.name, spec, Date.now(), wsId) }, 201);
    }
    if (path.startsWith("/api/schedules/") && (method === "PATCH" || method === "DELETE")) {
      const id = Number(path.slice("/api/schedules/".length).split("/")[0]);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "bad id" }, 400);
      if (method === "DELETE") return json({ ok: auto.deleteScheduleByRef(String(id)) > 0 });
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!auto.getSchedule(id)) return json({ error: "not found" }, 404);
      auto.setScheduleActive(id, body.active !== false);
      return json({ schedule: auto.getSchedule(id) });
    }
    if (path === "/api/triggers" && method === "GET") return json({ triggers: auto.listTriggers(), events: auto.CRM_EVENTS });
    if (path.startsWith("/api/triggers/") && method === "DELETE") {
      const id = Number(path.slice("/api/triggers/".length).split("/")[0]);
      if (!auto.deleteTrigger(id)) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
    if (path === "/api/automation-runs" && method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
      return json({ runs: auto.listRuns(limit) });
    }

    // ---- workspaces: proxy exec-crm's list, per-session selection ------------------
    if (path === "/api/workspaces" && method === "GET") {
      const list = await listWorkspaces();
      if (!list) return json({ workspaces: [], error: `exec-crm unreachable at ${crmBase()}` });
      return json({ workspaces: list.map((w) => ({ id: w.id, name: w.name, color: w.color })) });
    }
    if (path === "/api/session/workspace" && method === "GET") {
      const sid = String(url.searchParams.get("session") || "").slice(0, 64);
      const w = getSessionWorkspace(sid);
      return json({ workspace_id: w.id, workspace_name: w.name });
    }
    if (path === "/api/session/workspace" && method === "POST") {
      // One workspace per session: "switching" a session's workspace forks a
      // FRESH session bound to the target. The old session is never re-scoped,
      // so workspaces can't commingle. Returns the new session for the client
      // to follow (or unchanged:true when already there).
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const sid = String(body.session || "").slice(0, 64);
      if (!sid) return json({ error: "missing session" }, 400);
      if (!getChatSession(sid)) return json({ error: "unknown session" }, 404);
      const id = body.workspace_id == null || body.workspace_id === "" ? null : Number(body.workspace_id);
      if (id !== null && (!Number.isInteger(id) || id <= 0)) return json({ error: "bad workspace_id" }, 400);
      const cur = getSessionWorkspace(sid);
      if ((cur.id ?? null) === id) {
        return json({ ok: true, unchanged: true, workspace_id: cur.id, workspace_name: cur.name });
      }
      let wname = "";
      if (id !== null) {
        const list = await listWorkspaces();
        const w = list?.find((x) => x.id === id);
        if (list && !w) return json({ error: `unknown workspace ${id}` }, 400);
        // exec-crm unreachable: accept the id on trust, name unknown
        wname = w ? w.name : "";
      }
      const nid = "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try {
        const info = createChatSession(nid, "");
        setSessionWorkspace(nid, id, wname);
        return json({ ok: true, session: { id: info.id, name: info.name }, workspace_id: id, workspace_name: wname });
      } catch (e: any) { return json({ error: String(e?.message || e) }, 400); }
    }

    // ---- incoming exec-crm webhook -> triggers -----------------------------------
    if (path === "/api/hooks/exec-crm" && method === "POST") {
      const auth = hookAuth(req);
      if (auth) return auth;
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const event = String(body.event || req.headers.get("x-crm-event") || "");
      if (!event) return json({ error: "missing event" }, 400);
      const { matched, runs } = await handleWebhookEvent(event, body.data || {});
      return json({ ok: true, event, matched, runs: runs.map((r) => r.id) });
    }

    // ---- incoming Meridian completion callback -> automation runs ------------------
    // Meridian POSTs { run_id, city, label, status, nodes, edges, result_url,
    // export_url } when a requested run finishes. Recorded as an automation run
    // (kind "meridian") so it shows in the Runs tab, the bell badge, and the
    // SSE stream — the same path schedule/trigger runs take.
    if (path === "/api/hooks/meridian" && method === "POST") {
      const auth = hookAuth(req);
      if (auth) return auth;
      let body: any = {};
      try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const { known, run } = handleMeridianCallback(body);
      return json({ ok: true, known, run_id: run.id });
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
      let mime = kind === "png" ? "image/png" : kind === "jpeg" ? "image/jpeg" : kind === "webp" ? "image/webp" : null;
      let ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
      if (!mime && /\.vcf$/i.test(file.filename || "")) {
        // vCard contact file: sniff the content for BEGIN:VCARD before accepting,
        // so a renamed binary can't sneak through on the extension alone.
        const head = new TextDecoder().decode(file.bytes.slice(0, 4096));
        if (/BEGIN:VCARD/i.test(head)) { mime = "text/vcard"; ext = "vcf"; }
      }
      if (!mime) return json({ error: "only JPEG, PNG, and WebP photos and .vcf contact files are accepted" }, 415);
      const id = crypto.randomUUID();
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
      // handleMessage scopes every exec-crm call to session.workspaceId
      // (null = default: no workspace parameter is sent).
      const reply: Reply = await handleMessage(session, text, { attachments, latestUpload: uploadRef(sid, latest) });
      saveSession(session);
      logMessage(sid, "user", text || `[photo${attachments.length > 1 ? "s" : ""}]`);
      logMessage(sid, "milton", reply.text);

      return json({ ...reply, ms: Date.now() - t0, workspace_id: session.workspaceId ?? null, workspace_name: session.workspaceName || "" });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`milton listening on http://localhost:${server.port}`);
console.log(`exec-crm: ${crmBase()} (${crmOk ? "reachable" : "UNREACHABLE"})`);
console.log(`LLM mode: ${embedded ? `embedded (${embedded.label})` : process.env.MILTON_LLM_URL ? "enabled" : "local-only (set MILTON_LLM_URL for freeform chat, MILTON_EMBEDDED=1 for the bundled model)"}`);
console.log(`automation scheduler: every 30s${process.env.MILTON_HOOK_SECRET ? "" : " (incoming webhooks disabled: set MILTON_HOOK_SECRET)"}`);
if (!crmOk) console.log("Hint: start exec-crm first, or set EXEC_CRM_URL (or MILTON_CRM_URL) to its address.");

// ---- enrichment tick: 30s background poll of in-flight Meridian jobs --------
// The scrape can take longer than a few seconds, so the chat never blocks on
// it: this tick polls every parked job on the same 30s cadence as the
// automation scheduler. On a terminal state the completion (offer card or
// failure note) is appended to the session and pushed over SSE, so the user
// sees it without asking. A job still "running" past ENRICH_JOB_TIMEOUT_MS
// is treated as stalled — Meridian caps jobs at ~60s, so anything older than
// that means Meridian died mid-job.
async function tickEnrichment() {
  let rows: { id: string; state: string }[] = [];
  try { rows = db.query("SELECT id, state FROM sessions").all() as any[]; }
  catch { return; }
  for (const row of rows) {
    let st: any;
    try { st = JSON.parse(row.state); } catch { continue; }
    const job = st.enrichJob as EnrichJobState | undefined;
    if (!job?.job_id) continue;
    let r;
    try { r = await getEnrichJob(job.job_id); }
    catch { continue; } // Meridian unreachable this round — try again next tick
    if (!r) continue;
    const decision = enrichTickDecision(job, r.status, Date.now());
    if (decision === "keep") continue;
    const session = loadSession(row.id);
    // A chat turn may have resolved it concurrently — don't double-deliver.
    if (session.enrichJob?.job_id !== job.job_id) continue;
    session.enrichJob = undefined;
    const reply: Reply = decision === "stale"
      ? {
        text: `The enrichment for **${job.targetName}** seems to have stalled — it's been running far longer than Meridian's ~60s job cap, so Meridian probably restarted mid-scrape. Say \`enrich ${job.targetName}\` to try again.`,
        chips: ["Meridian recons"],
      }
      : enrichTerminalReply(session, job, r);
    session.history.push({ role: "milton", text: reply.text });
    saveSession(session);
    logMessage(row.id, "milton", reply.text);
    auto.broadcastSse("enrichment-done", {
      session_id: row.id, target_name: job.targetName, decision, reply,
    });
  }
}

// ---- prospect tick: 30s background poll of in-flight Meridian prospect jobs --
// Mirrors tickEnrichment. On `done`, the tick stages the batch into exec-crm's
// Data Workshop Sandbox itself (staged, never committed), then reports the
// staged confirmation into the session. Staging runs inside the session's
// workspace (runWithWorkspace) so the batch lands in the right workspace even
// from the background sweep, which has no ambient workspace of its own.
async function tickProspect() {
  let rows: { id: string; state: string }[] = [];
  try { rows = db.query("SELECT id, state FROM sessions").all() as any[]; }
  catch { return; }
  for (const row of rows) {
    let st: any;
    try { st = JSON.parse(row.state); } catch { continue; }
    const job = st.prospectJob as ProspectJobState | undefined;
    if (!job?.job_id) continue;
    let r;
    try { r = await getProspectJob(job.job_id); }
    catch { continue; } // Meridian unreachable this round — try again next tick
    if (!r) continue;
    const decision = prospectTickDecision(job, r.status, Date.now());
    if (decision === "keep") continue;
    const session = loadSession(row.id);
    // A chat turn may have resolved it concurrently — don't double-stage.
    if (session.prospectJob?.job_id !== job.job_id) continue;
    session.prospectJob = undefined;
    const reply: Reply = decision === "stale"
      ? {
        text: `Prospecting **${job.industry}** in **${job.location}** seems to have stalled — it's been running far longer than Meridian's ~60s job cap, so Meridian probably restarted mid-run. Say \`meridian prospect ${job.industry} in ${job.location}\` to try again.`,
        chips: ["Meridian recons"],
      }
      : await runWithWorkspace(session.workspaceId ?? null, () => prospectTerminalReply(session, job, r));
    session.history.push({ role: "milton", text: reply.text });
    saveSession(session);
    logMessage(row.id, "milton", reply.text);
    auto.broadcastSse("prospect-done", {
      session_id: row.id, industry: job.industry, location: job.location, decision, reply,
    });
  }
}

// scheduler: run due schedules every 30s (plus one sweep shortly after boot)
let ticking = false;
async function sweep() {
  if (ticking) return;
  ticking = true;
  try {
    await tickAutomation(Date.now());
    await tickEnrichment();
    await tickProspect();
  }
  catch (e) { console.error("scheduler sweep failed:", e); }
  finally { ticking = false; }
}
setInterval(sweep, 30000);
setTimeout(sweep, 5000);

// exported for tests (boots the server against MILTON_DATA on import)
export { server, loadSession, saveSession, tickEnrichment, tickProspect };

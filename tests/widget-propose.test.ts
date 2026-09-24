// tests/widget-propose.test.ts — phase 3, milton side: Milton proposes a
// widget or set via POST /api/widgets/propose, which files it into exec-crm's
// proposal inbox (stubbed here). The user previews/approves in exec-crm's chat.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;

let received: { path: string; workspace: string | null; body: any }[] = [];
let failNext = false;
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/widget-proposals" && req.method === "POST") {
      const body = await req.json();
      received.push({ path: url.pathname, workspace: url.searchParams.get("workspace"), body });
      if (failNext) { failNext = false; return Response.json({ error: "widget js is required" }, { status: 400 }); }
      return Response.json({ proposal: { id: 7, kind: body.kind, title: body.title, status: "pending" } }, { status: 201 });
    }
    return Response.json({});
  },
});

let dir = "";
let proc: any = null;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "milton-propose-"));
  proc = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: root,
    env: { ...process.env, MILTON_DATA: dir, PORT: "0", EXEC_CRM_URL: `http://localhost:${stub.port}` },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/milton listening on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; break; }
    }
    if (done) break;
  }
  reader.releaseLock();
  if (!base) throw new Error("widget-propose test server did not start. output: " + buf.slice(-800));
});

afterAll(async () => {
  try { proc?.kill(); } catch {}
  stub.stop();
  await rm(dir, { recursive: true, force: true });
});

const WIDGET = {
  kind: "widget", title: "Stalled deals radar",
  rationale: "Six deals are stuck; keep them visible.",
  manifest: { name: "stalled-radar", title: "Stalled Radar", version: "1.0.0", mount: "dashboard", permissions: ["deals:read"] },
  js: "document.getElementById('wroot').textContent='radar';", css: "",
};

describe("POST /api/widgets/propose", () => {
  test("files a widget proposal into exec-crm's inbox", async () => {
    received = [];
    const r = await fetch(base + "/api/widgets/propose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: 3, ...WIDGET }),
    });
    expect(r.status).toBe(201);
    const j: any = await r.json();
    expect(j.proposal.status).toBe("pending");
    expect(j.proposal.title).toBe("Stalled deals radar");
    expect(received.length).toBe(1);
    expect(received[0].workspace).toBe("3");
    expect(received[0].body.manifest.name).toBe("stalled-radar");
    expect(received[0].body.rationale).toContain("Six deals");
  });

  test("files a set proposal with members", async () => {
    received = [];
    const r = await fetch(base + "/api/widgets/propose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "set", title: "Morning duo",
        manifest: { name: "morning-duo", title: "Morning Duo", version: "1.0.0", description: "d" },
        members: [{ manifest: WIDGET.manifest, js: WIDGET.js, css: "" }],
      }),
    });
    expect(r.status).toBe(201);
    expect(received[0].body.members.length).toBe(1);
    expect(received[0].workspace).toBeNull(); // no workspace → exec-crm default
  });

  test("bad kind → 400 without touching exec-crm", async () => {
    received = [];
    const r = await fetch(base + "/api/widgets/propose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "gadget", title: "x" }),
    });
    expect(r.status).toBe(400);
    expect(received.length).toBe(0);
  });

  test("exec-crm rejection → 502 with the reason", async () => {
    failNext = true;
    const r = await fetch(base + "/api/widgets/propose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...WIDGET, js: "" }),
    });
    expect(r.status).toBe(502);
    const j: any = await r.json();
    expect(j.error).toContain("widget js is required");
  });
});

describe("proposeWidget client", () => {
  test("posts the spec to /api/widget-proposals with the session workspace", async () => {
    // crm.ts reads EXEC_CRM_URL at module load and bun shares module state
    // across test files, so drive it in a fresh bun process with the stub URL.
    const d = await mkdtemp(join(tmpdir(), "milton-propose-client-"));
    const driver = join(d, "driver.ts");
    await Bun.write(driver, `
      import { runWithWorkspace } from ${JSON.stringify(new URL("../src/workspace", import.meta.url).pathname)};
      import { proposeWidget } from ${JSON.stringify(new URL("../src/crm", import.meta.url).pathname)};
      const p = await runWithWorkspace(9, () => proposeWidget({
        kind: "widget", title: "Stalled deals radar",
        manifest: { name: "stalled-radar", title: "Stalled Radar", version: "1.0.0",
          mount: "dashboard", permissions: ["deals:read"] },
        js: "1+1;",
      }));
      console.log(JSON.stringify({ status: p.status, title: p.title }));
    `);
    received = [];
    const proc = Bun.spawn([process.execPath, driver], {
      cwd: root,
      env: { ...process.env, EXEC_CRM_URL: `http://localhost:${stub.port}` },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error("driver failed: " + err.slice(-500));
    const res = JSON.parse(out.trim());
    expect(res.status).toBe("pending");
    expect(received[0].workspace).toBe("9");
    expect(received[0].body.title).toBe("Stalled deals radar");
    await rm(d, { recursive: true, force: true });
  });
});

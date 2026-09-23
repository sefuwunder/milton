// tests/hygiene-api.test.ts — GET /api/hygiene structured endpoint.
//
// The endpoint exposes the same playbook engine as the "pipeline hygiene"
// chat reply, but as machine-readable JSON grouped review → action →
// outcome, for other surfaces (exec-crm's Dashboard) to render without
// parsing chat text.
//
// Spawns a real Milton server against a stub exec-crm: MILTON_DATA points
// at a temp dir, EXEC_CRM_URL at the in-process stub.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;

function isoDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10) + "T09:00:00";
}

// Fixture: deal 1 has no contact and no close date (review-phase findings),
// deal 2 went quiet 40 days ago (action-phase findings).
const fx = {
  deals: [
    { id: 1, title: "Acme Website", value: 5000, stage: "qualification", owner: "sam",
      company_id: null, contact_id: null, company_name: "Acme", contact_name: "",
      expected_close: "", probability: 10,
      created_at: isoDaysAgo(60), updated_at: isoDaysAgo(1) },
    { id: 2, title: "Beta Retainer", value: 12000, stage: "prospecting", owner: "sam",
      company_id: null, contact_id: 7, company_name: "Beta", contact_name: "Bea",
      expected_close: isoDaysAgo(-30).slice(0, 10), probability: 10,
      created_at: isoDaysAgo(90), updated_at: isoDaysAgo(40) },
  ],
  tasks: [], activities: [],
  stages: ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"],
};

let lastWorkspaceParam: string | null = null;
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    lastWorkspaceParam = url.searchParams.get("workspace");
    const ok = (data: any) => Response.json(data);
    if (url.pathname === "/api/deals") return ok({ deals: fx.deals });
    if (url.pathname === "/api/tasks") return ok({ tasks: fx.tasks });
    if (url.pathname === "/api/activities") return ok({ activities: fx.activities });
    if (url.pathname === "/api/stages") return ok({ stages: fx.stages });
    if (url.pathname === "/api/contacts") return ok({ contacts: [] });
    if (url.pathname === "/api/companies") return ok({ companies: [] });
    return ok({});
  },
});

let dir = "";
let proc: any = null;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "milton-hygiene-api-"));
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
  if (!base) throw new Error("hygiene-api test server did not start. output: " + buf.slice(-800));
});

afterAll(async () => {
  try { proc?.kill(); } catch {}
  stub.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/hygiene", () => {
  test("returns phase-grouped items with lead and counts", async () => {
    const r = await fetch(base + "/api/hygiene");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.lead).toBe("string");
    expect(j.lead).toMatch(/^Found \d+ things? worth a look/);
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    // every item carries icon, text, phase
    for (const it of j.items) {
      expect(typeof it.icon).toBe("string");
      expect(typeof it.text).toBe("string");
      expect(["review", "action", "outcome"]).toContain(it.phase);
    }
    // counts agree with items, and the lead names the nonzero phases
    const counts: Record<string, number> = { review: 0, action: 0, outcome: 0 };
    for (const it of j.items) counts[it.phase]++;
    expect(j.counts).toEqual(counts);
    for (const p of ["review", "action", "outcome"]) {
      if (counts[p] > 0) expect(j.lead).toContain(`${counts[p]} in ${p}`);
    }
    // phase order invariant: review items, then action, then outcome
    const order = { review: 0, action: 1, outcome: 2 };
    const seq = j.items.map((it: any) => order[it.phase as keyof typeof order]);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  test("both review and action phases fire on the fixture", async () => {
    const j: any = await (await fetch(base + "/api/hygiene")).json();
    expect(j.counts.review).toBeGreaterThan(0);
    expect(j.counts.action).toBeGreaterThan(0);
  });

  test("forwards ?workspace= to exec-crm", async () => {
    lastWorkspaceParam = null;
    const r = await fetch(base + "/api/hygiene?workspace=2");
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.workspace_id).toBe(2);
    expect(lastWorkspaceParam).toBe("2");
  });

  test("rejects a non-integer workspace", async () => {
    const r = await fetch(base + "/api/hygiene?workspace=abc");
    expect(r.status).toBe(400);
  });

  test("matches the chat reply's lead text exactly", async () => {
    const api: any = await (await fetch(base + "/api/hygiene")).json();
    const chat: any = await (await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "hygiene-api-test", message: "pipeline hygiene" }),
    })).json();
    expect(chat.text).toBe(api.lead);
  });
});

// meridian_runs.test.ts — requesting Meridian recon runs through the router:
// intent parsing, the run-request POST shape, hook auth (401/503/200 logic),
// completion-callback handling (known + unknown run_ids), workspace pinning.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent } from "../src/intents";
import { hookSecret, verifyHookSecret } from "../src/hookauth";
import * as mer from "../src/meridian";
import * as rr from "../src/recon_runs";
import * as auto from "../src/automation";
import { handleMessage, handleMeridianCallback, type Session } from "../src/brain";

const sess = (id: string, workspaceId?: number): Session =>
  ({ id, history: [], notes: [], workspaceId: workspaceId ?? undefined });

const SECRET = "test-hook-secret";
const prevSecret = process.env.MILTON_HOOK_SECRET;
const prevBase = process.env.MILTON_BASE_URL;
let prevFetch: typeof fetch;

// ---- stub Meridian (self-contained: handles /api/runs itself) -----------------------
let n = 0;
let runStatus = 202;
let lastRunPost: { method: string; body: any } | null = null;

function stubRuns(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (url === mer.meridianBase() + "/api/runs") {
    lastRunPost = { method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    if (runStatus !== 202) return ok({ error: "bad request" }, runStatus);
    n += 1;
    return ok({ run_id: `run-test-${n}`, status: n === 1 ? "running" : "queued" }, 202);
  }
  if (url === mer.meridianBase() + "/api/recon") {
    return ok({ recons: [{ id: "r1", city: "Austin", country: "US", status: "done", created_at: "", updated_at: "", nodes: 1, edges: 0 }] });
  }
  return Promise.reject(new Error("unexpected fetch " + url));
}

beforeAll(() => {
  const db = new Database(":memory:");
  auto.initAutomationDb(db);
  rr.initReconRunsDb(db);
  process.env.MILTON_HOOK_SECRET = SECRET;
  delete process.env.MILTON_BASE_URL;
  prevFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = stubRuns;
  mer.clearReconCache();
});

afterAll(() => {
  // restore the real fetch: later files (e.g. upload.test.ts) talk to a live server
  (globalThis as any).fetch = prevFetch;
  if (prevSecret === undefined) delete process.env.MILTON_HOOK_SECRET;
  else process.env.MILTON_HOOK_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.MILTON_BASE_URL;
  else process.env.MILTON_BASE_URL = prevBase;
});

// ---- hookauth -------------------------------------------------------------------------
describe("hookauth", () => {
  test("hookSecret reads the env", () => {
    expect(hookSecret()).toBe(SECRET);
    delete process.env.MILTON_HOOK_SECRET;
    expect(hookSecret()).toBe("");
    process.env.MILTON_HOOK_SECRET = SECRET;
  });
  test("verifyHookSecret accepts the right secret", () => {
    expect(verifyHookSecret(SECRET)).toBe(true);
  });
  test("verifyHookSecret rejects wrong or empty secrets", () => {
    expect(verifyHookSecret("nope")).toBe(false);
    expect(verifyHookSecret("")).toBe(false);
    expect(verifyHookSecret(SECRET + "x")).toBe(false);
  });
  test("verifyHookSecret is false when no secret is configured", () => {
    delete process.env.MILTON_HOOK_SECRET;
    expect(verifyHookSecret(SECRET)).toBe(false);
    process.env.MILTON_HOOK_SECRET = SECRET;
  });
});

// ---- intent parsing ----------------------------------------------------------------------
describe("meridian_request intent parsing", () => {
  test("meridian recon <city>", () => {
    const i = parseIntent("meridian recon Austin");
    expect(i.name).toBe("meridian_request");
    expect(i.slots.city).toBe("Austin");
  });
  test("meridian run <city>", () => {
    const i = parseIntent("meridian run Berlin");
    expect(i.name).toBe("meridian_request");
    expect(i.slots.city).toBe("Berlin");
  });
  test("casing is preserved, multi-word cities work", () => {
    const i = parseIntent("Meridian Run New York");
    expect(i.name).toBe("meridian_request");
    expect(i.slots.city).toBe("New York");
  });
  test("bare meridian recon still lists sprints (empty city never becomes a request)", () => {
    expect(parseIntent("meridian recon").name).toBe("list_recons");
    expect(parseIntent("meridian recons").name).toBe("list_recons");
  });
});

// ---- milton base URL -----------------------------------------------------------------------
describe("miltonBase", () => {
  test("defaults to localhost:3009", () => {
    delete process.env.MILTON_BASE_URL;
    expect(mer.miltonBase()).toBe("http://localhost:3009");
  });
  test("MILTON_BASE_URL overrides, trailing slash stripped", () => {
    process.env.MILTON_BASE_URL = "http://pi:3009/";
    expect(mer.miltonBase()).toBe("http://pi:3009");
    delete process.env.MILTON_BASE_URL;
  });
});

// ---- run-request chat flow --------------------------------------------------------------------
describe("meridian run request flow", () => {
  test("posts city + callback_url + secret header when configured", async () => {
    const r = await handleMessage(sess("mr-1"), "meridian recon Austin");
    expect(lastRunPost?.method).toBe("POST");
    expect(lastRunPost?.body.city).toBe("Austin");
    expect(lastRunPost?.body.callback_url).toBe("http://localhost:3009/api/hooks/meridian");
    expect(lastRunPost?.body.callback_headers).toEqual({ "X-Milton-Secret": SECRET });
    expect(r.text).toContain("Run requested");
    expect(r.text).toContain("Austin");
    expect(r.text).toContain("running");
    expect(r.text).toContain("run-test"); // short run id
    expect(r.text).toContain("report back");
  });
  test("pending run is persisted", async () => {
    await handleMessage(sess("mr-2"), "meridian recon Denver");
    const latest = rr.listRunRequests()[0];
    expect(latest.city).toBe("Denver");
    expect(latest.workspace_id).toBeNull();
    expect(latest.status).toBe("queued");
    expect(latest.completed_at).toBeNull();
  });
  test("pending run pins the requesting session's workspace", async () => {
    await handleMessage(sess("mr-3", 7), "meridian recon Rome");
    const latest = rr.listRunRequests()[0];
    expect(latest.city).toBe("Rome");
    expect(latest.workspace_id).toBe(7);
  });
  test("without MILTON_HOOK_SECRET the callback is omitted and the user is told to check back", async () => {
    delete process.env.MILTON_HOOK_SECRET;
    try {
      const r = await handleMessage(sess("mr-4"), "meridian recon Paris");
      expect(lastRunPost?.body.city).toBe("Paris");
      expect("callback_url" in (lastRunPost?.body || {})).toBe(false);
      expect("callback_headers" in (lastRunPost?.body || {})).toBe(false);
      expect(r.text).toContain("Run requested");
      expect(r.text).toContain("meridian recons");
    } finally {
      process.env.MILTON_HOOK_SECRET = SECRET;
    }
  });
  test("a rejected run is reported plainly", async () => {
    runStatus = 400;
    try {
      const r = await handleMessage(sess("mr-5"), "meridian recon Nowhere");
      expect(r.text).toContain("wouldn't take the run");
    } finally {
      runStatus = 202;
    }
  });
});

// ---- completion callback -------------------------------------------------------------------------
describe("meridian completion callback", () => {
  test("known run: marked completed and recorded as an automation run", async () => {
    await handleMessage(sess("mr-6", 3), "meridian recon Lyon");
    const runId = rr.listRunRequests()[0].run_id;
    const { known, run } = handleMeridianCallback({
      run_id: runId, city: "Lyon", label: "", status: "ready",
      nodes: 12, edges: 9,
      result_url: "http://m:3005/api/recon/x", export_url: "http://m:3005/api/recon/x/export",
    });
    expect(known).toBe(true);
    expect(run.kind).toBe("meridian");
    expect(run.status).toBe("ok");
    expect(run.routine_name).toBe("Recon: Lyon");
    expect(run.summary).toContain("ready");
    expect(run.summary).toContain("12 nodes");
    expect(run.summary).toContain("9 edges");
    expect(run.detail.result_url).toBe("http://m:3005/api/recon/x");
    expect(run.detail.workspace_id).toBe(3);
    const stored = rr.getRunRequest(runId)!;
    expect(stored.nodes).toBe(12);
    expect(stored.edges).toBe(9);
    expect(stored.completed_at).not.toBeNull();
    // visible in the Runs list
    const inRuns = auto.listRuns(50).find((x) => x.id === run.id);
    expect(inRuns?.kind).toBe("meridian");
  });
  test("unknown run_id is still recorded, marked unknown", () => {
    const { known, run } = handleMeridianCallback({
      run_id: "ghost-1", city: "Nice", label: "", status: "failed",
      nodes: 0, edges: 0, result_url: "", export_url: "",
    });
    expect(known).toBe(false);
    expect(run.kind).toBe("meridian");
    expect(run.status).toBe("failed");
    expect(run.summary).toContain("not requested from here");
    expect(run.detail.known).toBe(false);
    expect(run.detail.run_id).toBe("ghost-1");
  });
  test("partial status maps to partial", () => {
    const { run } = handleMeridianCallback({ run_id: "ghost-2", city: "", label: "Late run", status: "partial", nodes: 5, edges: 4 });
    expect(run.status).toBe("partial");
    expect(run.routine_name).toBe("Recon: Late run");
  });
});

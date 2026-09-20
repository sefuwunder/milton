// meridian_prospect.test.ts — Milton's "meridian prospect <industry> in <location>"
// flow: intent parsing (industry/location slots, missing-slot clarifications),
// async job launch, status polling (running/done/failed), the 30s background
// tick, session persistence of the in-flight job, and staging into exec-crm's
// Data Workshop Sandbox as a workspace-scoped batch — staged, never committed.
//
// Stub Meridian + exec-crm in ALL tests — never hit real endpoints.
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { parseIntent } from "../src/intents";
import * as mer from "../src/meridian";
import { runWithWorkspace } from "../src/workspace";
import {
  handleMessage, prospectTerminalReply, prospectTickDecision,
  buildProspectBatch, prospectNotes, stageProspects,
  PROSPECT_BATCH_MAX_ROWS, PROSPECT_JOB_TIMEOUT_MS,
  type Session, type ProspectJobState,
} from "../src/brain";

const sess = (id: string): Session => ({ id, history: [], notes: [] });

// ---- fixtures (mutable per test) ------------------------------------------------------
let crmCompanies: any[] = [];
let companiesListFails = false;
let meridianDown = false;
let prospectScript: (id: string) => any = () => doneProspectJob;
let lastProspectPost: any = null;
let lastSandboxPost: any = null;
let lastSandboxUrl: string | null = null;

const prospectCompanies = [
  {
    name: "Bright Smile Dental", address: "123 Main St, Madisonville, OH",
    lat: 39.16, lon: -84.38,
    tags: { amenity: "dentist", healthcare: "dental" },
    industry: "dental clinics", territory: "Madisonville", source: "overpass", prospect: true,
  },
  {
    name: "Pearl Family Dentistry", address: "456 Oak Ave, Madisonville, OH",
    lat: 39.17, lon: -84.39,
    tags: { amenity: "dentist" },
    industry: "dental clinics", territory: "Madisonville", source: "overpass", prospect: true,
  },
  {
    name: 'Bob\'s "Best" Dental, LLC', address: "789 Elm St, Madisonville, OH",
    tags: {},
    industry: "dental clinics", territory: "Madisonville", source: "overpass", prospect: true,
  },
];

const doneProspectJob = {
  id: "pjob1", location: "Madisonville", industry: "dental clinics", status: "done",
  progress: { done: 3, total: 3 },
  error: null,
  companies: prospectCompanies,
  nodes: [], edges: [],
  created_at: 1, updated_at: 2,
};

const ok = (data: any, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const CRM = "http://localhost:3001";
  if (url.startsWith(CRM)) {
    const [path, qs] = url.slice(CRM.length).split("?");
    if (path === "/api/companies") {
      if (companiesListFails) return ok({ error: "boom" }, 500);
      return ok({ companies: crmCompanies });
    }
    if (path === "/api/sandbox/batches" && init.method === "POST") {
      lastSandboxUrl = url;
      lastSandboxPost = JSON.parse(String(init.body || "{}"));
      return ok({ batch: { id: 9, name: lastSandboxPost.name }, summary: { rows: 3 }, warnings: [] }, 201);
    }
    return ok({ error: "not found" }, 404);
  }
  if (url.startsWith(mer.meridianBase())) {
    if (meridianDown) return Promise.reject(new Error("fetch failed"));
    const path = url.slice(mer.meridianBase().length).split("?")[0];
    if (path === "/api/prospect" && init.method === "POST") {
      lastProspectPost = JSON.parse(String(init.body || "{}"));
      return ok({ job_id: "pjob1", status: "running" }, 201);
    }
    const m = path.match(/^\/api\/prospect\/([^/]+)$/);
    if (m) {
      const j = prospectScript(m[1]);
      if (!j) return ok({ error: "not found" }, 404);
      return ok({ job: j });
    }
    return ok({ error: "not found" }, 404);
  }
  return Promise.reject(new Error("unexpected fetch: " + url));
}

const realFetch = globalThis.fetch.bind(globalThis);
function install() {
  (globalThis as any).fetch = stubFetch;
  meridianDown = false;
  companiesListFails = false;
  crmCompanies = [];
  lastProspectPost = null;
  lastSandboxPost = null;
  lastSandboxUrl = null;
  prospectScript = () => doneProspectJob;
}
afterEach(() => { (globalThis as any).fetch = realFetch; });

// ---- intent parsing -------------------------------------------------------------------
describe("prospect intents", () => {
  test("meridian prospect <industry> in <location>", () => {
    const i = parseIntent("meridian prospect dental clinics in Madisonville");
    expect(i.name).toBe("meridian_prospect");
    expect(i.slots.industry).toBe("dental clinics");
    expect(i.slots.location).toBe("Madisonville");
  });
  test("case-insensitive, locations containing 'in'", () => {
    const i = parseIntent("Meridian Prospect Cafes IN Berlin in Germany");
    expect(i.name).toBe("meridian_prospect");
    expect(i.slots.industry).toBe("Cafes");
    expect(i.slots.location).toBe("Berlin in Germany");
  });
  test("bare 'meridian prospect' -> missing both slots", () => {
    const i = parseIntent("meridian prospect");
    expect(i.name).toBe("meridian_prospect");
    expect(i.slots.industry || "").toBe("");
    expect(i.slots.location || "").toBe("");
  });
  test("'meridian prospect <industry>' -> missing location", () => {
    const i = parseIntent("meridian prospect dental clinics");
    expect(i.name).toBe("meridian_prospect");
    expect(i.slots.industry).toBe("dental clinics");
    expect(i.slots.location || "").toBe("");
  });
  test("'meridian prospect in <location>' -> missing industry", () => {
    const i = parseIntent("meridian prospect in Madisonville");
    expect(i.name).toBe("meridian_prospect");
    expect(i.slots.industry || "").toBe("");
    expect(i.slots.location).toBe("Madisonville");
  });
  test("prospect status", () => {
    expect(parseIntent("prospect status").name).toBe("meridian_prospect_status");
    expect(parseIntent("check prospecting").name).toBe("meridian_prospect_status");
  });
  test("does not swallow 'meridian recon <city>'", () => {
    expect(parseIntent("meridian recon Austin").name).toBe("meridian_request");
  });
});

// ---- missing-slot clarifications ------------------------------------------------------
describe("prospect clarifications", () => {
  test("bare command asks for industry + location with an example", async () => {
    install();
    const r = await handleMessage(sess("p-1"), "meridian prospect");
    expect(r.text).toContain("meridian prospect dental clinics in Madisonville");
    expect(lastProspectPost).toBeNull();
  });
  test("industry only asks which territory", async () => {
    install();
    const r = await handleMessage(sess("p-2"), "meridian prospect dental clinics");
    expect(r.text).toMatch(/which territory/i);
    expect(r.text).toContain("dental clinics");
    expect(lastProspectPost).toBeNull();
  });
  test("location only asks which industry", async () => {
    install();
    const r = await handleMessage(sess("p-3"), "meridian prospect in Madisonville");
    expect(r.text).toMatch(/which industry/i);
    expect(r.text).toContain("Madisonville");
    expect(lastProspectPost).toBeNull();
  });
});

// ---- meridian.ts client ---------------------------------------------------------------
describe("prospect client", () => {
  test("requestProspect posts {location, industry} -> 201 {job_id}", async () => {
    install();
    const r = await mer.requestProspect("Madisonville", "dental clinics");
    expect(r).toEqual({ ok: true, job_id: "pjob1", status: "running" });
    expect(lastProspectPost).toEqual({ location: "Madisonville", industry: "dental clinics" });
  });
  test("requestProspect unreachable -> unreachable flag", async () => {
    install();
    meridianDown = true;
    const r = await mer.requestProspect("Madisonville", "dental clinics");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unreachable).toBe(true);
  });
  test("getProspectJob parses the API contract shape", async () => {
    install();
    const j = await mer.getProspectJob("pjob1");
    expect(j?.id).toBe("pjob1");
    expect(j?.location).toBe("Madisonville");
    expect(j?.industry).toBe("dental clinics");
    expect(j?.status).toBe("done");
    expect(j?.companies?.length).toBe(3);
    expect(j?.companies?.[0]).toMatchObject({
      name: "Bright Smile Dental", address: "123 Main St, Madisonville, OH",
      lat: 39.16, source: "overpass", prospect: true,
    });
    expect(j?.companies?.[0].tags).toEqual({ amenity: "dentist", healthcare: "dental" });
    expect(j?.progress).toEqual({ done: 3, total: 3 });
    expect(j?.nodes).toEqual([]);
  });
  test("getProspectJob returns null for unknown id", async () => {
    install();
    prospectScript = () => null;
    expect(await mer.getProspectJob("nope")).toBeNull();
  });
  test("getProspectJob tolerates sparse companies", async () => {
    install();
    prospectScript = () => ({ ...doneProspectJob, companies: [{ name: "  Lone Wolf Co  " }] });
    const j = await mer.getProspectJob("pjob1");
    expect(j?.companies?.length).toBe(1);
    expect(j?.companies?.[0].name).toBe("  Lone Wolf Co  ");
    expect(j?.companies?.[0].tags).toEqual({});
  });
});

// ---- launch ---------------------------------------------------------------------------
describe("prospect launch", () => {
  test("full command parks the job and replies with a progress card", async () => {
    install();
    const s = sess("p-4");
    const r = await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    expect(r.text).toContain("🔎 Prospecting **dental clinics** in **Madisonville**");
    expect(r.text).toContain("30 seconds");
    expect(r.text).toContain("prospect status");
    expect(s.prospectJob?.job_id).toBe("pjob1");
    expect(s.prospectJob?.industry).toBe("dental clinics");
    expect(s.prospectJob?.location).toBe("Madisonville");
    expect(lastSandboxPost).toBeNull(); // nothing staged at launch
  });
  test("unreachable Meridian reports plainly", async () => {
    install();
    meridianDown = true;
    const s = sess("p-5");
    const r = await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    expect(r.text).toMatch(/can't reach meridian/i);
    expect(s.prospectJob).toBeUndefined();
  });
});

// ---- status polling + staging ----------------------------------------------------------
describe("prospect status", () => {
  test("no parked job explains itself", async () => {
    install();
    const r = await handleMessage(sess("p-6"), "prospect status");
    expect(r.text).toContain("No prospecting job is running");
  });
  test("running job reports progress and stays parked", async () => {
    install();
    prospectScript = () => ({
      ...doneProspectJob, status: "running",
      progress: { done: 7, total: 20, current: "scanning Overpass tiles" },
    });
    const s = sess("p-7");
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("Still prospecting **dental clinics** in **Madisonville**");
    expect(r.text).toContain("7/20");
    expect(r.text).toContain("scanning Overpass tiles");
    expect(s.prospectJob).toBeTruthy();
    expect(lastSandboxPost).toBeNull();
  });
  test("done job stages into the sandbox with the workspace param", async () => {
    install();
    const s = sess("p-8");
    s.workspaceId = 42;
    s.workspaceName = "Q3 Push";
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    // staged confirmation
    expect(r.text).toContain("✅ Staged **3** companies into the Data Workshop Sandbox");
    expect(r.text).toContain("Q3 Push");
    expect(r.text).toContain("nothing was imported");
    expect(r.text).toContain("`9`");
    expect(r.text).toContain("Bright Smile Dental");
    expect(r.text).toContain("Pearl Family Dentistry");
    expect(s.prospectJob).toBeUndefined();
    // sandbox payload
    expect(lastSandboxUrl).toContain("workspace=42");
    expect(lastSandboxUrl).toContain("/api/sandbox/batches");
    expect(lastSandboxPost.name).toBe("Meridian prospects — dental clinics · Madisonville");
    expect(lastSandboxPost.filename).toBe("meridian-prospects-dental-clinics-madisonville.csv");
    const lines = String(lastSandboxPost.csv).split("\n");
    expect(lines[0]).toBe("name,title,email,phone,company,notes");
    expect(lines.length).toBe(4); // header + 3 rows
    // name and company both carry the company name
    expect(lines[1].startsWith("Bright Smile Dental,")).toBe(true);
    // notes carry the provenance marker, address, and OSM tags (quoted)
    expect(lastSandboxPost.csv).toContain("meridian-prospect · territory: Madisonville · industry: dental clinics");
    expect(lastSandboxPost.csv).toContain("123 Main St, Madisonville, OH");
    expect(lastSandboxPost.csv).toContain("amenity=dentist; healthcare=dental");
    // CSV escaping: comma + quotes in the company name
    expect(lastSandboxPost.csv).toContain('"Bob\'s ""Best"" Dental, LLC"');
  });
  test("sandbox POST without a session workspace sends no workspace param", async () => {
    install();
    const s = sess("p-8b"); // workspaceId unset -> default workspace
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    await handleMessage(s, "prospect status");
    expect(lastSandboxUrl).not.toContain("workspace=");
    expect(lastSandboxUrl).toContain("/api/sandbox/batches");
  });
  test("companies already in the CRM are flagged in the row notes", async () => {
    install();
    crmCompanies = [{ id: 5, name: "Pearl Family Dentistry", industry: "", website: "", notes: "" }];
    const s = sess("p-9");
    s.workspaceId = 7;
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("✅ Staged **3** companies");
    expect(lastSandboxPost.csv).toContain("already in your CRM");
  });
  test("CRM company-list failure does not kill staging", async () => {
    install();
    companiesListFails = true;
    const s = sess("p-10");
    s.workspaceId = 7;
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("✅ Staged **3** companies");
    expect(lastSandboxPost).toBeTruthy();
    expect(lastSandboxPost.csv).not.toContain("already in your CRM");
  });
  test("failed job reports the error plainly, stages nothing", async () => {
    install();
    prospectScript = () => ({ ...doneProspectJob, status: "failed", error: "Overpass timed out", companies: null });
    const s = sess("p-11");
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("failed");
    expect(r.text).toContain("Overpass timed out");
    expect(lastSandboxPost).toBeNull();
    expect(s.prospectJob).toBeUndefined();
  });
  test("done job with no companies says so plainly", async () => {
    install();
    prospectScript = () => ({ ...doneProspectJob, companies: [] });
    const s = sess("p-12");
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("didn't find any companies");
    expect(lastSandboxPost).toBeNull();
  });
  test("sandbox POST failure is reported cleanly", async () => {
    install();
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes("/api/sandbox/batches")) return ok({ error: "disk full" }, 500);
      return stubFetch(input, init);
    };
    const s = sess("p-13");
    s.workspaceId = 7;
    await handleMessage(s, "meridian prospect dental clinics in Madisonville");
    const r = await handleMessage(s, "prospect status");
    expect(r.text).toContain("couldn't stage");
    expect(r.text).toContain("Nothing was imported");
    expect(s.prospectJob).toBeUndefined(); // cleared — no silent re-stage
  });
});

// ---- buildProspectBatch: dedupe, cap, notes --------------------------------------------
describe("buildProspectBatch", () => {
  test("dedupes by normalized company name", () => {
    const b = buildProspectBatch("dental clinics", "Madisonville", [
      { name: "Acme Dental" }, { name: "acme  dental!" }, { name: "ACME DENTAL" }, { name: "Other Co" },
    ] as any);
    expect(b.count).toBe(2);
    expect(b.samples).toEqual(["Acme Dental", "Other Co"]);
  });
  test("caps at PROSPECT_BATCH_MAX_ROWS", () => {
    const cos = Array.from({ length: PROSPECT_BATCH_MAX_ROWS + 50 }, (_, i) => ({ name: `Company ${i}` })) as any;
    const b = buildProspectBatch("x", "y", cos);
    expect(b.count).toBe(PROSPECT_BATCH_MAX_ROWS);
    expect(PROSPECT_BATCH_MAX_ROWS).toBeLessThanOrEqual(500);
  });
  test("notes format: single-line marker + territory + industry + address + tags", () => {
    const n = prospectNotes(
      { name: "Bright Smile Dental", address: "123 Main St", tags: { amenity: "dentist" }, territory: "Madisonville" } as any,
      "dental clinics", "Elsewhere", false,
    );
    expect(n).toBe(
      "meridian-prospect · territory: Madisonville · industry: dental clinics · 123 Main St · amenity=dentist",
    );
    expect(n).not.toContain("\n"); // sandbox CSV is line-oriented
  });
  test("notes fall back to the job location when the company has no territory", () => {
    const n = prospectNotes({ name: "X" } as any, "dental clinics", "Madisonville", false);
    expect(n).toContain("territory: Madisonville");
  });
  test("empty and blank names are skipped", () => {
    const b = buildProspectBatch("x", "y", [{ name: "" }, { name: "   " }, { name: "Real Co" }] as any);
    expect(b.count).toBe(1);
  });
});

// ---- tick decision: pure, injectable clock ----------------------------------------------
describe("prospectTickDecision", () => {
  const job = (at: number): ProspectJobState =>
    ({ job_id: "pjob1", industry: "dental clinics", location: "Madisonville", at });
  test("done and failed deliver immediately", () => {
    expect(prospectTickDecision(job(1000), "done", 2000)).toBe("done");
    expect(prospectTickDecision(job(1000), "failed", 2000)).toBe("failed");
  });
  test("running keeps polling inside the timeout", () => {
    expect(prospectTickDecision(job(1000), "running", 1000 + PROSPECT_JOB_TIMEOUT_MS)).toBe("keep");
  });
  test("running past the timeout is stale", () => {
    expect(prospectTickDecision(job(1000), "running", 1000 + PROSPECT_JOB_TIMEOUT_MS + 1)).toBe("stale");
  });
});

// ---- terminal reply: shared by manual status and the background tick --------------------
describe("prospectTerminalReply", () => {
  const job: ProspectJobState =
    ({ job_id: "pjob1", industry: "dental clinics", location: "Madisonville", at: 1 });
  test("done stages and confirms, with samples", async () => {
    install();
    const s = sess("p-20");
    s.workspaceId = 42;
    s.workspaceName = "Q3 Push";
    // prospectTerminalReply reads the ambient workspace (handleMessage and
    // the 30s tick both wrap it in runWithWorkspace) — provide it here too.
    const r = await runWithWorkspace(s.workspaceId, () => prospectTerminalReply(s, job, doneProspectJob as any));
    expect(r.text).toContain("✅ Staged **3** companies");
    expect(r.text).toContain("Q3 Push");
    expect(lastSandboxUrl).toContain("workspace=42");
    expect(r.text).toContain("Bright Smile Dental");
  });
  test("failed reports the error", async () => {
    install();
    const s = sess("p-21");
    const r = await prospectTerminalReply(s, job, { ...doneProspectJob, status: "failed", error: "boom" } as any);
    expect(r.text).toContain("failed");
    expect(r.text).toContain("boom");
    expect(lastSandboxPost).toBeNull();
  });
});

// ---- 30s background tick: persistence round-trip + delivery -----------------------------
// Boots the real server once against a scratch data dir. The tick scans the
// sessions table for parked prospectJobs, polls Meridian, and on `done`
// stages the batch into the sandbox itself (staged, never committed).
describe("prospect tick", () => {
  let srv: any;
  const TICK_SID = "prospect-tick-test";

  const tickJob: ProspectJobState =
    ({ job_id: "pjob1", industry: "dental clinics", location: "Madisonville", at: Date.now() });

  function tickStubFetch(input: any, init: any = {}): Promise<Response> {
    const url = String(input);
    if (url.startsWith(mer.meridianBase())) {
      if ((globalThis as any).__tickMeridianDown)
        return Promise.reject(new Error("fetch failed"));
      const m = url.match(/\/api\/prospect\/([^/?]+)/);
      if (m) return ok((globalThis as any).__tickJobJson || doneProspectJob);
      return ok({ error: "not found" }, 404);
    }
    if (url.startsWith("http://localhost:3001")) {
      const path = url.slice("http://localhost:3001".length).split("?")[0];
      if (path === "/api/companies") return ok({ companies: [] });
      if (path === "/api/sandbox/batches" && init.method === "POST") {
        (globalThis as any).__tickSandboxPost = JSON.parse(String(init.body || "{}"));
        (globalThis as any).__tickSandboxUrl = url;
        return ok({ batch: { id: 11, name: "Meridian prospects" }, summary: {}, warnings: [] }, 201);
      }
      return ok({ error: "not found" }, 404);
    }
    return realFetch(input, init);
  }

  beforeAll(async () => {
    process.env.MILTON_DATA = `/tmp/milton-prospect-tick-test-${Date.now()}`;
    process.env.PORT = "0";
    srv = await import("../src/server.ts");
    // The server module binds its database on first import and bun shares
    // module state across test files: if another file imported server.ts
    // first, this import is cached and MILTON_DATA above is ignored. Reset
    // explicitly so the tick tests always run against their own dir.
    srv.__resetDataDirForTests(process.env.MILTON_DATA);
    const { ensureChatSession } = await import("../src/chat_sessions");
    ensureChatSession(TICK_SID);
  });

  afterAll(() => {
    (globalThis as any).fetch = realFetch;
    delete (globalThis as any).__tickMeridianDown;
    delete (globalThis as any).__tickJobJson;
    delete (globalThis as any).__tickSandboxPost;
    delete (globalThis as any).__tickSandboxUrl;
  });

  function parkJob(job: ProspectJobState) {
    (globalThis as any).fetch = tickStubFetch;
    const s = srv.loadSession(TICK_SID);
    s.prospectJob = job;
    s.pending = undefined;
    s.history = [];
    srv.saveSession(s);
  }

  test("in-flight job survives a session reload between launch and status", () => {
    parkJob({ ...tickJob });
    const reloaded = srv.loadSession(TICK_SID);
    expect(reloaded.prospectJob?.job_id).toBe("pjob1");
    expect(reloaded.prospectJob?.industry).toBe("dental clinics");
    expect(reloaded.prospectJob?.location).toBe("Madisonville");
  });

  test("tick stages the done batch and reports the confirmation", async () => {
    (globalThis as any).__tickJobJson = doneProspectJob;
    parkJob({ ...tickJob });
    await srv.tickProspect();
    const s = srv.loadSession(TICK_SID);
    expect(s.prospectJob).toBeUndefined();
    const post = (globalThis as any).__tickSandboxPost;
    expect(post.name).toBe("Meridian prospects — dental clinics · Madisonville");
    expect(String(post.csv).split("\n")[0]).toBe("name,title,email,phone,company,notes");
    expect(s.history.some((h: any) => h.text.includes("✅ Staged **3** companies"))).toBe(true);
    expect(s.history.some((h: any) => h.text.includes("Data Workshop Sandbox"))).toBe(true);
  });

  test("tick delivers the failure note", async () => {
    (globalThis as any).__tickJobJson = { ...doneProspectJob, status: "failed", error: "Overpass blew up", companies: null };
    parkJob({ ...tickJob });
    await srv.tickProspect();
    const s = srv.loadSession(TICK_SID);
    expect(s.prospectJob).toBeUndefined();
    expect(s.history.some((h: any) => h.text.includes("Overpass blew up"))).toBe(true);
  });

  test("tick leaves the job parked when Meridian is unreachable", async () => {
    (globalThis as any).__tickMeridianDown = true;
    try {
      parkJob({ ...tickJob });
      await srv.tickProspect();
      expect(srv.loadSession(TICK_SID).prospectJob?.job_id).toBe("pjob1");
    } finally {
      (globalThis as any).__tickMeridianDown = false;
    }
  });

  test("tick marks a job stale past the timeout and tells the user to retry", async () => {
    (globalThis as any).__tickJobJson = { ...doneProspectJob, status: "running" };
    parkJob({ ...tickJob, at: Date.now() - PROSPECT_JOB_TIMEOUT_MS - 1000 });
    await srv.tickProspect();
    const s = srv.loadSession(TICK_SID);
    expect(s.prospectJob).toBeUndefined();
    const last = s.history[s.history.length - 1];
    expect(last.text).toMatch(/stalled/i);
    expect(last.text).toContain("meridian prospect dental clinics in Madisonville");
  });
});

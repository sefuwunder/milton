// observer.test.ts — F2 deal observer: backfill, differ, close_log, idempotency.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initObserverDb, observeOnce, maybeObserve, OBSERVER_INTERVAL_MS,
  valueBand, dwellBucketFor, parseMoveActivity,
} from "/home/hatch/workspace/your_files/milton/src/observer";
import { initSettingsDb, getSetting, setSetting } from "/home/hatch/workspace/your_files/milton/src/settings";
import { clearWorkspaceCache } from "/home/hatch/workspace/your_files/milton/src/workspace";

// ---- stub exec-crm --------------------------------------------------------------
let workspaces: any[] = [];
let dealsByWs: Record<string, any[]> = {};
let stagesByWs: Record<string, any[]> = {};
let activitiesByWs: Record<string, any[]> = {};
let companiesByWs: Record<string, any[]> = {};
let failAll = false;

function ok(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function stubFetch(input: any, init?: any): Promise<Response> {
  if (failAll) throw new Error("connection refused");
  const url = new URL(String(input));
  const ws = url.searchParams.get("workspace") || "default";
  const path = url.pathname;
  if (path === "/api/workspaces") return ok({ workspaces });
  if (path === "/api/deals") return ok({ deals: dealsByWs[ws] || [] });
  if (path === "/api/stages") return ok({ stages: stagesByWs[ws] || [] });
  if (path === "/api/activities") return ok({ activities: activitiesByWs[ws] || [] });
  if (path === "/api/companies") return ok({ companies: companiesByWs[ws] || [] });
  return ok({ error: "not found" }, 404);
}
const realFetch = globalThis.fetch.bind(globalThis);

const STAGES = [
  { slug: "prospecting", name: "Prospecting", position: 0, color: "#888" },
  { slug: "negotiation", name: "Negotiation", position: 1, color: "#888" },
  { slug: "closed_won", name: "Closed won", position: 2, color: "#888" },
  { slug: "closed_lost", name: "Closed lost", position: 3, color: "#888" },
];
function deal(id: number, title: string, stage: string, value: number, extra: any = {}) {
  return {
    id, title, stage, value, probability: 50, expected_close: "2026-12-31",
    owner: "sam", company_id: 9, contact_id: null, created_at: "2026-08-01T09:00:00",
    updated_at: "2026-09-10T09:00:00", ...extra,
  };
}
function seed() {
  workspaces = [{ id: 7, name: "W7", color: "#579bfc" }];
  stagesByWs = { "7": STAGES, default: STAGES };
  companiesByWs = {
    "7": [{ id: 9, name: "Acme Co", industry: "software", website: "", notes: "" }],
    default: [],
  };
  activitiesByWs = {
    "7": [
      { id: 1, kind: "deal", text: "Acme moved to Prospecting", ref_type: "", ref_id: 0, created_at: "2026-09-01T10:00:00" },
      { id: 2, kind: "deal", text: "Acme moved to Negotiation", ref_type: "", ref_id: 0, created_at: "2026-09-05T10:00:00" },
      { id: 3, kind: "deal", text: "Beta moved to Negotiation", ref_type: "", ref_id: 0, created_at: "2026-09-03T10:00:00" },
      { id: 4, kind: "deal", text: "Dup moved to Prospecting", ref_type: "", ref_id: 0, created_at: "2026-09-02T10:00:00" },
      { id: 5, kind: "deal", text: "Acme moved to Atlantis", ref_type: "", ref_id: 0, created_at: "2026-09-06T10:00:00" },
      { id: 6, kind: "task", text: "Completed: something", ref_type: "", ref_id: 0, created_at: "2026-09-04T10:00:00" },
      { id: 7, kind: "deal", text: "Acme created", ref_type: "", ref_id: 0, created_at: "2026-08-20T10:00:00" },
    ],
    default: [],
  };
  dealsByWs = {
    "7": [
      deal(1, "Acme", "prospecting", 5000),
      deal(2, "Beta", "closed_lost", 1200, { updated_at: "2026-09-08T10:00:00" }),
      deal(3, "Dup", "prospecting", 300),
      deal(4, "Dup", "negotiation", 400),
      deal(5, "Gamma", "prospecting", 75000),
    ],
    default: [],
  };
  failAll = false;
}

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  initSettingsDb(db);
  initObserverDb(db);
});
beforeEach(() => {
  (globalThis as any).fetch = stubFetch;
  clearWorkspaceCache();
  seed();
  // fresh tables each test
  db.exec("DELETE FROM deal_snapshots; DELETE FROM stage_transitions; DELETE FROM close_log; DELETE FROM settings;");
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

// ---- pure helpers -----------------------------------------------------------------
describe("pure helpers", () => {
  test("valueBand boundaries", () => {
    expect(valueBand(0)).toBe("<1k");
    expect(valueBand(999.99)).toBe("<1k");
    expect(valueBand(1000)).toBe("1-10k");
    expect(valueBand(9999)).toBe("1-10k");
    expect(valueBand(10000)).toBe("10-50k");
    expect(valueBand(49999)).toBe("10-50k");
    expect(valueBand(50000)).toBe(">50k");
  });
  test("dwellBucketFor relative to median", () => {
    expect(dwellBucketFor(1, 10)).toBe("lt-half-median");
    expect(dwellBucketFor(10, 10)).toBe("median-2xmedian");
    expect(dwellBucketFor(25, 10)).toBe("gt-2xmedian");
    expect(dwellBucketFor(5, null)).toBe("median-2xmedian");
    expect(dwellBucketFor(5, 0)).toBe("median-2xmedian");
  });
  test("parseMoveActivity", () => {
    expect(parseMoveActivity("Acme moved to Negotiation")).toEqual({ title: "Acme", stageName: "Negotiation" });
    // greedy title: splits on the LAST " moved to "
    expect(parseMoveActivity("We moved to Boston moved to Prospecting")).toEqual({ title: "We moved to Boston", stageName: "Prospecting" });
    expect(parseMoveActivity("Acme created")).toBeNull();
    expect(parseMoveActivity("")).toBeNull();
    expect(parseMoveActivity(" moved to ")).toBeNull();
  });
});

// ---- first run: backfill + differ ---------------------------------------------------
describe("observeOnce first run", () => {
  test("backfills transitions, drops ambiguous titles and unknown stages", async () => {
    const rep = await observeOnce();
    expect(rep.ok).toBe(true);
    expect(rep.backfilledTransitions).toBe(3); // Acme x2, Beta x1 (Dup ambiguous, Atlantis unknown)
    expect(rep.skippedAmbiguous).toBe(1); // "Dup" matches two deals
    expect(rep.skippedStage).toBe(1); // Atlantis
    const rows = db.query("SELECT deal_id, to_stage, source FROM stage_transitions WHERE source='backfill' ORDER BY deal_id, at").all();
    expect(rows).toEqual([
      { deal_id: 1, to_stage: "prospecting", source: "backfill" },
      { deal_id: 1, to_stage: "negotiation", source: "backfill" },
      { deal_id: 2, to_stage: "negotiation", source: "backfill" },
    ]);
  });

  test("differ snapshots every deal and logs first-sighting closes", async () => {
    const rep = await observeOnce();
    expect(rep.deals).toBe(5);
    expect(rep.snapshots).toBe(5);
    // Beta was already closed_lost at first sighting -> close_log, last stage from backfill
    expect(rep.closes).toBe(1);
    const close = db.query("SELECT deal_id, outcome, last_stage, value_band, industry FROM close_log").get() as any;
    expect(close.deal_id).toBe(2);
    expect(close.outcome).toBe("lost");
    expect(close.last_stage).toBe("negotiation");
    expect(close.value_band).toBe("1-10k");
    expect(close.industry).toBe("software");
    // default workspace (stored as 0) got its pass too
    expect(rep.workspaces).toBe(2);
  });

  test("backfill runs only once", async () => {
    await observeOnce();
    expect(getSetting("observer.backfilled_at")).not.toBeNull();
    const rep2 = await observeOnce();
    expect(rep2.backfilledTransitions).toBe(0);
    expect(rep2.skippedAmbiguous).toBe(0);
  });
});

// ---- second run: stage move then close ------------------------------------------------
describe("differ across runs", () => {
  test("stage change -> transition; close -> close_log with last open stage", async () => {
    await observeOnce();
    // Acme moves to closed_won between runs
    dealsByWs["7"] = dealsByWs["7"].map((d: any) =>
      d.id === 1 ? { ...d, stage: "closed_won", updated_at: "2026-09-12T10:00:00" } : d);
    const rep = await observeOnce();
    expect(rep.closes).toBe(1);
    const close = db.query("SELECT outcome, last_stage, value_band, dwell_bucket FROM close_log WHERE deal_id = 1").get() as any;
    expect(close.outcome).toBe("won");
    expect(close.last_stage).toBe("prospecting");
    expect(close.value_band).toBe("1-10k");
    expect(typeof close.dwell_bucket).toBe("string");
    const tr = db.query(
      "SELECT from_stage, to_stage, source FROM stage_transitions WHERE deal_id = 1 AND source = 'diff' ORDER BY at, id"
    ).all();
    expect(tr[tr.length - 1]).toEqual({ from_stage: "prospecting", to_stage: "closed_won", source: "diff" });
  });

  test("no changes -> no new transitions or closes (idempotent)", async () => {
    await observeOnce();
    const rep = await observeOnce();
    expect(rep.transitions).toBe(0);
    expect(rep.closes).toBe(0);
    expect(rep.ok).toBe(true);
  });

  test("reopen then re-close logs a second close", async () => {
    await observeOnce();
    dealsByWs["7"] = dealsByWs["7"].map((d: any) =>
      d.id === 1 ? { ...d, stage: "closed_won", updated_at: "2026-09-12T10:00:00" } : d);
    await observeOnce();
    dealsByWs["7"] = dealsByWs["7"].map((d: any) =>
      d.id === 1 ? { ...d, stage: "negotiation", updated_at: "2026-09-13T10:00:00" } : d);
    await observeOnce();
    dealsByWs["7"] = dealsByWs["7"].map((d: any) =>
      d.id === 1 ? { ...d, stage: "closed_lost", updated_at: "2026-09-14T10:00:00" } : d);
    const rep = await observeOnce();
    expect(rep.closes).toBe(1);
    const rows = db.query("SELECT outcome, last_stage FROM close_log WHERE deal_id = 1 ORDER BY id").all();
    expect(rows).toEqual([
      { outcome: "won", last_stage: "prospecting" },
      { outcome: "lost", last_stage: "negotiation" },
    ]);
  });
});

// ---- failure handling -----------------------------------------------------------------
describe("failure handling", () => {
  test("exec-crm down -> ok:false, no throw", async () => {
    failAll = true;
    const rep = await observeOnce();
    expect(rep.ok).toBe(false);
    expect(rep.reason).toMatch(/unreachable|workspace list failed/);
  });

  test("one bad workspace does not kill the other", async () => {
    // default workspace throws, ws 7 fine: emulate via deals fetch on default
    const orig = stubFetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/deals" && !url.searchParams.get("workspace")) throw new Error("boom");
      return orig(input, init);
    };
    const rep = await observeOnce();
    expect(rep.workspaces).toBe(1);
    expect(rep.errors.length).toBe(1);
    expect(rep.ok).toBe(true);
  });
});

// ---- cadence gate ----------------------------------------------------------------------
describe("maybeObserve", () => {
  test("runs when due, skips within the hour, runs again after", async () => {
    const t0 = Date.now();
    const r1 = await maybeObserve(t0);
    expect(r1.ran).toBe(true);
    expect(r1.report!.ok).toBe(true);
    const r2 = await maybeObserve(t0 + 1000);
    expect(r2.ran).toBe(false);
    const r3 = await maybeObserve(t0 + OBSERVER_INTERVAL_MS + 1);
    expect(r3.ran).toBe(true);
  });

  test("records last_run_ms even when the CRM is down", async () => {
    failAll = true;
    const r = await maybeObserve(Date.now());
    expect(r.ran).toBe(true);
    expect(r.report!.ok).toBe(false);
    expect(getSetting("observer.last_run_ms")).not.toBeNull();
    // and the gate now holds until the next interval
    expect((await maybeObserve(Date.now())).ran).toBe(false);
  });
});

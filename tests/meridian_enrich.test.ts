// meridian_enrich.test.ts — Milton's "meridian enrich <name>" flow:
// intent parsing, cross-type fuzzy matching + numbered disambiguation,
// async job launch, status polling (running/done/failed), the offer card
// with explicit Yes before any write, the 30s background tick, session
// persistence of the in-flight job, and unreachable-Meridian handling.
//
// Nothing is written until the user says Yes; the dossier then lands in
// exec-crm itself, in an "Enrichment dossier" text custom field on the
// contact/company (created on first use, earlier dossiers preserved).
import { describe, test, expect, afterEach, afterAll, beforeAll } from "bun:test";
import { parseIntent } from "../src/intents";
import * as mer from "../src/meridian";
import {
  handleMessage, enrichTerminalReply, enrichTickDecision,
  ENRICH_DOSSIER_FIELD, ENRICH_JOB_TIMEOUT_MS,
  type Session, type EnrichJobState,
} from "../src/brain";

const sess = (id: string): Session => ({ id, history: [], notes: [] });

// ---- fixtures (mutable per test) ------------------------------------------------------
let companies: any[] = [
  { id: 11, name: "Acme Widgets", industry: "Mfg", website: "https://acme.example", notes: "" },
];
let contacts: any[] = [
  { id: 1, name: "Ada Lovelace", email: "ada@acme.example", phone: "", company_id: 11, company_name: "Acme Widgets", title: "CEO", notes: "" },
];
// exec-crm custom-field fixtures (mutable per test)
let cfFields: any[] = []; // definitions: { id, name(slug), label, type }
let cfValues: Record<string, string> = {}; // `${entityType}:${entityId}:${fieldId}` -> value
let lastCfPost: any = null; // last POST /api/custom-fields body
let lastCfPut: any = null; // last PUT /api/custom-fields/values body
let cfPutFails = false;
let meridianDown = false;
let enrichScript: (id: string) => any = () => doneJob;
let lastEnrichPost: any = null;

const doneJob = {
  id: "ejob1", query: "https://acme.example", status: "done",
  progress: { done: 3, total: 3 },
  error: null,
  company: { name: "Acme Widgets Inc.", domain: "acme.example", description: "Makers of fine widgets.", founded: "1998", employees: "120" },
  principals: [
    { name: "Ada Lovelace", title: "Chief Executive Officer", email: "ada@acme.example", source_url: "https://acme.example/team" },
    { name: "Alan Turing", title: "Chief Operating Officer", source_url: "https://acme.example/about" },
  ],
  notes: [], nodes: [], edges: [],
  created_at: 1, updated_at: 2,
};

const ok = (data: any, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const CRM = "http://localhost:3001";
  if (url.startsWith(CRM)) {
    const [path, qs] = url.slice(CRM.length).split("?");
    const q = new URLSearchParams(qs || "");
    if (path === "/api/contacts") return ok({ contacts });
    if (path === "/api/companies") return ok({ companies });
    if (path === "/api/custom-fields" && init.method === "POST") {
      lastCfPost = JSON.parse(String(init.body || "{}"));
      const f = {
        id: 70 + cfFields.length,
        name: String(lastCfPost.name || "").toLowerCase().replace(/\s+/g, "_"),
        label: lastCfPost.name, type: lastCfPost.field_type,
      };
      cfFields.push(f);
      return ok({ field: f }, 201);
    }
    if (path === "/api/custom-fields") {
      return ok({ fields: cfFields });
    }
    if (path === "/api/custom-fields/values" && init.method === "PUT") {
      if (cfPutFails) return ok({ error: "boom" }, 500);
      lastCfPut = JSON.parse(String(init.body || "{}"));
      const et = lastCfPut.entity_type || q.get("entity_type") || "company";
      cfValues[`${et}:${lastCfPut.entity_id}:${lastCfPut.field_id}`] = lastCfPut.value;
      return ok({ ok: true });
    }
    if (path === "/api/custom-fields/values") {
      const et = q.get("entity_type") || "company";
      const eid = q.get("entity_id");
      const values = Object.entries(cfValues)
        .filter(([k]) => k.startsWith(`${et}:${eid}:`))
        .map(([k, value]) => {
          const fieldId = Number(k.split(":")[2]);
          const f = cfFields.find((x) => x.id === fieldId) || {};
          return { field_id: fieldId, name: f.label || f.name, field_type: f.type || "text", value };
        });
      return ok({ values });
    }
    return ok({ error: "not found" }, 404);
  }
  if (url.startsWith(mer.meridianBase())) {
    if (meridianDown) return Promise.reject(new Error("fetch failed"));
    const path = url.slice(mer.meridianBase().length).split("?")[0];
    if (path === "/api/enrich" && init.method === "POST") {
      lastEnrichPost = JSON.parse(String(init.body || "{}"));
      return ok({ job_id: "ejob1", status: "running" }, 201);
    }
    const m = path.match(/^\/api\/enrich\/([^/]+)$/);
    if (m) return ok({ job: enrichScript(m[1]) });
    return ok({ error: "not found" }, 404);
  }
  return Promise.reject(new Error("unexpected fetch: " + url));
}

const realFetch = globalThis.fetch.bind(globalThis);
function install() {
  (globalThis as any).fetch = stubFetch;
  meridianDown = false;
  lastEnrichPost = null;
  enrichScript = () => doneJob;
  cfFields = []; cfValues = {}; lastCfPost = null; lastCfPut = null; cfPutFails = false;
  companies = [
    { id: 11, name: "Acme Widgets", industry: "Mfg", website: "https://acme.example", notes: "" },
  ];
  contacts = [
    { id: 1, name: "Ada Lovelace", email: "ada@acme.example", phone: "", company_id: 11, company_name: "Acme Widgets", title: "CEO", notes: "" },
  ];
}
afterEach(() => { (globalThis as any).fetch = realFetch; });

// ---- intent parsing ---------------------------------------------------------------------
describe("enrich intents", () => {
  test("meridian enrich <name>", () => {
    const i = parseIntent("meridian enrich acme");
    expect(i.name).toBe("meridian_enrich");
    expect(i.slots.query).toBe("acme");
  });
  test("bare enrich <name>", () => {
    const i = parseIntent("enrich Acme Widgets");
    expect(i.name).toBe("meridian_enrich");
    expect(i.slots.query).toBe("Acme Widgets");
  });
  test("enrichment status", () => {
    expect(parseIntent("enrichment status").name).toBe("meridian_enrich_status");
    expect(parseIntent("check enrichment").name).toBe("meridian_enrich_status");
  });
});

// ---- launch -----------------------------------------------------------------------------
describe("enrich launch", () => {
  test("clear winner: company matched, website used as the lookup query", async () => {
    install();
    const s = sess("e-1");
    const r = await handleMessage(s, "enrich acme");
    expect(r.text).toContain("Enriching **Acme Widgets**");
    expect(r.text).toContain("enrichment status");
    expect(s.enrichJob?.job_id).toBe("ejob1");
    expect(s.enrichJob?.targetType).toBe("company");
    expect(lastEnrichPost.query).toBe("https://acme.example");
  });
  test("contact match falls back to the contact's company name", async () => {
    install();
    const s = sess("e-2");
    const r = await handleMessage(s, "enrich lovelace");
    expect(r.text).toContain("Enriching **Ada Lovelace**");
    expect(s.enrichJob?.targetType).toBe("contact");
    expect(lastEnrichPost.query).toBe("Acme Widgets");
  });
  test("no match across contacts and companies", async () => {
    install();
    const s = sess("e-3");
    const r = await handleMessage(s, "enrich zzzznonexistent");
    expect(r.text).toContain("couldn't find any contact or company");
    expect(s.enrichJob).toBeUndefined();
    expect(lastEnrichPost).toBeNull();
  });
  test("ambiguous cross-type match asks with a numbered choice card", async () => {
    install();
    companies.push({ id: 12, name: "Acme Supplies", industry: "", website: "", notes: "" });
    const s = sess("e-4");
    const r = await handleMessage(s, "enrich acme");
    const choices = (r.cards || []).find((c: any) => c.kind === "choices");
    expect(choices).toBeTruthy();
    expect(choices.options.length).toBeGreaterThanOrEqual(2);
    expect(r.text).toContain("which one should I enrich");
    expect(s.enrichJob).toBeUndefined();
    expect(lastEnrichPost).toBeNull();
  });
  test("choosing a number from the disambiguation launches the job", async () => {
    install();
    companies.push({ id: 12, name: "Acme Supplies", industry: "", website: "", notes: "" });
    const s = sess("e-5");
    const first = await handleMessage(s, "enrich acme");
    const choices = (first.cards || []).find((c: any) => c.kind === "choices");
    const pick = choices.options.find((o: any) => o.label === "Acme Widgets");
    const r = await handleMessage(s, String(pick.n));
    expect(r.text).toContain("Enriching **Acme Widgets**");
    expect(s.enrichJob?.targetType).toBe("company");
    expect(s.enrichJob?.targetId).toBe(11);
    expect(lastEnrichPost.query).toBe("https://acme.example");
  });
  test("unreachable Meridian reports plainly", async () => {
    install();
    meridianDown = true;
    const s = sess("e-6");
    const r = await handleMessage(s, "enrich acme");
    expect(r.text).toMatch(/can't reach meridian/i);
    expect(s.enrichJob).toBeUndefined();
  });
});

// ---- status polling -----------------------------------------------------------------------
describe("enrich status", () => {
  test("no parked job explains itself", async () => {
    install();
    const r = await handleMessage(sess("e-7"), "enrichment status");
    expect(r.text).toContain("No enrichment is running");
  });
  test("running job reports progress and stays parked", async () => {
    install();
    enrichScript = () => ({ ...doneJob, status: "running", progress: { done: 1, total: 3, current: "scraping /team" }, principals: null, company: null });
    const s = sess("e-8");
    await handleMessage(s, "enrich acme");
    const r = await handleMessage(s, "enrichment status");
    expect(r.text).toContain("Still running");
    expect(r.text).toContain("1/3");
    expect(s.enrichJob).toBeTruthy();
  });
  test("done job renders the offer card and arms the save confirmation", async () => {
    install();
    const s = sess("e-9");
    await handleMessage(s, "enrich acme");
    const r = await handleMessage(s, "enrichment status");
    expect(r.text).toContain("Acme Widgets Inc.");
    expect(r.text).toContain("Ada Lovelace");
    expect(r.text).toContain("Chief Executive Officer");
    expect(r.text).toContain("ada@acme.example");
    expect(r.text).toContain("Alan Turing");
    expect(r.text).toContain("Save this dossier");
    const confirm = (r.cards || []).find((c: any) => c.kind === "confirm");
    expect(confirm).toBeTruthy();
    expect(s.pending?.type).toBe("enrich_save");
    expect(s.enrichJob).toBeUndefined();
  });
  test("failed job reports the error plainly", async () => {
    install();
    enrichScript = () => ({ ...doneJob, status: "failed", error: "DNS lookup failed", company: null, principals: null });
    const s = sess("e-10");
    await handleMessage(s, "enrich acme");
    const r = await handleMessage(s, "enrichment status");
    expect(r.text).toContain("failed");
    expect(r.text).toContain("DNS lookup failed");
    expect(s.pending).toBeUndefined();
  });
  test("done job with no principals says so plainly, without a save prompt", async () => {
    install();
    enrichScript = () => ({ ...doneJob, principals: [], notes: ["no team page found"] });
    const s = sess("e-11");
    await handleMessage(s, "enrich acme");
    const r = await handleMessage(s, "enrichment status");
    expect(r.text).toContain("couldn't find any principals");
    expect(s.pending).toBeUndefined();
  });
});

// ---- confirmation gating: the dossier lands in exec-crm's custom fields ----
describe("enrich save confirmation", () => {
  test("nothing is written before the offer card", async () => {
    install();
    const s = sess("e-12");
    await handleMessage(s, "enrich acme");
    expect(lastCfPut).toBeNull();
    expect(lastCfPost).toBeNull();
  });
  test("Yes after the offer creates the field and writes the dossier to exec-crm", async () => {
    install();
    const s = sess("e-13");
    await handleMessage(s, "enrich acme");
    await handleMessage(s, "enrichment status");
    const r = await handleMessage(s, "Yes");
    expect(r.text).toContain("Saved the dossier");
    expect(r.text).toContain(ENRICH_DOSSIER_FIELD);
    // field created on first use (text type — exec-crm has no textarea)
    expect(lastCfPost).toMatchObject({ entity_type: "company", name: ENRICH_DOSSIER_FIELD, field_type: "text" });
    // value written to the company
    expect(lastCfPut).toMatchObject({ field_id: cfFields[0].id, entity_id: 11 });
    expect(String(lastCfPut.value)).toContain("Ada Lovelace");
    expect(String(lastCfPut.value)).toContain("Chief Executive Officer");
    expect(String(lastCfPut.value)).toMatch(/Enriched \d{4}-\d{2}-\d{2}/);
    expect(s.pending).toBeUndefined();
  });
  test("existing dossier value is preserved underneath the new one", async () => {
    install();
    cfFields = [{ id: 77, name: "enrichment_dossier", label: ENRICH_DOSSIER_FIELD, type: "text" }];
    cfValues["company:11:77"] = "Enriched 2026-01-01:\nOld Corp (old.example)\n\nPrincipals\n- Jane Doe — CEO";
    const s = sess("e-16");
    await handleMessage(s, "enrich acme");
    await handleMessage(s, "enrichment status");
    const r = await handleMessage(s, "Yes");
    expect(r.text).toContain("added to the earlier dossier");
    expect(lastCfPost).toBeNull(); // field already existed — not recreated
    expect(String(lastCfPut.value)).toContain("Jane Doe");
    expect(String(lastCfPut.value)).toContain("Ada Lovelace");
    expect(String(lastCfPut.value).indexOf("Jane Doe")).toBeLessThan(String(lastCfPut.value).indexOf("Ada Lovelace"));
  });
  test("No cancels without writing", async () => {
    install();
    const s = sess("e-14");
    await handleMessage(s, "enrich acme");
    await handleMessage(s, "enrichment status");
    await handleMessage(s, "No");
    expect(lastCfPut).toBeNull();
    expect(lastCfPost).toBeNull();
    expect(s.pending).toBeUndefined();
  });
  test("Yes with no pending offer says so", async () => {
    install();
    const r = await handleMessage(sess("e-15"), "Yes");
    expect(r.text).toMatch(/nothing|pending/i);
  });
  test("tick-delivered offer survives an 'enrichment status' check, then Yes writes", async () => {
    // Regression: the launch reply tells the user to say `enrichment status`
    // to check the job. When the 30s background tick beats the user to the
    // punch and delivers the offer card first, a later status check must not
    // silently kill the parked save — the follow-up Yes has to write.
    install();
    const s = sess("e-18");
    await handleMessage(s, "enrich acme"); // launches; parks enrichJob
    expect(s.enrichJob?.job_id).toBe("ejob1");
    // simulate the tick delivering the terminal reply (it clears enrichJob
    // and arms the enrich_save pending, exactly like server.ts does)
    const terminal = enrichTerminalReply(s, s.enrichJob!, doneJob as any);
    expect(terminal.text).toContain("Save this dossier");
    s.enrichJob = undefined;
    expect(s.pending?.type).toBe("enrich_save");
    // user checks status before answering — pending must survive
    const st = await handleMessage(s, "enrichment status");
    expect(st.text).toContain("ready and waiting");
    expect(st.text).toContain(ENRICH_DOSSIER_FIELD);
    expect(s.pending?.type).toBe("enrich_save");
    // and the Yes still writes the dossier to exec-crm
    const r = await handleMessage(s, "Yes");
    expect(r.text).toContain("Saved the dossier");
    expect(lastCfPut).toMatchObject({ entity_id: 11 });
    expect(String(lastCfPut.value)).toContain("Ada Lovelace");
    expect(String(lastCfPut.value)).toContain("Chief Executive Officer");
    expect(s.pending).toBeUndefined();
  });
  test("an unrelated message still cancels a parked enrich_save (one-shot confirmations)", async () => {
    install();
    const s = sess("e-19");
    await handleMessage(s, "enrich acme");
    const terminal = enrichTerminalReply(s, s.enrichJob!, doneJob as any);
    expect(terminal.text).toContain("Save this dossier");
    s.enrichJob = undefined;
    await handleMessage(s, "my tasks"); // not part of the enrich flow
    expect(s.pending).toBeUndefined();
    expect(lastCfPut).toBeNull();
  });
  test("exec-crm write failure is reported, not thrown", async () => {
    install();
    cfPutFails = true;
    const s = sess("e-17");
    await handleMessage(s, "enrich acme");
    await handleMessage(s, "enrichment status");
    const r = await handleMessage(s, "Yes");
    expect(r.text).toContain("couldn't save the dossier");
  });
});

// ---- DOM: offer card renders through the real frontend pipeline ---------------------
describe("offer card DOM", () => {
  test("confirm card + dossier markdown render without throwing", async () => {
    const { readFileSync } = await import("fs");
    const prevDoc = (globalThis as any).document;
    const prevLs = (globalThis as any).localStorage;
    const prevFetch = (globalThis as any).fetch;
    const prevT = (globalThis as any).__t;
    try {
      const mkEl = (tag: string): any => ({
        tag, children: [] as any[], innerHTML: "", textContent: "", value: "", className: "",
        appendChild(c: any) { this.children.push(c); return c; },
        insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
        addEventListener() {}, remove() {}, focus() {}, scrollTop: 0, scrollHeight: 0,
        closest() { return null; }, getAttribute() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        hidden: false, style: {},
      });
      const els: Record<string, any> = {};
      ["chat", "chips", "composer", "input", "status-dot", "status-text", "help-btn",
       "cam-btn", "photo-input", "vcf-btn", "vcf-input", "tray", "bell-btn", "bell-badge", "auto-btn",
       "auto-view", "auto-tabs", "auto-body", "auto-close", "toast", "ws-select", "palette",
       "session-select", "session-new"].forEach((id) => (els[id] = mkEl("div")));
      (globalThis as any).document = {
        getElementById: (id: string) => els[id] || null,
        createElement: (t: string) => mkEl(t),
        addEventListener() {},
      };
      (globalThis as any).localStorage = { _s: {}, getItem(k: string) { return this._s[k] || null; }, setItem(k: string, v: string) { this._s[k] = v; } };
      (globalThis as any).fetch = async () => ({ json: async () => ({}) });
      let src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
      src = src.replace("})();", ";globalThis.__t={cardHTML,md,money,esc};})();");
      (0, eval)(src);
      await new Promise((r) => setTimeout(r, 50));
      const T = (globalThis as any).__t;
      // The exact payload shape brain.ts sends for the enrichment offer.
      const dossier = "**Acme Widgets Inc.** (acme.example)\nMakers of fine widgets. · founded 1998 · 120 employees\n\n**Principals**\n- Ada Lovelace — Chief Executive Officer · ada@acme.example\n- Alan Turing — Chief Operating Officer";
      const card = { kind: "confirm", options: [{ n: 1, label: "Yes, save it" }, { n: 2, label: "Cancel" }] };
      const html = T.cardHTML(card) + T.md(dossier);
      expect(html).toContain("Yes, save it");
      expect(html).toContain("Cancel");
      expect(html).toContain("Ada Lovelace");
      expect(html).toContain("Chief Executive Officer");
      expect(html).toContain("ada@acme.example");
      expect(html).toContain("Acme Widgets Inc.");
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).localStorage = prevLs;
      (globalThis as any).fetch = prevFetch;
      (globalThis as any).__t = prevT;
    }
  });
});

// ---- enrich_notes unit ----------------------------------------------------------------------
// ---- tick decision: pure, injectable clock --------------------------------------
describe("enrichTickDecision", () => {
  const job = (at: number): EnrichJobState =>
    ({ job_id: "ejob1", targetType: "company", targetId: 11, targetName: "Acme", at });
  test("done and failed deliver immediately", () => {
    expect(enrichTickDecision(job(1000), "done", 2000)).toBe("done");
    expect(enrichTickDecision(job(1000), "failed", 2000)).toBe("failed");
  });
  test("running keeps polling inside the timeout", () => {
    expect(enrichTickDecision(job(1000), "running", 1000 + ENRICH_JOB_TIMEOUT_MS)).toBe("keep");
  });
  test("running past the timeout is stale", () => {
    expect(enrichTickDecision(job(1000), "running", 1000 + ENRICH_JOB_TIMEOUT_MS + 1)).toBe("stale");
  });
});

// ---- terminal reply: shared by manual status and the background tick ------------
describe("enrichTerminalReply", () => {
  const job: EnrichJobState =
    ({ job_id: "ejob1", targetType: "company", targetId: 11, targetName: "Acme Widgets", at: 1 });
  test("done with principals arms the exec-crm write confirmation", () => {
    const s = sess("e-20");
    const r = enrichTerminalReply(s, job, doneJob as any);
    expect(r.text).toContain("Acme Widgets Inc.");
    expect(r.text).toContain("Ada Lovelace");
    expect(r.text).toContain(ENRICH_DOSSIER_FIELD);
    expect(s.pending?.type).toBe("enrich_save");
    expect((s.pending!.payload as any).dossier).toContain("Ada Lovelace");
    expect((s.pending!.payload as any).dossier).not.toContain("**"); // plain text for the field
  });
  test("done without principals explains, no pending", () => {
    const s = sess("e-21");
    const r = enrichTerminalReply(s, job, { ...doneJob, principals: [] } as any);
    expect(r.text).toContain("couldn't find any principals");
    expect(s.pending).toBeUndefined();
  });
  test("failed reports the error, clears nothing else", () => {
    const s = sess("e-22");
    const r = enrichTerminalReply(s, job, { ...doneJob, status: "failed", error: "boom" } as any);
    expect(r.text).toContain("failed");
    expect(r.text).toContain("boom");
    expect(s.pending).toBeUndefined();
  });
});

// ---- 30s background tick: persistence round-trip + delivery ---------------------
// Boots the real server once against a scratch data dir. The tick scans the
// sessions table for parked enrichJobs, polls Meridian, and delivers the
// terminal reply into the session (the same path the 30s sweep uses).
describe("enrichment tick", () => {
  let srv: any;
  const TICK_SID = "enrich-tick-test";

  const tickJob: EnrichJobState =
    ({ job_id: "ejob1", targetType: "company", targetId: 11, targetName: "Acme Widgets", at: Date.now() });

  function tickStubFetch(input: any, init: any = {}): Promise<Response> {
    const url = String(input);
    if (url.startsWith(mer.meridianBase())) {
      if ((globalThis as any).__tickMeridianDown)
        return Promise.reject(new Error("fetch failed"));
      const m = url.match(/\/api\/enrich\/([^/?]+)/);
      if (m) return ok((globalThis as any).__tickJobJson || doneJob);
      return ok({ error: "not found" }, 404);
    }
    return realFetch(input, init);
  }

  beforeAll(async () => {
    process.env.MILTON_DATA = `/tmp/milton-enrich-tick-test-${Date.now()}`;
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

  afterAll(() => { (globalThis as any).fetch = realFetch; });

  function parkJob(job: EnrichJobState) {
    (globalThis as any).fetch = tickStubFetch;
    const s = srv.loadSession(TICK_SID);
    s.enrichJob = job;
    s.pending = undefined;
    s.history = [];
    srv.saveSession(s);
  }

  test("in-flight job survives a session reload between launch and status", () => {
    parkJob({ ...tickJob });
    const reloaded = srv.loadSession(TICK_SID);
    expect(reloaded.enrichJob?.job_id).toBe("ejob1");
    expect(reloaded.enrichJob?.targetName).toBe("Acme Widgets");
    expect(reloaded.enrichJob?.targetType).toBe("company");
  });

  test("tick delivers the done offer into the session and clears the job", async () => {
    (globalThis as any).__tickJobJson = doneJob;
    parkJob({ ...tickJob });
    await srv.tickEnrichment();
    const s = srv.loadSession(TICK_SID);
    expect(s.enrichJob).toBeUndefined();
    expect(s.pending?.type).toBe("enrich_save");
    expect(s.history.some((h: any) => h.text.includes("Acme Widgets Inc."))).toBe(true);
    expect(s.history.some((h: any) => h.text.includes("Ada Lovelace"))).toBe(true);
  });

  test("tick delivers the failure note", async () => {
    (globalThis as any).__tickJobJson = { ...doneJob, status: "failed", error: "DNS blew up", company: null, principals: null };
    parkJob({ ...tickJob });
    await srv.tickEnrichment();
    const s = srv.loadSession(TICK_SID);
    expect(s.enrichJob).toBeUndefined();
    expect(s.pending).toBeUndefined();
    expect(s.history.some((h: any) => h.text.includes("DNS blew up"))).toBe(true);
  });

  test("tick leaves the job parked when Meridian is unreachable", async () => {
    (globalThis as any).__tickMeridianDown = true;
    try {
      parkJob({ ...tickJob });
      await srv.tickEnrichment();
      expect(srv.loadSession(TICK_SID).enrichJob?.job_id).toBe("ejob1");
    } finally {
      (globalThis as any).__tickMeridianDown = false;
    }
  });

  test("tick marks a job stale past the timeout and tells the user to retry", async () => {
    (globalThis as any).__tickJobJson = { ...doneJob, status: "running" };
    parkJob({ ...tickJob, at: Date.now() - ENRICH_JOB_TIMEOUT_MS - 1000 });
    await srv.tickEnrichment();
    const s = srv.loadSession(TICK_SID);
    expect(s.enrichJob).toBeUndefined();
    const last = s.history[s.history.length - 1];
    expect(last.text).toMatch(/stalled/i);
    expect(last.text).toContain("enrich Acme Widgets");
  });
});

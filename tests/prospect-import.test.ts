// tests/prospect-import.test.ts — `import prospects`: bring the last finished
// Meridian prospect run into an exec-crm workspace as contacts (company +
// contact per prospect). Intent parsing, workspace resolution, dedupe against
// the target workspace, the 30-contact cap, the Yes/No confirmation gate, and
// the stash of the finished run on the session.
// Stub exec-crm in ALL tests — never hit real endpoints.
import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent } from "../src/intents";
import { clearWorkspaceCache } from "../src/workspace";
import {
  handleMessage, prospectTerminalReply, normProspectName,
  PROSPECT_IMPORT_MAX, PROSPECT_STASH_MAX,
  type Session, type ProspectJobState,
} from "../src/brain";
import * as auto from "../src/automation";
import * as chats from "../src/chat_sessions";
import { initDealNotesDb } from "../src/deal_notes";

const sess = (id: string): Session => ({ id, history: [], notes: [] });

// ---- fixtures (mutable per test) ------------------------------------------------------
let workspaces: any[] = [{ id: 7, name: "Prospecting", color: "#579bfc" }];
let crmContacts: any[] = [];
let crmCompanies: any[] = [];
let companyPosts: any[] = [];
let contactPosts: any[] = [];
let nextCompanyId = 100;
let nextContactId = 200;

const prospectCompanies = [
  { name: "Bright Smile Dental", address: "123 Main St, Madisonville, OH", tags: { amenity: "dentist" }, industry: "dental clinics", territory: "Madisonville" },
  { name: "Pearl Family Dentistry", address: "456 Oak Ave, Madisonville, OH", tags: { amenity: "dentist" }, industry: "dental clinics", territory: "Madisonville" },
  { name: "Riverside Orthodontics", address: "789 Elm St, Madisonville, OH", tags: {}, industry: "dental clinics", territory: "Madisonville" },
];

function withLastProspect(s: Session, companies: any[] = prospectCompanies): Session {
  s.lastProspect = { industry: "dental clinics", location: "Madisonville", companies, at: Date.now() };
  return s;
}

const ok = (data: any, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

async function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return Promise.reject(new Error("unexpected fetch: " + url));
  const method = (init.method || "GET").toUpperCase();
  const path = url.split("?")[0].slice("http://localhost:3001".length);
  if (method === "GET" && path === "/api/workspaces") return ok({ workspaces });
  if (method === "GET" && path === "/api/contacts") return ok({ contacts: crmContacts });
  if (method === "GET" && path === "/api/companies") return ok({ companies: crmCompanies });
  if (method === "POST" && path === "/api/companies") {
    const body = JSON.parse(String(init.body || "{}"));
    companyPosts.push(body);
    return ok({ company: { id: nextCompanyId++, ...body } }, 201);
  }
  if (method === "POST" && path === "/api/contacts") {
    const body = JSON.parse(String(init.body || "{}"));
    contactPosts.push(body);
    return ok({ contact: { id: nextContactId++, ...body } }, 201);
  }
  if (method === "POST" && path === "/api/sandbox/batches") return ok({ batch: { id: 11 } }, 201);
  return ok({ error: "not found" }, 404);
}

const realFetch = globalThis.fetch.bind(globalThis);
function install() {
  (globalThis as any).fetch = stubFetch;
  clearWorkspaceCache();
  workspaces = [{ id: 7, name: "Prospecting", color: "#579bfc" }];
  crmContacts = [];
  crmCompanies = [];
  companyPosts = [];
  contactPosts = [];
  nextCompanyId = 100;
  nextContactId = 200;
}
afterEach(() => { (globalThis as any).fetch = realFetch; });

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}',
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
  chats.initChatSessionDb(db);
});

// ---- intent parsing -------------------------------------------------------------------
describe("prospect_import intents", () => {
  test("\"import prospects\" -> prospect_import", () => {
    const i = parseIntent("import prospects");
    expect(i.name).toBe("prospect_import");
    expect(i.slots.workspace || "").toBe("");
  });
  test("\"import prospect as contacts\" -> prospect_import", () => {
    expect(parseIntent("import prospect as contacts").name).toBe("prospect_import");
  });
  test("\"prospect import\" -> prospect_import", () => {
    expect(parseIntent("prospect import").name).toBe("prospect_import");
  });
  test("\"import prospects into Prospecting\" -> workspace slot", () => {
    const i = parseIntent("import prospects into Prospecting");
    expect(i.name).toBe("prospect_import");
    expect(i.slots.workspace).toBe("Prospecting");
  });
  test("\"import prospects into workspace Acme Corp\" -> workspace slot", () => {
    const i = parseIntent("import prospects into workspace Acme Corp");
    expect(i.slots.workspace).toBe("Acme Corp");
  });
  test("\"import these contacts\" still routes to the vcf flow", () => {
    expect(parseIntent("import these contacts").name).toBe("import_contacts");
  });
});

// ---- workspace resolution + confirmation ----------------------------------------------
describe("prospectImportReply", () => {
  test("no finished run -> guidance", async () => {
    install();
    const r = await handleMessage(sess("pi-none"), "import prospects");
    expect(r.text).toContain("meridian prospect");
  });
  test("named workspace -> confirmation lists prospects, parks pending", async () => {
    install();
    const s = withLastProspect(sess("pi-confirm"));
    const r = await handleMessage(s, "import prospects into Prospecting");
    expect(r.text).toContain("Import **3** contacts");
    expect(r.text).toContain("workspace **Prospecting**");
    expect(r.text).toContain("Bright Smile Dental");
    expect(r.chips).toContain("Yes");
    expect(s.pending?.type).toBe("prospect_import");
    expect(s.pending?.payload.items).toHaveLength(3);
    expect(s.pending?.payload.workspaceId).toBe(7);
  });
  test("session workspace used when none named", async () => {
    install();
    const s = withLastProspect(sess("pi-sessws"));
    s.workspaceId = 7; s.workspaceName = "Prospecting";
    const r = await handleMessage(s, "import prospects");
    expect(r.text).toContain("workspace **Prospecting**");
    expect(s.pending?.type).toBe("prospect_import");
  });
  test("no workspace context -> asks which one", async () => {
    install();
    const s = withLastProspect(sess("pi-whichws"));
    const r = await handleMessage(s, "import prospects");
    expect(r.text).toContain("Which workspace");
    expect(r.text).toContain("Prospecting");
    expect(s.pending).toBeUndefined();
  });
  test("unknown workspace name -> lists available", async () => {
    install();
    const s = withLastProspect(sess("pi-badws"));
    const r = await handleMessage(s, "import prospects into Nope");
    expect(r.text).toContain("don't know a workspace");
    expect(r.text).toContain("Prospecting");
  });
  test("existing contacts/companies are skipped in the confirmation", async () => {
    install();
    crmContacts = [{ id: 1, name: "Bright Smile Dental" }];
    const s = withLastProspect(sess("pi-skip"));
    const r = await handleMessage(s, "import prospects into Prospecting");
    expect(r.text).toContain("Import **2** contacts");
    expect(r.text).toContain("1 already in your CRM");
    expect(s.pending?.payload.items.map((i: any) => i.name)).not.toContain("Bright Smile Dental");
  });
  test("everything already imported -> nothing-new reply", async () => {
    install();
    crmContacts = prospectCompanies.map((c, i) => ({ id: i + 1, name: c.name }));
    const s = withLastProspect(sess("pi-allnew"));
    const r = await handleMessage(s, "import prospects into Prospecting");
    expect(r.text).toContain("Nothing new to import");
    expect(s.pending).toBeUndefined();
  });
});

// ---- confirmed import -----------------------------------------------------------------
describe("prospect_import confirmation", () => {
  test("\"yes\" creates companies + contacts in the target workspace", async () => {
    install();
    const s = withLastProspect(sess("pi-yes"));
    await handleMessage(s, "import prospects into Prospecting");
    const r = await handleMessage(s, "yes");
    expect(r.text).toContain("Imported **3** contacts");
    expect(r.text).toContain("workspace **Prospecting**");
    expect(companyPosts).toHaveLength(3);
    expect(contactPosts).toHaveLength(3);
    expect(companyPosts[0].name).toBe("Bright Smile Dental");
    expect(companyPosts[0].industry).toBe("dental clinics");
    expect(contactPosts[0].name).toBe("Bright Smile Dental");
    expect(contactPosts[0].company_id).toBe(100); // id returned by the first company POST
    expect(s.pending).toBeUndefined();
  });
  test("existing company is reused, not recreated", async () => {
    install();
    crmCompanies = [{ id: 55, name: "Bright Smile Dental" }];
    const s = withLastProspect(sess("pi-reuse"));
    const ask = await handleMessage(s, "import prospects into Prospecting");
    expect(ask.text).toContain("Import **3** contacts"); // company exists but contact doesn't -> still importable
    await handleMessage(s, "yes");
    expect(companyPosts).toHaveLength(2); // Bright Smile reused, not recreated
    expect(contactPosts).toHaveLength(3);
    const reused = contactPosts.find((c) => c.name === "Bright Smile Dental");
    expect(reused.company_id).toBe(55);
  });
  test("\"no\" cancels without writing", async () => {
    install();
    const s = withLastProspect(sess("pi-no"));
    await handleMessage(s, "import prospects into Prospecting");
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(companyPosts).toHaveLength(0);
    expect(contactPosts).toHaveLength(0);
  });
  test("import caps at PROSPECT_IMPORT_MAX", async () => {
    install();
    const many = Array.from({ length: 35 }, (_, i) => ({
      name: `Dental Practice ${String(i + 1).padStart(2, "0")}`,
      address: "", tags: {}, industry: "dental clinics", territory: "Madisonville",
    }));
    const s = withLastProspect(sess("pi-cap"), many);
    const r = await handleMessage(s, "import prospects into Prospecting");
    expect(s.pending?.payload.items).toHaveLength(PROSPECT_IMPORT_MAX);
    expect(r.text).toContain(`first ${PROSPECT_IMPORT_MAX}`);
    const done = await handleMessage(s, "yes");
    expect(done.text).toContain(`Imported **${PROSPECT_IMPORT_MAX}** contacts`);
    expect(contactPosts).toHaveLength(PROSPECT_IMPORT_MAX);
  });
});

// ---- stash wiring ---------------------------------------------------------------------
describe("lastProspect stash", () => {
  test("prospectTerminalReply keeps the finished run for import", async () => {
    install();
    const s = sess("pi-stash");
    const job: ProspectJobState = { job_id: "j1", industry: "dental clinics", location: "Madisonville", at: Date.now() };
    const done: any = {
      status: "done", location: "Madisonville", industry: "dental clinics",
      progress: { done: 3, total: 3 }, error: null,
      companies: [...prospectCompanies, { name: "Bright Smile Dental" }], // dup intentional
      nodes: [], edges: [],
    };
    const r = await prospectTerminalReply(s, job, done);
    expect(r.text).toContain("Staged **3** companies");
    expect(r.chips).toContain("Import prospects");
    expect(s.lastProspect?.companies).toHaveLength(4); // stash keeps raw list (dedupe happens at import)
    expect(s.lastProspect?.industry).toBe("dental clinics");
    expect(s.lastProspect!.companies.length).toBeLessThanOrEqual(PROSPECT_STASH_MAX);
  });
  test("import right after a finished run works end to end", async () => {
    install();
    const s = sess("pi-e2e");
    const job: ProspectJobState = { job_id: "j2", industry: "dental clinics", location: "Madisonville", at: Date.now() };
    const done: any = {
      status: "done", location: "Madisonville", industry: "dental clinics",
      progress: { done: 3, total: 3 }, error: null, companies: prospectCompanies, nodes: [], edges: [],
    };
    await prospectTerminalReply(s, job, done);
    s.workspaceId = 7; s.workspaceName = "Prospecting";
    const ask = await handleMessage(s, "import prospects");
    expect(ask.text).toContain("Import **3** contacts");
    const doneMsg = await handleMessage(s, "yes");
    expect(doneMsg.text).toContain("Imported **3** contacts");
    expect(contactPosts).toHaveLength(3);
  });
  test("normProspectName treats case/punctuation variants as equal", () => {
    expect(normProspectName("Bright Smile Dental")).toBe("bright smile dental");
    expect(normProspectName("bright smile dental, LLC")).toBe("bright smile dental llc");
  });
});

// Feature 3: conversational capture ("just met James from Vertex, ...").
import { test, expect, beforeEach, describe } from "bun:test";
import { parseIntent, parseCapture } from "../src/intents";
import { handleMessage, runRoutineUnattended } from "../src/brain";
import { initAutomationDb } from "../src/automation";
import { Database } from "bun:sqlite";

function sess() { return { id: "cap-" + Math.random().toString(36).slice(2), history: [], notes: [] } as any; }

// ---- CRM stub ---------------------------------------------------------------
const calls: { method: string; url: string; body?: any }[] = [];
let companies: any[] = [];
let createdCompany: any = null;
let createdContact: any = null;
let createdDeal: any = null;

function stubFetch() {
  (globalThis as any).fetch = async (url: string, opts: any = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, url: u, body });
    const ok = (d: any) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (u.includes("/api/companies") && method === "GET") return ok({ companies });
    if (u.includes("/api/companies") && method === "POST") {
      createdCompany = { id: 7, name: body.name };
      return ok({ company: createdCompany });
    }
    if (u.includes("/api/contacts") && method === "POST") {
      createdContact = { id: 9, ...body };
      return ok({ contact: createdContact });
    }
    if (u.includes("/api/kpis")) return ok({ kpis: {} });
    if (u.includes("/api/stages")) return ok({ stages: [{ slug: "prospecting", name: "Prospecting" }, { slug: "negotiation", name: "Negotiation" }] });
    if (u.includes("/api/deals") && method === "POST") {
      createdDeal = { id: 3, ...body };
      return ok({ deal: createdDeal });
    }
    if (u.includes("/api/health")) return ok({ ok: true });
    if (u.includes("/api/workspaces")) return ok({ workspaces: [{ id: 1, name: "Main" }] });
    throw new Error("unstubbed: " + method + " " + u);
  };
}
beforeEach(() => {
  calls.length = 0; companies = [];
  createdCompany = null; createdContact = null; createdDeal = null;
  initAutomationDb(new Database(":memory:"));
  stubFetch();
});

describe("parseCapture", () => {
  test("spec example 1: name, from-company, note", () => {
    expect(parseCapture("James from Vertex, he's evaluating the pilot")).toEqual({
      name: "James", company: "Vertex", note: "he's evaluating the pilot",
    });
  });
  test("spec example 2: name, no company from lowercase 'at the conference'", () => {
    expect(parseCapture("Sarah Liu at the conference, she's interested in our enterprise plan")).toEqual({
      name: "Sarah Liu", company: "", note: "she's interested in our enterprise plan",
    });
  });
  test("capitalized 'at' company", () => {
    const p = parseCapture("Priya at Helios Labs, CTO");
    expect(p).toEqual({ name: "Priya", company: "Helios Labs", note: "CTO" });
  });
  test("missing company and note", () => {
    expect(parseCapture("Alex")).toEqual({ name: "Alex", company: "", note: "" });
  });
  test("lowercase name gets title-cased", () => {
    const p = parseCapture("james from vertex, pilot talk");
    expect(p.name).toBe("James");
  });
  test("no name detected", () => {
    expect(parseCapture("with the team about Q3").name).toBe("");
  });
});

describe("capture intent routing", () => {
  test("both phrasings route to capture", () => {
    for (const t of [
      "just met James from Vertex, he's evaluating the pilot",
      "met Sarah Liu at the conference, she's interested in our enterprise plan",
      "I just met Priya at Helios Labs",
    ]) {
      const i = parseIntent(t);
      expect(i.name).toBe("capture");
    }
  });
});

describe("capture chat flow", () => {
  test("offer shows a confirmation card and writes nothing", async () => {
    const s = sess();
    const r = await handleMessage(s, "just met James from Vertex, he's evaluating the pilot");
    expect(r.text).toContain("James");
    expect(r.text).toContain("Vertex");
    expect(r.text).toContain("he's evaluating the pilot");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("capture");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("confirm: fuzzy-matches existing company, creates contact + deal draft", async () => {
    companies = [{ id: 5, name: "Vertex Industries" }];
    const s = sess();
    await handleMessage(s, "just met James from Vertex, he's evaluating the pilot");
    const r = await handleMessage(s, "yes");
    expect(createdCompany).toBeNull(); // matched, not created
    expect(createdContact).toMatchObject({ name: "James", company_id: 5 });
    expect(createdDeal.stage).toBe("prospecting"); // first pipeline stage
    expect(createdDeal.company_id).toBe(5);
    expect(createdDeal.contact_id).toBe(9);
    expect(createdDeal.title).toBe("Vertex Industries — evaluating the pilot");
    expect(r.text).toContain("Saved");
    expect(r.text).toContain("Vertex Industries");
  });

  test("confirm: creates the company when there's no match", async () => {
    const s = sess();
    await handleMessage(s, "just met James from Vertex, he's evaluating the pilot");
    await handleMessage(s, "yes");
    expect(createdCompany).toMatchObject({ name: "Vertex" });
    expect(createdContact.company_id).toBe(7);
    expect(createdDeal.company_id).toBe(7);
  });

  test("no company: contact + deal still created, factual title", async () => {
    const s = sess();
    await handleMessage(s, "met Sarah Liu at the conference, she's interested in our enterprise plan");
    await handleMessage(s, "yes");
    expect(createdContact).toMatchObject({ name: "Sarah Liu" });
    expect(createdContact.company_id).toBeUndefined();
    expect(createdDeal.title).toContain("Sarah Liu");
    expect(createdDeal.title).not.toContain("conference");
  });

  test("no note: deal gets a factual fallback title", async () => {
    const s = sess();
    await handleMessage(s, "met Alex");
    await handleMessage(s, "yes");
    expect(createdDeal.title).toBe("Alex — introduction");
  });

  test("correction: restated details update the card", async () => {
    const s = sess();
    await handleMessage(s, "just met James from Vertex, he's evaluating the pilot");
    const r = await handleMessage(s, "James Chen from Vertex Labs, he's evaluating the pilot for Q3");
    expect(r.text).toContain("James Chen");
    expect(r.text).toContain("Vertex Labs");
    expect(r.text).toContain("for Q3");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("capture");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("correction: 'name is' / 'company is' patches", async () => {
    const s = sess();
    await handleMessage(s, "just met James from Vertex");
    let r = await handleMessage(s, "his name is James Chen");
    expect(r.text).toContain("James Chen");
    r = await handleMessage(s, "company is Vertex Labs");
    expect(r.text).toContain("Vertex Labs");
    expect(r.text).toContain("James Chen"); // name preserved
  });

  test("correction: plain sentence becomes the new note", async () => {
    const s = sess();
    await handleMessage(s, "just met James from Vertex");
    const r = await handleMessage(s, "he wants pricing by Friday");
    expect(r.text).toContain("he wants pricing by Friday");
  });

  test("cancel clears pending with no writes", async () => {
    const s = sess();
    await handleMessage(s, "just met James from Vertex, he's evaluating the pilot");
    const r = await handleMessage(s, "cancel");
    expect(s.pending).toBeUndefined();
    expect(r.text).toMatch(/cancelled|dropped/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("missing name asks who", async () => {
    const s = sess();
    const r = await handleMessage(s, "met with the team about Q3");
    expect(r.text).toMatch(/Who did you meet/);
    expect(s.pending).toBeUndefined();
  });

  test("unattended routine skips capture (needs confirmation)", async () => {
    await handleMessage(sess(), "save routine log: just met James from Vertex, he's evaluating the pilot; kpis");
    calls.length = 0;
    const run = await runRoutineUnattended("log", "manual", "test");
    expect(run.status).toBe("partial");
    expect(run.summary).toMatch(/skipped: needs follow-up/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await handleMessage(sess(), "delete routine log");
  });
});

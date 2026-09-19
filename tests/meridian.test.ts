// meridian.test.ts — Milton's read-only Meridian recon access:
// intent parsing, listing, dossier, entity filtering, disambiguation,
// unreachable-Meridian handling, and the MERIDIAN_URL default.
import { describe, test, expect, beforeAll } from "bun:test";
import { parseIntent } from "../src/intents";
import * as mer from "../src/meridian";
import { handleMessage, type Session } from "../src/brain";

const sess = (id: string): Session => ({ id, history: [], notes: [] });

// ---- stub Meridian ------------------------------------------------------------------
const stubRecons = [
  { id: "r1", city: "Austin", country: "US", status: "done", created_at: "2026-09-18 10:00:00", updated_at: "2026-09-18 12:00:00", nodes: 4, edges: 3 },
  { id: "r2", city: "Springfield", country: "US-IL", status: "done", created_at: "2026-09-17 10:00:00", updated_at: "2026-09-17 11:00:00", nodes: 2, edges: 1 },
  { id: "r3", city: "Springfield", country: "US-MA", status: "partial", created_at: "2026-09-16 10:00:00", updated_at: "2026-09-16 11:00:00", nodes: 1, edges: 0 },
];

const stubDetail: Record<string, any> = {
  r1: {
    recon: {
      id: "r1", city: "Austin", country: "US", status: "done",
      created_at: "2026-09-18 10:00:00", updated_at: "2026-09-18 12:00:00",
      facts: { population: "974,447", mayor: "Kirk Watson", timezone: "America/Chicago" },
      sources: [{ key: "geocode", state: "ok" }],
      nodes: [
        { id: "n1", label: "Acme Corp", type: "org", source: "opencorporates", detail: "Holding company, founded 1998", url: "https://example.com/acme" },
        { id: "n2", label: "Globex", type: "company", source: "aleph", detail: "Software vendor" },
        { id: "n3", label: "Jane Doe", type: "person", source: "news", detail: "CEO of Acme" },
        { id: "n4", label: "acme.com", type: "domain", source: "crtsh" },
      ],
      edges: [
        { from: "n3", to: "n1", label: "leads" },
        { from: "n1", to: "n4", label: "owns" },
        { from: "n2", to: "n1", label: "partners" },
      ],
    },
  },
  r2: { recon: { id: "r2", city: "Springfield", country: "US-IL", status: "done", facts: {}, sources: [], nodes: [], edges: [], created_at: "", updated_at: "" } },
  r3: { recon: { id: "r3", city: "Springfield", country: "US-MA", status: "partial", facts: {}, sources: [], nodes: [], edges: [], created_at: "", updated_at: "" } },
};

let meridianDown = false;
const realFetch = globalThis.fetch.bind(globalThis);

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith(mer.meridianBase())) return realFetch(input, init);
  if (meridianDown) return Promise.reject(new Error("fetch failed"));
  const path = url.slice(mer.meridianBase().length).split("?")[0];
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (path === "/api/recon") return ok({ recons: stubRecons });
  const m = path.match(/^\/api\/recon\/([^/]+)$/);
  if (m && stubDetail[m[1]]) return ok(stubDetail[m[1]]);
  if (m) return ok({ error: "not found" }, 404);
  return ok({ error: "not found" }, 404);
}

beforeAll(() => {
  (globalThis as any).fetch = stubFetch;
  mer.clearReconCache();
});

// ---- env default ----------------------------------------------------------------------
describe("meridian env", () => {
  test("defaults to localhost:3005", () => {
    delete process.env.MERIDIAN_URL;
    expect(mer.meridianBase()).toBe("http://localhost:3005");
  });
  test("MERIDIAN_URL overrides", () => {
    process.env.MERIDIAN_URL = "http://example:9999";
    expect(mer.meridianBase()).toBe("http://example:9999");
    delete process.env.MERIDIAN_URL;
  });
});

// ---- intent parsing ---------------------------------------------------------------------
describe("meridian intents", () => {
  test("meridian recons", () => {
    expect(parseIntent("meridian recons").name).toBe("list_recons");
    expect(parseIntent("Meridian recon").name).toBe("list_recons");
  });
  test("meridian dossier <city>", () => {
    const i = parseIntent("meridian dossier austin");
    expect(i.name).toBe("meridian_dossier");
    expect(i.slots.query).toBe("austin");
  });
  test("meridian entities <id>", () => {
    const i = parseIntent("meridian entities r1");
    expect(i.name).toBe("meridian_entities");
    expect(i.slots.query).toBe("r1");
    expect(i.slots.etype).toBeUndefined();
  });
  test("meridian entities <city> <type> splits the type filter", () => {
    const i = parseIntent("meridian entities austin company");
    expect(i.name).toBe("meridian_entities");
    expect(i.slots.query).toBe("austin");
    expect(i.slots.etype).toBe("company");
  });
  test("trailing word that is not a type stays in the query", () => {
    const i = parseIntent("meridian entities new york");
    expect(i.slots.query).toBe("new york");
    expect(i.slots.etype).toBeUndefined();
  });
});

// ---- chat flows -------------------------------------------------------------------------
describe("meridian chat flows", () => {
  test("meridian recons lists sprints with counts", async () => {
    const r = await handleMessage(sess("m-1"), "meridian recons");
    expect(r.text).toContain("Austin");
    expect(r.text).toContain("4 nodes");
    expect(r.text).toContain("id `r1`");
  });
  test("meridian dossier by city renders summary", async () => {
    const r = await handleMessage(sess("m-2"), "meridian dossier austin");
    expect(r.text).toContain("Recon: Austin, US");
    expect(r.text).toContain("org 1");
    expect(r.text).toContain("population");
    expect(r.text).toContain("Acme Corp");
  });
  test("meridian dossier by id", async () => {
    const r = await handleMessage(sess("m-3"), "meridian dossier r1");
    expect(r.text).toContain("Recon: Austin, US");
  });
  test("ambiguous city asks with numbered choices", async () => {
    const s = sess("m-4");
    const r = await handleMessage(s, "meridian dossier springfield");
    expect(r.cards?.[0]?.kind).toBe("choices");
    expect(s.choice?.kind).toBe("recon");
    const r2 = await handleMessage(s, "2");
    expect(r2.text).toContain("Springfield, US-MA");
  });
  test("unknown city is reported", async () => {
    const r = await handleMessage(sess("m-5"), "meridian dossier zzz");
    expect(r.text).toContain('No recon matching "zzz"');
  });
  test("meridian entities lists business entities with facts", async () => {
    const r = await handleMessage(sess("m-6"), "meridian entities austin");
    expect(r.text).toContain("Business entities in Austin");
    expect(r.text).toContain("Acme Corp");
    expect(r.text).toContain("Globex");
    expect(r.text).not.toContain("Jane Doe");
    expect(r.text).not.toContain("acme.com");
    expect(r.text).toContain("Holding company, founded 1998");
    expect(r.text).toContain("https://example.com/acme");
  });
  test("meridian entities with type filter", async () => {
    const r = await handleMessage(sess("m-7"), "meridian entities austin company");
    expect(r.text).toContain("Company in Austin");
    expect(r.text).toContain("Globex");
    expect(r.text).not.toContain("Acme Corp");
  });
  test("unreachable meridian says so plainly", async () => {
    meridianDown = true;
    mer.clearReconCache();
    try {
      const r = await handleMessage(sess("m-8"), "meridian recons");
      expect(r.text).toContain("can't reach Meridian");
      expect(r.text).toContain("MERIDIAN_URL");
    } finally {
      meridianDown = false;
      mer.clearReconCache();
    }
  });
});

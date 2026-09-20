// custom-fields.test.ts — Milton custom-field chat commands vs a stubbed exec-crm.
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import { parseIntent } from "../src/intents";
import { parseIntentFuzzy } from "../src/fuzzy";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); });

// ---- stub exec-crm (real response shapes: definitions use name=slug/label/type,
// values endpoint returns {values:[...]}) --------------------------------------
const calls: { method: string; path: string; body?: any }[] = [];
let failCf = false;
const stubFieldDefs: Record<string, any[]> = {
  contact: [
    { id: 2, name: "renewal_date", label: "Renewal date", type: "date" },
    { id: 3, name: "budget", label: "Budget", type: "number" },
    { id: 4, name: "renewal_day", label: "Renewal day", type: "date" },
  ],
  company: [{ id: 1, name: "vip", label: "VIP", type: "checkbox" }],
  campaign: [],
  task: [],
};
const stubValues: Record<string, any[]> = {
  "contact:1": [{ field_id: 2, name: "Renewal date", field_type: "date", value: "2026-10-01" }],
};
const stubContacts = [
  { id: 1, name: "Acme Corp", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
  { id: 2, name: "Acme Ltd", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
  { id: 3, name: "Bob Jones", email: "", phone: "", company_id: null, company_name: "", title: "", notes: "" },
];
const stubCompanies = [{ id: 1, name: "Globex", industry: "", website: "", notes: "" }];

const realFetch = globalThis.fetch.bind(globalThis);
function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const method = (init.method || "GET").toUpperCase();
  const fullPath = url.replace("http://localhost:3001", "");
  const [path, qs] = fullPath.split("?");
  let body: any;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  calls.push({ method, path: fullPath, body });
  const ok = (data: any, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (failCf && path.startsWith("/api/custom-fields")) return Promise.reject(new Error("fetch failed"));

  if (method === "GET" && path === "/api/custom-fields") {
    const et = new URLSearchParams(qs || "").get("entity_type") || "";
    return ok({ fields: stubFieldDefs[et] || [] });
  }
  if (method === "POST" && path === "/api/custom-fields") {
    const et = String(body.entity_type || "");
    const name = String(body.name || "").trim();
    const ftype = String(body.field_type || "text");
    const dupe = (stubFieldDefs[et] || []).some((f) => String(f.label).toLowerCase() === name.toLowerCase());
    if (dupe) return ok({ error: `custom field "${name}" already exists for ${et}s` }, 400);
    if (!["text", "number", "date", "checkbox"].includes(ftype)) return ok({ error: `field_type must be one of: text, number, date, checkbox` }, 400);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return ok({ field: { id: 9, name: slug, label: name, type: ftype } }, 201);
  }
  const delMatch = path.match(/^\/api\/custom-fields\/(\d+)$/);
  if (delMatch && method === "DELETE") return ok({ ok: true });
  if (method === "GET" && path === "/api/custom-fields/values") {
    const q = new URLSearchParams(qs || "");
    return ok({ values: stubValues[`${q.get("entity_type")}:${q.get("entity_id")}`] || [] });
  }
  if (method === "PUT" && path === "/api/custom-fields/values") return ok({ ok: true });

  if (method === "GET" && path === "/api/contacts") return ok({ contacts: stubContacts });
  if (method === "GET" && path === "/api/companies") return ok({ companies: stubCompanies });
  if (method === "GET" && path === "/api/campaigns") return ok({ campaigns: [] });
  if (method === "GET" && path === "/api/tasks") return ok({ tasks: [] });
  return ok({}, 404);
}
(globalThis as any).fetch = stubFetch;

function mkSession(ws?: number): Session {
  return ws == null ? { id: "cf-test", history: [] } : { id: "cf-test", history: [], workspaceId: ws, workspaceName: "" };
}
beforeEach(() => { calls.length = 0; failCf = false; });

// ---- exact parser -------------------------------------------------------------
describe("custom field parser", () => {
  test("add with explicit type", () => {
    const i = parseIntent("add custom field Renewal date of type date to contacts");
    expect(i.name).toBe("add_custom_field");
    expect(i.slots.name).toBe("Renewal date");
    expect(i.slots.field_type).toBe("date");
    expect(i.slots.entity_type).toBe("contact");
  });
  test("add defaults to no type slot", () => {
    const i = parseIntent("add custom field VIP to companies");
    expect(i.name).toBe("add_custom_field");
    expect(i.slots.name).toBe("VIP");
    expect(i.slots.field_type).toBeUndefined();
    expect(i.slots.entity_type).toBe("company");
  });
  test("add name before 'custom field'", () => {
    const i = parseIntent("add the VIP custom field to companies");
    expect(i.name).toBe("add_custom_field");
    expect(i.slots.name).toBe("VIP");
    expect(i.slots.entity_type).toBe("company");
  });
  test("set keeps field, value, entity, query", () => {
    const i = parseIntent("set Renewal date to 2026-10-01 for contact Acme Corp");
    expect(i.name).toBe("set_custom_field");
    expect(i.slots.field).toBe("Renewal date");
    expect(i.slots.value).toBe("2026-10-01");
    expect(i.slots.entity_type).toBe("contact");
    expect(i.slots.query).toBe("Acme Corp");
  });
  test("set strips a leading article from the field", () => {
    const i = parseIntent("set the VIP to yes for company Globex");
    expect(i.name).toBe("set_custom_field");
    expect(i.slots.field).toBe("VIP");
  });
  test("set for deal explains deals are unsupported", () => {
    const i = parseIntent("set Renewal date to 2026-10-01 for deal Acme");
    expect(i.name).toBe("set_custom_field");
    expect(i.slots.entity_type).toBe("deal");
  });
  test("list definitions", () => {
    const i = parseIntent("list custom fields for contacts");
    expect(i.name).toBe("show_custom_fields");
    expect(i.slots.entity_type).toBe("contact");
    expect(i.slots.query).toBeUndefined();
  });
  test("show values for an entity", () => {
    const i = parseIntent("show custom fields for company Globex");
    expect(i.name).toBe("show_custom_fields");
    expect(i.slots.entity_type).toBe("company");
    expect(i.slots.query).toBe("Globex");
  });
  test("delete", () => {
    const i = parseIntent("remove custom field VIP from companies");
    expect(i.name).toBe("delete_custom_field");
    expect(i.slots.name).toBe("VIP");
    expect(i.slots.entity_type).toBe("company");
  });
  test("delete name before 'custom field'", () => {
    const i = parseIntent("delete the VIP custom field from companies");
    expect(i.name).toBe("delete_custom_field");
    expect(i.slots.name).toBe("VIP");
  });
});

// ---- fuzzy parser -------------------------------------------------------------
describe("fuzzy custom fields", () => {
  test("typo'd add keeps the name verbatim, no explicit type", () => {
    const i = parseIntentFuzzy("creat a custom feild Renewal date for contacts");
    expect(i.name).toBe("add_custom_field");
    expect(i.fuzzy).toBe(true);
    expect(i.slots.name).toBe("Renewal date");
    expect(i.slots.field_type).toBeUndefined();
    expect(i.slots.entity_type).toBe("contact");
  });
  test("paraphrased list has no entity query", () => {
    const i = parseIntentFuzzy("what custom fields do contacts have");
    expect(i.name).toBe("show_custom_fields");
    expect(i.slots.entity_type).toBe("contact");
    expect(i.slots.query).toBeUndefined();
  });
  test("polite show keeps entity + query", () => {
    const i = parseIntentFuzzy("please show me the custom fields for company globex");
    expect(i.name).toBe("show_custom_fields");
    expect(i.slots.entity_type).toBe("company");
    expect(i.slots.query).toBe("globex");
  });
  test("fuzzy set keeps field, value, entity", () => {
    const i = parseIntentFuzzy("change the custom field VIP to no for company globex");
    expect(i.name).toBe("set_custom_field");
    expect(i.slots.field).toBe("VIP");
    expect(i.slots.value).toBe("no");
    expect(i.slots.entity_type).toBe("company");
  });
  test("name-before-custom-field delete", () => {
    const i = parseIntentFuzzy("delete the VIP custom feild from companies");
    expect(i.name).toBe("delete_custom_field");
    expect(i.slots.name).toBe("VIP");
    expect(i.slots.entity_type).toBe("company");
  });
  test("'get me my tasks' stays a task list", () => {
    expect(parseIntentFuzzy("get me my tasks").name).toBe("tasks");
    expect(parseIntentFuzzy("shwo me my tasks").name).toBe("tasks");
  });
  test("'show me jane doe' still disambiguates", () => {
    expect(parseIntentFuzzy("show me jane doe").name).toBe("disambiguate_intent");
  });
  test("'set acme value to 50k' stays on the deal path", () => {
    expect(parseIntentFuzzy("set acme value to 50k").name).toBe("set_deal_field");
  });
  test("'delete task X' stays on the task path", () => {
    expect(parseIntentFuzzy("delete task call bob").name).toBe("delete_task");
  });
});

// ---- add ----------------------------------------------------------------------
describe("add custom field", () => {
  test("infers date from the name and says so", async () => {
    const r = await handleMessage(mkSession(), "add custom field Contract deadline to contacts");
    expect(r.text).toContain("Contract deadline");
    expect(r.text).toContain("date");
    expect(r.text).toMatch(/infer/i);
    const post = calls.find((c) => c.method === "POST" && c.path.startsWith("/api/custom-fields"));
    expect(post?.body).toMatchObject({ entity_type: "contact", name: "Contract deadline", field_type: "date" });
  });
  test("explicit type is not reported as inferred", async () => {
    const r = await handleMessage(mkSession(), "add custom field Review day of type text to contacts");
    expect(r.text).not.toMatch(/infer/i);
    const post = calls.find((c) => c.method === "POST" && c.path.startsWith("/api/custom-fields"));
    expect(post?.body).toMatchObject({ field_type: "text" });
  });
  test("duplicate is a plain sentence, not raw JSON", async () => {
    const r = await handleMessage(mkSession(), "add custom field VIP to companies");
    expect(r.text).toMatch(/couldn't add/i);
    expect(r.text).not.toContain('{"error"');
    expect(r.text).toContain("already exists");
  });
});

// ---- set ----------------------------------------------------------------------
describe("set custom field", () => {
  test("happy path PUTs the value", async () => {
    const r = await handleMessage(mkSession(), "set Renewal date to 2026-10-01 for contact Acme Corp");
    expect(r.text).toContain("Renewal date");
    expect(r.text).toContain("2026-10-01");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/custom-fields/values");
    expect(put?.body).toMatchObject({ field_id: 2, entity_id: 1, value: "2026-10-01" });
  });
  test("leading article on the field still resolves", async () => {
    const r = await handleMessage(mkSession(), "set the VIP to yes for company Globex");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/custom-fields/values");
    expect(put?.body).toMatchObject({ field_id: 1, entity_id: 1, value: "true" });
    expect(r.text).toContain("VIP");
  });
  test("bad date is rejected before any PUT", async () => {
    const r = await handleMessage(mkSession(), "set Renewal date to not-a-date for contact Acme Corp");
    expect(r.text).toMatch(/couldn't parse/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("impossible date is rejected", async () => {
    const r = await handleMessage(mkSession(), "set Renewal date to 2026-02-30 for contact Acme Corp");
    expect(r.text).toMatch(/couldn't parse/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("non-number for a number field is rejected", async () => {
    const r = await handleMessage(mkSession(), "set Budget to lots for contact Acme Corp");
    expect(r.text).toMatch(/isn't a number/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("checkbox accepts yes/no variants", async () => {
    await handleMessage(mkSession(), "set VIP to no for company Globex");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/custom-fields/values");
    expect(put?.body).toMatchObject({ field_id: 1, value: "false" });
  });
  test("checkbox rejects non-yes/no", async () => {
    const r = await handleMessage(mkSession(), "set VIP to maybe for company Globex");
    expect(r.text).toMatch(/yes\/no/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("unknown field names the known ones", async () => {
    const r = await handleMessage(mkSession(), "set Nope to x for contact Acme Corp");
    expect(r.text).toMatch(/couldn't find a custom field/i);
    expect(r.text).toContain("Renewal date");
  });
  test("unknown entity is reported", async () => {
    const r = await handleMessage(mkSession(), "set Renewal date to 2026-10-01 for contact Nobody Here");
    expect(r.text).toMatch(/couldn't find a contact/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("deal entity gets the not-supported explanation", async () => {
    const r = await handleMessage(mkSession(), "set Renewal date to x for deal Acme");
    expect(r.text).toMatch(/not on deals/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("ambiguous field asks with numbered choices", async () => {
    const s = mkSession();
    const r = await handleMessage(s, "set Renewal to 2026-10-01 for contact Acme Corp");
    expect(r.text).toMatch(/which one did you mean/i);
    expect(s.choice?.kind).toBe("field");
    const r2 = await handleMessage(s, "1");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/custom-fields/values");
    expect(put?.body).toMatchObject({ entity_id: 1, value: "2026-10-01" });
    expect(r2.text).toContain("Renewal date");
  });
  test("ambiguous entity asks with numbered choices", async () => {
    const s = mkSession();
    const r = await handleMessage(s, "set Renewal date to 2026-10-01 for contact Acme");
    expect(r.text).toMatch(/which one did you mean/i);
    const r2 = await handleMessage(s, "2");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/custom-fields/values");
    expect(put?.body).toMatchObject({ field_id: 2, entity_id: 2, value: "2026-10-01" });
    expect(r2.text).toContain("Acme Ltd");
  });
});

// ---- show ---------------------------------------------------------------------
describe("show custom fields", () => {
  test("lists definitions with types", async () => {
    const r = await handleMessage(mkSession(), "list custom fields for companies");
    expect(r.text).toContain("VIP");
    expect(r.text).toContain("checkbox");
  });
  test("shows one entity's values", async () => {
    const r = await handleMessage(mkSession(), "show custom fields for contact Acme Corp");
    expect(r.text).toContain("Renewal date");
    expect(r.text).toContain("2026-10-01");
  });
  test("no definitions yet", async () => {
    const r = await handleMessage(mkSession(), "list custom fields for tasks");
    expect(r.text).toMatch(/no custom fields on tasks yet/i);
  });
  test("entity with no values", async () => {
    const r = await handleMessage(mkSession(), "show custom fields for contact Bob Jones");
    expect(r.text).toMatch(/no custom fields/i);
  });
});

// ---- delete -------------------------------------------------------------------
describe("delete custom field", () => {
  test("asks first with a confirm card", async () => {
    const s = mkSession();
    const r = await handleMessage(s, "remove custom field VIP from companies");
    expect(r.text).toMatch(/delete custom field/i);
    expect(r.text).toMatch(/can't be undone/i);
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("delete_custom_field");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  test("yes deletes", async () => {
    const s = mkSession();
    await handleMessage(s, "remove custom field VIP from companies");
    const r = await handleMessage(s, "Yes");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/api/custom-fields/1");
    expect(r.text).toMatch(/deleted custom field/i);
  });
  test("no cancels", async () => {
    const s = mkSession();
    await handleMessage(s, "remove custom field VIP from companies");
    const r = await handleMessage(s, "No");
    expect(r.text).toMatch(/cancelled/i);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// ---- failure modes ------------------------------------------------------------
describe("failure modes", () => {
  test("unreachable CRM is a plain sentence", async () => {
    failCf = true;
    const r = await handleMessage(mkSession(), "list custom fields for contacts");
    expect(r.text).toMatch(/can't reach exec-crm/i);
  });
  test("workspace id is sent when the session has one", async () => {
    await handleMessage(mkSession(7), "list custom fields for contacts");
    expect(calls.some((c) => c.path.includes("workspace=7"))).toBe(true);
  });
  test("no workspace means no workspace param", async () => {
    await handleMessage(mkSession(), "list custom fields for contacts");
    expect(calls.some((c) => c.path.includes("workspace="))).toBe(false);
  });
});

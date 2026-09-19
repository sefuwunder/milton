// intents.test.ts — parser unit tests
import { describe, test, expect } from "bun:test";
import { parseIntent, parseMoney, parseDate, parseStage, extractMoney, extractDate, HELP_LEVELS, helpText } from "../src/intents";

describe("parseIntent reads", () => {
  const cases: [string, string, Record<string, string>?][] = [
    ["help", "help"],
    ["show pipeline", "pipeline"],
    ["pipeline", "pipeline"],
    ["kpis", "kpis"],
    ["how are we doing", "kpis"],
    ["deals", "deals"],
    ["list deals in negotiation", "deals", { stage: "negotiation" }],
    ["list deals in won", "deals", { stage: "closed_won" }],
    ["show deal acme website", "deal_detail", { query: "acme website" }],
    ["tasks", "tasks"],
    ["my tasks", "tasks"],
    ["completed tasks", "tasks", { filter: "done" }],
    ["show tasks for acme", "tasks", { search: "acme" }],
    ["contacts", "contacts"],
    ["find contacts named jane", "contacts", { search: "jane" }],
    ["list companies", "companies"],
    ["find company globex", "companies", { search: "globex" }],
    ["morning brief", "brief"],
    ["brief me", "brief"],
    ["pipeline hygiene", "hygiene"],
    ["webhooks", "webhooks"],
    ["incoming hooks", "hooks"],
    ["delivery log", "deliveries"],
    ["recent activity", "activities"],
    ["read this", "ocr_read"],
    ["read the photo", "ocr_read"],
    ["what does this say", "ocr_read"],
    ["what's in this photo", "ocr_read"],
    ["transcribe this", "ocr_read"],
    ["transcribe it", "ocr_read"],
    ["analyze the handwriting", "handwriting"], ["analyze handwriting", "handwriting"],
    ["analyze this handwriting", "handwriting"],
    ["handwriting analysis", "handwriting"],
    ["describe the handwriting", "handwriting"],
    ["save note to a deal", "save_note"],
    ["my notes", "notes"],
    ["list notes", "notes"],
  ];
  for (const [input, name, slots] of cases) {
    test(`"${input}" -> ${name}`, () => {
      const i = parseIntent(input);
      expect(i.name).toBe(name);
      if (slots) for (const [k, v] of Object.entries(slots)) expect(i.slots[k]).toBe(v);
    });
  }
});

describe("parseIntent writes", () => {
  test("move deal to stage", () => {
    const i = parseIntent("move acme website to negotiation");
    expect(i.name).toBe("move_deal");
    expect(i.slots.query).toBe("acme website");
    expect(i.slots.stage).toBe("negotiation");
  });
  test("mark won/lost", () => {
    expect(parseIntent("mark acme deal as won").slots).toMatchObject({ query: "acme", result: "won" });
    expect(parseIntent("mark acme deal as lost").name).toBe("close_deal");
  });
  test("delete deal", () => {
    const i = parseIntent("delete deal acme website");
    expect(i.name).toBe("delete_deal");
    expect(i.slots.query).toBe("acme website");
  });
  test("stage intents", () => {
    expect(parseIntent("stages").name).toBe("list_stages");
    expect(parseIntent("list stages").name).toBe("list_stages");
    expect(parseIntent("show pipeline stages").name).toBe("list_stages");
    const a = parseIntent("add stage Discovery Call");
    expect(a.name).toBe("add_stage");
    expect(a.slots.name).toBe("Discovery Call"); // display names keep their case
    const ab = parseIntent("add stage Discovery before Proposal");
    expect(ab.slots).toMatchObject({ name: "Discovery", pos: "before", ref: "proposal" });
    const r = parseIntent("rename stage Proposal to Scoping");
    expect(r.name).toBe("rename_stage");
    expect(r.slots).toMatchObject({ query: "proposal", name: "Scoping" });
    const d = parseIntent("delete stage Discovery");
    expect(d.name).toBe("delete_stage");
    expect(d.slots.query).toBe("discovery");
    const m = parseIntent("move stage Negotiation after Proposal");
    expect(m.name).toBe("move_stage");
    expect(m.slots).toMatchObject({ query: "negotiation", pos: "after", ref: "proposal" });
    // no clash with deal intents
    expect(parseIntent("move stage X before Y").name).toBe("move_stage");
    expect(parseIntent("move acme deal to negotiation").name).toBe("move_deal");
  });
  test("set deal field", () => {
    const i = parseIntent("set acme deal value to 75k");
    expect(i.name).toBe("set_deal_field");
    expect(i.slots.field).toBe("value");
  });
  test("add deal with extras", () => {
    const i = parseIntent("add deal Website redesign for Acme worth 50k close friday");
    expect(i.name).toBe("add_deal");
    expect(i.slots.value).toBe("50000");
    expect(i.slots.company).toBe("acme");
    expect(i.slots.close).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(i.slots.title).toContain("website redesign");
  });
  test("add contact", () => {
    const i = parseIntent("add contact Jane Doe at Acme jane@acme.com");
    expect(i.name).toBe("add_contact");
    expect(i.slots.name).toBe("jane doe");
    expect(i.slots.company).toBe("acme");
    expect(i.slots.email).toBe("jane@acme.com");
  });
  test("add task with due", () => {
    const i = parseIntent("add task Call Acme tomorrow");
    expect(i.name).toBe("add_task");
    expect(i.slots.title).toBe("call acme");
    expect(i.slots.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("remind me", () => {
    const i = parseIntent("remind me to send the proposal friday");
    expect(i.name).toBe("remind");
    expect(i.slots.title).toContain("send the proposal");
    expect(i.slots.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("complete task", () => {
    expect(parseIntent("complete task 3").slots.query).toBe("3");
    expect(parseIntent("done with call acme").name).toBe("complete_task");
  });
  test("confirm + choose", () => {
    expect(parseIntent("yes").name).toBe("confirm_yes");
    expect(parseIntent("no").name).toBe("confirm_no");
    expect(parseIntent("2").slots.n).toBe("2");
    expect(parseIntent("pick 1").name).toBe("choose_number");
  });
});

describe("help stays in sync with the parser", () => {
  let total = 0;
  for (const level of HELP_LEVELS) {
    for (const row of level.rows) {
      for (const [cmd, intent] of row.cmds) {
        total++;
        test(`help example "${cmd}" -> ${intent}`, () => {
          expect(parseIntent(cmd).name).toBe(intent);
        });
      }
    }
  }
  test("help covers all three levels", () => {
    expect(HELP_LEVELS.map((l) => l.title)).toEqual([
      "🟢 Beginner — everyday commands",
      "🟡 Intermediate — automate the repeatable",
      "🔴 Advanced — events, webhooks, destructive ops",
    ]);
    expect(total).toBeGreaterThan(20);
  });
  test("helpText renders every example", () => {
    const text = helpText();
    for (const level of HELP_LEVELS) {
      expect(text).toContain(level.title);
      for (const row of level.rows) {
        for (const [cmd] of row.cmds) expect(text).toContain(`\`${cmd}\``);
        if (row.note) expect(text).toContain(row.note);
      }
    }
  });
});

describe("value parsers", () => {
  test("parseMoney", () => {
    expect(parseMoney("$50k")).toBe(50000);
    expect(parseMoney("1.2m")).toBe(1200000);
    expect(parseMoney("75000")).toBe(75000);
    expect(parseMoney("$2.5M")).toBe(2500000);
  });
  test("parseStage", () => {
    expect(parseStage("won")).toBe("closed_won");
    expect(parseStage("negotiating")).toBe("negotiation");
    expect(parseStage("banana")).toBeNull();
  });
  test("parseDate", () => {
    const ref = new Date("2026-09-19T12:00:00");
    expect(parseDate("today", ref)).toBe("2026-09-19");
    expect(parseDate("tomorrow", ref)).toBe("2026-09-20");
    expect(parseDate("friday", ref)).toBe("2026-09-25"); // Sat 9/19 -> next Fri 9/25
    expect(parseDate("in 3 days", ref)).toBe("2026-09-22");
    expect(parseDate("2026-10-02", ref)).toBe("2026-10-02");
  });
  test("extractMoney/extractDate", () => {
    const m = extractMoney("deal worth $50k for acme");
    expect(m?.value).toBe(50000);
    const d = extractDate("call acme tomorrow morning");
    expect(d?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d?.rest).not.toContain("tomorrow");
  });
});

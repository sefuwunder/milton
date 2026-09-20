// usability.test.ts — the usability batch's pure logic: command registry
// completeness, unknown-command suggestions, wizard state machine, pronoun
// resolution, and the undo journal. No fetch: the in-memory fallback stands
// in for SQLite (the server boots initUsabilityDb for real).
import { describe, test, expect, beforeEach } from "bun:test";
import { INTENT_NAMES } from "../src/intents";
import { parseIntentFuzzy } from "../src/fuzzy";
import { commandRegistry, suggestCommands } from "../src/commands";
import {
  trackMention, latestMention, pushUndo, popUndo, undoDepth,
  setWizard, getWizard, clearWizard, wizardAnswer, wizardPrompt,
  applyPronouns, __resetMemory,
} from "../src/usability";

beforeEach(() => { __resetMemory(); });

// ---- command registry -------------------------------------------------------
describe("command registry", () => {
  test("every parser intent is registered", () => {
    const names = new Set(commandRegistry().map((c) => c.name));
    const missing = INTENT_NAMES.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });
  test("every non-internal command has a description and a usage that parses to it", () => {
    const bad: string[] = [];
    for (const c of commandRegistry()) {
      if (c.internal) continue;
      if (!c.description || !c.usage) { bad.push(`${c.name}: missing description/usage`); continue; }
      const r = parseIntentFuzzy(c.usage);
      if (r.name !== c.name) bad.push(`${c.name}: usage "${c.usage}" parses to ${r.name}`);
    }
    expect(bad).toEqual([]);
  });
  test("plumbing intents stay internal", () => {
    const by = new Map(commandRegistry().map((c) => [c.name, c]));
    for (const n of ["unknown", "confirm_yes", "confirm_no", "choose_number", "disambiguate_intent"])
      expect(by.get(n)?.internal).toBe(true);
  });
});

// ---- unknown-command suggestions --------------------------------------------
describe("suggestCommands", () => {
  const top3 = (raw: string) => suggestCommands(raw, 3).map((c) => c.name);
  test("typo'd commands land in the top 3", () => {
    expect(top3("updo")).toContain("undo");
    expect(top3("deal jurney acme")).toContain("deal_journey");
    expect(top3("show dupicates")).toContain("duplicates");
    expect(top3("new tasl")).toContain("wizard_start");
    expect(top3("whats bloking the website thing")).toContain("task_blockers");
  });
  test("exact-ish command wins first place", () => {
    expect(suggestCommands("updo")[0]?.name).toBe("undo");
  });
  test("empty input suggests nothing", () => {
    expect(suggestCommands("")).toEqual([]);
  });
  test("pure gibberish suggests nothing (no alphabetical noise)", () => {
    expect(suggestCommands("frobnicator")).toEqual([]);
    expect(suggestCommands("frobnicator doohickey")).toEqual([]);
  });
  test("internal plumbing never surfaces", () => {
    for (const raw of ["updo", "confimr", "chooze 2", "unknow"])
      expect(top3(raw)).not.toContain("confirm_yes");
  });
});

// ---- wizard state machine ---------------------------------------------------
describe("wizard state machine", () => {
  const dealWiz = () => {
    setWizard("s", { kind: "deal", step: 0, data: {} });
    return getWizard("s")!;
  };
  test("prompt counts steps and offers skip/cancel", () => {
    const p = wizardPrompt(dealWiz());
    expect(p.text).toContain("1 of 4");
    expect(p.chips).toEqual(["Cancel"]); // title is required
    const p2 = wizardPrompt({ kind: "deal", step: 1, data: {} });
    expect(p2.text).toContain("2 of 4");
    expect(p2.chips).toEqual(["Skip", "Cancel"]);
  });
  test("happy path: required title, money parsed, skips, then finishes", () => {
    let w = dealWiz();
    let t = wizardAnswer("s", w, "Acme Website");
    expect(t.finished).toBe(false);
    t = wizardAnswer("s", getWizard("s")!, "50k");
    expect(t.finished).toBe(false);
    expect(getWizard("s")!.data.value).toBe("50000");
    t = wizardAnswer("s", getWizard("s")!, "__skip__");
    expect(t.finished).toBe(false); // close date skipped
    t = wizardAnswer("s", getWizard("s")!, "__skip__");
    expect(t.finished).toBe(true);
    expect(t.kind).toBe("deal");
    expect(t.slots).toMatchObject({ title: "Acme Website", value: "50000", company: "", close: "" });
  });
  test("invalid money re-asks without advancing", () => {
    const w = dealWiz();
    wizardAnswer("s", w, "Acme");
    const t = wizardAnswer("s", getWizard("s")!, "lots");
    expect(t.finished).toBe(false);
    expect(t.reply?.text).toContain("doesn't look like an amount");
    expect(getWizard("s")!.step).toBe(1); // still on the value slot
  });
  test("required slot refuses skip", () => {
    const t = wizardAnswer("s", dealWiz(), "__skip__");
    expect(t.finished).toBe(false);
    expect(t.reply?.text).toContain("I need an answer here");
    expect(getWizard("s")!.step).toBe(0);
  });
  test("task wizard validates due dates", () => {
    setWizard("s", { kind: "task", step: 0, data: {} });
    wizardAnswer("s", getWizard("s")!, "Call Acme");
    const t = wizardAnswer("s", getWizard("s")!, "not a date");
    expect(t.finished).toBe(false);
    expect(t.reply?.text).toContain("doesn't look like a date");
  });
  test("contact wizard validates email", () => {
    setWizard("s", { kind: "contact", step: 0, data: {} });
    wizardAnswer("s", getWizard("s")!, "Jane Doe");
    wizardAnswer("s", getWizard("s")!, "__skip__"); // company
    const t = wizardAnswer("s", getWizard("s")!, "not-an-email");
    expect(t.finished).toBe(false);
    expect(t.reply?.text).toContain("doesn't look like an email");
  });
  test("clearWizard ends it", () => {
    dealWiz();
    clearWizard("s");
    expect(getWizard("s")).toBe(null);
  });
  test("wizard state survives set/get round-trip", () => {
    setWizard("s", { kind: "company", step: 1, data: { name: "Acme" } });
    expect(getWizard("s")).toMatchObject({ kind: "company", step: 1 });
  });
});

// ---- pronouns ---------------------------------------------------------------
describe("pronouns", () => {
  test("it resolves the latest deal mention", () => {
    trackMention("s", "deal", 3, "Globex Audit");
    const r = applyPronouns("s", { name: "move_deal", slots: { query: "it", stage: "negotiation" } });
    expect(r.missing).toBe(undefined);
    expect(r.intent.slots.query).toBe("Globex Audit");
  });
  test("missing mention reports the entity type instead of guessing", () => {
    const r = applyPronouns("s", { name: "contact_detail", slots: { query: "her" } });
    expect(r.missing).toBe("contact");
    expect(r.intent.slots.query).toBe("her"); // untouched
  });
  test("a deal mention never leaks into a contact query", () => {
    trackMention("s", "deal", 3, "Globex Audit");
    const r = applyPronouns("s", { name: "contact_detail", slots: { query: "it" } });
    expect(r.missing).toBe("contact");
  });
  test("hers resolves the latest contact", () => {
    trackMention("s", "contact", 1, "Jane Doe");
    const r = applyPronouns("s", { name: "contact_detail", slots: { query: "hers" } });
    expect(r.missing).toBe(undefined);
    expect(r.intent.slots.query).toBe("Jane Doe");
  });
  test("that task resolves tasks", () => {
    trackMention("s", "task", 2, "Send invoice");
    const r = applyPronouns("s", { name: "task_blockers", slots: { query: "that task" } });
    expect(r.intent.slots.query).toBe("Send invoice");
  });
  test("intents without pronoun slots pass through untouched", () => {
    const r = applyPronouns("s", { name: "kpis", slots: {} });
    expect(r.missing).toBe(undefined);
  });
  test("re-mentioning bumps to the front", () => {
    trackMention("s", "deal", 1, "Old Deal");
    trackMention("s", "deal", 2, "New Deal");
    trackMention("s", "deal", 1, "Old Deal");
    expect(latestMention("s", "deal")?.name).toBe("Old Deal");
  });
});

// ---- undo journal -----------------------------------------------------------
describe("undo journal", () => {
  test("push and pop round-trip, then empties", () => {
    pushUndo("s", "Created deal", { kind: "delete_deal", id: 9 });
    const e = popUndo("s");
    expect(e?.label).toBe("Created deal");
    expect(e?.inverse).toMatchObject({ kind: "delete_deal", id: 9 });
    expect(popUndo("s")).toBe(null);
  });
  test("pops newest first (LIFO)", () => {
    pushUndo("s", "first", { kind: "delete_deal", id: 1 });
    pushUndo("s", "second", { kind: "delete_deal", id: 2 });
    expect(popUndo("s")?.label).toBe("second");
    expect(popUndo("s")?.label).toBe("first");
  });
  test("journal caps at twenty per session", () => {
    for (let i = 0; i < 25; i++) pushUndo("s", `op ${i}`, { kind: "delete_deal", id: i });
    expect(undoDepth("s")).toBe(20);
    expect(popUndo("s")?.label).toBe("op 24"); // newest survives
    let count = 1;
    while (popUndo("s")) count++;
    expect(count).toBe(20);
  });
  test("mentions cap at ten per session", () => {
    for (let i = 0; i < 12; i++) trackMention("s", "deal", i, `Deal ${i}`);
    expect(latestMention("s", "deal")?.name).toBe("Deal 11");
  });
  test("sessions are isolated", () => {
    pushUndo("a", "op a", { kind: "delete_deal", id: 1 });
    trackMention("a", "deal", 1, "Deal A");
    expect(popUndo("b")).toBe(null);
    expect(latestMention("b", "deal")).toBe(null);
  });
});

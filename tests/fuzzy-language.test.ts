// fuzzy-language.test.ts — deterministic typo/paraphrase tolerance for Milton.
//
// The fuzzy interpreter (src/fuzzy.ts) runs only when the exact parser says
// "unknown". It is dependency-free and fully deterministic: same input always
// yields the same intent. These tests pin that behavior: typos, paraphrases,
// shuffled word order, filler words, slot preservation, gibberish, near-tie
// disambiguation, and adversarial long-input timing.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntentFuzzy } from "../src/fuzzy";
import { handleMessage, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); });

// Minimal exec-crm stub: enough for the disambiguation flow test below.
const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as any).fetch = (input: any, init: any = {}) => {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const path = url.replace("http://localhost:3001", "").split("?")[0];
  const ok = (data: any) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
  if (path === "/api/deals") return ok({ deals: [] });
  if (path === "/api/contacts") return ok({ contacts: [] });
  if (path === "/api/companies") return ok({ companies: [] });
  if (path === "/api/tasks") return ok({ tasks: [] });
  if (path === "/api/stages") return ok({ stages: [] });
  if (path === "/api/kpis") return ok({ pipeline_value: 0, open_deals: 0, win_rate: 0 });
  return Promise.resolve(new Response("not found", { status: 404 }));
};

function freshSession(): Session { return { id: "fuzzy-test", history: [] }; }

// ---------------------------------------------------------------------------
// Corpus: [input, expected intent]. Every expectation below was verified
// against the actual implementation; the suite fails if behavior drifts.
// ---------------------------------------------------------------------------
const CORPUS: [string, string][] = [
  // required examples
  ["shwo my daels", "deals"],
  ["clsoe the deal", "unknown"],
  ["what opportunities are closing soon", "closing_soon"],
  ["deals closing soon", "closing_soon"],
  ["widget as pin this", "pin_widget"],
  ["hey milton could you please show me my top deals thanks", "top_deals"],

  // typos: transpositions, substitutions, missing letters
  ["daels", "deals"],
  ["deel", "deals"],
  ["shwo my daels", "deals"],
  ["shwo me my tasks", "tasks"],
  ["clsoe the acme deal as won", "close_deal"],
  ["delte deal acme", "delete_deal"],
  ["ad a new deal acme 50k", "add_deal"],
  ["remvoe task call acme", "delete_task"],
  ["complet task call acme", "complete_task"],
  ["swich to acme workspace", "switch_workspace"],
  ["kpsi", "kpis"],
  ["top daels", "top_deals"],
  ["shwo my pipeline", "pipeline"],
  ["ad conatct jane", "add_contact"],
  ["cretae task call bob", "add_task"],
  ["delet task call acme", "delete_task"],
  ["updtae deal acme value 60k", "set_deal_field"],
  ["lisst my contacts", "contacts"],

  // paraphrases: same intent, different words
  ["which deals close soon", "closing_soon"],
  ["upcoming closes", "closing_soon"],
  ["show me everything closing this week", "closing_soon"],
  ["what does the pipeline look like", "pipeline"],
  ["gimme my kpis", "kpis"],
  ["give me my kpis", "kpis"],
  ["show key metrics", "kpis"],
  ["display the pipeline", "pipeline"],
  ["show the sales pipeline", "pipeline"],
  ["list my deals", "deals"],
  ["show all deals", "deals"],
  ["get me my tasks", "tasks"],
  ["list open tasks", "tasks"],
  ["mark the acme deal as won", "close_deal"],
  ["acme deal close as won", "close_deal"],
  ["close acme as lost", "close_deal"],
  ["move acme to negotiation", "move_deal"],
  ["shift the acme deal to proposal", "move_deal"],
  ["to negotiation move the acme deal", "move_deal"],
  ["create a new deal for acme", "add_deal"],
  ["new deal acme 30k", "add_deal"],
  ["add deal Acme Corp for $50k closing tomorrow", "add_deal"],
  ["remind me to call sarah in 2 hours", "remind_add"],
  ["remind me about the acme proposal tomorrow", "remind_add"],
  ["note on Acme: called today, wants proposal", "add_note"],
  ["add a note to acme deal: sent pricing", "add_note"],
  ["search acme corp", "search"],
  ["find acme", "search"],
  ["look up globex", "search"],
  ["cancel the acme deal", "delete_deal"],
  ["finish task call acme", "complete_task"],
  ["check off call acme", "complete_task"],
  ["mark task call acme complete", "complete_task"],
  ["give me a briefing on globex", "brief"],
  ["show my companies", "companies"],
  ["list companies", "companies"],
  ["add company initech", "add_company"],
  ["add contact jane at acme", "add_contact"],

  // shuffled word order
  ["deals my show", "deals"],
  ["tasks my show", "tasks"],
  ["my kpis show me", "kpis"],
  ["contacts my list", "contacts"],

  // filler-heavy inputs
  ["um can you like show me my deals please", "deals"],
  ["please add a new deal for acme thanks", "add_deal"],
  ["hey can you remind me to call sarah", "remind_add"],

  // gibberish / small talk -> unknown (LLM fallback), never a false positive
  ["xyzzy plugh nonsense", "unknown"],
  ["tell me a joke about crm", "unknown"],
  ["", "unknown"],
  ["asdf qwer zxcv", "unknown"],
  ["the quick brown fox", "unknown"],
  ["hello", "unknown"],
  ["thanks", "unknown"],
  ["what do I need to do", "unknown"],

  // incomplete strong commands stay unknown: never invent won/lost or a title
  ["clsoe the deal", "unknown"],
  ["add a deal", "unknown"],

  // near ties -> numbered disambiguation, never a coin flip
  ["tell me about acme", "disambiguate_intent"],
  ["show me jane doe", "disambiguate_intent"],
  ["deal acme", "deal_detail"],
  ["deals", "deals"],
  ["show deal", "deals"],
  ["compleet the acme deal", "disambiguate_intent"],

  // stages
  ["list stages", "list_stages"],
  ["add stage discovery", "add_stage"],
  ["rename stage prospecting to discovery", "rename_stage"],
  ["move stage discovery before negotiation", "move_stage"],

  // routines / schedules
  ["run morning brief", "run_routine"],
  ["list routines", "list_routines"],
  ["list schedules", "list_schedules"],

  // meridian (read-only)
  ["meridian recons", "list_recons"],
  ["meridian dossier springfield", "meridian_dossier"],
  ["meridian entities springfield org", "meridian_entities"],

  // widgets / pin
  ["pin this as a widget", "pin_widget"],
  ["pin this widget", "pin_widget"],

  // workspaces
  ["switch to acme workspace", "switch_workspace"],
  ["list workspaces", "list_workspaces"],
  ["current workspace", "current_workspace"],

  // help / brief / hygiene
  ["help", "help"],
  ["what can you do", "help"],
  ["morning brief", "brief"],
  ["pipeline hygiene", "hygiene"],

  // more coverage: tasks, notes, campaigns, stages, routines, recon, ocr
  ["show my tasks", "tasks"],
  ["overdue tasks", "tasks"],
  ["add contact bob at initech", "add_contact"],
  ["who is jane", "contact_detail"],
  ["add deal globex 100k", "add_deal"],
  ["deals in negotiation", "deals"],
  ["won deals", "deals"],
  ["show closed won deals", "deals"],
  ["lost deals", "deals"],
  ["schedule eod daily at 6pm", "schedule_add"],
  ["save routine eod: check pipeline", "save_routine"],
  ["run eod", "run_routine"],
  ["delete routine eod", "delete_routine"],
  ["add campaign q4 push", "add_campaign"],
  ["read this", "ocr_read"],
  ["transcribe the image", "ocr_read"],
  ["stages", "list_stages"],
  ["note on acme: met at conference", "add_note"],
  ["remind me to send the proposal", "remind_add"],
  ["my reminders", "remind_list"],
  ["morning briefing", "brief"],
  ["daily brief", "brief"],
  ["pipeline summary", "pipeline"],
  ["funnel", "pipeline"],
  ["how are we doing", "kpis"],
  ["kpi dashboard", "kpis"],
  ["delete stage discovery", "delete_stage"],
  ["rename stage foo to bar", "rename_stage"],
  ["start recon springfield", "meridian_request"],
  ["meeting prep for acme", "prep_brief"],

  // pre-existing exact-parser behavior is preserved (exact wins over fuzzy):
  // "delete the acme deal" and "remove deal acme" hit the exact delete_task
  // regex, so the fuzzy layer never runs. Pinned here, not endorsed.
  ["delete the acme deal", "delete_task"],
  ["remove deal acme", "delete_task"],
  ["remove acme deal", "delete_task"],
  ["delete contact jane", "delete_task"],
  ["delete it", "delete_task"],
];

describe("fuzzy language corpus", () => {
  for (const [input, want] of CORPUS) {
    test(JSON.stringify(input) + " -> " + want, () => {
      expect(parseIntentFuzzy(input).name).toBe(want);
    });
  }
  test(`corpus has ${CORPUS.length} cases`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(120);
  });
});

describe("fuzzy slot preservation", () => {
  test("add deal keeps money, date and title", () => {
    const r = parseIntentFuzzy("add deal Acme Renewal worth $45k next Friday");
    expect(r.name).toBe("add_deal");
    expect(r.slots.title).toBe("acme renewal");
    expect(r.slots.value).toBe("45000");
    expect(r.slots.close).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("add task keeps title and due date", () => {
    const r = parseIntentFuzzy("add task Call Jane tomorrow");
    expect(r.name).toBe("add_task");
    expect(r.slots.title).toBe("call jane");
    expect(r.slots.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("close deal keeps query and outcome", () => {
    const r = parseIntentFuzzy("close Acme Website as won");
    expect(r.name).toBe("close_deal");
    expect(r.slots.query).toBe("acme website");
    expect(r.slots.result).toBe("won");
  });
  test("typo'd add deal keeps slots", () => {
    const r = parseIntentFuzzy("ad a new deal acme 50k");
    expect(r.name).toBe("add_deal");
    expect(r.slots.title).toBe("acme");
    expect(r.slots.value).toBe("50000");
  });
  test("move deal keeps stage", () => {
    const r = parseIntentFuzzy("to negotiation move the acme deal");
    expect(r.name).toBe("move_deal");
    expect(r.slots.stage).toBe("negotiation");
  });
});

describe("fuzzy disambiguation flow", () => {
  test("near tie asks a numbered question, picking a number dispatches it", async () => {
    const s = freshSession();
    const q = await handleMessage(s, "tell me about acme");
    expect(q.text).toContain("Did you mean:");
    expect(q.chips).toEqual(["1", "2"]);
    // pick "show a deal" -> dispatches `show deal acme`; no deals in stub,
    // so it lands on the (empty) deal picker instead of asking again
    const a = await handleMessage(s, "1");
    expect(a.text).not.toContain("Did you mean:");
    expect(s.choice?.kind).toBe("deal");
  });
  test("disambiguation result is deterministic", () => {
    const a = parseIntentFuzzy("tell me about acme");
    const b = parseIntentFuzzy("tell me about acme");
    expect(a.name).toBe("disambiguate_intent");
    expect(a.slots.options).toBe(b.slots.options);
  });
});

describe("fuzzy determinism and timing", () => {
  test("same input always yields the same intent", () => {
    for (const [input] of CORPUS.slice(0, 40)) {
      expect(parseIntentFuzzy(input).name).toBe(parseIntentFuzzy(input).name);
    }
  });
  test("adversarial long input completes quickly", () => {
    const long = Array(200).fill("deal").join(" ");
    const t0 = Date.now();
    const r = parseIntentFuzzy(long);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.name).not.toBe("unknown");
  });
  test("filler flood cannot push the command past the token cap", () => {
    const flood = Array(100).fill("please").join(" ") + " show deals";
    expect(parseIntentFuzzy(flood).name).toBe("deals");
  });
});

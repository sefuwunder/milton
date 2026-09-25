// symspell.test.ts — the SymSpell symmetric-delete engine and the three
// features built on it: typo-tolerant intent matching, glued-word recovery,
// and the entity-name typo tier.
//
// The engine consolidation (fuzzy.ts bestToken, commands.ts suggestCommands)
// is pinned by a 1,872-input behavioral snapshot with zero differences from
// the pre-SymSpell implementation; these tests pin the NEW behavior.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { deletesOf, buildSymSpellIndex } from "../src/symspell";
import { parseIntentFuzzy } from "../src/fuzzy";
import { suggestCommands } from "../src/commands";
import { matchByName } from "../src/crm";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); initDealNotesDb(new Database(":memory:")); });

describe("symspell engine", () => {
  test("deletesOf enumerates every deletion variant, deduplicated", () => {
    const d = deletesOf("abc", 2);
    for (const w of ["a", "b", "c", "ab", "ac", "bc"]) expect(d.has(w)).toBe(true);
    expect(d.has("")).toBe(false); // 3 deletions away: beyond maxEdit
    expect(deletesOf("abc", 1).has("a")).toBe(false); // maxEdit=1: only 1-deletion variants
    expect(d.has("abc")).toBe(false); // the word itself is stored separately
    expect(d.has("abcd")).toBe(false);
  });

  test("delete index finds a 1-edit neighbor through a shared variant", () => {
    const idx = buildSymSpellIndex(["apple", "zebra"], 2);
    const hits = idx.lookup("aple", () => 2);
    const words = hits.map((h) => h.word);
    expect(words).toContain("apple");
    expect(words).not.toContain("zebra");
  });

  test("lookup verifies with the caller's accept and reports its distance", () => {
    const idx = buildSymSpellIndex(["overdue"], 2);
    const hits = idx.lookup("ovedrue", (w) => (w === "overdue" ? 2 : null));
    expect(hits).toEqual([{ word: "overdue", d: 2 }]); // adjacent transposition = 2 plain edits
  });

  test("accept returning null rejects the candidate", () => {
    const idx = buildSymSpellIndex(["apple"], 2);
    expect(idx.lookup("aple", () => null)).toEqual([]);
  });

  test("deterministic order: distance first, then word", () => {
    const idx = buildSymSpellIndex(["abcx", "abc", "abcxx"], 2);
    const hits = idx.lookup("abc", () => 2);
    const ds = hits.map((h) => h.d);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
    // same-distance ties break alphabetically
    const tie = idx.lookup("abq", (w) => (w.startsWith("abc") ? 2 : null));
    const tieWords = tie.filter((h) => h.d === 1).map((h) => h.word);
    expect([...tieWords].sort()).toEqual(tieWords);
  });

  test("empty query and empty index are safe", () => {
    const idx = buildSymSpellIndex(["apple"], 2);
    expect(idx.lookup("", () => 2)).toEqual([]);
    expect(buildSymSpellIndex([], 2).lookup("apple", () => 2)).toEqual([]);
  });

  test("duplicate dictionary words collapse to one entry", () => {
    const idx = buildSymSpellIndex(["apple", "apple"], 2);
    expect(idx.lookup("aple", () => 2).filter((h) => h.word === "apple")).toHaveLength(1);
  });
});

describe("glued-word recovery", () => {
  test("showdeals parses as deals", () => {
    const r: any = parseIntentFuzzy("showdeals");
    expect(r.name).toBe("deals");
    expect(r.fuzzy).toBe(true);
  });

  test("addtask call bob parses as add_task", () => {
    const r: any = parseIntentFuzzy("addtask call bob");
    expect(r.name).toBe("add_task");
  });

  test("listtasks parses as tasks", () => {
    const r: any = parseIntentFuzzy("listtasks");
    expect(r.name).toBe("tasks");
  });

  test("glued words compose with slot content", () => {
    const r: any = parseIntentFuzzy("showdeals tomorrow");
    expect(r.name).not.toBe("unknown");
  });

  test("real words are never shredded: tomorrow stays unknown", () => {
    expect(parseIntentFuzzy("tomorrow").name).toBe("unknown");
  });

  test("real words are never shredded: discount stays unknown", () => {
    expect(parseIntentFuzzy("discount").name).toBe("unknown");
  });

  test("entity-like glue is never split: acmecorp stays unknown", () => {
    expect(parseIntentFuzzy("acmecorp").name).toBe("unknown");
  });

  test("splitting never reranks a successful classic parse", () => {
    // "show deals" already parses without the fallback; the fallback must
    // not change it.
    const r: any = parseIntentFuzzy("show deals");
    expect(r.name).toBe("deals");
  });
});

describe("entity-name typo tier", () => {
  const items = [
    { id: 1, name: "Acme Corp" },
    { id: 2, name: "Bacmee Ltd" },
    { id: 3, name: "Tom Reyes" },
  ];

  test("Acmee finds Acme Corp at the typo tier, ranked first", () => {
    const ms = matchByName(items, "Acmee");
    expect(ms[0].item.name).toBe("Acme Corp");
    expect(ms[0].score).toBe(60);
  });

  test("Tom Reeys finds Tom Reyes at the typo tier", () => {
    const ms = matchByName(items, "Tom Reeys");
    expect(ms[0].item.name).toBe("Tom Reyes");
    expect(ms[0].score).toBe(60);
  });

  test("a typo match never promotes unrelated items", () => {
    const ms = matchByName(items, "Acmee");
    expect(ms.find((m) => m.item.name === "Tom Reyes")).toBeUndefined();
  });

  test("exact and prefix matches still outrank the typo tier", () => {
    const ms = matchByName(items, "Acme Corp");
    expect(ms[0]).toMatchObject({ score: 100 });
    expect(ms[0].item.name).toBe("Acme Corp");
    const ms2 = matchByName(items, "acm");
    expect(ms2[0].item.name).toBe("Acme Corp");
    expect(ms2[0].score).toBeGreaterThan(60);
  });

  test("typo tier outranks substring", () => {
    const ms = matchByName(items, "Acme");
    const bacmee = ms.find((m) => m.item.name === "Bacmee Ltd")!;
    expect(bacmee.score).toBe(60); // typo, not the old substring 50
  });

  test("token order does not matter: Reyes Tom matches", () => {
    const ms = matchByName(items, "Reyes Tom");
    expect(ms[0].item.name).toBe("Tom Reyes");
    expect(ms[0].score).toBe(60);
  });

  test("gibberish matches nothing", () => {
    expect(matchByName(items, "Zzz Qqq")).toEqual([]);
  });
});

describe("suggestCommands consolidation (regression pins)", () => {
  test("typo'd input still suggests the right command first", () => {
    expect(suggestCommands("ad tsk")[0].name).toBe("add_task");
    expect(suggestCommands("shwo dela")[0].name).toBe("deal_detail");
    expect(suggestCommands("meridian enrich acme")[0].name).toBe("meridian_enrich");
  });

  test("gibberish suggests nothing", () => {
    expect(suggestCommands("xyzzy")).toEqual([]);
  });
});

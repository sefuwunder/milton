// intent_misses.test.ts — local intent-miss log: logging, dedupe, listing,
// review, dismissal, and the needDb() guard.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initMissLogDb,
  logMiss,
  listMisses,
  countUnreviewed,
  markReviewed,
  dismissMiss,
  type Miss,
} from "../src/intent_misses";

// NOTE: must be top-level — an afterAll/beforeAll nested inside another hook
// fires at the wrong time in bun test.
beforeAll(() => { initMissLogDb(new Database(":memory:")); });

describe("logMiss", () => {
  test("logs a row with all fields populated", () => {
    const m = logMiss("  what is the meaning of pipeline?  ", "sess-a", "pipeline_question") as Miss;
    expect(m).not.toBeNull();
    expect(m.id).toBeGreaterThan(0);
    expect(m.utterance).toBe("what is the meaning of pipeline?");
    expect(m.session_id).toBe("sess-a");
    expect(m.guess).toBe("pipeline_question");
    expect(m.reviewed).toBe(0);
    expect(typeof m.at).toBe("string");
    expect(m.at.length).toBeGreaterThan(0);
  });

  test("guess defaults to null when omitted", () => {
    const m = logMiss("blorp snafu wobble", "sess-a") as Miss;
    expect(m.guess).toBeNull();
  });

  test("empty and whitespace-only utterances return null", () => {
    expect(logMiss("", "sess-a")).toBeNull();
    expect(logMiss("   \n\t  ", "sess-a")).toBeNull();
  });

  test("trims and slices utterance to 1000 chars", () => {
    const long = "x".repeat(1500);
    const m = logMiss(long, "sess-a") as Miss;
    expect(m.utterance).toBe("x".repeat(1000));
  });

  test("dedupe: same session+utterance twice -> second returns null", () => {
    const first = logMiss("turn off the fridge lights", "sess-dupe");
    expect(first).not.toBeNull();
    expect(logMiss("turn off the fridge lights", "sess-dupe")).toBeNull();
    // whitespace variants hit the same dedupe key
    expect(logMiss("  turn off the fridge lights  ", "sess-dupe")).toBeNull();
    expect(countUnreviewed()).toBeGreaterThanOrEqual(1);
  });

  test("same utterance in a different session logs fine", () => {
    expect(logMiss("turn off the fridge lights", "sess-other")).not.toBeNull();
  });

  test("same utterance re-logs after being reviewed", () => {
    const m = logMiss("relog me please", "sess-relog") as Miss;
    expect(markReviewed(m.id)).toBe(true);
    const again = logMiss("relog me please", "sess-relog") as Miss;
    expect(again).not.toBeNull();
    expect(again.id).toBeGreaterThan(m.id);
    // reviewed rows don't block dedupe (only unreviewed do) — covered above
  });

});

describe("24h dedupe window (fresh db)", () => {
  test("an unreviewed row older than 24h is not a dupe", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    d.exec("INSERT INTO intent_misses (utterance, session_id, guess, at) VALUES ('ancient one', 's', NULL, datetime('now', '-25 hours'))");
    const m = logMiss("ancient one", "s");
    expect(m).not.toBeNull();
    expect(countUnreviewed()).toBe(2);
    // and an unreviewed row from right now still blocks
    expect(logMiss("ancient one", "s")).toBeNull();
  });
});

describe("listMisses", () => {
  test("newest first, default unreviewedOnly, default limit 20", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    for (let i = 1; i <= 25; i++) logMiss(`miss ${i}`, "sess-list");
    const all = listMisses();
    expect(all).toHaveLength(20);
    expect(all[0].utterance).toBe("miss 25");
    expect(all[19].utterance).toBe("miss 6");
    // ids descending = newest first
    for (let i = 1; i < all.length; i++) expect(all[i - 1].id).toBeGreaterThan(all[i].id);
  });

  test("limit is honored", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    for (let i = 1; i <= 5; i++) logMiss(`item ${i}`, "sess-lim");
    expect(listMisses({ limit: 3 })).toHaveLength(3);
    expect(listMisses({ limit: 100 })).toHaveLength(5);
  });

  test("unreviewedOnly:false includes reviewed rows", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    const a = logMiss("alpha miss", "sess-f") as Miss;
    logMiss("beta miss", "sess-f");
    markReviewed(a.id);
    const unrev = listMisses({ unreviewedOnly: true });
    expect(unrev).toHaveLength(1);
    expect(unrev[0].utterance).toBe("beta miss");
    const both = listMisses({ unreviewedOnly: false });
    expect(both).toHaveLength(2);
    expect(both[0].utterance).toBe("beta miss"); // still newest first
  });
});

describe("markReviewed / dismissMiss / countUnreviewed", () => {
  test("markReviewed flips the flag and drops it from the unreviewed list", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    const m = logMiss("review me", "sess-r") as Miss;
    expect(countUnreviewed()).toBe(1);
    expect(markReviewed(m.id)).toBe(true);
    const row = listMisses({ unreviewedOnly: false })[0];
    expect(row.reviewed).toBe(1);
    expect(listMisses()).toHaveLength(0);
    expect(countUnreviewed()).toBe(0);
  });

  test("markReviewed on a missing id returns false", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    expect(markReviewed(9999)).toBe(false);
  });

  test("dismissMiss hard-deletes the row", () => {
    const d = new Database(":memory:");
    initMissLogDb(d);
    const m = logMiss("dismiss me", "sess-d") as Miss;
    expect(dismissMiss(m.id)).toBe(true);
    expect(listMisses({ unreviewedOnly: false })).toHaveLength(0);
    expect(countUnreviewed()).toBe(0);
    expect(dismissMiss(m.id)).toBe(false);
  });
});

describe("needDb guard", () => {
  test("throws before initMissLogDb", () => {
    // fresh module state is impossible per-file, so simulate by loading a
    // second copy of the module in a worker-free way: import with a query
    // string forces bun to re-evaluate the module with db === null.
    return import(`../src/intent_misses?guard=${Date.now()}`).then((mod: any) => {
      expect(() => mod.logMiss("hello", "s")).toThrow(/not initialized/);
      expect(() => mod.listMisses()).toThrow(/not initialized/);
      expect(() => mod.countUnreviewed()).toThrow(/not initialized/);
      expect(() => mod.markReviewed(1)).toThrow(/not initialized/);
      expect(() => mod.dismissMiss(1)).toThrow(/not initialized/);
    });
  });
});

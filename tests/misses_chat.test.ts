// misses_chat.test.ts — intent-miss log wired through chat: unknown utterances
// are logged, "show misses" lists them, review/dismiss work, and the morning
// brief surfaces the unreviewed count.
//
// Test-hygiene notes (see ~/AGENTS.md): every store this file touches is
// initialized in its own top-level beforeAll; the fetch stub is installed in
// beforeEach and restored in afterEach so nothing leaks into files that run
// later; LLM env is scrubbed because llm.test.ts sets MILTON_LLM_URL at module
// scope and runs before this file alphabetically.
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleMessage, type Session } from "../src/brain";
import * as auto from "../src/automation";
import { initDealNotesDb } from "../src/deal_notes";
import { initMissLogDb, listMisses, countUnreviewed } from "../src/intent_misses";

delete process.env.MILTON_LLM_URL;
delete process.env.MILTON_LLM_MODEL;
delete process.env.MILTON_LLM_KEY;

beforeAll(() => {
  auto.initAutomationDb(new Database(":memory:"));
  initDealNotesDb(new Database(":memory:"));
  initMissLogDb(new Database(":memory:"));
});

const realFetch = (globalThis as any).fetch;
function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
  const path = url.replace("http://localhost:3001", "").split("?")[0];
  const ok = (data: any) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  if (path === "/api/deals") return ok({ deals: [] });
  if (path === "/api/tasks") return ok({ tasks: [] });
  if (path === "/api/activities") return ok({ activities: [] });
  if (path === "/api/contacts") return ok({ contacts: [] });
  return ok({});
}
beforeEach(() => { (globalThis as any).fetch = stubFetch; });
afterEach(() => { (globalThis as any).fetch = realFetch; });

function freshSession(id = "miss-test"): Session { return { id, history: [] }; }

describe("intent misses via chat", () => {
  test("unknown utterance is logged locally", async () => {
    const before = countUnreviewed();
    const r = await handleMessage(freshSession(), "blorple wibble zzz");
    expect(r.text).toContain("not sure what you mean");
    expect(countUnreviewed()).toBe(before + 1);
    const rows = listMisses({ unreviewedOnly: true, limit: 5 });
    expect(rows[0].utterance).toBe("blorple wibble zzz");
    expect(rows[0].session_id).toBe("miss-test");
  });

  test("repeat of the same unknown utterance is deduped", async () => {
    const s = freshSession("dedupe-test");
    await handleMessage(s, "snorble fnord qux");
    const n = countUnreviewed();
    await handleMessage(s, "snorble fnord qux");
    expect(countUnreviewed()).toBe(n);
  });

  test("show misses lists unreviewed misses", async () => {
    await handleMessage(freshSession("list-test"), "wobble gobble unique-phrase-123");
    const r = await handleMessage(freshSession("list-test"), "show misses");
    expect(r.text).toContain("wobble gobble unique-phrase-123");
  });

  test("review miss marks it reviewed", async () => {
    const s = freshSession("review-test");
    await handleMessage(s, "zibble zabble review-me-456");
    const miss = listMisses({ unreviewedOnly: true, limit: 50 }).find((m) => m.utterance.includes("review-me-456"))!;
    const r = await handleMessage(s, `review miss ${miss.id}`);
    expect(r.text).toContain(`#${miss.id}`);
    expect(r.text).toMatch(/reviewed/i);
    expect(listMisses({ unreviewedOnly: true, limit: 50 }).some((m) => m.id === miss.id)).toBe(false);
  });

  test("dismiss miss deletes it", async () => {
    const s = freshSession("dismiss-test");
    await handleMessage(s, "frobnicator dismiss-me-789");
    const miss = listMisses({ unreviewedOnly: true, limit: 50 }).find((m) => m.utterance.includes("dismiss-me-789"))!;
    const r = await handleMessage(s, `dismiss miss ${miss.id}`);
    expect(r.text).toContain(`#${miss.id}`);
    expect(listMisses({ unreviewedOnly: false, limit: 200 }).some((m) => m.id === miss.id)).toBe(false);
  });

  test("morning brief surfaces the unreviewed count", async () => {
    await handleMessage(freshSession("brief-test"), "quux corge brief-count-000");
    const r = await handleMessage(freshSession("brief-test"), "morning brief");
    expect(r.text).toMatch(/unreviewed intent miss/);
    expect(r.text).toContain("show misses");
  });

  test("show misses when the queue is empty", async () => {
    // review everything left over from the tests above
    for (const m of listMisses({ unreviewedOnly: true, limit: 200 })) {
      await handleMessage(freshSession("cleanup"), `review miss ${m.id}`);
    }
    const r = await handleMessage(freshSession("cleanup"), "show misses");
    expect(r.text).toMatch(/no unreviewed misses/i);
  });
});

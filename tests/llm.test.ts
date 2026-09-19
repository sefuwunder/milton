// llm.test.ts — LLM-mode failure visibility: misconfigured models must surface
// in-chat instead of failing silently into the generic "not sure" fallback.
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { handleMessage, type Session } from "../src/brain";

const LLM_BASE = "http://localhost:11999/v1";
const SECRET = "sk-test-secret-do-not-leak-xyz";

// brain.ts reads LLM env at call time, so per-test configuration is safe.
process.env.MILTON_LLM_URL = LLM_BASE;
process.env.MILTON_LLM_MODEL = "qwen3.5:0.8b";
process.env.MILTON_LLM_KEY = SECRET;

const realFetch = globalThis.fetch.bind(globalThis);

// canned LLM behavior, swapped per test
let llmBehavior: "ok" | "404" | "refused" = "ok";
let lastAuthHeader: string | null = null;

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (url.startsWith(LLM_BASE)) {
    const headers = new Headers(init.headers || {});
    lastAuthHeader = headers.get("authorization");
    if (llmBehavior === "404") {
      return Promise.resolve(new Response(
        JSON.stringify({ error: "model 'qwen3.5:0.8b' not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ));
    }
    if (llmBehavior === "refused") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(new Response(
      JSON.stringify({ choices: [{ message: { content: "Here's the freeform answer." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  }
  // minimal exec-crm stubs (llmReply reads a CRM snapshot first)
  if (url.startsWith("http://localhost:3001")) {
    const path = url.replace("http://localhost:3001", "");
    const ok = (d: any) => Promise.resolve(new Response(JSON.stringify(d), { status: 200 }));
    if (path === "/api/deals") return ok({ deals: [] });
    if (path === "/api/tasks") return ok({ tasks: [] });
    if (path === "/api/contacts") return ok({ contacts: [] });
    return ok({});
  }
  return realFetch(input, init);
}
(globalThis as any).fetch = stubFetch;

afterAll(() => {
  delete process.env.MILTON_LLM_URL;
  delete process.env.MILTON_LLM_MODEL;
  delete process.env.MILTON_LLM_KEY;
});

function freshSession(): Session { return { id: "llm-test", history: [] }; }
beforeEach(() => { llmBehavior = "ok"; lastAuthHeader = null; });

describe("LLM failure visibility", () => {
  test("model-not-found 404 surfaces status + provider message + ollama hint", async () => {
    llmBehavior = "404";
    const r = await handleMessage(freshSession(), "xyzzy plugh");
    expect(r.text).toContain("404");
    expect(r.text).toContain("model 'qwen3.5:0.8b' not found");
    expect(r.text).toContain("localhost:11999/v1/chat/completions");
    expect(r.text).toContain("ollama list");
    expect(r.text).not.toContain("I'm not sure what you mean");
  });

  test("connection refused surfaces the failure, not the generic fallback", async () => {
    llmBehavior = "refused";
    const r = await handleMessage(freshSession(), "xyzzy plugh");
    expect(r.text).toContain("couldn't reach the language model");
    expect(r.text).toContain("localhost:11999/v1/chat/completions");
    expect(r.text).toContain("fetch failed");
    expect(r.text).not.toContain("I'm not sure what you mean");
  });

  test("API key is sent to the provider but never appears in the surfaced error", async () => {
    llmBehavior = "404";
    const r = await handleMessage(freshSession(), "xyzzy plugh");
    expect(lastAuthHeader).toBe(`Bearer ${SECRET}`); // key is actually used
    expect(r.text).not.toContain(SECRET);
    llmBehavior = "refused";
    const r2 = await handleMessage(freshSession(), "xyzzy plugh");
    expect(r2.text).not.toContain(SECRET);
  });

  test("successful LLM call still answers in freeform mode", async () => {
    llmBehavior = "ok";
    const r = await handleMessage(freshSession(), "xyzzy plugh");
    expect(r.text).toBe("Here's the freeform answer.");
  });

  test("no LLM configured → generic fallback, no error noise", async () => {
    delete process.env.MILTON_LLM_URL;
    try {
      const r = await handleMessage(freshSession(), "xyzzy plugh");
      expect(r.text).toContain("I'm not sure what you mean");
      expect(r.text).not.toContain("language model");
    } finally {
      process.env.MILTON_LLM_URL = LLM_BASE;
    }
  });
});

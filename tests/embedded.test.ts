// embedded.test.ts — self-contained mode: asset discovery, MILTON_EMBEDDED=1 vs
// auto-detect logic, spawn-arg construction, model labels, and a boot smoke
// test against a stub llama-server (a tiny executable bun script).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findEmbeddedAssets, embeddedDecision, buildServerArgs, modelLabel, startEmbedded } from "../src/embedded";
import * as an from "../src/analyst";

const ENV_KEYS = ["MILTON_EMBEDDED", "MILTON_LLM_URL"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  an.setEmbeddedEndpoint(null);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  an.setEmbeddedEndpoint(null);
});

function makeModelDir(withBin = true, withGguf = true): string {
  const dir = mkdtempSync(join(tmpdir(), "milton-models-"));
  if (withGguf) writeFileSync(join(dir, "Qwen3-0.6B-Q4_K_M.gguf"), "fake-gguf");
  if (withBin) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "llama-server"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "llama-server"), 0o755);
  }
  return dir;
}

describe("findEmbeddedAssets", () => {
  test("finds gguf + binary", () => {
    const dir = makeModelDir();
    const plan = findEmbeddedAssets(dir);
    expect(plan).not.toBeNull();
    expect(plan!.gguf).toBe(join(dir, "Qwen3-0.6B-Q4_K_M.gguf"));
    expect(plan!.binary).toBe(join(dir, "bin", "llama-server"));
  });
  test("missing binary -> null", () => {
    expect(findEmbeddedAssets(makeModelDir(false, true))).toBeNull();
  });
  test("missing gguf -> null", () => {
    expect(findEmbeddedAssets(makeModelDir(true, false))).toBeNull();
  });
  test("missing dir -> null", () => {
    expect(findEmbeddedAssets(join(tmpdir(), "milton-no-such-dir-xyz"))).toBeNull();
  });
});

describe("embeddedDecision", () => {
  test("MILTON_EMBEDDED=1 with assets -> plan", () => {
    process.env.MILTON_EMBEDDED = "1";
    expect(embeddedDecision(makeModelDir())).not.toBeNull();
  });
  test("MILTON_EMBEDDED=1 without assets -> clean error", () => {
    process.env.MILTON_EMBEDDED = "1";
    expect(() => embeddedDecision(makeModelDir(false, false))).toThrow(/get-model\.sh/);
  });
  test("MILTON_EMBEDDED=1 beats an explicit MILTON_LLM_URL", () => {
    process.env.MILTON_EMBEDDED = "1";
    process.env.MILTON_LLM_URL = "http://ollama:11434/v1";
    expect(embeddedDecision(makeModelDir())).not.toBeNull();
  });
  test("auto-detect: assets + no MILTON_LLM_URL -> plan", () => {
    expect(embeddedDecision(makeModelDir())).not.toBeNull();
  });
  test("auto-detect: explicit MILTON_LLM_URL wins -> null", () => {
    process.env.MILTON_LLM_URL = "http://ollama:11434/v1";
    expect(embeddedDecision(makeModelDir())).toBeNull();
  });
  test("no assets -> null", () => {
    expect(embeddedDecision(makeModelDir(false, false))).toBeNull();
  });
});

describe("buildServerArgs + modelLabel", () => {
  test("argv shape", () => {
    const args = buildServerArgs({ gguf: "/m/x.gguf", binary: "/m/bin/llama-server", modelDir: "/m" }, 4321);
    expect(args).toEqual(["/m/bin/llama-server", "-m", "/m/x.gguf", "--host", "127.0.0.1", "--port", "4321"]);
  });
  test("model labels", () => {
    expect(modelLabel("/m/Qwen3-0.6B-Q4_K_M.gguf")).toBe("qwen3-0.6b");
    expect(modelLabel("/m/llama-3.2-1b-f16.gguf")).toBe("llama-3.2-1b");
  });
});

describe("boot smoke against a stub llama-server", () => {
  const stubScript = `#!/usr/bin/env bun
const portIdx = process.argv.indexOf("--port");
const port = Number(process.argv[portIdx + 1]);
Bun.serve({
  port, hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return new Response("ok");
    if (u.pathname === "/v1/chat/completions" && req.method === "POST")
      return Response.json({ choices: [{ message: { content: "- stub insight from sidecar" } }] });
    return new Response("nf", { status: 404 });
  },
});
`;

  test("startEmbedded polls /health, routes LLM traffic, and reaps the child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milton-embed-"));
    writeFileSync(join(dir, "Qwen3-0.6B-Q4_K_M.gguf"), "fake-gguf");
    mkdirSync(join(dir, "bin"), { recursive: true });
    const stubPath = join(dir, "bin", "llama-server");
    writeFileSync(stubPath, stubScript);
    chmodSync(stubPath, 0o755);

    process.env.MILTON_EMBEDDED = "1";
    const plan = embeddedDecision(dir);
    expect(plan).not.toBeNull();

    let srv: Awaited<ReturnType<typeof startEmbedded>> | null = null;
    try {
      srv = await startEmbedded(plan!, { healthTimeoutMs: 15000, pollMs: 100 });
      expect(srv.label).toBe("qwen3-0.6b");
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      // resolution order: embedded endpoint is active
      expect(an.llmEndpointBase()).toBe(srv.url);

      // analyst routes through the embedded endpoint
      const r = await an.askAnalyst({ system: "s", facts: "f" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toContain("stub insight from sidecar");

      // chat freeform also routes through it (unknown input -> llmReply)
      const { handleMessage } = await import("../src/brain");
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: any, init: any = {}) => {
        const url = String(input);
        if (url.startsWith("http://localhost:3001")) {
          const path = url.slice("http://localhost:3001".length).split("?")[0];
          if (path === "/api/deals") return new Response(JSON.stringify({ deals: [] }), { headers: { "Content-Type": "application/json" } });
          return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
        }
        return realFetch(input, init);
      };
      try {
        const reply = await handleMessage({ id: "embed-chat", history: [], notes: [], workspaceId: null }, "zzq some unknown request");
        expect(reply.text).toContain("stub insight from sidecar");
      } finally {
        (globalThis as any).fetch = realFetch;
      }
    } finally {
      srv?.stop();
    }

    // after stop: endpoint cleared and child reaped
    expect(an.llmEndpointBase()).toBe("");
    const healthUrl = srv!.url.replace(/\/v1$/, "/health");
    let dead = false;
    for (let i = 0; i < 30 && !dead; i++) {
      try { await fetch(healthUrl, { signal: AbortSignal.timeout(1000) }); }
      catch { dead = true; }
      if (!dead) await Bun.sleep(200);
    }
    expect(dead).toBe(true);
  }, 30000);
});

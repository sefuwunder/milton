// embedded.ts — self-contained mode: run a small GGUF model via a llama.cpp
// `llama-server` sidecar. Zero npm deps: the binary and model are fetched by
// scripts/get-model.sh into gitignored models/ and spawned as a child process.
//
// Endpoint resolution order (documented in README):
//   embedded sidecar (when active) -> MILTON_LLM_URL -> none (deterministic only)

import { readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { setEmbeddedEndpoint } from "./analyst";

export interface EmbeddedPlan { gguf: string; binary: string; modelDir: string }

/** Locate sidecar assets: the first models/*.gguf (sorted) plus
 *  models/bin/llama-server[.exe]. Returns null when either is missing. */
export function findEmbeddedAssets(modelDir = "models"): EmbeddedPlan | null {
  let files: string[];
  try {
    files = readdirSync(modelDir).filter((f) => f.toLowerCase().endsWith(".gguf")).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const binary = join(modelDir, "bin", exe);
  if (!existsSync(binary)) return null;
  return { gguf: join(modelDir, files[0]), binary, modelDir };
}

/** Decide whether to start the embedded sidecar.
 *  - MILTON_EMBEDDED=1 forces it; throws a clean Error when assets are missing.
 *  - Otherwise auto-detect: start it only when assets exist AND no MILTON_LLM_URL
 *    is set (an explicit endpoint always wins over auto-detect).
 *  Returns the asset plan, or null for external/none mode. */
export function embeddedDecision(modelDir = "models"): EmbeddedPlan | null {
  const forced = process.env.MILTON_EMBEDDED === "1";
  const plan = findEmbeddedAssets(modelDir);
  if (forced && !plan) {
    throw new Error(
      "MILTON_EMBEDDED=1 but no model assets found — run scripts/get-model.sh first " +
      "(it installs models/bin/llama-server and a models/*.gguf)."
    );
  }
  if (forced) return plan;
  if ((process.env.MILTON_LLM_URL || "").trim()) return null;
  return plan;
}

/** Human label for the log line, e.g. "Qwen3-0.6B-Q4_K_M.gguf" -> "qwen3-0.6b". */
export function modelLabel(ggufPath: string): string {
  const base = basename(ggufPath).replace(/\.gguf$/i, "");
  return base.replace(/[-_](q\d+(_[a-z0-9]+)*|f16|f32|q8_0|iq\d+(_[a-z0-9]+)*)$/i, "").toLowerCase() || base.toLowerCase();
}

/** argv for the sidecar: binary first, then flags. Exported for tests. */
export function buildServerArgs(plan: EmbeddedPlan, port: number): string[] {
  return [plan.binary, "-m", plan.gguf, "--host", "127.0.0.1", "--port", String(port)];
}

async function freePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = srv.port;
  srv.stop(true);
  return port;
}

export interface EmbeddedServer {
  /** OpenAI-compatible base, e.g. http://127.0.0.1:48231/v1 */
  url: string;
  label: string;
  /** Kill the child and clear the endpoint override. Idempotent. */
  stop: () => void;
}

/** Spawn llama-server, wait for /health, and point all LLM traffic at it.
 *  Throws a clean Error when the binary exits early or never becomes healthy. */
export async function startEmbedded(
  plan: EmbeddedPlan, opts: { healthTimeoutMs?: number; pollMs?: number } = {}
): Promise<EmbeddedServer> {
  const port = await freePort();
  const args = buildServerArgs(plan, port);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  } catch (e: any) {
    throw new Error(`couldn't launch ${plan.binary}: ${e?.message || e} — re-run scripts/get-model.sh to fetch a matching binary.`);
  }
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const timeoutMs = opts.healthTimeoutMs ?? 120000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    setEmbeddedEndpoint(null);
    try { proc.kill(); } catch { /* already gone */ }
  };
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const code = proc.exitCode;
      stop();
      throw new Error(`llama-server exited during startup (code ${code}) — the binary may not match this platform; re-run scripts/get-model.sh.`);
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const url = `http://127.0.0.1:${port}/v1`;
        setEmbeddedEndpoint(url);
        return { url, label: modelLabel(plan.gguf), stop };
      }
    } catch { /* not up yet */ }
    await Bun.sleep(pollMs);
  }
  stop();
  throw new Error(`llama-server didn't become healthy within ${Math.round(timeoutMs / 1000)}s — the model may be too large for this machine's RAM.`);
}

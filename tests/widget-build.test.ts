// tests/widget-build.test.ts — the natural widget-making flow:
// "build a widget that ..." -> build_widget intent -> Milton drafts
// (deterministic template, or the local LLM) -> filed as a Phase 3 proposal.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseIntent } from "../src/intents";
import {
  validateWidgetDraft, matchTemplate, buildFromTemplate, templateExamples,
  draftWidgetViaLlm, type WidgetDraftSpec,
} from "../src/widget_draft";

describe("build_widget intent", () => {
  const cases: [string, string][] = [
    ["build a widget that shows stalled deals", "shows stalled deals"],
    ["make me a widget for overdue tasks", "overdue tasks"],
    ["create a widget with pipeline by stage", "pipeline by stage"],
    ["design me a widget for deals stuck 45 days in negotiation", "deals stuck 45 days in negotiation"],
    ["i want a widget that shows deals closing soon", "shows deals closing soon"],
    ["i'd like a widget for overdue tasks", "overdue tasks"],
    ["new widget", ""],
  ];
  for (const [text, desc] of cases) {
    test(`parses "${text}"`, () => {
      const i = parseIntent(text);
      expect(i.name).toBe("build_widget");
      expect(i.slots.description).toBe(desc);
    });
  }
  test("does not steal pin_widget", () => {
    expect(parseIntent("pin this as a widget").name).toBe("pin_widget");
    expect(parseIntent("add widget").name).toBe("pin_widget");
  });
});

describe("template matching", () => {
  test("each template produces a valid spec", () => {
    const descs = ["stalled deals", "deals stuck 45 days in negotiation", "overdue tasks",
      "pipeline by stage", "deals closing soon", "deals closing in 3 weeks"];
    for (const d of descs) {
      const t = matchTemplate(d);
      expect(t).not.toBeNull();
      const spec = buildFromTemplate(t!.template, t!.params);
      const v = validateWidgetDraft(spec);
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
    }
  });
  test("stalled extracts days and stage", () => {
    const t = matchTemplate("deals stuck 45 days in negotiation")!;
    expect(t.params.days).toBe(45);
    expect(t.params.stage).toBe("negotiation");
    const spec = buildFromTemplate(t.template, t.params);
    expect(spec.js).toContain('"days":45');
    expect(spec.js).toContain('"stage":"negotiation"');
    expect(spec.manifest.permissions).toEqual(["deals:read"]);
  });
  test("non-widget descriptions match nothing", () => {
    expect(matchTemplate("what is the weather")).toBeNull();
    expect(matchTemplate("show my pipeline")).toBeNull();
  });
  test("templateExamples are all parseable", () => {
    for (const e of templateExamples()) {
      expect(parseIntent(`build ${e}`).name).toBe("build_widget");
      expect(matchTemplate(e)).not.toBeNull();
    }
  });
});

describe("validateWidgetDraft", () => {
  const good = (): WidgetDraftSpec => ({
    title: "T", rationale: "why",
    manifest: { name: "my-widget", title: "T", version: "1.0.0", mount: "dashboard", permissions: ["deals:read"] },
    js: "document.getElementById('wroot').textContent='hi';",
  });
  test("accepts a good spec", () => {
    expect(validateWidgetDraft(good()).ok).toBe(true);
  });
  test("rejects bad manifest fields", () => {
    for (const mutate of [
      (s: any) => { s.manifest.name = "Bad Name!"; },
      (s: any) => { s.manifest.version = "1.0"; },
      (s: any) => { s.manifest.mount = "sidebar"; },
      (s: any) => { s.manifest.permissions = ["teleport:write"]; },
      (s: any) => { s.manifest.permissions = []; },
    ]) {
      const s = good(); mutate(s);
      expect(validateWidgetDraft(s).ok).toBe(false);
    }
  });
  test("rejects script-breakout and network primitives", () => {
    for (const js of [
      "var a = '</SCRIPT>';",
      "fetch('/x').then()",
      "new XMLHttpRequest()",
      "new WebSocket('ws://x')",
    ]) {
      const s = good(); s.js = js;
      expect(validateWidgetDraft(s).errors.length).toBeGreaterThan(0);
    }
  });
  test("rejects oversized bundles", () => {
    const s = good(); s.js = "x".repeat(256 * 1024 + 1);
    expect(validateWidgetDraft(s).ok).toBe(false);
  });
});

describe("draftWidgetViaLlm", () => {
  const draft = {
    title: "Big Deals", rationale: "see the whales",
    manifest: { name: "big-deals", title: "Big Deals", version: "1.0.0", mount: "dashboard", permissions: ["deals:read"] },
    js: "document.getElementById('wroot').textContent='big';",
  };
  const stubFetch = (body: any, ok = true, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  test("accepts a valid JSON draft", async () => {
    const r = await draftWidgetViaLlm("big deals", {
      endpoint: "http://x/v1", model: "m",
      fetchImpl: stubFetch({ choices: [{ message: { content: JSON.stringify(draft) } }] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.title).toBe("Big Deals");
  });
  test("strips code fences", async () => {
    const r = await draftWidgetViaLlm("big deals", {
      endpoint: "http://x/v1", model: "m",
      fetchImpl: stubFetch({ choices: [{ message: { content: "```json\n" + JSON.stringify(draft) + "\n```" } }] }),
    });
    expect(r.ok).toBe(true);
  });
  test("rejects invalid JSON", async () => {
    const r = await draftWidgetViaLlm("big deals", {
      endpoint: "http://x/v1", model: "m",
      fetchImpl: stubFetch({ choices: [{ message: { content: "here is your widget!!!" } }] }),
    });
    expect(r.ok).toBe(false);
  });
  test("rejects a draft that fails validation", async () => {
    const bad = { ...draft, manifest: { ...draft.manifest, permissions: ["mind:read"] } };
    const r = await draftWidgetViaLlm("big deals", {
      endpoint: "http://x/v1", model: "m",
      fetchImpl: stubFetch({ choices: [{ message: { content: JSON.stringify(bad) } }] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/validation/);
  });
  test("surfaces provider errors", async () => {
    const r = await draftWidgetViaLlm("big deals", {
      endpoint: "http://x/v1", model: "m",
      fetchImpl: stubFetch({ error: "model exploded" }, false, 500),
    });
    expect(r.ok).toBe(false);
  });
});

// ---- end-to-end: chat -> template draft -> stubbed exec-crm proposal inbox ----
const root = new URL("..", import.meta.url).pathname;
let received: any[] = [];
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/widget-proposals" && req.method === "POST") {
      const body = await req.json();
      received.push(body);
      return Response.json({ proposal: { id: 3, kind: body.kind, title: body.title, status: "pending" } }, { status: 201 });
    }
    return Response.json({});
  },
});

let dir = "";
let proc: any = null;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "milton-build-widget-"));
  const env: Record<string, string> = { ...process.env } as any;
  delete env.MILTON_LLM_URL; // deterministic path only
  proc = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: root,
    env: { ...env, MILTON_DATA: dir, PORT: "0", EXEC_CRM_URL: `http://localhost:${stub.port}` },
    stdout: "pipe", stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/milton listening on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; break; }
    }
    if (done) break;
  }
  reader.releaseLock();
  if (!base) throw new Error("widget-build test server did not start. output: " + buf.slice(-800));
});

afterAll(async () => {
  try { proc?.kill(); } catch {}
  stub.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("chat end-to-end", () => {
  test("template request files a proposal", async () => {
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "e2e-build", message: "build a widget for overdue tasks" }),
    });
    const j: any = await r.json();
    expect(j.text).toMatch(/Drafted “Overdue Tasks”/);
    expect(j.text).toMatch(/filed it as a proposal/);
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("widget");
    expect(received[0].title).toBe("Overdue Tasks");
    expect(received[0].manifest.permissions).toEqual(["tasks:read"]);
    expect(typeof received[0].js).toBe("string");
  });
  test("freeform request without LLM explains the options", async () => {
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "e2e-build", message: "build a widget that predicts the weather" }),
    });
    const j: any = await r.json();
    expect(j.text).toMatch(/MILTON_LLM_URL/);
    expect(received.length).toBe(1); // no new proposal filed
  });
  test("bare request asks what the widget should do", async () => {
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "e2e-build", message: "new widget" }),
    });
    const j: any = await r.json();
    expect(j.text).toMatch(/What should the widget do/);
    expect((j.chips || []).length).toBeGreaterThan(0);
  });
});

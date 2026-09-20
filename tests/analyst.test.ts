// analyst.test.ts — small-LLM analyst & planner: intent parsing, deterministic
// stats math, LLM-available vs unreachable paths, break-down confirmation flow,
// unattended skip, and the NO_PROXY/timeout hardening.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initAutomationDb } from "../src/automation";
import { parseIntent } from "../src/intents";
import * as an from "../src/analyst";
import { handleMessage, runRoutineUnattended, type Session } from "../src/brain";

const sess = (id = "analyst-test"): Session => ({ id, history: [], notes: [], workspaceId: null });

const dstr = (offsetDays: number): string => {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
};
const todayStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const stubStages = [
  { slug: "prospecting", name: "Prospecting", position: 0, color: "#888" },
  { slug: "qualification", name: "Qualification", position: 1, color: "#888" },
  { slug: "proposal", name: "Proposal", position: 2, color: "#888" },
  { slug: "negotiation", name: "Negotiation", position: 3, color: "#888" },
  { slug: "closed_won", name: "Closed won", position: 4, color: "#888" },
  { slug: "closed_lost", name: "Closed lost", position: 5, color: "#888" },
];
const stubCampaigns = [
  { id: 1, name: "Q4 Launch" },
  { id: 2, name: "Beta Test" },
];
const stubDeals = [
  { id: 1, title: "Acme pilot", company_id: 1, contact_id: 1, campaign_id: 1, value: 120000, stage: "negotiation", probability: 60, expected_close: dstr(3).slice(0, 10), owner: "", created_at: "", updated_at: dstr(-45) },
  { id: 2, title: "Acme expansion", company_id: 1, contact_id: null, campaign_id: 1, value: 60000, stage: "proposal", probability: 0, expected_close: dstr(20).slice(0, 10), owner: "", created_at: "", updated_at: dstr(-2) },
  { id: 3, title: "Globex rollout", company_id: 2, contact_id: 2, campaign_id: 2, value: 30000, stage: "qualification", probability: 0, expected_close: "", owner: "", created_at: "", updated_at: dstr(-10) },
  { id: 4, title: "Won deal", company_id: null, contact_id: null, campaign_id: null, value: 50000, stage: "closed_won", probability: 100, expected_close: "", owner: "", created_at: "", updated_at: dstr(-40) },
  { id: 5, title: "Lost deal", company_id: null, contact_id: null, campaign_id: null, value: 20000, stage: "closed_lost", probability: 0, expected_close: "", owner: "", created_at: "", updated_at: dstr(-50) },
  { id: 6, title: "Old prospect", company_id: null, contact_id: null, campaign_id: null, value: 10000, stage: "prospecting", probability: 0, expected_close: "", owner: "", created_at: "", updated_at: dstr(-60) },
];
const stubTasks = [
  { id: 1, title: "Call Acme", deal_id: null, campaign_id: null, due_date: dstr(-2).slice(0, 10), done: 0, owner: "", created_at: "" },
  { id: 2, title: "Send proposal", deal_id: null, campaign_id: null, due_date: todayStr(), done: 0, owner: "", created_at: "" },
  { id: 3, title: "Prep demo", deal_id: null, campaign_id: null, due_date: dstr(3).slice(0, 10), done: 0, owner: "", created_at: "" },
  { id: 4, title: "File expenses", deal_id: null, campaign_id: null, due_date: "", done: 0, owner: "", created_at: "" },
  { id: 5, title: "Old done thing", deal_id: null, campaign_id: null, due_date: dstr(-9).slice(0, 10), done: 1, owner: "", created_at: "" },
];

const calls: { method: string; url: string; body?: any }[] = [];
let llmMode: "ok" | "down" | "hang" | "bullets" = "ok";
let lastLlmBody: any = null;
const realFetch = globalThis.fetch.bind(globalThis);

const LLM_URL = "http://llm.test";

function stubFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const ok = (data: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (url.startsWith("http://localhost:3001")) {
    const path = url.slice("http://localhost:3001".length).split("?")[0];
    let body: any = undefined;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { /* ignore */ }
    calls.push({ method, url, body });
    if (path === "/api/deals") return ok({ deals: stubDeals });
    if (path === "/api/tasks") {
      if (method === "POST") return ok({ task: { id: 900 + calls.length, ...body } });
      return ok({ tasks: stubTasks });
    }
    if (path === "/api/stages") return ok({ stages: stubStages });
    if (path === "/api/campaigns") return ok({ campaigns: stubCampaigns });
    if (path === "/api/contacts") return ok({ contacts: [] });
    return ok({});
  }
  if (url.startsWith(LLM_URL)) {
    if (llmMode === "down") return Promise.reject(new Error("fetch failed"));
    if (llmMode === "hang") {
      return new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () =>
          rej(new DOMException("The operation was aborted.", "AbortError")));
      });
    }
    try { lastLlmBody = init.body ? JSON.parse(init.body) : null; } catch { lastLlmBody = null; }
    const content = llmMode === "bullets"
      ? "- Negotiation holds most open value\n- Prospecting is going stale"
      : "1. Book venue\n2. Send invites\n3. Order catering";
    return ok({ choices: [{ message: { content } }] });
  }
  return realFetch(input, init);
}

const ENV_KEYS = ["MILTON_LLM_URL", "MILTON_ANALYST_MODEL", "MILTON_LLM_MODEL", "MILTON_LLM_TIMEOUT_MS", "MILTON_LLM_KEY", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  (globalThis as any).fetch = stubFetch;
  initAutomationDb(new Database(":memory:"));
  an.setEmbeddedEndpoint(null);
  calls.length = 0;
  llmMode = "ok";
  lastLlmBody = null;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  an.setEmbeddedEndpoint(null);
  (globalThis as any).fetch = realFetch;
});

describe("analyst intent parsing", () => {
  const cases: [string, string, string?][] = [
    ["analyze my pipeline", "analyze_pipeline"],
    ["analyze pipeline", "analyze_pipeline"],
    ["pipeline stats", "analyze_pipeline"],
    ["how's my pipeline", "analyze_pipeline"],
    ["pipeline report", "analyze_pipeline"],
    ["forecast", "forecast"],
    ["sales forecast", "forecast"],
    ["what will close this quarter", "forecast"],
    ["plan my day", "plan_day"],
    ["plan today", "plan_day"],
    ["plan my week", "plan_week"],
    ["weekly plan", "plan_week"],
    ["break down launch event", "plan_breakdown", "launch event"],
    ["plan website redesign", "plan_breakdown", "website redesign"],
  ];
  for (const [cmd, intent, goal] of cases) {
    test(`"${cmd}" -> ${intent}`, () => {
      const p = parseIntent(cmd);
      expect(p.name).toBe(intent);
      if (goal) expect(p.slots.goal).toBe(goal);
    });
  }
  test("\"plan my day\" is not a breakdown", () => {
    expect(parseIntent("plan my day").name).toBe("plan_day");
  });
});

describe("deterministic stats math", () => {
  test("computePipelineStats aggregates per stage", () => {
    const st = an.computePipelineStats(stubDeals as any, stubStages as any, stubCampaigns);
    expect(st.openCount).toBe(4);
    expect(st.openValue).toBe(220000);
    const neg = st.stages.find((s) => s.slug === "negotiation")!;
    expect(neg.count).toBe(1);
    expect(neg.total).toBe(120000);
    expect(neg.avgDays).toBe(45);
    expect(neg.avgProb).toBe(60);
    expect(st.winRate).toBe(0.5);
    expect(st.wonCount).toBe(1);
    expect(st.lostCount).toBe(1);
  });
  test("stale deals are 30d+ sorted by value", () => {
    const st = an.computePipelineStats(stubDeals as any, stubStages as any, stubCampaigns);
    expect(st.stale.map((d) => d.title)).toEqual(["Acme pilot", "Old prospect"]);
    expect(st.stale[0].days).toBe(45);
  });
  test("top campaigns by open pipeline value", () => {
    const st = an.computePipelineStats(stubDeals as any, stubStages as any, stubCampaigns);
    expect(st.topCampaigns[0]).toMatchObject({ name: "Q4 Launch", value: 180000, count: 2 });
    expect(st.topCampaigns[1]).toMatchObject({ name: "Beta Test", value: 30000, count: 1 });
  });
  test("facts block is compact numbers, not records", () => {
    const st = an.computePipelineStats(stubDeals as any, stubStages as any, stubCampaigns);
    expect(st.facts.length).toBeLessThan(1200);
    expect(st.facts).toContain("220000");
  });
  test("dealWeight prefers the deal probability, else stage defaults", () => {
    expect(an.dealWeight({ probability: 60, stage: "negotiation" } as any)).toBe(0.6);
    expect(an.dealWeight({ probability: 0, stage: "negotiation" } as any)).toBe(0.75);
    expect(an.dealWeight({ probability: 0, stage: "proposal" } as any)).toBe(0.5);
    expect(an.dealWeight({ probability: 0, stage: "qualification" } as any)).toBe(0.25);
    expect(an.dealWeight({ probability: 0, stage: "prospecting" } as any)).toBe(0.1);
    expect(an.dealWeight({ probability: 0, stage: "mystery" } as any)).toBe(0.15);
  });
  test("computeForecast weights, quarter wins, concentration", () => {
    const f = an.computeForecast(stubDeals as any, stubStages as any);
    // 120000*.6 + 60000*.5 + 30000*.25 + 10000*.1 = 110500
    expect(f.weightedTotal).toBe(110500);
    expect(f.openValue).toBe(220000);
    expect(f.wonThisQuarter).toBe(50000);
    expect(f.wonThisQuarterCount).toBe(1);
    expect(f.topDeal).toMatchObject({ title: "Acme pilot", value: 120000, sharePct: 55 });
    expect(f.quarter).toBe(an.currentQuarterKey());
  });
  test("parseNumberedList extracts steps", () => {
    expect(an.parseNumberedList("1. Book venue\n2. Send invites\n\n3) Order catering")).toEqual(
      ["Book venue", "Send invites", "Order catering"]);
    expect(an.parseNumberedList("no list here")).toEqual([]);
  });
});

describe("proxy hardening", () => {
  test("proxy env + loopback + no NO_PROXY -> interfering", () => {
    process.env.HTTP_PROXY = "http://proxy:8080";
    expect(an.proxyLikelyInterfering("localhost")).toBe(true);
    expect(an.proxyLikelyInterfering("127.0.0.1")).toBe(true);
  });
  test("NO_PROXY covering localhost -> not interfering", () => {
    process.env.HTTP_PROXY = "http://proxy:8080";
    process.env.NO_PROXY = "localhost,127.0.0.1";
    expect(an.proxyLikelyInterfering("localhost")).toBe(false);
  });
  test("no proxy env -> not interfering", () => {
    expect(an.proxyLikelyInterfering("localhost")).toBe(false);
  });
  test("non-loopback host is never flagged", () => {
    process.env.HTTP_PROXY = "http://proxy:8080";
    expect(an.proxyLikelyInterfering("api.example.com")).toBe(false);
  });
});

describe("endpoint resolution order", () => {
  test("embedded beats MILTON_LLM_URL beats none", () => {
    expect(an.llmEndpointBase()).toBe("");
    process.env.MILTON_LLM_URL = "http://ollama:11434/v1/";
    expect(an.llmEndpointBase()).toBe("http://ollama:11434/v1");
    an.setEmbeddedEndpoint("http://127.0.0.1:9999/v1");
    expect(an.llmEndpointBase()).toBe("http://127.0.0.1:9999/v1");
  });
  test("analystModel: MILTON_ANALYST_MODEL > MILTON_LLM_MODEL > default", () => {
    expect(an.analystModel()).toBe("local-model");
    process.env.MILTON_LLM_MODEL = "qwen3.5:0.8b";
    expect(an.analystModel()).toBe("qwen3.5:0.8b");
    process.env.MILTON_ANALYST_MODEL = "qwen3:0.6b";
    expect(an.analystModel()).toBe("qwen3:0.6b");
  });
  test("analystTimeoutMs defaults to 90000", () => {
    expect(an.analystTimeoutMs()).toBe(90000);
    process.env.MILTON_LLM_TIMEOUT_MS = "5000";
    expect(an.analystTimeoutMs()).toBe(5000);
    process.env.MILTON_LLM_TIMEOUT_MS = "bogus";
    expect(an.analystTimeoutMs()).toBe(90000);
  });
});

describe("analyze my pipeline", () => {
  test("deterministic brief without any LLM", async () => {
    const r = await handleMessage(sess(), "analyze my pipeline");
    expect(r.text).toContain("Pipeline analysis");
    expect(r.text).toContain("4 open deals");
    expect(r.text).toContain("Negotiation");
    expect(r.text).toContain("Win rate:** 50%");
    expect(r.text).toContain("Acme pilot");
    expect(r.text).toContain("Q4 Launch");
    expect(r.text).not.toContain("Analyst read");
  });
  test("LLM available -> insight bullets appended", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    llmMode = "bullets";
    const r = await handleMessage(sess(), "pipeline stats");
    expect(r.text).toContain("Pipeline analysis");
    expect(r.text).toContain("Analyst read");
    expect(r.text).toContain("Negotiation holds most open value");
    // pre-computed numbers only: no raw record dump in the request
    expect(JSON.stringify(lastLlmBody).length).toBeLessThan(3000);
  });
  test("LLM unreachable -> full deterministic brief + one-line note", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    llmMode = "down";
    const r = await handleMessage(sess(), "analyze my pipeline");
    expect(r.text).toContain("Pipeline analysis");
    expect(r.text).toContain("Win rate:** 50%");
    expect(r.text).toContain("Analyst insight skipped");
    expect(r.text).toContain("fetch failed");
  });
  test("MILTON_LLM_TIMEOUT_MS is honored", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    process.env.MILTON_LLM_TIMEOUT_MS = "50";
    llmMode = "hang";
    const t0 = Date.now();
    const r = await handleMessage(sess(), "analyze my pipeline");
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.text).toContain("Pipeline analysis");
    expect(r.text).toContain("Analyst insight skipped");
  });
  test("proxy trap surfaces the NO_PROXY hint", async () => {
    process.env.MILTON_LLM_URL = "http://localhost:11434/v1";
    process.env.HTTP_PROXY = "http://proxy:8080";
    llmMode = "down";
    const r = await an.askAnalyst({ system: "x", facts: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("NO_PROXY=localhost,127.0.0.1");
  });
});

describe("forecast", () => {
  test("deterministic weighted forecast", async () => {
    const r = await handleMessage(sess(), "forecast");
    expect(r.text).toContain("Forecast");
    expect(r.text).toContain("$110.5k");
    expect(r.text).toContain("Acme pilot");
    expect(r.text).toContain("55% of open pipeline");
    expect(r.text).not.toContain("Risk read");
  });
  test("LLM available -> risk read appended", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    llmMode = "bullets";
    const r = await handleMessage(sess(), "what will close this quarter");
    expect(r.text).toContain("Risk read");
  });
});

describe("plan my day / plan my week", () => {
  test("day plan orders overdue first, deterministic", async () => {
    const r = await handleMessage(sess(), "plan my day");
    expect(r.text).toContain("Plan for");
    const iOverdue = r.text.indexOf("Call Acme");
    const iToday = r.text.indexOf("Send proposal");
    expect(iOverdue).toBeGreaterThan(-1);
    expect(iToday).toBeGreaterThan(iOverdue);
    expect(r.text).toContain("Acme pilot"); // closing soon
    expect(r.text).not.toContain("Suggested schedule");
  });
  test("day plan with LLM -> suggested schedule", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    llmMode = "bullets";
    const r = await handleMessage(sess(), "plan my day");
    expect(r.text).toContain("Suggested schedule");
  });
  test("week plan groups by day", async () => {
    const r = await handleMessage(sess(), "plan my week");
    expect(r.text).toContain("Plan for the week");
    expect(r.text).toContain("Overdue");
    expect(r.text).toContain("Call Acme");
  });
});

describe("break down", () => {
  test("without LLM -> clean needs-model message, no writes", async () => {
    const s = sess();
    const r = await handleMessage(s, "break down launch event");
    expect(r.text).toContain("needs the analyst model");
    expect(r.text).toContain("MILTON_LLM_URL");
    expect(r.text).toContain("MILTON_ANALYST_MODEL");
    expect(s.pending).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  test("with LLM -> confirm card, yes creates tasks", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    const s = sess();
    const r = await handleMessage(s, "break down launch event");
    expect(r.text).toContain("1. Book venue");
    expect(r.text).toContain("create these 3 as tasks");
    expect(r.cards?.[0]?.kind).toBe("confirm");
    expect(s.pending?.type).toBe("plan_tasks");
    const r2 = await handleMessage(s, "yes");
    expect(r2.text).toContain('Created 3 tasks for "launch event"');
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/api/tasks"));
    expect(posts.length).toBe(3);
    expect(posts[0].body.title).toBe("Book venue");
  });
  test("no cancels the pending plan", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    const s = sess();
    await handleMessage(s, "break down launch event");
    const r = await handleMessage(s, "no");
    expect(r.text).toContain("Cancelled");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  test("unattended routine skips break down", async () => {
    process.env.MILTON_LLM_URL = LLM_URL;
    await handleMessage(sess(), "save routine bd: break down launch event; kpis");
    calls.length = 0;
    const run = await runRoutineUnattended("bd", "manual", "test");
    expect(run.status).toBe("partial");
    expect(run.summary).toMatch(/needs follow-up/i);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await handleMessage(sess(), "delete routine bd");
  });
});

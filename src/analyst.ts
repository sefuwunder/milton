// analyst.ts — small-LLM analyst & planner layer for Milton.
//
// Two halves:
//  1. A dedicated LLM client (askAnalyst) for analysis/planning prompts. It rides
//     the same OpenAI-compatible endpoint as chat (MILTON_LLM_URL) but has its own
//     model override (MILTON_ANALYST_MODEL) and a longer default timeout
//     (MILTON_LLM_TIMEOUT_MS, 90s) — analysis prompts deserve more than the chat
//     path's 30s. The chat path in brain.ts is untouched.
//  2. Deterministic statistics (computePipelineStats / computeForecast) that run
//     with no model at all. The LLM only ever receives these pre-computed numbers —
//     never raw record dumps — and its output is labeled as model-generated; if it
//     returns garbage, callers fall back to the deterministic brief.
//
// Env is read at call time (not module load) so tests can reconfigure per case.

import type { Deal, Stage } from "./crm";

// ---- configuration ------------------------------------------------------------
// Endpoint resolution order: embedded llama-server sidecar (when active) ->
// MILTON_LLM_URL -> none (deterministic fallbacks only).

let embeddedUrl: string | null = null;

/** Set by src/embedded.ts at boot when the sidecar starts; cleared on shutdown. */
export function setEmbeddedEndpoint(url: string | null): void {
  embeddedUrl = url;
}

export function llmEndpointBase(): string {
  return embeddedUrl || (process.env.MILTON_LLM_URL || "").replace(/\/$/, "");
}

export function analystConfigured(): boolean {
  return Boolean(llmEndpointBase());
}

export function analystModel(): string {
  return process.env.MILTON_ANALYST_MODEL || process.env.MILTON_LLM_MODEL || "local-model";
}

export function analystTimeoutMs(): number {
  const n = parseInt(process.env.MILTON_LLM_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 90000;
}

function analystBase(): string {
  return llmEndpointBase();
}

// ---- proxy awareness ----------------------------------------------------------
// Open user report: Milton -> Ollama times out while curl succeeds. The classic
// culprit is HTTP(S)_PROXY routing even loopback traffic through a proxy that
// can't reach it. Bun's fetch honors proxy env vars; curl honors NO_PROXY —
// hence the asymmetry. We can't bypass the proxy per-request, so we detect the
// trap and surface an actionable hint in the error.
function proxyEnv(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || "";
}

function noProxyList(): string[] {
  return (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** True when proxy env vars are set, the target is loopback, and NO_PROXY
 *  doesn't cover it — i.e. this request is probably being proxied to nowhere. */
export function proxyLikelyInterfering(host: string): boolean {
  if (!proxyEnv()) return false;
  const h = host.toLowerCase();
  const list = noProxyList();
  if (list.includes("*")) return false;
  if (list.some((e) => e === h || h === e.replace(/^\./, "") || h.endsWith(e.startsWith(".") ? e : `.${e}`))) return false;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function loopbackHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ---- LLM client ----------------------------------------------------------------

export type AnalystResult = { ok: true; text: string } | { ok: false; error: string };

async function analystProviderError(res: Response): Promise<string> {
  try {
    const j: any = await res.json();
    if (typeof j?.error === "string") return j.error;
    if (typeof j?.error?.message === "string") return j.error.message;
  } catch { /* non-JSON error body */ }
  return res.statusText || "";
}

/** Ask the analyst model something. `facts` must be pre-computed numbers/text —
 *  never raw record dumps. Returns sanitized text on success; on failure an
 *  error string with an actionable hint (never API key material). */
export async function askAnalyst(opts: {
  system: string; facts: string; maxTokens?: number;
}): Promise<AnalystResult> {
  const base = analystBase();
  if (!base) return { ok: false, error: "analyst model not configured (set MILTON_LLM_URL)" };
  const endpoint = base + "/chat/completions";
  const key = process.env.MILTON_LLM_KEY || "";
  const host = loopbackHost(base);
  const proxyHint = host && proxyLikelyInterfering(host)
    ? " Your HTTP(S)_PROXY looks set while NO_PROXY doesn't cover localhost — try NO_PROXY=localhost,127.0.0.1."
    : "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: analystModel(),
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.facts },
        ],
        max_tokens: opts.maxTokens ?? 400,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(analystTimeoutMs()),
    });
    if (!res.ok) {
      const providerMsg = await analystProviderError(res);
      return { ok: false, error: `${res.status} from ${endpoint}${providerMsg ? `: ${providerMsg}` : ""}. Check the endpoint and \`ollama list\` for the model name.${proxyHint}` };
    }
    const j: any = await res.json();
    const text = (j.choices?.[0]?.message?.content || "").trim();
    if (!text) return { ok: false, error: `empty response from ${endpoint}` };
    // Small models ramble; keep the output tight.
    return { ok: true, text: text.length > 1800 ? text.slice(0, 1800).trimEnd() + " …" : text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `couldn't reach the analyst model at ${endpoint} (${msg}). Check the endpoint and \`ollama list\` for the model name.${proxyHint}` };
  }
}

/** Pull a numbered list out of model output. Returns [] when unusable. */
export function parseNumberedList(text: string): string[] {
  return text.split("\n")
    .map((l) => l.match(/^\s*\d+[.)]\s*(.+?)\s*$/)?.[1])
    .filter((s): s is string => !!s && s.length > 0)
    .slice(0, 12);
}

// ---- deterministic statistics --------------------------------------------------
// Pure functions over CRM data. No LLM involved; the LLM only ever sees the
// compact facts blocks these produce.

function daysSinceStr(s: string): number | null {
  // Pure local calendar-day arithmetic, consistent with daysUntil in brain.ts:
  // user-facing day counts follow the user's calendar, and both sides are
  // pinned to local midnight so the result is always whole days.
  const m = (s || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((now.getTime() - then.getTime()) / 86400000);
}

function quarterKey(isoDate: string): string | null {
  const m = (isoDate || "").slice(0, 10).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

export function currentQuarterKey(ref: Date = new Date()): string {
  return `${ref.getFullYear()}-Q${Math.floor(ref.getMonth() / 3) + 1}`;
}

export interface StageStat {
  slug: string; label: string; count: number; total: number; avg: number;
  avgDays: number | null; avgProb: number | null;
}
export interface StaleDeal { title: string; stage: string; value: number; days: number }
export interface CampaignStat { name: string; value: number; count: number }
export interface PipelineStats {
  stages: StageStat[];
  openCount: number; openValue: number;
  wonCount: number; wonValue: number; lostCount: number; lostValue: number;
  winRate: number | null;
  stale: StaleDeal[];
  topCampaigns: CampaignStat[];
  /** Compact facts block — the only thing the LLM ever sees. */
  facts: string;
}

export function computePipelineStats(
  deals: Deal[], stages: Stage[], campaigns: { id: number; name: string }[] = []
): PipelineStats {
  const labels: Record<string, string> = {};
  for (const s of stages) labels[s.slug] = s.name;
  const label = (slug: string) => labels[slug] || slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const won = deals.filter((d) => d.stage === "closed_won");
  const lost = deals.filter((d) => d.stage === "closed_lost");

  const order = stages.length ? stages.map((s) => s.slug) : [...new Set(deals.map((d) => d.stage))];
  const stageStats: StageStat[] = order.map((slug) => {
    const ds = deals.filter((d) => d.stage === slug);
    const total = ds.reduce((a, d) => a + (d.value || 0), 0);
    const dayList = ds.map((d) => daysSinceStr(d.updated_at)).filter((n): n is number => n !== null);
    const probList = ds.map((d) => d.probability).filter((p) => typeof p === "number" && p > 0);
    return {
      slug, label: label(slug), count: ds.length, total,
      avg: ds.length ? Math.round(total / ds.length) : 0,
      avgDays: dayList.length ? Math.round(dayList.reduce((a, b) => a + b, 0) / dayList.length) : null,
      avgProb: probList.length ? Math.round(probList.reduce((a, b) => a + b, 0) / probList.length) : null,
    };
  });

  const stale: StaleDeal[] = open
    .map((d) => ({ d, days: daysSinceStr(d.updated_at) }))
    .filter((x): x is { d: Deal; days: number } => x.days !== null && x.days >= 30)
    .sort((a, b) => (b.d.value || 0) - (a.d.value || 0))
    .map((x) => ({ title: x.d.title, stage: label(x.d.stage), value: x.d.value || 0, days: x.days }));

  const campName = new Map(campaigns.map((c) => [c.id, c.name]));
  const byCamp = new Map<number, { value: number; count: number }>();
  for (const d of open) {
    const cid = d.campaign_id;
    if (typeof cid !== "number") continue;
    const e = byCamp.get(cid) || { value: 0, count: 0 };
    e.value += d.value || 0; e.count += 1;
    byCamp.set(cid, e);
  }
  const topCampaigns: CampaignStat[] = [...byCamp.entries()]
    .map(([id, e]) => ({ name: campName.get(id) || `Campaign #${id}`, value: e.value, count: e.count }))
    .sort((a, b) => b.value - a.value);

  const wonValue = won.reduce((a, d) => a + (d.value || 0), 0);
  const winRate = won.length + lost.length ? won.length / (won.length + lost.length) : null;

  const facts = [
    `Open pipeline: ${open.length} deals, total value ${openValue(open)}.`,
    ...stageStats.filter((s) => s.count > 0).map((s) =>
      `${s.label}: ${s.count} deals, total ${s.total}, avg ${s.avg}` +
      (s.avgDays !== null ? `, avg ${s.avgDays} days since last update` : "") +
      (s.avgProb !== null ? `, avg win probability ${s.avgProb}%` : "")),
    `Closed: ${won.length} won (${wonValue}), ${lost.length} lost${winRate !== null ? `, win rate ${Math.round(winRate * 100)}%` : ""}.`,
    stale.length ? `Stale deals (30+ days, by value): ${stale.slice(0, 5).map((d) => `${d.title} (${d.value}, ${d.days}d)`).join("; ")}.` : "No stale deals.",
    topCampaigns.length ? `Top campaigns by open value: ${topCampaigns.slice(0, 3).map((c) => `${c.name} (${c.value})`).join("; ")}.` : "",
  ].filter(Boolean).join("\n");

  return {
    stages: stageStats,
    openCount: open.length, openValue: openValue(open),
    wonCount: won.length, wonValue, lostCount: lost.length, lostValue: lost.reduce((a, d) => a + (d.value || 0), 0),
    winRate, stale, topCampaigns, facts,
  };
}

function openValue(deals: Deal[]): number {
  return deals.reduce((a, d) => a + (d.value || 0), 0);
}

// ---- forecast ------------------------------------------------------------------
// Weighted forecast: each open deal contributes value x win probability. The
// deal's own probability wins when set; otherwise documented per-stage defaults.

export const STAGE_WEIGHTS: Record<string, number> = {
  prospecting: 0.10, qualification: 0.25, proposal: 0.50, negotiation: 0.75,
  closed_won: 1, closed_lost: 0,
};
const DEFAULT_WEIGHT = 0.15;

export function dealWeight(d: Deal): number {
  if (typeof d.probability === "number" && d.probability > 0) return Math.min(1, d.probability / 100);
  return STAGE_WEIGHTS[d.stage] ?? DEFAULT_WEIGHT;
}

export interface ForecastStage { slug: string; label: string; count: number; value: number; weighted: number }
export interface Forecast {
  quarter: string;
  openCount: number; openValue: number;
  weightedTotal: number;
  perStage: ForecastStage[];
  wonThisQuarter: number; wonThisQuarterCount: number;
  topDeal: { title: string; value: number; sharePct: number } | null;
  facts: string;
}

export function computeForecast(deals: Deal[], stages: Stage[], ref: Date = new Date()): Forecast {
  const labels: Record<string, string> = {};
  for (const s of stages) labels[s.slug] = s.name;
  const label = (slug: string) => labels[slug] || slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const q = currentQuarterKey(ref);

  const order = stages.length ? stages.map((s) => s.slug) : [...new Set(open.map((d) => d.stage))];
  const perStage: ForecastStage[] = order
    .map((slug) => {
      const ds = open.filter((d) => d.stage === slug);
      const value = ds.reduce((a, d) => a + (d.value || 0), 0);
      return { slug, label: label(slug), count: ds.length, value, weighted: Math.round(ds.reduce((a, d) => a + (d.value || 0) * dealWeight(d), 0)) };
    })
    .filter((s) => s.count > 0);
  const weightedTotal = perStage.reduce((a, s) => a + s.weighted, 0);
  const openTotal = openValue(open);

  const wonQ = deals.filter((d) => d.stage === "closed_won" && quarterKey(d.updated_at) === q);
  const wonThisQuarter = wonQ.reduce((a, d) => a + (d.value || 0), 0);

  const biggest = [...open].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
  const topDeal = biggest && openTotal > 0
    ? { title: biggest.title, value: biggest.value || 0, sharePct: Math.round(((biggest.value || 0) / openTotal) * 100) }
    : null;

  const facts = [
    `Weighted forecast for ${q}: ${weightedTotal} across ${open.length} open deals (open pipeline ${openTotal}).`,
    ...perStage.map((s) => `${s.label}: ${s.count} deals, ${s.value} open, ${s.weighted} weighted.`),
    `Closed won in ${q}: ${wonQ.length} deals, ${wonThisQuarter}.`,
    topDeal ? `Largest open deal: "${topDeal.title}" at ${topDeal.value} (${topDeal.sharePct}% of open pipeline).` : "",
  ].filter(Boolean).join("\n");

  return { quarter: q, openCount: open.length, openValue: openTotal, weightedTotal, perStage, wonThisQuarter, wonThisQuarterCount: wonQ.length, topDeal, facts };
}

// ---- prompt discipline ----------------------------------------------------------
// Small models do best with a tight role, a demand for short structured output,
// and facts only — no raw records, no room to ramble.

export const ANALYZE_SYSTEM =
  "You are a terse sales-pipeline analyst. I give you pre-computed pipeline statistics. " +
  "Reply with 3-5 short bullet insights, one line each, starting with '- '. " +
  "Compare stages, call out bottlenecks and risks. Use ONLY the numbers given — never invent figures. No headers, no preamble.";

export const FORECAST_SYSTEM =
  "You are a terse revenue analyst. I give you forecast numbers. " +
  "Reply with 2-4 short bullets on forecast risk: deal concentration, stale large deals, thin coverage. " +
  "One line each, starting with '- '. Use ONLY the numbers given. No headers, no preamble.";

export const PLAN_DAY_SYSTEM =
  "You are a terse executive assistant. I give you a prioritized work list. " +
  "Turn it into a short ordered day plan with rough time blocks (e.g. '9:00-9:30'). " +
  "Keep it under 12 lines. Plain text, no headers.";

export const PLAN_WEEK_SYSTEM =
  "You are a terse executive assistant. I give you a week's work items grouped by day. " +
  "Turn it into a short ordered plan grouped by day (Mon-Fri), with the must-do items first each day. " +
  "Keep it under 20 lines. Plain text, no headers.";

export const BREAKDOWN_SYSTEM =
  "Break the goal into 5-9 concrete, actionable steps. " +
  "Reply with ONLY a numbered list, one step per line ('1. ...'). No preamble, no explanation.";

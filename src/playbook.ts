// playbook.ts — deterministic forward-chaining rule engine for Milton playbooks.
//
// A run starts from a frozen CRM snapshot (extractFacts: deals, tasks,
// activities, per-stage dwell medians, owner load, optional event fact) plus a
// frozen `now`. Rules are plain JSON (see playbook-rules.json) in a
// json-rules-engine-flavoured DSL extended with per-subject iteration
// (`subject` / `as` / `where`) and negation-as-failure (`{not: …}`).
//
// Match → agenda → fire, one activation per pass:
//   1. Match every eligible rule with nested-loop joins over the fact
//      collections (no RETE: ≤1k facts, ≤100 rules — sub-millisecond).
//      Rules carrying an `on` array run ONLY when `eventName` is set and
//      listed in it; rules without `on` run only in normal (non-event) runs.
//   2. Refraction: a (rule, bindings) activation that already fired never
//      re-fires in the same run.
//   3. Conflict resolution: salience desc, then specificity desc (leaf
//      condition count, recursive), then rule id asc. Facts are iterated in
//      array order and the agenda is re-sorted every pass, so runs are fully
//      deterministic.
//   4. Fire the first activation. `assert` actions append derived facts that
//      later passes can match (chaining). A 100-iteration cap guards against
//      assert-loop authoring bugs.
//
// Actions are advisory only: `finding` (aggregated across activations or
// per-activation text), `suggest` (text + follow-up chips), `assert`
// (derived fact for chaining), `flag` (marked entity). Nothing here sends
// messages, mutates the CRM, or runs routines — the chat layer (brain.ts)
// disposes. Destructive steps stay behind the existing confirmation path.
//
// brain.ts imports this module; this module must never import brain.ts (cycle).

import type { Deal, Task, Activity, Stage } from "./crm";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import starterRulesJson from "./playbook-rules.json";

// ---- DSL types ---------------------------------------------------------------

export type Operator =
  | "equal" | "notEqual"
  | "greaterThan" | "greaterThanInclusive" | "lessThan" | "lessThanInclusive"
  | "in" | "notIn" | "contains" | "startsWith" | "endsWith";

export type LeafCondition = { fact: string; operator: Operator; value: unknown };
export type NotCondition = { not: Condition };
export type SubjectCondition = {
  subject: string; as?: string;
  where?: Record<string, string | number>;
  all?: Condition[]; any?: Condition[];
};
export type Condition = SubjectCondition | NotCondition | LeafCondition;

export type FindingAction = {
  finding: string; icon: string; text?: string;
  aggregate?: string; orderBy?: string; fix?: string;
};
export type SuggestAction = { suggest: string; chips?: string[] };
export type AssertAction = { assert: string; facts?: Record<string, unknown> };
export type FlagAction = { flag: string; entity?: string };
export type Action = FindingAction | SuggestAction | AssertAction | FlagAction;

export interface Rule {
  id: string; name: string; salience?: number; active?: boolean; on?: string[];
  when: Condition[]; then: Action[];
}

// ---- facts -------------------------------------------------------------------

export type Fact = Record<string, unknown>;
export interface FactSet { [collection: string]: Fact[]; }

export interface PlaybookInput {
  deals: Deal[]; tasks: Task[]; activities: Activity[]; stages: Stage[];
  nowMs: number;
  event?: Record<string, unknown>;
}

/** Local calendar-day difference (dateStr minus nowMs), both sides pinned to
 *  local midnight — identical semantics to brain.ts `daysUntil`. */
function calDays(dateStr: string, nowMs: number): number | null {
  const m = (dateStr || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  const r = new Date(nowMs); r.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - r.getTime()) / 86400000);
}

/** Flatten the CRM snapshot into the engine's fact collections. All temporal
 *  fields are derived once from the frozen `nowMs` so rules stay pure
 *  comparisons and runs are reproducible. */
export function extractFacts(input: PlaybookInput): FactSet {
  const { deals, tasks, activities, stages, nowMs } = input;
  // brain.ts todayStr() is ref.toISOString().slice(0, 10) — a UTC date — so
  // this matches the legacy hygiene overdue predicate exactly.
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);

  const deal: Fact[] = deals.map((d) => {
    const dsu = calDays((d.updated_at || "").slice(0, 10), nowMs);
    return {
      id: d.id,
      title: d.title,
      value: d.value || 0,
      stage: d.stage,
      owner: d.owner,
      company_id: d.company_id ?? null,
      contact_id: d.contact_id ?? null,
      expected_close: d.expected_close || "",
      created: d.created_at,
      updated: d.updated_at,
      days_since_update: dsu === null ? null : -dsu,
      open: !d.stage.startsWith("closed_"),
      days_until_close: d.expected_close ? calDays(d.expected_close, nowMs) : null,
    };
  });

  const task: Fact[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    deal_id: t.deal_id,
    due_date: t.due_date,
    owner: t.owner,
    open: !t.done,
    overdue: Boolean(!t.done && t.due_date && t.due_date < todayUtc),
  }));

  const activity: Fact[] = activities.map((a) => {
    const da = calDays((a.created_at || "").slice(0, 10), nowMs);
    return {
      id: a.id, kind: a.kind, ref_type: a.ref_type, ref_id: a.ref_id,
      days_ago: da === null ? null : -da,
    };
  });

  const openDeals = deals.filter((d) => !String(d.stage).startsWith("closed_"));
  // Per-stage median current-stage dwell in whole local calendar days, pinned
  // to the frozen nowMs. We deliberately do NOT use analyst.computeSalesCycle
  // here: its internals pin "now" to the wall clock, which would make runs
  // drift across midnight boundaries and break reproducibility. This mirrors
  // its per-stage logic exactly (same stage order, same median of the same
  // deal set), only the clock is frozen.
  const order = stages.length ? stages.map((s) => s.slug) : [...new Set(openDeals.map((d) => d.stage))];
  const dwell: Fact[] = [];
  for (const slug of order) {
    const ds = openDeals.filter((d) => d.stage === slug);
    if (!ds.length) continue;
    const dwells = ds
      .map((d) => calDays((d.updated_at || "").slice(0, 10), nowMs))
      .filter((n): n is number => n !== null)
      .map((n) => -n); // dwell days since last update
    if (!dwells.length) continue;
    const sorted = [...dwells].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    dwell.push({ stage: slug, median_dwell: med });
  }

  const overdueByOwner = new Map<string, number>();
  for (const t of task) {
    if (t.overdue) {
      const owner = String(t.owner);
      overdueByOwner.set(owner, (overdueByOwner.get(owner) || 0) + 1);
    }
  }
  const owner_load: Fact[] = [...overdueByOwner.entries()]
    .map(([owner, overdue_count]) => ({ owner, overdue_count }));

  const facts: FactSet = { deal, task, activity, dwell, owner_load };
  if (input.event) facts.event = [{ name: (input.event as { name?: unknown }).name, ...input.event }];
  return facts;
}

// ---- matching ----------------------------------------------------------------

type Bindings = Map<string, Fact>;
interface MatchState { b: Bindings; w: string[]; }
interface Activation { rule: Rule; bindings: Bindings; why: string; }

/** Resolve a `<binding>.<field>` path against the current bindings. */
function resolvePath(path: string, bindings: Bindings): unknown {
  const parts = path.split(".");
  let cur: unknown = bindings.get(parts[0]);
  for (let i = 1; i < parts.length && cur !== null && cur !== undefined; i++) {
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

/**
 * Resolve a leaf `value`. A string starting with `$` is a binding reference
 * with its original type (`$d.id`); an optional trailing arithmetic suffix
 * `/N`, `*N`, `+N`, `-N` (numeric N) is applied, e.g. `$d.days_since_update/2`.
 * Returns NaN when the reference or arithmetic cannot be evaluated — numeric
 * comparisons against NaN simply fail to match.
 */
function resolveValue(v: unknown, bindings: Bindings): unknown {
  if (typeof v !== "string" || !v.startsWith("$")) return v;
  const m = v.match(/^(\$[^/*+\-]+)([\/*+\-])(\d+(?:\.\d+)?)$/);
  if (m) {
    const base = resolvePath(m[1].slice(1), bindings);
    const n = Number(m[3]);
    if (typeof base !== "number" || !Number.isFinite(base) || !Number.isFinite(n)) return NaN;
    switch (m[2]) {
      case "/": return n === 0 ? NaN : base / n;
      case "*": return base * n;
      case "+": return base + n;
      case "-": return base - n;
    }
  }
  return resolvePath(v.slice(1), bindings);
}

/** Resolve a `where` value: `$`-prefixed strings are binding references with
 *  their original type; everything else is a literal. */
function resolveWhere(v: string | number, bindings: Bindings): unknown {
  return typeof v === "string" && v.startsWith("$") ? resolvePath(v.slice(1), bindings) : v;
}

function eq(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function applyOperator(op: Operator, left: unknown, right: unknown): boolean {
  switch (op) {
    case "equal": return eq(left, right);
    case "notEqual": return !eq(left, right);
    case "greaterThan": { const a = toNum(left), b = toNum(right); return Number.isFinite(a) && Number.isFinite(b) && a > b; }
    case "greaterThanInclusive": { const a = toNum(left), b = toNum(right); return Number.isFinite(a) && Number.isFinite(b) && a >= b; }
    case "lessThan": { const a = toNum(left), b = toNum(right); return Number.isFinite(a) && Number.isFinite(b) && a < b; }
    case "lessThanInclusive": { const a = toNum(left), b = toNum(right); return Number.isFinite(a) && Number.isFinite(b) && a <= b; }
    case "in": return Array.isArray(right) && right.some((r) => eq(left, r));
    case "notIn": return !(Array.isArray(right) && right.some((r) => eq(left, r)));
    case "contains":
      if (typeof left === "string") return left.includes(String(right));
      if (Array.isArray(left)) return left.some((x) => eq(x, right));
      return false;
    case "startsWith": return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "endsWith": return typeof left === "string" && typeof right === "string" && left.endsWith(right);
  }
}

// ---- why-traces ---------------------------------------------------------------

function opSymbol(op: Operator): string {
  switch (op) {
    case "equal": return "=";
    case "notEqual": return "≠";
    case "greaterThan": return ">";
    case "greaterThanInclusive": return "≥";
    case "lessThan": return "<";
    case "lessThanInclusive": return "≤";
    case "in": return "in";
    case "notIn": return "not in";
    case "contains": return "contains";
    case "startsWith": return "starts with";
    case "endsWith": return "ends with";
  }
}

function fmtVal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `[${v.map(fmtVal).join(", ")}]`;
  if (typeof v === "number" && !Number.isInteger(v)) return String(Math.round(v * 100) / 100);
  return String(v);
}

function fieldName(factPath: string): string {
  const i = factPath.indexOf(".");
  return i >= 0 ? factPath.slice(i + 1) : factPath;
}

/** Compact summary of a matched leaf, e.g. `value 120000 > 10000`. */
function describeLeaf(cond: LeafCondition, bindings: Bindings, includeActual: boolean): string {
  const right = resolveValue(cond.value, bindings);
  const actual = includeActual ? `${fmtVal(resolvePath(cond.fact, bindings))} ` : "";
  return `${fieldName(cond.fact)} ${actual}${opSymbol(cond.operator)} ${fmtVal(right)}`.replace("  ", " ");
}

/** Negation-as-failure summary, e.g. `no activity with ref_type = "deal", ref_id = 42, days_ago < 14`. */
function describeNegation(cond: Condition, bindings: Bindings): string {
  if (typeof cond === "object" && cond !== null && "not" in cond) {
    return `not (${describeNegation((cond as NotCondition).not, bindings)})`;
  }
  if (typeof cond === "object" && cond !== null && "fact" in cond) {
    return describeLeaf(cond as LeafCondition, bindings, false);
  }
  const subj = cond as SubjectCondition;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(subj.where ?? {})) {
    parts.push(`${k} = ${fmtVal(resolveWhere(v, bindings))}`);
  }
  for (const c of subj.all ?? []) parts.push(describeNegation(c, bindings));
  return `no ${subj.subject}${parts.length ? ` with ${parts.join(", ")}` : ""}`;
}

function activationWhy(rule: Rule, bindings: Bindings, summaries: string[]): string {
  const parts: string[] = [];
  for (const [name, fact] of bindings) {
    let s = name;
    if (fact.id !== null && fact.id !== undefined) s += ` #${fact.id}`;
    if (typeof fact.title === "string" && fact.title) s += ` "${fact.title}"`;
    parts.push(s);
  }
  return `rule ${rule.id} · ${parts.join(", ")} — ${summaries.join("; ")}`;
}

// ---- matcher ------------------------------------------------------------------

function matchCond(cond: Condition, facts: FactSet, s: MatchState): MatchState[] {
  // Negation as failure: succeeds iff the inner condition matches nothing.
  if ("not" in cond) {
    const inner = matchCond(cond.not, facts, { b: s.b, w: [] });
    if (inner.length > 0) return [];
    return [{ b: s.b, w: [...s.w, describeNegation(cond.not, s.b)] }];
  }
  // Leaf: resolve fact path and value against bindings, apply the operator.
  if ("fact" in cond) {
    const left = resolvePath(cond.fact, s.b);
    const right = resolveValue(cond.value, s.b);
    if (!applyOperator(cond.operator, left, right)) return [];
    return [{ b: s.b, w: [...s.w, describeLeaf(cond, s.b, true)] }];
  }
  // Subject clause: iterate the collection in array order; `as` names the
  // binding (default = subject name); `where` pre-filters candidates.
  const name = cond.as ?? cond.subject;
  const coll = facts[cond.subject] ?? [];
  const out: MatchState[] = [];
  for (const fact of coll) {
    let ok = true;
    for (const [k, v] of Object.entries(cond.where ?? {})) {
      if (!eq(fact[k], resolveWhere(v, s.b))) { ok = false; break; }
    }
    if (!ok) continue;
    const nb = new Map(s.b);
    nb.set(name, fact);
    let states: MatchState[] = [{ b: nb, w: s.w }];
    for (const c of cond.all ?? []) {
      const next: MatchState[] = [];
      for (const st of states) next.push(...matchCond(c, facts, st));
      states = next;
      if (!states.length) break;
    }
    if (!states.length) continue;
    if (cond.any !== undefined) {
      const matched: MatchState[] = [];
      for (const c of cond.any) {
        for (const st of states) matched.push(...matchCond(c, facts, st));
      }
      if (!matched.length) continue;
      states = matched;
    }
    out.push(...states);
  }
  return out;
}

function matchRule(rule: Rule, facts: FactSet): Activation[] {
  let states: MatchState[] = [{ b: new Map(), w: [] }];
  for (const cond of rule.when) {
    const next: MatchState[] = [];
    for (const s of states) next.push(...matchCond(cond, facts, s));
    states = next;
    if (!states.length) return [];
  }
  return states.map((s) => ({ rule, bindings: s.b, why: activationWhy(rule, s.b, s.w) }));
}

/** Specificity for conflict resolution: recursive leaf-condition count. */
function specificity(rule: Rule): number {
  const count = (c: Condition): number => {
    if ("not" in c) return count(c.not);
    if ("fact" in c) return 1;
    let n = 0;
    for (const x of c.all ?? []) n += count(x);
    for (const x of c.any ?? []) n += count(x);
    return n;
  };
  return rule.when.reduce((a, c) => a + count(c), 0);
}

/** Key-stable stringify for refraction keys (bindings hold plain data). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

// ---- templates -----------------------------------------------------------------

/**
 * Interpolate `{binding.field}` placeholders from the activation's bindings;
 * unknown paths become the empty string. Only `{…}` is special — a literal
 * `$` (as in `${d.value}` → `$5000`) always survives.
 */
export function renderTemplate(tpl: string, bindings: Bindings): string {
  return tpl.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const v = resolvePath(raw.trim(), bindings);
    return v === null || v === undefined ? "" : String(v);
  });
}

/**
 * Interpolate an `assert` fact value. A value that is exactly one placeholder
 * (`{d.id}`) keeps its original type (numbers stay numbers); embedded
 * placeholders render as strings.
 */
function renderFactValue(v: unknown, bindings: Bindings): unknown {
  if (typeof v !== "string") return v;
  const m = v.match(/^\{([^{}]+)\}$/);
  if (m) {
    const raw = resolvePath(m[1].trim(), bindings);
    return raw === undefined ? "" : raw;
  }
  return renderTemplate(v, bindings);
}

// ---- run -----------------------------------------------------------------------

export interface PlaybookFinding {
  ruleId: string; ruleName: string; kind: string; icon: string;
  text: string; fix?: string; why: string;
}
export interface PlaybookSuggestion {
  ruleId: string; ruleName: string; text: string; chips: string[]; why: string;
}
export interface PlaybookFlag {
  ruleId: string; kind: string; entity?: string; why: string;
}
export interface PlaybookRunResult {
  findings: PlaybookFinding[];
  suggestions: PlaybookSuggestion[];
  flags: PlaybookFlag[];
  /** Derived-fact collections asserted this run → count added. */
  asserted: Record<string, number>;
  /** Activations fired. */
  fired: number;
  /** True when the 100-iteration cycle guard tripped. */
  capped: boolean;
}

export interface RuleRecord {
  id: string; name: string; salience: number; active: boolean; builtin: boolean;
  rule: Rule;
}

function asRule(r: Rule | RuleRecord): Rule {
  return r !== null && typeof r === "object" && "rule" in r &&
    (r as RuleRecord).rule !== null && typeof (r as RuleRecord).rule === "object"
    ? (r as RuleRecord).rule
    : (r as Rule);
}

interface FindingActivation {
  rule: Rule; action: FindingAction; bindings: Bindings; why: string;
}

function firstTitle(act: FindingActivation): string | undefined {
  for (const fact of act.bindings.values()) {
    if (fact && typeof fact.title === "string" && fact.title) return fact.title;
  }
  return undefined;
}

function sortByOrder(acts: FindingActivation[], orderBy?: string): FindingActivation[] {
  if (!orderBy) return acts;
  const desc = orderBy.startsWith("-");
  const path = desc ? orderBy.slice(1) : orderBy;
  return [...acts].sort((a, b) => {
    const va = resolvePath(path, a.bindings);
    const vb = resolvePath(path, b.bindings);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va ?? "").localeCompare(String(vb ?? ""));
    return desc ? -cmp : cmp;
  });
}

/** Render an aggregate template: `{n}`, `{s}` (plural), `{titles}` (first 4,
 *  `…` when more), `{first}` — then ordinary binding interpolation. */
function renderAggregate(tpl: string, acts: FindingActivation[], orderBy?: string): string {
  const sorted = sortByOrder(acts, orderBy);
  const n = acts.length;
  const titles = sorted.map(firstTitle).filter((t): t is string => t !== undefined);
  const withAgg = tpl
    .replace(/\{n\}/g, String(n))
    .replace(/\{s\}/g, n === 1 ? "" : "s")
    .replace(/\{titles\}/g, titles.slice(0, 4).join(", ") + (titles.length > 4 ? "…" : ""))
    .replace(/\{first\}/g, titles[0] ?? "");
  return renderTemplate(withAgg, sorted.length ? sorted[0].bindings : new Map());
}

function renderFindings(acts: FindingActivation[]): PlaybookFinding[] {
  const groups = new Map<string, FindingActivation[]>();
  const order: string[] = [];
  for (const a of acts) {
    const key = `${a.rule.id}::${a.action.finding}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(a);
  }
  const out: PlaybookFinding[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    const { rule, action } = g[0];
    if (action.aggregate) {
      const sorted = sortByOrder(g, action.orderBy);
      const titles = sorted.map(firstTitle).filter((t): t is string => t !== undefined);
      const leafPart = g[0].why.includes(" — ") ? g[0].why.split(" — ").slice(1).join(" — ") : g[0].why;
      out.push({
        ruleId: rule.id, ruleName: rule.name, kind: action.finding, icon: action.icon,
        text: renderAggregate(action.aggregate, g, action.orderBy),
        fix: action.fix ? renderAggregate(action.fix, g, action.orderBy) : undefined,
        why: `rule ${rule.id} · ${g.length} matched ("${titles.slice(0, 4).join('", "')}"${titles.length > 4 ? "…" : ""}) — ${leafPart}`,
      });
    } else {
      for (const a of g) {
        out.push({
          ruleId: rule.id, ruleName: rule.name, kind: action.finding, icon: action.icon,
          text: renderTemplate(action.text ?? "", a.bindings),
          fix: action.fix ? renderTemplate(action.fix, a.bindings) : undefined,
          why: a.why,
        });
      }
    }
  }
  return out;
}

export interface RunPlaybookOpts {
  rules: Array<Rule | RuleRecord>;
  facts: FactSet;
  eventName?: string;
}

const MAX_ITERATIONS = 100;

export function runPlaybook(opts: RunPlaybookOpts): PlaybookRunResult {
  const rules = opts.rules.map(asRule).filter((r) => {
    if (r.active === false) return false;
    const on = r.on;
    // Event-scoped rules run only when eventName is set and listed;
    // rules without `on` run only in normal (non-event) runs.
    if (opts.eventName != null) return !!on && on.length > 0 && on.includes(opts.eventName);
    return !on || on.length === 0;
  });

  // Copy the collections (shallow): asserted facts must not leak into the
  // caller's arrays, and a run must be repeatable from the same input.
  const facts: FactSet = {};
  for (const [k, v] of Object.entries(opts.facts)) facts[k] = [...v];

  const specCache = new Map<string, number>();
  const spec = (r: Rule): number => {
    let s = specCache.get(r.id);
    if (s === undefined) { s = specificity(r); specCache.set(r.id, s); }
    return s;
  };

  const firedKeys = new Set<string>();
  const findingActs: FindingActivation[] = [];
  const suggestions: PlaybookSuggestion[] = [];
  const flags: PlaybookFlag[] = [];
  const asserted: Record<string, number> = {};
  let fired = 0;
  let capped = false;

  for (;;) {
    if (fired >= MAX_ITERATIONS) { capped = true; break; }
    const agenda: Activation[] = [];
    for (const rule of rules) {
      for (const act of matchRule(rule, facts)) {
        const key = `${rule.id}|${stableStringify(Object.fromEntries(act.bindings))}`;
        if (firedKeys.has(key)) continue; // refraction
        agenda.push(act);
      }
    }
    if (!agenda.length) break;
    // Conflict resolution: salience desc, specificity desc, rule id asc.
    // Array.sort is stable, so same-rule activations keep fact array order.
    agenda.sort((a, b) =>
      (b.rule.salience ?? 50) - (a.rule.salience ?? 50) ||
      spec(b.rule) - spec(a.rule) ||
      (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
    const act = agenda[0];
    firedKeys.add(`${act.rule.id}|${stableStringify(Object.fromEntries(act.bindings))}`);
    fired++;

    for (const action of act.rule.then) {
      if ("assert" in action) {
        const coll = action.assert;
        const fact: Fact = {};
        for (const [k, v] of Object.entries(action.facts ?? {})) fact[k] = renderFactValue(v, act.bindings);
        (facts[coll] ??= []).push(fact);
        asserted[coll] = (asserted[coll] ?? 0) + 1;
      } else if ("finding" in action) {
        findingActs.push({ rule: act.rule, action, bindings: act.bindings, why: act.why });
      } else if ("suggest" in action) {
        suggestions.push({
          ruleId: act.rule.id, ruleName: act.rule.name,
          text: renderTemplate(action.suggest, act.bindings),
          chips: [...(action.chips ?? [])], why: act.why,
        });
      } else if ("flag" in action) {
        flags.push({
          ruleId: act.rule.id, kind: action.flag,
          entity: action.entity ? renderTemplate(action.entity, act.bindings) : undefined,
          why: act.why,
        });
      }
    }
  }

  return {
    findings: renderFindings(findingActs),
    suggestions, flags, asserted, fired, capped,
  };
}

// ---- rule validation ------------------------------------------------------------

const OPERATORS = new Set<string>([
  "equal", "notEqual",
  "greaterThan", "greaterThanInclusive", "lessThan", "lessThanInclusive",
  "in", "notIn", "contains", "startsWith", "endsWith",
]);

function validateCondition(c: unknown, path: string, errs: string[]): void {
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    errs.push(`${path}: condition must be an object`);
    return;
  }
  const cond = c as Record<string, unknown>;
  if ("not" in cond) { validateCondition(cond.not, `${path}.not`, errs); return; }
  if ("fact" in cond) {
    if (typeof cond.fact !== "string" || !cond.fact.trim()) errs.push(`${path}: fact must be a non-empty string`);
    if (typeof cond.operator !== "string" || !OPERATORS.has(cond.operator)) {
      errs.push(`${path}: unknown operator ${JSON.stringify(cond.operator)}`);
    }
    if (!("value" in cond)) errs.push(`${path}: leaf condition needs a value`);
    return;
  }
  if (typeof cond.subject !== "string" || !cond.subject.trim()) {
    errs.push(`${path}: subject must be a non-empty string`);
  }
  if (cond.as !== undefined && typeof cond.as !== "string") errs.push(`${path}: as must be a string`);
  if (cond.where !== undefined && (typeof cond.where !== "object" || cond.where === null || Array.isArray(cond.where))) {
    errs.push(`${path}: where must be an object`);
  }
  for (const key of ["all", "any"] as const) {
    if (cond[key] !== undefined) {
      if (!Array.isArray(cond[key])) errs.push(`${path}: ${key} must be an array`);
      else (cond[key] as unknown[]).forEach((x, i) => validateCondition(x, `${path}.${key}[${i}]`, errs));
    }
  }
}

function validateAction(a: unknown, path: string, errs: string[]): void {
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    errs.push(`${path}: action must be an object`);
    return;
  }
  const act = a as Record<string, unknown>;
  if ("finding" in act) {
    if (typeof act.finding !== "string" || !act.finding.trim()) errs.push(`${path}: finding kind must be a non-empty string`);
    if (typeof act.icon !== "string" || !act.icon) errs.push(`${path}: finding needs an icon`);
  } else if ("suggest" in act) {
    if (typeof act.suggest !== "string" || !act.suggest.trim()) errs.push(`${path}: suggest needs text`);
  } else if ("assert" in act) {
    if (typeof act.assert !== "string" || !act.assert.trim()) errs.push(`${path}: assert needs a collection name`);
  } else if ("flag" in act) {
    if (typeof act.flag !== "string" || !act.flag.trim()) errs.push(`${path}: flag needs a kind`);
  } else {
    errs.push(`${path}: unknown action (need finding, suggest, assert, or flag)`);
  }
}

/** Structural validation of a rule object. Returns error strings; empty = valid. */
export function validateRule(r: unknown): string[] {
  const errs: string[] = [];
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["rule must be an object"];
  const rule = r as Record<string, unknown>;
  if (typeof rule.id !== "string" || !rule.id.trim()) errs.push("id must be a non-empty string");
  if (typeof rule.name !== "string" || !rule.name.trim()) errs.push("name must be a non-empty string");
  if (!Array.isArray(rule.when)) errs.push("when must be an array");
  else rule.when.forEach((c, i) => validateCondition(c, `when[${i}]`, errs));
  if (!Array.isArray(rule.then) || rule.then.length === 0) errs.push("then must be a non-empty array");
  else rule.then.forEach((a, i) => validateAction(a, `then[${i}]`, errs));
  if (rule.salience !== undefined && (typeof rule.salience !== "number" || !Number.isFinite(rule.salience))) {
    errs.push("salience must be a number");
  }
  if (rule.on !== undefined && (!Array.isArray(rule.on) || (rule.on as unknown[]).some((e) => typeof e !== "string"))) {
    errs.push("on must be an array of event-name strings");
  }
  if (rule.active !== undefined && typeof rule.active !== "boolean") errs.push("active must be a boolean");
  return errs;
}

// ---- storage ---------------------------------------------------------------------

const STARTER_RULES: Rule[] = starterRulesJson as unknown as Rule[];

let db: Database | null = null;

function needDb(): Database {
  if (!db) throw new Error("playbook DB not initialized");
  return db;
}

function userDataDir(): string {
  return process.env.MILTON_DATA || "./data";
}

export function initPlaybookDb(database: Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      salience INTEGER NOT NULL DEFAULT 50,
      active INTEGER NOT NULL DEFAULT 1,
      rule_json TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 1
    );
  `);
  const row = db.query("SELECT COUNT(*) AS n FROM playbook_rules").get() as { n: number } | null;
  if (Number(row?.n || 0) === 0) {
    for (const r of STARTER_RULES) {
      const errs = validateRule(r);
      if (errs.length) {
        console.warn(`[playbook] skipping invalid starter rule ${(r as Rule)?.id}: ${errs.join("; ")}`);
        continue;
      }
      db.query(
        "INSERT INTO playbook_rules (id, name, salience, active, rule_json, builtin) VALUES (?, ?, ?, 1, ?, 1)"
      ).run(r.id, r.name, r.salience ?? 50, JSON.stringify(r));
    }
  }
}

/** User overrides from ${MILTON_DATA}/playbook.user.json (a JSON array of rules).
 *  Malformed file or entries → console.warn + ignore, never crash. */
function readUserOverrides(): Array<{ rule: Rule; active?: boolean }> {
  const file = `${userDataDir()}/playbook.user.json`;
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[playbook] ignoring malformed ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[playbook] ignoring ${file}: expected a JSON array of rules`);
    return [];
  }
  const out: Array<{ rule: Rule; active?: boolean }> = [];
  for (const entry of parsed) {
    const errs = validateRule(entry);
    if (errs.length) {
      console.warn(`[playbook] ignoring invalid user rule ${(entry as { id?: unknown })?.id}: ${errs.join("; ")}`);
      continue;
    }
    const rule = entry as Rule;
    out.push({
      rule,
      active: typeof (entry as { active?: unknown }).active === "boolean"
        ? (entry as { active: boolean }).active
        : undefined,
    });
  }
  return out;
}

/** All rules: DB rows overlaid with user-file overrides (by id). Overrides
 *  get builtin:false; an explicit `active` in the user file wins. */
export function loadRules(): RuleRecord[] {
  const d = needDb();
  const rows = d.query(
    "SELECT id, name, salience, active, rule_json, builtin FROM playbook_rules"
  ).all() as Array<{ id: string; name: string; salience: number; active: number; rule_json: string; builtin: number }>;
  const byId = new Map<string, RuleRecord>();
  for (const r of rows) {
    let rule: Rule;
    try {
      rule = JSON.parse(r.rule_json) as Rule;
    } catch {
      console.warn(`[playbook] skipping rule ${r.id}: rule_json does not parse`);
      continue;
    }
    byId.set(r.id, {
      id: r.id, name: r.name, salience: Number(r.salience ?? 50),
      active: r.active !== 0, builtin: r.builtin !== 0, rule,
    });
  }
  for (const { rule, active } of readUserOverrides()) {
    const existing = byId.get(rule.id);
    byId.set(rule.id, {
      id: rule.id,
      name: rule.name,
      salience: rule.salience ?? 50,
      active: active !== undefined ? active : (existing ? existing.active : true),
      builtin: false,
      rule,
    });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function listRules(): RuleRecord[] {
  return loadRules();
}

export function getRule(id: string): RuleRecord | undefined {
  return loadRules().find((r) => r.id === id);
}

/**
 * Flip a rule's active flag. Updates the DB row; returns false when the id is
 * unknown or exists only in the user file (the chat layer tells the user to
 * edit the file instead).
 */
export function setRuleActive(id: string, active: boolean): boolean {
  const d = needDb();
  const row = d.query("SELECT id FROM playbook_rules WHERE id = ?").get(id) as { id: string } | null;
  if (!row) return false;
  d.query("UPDATE playbook_rules SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  return true;
}

/**
 * Re-apply the starter set (e.g. after an upgrade): upsert every starter rule —
 * update name/salience/rule_json, preserve existing `active` flags, insert
 * missing ids. Returns {builtins, overrides} counts.
 */
export function reloadPlaybook(): { builtins: number; overrides: number } {
  const d = needDb();
  let builtins = 0;
  for (const r of STARTER_RULES) {
    const errs = validateRule(r);
    if (errs.length) {
      console.warn(`[playbook] skipping invalid starter rule ${r.id}: ${errs.join("; ")}`);
      continue;
    }
    const existing = d.query("SELECT id FROM playbook_rules WHERE id = ?").get(r.id) as { id: string } | null;
    if (existing) {
      d.query("UPDATE playbook_rules SET name = ?, salience = ?, rule_json = ? WHERE id = ?")
        .run(r.name, r.salience ?? 50, JSON.stringify(r), r.id);
    } else {
      d.query(
        "INSERT INTO playbook_rules (id, name, salience, active, rule_json, builtin) VALUES (?, ?, ?, 1, ?, 1)"
      ).run(r.id, r.name, r.salience ?? 50, JSON.stringify(r));
    }
    builtins++;
  }
  const overrides = readUserOverrides().length;
  return { builtins, overrides };
}

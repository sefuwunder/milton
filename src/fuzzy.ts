// fuzzy.ts — deterministic fuzzy language interpreter for Milton.
//
// Sits IN FRONT OF (never replacing) the exact regex parser in intents.ts:
//   1. parseIntent(raw) runs first; any non-"unknown" result wins outright.
//   2. Only when the exact parser gives up does the fuzzy layer score intents
//      by typo-tolerant keyword + phrase matching (synonyms, any word order).
//   3. The winner's matched keywords are canonicalized IN PLACE inside the
//      original token stream (typos repaired, synonyms normalized, filler
//      dropped) and the canonical command is fed back through parseIntent,
//      so ALL slot extraction (dates, money, stages, names) reuses the exact
//      parser's battle-tested logic on the user's raw entity text. Entities
//      are never normalized away: only tokens that fuzzy-match a known
//      keyword are rewritten; everything else passes through verbatim.
//   4. Below threshold -> "unknown" (existing path). Near-tie between top
//      candidates -> "disambiguate_intent" for the existing numbered choice
//      flow. Ties are broken by a fixed per-intent priority — never random.
//
// Fully deterministic: no ML, no randomness, no Date/clock use.

import { parseIntent, type Intent, type IntentName } from "./intents";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const CONTRACTIONS: [RegExp, string][] = [
  [/\bwhat's\b/g, "what is"], [/\bwhere's\b/g, "where is"],
  [/\bwho's\b/g, "who is"], [/\bhow's\b/g, "how is"],
  [/\bit's\b/g, "it is"], [/\bthat's\b/g, "that is"],
  [/\bthere's\b/g, "there is"], [/\bhere's\b/g, "here is"],
  [/\bi'm\b/g, "i am"], [/\bi've\b/g, "i have"], [/\bi'll\b/g, "i will"],
  [/\bdon't\b/g, "do not"], [/\bdoesn't\b/g, "does not"],
  [/\bcan't\b/g, "can not"], [/\bwon't\b/g, "will not"],
  [/\blet's\b/g, "let us"], [/\bwe're\b/g, "we are"],
  [/\byou're\b/g, "you are"],
];

export function expandContractions(s: string): string {
  let t = ` ${s} `;
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, ` ${to} `);
  return t.replace(/\s+/g, " ").trim();
}

/** Aggressive normalization for MATCHING only. Slot extraction always works
 *  from the raw token stream, so this may discard punctuation freely. */
export function normalizeForMatch(s: string): string {
  return expandContractions(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s$/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Bounded Damerau-Levenshtein (optimal string alignment) with early exit.
//
// Why Damerau over plain Levenshtein: adjacent transpositions ("shwo" ->
// "show", "clsoe" -> "close", "daels" -> "deal") are the single most common
// human typo class, and plain Levenshtein scores each as 2 edits — which
// blows the tight per-word distance budgets we need to keep short command
// verbs ("add", "get", "run") from colliding with everyday words. The bound
// scales with word length (<=1 for len <= 3, <=2 above) and the DP bails out
// of a row the moment its minimum exceeds the bound, so pathological inputs
// stay cheap. Deterministic, no allocations beyond three short rows.
// ---------------------------------------------------------------------------

export function boundedEdit(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  let n = a.length, m = b.length;
  if (Math.abs(n - m) > maxDist) return maxDist + 1;
  if (n === 0) return m;
  if (m === 0) return n;
  if (n > m) { const t = a; a = b; b = t; const u = n; n = m; m = u; } // n <= m
  let pp = new Array<number>(n + 1), pr = new Array<number>(n + 1), cu = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) pr[i] = i;
  for (let j = 1; j <= m; j++) {
    cu[0] = j;
    let rowMin = j;
    const bj = b[j - 1];
    for (let i = 1; i <= n; i++) {
      const cost = a[i - 1] === bj ? 0 : 1;
      let v = pr[i] + 1;
      const ins = cu[i - 1] + 1;
      if (ins < v) v = ins;
      const sub = pr[i - 1] + cost;
      if (sub < v) v = sub;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === bj) {
        const tr = pp[i - 2] + 1; // adjacent transposition
        if (tr < v) v = tr;
      }
      cu[i] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1;
    const t = pp; pp = pr; pr = cu; cu = t;
  }
  const d = pr[n];
  return d <= maxDist ? d : maxDist + 1;
}

/** Max edit distance for a token/alias pair: short words get a tight budget
 *  so "add" can't match "and", longer words get room for two typos. */
export function maxDistFor(a: string, b: string): number {
  return Math.min(a.length, b.length) <= 3 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Matcher declarations — one place per intent: keywords (alias -> canonical
// word, weight), multi-word trigger phrases (partial credit), the minimum
// credit to win, a fixed tie-break priority, a human label, and a builder
// that assembles the canonical command for the exact parser.
// ---------------------------------------------------------------------------

/** Filler words dropped from the canonical command. Conservative: only words
 *  that can never carry meaning in any intent ("my"/"it"/"the" are kept —
 *  exact regexes depend on some of them). */
const FILLER = new Set([
  "hey", "hi", "hello", "yo", "please", "kindly", "thanks", "thank",
  "milton", "bot", "assistant", "could", "would", "should", "can", "you",
  "um", "uh", "hmm", "well", "actually", "really", "just", "now", "like",
]);

const MAX_TOKENS = 64; // tokens beyond this still reach slots, but aren't matched
const TIE_GAP = 1.0;   // top-two credits closer than this -> disambiguate

/** Small-talk markers. When one is present, only candidates with a STRONG
 *  keyword (weight >= 2.5) may win — "tell me a joke about crm" is chatter
 *  for the LLM fallback, not a deal_detail command built on "tell"/"about". */
const CHATTER = new Set([
  "joke", "jokes", "joking", "funny", "story", "stories",
  "poem", "poems", "song", "songs", "weather",
]);

type Tag = "stage" | "won" | "lost" | undefined;

interface Kw { a: string; c: string; w: number; tag?: Tag; x?: 1 }
interface Ph { w: string[]; wgt: number; tag?: Tag }
interface FuzzInfo { stageAlias?: string; wonLost?: string }

/** K(canonical, weight, ...aliases) — one keyword family. */
function K(c: string, w: number, ...aliases: string[]): Kw[] {
  return [c, ...aliases].map((a) => ({ a, c, w }));
}
function P(phrase: string, wgt: number, tag?: Tag): Ph {
  return { w: normalizeForMatch(phrase).split(" "), wgt, tag };
}

export interface FuzzMatcher {
  intent: IntentName;
  label: string;
  kw: Kw[];
  ph: Ph[];
  need: number;      // minimum credit to be a candidate
  pri: number;       // tie-break priority (lower wins); fixed order, never random
  mustHave?: string[]; // at least one consumed canonical must be in this set:
                       // an action intent needs its action verb ("deal acme"
                       // is not a delete/add without "delete"/"add")
  veto?: (tokens: string[]) => boolean; // hard semantic exclusion ("add a note"
                       // is never add_deal); vetoed != failed, so it can't claim
  remBonus: number;  // extra credit when unmatched content tokens remain
  noRemBonus: number;// extra credit when nothing remains (bare command)
  build: (toks: string[], info: FuzzInfo) => string | null;
}

const drop = (toks: string[], ws: string[]): string[] =>
  toks.filter((t) => !ws.includes(t));

const SHOW = ["show", "list", "display", "view", "get", "gimme"];
const DEALN = ["deal", "deals", "opportunity", "opportunities", "opp", "opps"];
const ART = ["the", "a", "an"];

// ---- custom fields (exec-crm /api/custom-fields) -------------------------------
// Fuzzy companions to the exact matchers in intents.ts: typo-tolerant and
// paraphrase-tolerant ("creat a custom feild X for contacts",
// "what custom fields do contacts have"). Builds re-emit the canonical
// command, which the exact parser must accept (check in parseIntentFuzzy).
const CF_KW = [
  ...K("custom", 2.5),
  ...K("field", 2.5, "fields", "attribute", "attributes"),
  ...K("campaigns", 2, "campaign"),
  ...K("contacts", 2, "contact"),
  ...K("companies", 2, "company"),
  ...K("tasks", 2, "task"),
];
const CF_SING: Record<string, string> = {
  campaigns: "campaign", contacts: "contact", companies: "company", tasks: "task", deals: "deal",
};
/** Without a "custom"/"field" word this isn't a field command — "get me my
 *  tasks" must stay a task list, and a strong-but-failed read here would
 *  claim the tokens and break nearby ties. */
const CF_WORDS = ["custom", "field", "fields", "attribute", "attributes"];
const noCfWords = (toks: string[]) => !toks.some((t) => CF_WORDS.includes(t));
/** First entity word, canonical plural; deals included so "set X to Y for
 *  deal Z" reaches the exact parser's not-supported-on-deals explanation. */
function cfEnt(low: string[]): string | null {
  for (const x of low) {
    if (x === "campaigns" || x === "campaign") return "campaigns";
    if (x === "contacts" || x === "contact") return "contacts";
    if (x === "companies" || x === "company") return "companies";
    if (x === "tasks" || x === "task") return "tasks";
    if (x === "deals" || x === "deal") return "deals";
  }
  return null;
}
/** Explicit "of type <t>" / "type <t>" only — a type word inside the name
 *  ("Renewal date") is not an explicit type; brain.ts infers date from those. */
function cfType(low: string[]): string {
  const TYPES = ["text", "number", "date", "checkbox"];
  for (let i = 0; i < low.length; i++) {
    if (low[i] === "type" && TYPES.includes(low[i + 1])) return low[i + 1];
  }
  return "";
}

// Stage alias keys (must match STAGE_ALIASES keys in intents.ts, single-word).
const STAGE_KEYS = [
  "prospecting", "prospect", "qualification", "qualifying", "qualified",
  "proposal", "proposals", "negotiation", "negotiating",
  "won", "closedwon", "win", "lost", "closedlost", "lose",
];
const STAGE_KW: Kw[] = STAGE_KEYS.map((k) => ({ a: k, c: k, w: 1.5, tag: "stage" as Tag }));

function dealsBuild(toks: string[], info: FuzzInfo): string | null {
  if (info.stageAlias) return `show ${info.stageAlias} deals`;
  const rest = drop(toks[0] === "show" ? toks.slice(1) : toks, [...ART, "me", "my", "mine"]);
  const s = rest.join(" ");
  if (/^(deals?|open deals?|all deals?|my deals?|opportunit(ies|y))$/.test(s)) return "deals";
  if (!s) return "deals";
  return `show ${s} deals`;
}

const MATCHERS: FuzzMatcher[] = [
  {
    intent: "help", label: "show help", need: 3, pri: 76, remBonus: 0, noRemBonus: 0,
    kw: [...K("help", 4), ...K("commands", 3, "command")],
    ph: [P("what can you do", 5)],
    build: () => "help",
  },
  {
    intent: "pipeline", label: "show pipeline", need: 3, pri: 56, remBonus: 0, noRemBonus: 0,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("pipeline", 3), ...K("funnel", 3), ...K("board", 2.5), ...K("summary", 1)],
    ph: [P("sales pipeline", 2)],
    build: () => "pipeline",
  },
  {
    intent: "deals", label: "list deals", need: 2.5, pri: 21, remBonus: 0, noRemBonus: 1,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("deal", 2.5, ...DEALN.slice(1)), ...K("open", 1), ...K("all", 0.5), ...K("my", 0.5), ...STAGE_KW],
    ph: [P("closed won", 2, "stage"), P("closed lost", 2, "stage")],
    build: dealsBuild,
  },
  {
    intent: "deal_detail", label: "show a deal", need: 3, pri: 19, remBonus: 1.5, noRemBonus: 0,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("deal", 2.5, ...DEALN.slice(1)), ...K("open", 1), ...K("about", 1), ...K("tell", 1)],
    ph: [P("tell me about", 3)],
    build: (t) => {
      const core = drop(t, [...SHOW, ...DEALN, "open", "about", "me", "my", "tell", ...ART]);
      if (!core.length) return null;
      return t.includes("who") ? `who is ${core.join(" ")}` : `show deal ${core.join(" ")}`;
    },
  },
  {
    intent: "kpis", label: "show KPIs", need: 3, pri: 55, remBonus: 0, noRemBonus: 0,
    kw: [...K("kpis", 4, "kpi"), ...K("metrics", 3, "metric"), ...K("dashboard", 2)],
    ph: [P("how are we doing", 4), P("key metrics", 2.5)],
    build: () => "kpis",
  },
  {
    intent: "tasks", label: "list tasks", need: 2.5, pri: 22, remBonus: 0, noRemBonus: 1,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("task", 2.5, "tasks", "todo", "todos"), ...K("open", 1), ...K("pending", 1.5), { a: "due", c: "due", w: 1.5, x: 1 }, ...K("my", 0.5), ...K("all", 0.5), ...K("completed", 2, "finished"), { a: "done", c: "done", w: 2, x: 1 }],
    ph: [],
    build: (t) => {
      if (t.includes("completed") || t.includes("done") || t.includes("finished")) return "completed tasks";
      const core = drop(t, [...SHOW, "list", "task", "tasks", "todo", "todos", "my", "open", "pending", "all", ...ART, "for", "about", "on"]);
      return core.length ? `show tasks ${core.join(" ")}` : "tasks";
    },
  },
  {
    intent: "contacts", label: "list contacts", need: 2.5, pri: 23, remBonus: 0, noRemBonus: 1,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("contact", 2.5, "contacts"), ...K("named", 1), ...K("called", 1), ...K("like", 0.5), ...K("find", 1), ...K("my", 0.5)],
    ph: [],
    build: (t) => {
      const core = drop(t, [...SHOW, "list", "find", "contact", "contacts", "named", "called", "like", "for", ...ART, "my", "all"]);
      if (!core.length) return "contacts";
      const q = ["named", "called", "like", "for"].find((w) => t.includes(w)) || "for";
      return `contacts ${q} ${core.join(" ")}`;
    },
  },
  {
    intent: "contact_detail", label: "show a contact", need: 3, pri: 20, remBonus: 1.5, noRemBonus: 0,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("contact", 2.5, "contacts"), ...K("about", 1), ...K("tell", 1), ...K("who", 1.5)],
    ph: [P("tell me about", 3), P("who is", 3)],
    build: (t) => {
      const core = drop(t, [...SHOW, "list", "find", "lookup", "contact", "contacts", "about", "me", "tell", "who", "is", ...ART]);
      if (!core.length) return null;
      return t.includes("who") ? `who is ${core.join(" ")}` : `show contact ${core.join(" ")}`;
    },
  },
  {
    intent: "companies", label: "list companies", need: 2.5, pri: 24, remBonus: 0, noRemBonus: 1,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("company", 2.5, "companies", "account", "accounts"), ...K("find", 1), ...K("my", 0.5), ...K("all", 0.5)],
    ph: [],
    build: (t) => {
      const core = drop(t, [...SHOW, "list", "find", "company", "companies", "account", "accounts", ...ART, "my", "all"]);
      return core.length ? `company ${core.join(" ")}` : "companies";
    },
  },
  {
    intent: "brief", label: "morning brief", need: 3, pri: 53, remBonus: 0, noRemBonus: 0,
    kw: [...K("brief", 3, "briefing"), ...K("morning", 2), ...K("daily", 1.5), ...K("digest", 2)],
    ph: [P("brief me", 4)],
    build: () => "morning brief",
  },
  {
    intent: "hygiene", label: "pipeline hygiene", need: 3, pri: 54, remBonus: 0, noRemBonus: 0,
    kw: [...K("hygiene", 3.5), ...K("health", 2), ...K("cleanup", 2.5, "clean"), ...K("stale", 3), ...K("pipeline", 1), ...K("attention", 2)],
    ph: [P("needs attention", 4), P("what needs attention", 4), P("health check", 3)],
    build: () => "pipeline hygiene",
  },
  {
    intent: "add_deal", label: "add a deal", need: 4, pri: 11, remBonus: 1, noRemBonus: 0,
    mustHave: ["add"],
    veto: (t) => t.includes("note") || t.includes("notes"),
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...K("deal", 2.5, ...DEALN.slice(1))],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "insert", ...DEALN, ...ART]);
      return core.length ? `add deal ${core.join(" ")}` : null;
    },
  },
  {
    intent: "move_deal", label: "move a deal", need: 4, pri: 8, remBonus: 1, noRemBonus: 0,
    kw: [...K("move", 3, "shift", "put", "transfer"), ...K("deal", 2.5, ...DEALN.slice(1)), ...K("to", 0.5), ...STAGE_KW],
    ph: [P("closed won", 2, "stage"), P("closed lost", 2, "stage")],
    build: (t, info) => {
      const core = drop(t, ["move", "shift", "put", "transfer", ...DEALN, ...ART, ...STAGE_KEYS, "closed", "won", "lost"]);
      if (!core.length) return null;
      if (info.stageAlias) {
        const bare = drop(core, ["to"]);
        return `move deal ${bare.join(" ")} to ${info.stageAlias}`;
      }
      return `move deal ${core.join(" ")}`;
    },
  },
  {
    intent: "close_deal", label: "close a deal", need: 4, pri: 2, remBonus: 1, noRemBonus: 0,
    kw: [
      ...K("close", 3, "mark", "shut"),
      ...K("deal", 2, ...DEALN.slice(1)),
      { a: "won", c: "won", w: 2.5, tag: "won" as Tag },
      { a: "lost", c: "lost", w: 2.5, tag: "lost" as Tag },
    ],
    ph: [],
    build: (t) => {
      const hasOutcome = t.includes("won") || t.includes("lost");
      if (!hasOutcome) return null; // never invent won vs lost
      const core = drop(t, ["close", "mark", "shut", ...DEALN, ...ART]);
      return `close ${core.join(" ")}`;
    },
  },
];

const MORE: FuzzMatcher[] = [
  {
    intent: "delete_deal", label: "delete a deal", need: 4, pri: 3, remBonus: 1, noRemBonus: 0,
    mustHave: ["delete"],
    kw: [...K("delete", 3, "remove", "drop", "kill", "erase", "cancel"), ...K("deal", 2.5, ...DEALN.slice(1))],
    ph: [],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "drop", "kill", "erase", "cancel", ...DEALN, ...ART]);
      return core.length ? `delete deal ${core.join(" ")}` : null;
    },
  },
  {
    intent: "set_deal_field", label: "update a deal field", need: 4, pri: 10, remBonus: 1, noRemBonus: 0,
    kw: [...K("update", 2.5, "set", "edit", "change", "modify"), ...K("deal", 1.5, ...DEALN.slice(1)),
      ...K("value", 2, "worth", "amount"), ...K("probability", 2, "chance"), ...K("owner", 2), ...K("contact", 1.5), ...K("company", 1.5)],
    ph: [P("close date", 2.5), P("expected close", 2.5)],
    build: (t) => {
      const toks = ["update", "set"].includes(t[0]) ? t : ["update", ...t];
      return toks.join(" ");
    },
  },
  {
    intent: "add_task", label: "add a task", need: 4, pri: 12, remBonus: 1, noRemBonus: 0,
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...K("task", 2.5, "tasks", "todo", "todos")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "insert", "task", "tasks", "todo", "todos", ...ART]);
      return core.length ? `add task ${core.join(" ")}` : null;
    },
  },
  {
    intent: "complete_task", label: "complete a task", need: 4, pri: 6, remBonus: 1, noRemBonus: 0,
    kw: [...K("complete", 3, "finish", "done"), ...K("task", 2, "tasks", "todo", "todos"), ...K("mark", 1)],
    ph: [P("check off", 3), P("mark as done", 3)],
    build: (t) => {
      const core = drop(t, ["complete", "finish", "done", "check", "off", "mark", "as", "task", "tasks", "todo", "todos", ...ART]);
      return core.length ? `complete task ${core.join(" ")}` : null;
    },
  },
  {
    intent: "reopen_task", label: "reopen a task", need: 4, pri: 7, remBonus: 1, noRemBonus: 0,
    kw: [...K("reopen", 3.5, "uncomplete"), ...K("task", 2, "tasks", "todo", "todos")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["reopen", "uncomplete", "task", "tasks", "todo", "todos", ...ART]);
      return core.length ? `reopen task ${core.join(" ")}` : null;
    },
  },
  {
    intent: "delete_task", label: "delete a task", need: 4, pri: 4, remBonus: 1, noRemBonus: 0,
    kw: [...K("delete", 3, "remove", "drop", "kill", "erase"), ...K("task", 2.5, "tasks", "todo", "todos")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "drop", "kill", "erase", "task", "tasks", "todo", "todos", ...ART]);
      return core.length ? `delete task ${core.join(" ")}` : null;
    },
  },
  {
    intent: "add_contact", label: "add a contact", need: 4, pri: 13, remBonus: 1, noRemBonus: 0,
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...K("contact", 2.5, "contacts")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "insert", "contact", "contacts", ...ART]);
      return core.length ? `add contact ${core.join(" ")}` : null;
    },
  },
  {
    intent: "add_company", label: "add a company", need: 4, pri: 14, remBonus: 1, noRemBonus: 0,
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...K("company", 2.5, "companies", "account", "accounts")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "insert", "company", "companies", "account", "accounts", ...ART]);
      return core.length ? `add company ${core.join(" ")}` : null;
    },
  },
  {
    intent: "add_campaign", label: "add a campaign", need: 4, pri: 15, remBonus: 1, noRemBonus: 0,
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...K("campaign", 2.5, "campaigns")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "insert", "campaign", "campaigns", ...ART]);
      return core.length ? `add campaign ${core.join(" ")}` : null;
    },
  },
  {
    intent: "import_contacts", label: "import contacts", need: 3, pri: 71, remBonus: 0, noRemBonus: 0,
    kw: [...K("import", 3), ...K("contacts", 2, "contact"), ...K("vcf", 3), ...K("vcard", 3)],
    ph: [],
    build: () => "import contacts",
  },
  {
    intent: "capture", label: "log who I met", need: 3.5, pri: 52, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("met", 3), ...K("meet", 2, "meeting")],
    ph: [P("i met", 3)],
    build: (t) => {
      const core = drop(t, ["i", "just", "met", "meet", "meeting", ...ART]);
      return core.length ? `i met ${core.join(" ")}` : null;
    },
  },
  {
    intent: "remind_add", label: "add a reminder", need: 4, pri: 25, remBonus: 1, noRemBonus: 0,
    kw: [...K("remind", 3, "reminds"), ...K("reminder", 2.5, "reminders")],
    ph: [P("remind me", 4)],
    build: (t) => {
      const core = drop(t, ["remind", "reminds", "reminder", "reminders", "me"]);
      return core.length ? `remind me ${core.join(" ")}` : null;
    },
  },
  {
    intent: "remind_list", label: "list reminders", need: 3, pri: 27, remBonus: 0, noRemBonus: 0,
    kw: [...K("reminders", 3, "reminder"), ...K("remind", 2), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5)],
    ph: [],
    build: () => "reminders",
  },
  {
    intent: "remind_cancel", label: "cancel a reminder", need: 4, pri: 26, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("cancel", 2.5, "delete", "remove"), ...K("reminder", 3, "reminders")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["cancel", "delete", "remove", "reminder", "reminders", ...ART]);
      return core.length ? `cancel reminder ${core.join(" ")}` : null;
    },
  },
  {
    intent: "save_routine", label: "save a routine", need: 4, pri: 28, remBonus: 0, noRemBonus: 0,
    kw: [...K("save", 2.5, "create"), ...K("routine", 3, "routines")],
    ph: [],
    build: (t) => t.join(" "),
  },
  {
    intent: "run_routine", label: "run a routine", need: 3.5, pri: 29, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("run", 3), ...K("routine", 2.5, "routines"), ...K("my", 0.5)],
    ph: [],
    build: (t) => {
      const core = drop(t, ["run", "routine", "routines", "my", ...ART]);
      return core.length ? `run ${core.join(" ")}` : null;
    },
  },
  {
    intent: "list_routines", label: "list routines", need: 3, pri: 63, remBonus: 0, noRemBonus: 0,
    kw: [...K("routines", 3, "routine"), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5)],
    ph: [],
    build: () => "routines",
  },
  {
    intent: "show_routine", label: "show a routine", need: 3.5, pri: 30, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("show", 1.5, ...SHOW.slice(1)), ...K("routine", 2.5, "routines"), ...K("describe", 2)],
    ph: [],
    build: (t) => {
      const core = drop(t, [...SHOW, "list", "describe", "routine", "routines", "my", ...ART]);
      return core.length ? `routine ${core.join(" ")}` : null;
    },
  },
  {
    intent: "delete_routine", label: "delete a routine", need: 4, pri: 31, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("delete", 3, "remove", "drop"), ...K("routine", 2.5, "routines")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "drop", "routine", "routines", "my", ...ART]);
      return core.length ? `delete routine ${core.join(" ")}` : null;
    },
  },
  {
    intent: "schedule_add", label: "schedule a routine", need: 4, pri: 32, remBonus: 0, noRemBonus: 0,
    kw: [...K("schedule", 3), ...K("routine", 1.5, "routines"), ...K("every", 1.5), ...K("daily", 1.5), ...K("at", 0.5)],
    ph: [P("every weekday", 2)],
    build: (t) => t.join(" "),
  },
  {
    intent: "list_schedules", label: "list schedules", need: 3, pri: 36, remBonus: 0, noRemBonus: 0,
    kw: [...K("schedules", 3, "schedule"), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5)],
    ph: [],
    build: () => "schedules",
  },
  {
    intent: "unschedule", label: "unschedule", need: 3.5, pri: 33, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("unschedule", 3.5, "un-schedule")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["unschedule", "un-schedule", ...ART]);
      return core.length ? `unschedule ${core.join(" ")}` : null;
    },
  },
  {
    intent: "pause_schedule", label: "pause a schedule", need: 4, pri: 34, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("pause", 3), ...K("schedule", 2.5, "schedules")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["pause", "schedule", "schedules", ...ART]);
      return core.length ? `pause schedule ${core.join(" ")}` : null;
    },
  },
  {
    intent: "resume_schedule", label: "resume a schedule", need: 4, pri: 35, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("resume", 3), ...K("schedule", 2.5, "schedules")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["resume", "schedule", "schedules", ...ART]);
      return core.length ? `resume schedule ${core.join(" ")}` : null;
    },
  },
  {
    intent: "trigger_add", label: "add a trigger", need: 4, pri: 37, remBonus: 0, noRemBonus: 0,
    kw: [...K("when", 2), ...K("trigger", 2, "triggers"), ...K("run", 1.5)],
    ph: [],
    build: (t) => {
      const core = drop(t, ["when"]);
      return core.includes("run") ? `when ${core.join(" ")}` : null;
    },
  },
  {
    intent: "list_triggers", label: "list triggers", need: 3, pri: 38, remBonus: 0, noRemBonus: 0,
    kw: [...K("triggers", 3, "trigger"), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5)],
    ph: [],
    build: () => "triggers",
  },
  {
    intent: "delete_trigger", label: "delete a trigger", need: 4, pri: 39, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("delete", 3, "remove", "drop"), ...K("trigger", 2.5, "triggers")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "drop", "trigger", "triggers", ...ART]);
      return core.length ? `delete trigger ${core.join(" ")}` : null;
    },
  },
  {
    intent: "trigger_help", label: "trigger help", need: 3.5, pri: 40, remBonus: 0, noRemBonus: 0,
    kw: [...K("trigger", 2.5, "triggers"), ...K("help", 2)],
    ph: [],
    build: () => "trigger help",
  },
  {
    intent: "list_runs", label: "automation runs", need: 3, pri: 41, remBonus: 0, noRemBonus: 0,
    kw: [...K("runs", 2.5, "run"), ...K("automation", 1.5, "automations"), ...K("history", 1.5)],
    ph: [P("automation runs", 4), P("run history", 3)],
    build: () => "automation runs",
  },
  {
    intent: "list_stages", label: "list stages", need: 3, pri: 62, remBonus: 0, noRemBonus: 0,
    kw: [...K("stages", 3, "stage"), ...K("show", 1, ...SHOW.slice(1)), ...K("pipeline", 1), ...K("my", 0.5)],
    ph: [],
    build: () => "stages",
  },
  {
    intent: "add_stage", label: "add a stage", need: 4, pri: 17, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("add", 3, "create", "new", "make"), ...K("stage", 2.5, "stages")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["add", "create", "new", "make", "stage", "stages", ...ART]);
      return core.length ? `add stage ${core.join(" ")}` : null;
    },
  },
  {
    intent: "rename_stage", label: "rename a stage", need: 4, pri: 18, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("rename", 3), ...K("stage", 2.5, "stages")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["rename", "stage", "stages"]);
      return core.includes("to") ? `rename stage ${core.join(" ")}` : null;
    },
  },
  {
    intent: "delete_stage", label: "delete a stage", need: 4, pri: 5, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("delete", 3, "remove", "drop"), ...K("stage", 2.5, "stages")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "drop", "stage", "stages", ...ART]);
      return core.length ? `delete stage ${core.join(" ")}` : null;
    },
  },
  {
    intent: "move_stage", label: "move a stage", need: 4, pri: 9, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("move", 3, "shift"), ...K("stage", 2.5, "stages")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["move", "shift", "stage", "stages", ...ART]);
      return core.includes("before") || core.includes("after") ? `move stage ${core.join(" ")}` : null;
    },
  },
  {
    intent: "search", label: "search", need: 3, pri: 61, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("search", 3), ...K("find", 2), ...K("look", 1.5, "lookup")],
    ph: [P("look up", 2)],
    build: (t) => {
      const core = drop(t, ["search", "find", "look", "lookup", "up", "for", ...ART]);
      return core.length ? `search ${core.join(" ")}` : null;
    },
  },
  {
    intent: "list_workspaces", label: "list workspaces", need: 3, pri: 64, remBonus: 0, noRemBonus: 0,
    kw: [...K("workspaces", 3, "workspace"), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5)],
    ph: [],
    build: () => "workspaces",
  },
  {
    intent: "switch_workspace", label: "switch workspace", need: 3.5, pri: 65, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("switch", 3, "change"), ...K("workspace", 2.5, "workspaces"), ...K("to", 0.5)],
    ph: [P("switch to", 3)],
    build: (t) => {
      const core = drop(t, ["switch", "change", "to", "workspace", "workspaces", ...ART]);
      return core.length ? `switch to ${core.join(" ")}` : null;
    },
  },
  {
    intent: "current_workspace", label: "current workspace", need: 3.5, pri: 66, remBonus: 0, noRemBonus: 0,
    kw: [...K("current", 2.5), ...K("workspace", 2.5, "workspaces")],
    ph: [],
    build: () => "current workspace",
  },
  {
    intent: "list_recons", label: "list meridian recons", need: 3, pri: 67, remBonus: 0, noRemBonus: 0,
    kw: [...K("meridian", 2), ...K("recons", 3, "recon")],
    ph: [P("meridian recons", 4)],
    build: () => "meridian recons",
  },
  {
    intent: "meridian_dossier", label: "meridian dossier", need: 4, pri: 68, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("meridian", 2), ...K("dossier", 3)],
    ph: [],
    build: (t) => {
      const core = drop(t, ["meridian", "dossier"]);
      return core.length ? `meridian dossier ${core.join(" ")}` : null;
    },
  },
  {
    intent: "meridian_entities", label: "meridian entities", need: 4, pri: 69, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("meridian", 2), ...K("entities", 3, "entity")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["meridian", "entities", "entity"]);
      return core.length ? `meridian entities ${core.join(" ")}` : null;
    },
  },
  {
    intent: "meridian_request", label: "request meridian recon", need: 4, pri: 70, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("meridian", 2), ...K("recon", 2.5, "recons"), ...K("run", 1.5), ...K("start", 1.5), ...K("request", 1.5)],
    ph: [],
    build: (t) => {
      const core = drop(t, ["meridian", "recon", "recons", "run", "start", "request", "new", ...ART]);
      return core.length ? `meridian recon ${core.join(" ")}` : null;
    },
  },
  {
    intent: "meridian_enrich", label: "enrich company", need: 4, pri: 71, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("meridian", 2), ...K("enrich", 3.5, "enrichment", "lookup", "profile")],
    ph: [],
    build: (t) => {
      if (t.includes("status")) return null;
      const core = drop(t, ["meridian", "enrich", "enrichment", "lookup", "profile", ...ART]);
      return core.length ? `meridian enrich ${core.join(" ")}` : null;
    },
  },
  {
    intent: "meridian_enrich_status", label: "enrichment status", need: 4, pri: 72, remBonus: 0, noRemBonus: 0,
    kw: [...K("enrichment", 3, "enrich"), ...K("status", 2.5), ...K("check", 1), ...K("progress", 1.5)],
    ph: [],
    build: (t) => {
      if (!t.some((x) => ["status", "progress"].includes(x)) && !t.includes("check")) return null;
      return "enrichment status";
    },
  },
  {
    intent: "analyze_pipeline", label: "analyze pipeline", need: 3, pri: 45, remBonus: 0, noRemBonus: 0,
    kw: [...K("analyze", 3, "analyse"), ...K("analysis", 2.5), ...K("pipeline", 2), ...K("stats", 1.5), ...K("report", 1)],
    ph: [P("analyze my pipeline", 4), P("pipeline analysis", 3.5)],
    build: () => "analyze my pipeline",
  },
  {
    intent: "forecast", label: "sales forecast", need: 3, pri: 46, remBonus: 0, noRemBonus: 0,
    kw: [...K("forecast", 4), ...K("revenue", 1.5), ...K("sales", 1)],
    ph: [P("sales forecast", 4), P("revenue forecast", 4)],
    build: () => "forecast",
  },
  {
    intent: "sales_cycle", label: "sales cycle", need: 3, pri: 47, remBonus: 0, noRemBonus: 0,
    kw: [...K("cycle", 2.5), ...K("velocity", 2.5), ...K("sales", 1.5), ...K("stall", 2)],
    ph: [P("sales cycle", 4), P("deal velocity", 3.5), P("where do deals stall", 4)],
    build: () => "sales cycle",
  },
  {
    intent: "top_deals", label: "top deals", need: 3, pri: 42, remBonus: 0, noRemBonus: 0,
    kw: [...K("top", 3), ...K("biggest", 3), ...K("largest", 3), ...K("leaderboard", 3.5), ...K("deal", 2.5, ...DEALN.slice(1))],
    ph: [P("top deals", 2)],
    build: () => "top deals",
  },
  {
    intent: "campaign_stats", label: "campaign stats", need: 3.5, pri: 43, remBonus: 0, noRemBonus: 0,
    kw: [...K("campaign", 3, "campaigns"), ...K("stats", 2, "statistics"), ...K("roi", 2.5), ...K("performance", 2), ...K("report", 1)],
    ph: [P("campaign performance", 4)],
    build: () => "campaign stats",
  },
  {
    intent: "closing_soon", label: "deals closing soon", need: 3.5, pri: 44, remBonus: 0, noRemBonus: 0,
    kw: [...K("closing", 3, "closes", "close"), ...K("soon", 2), ...K("upcoming", 2.5), ...K("deal", 1, ...DEALN.slice(1))],
    ph: [P("closing soon", 4), P("deals closing soon", 4.5), P("upcoming closes", 4)],
    build: () => "deals closing soon",
  },
  {
    intent: "pin_widget", label: "pin as widget", need: 4, pri: 1, remBonus: 0, noRemBonus: 0,
    kw: [...K("pin", 3), ...K("widget", 2.5, "widgets"), ...K("save", 1.5)],
    ph: [P("pin this", 4), P("pin it", 4), P("as a widget", 2)],
    build: () => "pin this as a widget",
  },
  {
    intent: "plan_day", label: "plan my day", need: 3, pri: 48, remBonus: 0, noRemBonus: 0,
    kw: [...K("plan", 3), ...K("day", 1.5), ...K("daily", 1.5), ...K("today", 1)],
    ph: [P("plan my day", 4), P("plan today", 3.5)],
    build: () => "plan my day",
  },
  {
    intent: "plan_week", label: "plan my week", need: 3, pri: 49, remBonus: 0, noRemBonus: 0,
    kw: [...K("plan", 3), ...K("week", 1.5), ...K("weekly", 1.5)],
    ph: [P("plan my week", 4), P("plan this week", 3.5)],
    build: () => "plan my week",
  },
  {
    intent: "plan_breakdown", label: "break down a goal", need: 3.5, pri: 50, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("break", 2), ...K("down", 1.5), ...K("plan", 1.5)],
    ph: [P("break down", 4)],
    build: (t) => {
      const core = drop(t, ["break", "down", "plan", ...ART]);
      return core.length ? `break down ${core.join(" ")}` : null;
    },
  },
  {
    intent: "prep_brief", label: "meeting prep", need: 4, pri: 51, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("prep", 3, "prepare"), ...K("brief", 2.5, "briefing"), ...K("meeting", 2.5), ...K("call", 1.5)],
    ph: [P("brief me", 3), P("prep me", 4), P("meeting prep", 4)],
    build: (t) => {
      const core = drop(t, ["prep", "prepare", "brief", "briefing", "meeting", "me", "for", "my", "call", "with", "on", ...ART]);
      return core.length ? `prep me for my call with ${core.join(" ")}` : null;
    },
  },
  {
    intent: "notes", label: "list notes", need: 2.5, pri: 72, remBonus: 0, noRemBonus: 0,
    kw: [...K("notes", 2.5, "note"), ...K("show", 1, ...SHOW.slice(1)), ...K("my", 0.5), ...K("saved", 1), ...K("list", 1)],
    ph: [],
    build: () => "notes",
  },
  {
    intent: "add_note", label: "add a deal note", need: 4, pri: 16, remBonus: 0.5, noRemBonus: 0,
    kw: [...K("note", 2.5, "notes"), ...K("add", 2, "create", "new"), ...K("on", 1), ...K("to", 0.5)],
    ph: [],
    build: (t) => {
      // Emit the exact parser's "note on/to <rest>" shape (it also accepts a
      // "query : text" colon form, but the colon doesn't survive tokenizing).
      const core = drop(t, ["add", "create", "new", ...ART, "note", "notes"]);
      if (!core.length) return null;
      const prep = core[0] === "to" || core[0] === "on" ? core.shift()! : "on";
      if (!core.length) return null;
      return `note ${prep} ${core.join(" ")}`;
    },
  },
  {
    intent: "save_note", label: "save note to a deal", need: 3.5, pri: 73, remBonus: 0, noRemBonus: 0,
    kw: [...K("save", 2.5), ...K("note", 2.5, "notes"), ...K("file", 2)],
    ph: [P("save this note", 4)],
    build: () => "save this note",
  },
  {
    intent: "ocr_read", label: "read the photo", need: 3, pri: 74, remBonus: 0, noRemBonus: 0,
    kw: [...K("read", 3), ...K("transcribe", 3), ...K("photo", 1.5, "picture", "image")],
    ph: [P("read this", 4), P("what does this say", 4)],
    build: () => "read this",
  },
  {
    intent: "handwriting", label: "handwriting analysis", need: 3, pri: 75, remBonus: 0, noRemBonus: 0,
    kw: [...K("handwriting", 4), ...K("analyze", 2, "analyse")],
    ph: [P("analyze handwriting", 4), P("handwriting analysis", 4)],
    build: () => "analyze handwriting",
  },
  {
    intent: "activities", label: "recent activity", need: 2.5, pri: 57, remBonus: 0, noRemBonus: 0,
    kw: [...K("activity", 3, "activities"), ...K("recent", 1.5), ...K("changelog", 2.5), ...K("log", 1)],
    ph: [P("recent activity", 4)],
    build: () => "recent activity",
  },
  {
    intent: "webhooks", label: "webhooks", need: 2.5, pri: 58, remBonus: 0, noRemBonus: 0,
    kw: [...K("webhook", 3, "webhooks"), ...K("automation", 2, "automations"), ...K("integration", 2, "integrations"), ...K("outgoing", 1.5)],
    ph: [],
    build: () => "webhooks",
  },
  {
    intent: "hooks", label: "incoming hooks", need: 2.5, pri: 59, remBonus: 0, noRemBonus: 0,
    kw: [...K("hook", 3, "hooks"), ...K("incoming", 2), ...K("inbound", 2), ...K("zapier", 3), ...K("n8n", 3)],
    ph: [P("incoming hooks", 4)],
    build: () => "incoming hooks",
  },
  {
    intent: "deliveries", label: "delivery log", need: 2.5, pri: 60, remBonus: 0, noRemBonus: 0,
    kw: [...K("delivery", 3, "deliveries"), ...K("log", 1.5)],
    ph: [P("delivery log", 4)],
    build: () => "deliveries",
  },
  {
    intent: "confirm_yes", label: "yes", need: 2.5, pri: 77, remBonus: 0, noRemBonus: 0,
    kw: [...K("yes", 4, "yep", "yeah", "sure", "ok", "okay", "confirm")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["yes", "yep", "yeah", "y", "sure", "ok", "okay", "confirm", "do", "it", "go", "ahead"]);
      return core.length ? null : "yes"; // anything else attached -> not a bare confirmation
    },
  },
  {
    intent: "confirm_no", label: "no", need: 2.5, pri: 78, remBonus: 0, noRemBonus: 0,
    kw: [...K("no", 4, "nope", "nah", "cancel")],
    ph: [],
    build: (t) => {
      const core = drop(t, ["no", "nope", "nah", "cancel", "never", "mind", "nevermind", "abort"]);
      return core.length ? null : "no";
    },
  },
  {
    // Tutorial mode controls. "milton" is FILLER, so "teach me milton" arrives
    // as [teach, me]. Small-talk guard: "teach me a joke" is chatter, not a
    // tutorial — vetoed so it falls through to the LLM fallback.
    intent: "tutorial", label: "tutorial control", need: 3, pri: 75, remBonus: 0, noRemBonus: 0,
    veto: (toks) => toks.some((t) => CHATTER.has(t)),
    kw: [
      ...K("tutorial", 4, "tutorials", "tour"),
      ...K("teach", 2.5, "teaches", "teaching", "showaround"),
      ...K("start", 1.5, "begin", "beginning", "starting"),
      ...K("restart", 1.5, "redo"),
      ...K("status", 2, "progress", "going"),
      ...K("skip", 2.5, "skipping"),
      ...K("next", 2),
      ...K("back", 2, "previous", "backwards"),
      ...K("exit", 2.5, "quit", "quitting", "leave", "leaving"),
      // "stop" is d=2 from "show" — typo-guessing it would eat "show me
      // around" etc. Exact-only, like the confusable shorts elsewhere.
      { a: "stop", c: "exit", w: 2.5, x: 1 }, { a: "stopping", c: "exit", w: 2.5, x: 1 },
      ...K("step", 1, "steps", "lesson", "lessons"),
    ],
    ph: [P("teach me", 4), P("walk me through", 5), P("show me around", 4), P("exit tutorial", 5), P("go back", 3.5)],
    build: (t) => {
      if (t.some((x) => ["exit", "quit", "stop", "leave"].includes(x))) return "exit tutorial";
      if (t.some((x) => ["skip", "next"].includes(x))) return "skip";
      if (t.includes("back")) return "back";
      if (t.includes("restart")) return "restart tutorial";
      if (t.includes("status")) return "tutorial status";
      return "tutorial";
    },
  },
  // ---- chat sessions ------------------------------------------------------------
  {
    intent: "chat_session", label: "new chat session", need: 4, pri: 79, remBonus: 0, noRemBonus: 0,
    kw: [...K("new", 3, "create", "start", "open"), ...K("session", 3, "sessions", "conversation", "conversations")],
    ph: [P("new session", 4)],
    mustHave: ["new"],
    build: (t) => {
      const core = drop(t, ["new", "create", "start", "open", "session", "sessions", "conversation", "conversations", "chat", "called", "named", "for", ...ART]);
      return core.length ? `new session ${core.join(" ")}` : "new session";
    },
  },
  {
    intent: "chat_session", label: "list chat sessions", need: 3.5, pri: 80, remBonus: 0, noRemBonus: 0,
    kw: [...K("list", 3, "show", "display"), ...K("session", 3, "sessions", "conversation", "conversations")],
    ph: [P("list sessions", 4), P("show sessions", 4), P("my sessions", 4)],
    mustHave: ["session"],
    build: () => "sessions",
  },
  {
    intent: "chat_session", label: "switch chat session", need: 4, pri: 81, remBonus: 0, noRemBonus: 0,
    kw: [...K("switch", 4, "go", "change", "jump"), ...K("session", 2.5, "sessions", "conversation")],
    ph: [P("switch session", 4), P("go to session", 4)],
    mustHave: ["switch"],
    build: (t) => {
      const core = drop(t, ["switch", "go", "change", "jump", "session", "sessions", "conversation", "to", ...ART]);
      return core.length ? `switch session to ${core.join(" ")}` : null;
    },
  },
  {
    intent: "chat_session", label: "rename chat session", need: 4, pri: 82, remBonus: 0, noRemBonus: 0,
    kw: [...K("rename", 4), ...K("session", 2.5, "sessions", "conversation")],
    ph: [P("rename session", 4)],
    mustHave: ["rename"],
    build: (t) => {
      const core = drop(t, ["rename", "session", "sessions", "conversation", "it", ...ART]);
      return `rename session${core.length ? " " + core.join(" ") : ""}`;
    },
  },
  {
    intent: "chat_session", label: "delete chat session", need: 4, pri: 83, remBonus: 0, noRemBonus: 0,
    kw: [...K("delete", 4, "remove", "erase"), ...K("session", 2.5, "sessions", "conversation")],
    ph: [P("delete session", 4), P("remove session", 4)],
    mustHave: ["delete"],
    build: (t) => {
      const core = drop(t, ["delete", "remove", "erase", "session", "sessions", "conversation", ...ART]);
      return `delete session${core.length ? " " + core.join(" ") : ""}`;
    },
  },
  {
    intent: "chat_session", label: "current chat session", need: 3.5, pri: 84, remBonus: 0, noRemBonus: 0,
    kw: [...K("current", 3, "active"), ...K("session", 3, "sessions", "conversation")],
    ph: [P("current session", 4), P("which session", 4)],
    mustHave: ["session"],
    build: () => "current session",
  },
  {
    intent: "add_custom_field", label: "add a custom field", need: 4, pri: 16, remBonus: 1, noRemBonus: 0,
    mustHave: ["add"],
    veto: noCfWords,
    kw: [...K("add", 3, "create", "new", "make", "insert"), ...CF_KW],
    ph: [P("add custom field", 4), P("new custom field", 4), P("create custom field", 4)],
    build: (t) => {
      const low = t.map((x) => x.toLowerCase());
      const ent = cfEnt(low);
      if (!ent) return null;
      // name sits after the LAST custom/field marker (typo-repaired "feild"
      // canonicalizes in place, so "custom" alone isn't the anchor)
      const ci = Math.max(low.lastIndexOf("custom"), low.lastIndexOf("field"), low.lastIndexOf("fields"));
      const toIdx = low.lastIndexOf(ent);
      if (ci < 0 || toIdx <= ci) return null;
      const type = cfType(low);
      let nameToks = t.slice(ci + 1, toIdx);
      if (nameToks.every((x) => ["field", "fields", "to", "for", "on"].includes(x.toLowerCase()))) {
        // "add the VIP custom field to companies": name sits before "custom"
        const cc = low.lastIndexOf("custom");
        nameToks = t.slice(0, cc >= 0 ? cc : ci);
      }
      if (type) {
        // strip an explicit "of type <type>" / "type <type>" tail, not a type
        // word that is part of the name ("Renewal date" keeps its name)
        const lnt = nameToks.map((x) => x.toLowerCase());
        const ti = lnt.lastIndexOf(type);
        if (ti >= 0 && lnt[ti - 1] === "type") {
          nameToks = nameToks.slice(0, ti - 1);
          if (nameToks.length && nameToks[nameToks.length - 1].toLowerCase() === "of") nameToks.pop();
        }
      }
      const name = drop(nameToks, ["add", "create", "new", "make", "insert", "to", "for", "on", ...ART]).join(" ");
      if (!name) return null;
      return `add custom field ${name}${type ? ` of type ${type}` : ""} to ${ent}`;
    },
  },
  {
    intent: "set_custom_field", label: "set a custom field value", need: 4, pri: 17, remBonus: 1, noRemBonus: 0,
    mustHave: ["set"],
    // the field word keeps "set acme value to 50k" on the deal path
    veto: noCfWords,
    kw: [...K("set", 3, "update", "edit", "change", "modify"), ...CF_KW],
    ph: [P("set custom field", 4)],
    build: (t) => {
      const low = t.map((x) => x.toLowerCase());
      const ent = cfEnt(low);
      if (!ent) return null;
      const toIdx = low.lastIndexOf("to");
      const forIdx = low.lastIndexOf("for");
      if (toIdx < 1 || forIdx <= toIdx) return null;
      const field = drop(t.slice(1, toIdx), [...ART]).join(" ").replace(/^(?:custom fields? )/i, "");
      const value = drop(t.slice(toIdx + 1, forIdx), [...ART]).join(" ");
      let qToks = t.slice(forIdx + 1);
      const qi = qToks.findIndex((x) => { const l = x.toLowerCase(); return l === ent || l === CF_SING[ent]; });
      if (qi >= 0) qToks = qToks.slice(qi + 1);
      const query = drop(qToks, [...ART]).join(" ");
      if (!field || !value || !query) return null;
      return `set ${field} to ${value} for ${CF_SING[ent]} ${query}`;
    },
  },
  {
    intent: "show_custom_fields", label: "show custom fields", need: 4, pri: 18, remBonus: 1, noRemBonus: 0,
    kw: [...K("show", 2.5, "list", "display", "view", "get"), ...CF_KW],
    ph: [P("custom fields", 4), P("show custom fields", 4.5), P("list custom fields", 4.5)],
    // an action verb (set/delete/add) makes this a write, not a read; and
    // without a "custom"/"field" word it isn't a field command at all
    veto: (toks) => toks.some((t) => ["set", "update", "edit", "change", "modify", "add", "create", "make", "insert", "remove", "delete", "drop", "erase"].includes(t)) || noCfWords(toks),
    build: (t) => {
      const low = t.map((x) => x.toLowerCase());
      const ent = cfEnt(low);
      if (!ent) return null;
      // trailing glue ("what custom fields do contacts have") isn't a name
      const name = drop(t.slice(low.indexOf(ent) + 1), [...ART, "have", "has", "had", "do", "does"]).join(" ");
      if (name) return `show custom fields for ${CF_SING[ent]} ${name}`;
      return `list custom fields for ${ent}`;
    },
  },
  {
    intent: "delete_custom_field", label: "delete a custom field", need: 4, pri: 19, remBonus: 1, noRemBonus: 0,
    mustHave: ["remove"],
    // the field word keeps "delete task X" on the task path
    veto: noCfWords,
    kw: [...K("remove", 3, "delete", "drop", "erase"), ...CF_KW],
    ph: [P("delete custom field", 4), P("remove custom field", 4)],
    build: (t) => {
      const low = t.map((x) => x.toLowerCase());
      const ent = cfEnt(low);
      const fromIdx = low.lastIndexOf("from");
      const fi = Math.max(low.lastIndexOf("custom"), low.lastIndexOf("field"), low.lastIndexOf("fields"));
      if (!ent || fi < 0 || fromIdx <= fi) return null;
      let nameToks = t.slice(fi + 1, fromIdx);
      if (nameToks.every((x) => ["field", "fields"].includes(x.toLowerCase()))) {
        // "delete the VIP custom field from companies": name sits before "custom"
        const cc = low.lastIndexOf("custom");
        nameToks = t.slice(0, cc >= 0 ? cc : fi);
      }
      const name = drop(nameToks, ["remove", "delete", "drop", "erase", ...ART]).join(" ");
      if (!name) return null;
      return `remove custom field ${name} from ${ent}`;
    },
  },
];

for (const m of MORE) MATCHERS.push(m);

/** Words that can never be entity evidence: pure glue. A leftover "my" or
 *  "the" must not push a detail-intent over a list-intent (or vice versa). */
const REM_STOP = new Set([
  "my", "me", "the", "a", "an", "to", "for", "of", "on", "in", "at",
  "is", "are", "was", "were", "be", "it", "its", "this", "that", "these",
  "those", "and", "or", "as", "so", "up", "out", "there", "here",
]);

/** Every keyword alias and phrase word across all matchers. A leftover token
 *  that is itself command vocabulary (e.g. "top" in "show my top deals")
 *  is explained — it is not a deal/contact/task name. */
const KNOWN_VOCAB = new Set<string>();
for (const m of MATCHERS) {
  for (const k of m.kw) { KNOWN_VOCAB.add(k.a); KNOWN_VOCAB.add(k.c); }
  for (const p of m.ph) for (const w of p.w) KNOWN_VOCAB.add(w);
}
const CONTENT_STOP = new Set([...FILLER, ...REM_STOP, ...KNOWN_VOCAB]);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Scored {
  m: FuzzMatcher;
  credit: number;
  consumed: Map<number, string>;
  info: FuzzInfo;
  maxKw: number; // strongest keyword weight consumed (chatter veto)
}

function bestToken(tokens: string[], alias: string, used: Set<number>): { idx: number; d: number } | null {
  let best: { idx: number; d: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i)) continue;
    const t = tokens[i];
    if (FILLER.has(t)) continue; // pleasantries never carry intent meaning
    if (t.length > 24 || Math.abs(t.length - alias.length) > 2) continue;
    const limit = maxDistFor(t, alias);
    if (Math.abs(t.length - alias.length) > limit) continue;
    // First letters are almost never typo'd: on short words a wrong initial
    // is a different word ("call" is not "kill", "my" is not "me").
    if (Math.min(t.length, alias.length) <= 4 && t[0] !== alias[0]) continue;
    const d = boundedEdit(t, alias, limit);
    if (d <= limit && (!best || d < best.d)) {
      best = { idx: i, d };
      if (d === 0) break;
    }
  }
  return best;
}

function scoreMatcher(m: FuzzMatcher, tokens: string[], blocked: Set<number> = new Set()): Scored {
  const used = new Set<number>(blocked);
  const consumed = new Map<number, string>();
  const kwFirst = new Set<number>(); // token idxs consumed by keywords (not phrases)
  const info: FuzzInfo = {};
  let credit = 0;
  let maxKw = 0;

  const take = (idx: number, canon: string, tag: Tag) => {
    used.add(idx);
    consumed.set(idx, canon);
    if (tag === "stage") info.stageAlias = canon;
    else if (tag === "won") info.wonLost = "won";
    else if (tag === "lost") info.wonLost = "lost";
  };

  // keywords, heaviest first (deterministic: weight desc, alias asc).
  // Two rounds: exact (d=0) matches claim their tokens before fuzzy ones,
  // so a short alias ("kpi") can never steal the exact token of its longer
  // sibling ("kpis").
  const kws = [...m.kw].sort((x, y) => y.w - x.w || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  const done = new Set<Kw>();
  for (let round = 0; round < 2; round++) {
    for (const k of kws) {
      if (done.has(k)) continue;
      if (k.x && round === 1) continue; // exact-only keyword: no typo guessing
      const b = bestToken(tokens, k.a, used);
      if (!b) continue;
      if ((round === 0) !== (b.d === 0)) continue;
      done.add(k);
      const denom = Math.max(tokens[b.idx].length, k.a.length);
      credit += k.w * (1 - b.d / denom);
      if (k.w > maxKw) maxKw = k.w;
      take(b.idx, k.c, k.tag);
      kwFirst.add(b.idx);
    }
  }
  // phrases with partial credit. The head word must match: a phrase never
  // fires on a trailing stopword alone ("prep me" needs "prep", not just "me").
  // Phrase words need a tight match (d<=1, exact when short): a d=2 guess
  // like "closed"~"clsoe" or "soon"~"show" is a different phrase, not a typo.
  // Phrase words may reuse keyword-consumed tokens for hits (a collocation
  // bonus like "top deals" still counts when kw already ate "top"), but two
  // phrases never double-take the same token.
  const pused = new Set<number>();
  for (const p of m.ph) {
    const head = bestToken(tokens, p.w[0], pused);
    if (!head || head.d > 1) continue;
    let hits = 0;
    for (const w of p.w) {
      const b = bestToken(tokens, w, pused);
      if (!b || b.d > 1 || (w.length <= 3 && b.d > 0)) continue;
      hits++;
      if (used.has(b.idx)) pused.add(b.idx); // hit, already keyword-consumed
      else take(b.idx, w, p.tag);
    }
    // A phrase needs at least two of its words to hit: the head alone
    // ("needs attention" <- just "need") is not the phrase.
    if (hits >= Math.max(2, Math.ceil(p.w.length / 2))) {
      credit += p.wgt * (hits / p.w.length);
    }
  }

  // remainder bonus only for real content: leftover glue ("my", "the") or
  // leftover command vocabulary ("top" in "show my top deals") is explained,
  // not a deal/contact/task name. Blocked (already-explained) tokens never count.
  const rawRemaining = tokens.filter((_, i) => !used.has(i)).length;
  const contentLeft = tokens.filter(
    (_, i) => !used.has(i) && !blocked.has(i) && !CONTENT_STOP.has(tokens[i]),
  ).length;
  if (contentLeft > 0) credit += m.remBonus;
  else if (rawRemaining === 0) credit += m.noRemBonus;
  // (leftover glue alone, e.g. "the" in "clsoe the deal", earns neither bonus)
  // leading-verb prior: in a command, the first content word usually names
  // the action ("deals my show" is still a list-deals command).
  const firstIdx = tokens.findIndex((t) => !FILLER.has(t));
  // Leading-action prior, keyword-only: the first token must have matched a
  // real keyword (not just been swept up by a phrase like "what does…").
  if (firstIdx >= 0 && kwFirst.has(firstIdx)) credit += 1.0;
  // An action intent needs its action verb: without "delete"/"add" the input
  // is a noun phrase ("deal acme"), not a delete/add command.
  if (m.mustHave && ![...consumed.values()].some((v) => m.mustHave!.includes(v))) {
    credit = 0;
  }
  if (m.veto && m.veto(tokens)) credit = 0;
  return { m, credit, consumed, info, maxKw };
}

/** Assemble the canonical command: matched keywords are replaced in place
 *  by their canonical forms (typo repaired, synonym normalized), filler
 *  words are dropped, and every other ORIGINAL token (case and punctuation
 *  intact) passes through so entity extraction sees the user's real text. */
function buildCommand(s: Scored, rawToks: string[]): string | null {
  const toks: string[] = [];
  for (let i = 0; i < rawToks.length; i++) {
    if (s.consumed.has(i)) { toks.push(s.consumed.get(i)!); continue; }
    const w = rawToks[i].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FILLER.has(w)) continue;
    toks.push(rawToks[i]);
  }
  return s.m.build(toks, s.info);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DisambigOption { label: string; command: string }

/**
 * Fuzzy intent parsing. Exact matches always win outright; the fuzzy layer
 * only runs when parseIntent returns "unknown". Returns the exact parser's
 * Intent on success (with `fuzzy: true` set when the fuzzy path resolved it),
 * "unknown" below threshold, or "disambiguate_intent" with JSON-encoded
 * options when the top candidates are within TIE_GAP of each other.
 */
export function parseIntentFuzzy(raw: string): Intent {
  const exact = parseIntent(raw);
  if (exact.name !== "unknown") return exact;

  const normed = normalizeForMatch(raw);
  if (!normed) return exact;
  // Filler is dropped before the token cap so a long polite preamble can't
  // push the real command past MAX_TOKENS ("please…" x100 + "show deals").
  const isFiller = (t: string) => FILLER.has(t.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const tokens = normed.split(" ").filter(Boolean).filter((t) => !FILLER.has(t)).slice(0, MAX_TOKENS);
  const rawToks = expandContractions(raw).split(/\s+/).filter(Boolean).filter((t) => !isFiller(t)).slice(0, MAX_TOKENS);
  if (!tokens.length || tokens.length !== rawToks.length) return exact;

  const scored: (Scored & { cmd: string | null })[] = [];
  const failed: (Scored & { cmd: null })[] = [];
  const hasChatter = tokens.some((t) => CHATTER.has(t));
  for (const m of MATCHERS) {
    const s = scoreMatcher(m, tokens);
    if (s.credit < m.need) continue;
    if (hasChatter && s.maxKw < 2.5) continue; // small talk, not a command
    const cmd = buildCommand(s, rawToks);
    const check = cmd ? parseIntent(cmd) : null;
    if (!cmd || !check || check.name !== m.intent) {
      failed.push({ ...s, cmd: null }); // strong-but-incomplete interpretation
      continue;
    }
    scored.push({ ...s, cmd });
  }

  // Claiming: when the single strongest interpretation explains the input
  // but can't build (e.g. "clsoe the deal" -> close_deal, missing won/lost),
  // its tokens are not free for weaker candidates to reuse as entity names.
  // Only a STRICTLY strongest failed candidate claims; genuine ties (e.g.
  // several bare "delete X") fall through to disambiguation/unknown instead.
  let pool = scored;
  const topFailed = failed.length
    ? failed.reduce((a, b) => (b.credit > a.credit ? b : a))
    : null;
  const claims = topFailed &&
    topFailed.credit > 0 &&
    failed.filter((f) => f.credit >= topFailed.credit).length === 1 &&
    scored.every((s) => topFailed.credit > s.credit)
    ? new Set(topFailed.consumed.keys())
    : null;
  if (claims && claims.size > 0) {
    pool = [];
    for (const m of MATCHERS) {
      const s = scoreMatcher(m, tokens, claims);
      if (s.credit < m.need) continue;
      const cmd = buildCommand(s, rawToks);
      const check = cmd ? parseIntent(cmd) : null;
      if (!cmd || !check || check.name !== m.intent) continue;
      pool.push({ ...s, cmd });
    }
  }
  if (!pool.length) return exact;
  pool.sort((a, b) => b.credit - a.credit || a.m.pri - b.m.pri);

  const tied = pool.filter((s) => pool[0].credit - s.credit < TIE_GAP).slice(0, 3);
  if (tied.length > 1) {
    const options: DisambigOption[] = tied.map((s) => ({ label: s.m.label, command: s.cmd! }));
    return {
      name: "disambiguate_intent", raw, text: normed,
      slots: { options: JSON.stringify(options) },
    };
  }
  const win = pool[0];
  const out = parseIntent(win.cmd!);
  (out as Intent & { fuzzy?: boolean }).fuzzy = true;
  return out;
}

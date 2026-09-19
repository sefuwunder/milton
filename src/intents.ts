// intents.ts — deterministic natural-language parser for Milton.
// No ML, no dependencies: ordered regex matchers over normalized text.

export type IntentName =
  | "help" | "pipeline" | "deals" | "deal_detail" | "kpis" | "tasks"
  | "contacts" | "companies" | "brief" | "hygiene" | "webhooks" | "hooks"
  | "deliveries" | "activities"
  | "add_deal" | "move_deal" | "set_deal_field" | "close_deal" | "delete_deal"
  | "add_contact" | "add_company" | "add_task" | "complete_task" | "reopen_task"
  | "delete_task" | "remind"
  | "confirm_yes" | "confirm_no" | "choose_number"
  | "unknown";

export interface Intent {
  name: IntentName;
  raw: string;
  text: string; // normalized
  slots: Record<string, string>;
}

const STAGE_ALIASES: Record<string, string> = {
  prospecting: "prospecting", prospect: "prospecting",
  qualification: "qualification", qualifying: "qualification", qualified: "qualification",
  proposal: "proposal", proposals: "proposal",
  negotiation: "negotiation", negotiating: "negotiation",
  won: "closed_won", "closed won": "closed_won", closedwon: "closed_won", win: "closed_won",
  lost: "closed_lost", "closed lost": "closed_lost", closedlost: "closed_lost", lose: "closed_lost",
};

export function parseStage(s: string): string | null {
  const t = s.toLowerCase().trim();
  return STAGE_ALIASES[t] || null;
}

export function parseMoney(s: string): number | null {
  const m = s.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") v *= 1e3;
  else if (suffix === "m") v *= 1e6;
  else if (suffix === "b") v *= 1e9;
  return Math.round(v);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseDate(s: string, ref: Date = new Date()): string | null {
  const t = s.toLowerCase().trim();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  if (/^today$/.test(t)) return fmt(ref);
  if (/^tomorrow$/.test(t)) { const d = new Date(ref); d.setDate(d.getDate() + 1); return fmt(d); }
  if (/^next week$/.test(t)) { const d = new Date(ref); d.setDate(d.getDate() + 7); return fmt(d); }
  let m = t.match(/^in (\d+) days?$/);
  if (m) { const d = new Date(ref); d.setDate(d.getDate() + Number(m[1])); return fmt(d); }
  m = t.match(/^(?:next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (m) {
    const target = WEEKDAYS.indexOf(m[1]);
    const d = new Date(ref);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "friday" on a friday -> next friday
    if (/^next /.test(t)) delta += 7;
    d.setDate(d.getDate() + delta);
    return fmt(d);
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? Number(m[3]) : ref.getFullYear();
    if (y < 100) y += 2000;
    const mm = m[1].padStart(2, "0"), dd = m[2].padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

// Finds a date expression anywhere inside a longer string; returns {date, rest}.
export function extractDate(s: string): { date: string; rest: string } | null {
  const patterns = [
    /\b(today|tomorrow|next week)\b/i,
    /\bin (\d+) days?\b/i,
    /\b(?:next |this )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) {
      const date = parseDate(m[0]);
      if (date) return { date, rest: (s.slice(0, m.index) + " " + s.slice((m.index || 0) + m[0].length)).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

// Finds a money expression; returns {value, rest}.
export function extractMoney(s: string): { value: number; rest: string } | null {
  const m = s.match(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[kmb]?\b/i);
  if (!m) return null;
  // avoid swallowing a bare year or id-looking number without $ or suffix
  const token = m[0].trim();
  if (!/[$kmb]/i.test(token) && !/\bworth\b|\bvalue\b|\bdeal\b/i.test(s)) {
    // bare number: only accept if preceded by worth/value/for
    if (!/(worth|value|at|for)\s+$/.test(s.slice(0, m.index || 0))) return null;
  }
  const value = parseMoney(token);
  if (value === null) return null;
  return { value, rest: (s.slice(0, m.index) + " " + s.slice((m.index || 0) + m[0].length)).replace(/\s+/g, " ").trim() };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[?!.,;:]+$/g, "").replace(/\s+/g, " ").trim();
}

const DEAL_WORD = "(?:deal|opportunity|opp)";

function stripDealWord(q: string): string {
  return q.replace(/^(deal|opportunity|opp) /, "").replace(/ (deal|opportunity|opp)$/, "").trim();
}

export function parseIntent(raw: string): Intent {
  const text = norm(raw);
  const slots: Record<string, string> = {};
  let name: IntentName = "unknown";

  const set = (n: IntentName, s: Record<string, string> = {}) => { name = n; Object.assign(slots, s); };

  // ---- conversational control ------------------------------------------------
  if (/^(yes|yep|yeah|y|sure|do it|confirm|go ahead|ok|okay)$/.test(text)) return { name: "confirm_yes", raw, text, slots };
  if (/^(no|nope|nah|cancel|never mind|nevermind|abort)$/.test(text)) return { name: "confirm_no", raw, text, slots };
  let m = text.match(/^(?:number |option |#)?([1-9])$/) || text.match(/(?:choose|pick|select|option|number)\s+([1-9])\b/);
  if (m) return { name: "choose_number", raw, text, slots: { n: m[1] } };

  // ---- help -----------------------------------------------------------------
  if (/^(help|what can you do|commands|how do (i|you) work|start)$/.test(text)) set("help");

  // ---- routines ---------------------------------------------------------------
  else if (/\b(morning brief|daily brief|brief me|briefing)\b/.test(text)) set("brief");
  else if (/\b(pipeline hygiene|hygiene|health check|cleanup|stale deals)\b/.test(text)) set("hygiene");

  // ---- reads ------------------------------------------------------------------
  else if (/^(show |get |display )?(pipeline|funnel|board)( summary)?$/.test(text)) set("pipeline");
  else if (/^(kpis?|kpi dashboard|metrics|how are we doing|dashboard)$/.test(text)) set("kpis");
  else if (/^(recent activity|activity|activity log|what'?s (new|happened)|changelog)$/.test(text)) set("activities");
  else if (/^(webhooks?|automations?|outgoing hooks?|integrations?)$/.test(text)) set("webhooks");
  else if (/^(incoming hooks?|inbound hooks?|zapier|n8n|make hooks?)$/.test(text)) set("hooks");
  else if (/^(deliveries|webhook deliveries|delivery log)$/.test(text)) set("deliveries");
  else if (/^(list |show |get |all )?(companies|accounts)$/.test(text)) set("companies");
  else if (/^(tasks?|to-?dos?|my tasks?|open tasks?|pending tasks?|what'?s (on|due)|due (today|tomorrow|this week))$/.test(text)) set("tasks");
  else if (/^(completed tasks?|done tasks?|finished tasks?)$/.test(text)) set("tasks", { filter: "done" });
  else if (/^(deals?|opportunities|open deals?|all deals?|my deals?)$/.test(text)) set("deals");
  else if ((m = text.match(new RegExp(`^(?:list |show |get |all )?${DEAL_WORD}s? in (\\w[\\w ]*)$`)))) {
    const st = parseStage(m[1]);
    if (st) set("deals", { stage: st }); else set("deals", { search: m[1] });
  }
  else if ((m = text.match(/^(?:list |show |get |find |search )?contacts?(?: (?:named|called|like|for) (.+))?$/))) set("contacts", m[1] ? { search: m[1] } : {});
  else if ((m = text.match(new RegExp(`^(?:show|get|open|display|tell me about) ${DEAL_WORD} (.+)$`)))) set("deal_detail", { query: m[1] });
  else if ((m = text.match(/^(?:show|get|find|lookup|tell me about) contact (.+)$/))) set("contacts", { search: m[1] });
  else if ((m = text.match(/^(?:show|get|find) company (.+)$/))) set("companies", { search: m[1] });
  else if ((m = text.match(/^(?:show|get|list) tasks?(?: for| about| on)? (.+)$/))) set("tasks", { search: m[1] });

  // ---- deal writes --------------------------------------------------------------
  else if ((m = text.match(new RegExp(`^(?:mark |set )?${DEAL_WORD} (.+?) as (?:closed[ -]?)?(won|lost)$`)))) set("close_deal", { query: m[1], result: m[2] });
  else if ((m = text.match(/^(?:mark|close) (.+?) (?:as )?(won|lost)$/))) set("close_deal", { query: stripDealWord(m[1]), result: m[2] });
  else if ((m = text.match(new RegExp(`^(?:move |shift |put )${DEAL_WORD}? ?(.+?) to ([\\w ]+)$`)))) {
    const st = parseStage(m[2]);
    if (st) set("move_deal", { query: stripDealWord(m[1]), stage: st });
  }
  else if ((m = text.match(new RegExp(`^delete ${DEAL_WORD} (.+)$`)))) set("delete_deal", { query: m[1] });
  else if ((m = text.match(/^(?:update |set )(?:deal )?(.+?) (value|worth|amount|probability|chance|close date|expected close|owner|contact|company) (?:to )?(.+)$/))) {
    set("set_deal_field", { query: stripDealWord(m[1]), field: m[2], value: m[3] });
  }
  else if ((m = text.match(/^(?:add|create|new)(?: a| an)? deal (.+)$/))) {
    let rest = m[1], company = "", value = "", date = "";
    const mon = extractMoney(rest);
    if (mon) { value = String(mon.value); rest = mon.rest; }
    const dt = extractDate(rest);
    if (dt) { date = dt.date; rest = dt.rest; }
    rest = rest.replace(/\bworth\b.*$/, "").trim();
    const cm = rest.match(/(?:for|with|at) (.+)$/);
    if (cm) { company = cm[1].replace(/^(the|a|an) /, "").trim(); rest = rest.slice(0, cm.index).trim(); }
    set("add_deal", { title: rest, company, value, close: date });
  }

  // ---- contact / company writes ---------------------------------------------------
  else if ((m = text.match(/^(?:add|create|new)(?: a| an)? contact (.+)$/))) {
    let rest = m[1];
    const em = rest.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const email = em ? em[0] : "";
    if (em) rest = rest.replace(em[0], " ");
    const ph = rest.match(/(?:phone|tel|mobile|cell)[:\s]*([+\d][\d\s().-]{6,})/);
    const phone = ph ? ph[1].trim() : "";
    if (ph) rest = rest.replace(ph[0], " ");
    const cm = rest.match(/(?:at|@|from|with) (.+)$/);
    const company = cm ? cm[1].trim() : "";
    if (cm) rest = rest.slice(0, cm.index).trim();
    set("add_contact", { name: rest.replace(/\s+/g, " ").trim(), company, email, phone });
  }
  else if ((m = text.match(/^(?:add|create|new)(?: a| an)? company (.+)$/))) set("add_company", { name: m[1] });

  // ---- task writes -----------------------------------------------------------------
  else if (/^(remind me to |remind me )(.+)$/.test(text)) {
    const mm = text.match(/^(remind me to |remind me )(.+)$/)!;
    let rest = mm[2];
    const dt = extractDate(rest);
    set("remind", { title: dt ? dt.rest : rest, due: dt ? dt.date : "" });
  }
  else if ((m = text.match(/^(?:add|create|new)(?: a| an)? task (.+)$/))) {
    let rest = m[1];
    const dt = extractDate(rest);
    const due = dt ? dt.date : "";
    if (dt) rest = dt.rest;
    const dm = rest.match(/(?:for|on|about) (?:deal )?(.+)$/);
    const deal = dm ? dm[1].trim() : "";
    if (dm) rest = rest.slice(0, dm.index).trim();
    set("add_task", { title: rest, deal, due });
  }
  else if ((m = text.match(/^(?:complete|finish|done with|mark (?:as )?done|check off)(?: task)? (.+)$/))) set("complete_task", { query: m[1].replace(/^task /, "") });
  else if ((m = text.match(/^(?:reopen|uncomplete|mark (?:as )?not done)(?: task)? (.+)$/))) set("reopen_task", { query: m[1].replace(/^task /, "") });
  else if ((m = text.match(/^(?:delete|remove)(?: task)? (.+)$/))) set("delete_task", { query: m[1].replace(/^task /, "") });

  return { name, raw, text, slots };
}

// Suggestion chips shown under replies.
export const HELP_CHIPS = [
  "Show pipeline", "Morning brief", "My tasks",
  "KPIs", "Pipeline hygiene", "List deals in negotiation",
];

export function helpText(): string {
  return [
    "Here's what I can do inside exec-crm:",
    "",
    "**Look things up** — pipeline, KPIs, deals, contacts, companies, tasks, recent activity, webhooks.",
    "**Work the pipeline** — `add deal Website redesign for Acme worth 50k`, `move Acme deal to negotiation`, `mark Acme deal as won`, `set Acme deal value to 75k`.",
    "**People & companies** — `add contact Jane Doe at Acme jane@acme.com`, `add company Globex`.",
    "**Tasks** — `add task Call Acme tomorrow`, `remind me to send the proposal Friday`, `complete task 3`.",
    "**Routines** — `morning brief` for today's digest, `pipeline hygiene` for stale deals and gaps.",
    "",
    "I'll ask before anything destructive, and if a name matches more than one record I'll let you pick.",
  ].join("\n");
}

// intents.ts — deterministic natural-language parser for Milton.
// No ML, no dependencies: ordered regex matchers over normalized text.

import * as mer from "./meridian";

export type IntentName =
  | "help" | "pipeline" | "deals" | "deal_detail" | "kpis" | "tasks"
  | "contacts" | "companies" | "brief" | "hygiene" | "webhooks" | "hooks"
  | "deliveries" | "activities" | "notes"
  | "add_deal" | "move_deal" | "set_deal_field" | "close_deal" | "delete_deal"
  | "add_contact" | "add_company" | "add_task" | "complete_task" | "reopen_task"
  | "delete_task" | "remind_add" | "remind_list" | "remind_cancel" | "import_contacts"
  | "capture"
  | "ocr_read" | "handwriting" | "save_note"
  | "prep_brief"
  | "analyze_pipeline" | "forecast" | "plan_day" | "plan_week" | "plan_breakdown"
  | "sales_cycle" | "top_deals" | "campaign_stats" | "closing_soon"
  | "pin_widget"
  | "contact_detail" | "search" | "add_note" | "add_campaign"
  | "save_routine" | "run_routine" | "list_routines" | "delete_routine" | "show_routine"
  | "schedule_add" | "list_schedules" | "unschedule" | "pause_schedule" | "resume_schedule"
  | "trigger_add" | "list_triggers" | "delete_trigger" | "trigger_help" | "list_runs"
  | "list_workspaces" | "switch_workspace" | "current_workspace"
  | "list_recons" | "meridian_dossier" | "meridian_entities" | "meridian_request"
  | "list_stages" | "add_stage" | "rename_stage" | "delete_stage" | "move_stage"
  | "confirm_yes" | "confirm_no" | "choose_number"
  | "disambiguate_intent" // fuzzy near-tie: numbered choice between candidate intents
  | "unknown";

export interface Intent {
  name: IntentName;
  raw: string;
  text: string; // normalized
  slots: Record<string, string>;
  fuzzy?: boolean; // set when the fuzzy interpreter (not the exact regexes) resolved this
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

// Longest-first alternation of every stage alias, for matchers like
// "show negotiation deals" / "won deals".
const STAGE_WORDS = Object.keys(STAGE_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

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
export function extractDate(s: string, ref: Date = new Date()): { date: string; rest: string } | null {
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
      const date = parseDate(m[0], ref);
      if (date) return { date, rest: (s.slice(0, m.index) + " " + s.slice((m.index || 0) + m[0].length)).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

/** One-shot reminder time parsing. Returns the fire time (epoch ms) and the
 *  reminder text with the time expression stripped, or null when no usable
 *  time expression is present. Relative ("in 20 minutes") and absolute
 *  ("tomorrow at 9am", "friday at 2:30pm", "at 9am") forms are supported;
 *  a bare date with no time defaults to 9:00 AM local. */
export function parseReminderTime(s: string, nowMs: number): { fireAt: number; text: string } | null {
  // relative: "in 20 minutes"
  const rel = s.match(/\bin (\d+)\s*(minutes?|hours?|days?|weeks?)\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = /^minute/.test(rel[2]) ? 60000 : /^hour/.test(rel[2]) ? 3600000 : /^day/.test(rel[2]) ? 86400000 : 604800000;
    const rest = (s.slice(0, rel.index) + " " + s.slice((rel.index || 0) + rel[0].length)).replace(/\s+/g, " ").trim();
    return { fireAt: nowMs + n * unit, text: rest.replace(/^to /, "").trim() };
  }
  // absolute day + optional clock time (time is matched after the day is cut)
  const dt = extractDate(s, new Date(nowMs));
  const base = dt ? dt.rest : s;
  const tm = base.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!dt && !tm) return null;
  let rest = base;
  let hh = 9, mm = 0; // default: 9:00 AM
  if (tm) {
    hh = parseInt(tm[1], 10);
    mm = tm[2] ? parseInt(tm[2], 10) : 0;
    if (hh > 23 || mm > 59) return null;
    if (tm[3]) {
      if (hh > 12) return null;
      if (/pm/.test(tm[3]) && hh < 12) hh += 12;
      if (/am/.test(tm[3]) && hh === 12) hh = 0;
    }
    rest = (base.slice(0, tm.index) + " " + base.slice((tm.index || 0) + tm[0].length)).replace(/\s+/g, " ").trim();
  }
  const day = dt ? dt.date : toLocalDate(new Date(nowMs));
  const parts = day.split("-").map(Number);
  let fireAt = new Date(parts[0], parts[1] - 1, parts[2], hh, mm, 0, 0).getTime();
  if (!dt && fireAt <= nowMs) fireAt += 86400000; // "at 9am" already past today -> tomorrow
  return { fireAt, text: rest.replace(/^to /, "").trim() };
}

function toLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "today at 3:00 PM", "tomorrow at 9:00 AM", "Fri, Sep 25 at 2:30 PM". */
export function formatWhen(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms), n = new Date(nowMs);
  const sameDay = d.toDateString() === n.toDateString();
  const tom = new Date(n); tom.setDate(n.getDate() + 1);
  const isTom = d.toDateString() === tom.toDateString();
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
  if (sameDay) return `today at ${time}`;
  if (isTom) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

/** Conversational capture: "just met James from Vertex, he's evaluating the pilot".
 *  Deterministic heuristics — person name, company after "from"/a capitalized
 *  "at", trailing clause as the note. Never invents fields: anything missing
 *  stays empty for the confirmation card. */
export interface CaptureParse { name: string; company: string; note: string }
export function parseCapture(rest: string): CaptureParse {
  const s = rest.trim();
  let company = "";
  const fromM = s.match(/\bfrom ((?:[A-Z0-9][\w&.'-]* ?){1,3})/);
  const atM = s.match(/\bat ([A-Z][\w&.'-]*(?: +[A-Z][\w&.'-]+){0,2})/);
  const cm = fromM || atM;
  if (cm) company = cm[1].trim();
  // name: leading segment before the company marker / first comma, minus
  // trailing "at <place>" phrases that aren't companies ("at the conference")
  let head = cm && cm.index !== undefined ? s.slice(0, cm.index).trim() : s;
  head = head.split(",")[0].trim();
  head = head.replace(/\s+at\s+.+$/i, "").replace(/\s+from\s+.+$/i, "").replace(/\s+from\s*$/i, "").trim();
  let name = "";
  if (/^[A-Z][\w.'-]*( [A-Z][\w.'-]*){0,3}$/.test(head)) name = head;
  else if (/^[a-z][\w.'-]*( [a-z][\w.'-]*){0,3}$/.test(head)) {
    name = head.replace(/\w+/g, (w) => w[0].toUpperCase() + w.slice(1)); // "james" -> "James"
  }
  // note: trailing clause after the first comma, else whatever follows the company
  let note = "";
  const ci = s.indexOf(",");
  if (ci >= 0) note = s.slice(ci + 1).trim();
  else if (cm && cm.index !== undefined) note = s.slice(cm.index + cm[0].length).replace(/^[,. ]+/, "").trim();
  return { name, company, note };
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
  const cased = raw.replace(/[?!.,;:]+$/g, "").replace(/\s+/g, " ").trim(); // no lowercasing: stage labels keep their case
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

  // ---- automations (routines / schedules / triggers) --------------------------------
  // Must precede the brief/hygiene/read/write matchers: "schedule morning brief …"
  // contains "morning brief", "delete routine x" would otherwise read as delete_task, etc.
  else if ((m = text.match(/^(?:save|create) routine ([a-z0-9][\w\- ]{0,40}?):\s*(.+)$/))) set("save_routine", { name: m[1].trim(), steps: m[2].trim() });
  else if (/^(list |show )?routines$/.test(text)) set("list_routines");
  else if ((m = text.match(/^delete routine (.+)$/))) set("delete_routine", { name: m[1].trim() });
  else if ((m = text.match(/^(?:show |describe )?routine (.+)$/))) set("show_routine", { name: m[1].trim() });
  else if ((m = text.match(/^schedule (.+?) (every weekday at .+|daily at .+|each day at .+|every (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday) at .+|every \d+ (?:minutes?|hours?))$/))) set("schedule_add", { routine: m[1].trim(), when: m[2].trim() });
  else if (/^(list |show )?schedules$/.test(text)) set("list_schedules");
  else if ((m = text.match(/^unschedule (.+)$/))) set("unschedule", { ref: m[1].trim() });
  else if ((m = text.match(/^pause schedule (.+)$/))) set("pause_schedule", { ref: m[1].trim() });
  else if ((m = text.match(/^resume schedule (.+)$/))) set("resume_schedule", { ref: m[1].trim() });
  else if ((m = text.match(/^when (.+?) run (.+)$/))) set("trigger_add", { event: m[1].trim(), routine: m[2].trim() });
  else if (/^(list |show )?triggers$/.test(text)) set("list_triggers");
  else if ((m = text.match(/^delete trigger (\d+)$/))) set("delete_trigger", { id: m[1] });
  else if (/^trigger help$/.test(text)) set("trigger_help");
  else if (/^(automation runs|list runs|run history|recent runs)$/.test(text)) set("list_runs");
  else if ((m = text.match(/^run (.+)$/))) set("run_routine", { name: m[1].trim() });

  // ---- workspaces -------------------------------------------------------------------
  // After automations (so "run …" doesn't swallow anything), before the read
  // matchers below.
  else if (/^(list |show )?workspaces$/.test(text)) set("list_workspaces");
  else if (/^current workspace$/.test(text)) set("current_workspace");
  else if ((m = text.match(/^(?:switch to|use workspace|switch workspace to) (.+)$/))) set("switch_workspace", { name: m[1].trim() });

  // ---- meridian -----------------------------------------------------------------------
  // Prefixed with "meridian" so nothing collides with exec-crm intents.
  // "meridian recon Austin" requests a NEW run; "meridian recon(s)" lists sprints.
  else if (/^meridian recons?$/.test(text)) set("list_recons");
  else if ((m = cased.match(/^meridian (?:recon|run) (.+)$/i))) set("meridian_request", { city: m[1].trim() });
  else if ((m = text.match(/^meridian dossier (.+)$/))) set("meridian_dossier", { query: m[1].trim() });
  else if ((m = text.match(/^meridian entities (.+)$/))) {
    // Optional trailing type filter: "meridian entities austin company".
    const parts = m[1].trim().split(/\s+/);
    const maybeType = parts[parts.length - 1].toLowerCase();
    if (parts.length > 1 && mer.NODE_TYPES.includes(maybeType)) {
      set("meridian_entities", { query: parts.slice(0, -1).join(" "), etype: maybeType });
    } else {
      set("meridian_entities", { query: m[1].trim() });
    }
  }

  // ---- pipeline stages ------------------------------------------------------------
  // Before the deal matchers: "move stage X before Y" must not read as move_deal.
  // Stage names keep the user's capitalization (they're proper labels in the CRM);
  // ref/query slots stay lowercase for fuzzy matching.
  else if (/^(list |show |get |all )?(pipeline )?stages$/i.test(cased)) set("list_stages");
  else if ((m = cased.match(/^(?:add|create|new)(?: a| an)? stage (.+?)(?: (before|after) (.+))?$/i))) {
    set("add_stage", { name: m[1].trim(), ...(m[2] ? { pos: m[2].toLowerCase(), ref: m[3].trim().toLowerCase() } : {}) });
  }
  else if ((m = cased.match(/^rename stage (.+?) to (.+)$/i))) set("rename_stage", { query: m[1].trim().toLowerCase(), name: m[2].trim() });
  else if ((m = cased.match(/^(?:delete|remove) stage (.+)$/i))) set("delete_stage", { query: m[1].trim().toLowerCase() });
  else if ((m = cased.match(/^move stage (.+?) (before|after) (.+)$/i))) set("move_stage", { query: m[1].trim().toLowerCase(), pos: m[2].toLowerCase(), ref: m[3].trim().toLowerCase() });

  // ---- meeting prep -------------------------------------------------------------------
  // Before the brief/hygiene matchers: "brief me on Acme" contains "brief me".
  else if ((m = cased.match(/^prep me for my call with (.+)$/i))) set("prep_brief", { name: m[1].trim() });
  else if ((m = cased.match(/^brief me on (.+)$/i))) set("prep_brief", { name: m[1].trim() });
  else if ((m = cased.match(/^meeting prep(?: for)? (.+)$/i))) set("prep_brief", { name: m[1].trim() });
  else if ((m = cased.match(/^prep for (.+)$/i))) set("prep_brief", { name: m[1].trim() });

  // ---- analyst & planner -----------------------------------------------------------
  // Before the reads: "analyze my pipeline" must not fall through to "pipeline".
  else if (/^(analyze( my)? pipeline|pipeline stats|pipeline analysis|how'?s my pipeline|pipeline report)$/.test(text)) set("analyze_pipeline");
  else if (/^(forecast|sales forecast|revenue forecast|what will close this quarter|quarterly forecast|this quarter'?s forecast)$/.test(text)) set("forecast");
  else if (/^(sales cycle|deal velocity|sales velocity|pipeline velocity|average sales cycle|cycle time|where do deals stall)$/.test(text)) set("sales_cycle");
  else if (/^(top deals|biggest deals|largest deals|leaderboard)$/.test(text)) set("top_deals");
  else if (/^(campaign performance|campaign roi|campaign stats|campaign report)$/.test(text)) set("campaign_stats");
  else if (/^(closing soon|closing this month|upcoming closes|deals closing soon)$/.test(text)) set("closing_soon");
  else if (/^(pin (this|it)( as( a)? widget)?|pin( a)? widget|add( a)? widget|save (this|it)( as( a)? widget)?)$/.test(text)) set("pin_widget");
  else if (/^(plan my day|daily plan|plan today|today'?s plan)$/.test(text)) set("plan_day");
  else if (/^(plan my week|weekly plan|plan this week|this week'?s plan)$/.test(text)) set("plan_week");
  else if ((m = cased.match(/^break down (.+)$/i))) set("plan_breakdown", { goal: m[1].trim() });
  else if ((m = cased.match(/^plan (.+)$/i))) set("plan_breakdown", { goal: m[1].trim() });

  // ---- routines ---------------------------------------------------------------
  else if (/\b(morning brief|daily brief|brief me|briefing)\b/.test(text)) set("brief");
  else if (/\b(pipeline hygiene|hygiene|health check|cleanup|stale deals|what needs attention|needs attention)\b/.test(text)) set("hygiene");

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
  else if ((m = text.match(new RegExp(`^(?:show |list |get )?(${STAGE_WORDS}) deals?$`)))) set("deals", { stage: parseStage(m[1])! });
  else if ((m = text.match(new RegExp(`^(?:list |show |get |all )?${DEAL_WORD}s? in (\\w[\\w ]*)$`)))) {
    // hardcoded aliases resolve here; custom/editable stages resolve in
    // brain.ts via crm.resolveStage (exec-crm lets users edit the pipeline).
    const st = parseStage(m[1]);
    if (st) set("deals", { stage: st }); else set("deals", { stage_name: m[1] });
  }
  // "show <stage> deals" for editable stages: "show pre negotiation deals".
  // Hardcoded aliases are caught by the STAGE_WORDS matcher above.
  else if ((m = text.match(/^(?:show |list |get )(.+?) deals?$/))) {
    const st = parseStage(m[1]);
    if (/^(all|my|open)$/.test(m[1])) set("deals");
    else if (st) set("deals", { stage: st });
    else set("deals", { stage_name: m[1] });
  }
  else if ((m = text.match(/^(?:list |show |get |find |search )?contacts?(?: (?:named|called|like|for) (.+))?$/))) set("contacts", m[1] ? { search: m[1] } : {});
  else if ((m = text.match(new RegExp(`^(?:show|get|open|display|tell me about) ${DEAL_WORD} (.+)$`)))) set("deal_detail", { query: m[1] });
  else if ((m = text.match(/^(?:show|get|find|lookup|tell me about) contact (.+)$/))) set("contact_detail", { query: m[1] });
  else if ((m = text.match(/^(?:who is|who'?s) (.+)$/))) set("contact_detail", { query: m[1] });
  else if ((m = text.match(/^(?:show|get|find) company (.+)$/))) set("companies", { search: m[1] });
  else if ((m = text.match(/^(?:show|get|list) tasks?(?: for| about| on)? (.+)$/))) set("tasks", { search: m[1] });
  else if ((m = text.match(/^search (.+)$/))) set("search", { query: m[1] });

  // ---- camera / OCR -------------------------------------------------------------
  else if (/^(read this|read the photo|read it|what does this say|what'?s in (this|the) (photo|picture|image)|transcribe (this|it|the photo|the image))$/.test(text)) set("ocr_read");
  else if (/^(analyze (this |the |my )?handwriting|handwriting analysis|what does the handwriting (say|show)|describe (this |the |my )?handwriting)$/.test(text)) set("handwriting");
  else if (/^(save note to a deal|save this note|file this note)$/.test(text)) set("save_note");
  else if (/^(my notes|notes|list notes|show notes|saved notes)$/.test(text)) set("notes");

  // ---- deal writes --------------------------------------------------------------
  else if ((m = text.match(new RegExp(`^(?:mark |set )?${DEAL_WORD} (.+?) as (?:closed[ -]?)?(won|lost)$`)))) set("close_deal", { query: m[1], result: m[2] });
  else if ((m = text.match(/^(?:mark|close) (.+?) (?:as )?(won|lost)$/))) set("close_deal", { query: stripDealWord(m[1]), result: m[2] });
  else if ((m = text.match(new RegExp(`^(?:move |shift |put )${DEAL_WORD}? ?(.+?) to ([\\w ]+)$`)))) {
    const st = parseStage(m[2]);
    if (st) set("move_deal", { query: stripDealWord(m[1]), stage: st });
  }
  else if ((m = text.match(new RegExp(`^delete ${DEAL_WORD} (.+)$`)))) set("delete_deal", { query: m[1] });
  // Deal notes live in Milton's own SQLite (exec-crm has no deal-notes
  // endpoint). Colon form is explicit; the space form splits on the longest
  // known deal title in brain.ts.
  else if ((m = text.match(/^(?:add )?note (?:on|to) (.+?)\s*:\s*(.+)$/))) set("add_note", { query: m[1].trim(), text: m[2].trim() });
  else if ((m = text.match(/^(?:add )?note (?:on|to) (.+)$/))) set("add_note", { rest: m[1].trim() });
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
  // Campaigns require a company in exec-crm; "for <company>" is optional here
  // and asked for on the next turn when missing. Names keep their case.
  else if ((m = cased.match(/^(?:add|create|new)(?: a| an)? campaign (.+)$/i))) {
    let rest = m[1]; let company = "";
    const fm = rest.match(/\sfor\s(.+)$/i);
    if (fm) { company = fm[1].trim(); rest = rest.slice(0, fm.index).trim(); }
    set("add_campaign", { name: rest, company });
  }
  else if (/^import (?:these |the |my )?contacts?$/.test(text)) set("import_contacts");
  else if (/^import (?:the )?vcf(?: file)?$/.test(text)) set("import_contacts");
  else if (/^import vcard(?: file)?$/.test(text)) set("import_contacts");
  else if ((m = cased.match(/^(?:i )?(?:just )?met (.+)$/i))) set("capture", { rest: m[1].trim() });

  // ---- one-shot reminders ----------------------------------------------------------
  // Placed before delete_task: "delete reminder 2" must not parse as deleting a task.
  else if ((m = text.match(/^(?:cancel|delete|remove) reminder (\d+)$/))) set("remind_cancel", { id: m[1] });
  else if (/^(reminders|remind me list|list reminders|my reminders|show reminders|what are my reminders)$/.test(text)) set("remind_list");
  else if (/^remind me\b/.test(text)) {
    const rest = text.replace(/^remind me\b/, "").trim().replace(/^to /, "");
    set("remind_add", { rest });
  }
  // ---- task writes -----------------------------------------------------------------
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

// Structured help: every example command is paired with the intent it must
// parse to. helpText() renders this; the test suite asserts each example
// parses to its paired intent so help and parser can't drift apart.
export interface HelpRow { cmds: [string, IntentName][]; note: string }
export interface HelpLevel { title: string; rows: HelpRow[] }

export const HELP_LEVELS: HelpLevel[] = [
  {
    title: "🟢 Beginner — everyday commands",
    rows: [
      { cmds: [["morning brief", "brief"]], note: "today's digest: pipeline, closing soon, tasks, activity" },
      { cmds: [["my tasks", "tasks"], ["kpis", "kpis"], ["list deals in negotiation", "deals"], ["show negotiation deals", "deals"], ["show deal Acme", "deal_detail"]], note: "" },
      { cmds: [["sales cycle", "sales_cycle"], ["top deals", "top_deals"], ["closing soon", "closing_soon"]], note: "where deals stall, biggest open deals, closes in the next 30 days" },
      { cmds: [["campaign stats", "campaign_stats"], ["stale deals", "hygiene"], ["what needs attention", "hygiene"]], note: "campaign win rates & pipeline hygiene" },
      { cmds: [["pin this as a widget", "pin_widget"], ["add widget", "pin_widget"]], note: "pin the last analysis to the Milton tab in exec-crm" },
      { cmds: [["who is Jane Doe", "contact_detail"], ["search acme", "search"]], note: "contact detail cards and cross-entity search" },
      { cmds: [["note on Acme: called today, wants the proposal", "add_note"]], note: "pin a note to a deal — kept in Milton, shown on deal lookup" },
      { cmds: [["new campaign Q4 Push for Acme", "add_campaign"]], note: "campaigns need a company — I'll ask if you skip it" },
      { cmds: [["move Acme deal to negotiation", "move_deal"]], note: "" },
      { cmds: [["add contact Jane Doe at Acme jane@acme.com", "add_contact"]], note: "" },
      { cmds: [["add task Call Acme tomorrow", "add_task"]], note: "" },
      { cmds: [["workspaces", "list_workspaces"], ["switch to Acme", "switch_workspace"]], note: "" },
      { cmds: [["meridian recons", "list_recons"], ["meridian dossier Austin", "meridian_dossier"]], note: "read Meridian recon" },
      { cmds: [["prep me for my call with Acme", "prep_brief"]], note: "meeting prep: who, open deals, tasks, talking points" },
      { cmds: [["import these contacts", "import_contacts"]], note: "attach a .vcf file first — I list what's inside before importing" },
      { cmds: [["remind me to call Sarah tomorrow at 9am", "remind_add"]], note: "one-shot reminder — I'll ping you here when it's due" },
      { cmds: [["just met James from Vertex, he's evaluating the pilot", "capture"]], note: "log who you met — I show what I picked up before saving anything" },
      { cmds: [["reminders", "remind_list"], ["cancel reminder 2", "remind_cancel"]], note: "" },
    ],
  },
  {
    title: "🟡 Intermediate — automate the repeatable",
    rows: [
      { cmds: [["save routine EOD: my tasks; kpis", "save_routine"]], note: "chain commands into one routine" },
      { cmds: [["run EOD", "run_routine"], ["show routine EOD", "show_routine"], ["delete routine EOD", "delete_routine"]], note: "" },
      { cmds: [["schedule EOD every weekday at 6pm", "schedule_add"]], note: "put routines on a clock" },
      { cmds: [["pause schedule 3", "pause_schedule"], ["resume schedule 3", "resume_schedule"], ["unschedule 3", "unschedule"]], note: "" },
      { cmds: [["add stage Discovery before proposal", "add_stage"], ["rename stage Proposal to Scoping", "rename_stage"]], note: "edit the pipeline schema" },
      { cmds: [["meridian recon Austin", "meridian_request"]], note: "request a new Meridian recon — I report back when it finishes" },
      { cmds: [["meridian entities Austin company", "meridian_entities"]], note: "its orgs, filtered by type" },
      { cmds: [["analyze my pipeline", "analyze_pipeline"], ["forecast", "forecast"]], note: "pipeline stats & weighted forecast — deterministic, plus analyst-model insights when set" },
      { cmds: [["plan my day", "plan_day"], ["plan my week", "plan_week"]], note: "prioritized plan from tasks, closing deals, stale deals" },
      { cmds: [["break down launch event", "plan_breakdown"]], note: "numbered steps from a built-in template — I ask before creating them as tasks; the analyst model will make them smarter when it returns" },
    ],
  },
  {
    title: "🔴 Advanced — events, webhooks, destructive ops",
    rows: [
      { cmds: [["when deal won run celebrate", "trigger_add"]], note: "fire a routine on exec-crm events" },
      { cmds: [["when deal.stage_changed where stage=negotiation run prep", "trigger_add"]], note: "filtered triggers" },
      { cmds: [["trigger help", "trigger_help"]], note: "every supported event" },
      { cmds: [["delete stage Discovery", "delete_stage"]], note: "asks first, moves its deals somewhere safe" },
      { cmds: [["delete deal Old Opp", "delete_deal"]], note: "destructive — always confirms first" },
      { cmds: [["close Acme deal as won", "close_deal"], ["mark Acme deal as lost", "close_deal"]], note: "closing a deal asks first too" },
      { cmds: [["read this", "ocr_read"], ["analyze handwriting", "handwriting"]], note: "after 📷-snapping text" },
      { cmds: [], note: "Webhooks in: `POST /api/hooks/exec-crm` · `POST /api/hooks/meridian` (header `X-Milton-Secret` from `MILTON_HOOK_SECRET`)" },
      { cmds: [["automation runs", "list_runs"]], note: "history, 🔔 bell, and live toasts in the ⚙️ Automations panel" },
    ],
  },
];

export function helpText(): string {
  const lines = ["**Milton — what I can do**", ""];
  for (const level of HELP_LEVELS) {
    lines.push(`**${level.title}**`);
    for (const row of level.rows) {
      if (!row.cmds.length) { lines.push(row.note); continue; }
      const cmds = row.cmds.map(([c]) => `\`${c}\``).join(" · ");
      lines.push(row.note ? `${cmds} — ${row.note}` : cmds);
    }
    lines.push("");
  }
  lines.push("Anything else I don't recognize goes to your LLM if `MILTON_LLM_URL` is set.");
  lines.push("I'll ask before anything destructive, and let you pick when a name matches more than one record.");
  return lines.join("\n");
}

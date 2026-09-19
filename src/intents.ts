// intents.ts — deterministic natural-language parser for Milton.
// No ML, no dependencies: ordered regex matchers over normalized text.

import * as mer from "./meridian";

export type IntentName =
  | "help" | "pipeline" | "deals" | "deal_detail" | "kpis" | "tasks"
  | "contacts" | "companies" | "brief" | "hygiene" | "webhooks" | "hooks"
  | "deliveries" | "activities" | "notes"
  | "add_deal" | "move_deal" | "set_deal_field" | "close_deal" | "delete_deal"
  | "add_contact" | "add_company" | "add_task" | "complete_task" | "reopen_task"
  | "delete_task" | "remind"
  | "ocr_read" | "handwriting" | "save_note"
  | "prep_brief"
  | "save_routine" | "run_routine" | "list_routines" | "delete_routine" | "show_routine"
  | "schedule_add" | "list_schedules" | "unschedule" | "pause_schedule" | "resume_schedule"
  | "trigger_add" | "list_triggers" | "delete_trigger" | "trigger_help" | "list_runs"
  | "list_workspaces" | "switch_workspace" | "current_workspace"
  | "list_recons" | "meridian_dossier" | "meridian_entities" | "meridian_request"
  | "list_stages" | "add_stage" | "rename_stage" | "delete_stage" | "move_stage"
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
      { cmds: [["my tasks", "tasks"], ["kpis", "kpis"], ["list deals in negotiation", "deals"], ["show deal Acme", "deal_detail"]], note: "" },
      { cmds: [["move Acme deal to negotiation", "move_deal"]], note: "" },
      { cmds: [["add contact Jane Doe at Acme jane@acme.com", "add_contact"]], note: "" },
      { cmds: [["add task Call Acme tomorrow", "add_task"]], note: "" },
      { cmds: [["workspaces", "list_workspaces"], ["switch to Acme", "switch_workspace"]], note: "" },
      { cmds: [["meridian recons", "list_recons"], ["meridian dossier Austin", "meridian_dossier"]], note: "read Meridian recon" },
      { cmds: [["prep me for my call with Acme", "prep_brief"]], note: "meeting prep: who, open deals, tasks, talking points" },
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

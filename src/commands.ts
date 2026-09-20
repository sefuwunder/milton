// commands.ts — Milton's canonical command registry, shared by the
// slash-command palette (frontend), GET /api/commands, and the graceful
// "did you mean…" suggestions when parsing fails.
//
// The registry is built from real parser data: every example comes from
// HELP_LEVELS (the same strings the help-intent tests assert against), and
// `usage` for each intent is a command that actually parses to that intent
// (enforced by tests/usability.test.ts).

import { HELP_LEVELS, INTENT_NAMES, type IntentName } from "./intents";
import { boundedEdit } from "./fuzzy";

export interface CommandMeta {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  /** Parser plumbing (confirmations, choices, disambiguation) — not palette commands. */
  internal?: boolean;
}

const INTERNAL: IntentName[] = [
  "unknown", "confirm_yes", "confirm_no", "choose_number", "disambiguate_intent",
];

/** One-line, plain-English descriptions. Every non-internal intent needs one. */
const DESCRIPTIONS: Record<string, string> = {
  help: "Show everything Milton can do",
  pipeline: "Pipeline overview by stage",
  deals: "List deals, optionally filtered by stage",
  deal_detail: "Deal detail card",
  kpis: "Key metrics dashboard",
  tasks: "List tasks",
  contacts: "List contacts",
  companies: "List companies",
  brief: "Morning brief digest",
  hygiene: "Pipeline hygiene — stale deals and what needs attention",
  webhooks: "Outgoing webhooks",
  hooks: "Incoming webhooks",
  deliveries: "Webhook delivery log",
  activities: "Recent exec-crm activity",
  notes: "Milton's saved notes",
  add_deal: "Create a deal",
  move_deal: "Move a deal to another stage",
  set_deal_field: "Update a deal field (value, owner, close date…)",
  close_deal: "Mark a deal won or lost",
  delete_deal: "Delete a deal (asks first)",
  add_contact: "Add a contact",
  add_company: "Add a company",
  add_task: "Add a task",
  complete_task: "Mark a task done",
  reopen_task: "Reopen a task",
  delete_task: "Delete a task (asks first)",
  remind_add: "Set a one-shot reminder",
  remind_list: "List pending reminders",
  remind_cancel: "Cancel a reminder",
  import_contacts: "Import contacts from a .vcf file",
  capture: "Log someone you just met",
  ocr_read: "Read text from the attached photo",
  handwriting: "Analyze handwriting in the attached photo",
  save_note: "File the last photo note to a deal",
  prep_brief: "Meeting prep for a contact or company",
  analyze_pipeline: "Pipeline stats and analysis",
  forecast: "Weighted revenue forecast",
  plan_day: "Prioritized plan for today",
  plan_week: "Prioritized plan for the week",
  plan_breakdown: "Break a goal into task steps",
  sales_cycle: "Average sales cycle and where deals stall",
  top_deals: "Biggest open deals",
  campaign_stats: "Campaign performance stats",
  closing_soon: "Deals closing in the next 30 days",
  pin_widget: "Pin the last analysis to exec-crm's Milton tab",
  contact_detail: "Contact detail card",
  search: "Search across deals, contacts, companies, tasks",
  add_note: "Pin a note to a deal",
  add_campaign: "Create a campaign",
  save_routine: "Save a chain of commands as a routine",
  run_routine: "Run a saved routine",
  list_routines: "List saved routines",
  delete_routine: "Delete a routine",
  show_routine: "Show a routine's steps",
  schedule_add: "Put a routine on a schedule",
  list_schedules: "List schedules",
  unschedule: "Remove a schedule",
  pause_schedule: "Pause a schedule",
  resume_schedule: "Resume a schedule",
  trigger_add: "Run a routine on an exec-crm event",
  list_triggers: "List event triggers",
  delete_trigger: "Delete a trigger",
  trigger_help: "Show supported trigger events",
  list_runs: "Automation run history",
  list_workspaces: "List exec-crm workspaces",
  switch_workspace: "Switch the active workspace",
  current_workspace: "Show the active workspace",
  chat_session: "Manage named chat sessions",
  list_recons: "List Meridian recon sprints",
  meridian_dossier: "Meridian city dossier",
  meridian_entities: "Meridian entities for a city",
  meridian_request: "Request a new Meridian recon",
  meridian_enrich: "Enrich a company: public profile + principal contacts",
  meridian_enrich_status: "Check the running enrichment job",
  meridian_prospect: "Prospect companies in a territory; stages them into the Data Workshop Sandbox",
  meridian_prospect_status: "Check the running prospect job",
  list_stages: "List pipeline stages",
  add_stage: "Add a pipeline stage",
  rename_stage: "Rename a pipeline stage",
  delete_stage: "Delete a pipeline stage (asks first)",
  move_stage: "Reorder a pipeline stage",
  add_custom_field: "Add a custom field",
  set_custom_field: "Set a custom field value",
  show_custom_fields: "Show custom fields",
  delete_custom_field: "Delete a custom field (asks first)",
  tutorial: "Interactive Milton tutorial",
  wizard_start: "Guided setup — new deal, contact, company, or task",
  undo: "Undo the last change",
  deal_journey: "Stage-history timeline for a deal",
  task_blockers: "What's blocking a task",
  duplicates: "Find duplicate contacts and companies",
  deals_by_source: "Deals from a given source",
};

/** A usage example for each intent that must parse back to that intent. */
const USAGE: Record<string, string> = {
  help: "help",
  pipeline: "show pipeline",
  deals: "list deals",
  deal_detail: "show deal Acme",
  kpis: "kpis",
  tasks: "my tasks",
  contacts: "contacts",
  companies: "list companies",
  brief: "morning brief",
  hygiene: "stale deals",
  webhooks: "webhooks",
  hooks: "incoming hooks",
  deliveries: "deliveries",
  activities: "recent activity",
  notes: "my notes",
  add_deal: "add deal Website redesign for Acme worth 50k",
  move_deal: "move Acme deal to negotiation",
  set_deal_field: "set Acme deal value to 60k",
  close_deal: "close Acme deal as won",
  delete_deal: "delete deal Old Opp",
  add_contact: "add contact Jane Doe at Acme jane@acme.com",
  add_company: "add company Vertex Industries",
  add_task: "add task Call Acme tomorrow",
  complete_task: "complete Website redesign",
  reopen_task: "reopen Website redesign",
  delete_task: "delete task Old task",
  remind_add: "remind me to call Sarah tomorrow at 9am",
  remind_list: "reminders",
  remind_cancel: "cancel reminder 2",
  import_contacts: "import these contacts",
  capture: "just met James from Vertex",
  ocr_read: "read this",
  handwriting: "analyze handwriting",
  save_note: "save this note",
  prep_brief: "prep me for my call with Acme",
  analyze_pipeline: "analyze my pipeline",
  forecast: "forecast",
  plan_day: "plan my day",
  plan_week: "plan my week",
  plan_breakdown: "break down launch event",
  sales_cycle: "sales cycle",
  top_deals: "top deals",
  campaign_stats: "campaign stats",
  closing_soon: "closing soon",
  pin_widget: "pin this as a widget",
  contact_detail: "who is Jane Doe",
  search: "search acme",
  add_note: "note on Acme: called today",
  add_campaign: "new campaign Q4 Push",
  save_routine: "save routine EOD: my tasks; kpis",
  run_routine: "run EOD",
  list_routines: "list routines",
  delete_routine: "delete routine EOD",
  show_routine: "show routine EOD",
  schedule_add: "schedule EOD every weekday at 6pm",
  list_schedules: "list schedules",
  unschedule: "unschedule 3",
  pause_schedule: "pause schedule 3",
  resume_schedule: "resume schedule 3",
  trigger_add: "when deal won run celebrate",
  list_triggers: "list triggers",
  delete_trigger: "delete trigger 2",
  trigger_help: "trigger help",
  list_runs: "automation runs",
  list_workspaces: "workspaces",
  switch_workspace: "switch to Acme",
  current_workspace: "current workspace",
  chat_session: "new session Pipeline review",
  list_recons: "meridian recons",
  meridian_dossier: "meridian dossier Austin",
  meridian_entities: "meridian entities Austin company",
  meridian_request: "meridian recon Austin",
  meridian_enrich: "meridian enrich Acme",
  meridian_enrich_status: "enrichment status",
  meridian_prospect: "meridian prospect dental clinics in Madisonville",
  meridian_prospect_status: "prospect status",
  list_stages: "stages",
  add_stage: "add stage Discovery before proposal",
  rename_stage: "rename stage Proposal to Scoping",
  delete_stage: "delete stage Discovery",
  move_stage: "move stage Discovery before Proposal",
  add_custom_field: "add custom field Renewal date to contacts",
  set_custom_field: "set Renewal date to 2026-10-01 for contact Amara",
  show_custom_fields: "show custom fields for contacts",
  delete_custom_field: "remove custom field Renewal date from contacts",
  tutorial: "tutorial",
  wizard_start: "new deal",
  undo: "undo",
  deal_journey: "deal journey Acme",
  task_blockers: "what's blocking Website redesign",
  duplicates: "show duplicates",
  deals_by_source: "deals from Referral",
};

let cached: CommandMeta[] | null = null;

/** All commands, sorted by name. Built once from HELP_LEVELS + DESCRIPTIONS. */
export function commandRegistry(): CommandMeta[] {
  if (cached) return cached;
  const by: Record<string, CommandMeta> = {};
  const touch = (intent: string, example: string) => {
    const e = by[intent] || (by[intent] = {
      name: intent,
      description: DESCRIPTIONS[intent] || "",
      usage: USAGE[intent] || "",
      examples: [],
      internal: (INTERNAL as string[]).includes(intent) || undefined,
    });
    if (!e.examples.includes(example)) e.examples.push(example);
    return e;
  };
  for (const level of HELP_LEVELS)
    for (const row of level.rows)
      for (const [example, intent] of row.cmds)
        touch(intent, example);
  // every parser intent is registered, even with no HELP_LEVELS examples
  for (const intent of INTENT_NAMES) {
    if (!by[intent]) touch(intent, USAGE[intent] || "");
  }
  cached = Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

/**
 * Suggest the closest registry commands for a message we couldn't parse.
 * Scores every input word against command names, name parts, usage words,
 * help examples, and description words with bounded edit distance, then
 * averages — so "updo" → undo, "deal jurney" → deal_journey, and commands
 * matching more of the input win over single-word ties.
 */
export function suggestCommands(raw: string, n = 3): CommandMeta[] {
  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  const cmds = commandRegistry().filter((c) => !c.internal);
  const scored = cmds.map((c) => {
    const targets = new Set<string>([
      c.name,
      ...c.name.split("_"),
      ...c.usage.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
      ...c.examples.flatMap((e) => e.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
      ...c.description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    ]);
    let total = 0;
    for (const w of words) {
      let best = Infinity;
      for (const t of targets) {
        const d = boundedEdit(w, t, 4);
        // a real match: at most a third of the shorter word may be wrong
        // ("updo"→"undo", "dupicates"→"duplicates"); pure noise like
        // "frobnicator"→"activities" (d=5 of 10 chars) is capped instead.
        if (d <= Math.max(1, Math.floor(Math.min(w.length, t.length) / 3))) {
          const scaled = d / Math.max(w.length, t.length);
          if (scaled < best) best = scaled;
        }
      }
      total += best === Infinity ? 1 : best; // one garbage word caps at 1
    }
    return { c, score: total / words.length };
  });
  scored.sort((a, b) => a.score - b.score);
  // If not a single input word landed within edit distance of any target,
  // there is no meaningful suggestion — return nothing and let the caller
  // fall back to generic help chips instead of alphabetical noise.
  if (!scored.length || scored[0].score >= 1) return [];
  return scored.slice(0, n).map((s) => s.c);
}

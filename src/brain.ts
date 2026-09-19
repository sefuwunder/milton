// brain.ts — Milton's reasoning layer: intent -> exec-crm actions -> replies.
// Replies are structured (text + cards + chips) so the chat UI can render richly.

import * as crm from "./crm";
import { parseIntent, helpText, HELP_CHIPS, parseStage, parseMoney, parseDate, type Intent } from "./intents";

export interface Card {
  kind: "deals" | "pipeline" | "kpis" | "tasks" | "contacts" | "companies" | "activities" | "webhooks" | "choices" | "confirm" | "findings";
  title?: string;
  items?: any[];
  rows?: any[];
  options?: { n: number; label: string; sub?: string }[];
  stats?: { label: string; value: string }[];
}
export interface Reply { text: string; cards?: Card[]; chips?: string[] }

export interface PendingAction { type: string; label: string; payload: any }
export interface ChoiceState {
  kind: "deal" | "contact" | "company" | "task";
  options: { id: number; label: string; sub?: string }[];
  then: { action: string; payload: any };
}
export interface Session {
  id: string;
  pending?: PendingAction;
  choice?: ChoiceState;
  history: { role: "user" | "milton"; text: string }[];
}

// ---- formatting helpers -------------------------------------------------------
export function fmtMoney(n: number): string {
  if (!n) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + trimNum(n / 1e6) + "M";
  if (a >= 1e3) return "$" + trimNum(n / 1e3) + "k";
  return "$" + n;
}
function trimNum(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
export function stageLabel(s: string): string {
  return crm.STAGE_LABELS[s] || s;
}
export function todayStr(ref: Date = new Date()): string {
  return ref.toISOString().slice(0, 10);
}
export function daysUntil(dateStr: string, ref: Date = new Date()): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  const r = new Date(ref); r.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - r.getTime()) / 86400000);
}
function duePhrase(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d === null || !dateStr) return "no due date";
  if (d === 0) return "due today";
  if (d === 1) return "due tomorrow";
  if (d < 0) return `${-d}d overdue`;
  return `due in ${d}d (${dateStr})`;
}

// ---- entity picking -----------------------------------------------------------
async function pickDeal(query: string): Promise<{ deal?: crm.Deal; matches: crm.Match<crm.Deal>[] }> {
  const matches = await crm.resolveDeal(query);
  if (!matches.length) return { matches };
  const [top, second] = [matches[0], matches[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) return { deal: top.item, matches };
  return { matches };
}

async function needOne<T extends { id: number }>(
  matches: crm.Match<T>[], kind: ChoiceState["kind"],
  labelOf: (t: T) => string, subOf: (t: T) => string | undefined,
  then: ChoiceState["then"], noun: string
): Promise<{ item?: T; reply?: Reply }> {
  if (!matches.length) return { reply: { text: `I couldn't find any ${noun} matching that. Want me to create it?`, chips: [`Add ${noun} …`] } };
  const [top, second] = [matches[0], matches[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) return { item: top.item };
  const options = matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: labelOf(m.item), sub: subOf(m.item) }));
  return {
    reply: {
      text: `A few ${noun}s match — which one did you mean?`,
      cards: [{ kind: "choices", options }],
      chips: options.map((o) => String(o.n)),
    },
  };
}

// ---- LLM hook (optional, off by default) -----------------------------------------
const LLM_URL = process.env.MILTON_LLM_URL || "";
const LLM_KEY = process.env.MILTON_LLM_KEY || "";
const LLM_MODEL = process.env.MILTON_LLM_MODEL || "local-model";

async function llmReply(question: string, history: Session["history"]): Promise<string | null> {
  if (!LLM_URL) return null;
  try {
    const [deals, tasks, contacts] = await Promise.all([crm.getDeals(), crm.getTasks(), crm.getContacts()]);
    const open = deals.filter((d) => !d.stage.startsWith("closed_"));
    const ctx = [
      `CRM snapshot: ${deals.length} deals (${open.length} open), ${contacts.length} contacts, ${tasks.filter((t) => !t.done).length} open tasks.`,
      "Open deals: " + open.slice(0, 15).map((d) => `${d.title} (${stageLabel(d.stage)}, ${fmtMoney(d.value)})`).join("; "),
      "Stages: prospecting, qualification, proposal, negotiation, closed_won, closed_lost.",
    ].join("\n");
    const res = await fetch(LLM_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}) },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: `You are Milton, a concise CRM assistant inside exec-crm. Answer in 2-4 sentences, plain text, no markdown headers. You can read CRM data but cannot change it in this mode — suggest the exact command the user can type (e.g. "move Acme deal to negotiation").\n${ctx}` },
          ...history.slice(-8).map((h) => ({ role: h.role === "user" ? "user" : "assistant", content: h.text })),
          { role: "user", content: question },
        ],
        max_tokens: 300,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ---- main entry ------------------------------------------------------------------
export async function handleMessage(session: Session, raw: string): Promise<Reply> {
  const intent = parseIntent(raw);

  // 1) resolve an outstanding disambiguation choice
  if (session.choice && intent.name === "choose_number") {
    const n = Number(intent.slots.n);
    const opt = session.choice.options[n - 1];
    if (!opt) return { text: `Pick one of ${session.choice.options.map((o) => o.n).join(", ")}.`, chips: session.choice.options.map((o) => String(o.n)) };
    const ch = session.choice; session.choice = undefined;
    return dispatchChoice(session, ch, opt.id);
  }
  // 2) resolve a pending confirmation
  if (session.pending) {
    if (intent.name === "confirm_yes") {
      const p = session.pending; session.pending = undefined;
      return runPending(p);
    }
    if (intent.name === "confirm_no") {
      session.pending = undefined;
      return { text: "Cancelled — nothing changed.", chips: HELP_CHIPS.slice(0, 3) };
    }
    // anything else cancels the pending action (but still process the new message)
    session.pending = undefined;
  }

  session.history.push({ role: "user", text: raw });
  let reply: Reply;
  try {
    reply = await dispatch(session, intent);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(msg)) {
      reply = { text: `I can't reach exec-crm at ${crm.crmBase()}. Is it running? Start it with \`bun src/server.ts\` in the exec-crm folder, or point me elsewhere with MILTON_CRM_URL.` };
    } else {
      reply = { text: `Something went wrong: ${msg}` };
    }
  }
  session.history.push({ role: "milton", text: reply.text });
  session.history = session.history.slice(-40);
  return reply;
}

async function dispatchChoice(session: Session, ch: ChoiceState, id: number): Promise<Reply> {
  const { action, payload } = ch.then;
  if (ch.kind === "deal") {
    const deals = await crm.getDeals();
    const deal = deals.find((d) => d.id === id);
    if (!deal) return { text: "That deal seems to be gone — try again." };
    return dealAction(session, action, deal, payload);
  }
  if (ch.kind === "task") {
    const tasks = await crm.getTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) return { text: "That task seems to be gone — try again." };
    return taskAction(session, action, task, payload);
  }
  return { text: "I lost track of that choice — try the command again." };
}

async function runPending(p: PendingAction): Promise<Reply> {
  if (p.type === "delete_deal") {
    await crm.deleteDeal(p.payload.id);
    return { text: `Deleted deal "${p.label}".`, chips: ["Show pipeline", "List deals"] };
  }
  if (p.type === "close_lost") {
    const deal = await crm.patchDeal(p.payload.id, { stage: "closed_lost" });
    return { text: `Marked "${deal.title}" as lost.`, cards: [dealCard(deal)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (p.type === "delete_task") {
    await crm.deleteTask(p.payload.id);
    return { text: `Deleted task "${p.label}".`, chips: ["My tasks"] };
  }
  return { text: "Nothing to do." };
}

// ---- dispatch ----------------------------------------------------------------------
async function dispatch(session: Session, intent: Intent): Promise<Reply> {
  const s = intent.slots;
  switch (intent.name) {
    case "help": return { text: helpText(), chips: HELP_CHIPS };
    case "pipeline": return pipelineReply();
    case "deals": return dealsReply(s.stage, s.search);
    case "deal_detail": return dealDetailReply(session, s.query);
    case "kpis": return kpisReply();
    case "tasks": return tasksReply(s.filter, s.search);
    case "contacts": return contactsReply(s.search);
    case "companies": return companiesReply(s.search);
    case "brief": return briefReply();
    case "hygiene": return hygieneReply();
    case "activities": return activitiesReply();
    case "webhooks": return webhooksReply();
    case "hooks": return hooksReply();
    case "deliveries": return deliveriesReply();

    case "add_deal": return addDealReply(s);
    case "move_deal": return dealByName(session, s.query, "move_deal", { stage: s.stage });
    case "close_deal": return dealByName(session, s.query, "close_deal", { result: s.result });
    case "delete_deal": return dealByName(session, s.query, "delete_deal", {});
    case "set_deal_field": return dealByName(session, s.query, "set_deal_field", { field: s.field, value: s.value });

    case "add_contact": return addContactReply(s);
    case "add_company": {
      if (!s.name) return { text: "What should the company be called?" };
      const c = await crm.createCompany({ name: s.name });
      return { text: `Added company "${c.name}".`, chips: ["List companies", `Add contact … at ${c.name}`] };
    }
    case "add_task": return addTaskReply(session, s);
    case "remind": {
      if (!s.title) return { text: "Remind you to do what?" };
      const t = await crm.createTask({ title: s.title, due_date: s.due || "" });
      return { text: `Got it — I'll remind you: "${t.title}"${t.due_date ? ` (${duePhrase(t.due_date)})` : ""}.`, chips: ["My tasks"] };
    }
    case "complete_task": return taskByName(session, s.query, "complete_task", {});
    case "reopen_task": return taskByName(session, s.query, "reopen_task", {});
    case "delete_task": return taskByName(session, s.query, "delete_task", {});

    case "confirm_yes":
    case "confirm_no":
    case "choose_number":
      return { text: "There's nothing pending right now.", chips: HELP_CHIPS.slice(0, 3) };

    case "unknown": {
      const llm = await llmReply(intent.raw, session.history);
      if (llm) return { text: llm, chips: ["Show pipeline", "Morning brief", "Help"] };
      return {
        text: `I'm not sure what you mean by "${intent.raw}". I work best with direct commands — try one of these, or type "help" for the full list.`,
        chips: ["Show pipeline", "Morning brief", "My tasks", "Help"],
      };
    }
  }
}

// ---- read executors ------------------------------------------------------------------
async function pipelineReply(): Promise<Reply> {
  const deals = await crm.getDeals();
  const rows = crm.STAGES.map((st) => {
    const inStage = deals.filter((d) => d.stage === st);
    return { stage: st, label: stageLabel(st), count: inStage.length, value: inStage.reduce((a, d) => a + (d.value || 0), 0) };
  });
  const open = rows.filter((r) => !r.stage.startsWith("closed_"));
  const total = open.reduce((a, r) => a + r.value, 0);
  const count = open.reduce((a, r) => a + r.count, 0);
  return {
    text: `Pipeline: **${count} open deals** worth **${fmtMoney(total)}**.`,
    cards: [{ kind: "pipeline", title: "Pipeline by stage", rows }],
    chips: ["List deals in negotiation", "Pipeline hygiene", "Morning brief"],
  };
}

async function dealsReply(stage?: string, search?: string): Promise<Reply> {
  let deals = await crm.getDeals();
  if (stage) deals = deals.filter((d) => d.stage === stage);
  if (search) {
    const q = search.toLowerCase();
    deals = deals.filter((d) => d.title.toLowerCase().includes(q) || (d.company_name || "").toLowerCase().includes(q));
  }
  deals.sort((a, b) => (b.value || 0) - (a.value || 0));
  if (!deals.length) return { text: "No deals match.", chips: ["Show pipeline"] };
  const label = stage ? `Deals in ${stageLabel(stage)}` : search ? `Deals matching "${search}"` : "All deals";
  return {
    text: `${label} — ${deals.length} deal${deals.length === 1 ? "" : "s"}, ${fmtMoney(deals.reduce((a, d) => a + (d.value || 0), 0))} total.`,
    cards: [{ kind: "deals", title: label, items: deals.slice(0, 20) }],
    chips: ["Show pipeline", "Morning brief"],
  };
}

async function dealDetailReply(session: Session, query: string): Promise<Reply> {
  if (!query) return { text: "Which deal? Try `show deal Acme`." };
  const { deal, matches } = await pickDeal(query);
  if (deal) return { text: `"${deal.title}" at a glance:`, cards: [dealCard(deal)], chips: [`Move ${deal.title} to negotiation`, `Set ${deal.title} value to …`, "Show pipeline"] };
  const need = await needOne(matches, "deal", (d) => d.title, (d) => `${stageLabel(d.stage)} · ${fmtMoney(d.value)}`, { action: "deal_detail", payload: {} }, "deal");
  if (need.item) return { text: `"${need.item.title}" at a glance:`, cards: [dealCard(need.item)] };
  session.choice = {
    kind: "deal",
    options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.title, sub: `${stageLabel(m.item.stage)} · ${fmtMoney(m.item.value)}` })),
    then: { action: "deal_detail", payload: {} },
  };
  return need.reply!;
}

async function kpisReply(): Promise<Reply> {
  const k = await crm.getKpis();
  const stats = [
    { label: "Pipeline value", value: fmtMoney(Number(k.pipeline_value || k.total_pipeline || 0)) },
    { label: "Open deals", value: String(k.open_deals ?? k.deals_open ?? "—") },
    { label: "Win rate", value: k.win_rate != null ? `${k.win_rate}%` : "—" },
    { label: "Avg deal size", value: fmtMoney(Number(k.avg_deal_size || k.average_deal || 0)) },
  ].filter((s) => s.value !== "—" && s.value !== "0");
  const extra = Object.entries(k).filter(([key]) => !/pipeline|deals_open|win_rate|avg|average/i.test(key)).slice(0, 4);
  for (const [key, v] of extra) {
    if (typeof v === "number" || typeof v === "string") stats.push({ label: key.replace(/_/g, " "), value: String(v) });
  }
  return {
    text: stats.length ? "Here's how the business looks right now:" : "KPIs (raw):",
    cards: [{ kind: "kpis", title: "KPIs", stats: stats.length ? stats : [{ label: "raw", value: JSON.stringify(k).slice(0, 200) }] }],
    chips: ["Show pipeline", "Morning brief"],
  };
}

async function tasksReply(filter?: string, search?: string): Promise<Reply> {
  let tasks = await crm.getTasks();
  if (search) {
    const q = search.toLowerCase();
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
  } else if (filter !== "done") {
    tasks = tasks.filter((t) => !t.done);
  } else {
    tasks = tasks.filter((t) => t.done);
  }
  tasks.sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  if (!tasks.length) return { text: filter === "done" ? "No completed tasks yet." : "All clear — no open tasks.", chips: ["Morning brief"] };
  const label = filter === "done" ? "Completed tasks" : search ? `Tasks matching "${search}"` : "Open tasks";
  return {
    text: `${label} — ${tasks.length}:`,
    cards: [{ kind: "tasks", title: label, items: tasks.slice(0, 25) }],
    chips: ["Morning brief", "Pipeline hygiene"],
  };
}

async function contactsReply(search?: string): Promise<Reply> {
  let contacts = await crm.getContacts();
  if (search) {
    const q = search.toLowerCase();
    contacts = contacts.filter((c) => c.name.toLowerCase().includes(q) || (c.company_name || "").toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q));
  }
  if (!contacts.length) return { text: "No contacts match.", chips: ["Add contact …"] };
  return {
    text: `${search ? `Contacts matching "${search}"` : "Contacts"} — ${contacts.length}:`,
    cards: [{ kind: "contacts", title: "Contacts", items: contacts.slice(0, 25) }],
  };
}

async function companiesReply(search?: string): Promise<Reply> {
  let companies = await crm.getCompanies();
  if (search) {
    const q = search.toLowerCase();
    companies = companies.filter((c) => c.name.toLowerCase().includes(q));
  }
  const deals = await crm.getDeals();
  const items = companies.slice(0, 25).map((c) => ({
    ...c,
    sub: `${deals.filter((d) => d.company_id === c.id && !d.stage.startsWith("closed_")).length} open deals`,
  }));
  return {
    text: `${search ? `Companies matching "${search}"` : "Companies"} — ${companies.length}:`,
    cards: [{ kind: "companies", title: "Companies", items }],
  };
}

async function activitiesReply(): Promise<Reply> {
  const acts = await crm.getActivities();
  return {
    text: "Recent activity:",
    cards: [{ kind: "activities", title: "Activity", items: acts.slice(0, 12) }],
  };
}

async function webhooksReply(): Promise<Reply> {
  const hooks = await crm.getWebhooks();
  if (!hooks.length) return { text: "No outgoing webhooks configured. Set them up in exec-crm to fire on deal/contact/task events." };
  return {
    text: `${hooks.length} outgoing webhook${hooks.length === 1 ? "" : "s"}:`,
    cards: [{ kind: "webhooks", title: "Automations", items: hooks }],
    chips: ["Delivery log", "Incoming hooks"],
  };
}

async function hooksReply(): Promise<Reply> {
  const hooks = await crm.getIncomingHooks();
  if (!hooks.length) return { text: "No incoming hooks configured. Create them in exec-crm to let Zapier / Make / n8n push data in." };
  return { text: `${hooks.length} incoming hook${hooks.length === 1 ? "" : "s"}:`, cards: [{ kind: "webhooks", title: "Incoming hooks", items: hooks }] };
}

async function deliveriesReply(): Promise<Reply> {
  const ds = await crm.getDeliveries();
  const items = ds.slice(0, 15).map((d: any) => ({
    ...d,
    sub: `${d.event} · ${d.status}${d.response_code ? ` (${d.response_code})` : ""} · ${d.created_at || ""}`,
  }));
  return { text: ds.length ? "Latest webhook deliveries:" : "No webhook deliveries yet.", cards: [{ kind: "activities", title: "Deliveries", items }] };
}

// ---- routines ------------------------------------------------------------------------
async function briefReply(): Promise<Reply> {
  const [deals, tasks, acts] = await Promise.all([crm.getDeals(), crm.getTasks(), crm.getActivities()]);
  const today = todayStr();
  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const openValue = open.reduce((a, d) => a + (d.value || 0), 0);
  const closingSoon = open.filter((d) => { const n = daysUntil(d.expected_close); return n !== null && n >= 0 && n <= 7; })
    .sort((a, b) => a.expected_close.localeCompare(b.expected_close));
  const overdue = tasks.filter((t) => !t.done && t.due_date && t.due_date < today);
  const dueToday = tasks.filter((t) => !t.done && t.due_date === today);
  const lines = [
    `Good morning. **${open.length} open deals** worth **${fmtMoney(openValue)}**.`,
    closingSoon.length ? `**Closing this week (${closingSoon.length}):** ` + closingSoon.map((d) => `${d.title} (${d.expected_close}, ${fmtMoney(d.value)})`).join("; ") : "Nothing scheduled to close this week.",
    overdue.length ? `**${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}** — ${overdue.slice(0, 3).map((t) => t.title).join("; ")}${overdue.length > 3 ? "…" : ""}` : "No overdue tasks.",
    dueToday.length ? `**Due today:** ${dueToday.map((t) => t.title).join("; ")}` : "",
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    cards: [
      ...(closingSoon.length ? [{ kind: "deals" as const, title: "Closing this week", items: closingSoon }] : []),
      ...(overdue.length || dueToday.length ? [{ kind: "tasks" as const, title: "Needs attention", items: [...overdue, ...dueToday].slice(0, 10) }] : []),
      { kind: "activities" as const, title: "Latest activity", items: acts.slice(0, 5) },
    ],
    chips: ["Show pipeline", "Pipeline hygiene", "My tasks"],
  };
}

async function hygieneReply(): Promise<Reply> {
  const [deals, tasks] = await Promise.all([crm.getDeals(), crm.getTasks()]);
  const today = todayStr();
  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const findings: { icon: string; text: string; fix?: string }[] = [];
  const noClose = open.filter((d) => !d.expected_close);
  if (noClose.length) findings.push({ icon: "📅", text: `${noClose.length} deal${noClose.length === 1 ? "" : "s"} with no expected close date: ${noClose.slice(0, 4).map((d) => d.title).join(", ")}${noClose.length > 4 ? "…" : ""}`, fix: `Set ${noClose[0].title} close date to …` });
  const stale = open.filter((d) => { const n = daysUntil(d.updated_at.slice(0, 10)); return n !== null && n < -30; });
  if (stale.length) findings.push({ icon: "🕸️", text: `${stale.length} stale deal${stale.length === 1 ? "" : "s"} untouched for 30+ days: ${stale.slice(0, 4).map((d) => d.title).join(", ")}${stale.length > 4 ? "…" : ""}` });
  const noContact = open.filter((d) => !d.contact_id);
  if (noContact.length) findings.push({ icon: "👤", text: `${noContact.length} deal${noContact.length === 1 ? "" : "s"} with no contact attached: ${noContact.slice(0, 4).map((d) => d.title).join(", ")}${noContact.length > 4 ? "…" : ""}` });
  const overdue = tasks.filter((t) => !t.done && t.due_date && t.due_date < today);
  if (overdue.length) findings.push({ icon: "⏰", text: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}` });
  if (!findings.length) {
    return { text: "Pipeline is clean — every open deal has a close date, a contact, and recent activity. Nice.", chips: ["Show pipeline", "Morning brief"] };
  }
  return {
    text: `Found ${findings.length} thing${findings.length === 1 ? "" : "s"} worth fixing:`,
    cards: [{ kind: "findings", title: "Pipeline hygiene", items: findings }],
    chips: ["Show pipeline", "My tasks"],
  };
}

// ---- write executors -------------------------------------------------------------------
function dealCard(d: crm.Deal): Card {
  return {
    kind: "deals", title: d.title,
    items: [{ ...d, sub: `${stageLabel(d.stage)} · ${fmtMoney(d.value)} · ${d.probability}% · close ${d.expected_close || "—"}${d.company_name ? ` · ${d.company_name}` : ""}${d.contact_name ? ` · ${d.contact_name}` : ""}` }],
  };
}

async function dealByName(session: Session, query: string, action: string, payload: any): Promise<Reply> {
  if (!query) return { text: "Which deal?" };
  const { deal, matches } = await pickDeal(query);
  if (deal) return dealAction(session, action, deal, payload);
  const need = await needOne(matches, "deal", (d) => d.title, (d) => `${stageLabel(d.stage)} · ${fmtMoney(d.value)}`, { action, payload }, "deal");
  if (need.item) return dealAction(session, action, need.item as crm.Deal, payload);
  session.choice = {
    kind: "deal",
    options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.title, sub: `${stageLabel(m.item.stage)} · ${fmtMoney(m.item.value)}` })),
    then: { action, payload },
  };
  return need.reply!;
}

async function dealAction(session: Session, action: string, deal: crm.Deal, payload: any): Promise<Reply> {
  if (action === "move_deal") {
    const d = await crm.patchDeal(deal.id, { stage: payload.stage });
    return { text: `Moved "${d.title}" to **${stageLabel(d.stage)}**.`, cards: [dealCard(d)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (action === "close_deal") {
    const won = payload.result === "won";
    if (!won) {
      // confirm destructive-ish: mark lost
      session.pending = { type: "close_lost", label: deal.title, payload: { id: deal.id } };
      return {
        text: `Mark "${deal.title}" as **lost**?`,
        cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, mark lost" }, { n: 2, label: "Cancel" }] }],
        chips: ["Yes", "No"],
      };
    }
    const d = await crm.patchDeal(deal.id, { stage: "closed_won", probability: 100 });
    return { text: `🎉 "${d.title}" is **won** — ${fmtMoney(d.value)} in the books.`, cards: [dealCard(d)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (action === "delete_deal") {
    session.pending = { type: "delete_deal", label: deal.title, payload: { id: deal.id } };
    return {
      text: `Delete deal "${deal.title}" (${fmtMoney(deal.value)})? This can't be undone.`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, delete" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  if (action === "set_deal_field") {
    const field = payload.field as string;
    const value = payload.value as string;
    const patch: any = {};
    if (/value|worth|amount/.test(field)) {
      const v = parseMoney(value);
      if (v === null) return { text: `I couldn't parse "${value}" as an amount. Try e.g. "50k".` };
      patch.value = v;
    } else if (/probability|chance/.test(field)) {
      const v = parseInt(value, 10);
      if (isNaN(v)) return { text: `I couldn't parse "${value}" as a probability.` };
      patch.probability = Math.max(0, Math.min(100, v));
    } else if (/close/.test(field)) {
      const dt = parseDate(value);
      if (!dt) return { text: `I couldn't parse "${value}" as a date. Try "Friday" or "2026-10-02".` };
      patch.expected_close = dt;
    } else if (/owner/.test(field)) {
      patch.owner = value;
    } else if (/company/.test(field)) {
      const ms = await crm.resolveCompany(value);
      if (!ms.length) return { text: `No company matching "${value}". Add it first with "add company ${value}".` };
      patch.company_id = ms[0].item.id;
    } else if (/contact/.test(field)) {
      const ms = await crm.resolveContact(value);
      if (!ms.length) return { text: `No contact matching "${value}".` };
      patch.contact_id = ms[0].item.id;
    }
    const d = await crm.patchDeal(deal.id, patch);
    return { text: `Updated "${d.title}".`, cards: [dealCard(d)], chips: ["Show pipeline"] };
  }
  if (action === "deal_detail") {
    return { text: `"${deal.title}" at a glance:`, cards: [dealCard(deal)] };
  }
  if (action === "add_task_deal") {
    const t = await crm.createTask({ title: payload.title, due_date: payload.due || "", deal_id: deal.id });
    return { text: `Added task "${t.title}" linked to deal "${deal.title}".`, chips: ["My tasks", "Morning brief"] };
  }
  return { text: "I lost track of that action — try again." };
}

async function addDealReply(s: Record<string, string>): Promise<Reply> {
  if (!s.title) return { text: "What's the deal called? Try `add deal Website redesign for Acme worth 50k`." };
  const patch: any = { title: s.title, stage: "prospecting" };
  if (s.value) patch.value = Number(s.value);
  if (s.close) patch.expected_close = s.close;
  if (s.company) {
    const ms = await crm.resolveCompany(s.company);
    if (ms.length) patch.company_id = ms[0].item.id;
  }
  const d = await crm.createDeal(patch);
  const note = s.company && !patch.company_id ? ` (I couldn't find a company matching "${s.company}" — deal created without one.)` : "";
  return { text: `Created deal "${d.title}"${d.value ? ` worth ${fmtMoney(d.value)}` : ""}${d.expected_close ? `, closing ${d.expected_close}` : ""}.${note}`, cards: [dealCard(d)], chips: ["Show pipeline", `Move ${d.title} to qualification`] };
}

async function addContactReply(s: Record<string, string>): Promise<Reply> {
  if (!s.name) return { text: "Who should I add? Try `add contact Jane Doe at Acme`." };
  const patch: any = { name: s.name };
  if (s.email) patch.email = s.email;
  if (s.phone) patch.phone = s.phone;
  if (s.company) {
    const ms = await crm.resolveCompany(s.company);
    if (ms.length) patch.company_id = ms[0].item.id;
  }
  const c = await crm.createContact(patch);
  return { text: `Added contact "${c.name}"${c.email ? ` (${c.email})` : ""}.`, chips: ["List contacts", "Show pipeline"] };
}

async function addTaskReply(session: Session, s: Record<string, string>): Promise<Reply> {
  if (!s.title) return { text: "What's the task? Try `add task Call Acme tomorrow`." };
  const patch: any = { title: s.title };
  if (s.due) patch.due_date = s.due;
  if (s.deal) {
    const { deal, matches } = await pickDeal(s.deal);
    if (deal) patch.deal_id = deal.id;
    else if (matches.length) {
      // stash and ask
      session.choice = {
        kind: "deal",
        options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.title, sub: stageLabel(m.item.stage) })),
        then: { action: "add_task_deal", payload: { title: s.title, due: s.due } },
      };
      return { text: `Which deal is "${s.title}" for?`, cards: [{ kind: "choices", options: session.choice.options }], chips: session.choice.options.map((o) => String(o.n)) };
    }
  }
  const t = await crm.createTask(patch);
  return { text: `Added task "${t.title}"${t.due_date ? ` (${duePhrase(t.due_date)})` : ""}.`, chips: ["My tasks", "Morning brief"] };
}

async function taskByName(session: Session, query: string, action: string, payload: any): Promise<Reply> {
  if (!query) return { text: "Which task?" };
  const matches = await crm.resolveTask(query);
  const need = await needOne(matches, "task", (t) => t.title, (t) => duePhrase(t.due_date), { action, payload }, "task");
  if (need.item) return taskAction(session, action, need.item as crm.Task, payload);
  session.choice = {
    kind: "task",
    options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.title, sub: duePhrase(m.item.due_date) })),
    then: { action, payload },
  };
  return need.reply!;
}

async function taskAction(session: Session, action: string, task: crm.Task, payload: any): Promise<Reply> {
  if (action === "complete_task") {
    await crm.patchTask(task.id, { done: 1 });
    return { text: `✅ "${task.title}" done.`, chips: ["My tasks", "Morning brief"] };
  }
  if (action === "reopen_task") {
    await crm.patchTask(task.id, { done: 0 });
    return { text: `Reopened "${task.title}".`, chips: ["My tasks"] };
  }
  if (action === "delete_task") {
    session.pending = { type: "delete_task", label: task.title, payload: { id: task.id } };
    return {
      text: `Delete task "${task.title}"?`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, delete" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  return { text: "I lost track of that action — try again." };
}

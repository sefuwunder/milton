// brain.ts — Milton's reasoning layer: intent -> exec-crm actions -> replies.
// Replies are structured (text + cards + chips) so the chat UI can render richly.

import * as crm from "./crm";
import * as mer from "./meridian";
import { parseIntent, helpText, HELP_CHIPS, parseStage, parseMoney, parseDate, parseReminderTime, formatWhen, parseCapture, type Intent } from "./intents";
import { parseIntentFuzzy, type DisambigOption } from "./fuzzy";
import { ocrUpload, type HandMetrics } from "./ocr";
import { parseVcards, preferredPhone, preferredEmail, type ParsedVCard } from "./vcard";
import * as an from "./analyst";
import * as auto from "./automation";
import * as wss from "./workspace";
import * as chats from "./chat_sessions";
import * as reconRuns from "./recon_runs";
import * as dealNotes from "./deal_notes";
import { hookSecret } from "./hookauth";
import { TUTORIAL_STEPS, tutorialControl, tutorialFollowup, type TutorialState, type TutorialAction } from "./tutorial";

export interface Card {
  kind: "deals" | "pipeline" | "kpis" | "tasks" | "contacts" | "companies" | "activities" | "webhooks" | "choices" | "confirm" | "findings" | "transcription" | "handwriting";
  title?: string;
  items?: any[];
  rows?: any[];
  options?: { n: number; label: string; sub?: string }[];
  stats?: { label: string; value: string }[];
  // transcription card
  ocrText?: string;
  confidence?: number;
  script?: string;
  lines?: { text: string; confidence: number }[];
  // handwriting card
  metrics?: HandMetrics;
  notes?: string[];
  // photo cards
  uploadId?: string;
  imageUrl?: string;
}
export interface Reply {
  text: string; cards?: Card[]; chips?: string[]; widget?: crm.Widgetable;
  // named chat sessions: when a command creates/switches/renames the active
  // session, the UI picks this up and points subsequent chats at the new id.
  activeSession?: { id: string; name: string };
  // non-switching changes (delete/rename of another session): UI refetches list
  sessionsChanged?: boolean;
}

export interface PendingAction { type: string; label: string; payload: any }
export interface ChoiceState {
  kind: "deal" | "contact" | "company" | "task" | "workspace" | "session" | "stage" | "recon" | "prep" | "intent";
  options: { id: number | string; n?: number; label: string; sub?: string }[];
  then: { action: string; payload: any };
}
export interface SavedNote { dealId: number; dealTitle: string; text: string; uploadId?: string; at: string }
export interface Session {
  id: string;
  chatName?: string; // user-facing name of this chat session ("General", …)
  pending?: PendingAction;
  choice?: ChoiceState;
  history: { role: "user" | "milton"; text: string }[];
  lastOcr?: { text: string; uploadId: string };
  notes?: SavedNote[];
  // exec-crm workspace this session works inside; null = default (nothing sent)
  workspaceId?: number | null;
  workspaceName?: string;
  // last analysis output shaped as a pinnable widget ("pin this as a widget")
  lastWidgetable?: crm.Widgetable;
  // interactive tutorial mode; persists in SQLite so progress survives reconnects
  tutorial?: TutorialState;
}

// A photo uploaded through /api/upload, resolved session-side.
export interface UploadRef { id: string; mime: string; size: number; path: string }
export interface MessageOpts { attachments?: UploadRef[]; latestUpload?: UploadRef | null; raw?: string }

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
  // Pure calendar-day arithmetic in local time: both sides pinned to local
  // midnight, so the result is always a whole number of days — no half-day
  // rounding flakes at noon/midnight boundaries.
  const m = (dateStr || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
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
// Env is read at call time (not module load) so tests can reconfigure per case.
type LlmResult = { ok: true; text: string } | { ok: false; error: string };

function llmBase(): string {
  // Resolution order lives in analyst.ts: embedded sidecar -> MILTON_LLM_URL.
  // Chat keeps its existing behavior (30s timeout, snapshot prompt); only the
  // endpoint source can change.
  return an.llmEndpointBase();
}

/** Pull the provider's own error text out of a failed chat-completions response.
 *  Ollama: {"error": "..."} — OpenAI: {"error": {"message": "..."}}.
 *  Never includes request headers, so no API key material can leak through here. */
async function llmProviderError(res: Response): Promise<string> {
  try {
    const j: any = await res.json();
    if (typeof j?.error === "string") return j.error;
    if (typeof j?.error?.message === "string") return j.error.message;
  } catch { /* non-JSON error body */ }
  return res.statusText || "";
}

async function llmReply(question: string, history: Session["history"]): Promise<LlmResult> {
  const base = llmBase();
  if (!base) return { ok: false, error: "LLM not configured (set MILTON_LLM_URL)" };
  const endpoint = base + "/chat/completions";
  const key = process.env.MILTON_LLM_KEY || "";
  const model = process.env.MILTON_LLM_MODEL || "local-model";
  try {
    const [deals, tasks, contacts] = await Promise.all([crm.getDeals(), crm.getTasks(), crm.getContacts()]);
    const open = deals.filter((d) => !d.stage.startsWith("closed_"));
    const ctx = [
      `CRM snapshot: ${deals.length} deals (${open.length} open), ${contacts.length} contacts, ${tasks.filter((t) => !t.done).length} open tasks.`,
      "Open deals: " + open.slice(0, 15).map((d) => `${d.title} (${stageLabel(d.stage)}, ${fmtMoney(d.value)})`).join("; "),
      "Stages: prospecting, qualification, proposal, negotiation, closed_won, closed_lost.",
    ].join("\n");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
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
    if (!res.ok) {
      const providerMsg = await llmProviderError(res);
      return { ok: false, error: `${res.status} from ${endpoint}${providerMsg ? `: ${providerMsg}` : ""}` };
    }
    const j: any = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: `empty response from ${endpoint}` };
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `request to ${endpoint} failed: ${msg}` };
  }
}

// ---- main entry ------------------------------------------------------------------
// Every handleMessage call runs inside the session's workspace (exec-crm's
// ?workspace=<id> scoping) so callers never scope CRM calls by hand.
export async function handleMessage(session: Session, raw: string, opts: MessageOpts = {}): Promise<Reply> {
  const atts = opts.attachments || [];

  // captionless upload -> vCard offer, or photo OCR automatically
  if (!raw.trim() && atts.length) {
    const vcf = atts.find((a) => a.mime === "text/vcard");
    if (vcf) {
      session.history.push({ role: "user", text: "[vcard]" });
      const reply = await vcardOfferReply(session, vcf);
      session.history.push({ role: "milton", text: reply.text });
      session.history = session.history.slice(-40);
      return reply;
    }
    session.history.push({ role: "user", text: "[photo]" });
    const reply = await ocrPhotoReply(atts[0], { auto: true });
    session.history.push({ role: "milton", text: reply.text });
    session.history = session.history.slice(-40);
    if (reply.cards?.[0]?.ocrText) session.lastOcr = { text: reply.cards[0].ocrText!, uploadId: atts[0].id };
    return reply;
  }

  return wss.runWithWorkspace(session.workspaceId ?? null, () => handleMessageScoped(session, raw, opts));
}

async function handleMessageScoped(session: Session, raw: string, opts: MessageOpts = {}): Promise<Reply> {
  const intent = parseIntentFuzzy(raw);

  // 1) resolve an outstanding disambiguation choice
  if (session.choice && intent.name === "choose_number") {
    const n = Number(intent.slots.n);
    const opt = session.choice.options[n - 1];
    if (!opt) return { text: `Pick one of ${session.choice.options.map((o) => o.n).join(", ")}.`, chips: session.choice.options.map((o) => String(o.n)) };
    const ch = session.choice; session.choice = undefined;
    return dispatchChoice(session, ch, opt.id);
  }
  // 1b) fuzzy near-tie: the top candidate intents scored within a hair of
  // each other — ask with the existing numbered choice flow.
  if (intent.name === "disambiguate_intent") {
    const options = JSON.parse(intent.slots.options) as DisambigOption[];
    session.choice = {
      kind: "intent",
      options: options.map((o, i) => ({ id: i, n: i + 1, label: o.label, sub: o.command })),
      then: { action: "pick_intent", payload: { commands: options.map((o) => o.command) } },
    };
    return {
      text: `Did you mean:\n${options.map((o, i) => `${i + 1}) ${o.label} — \`${o.command}\``).join("\n")}`,
      cards: [{ kind: "choices", options: session.choice.options }],
      chips: options.map((_, i) => String(i + 1)),
    };
  }
  // 2a) resolve a pending save-note: the reply names the deal
  if (session.pending?.type === "save_note" && intent.name !== "confirm_yes" && intent.name !== "confirm_no") {
    const p = session.pending; session.pending = undefined;
    return dealByName(session, raw, "save_note", { text: p.payload.text, uploadId: p.payload.uploadId });
  }
  // 2c) resolve a pending delete-stage target: the reply names the stage that
  // receives the doomed stage's deals. Anything but cancel is read as a stage name.
  if (session.pending?.type === "delete_stage_target" && intent.name !== "confirm_no") {
    const p = session.pending;
    const names = (await crm.getStages()).map((s) => s.name);
    const target = (await crm.resolveStage(raw))[0]?.item;
    if (!target) {
      return { text: `I don't know a stage called "${raw}". Pick one of: ${names.join(", ")}.`, chips: ["Cancel"] };
    }
    if (target.slug === p.payload.slug) {
      return { text: `That's the stage being deleted — pick a different one: ${names.filter((n) => n !== p.label).join(", ")}.`, chips: ["Cancel"] };
    }
    session.pending = {
      type: "delete_stage", label: p.label,
      payload: { slug: p.payload.slug, deals: p.payload.deals, moveTo: target.slug, moveToName: target.name },
    };
    return {
      text: `Move ${p.payload.deals} deal(s) from "${p.label}" to "${target.name}" and delete "${p.label}"? This can't be undone.`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, move & delete" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  // 2d) resolve a pending conversational capture: anything that isn't yes/no is
  // treated as corrected details — reparse and show the card again.
  if (session.pending?.type === "capture" && intent.name !== "confirm_yes" && intent.name !== "confirm_no") {
    return captureCorrectReply(session, raw);
  }
  // 2e) resolve a pending campaign company: the reply names the company the
  // new campaign belongs to (exec-crm requires one).
  if (session.pending?.type === "add_campaign_company" && intent.name !== "confirm_no") {
    const p = session.pending; session.pending = undefined;
    const ms = await crm.resolveCompany(raw);
    if (!ms.length) {
      return {
        text: `No company matching "${raw}" — add it first with \`add company ${raw}\`, then say \`new campaign ${p.payload.name}\` again.`,
        chips: ["Help"],
      };
    }
    return createCampaignReply(p.payload.name, ms[0].item.id, ms[0].item.name);
  }
  if (session.pending) {
    if (intent.name === "confirm_yes") {
      const p = session.pending; session.pending = undefined;
      return runPending(session, p);
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
    reply = await dispatch(session, intent, { ...opts, raw });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(msg)) {
      reply = { text: `I can't reach exec-crm at ${crm.crmBase()}. Is it running? Start it with \`bun src/server.ts\` in the exec-crm folder, or point me elsewhere with EXEC_CRM_URL.` };
    } else {
      reply = { text: `Something went wrong: ${msg}` };
    }
  }
  session.history.push({ role: "milton", text: reply.text });
  session.history = session.history.slice(-40);
  if (reply.cards?.[0]?.kind === "transcription" && reply.cards[0].ocrText) {
    session.lastOcr = { text: reply.cards[0].ocrText, uploadId: reply.cards[0].uploadId || "" };
  }
  return reply;
}

async function dispatchChoice(session: Session, ch: ChoiceState, id: number | string): Promise<Reply> {
  const { action, payload } = ch.then;
  if (ch.kind === "deal") {
    const deals = await crm.getDeals();
    const deal = deals.find((d) => d.id === id);
    if (!deal) return { text: "That deal seems to be gone — try again." };
    return dealAction(session, action, deal, payload);
  }
  if (ch.kind === "contact") {
    const contacts = await crm.getContacts();
    const c = contacts.find((x) => x.id === id);
    if (!c) return { text: "That contact seems to be gone — try again." };
    return contactDetailCard(session, c);
  }
  if (ch.kind === "task") {
    const tasks = await crm.getTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) return { text: "That task seems to be gone — try again." };
    return taskAction(session, action, task, payload);
  }
  if (ch.kind === "workspace") {
    const w = (await wss.listWorkspaces())?.find((x) => x.id === id);
    if (!w) return { text: "That workspace seems to be gone — say `workspaces` to see the current list." };
    return applyWorkspace(session, w);
  }
  if (ch.kind === "session") {
    const info = chats.getChatSession(String(id));
    if (!info) return { text: "That session seems to be gone — say `sessions` to see the current list." };
    if (ch.then.action === "delete_chat_session") return requestDeleteChatSession(session, info);
    return applyChatSessionSwitch(info);
  }
  if (ch.kind === "stage") {
    const slug = ch.then.payload?.slugs?.[id];
    const st = (await crm.getStages()).find((x) => x.slug === slug);
    if (!st) return { text: "That stage seems to be gone — say `stages` to see the current list." };
    return stageAction(session, action, st, payload);
  }
    if (ch.kind === "recon") {
    const r = await mer.getRecon(String(id));
    if (!r) return { text: "That recon seems to be gone — say `meridian recons` to see the current list." };
    if (action === "meridian_entities") return entitiesReplyFor(r, payload.etype);
    return dossierReplyFor(r);
  }
  if (ch.kind === "prep") {
    const p = ch.then.payload?.sel?.[id];
    if (!p || (p.type !== "contact" && p.type !== "company")) {
      return { text: "I lost track of that choice — try the command again." };
    }
    return prepBriefReply(session, p.type, p.id);
  }
  if (ch.kind === "intent") {
    // fuzzy near-tie resolution: re-run the chosen canonical command.
    const cmd = ch.then.payload?.commands?.[id];
    if (typeof cmd !== "string") return { text: "I lost track of that choice — try the command again." };
    const intent2 = parseIntent(cmd);
    if (intent2.name === "unknown" || intent2.name === "disambiguate_intent") {
      return { text: "I lost track of that choice — try the command again." };
    }
    return dispatch(session, intent2, { raw: cmd });
  }
  return { text: "I lost track of that choice — try the command again." };
}

async function runPending(session: Session, p: PendingAction): Promise<Reply> {
  if (p.type === "delete_deal") {
    await crm.deleteDeal(p.payload.id);
    return { text: `Deleted deal "${p.label}".`, chips: ["Show pipeline", "List deals"] };
  }
  if (p.type === "close_lost") {
    const deal = await crm.patchDeal(p.payload.id, { stage: "closed_lost" });
    return { text: `Marked "${deal.title}" as lost.`, cards: [dealCard(deal)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (p.type === "close_won") {
    const deal = await crm.patchDeal(p.payload.id, { stage: "closed_won", probability: 100 });
    return { text: `🎉 "${deal.title}" is **won** — ${fmtMoney(deal.value)} in the books.`, cards: [dealCard(deal)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (p.type === "delete_task") {
    await crm.deleteTask(p.payload.id);
    return { text: `Deleted task "${p.label}".`, chips: ["My tasks"] };
  }
  if (p.type === "delete_stage") {
    await crm.deleteStage(p.payload.slug, p.payload.moveTo);
    const moved = p.payload.moveTo ? ` ${p.payload.deals} deal(s) moved to "${p.payload.moveToName}".` : "";
    return { text: `Deleted stage "${p.label}".${moved}`, chips: ["Stages", "Show pipeline"] };
  }
  if (p.type === "capture") return captureSave(session, p.payload as CapturePayload);
  if (p.type === "plan_tasks") return planTasksSave(session, p.payload as { goal: string; steps: string[] });
  if (p.type === "vcard_import") {
    return vcardImportRun(p.payload.cards as ParsedVCard[]);
  }
  if (p.type === "delete_chat_session") {
    const { name, remaining } = chats.deleteChatSession(p.payload.id);
    const wasCurrent = p.payload.id === session.id;
    const next = wasCurrent ? remaining[0] : undefined;
    return {
      text: `Deleted chat session **${name}**.${wasCurrent && next ? ` You're now in **${next.name}**.` : ""}`,
      chips: ["Sessions"],
      ...(wasCurrent && next
        ? { activeSession: { id: next.id, name: next.name } }
        : { sessionsChanged: true }),
    };
  }
  if (p.type === "reminder_add") {
    const r = auto.createReminder(session.id, String(p.payload.text), Number(p.payload.fireAt));
    return { text: `⏰ I'll remind you to **${r.text}** ${formatWhen(r.fire_at)}.`, chips: ["Reminders"] };
  }
  if (p.type === "routine_run") {
    const out = await runRoutineSteps(session, p.payload.steps, { unattended: false, confirmed: true });
    const okCount = out.results.filter((r) => r.ok).length;
    return {
      text: `▶️ **${p.label}** — ${okCount}/${p.payload.steps.length} steps ok\n\n${out.text}`,
      cards: out.cards, chips: ["List routines", "Morning brief"],
    };
  }
  return { text: "Nothing to do." };
}

// ---- automations: routines, schedules, triggers ------------------------------------
// Intents that currently ask for confirmation before acting. Routine steps resolving
// to these never auto-confirm: interactive runs ask once up front, unattended runs skip.
const DESTRUCTIVE_PENDING = new Set(["delete_deal", "delete_task", "close_lost", "close_won", "delete_stage", "delete_chat_session"]);

function isDestructiveIntent(intent: Intent): boolean {
  if (intent.name === "delete_deal" || intent.name === "delete_task" || intent.name === "delete_stage") return true;
  if (intent.name === "close_deal") return true; // won and lost both move money / pipeline state
  if (intent.name === "chat_session" && intent.slots.action === "delete") return true; // never auto-run in routines
  return false;
}

interface StepResult { step: string; ok: boolean; text: string }

async function runRoutineSteps(
  session: Session, steps: string[],
  opts: { unattended: boolean; confirmed?: boolean; visited?: Set<string> }
): Promise<{ text: string; cards?: Card[]; results: StepResult[] }> {
  const visited = opts.visited || new Set<string>();
  const results: StepResult[] = [];
  const cards: Card[] = [];
  for (const step of steps) {
    const intent = parseIntent(step);
    // nested routine: inline with a recursion guard
    if (intent.name === "run_routine") {
      const key = intent.slots.name.toLowerCase();
      const sub = auto.getRoutine(intent.slots.name);
      if (!sub) { results.push({ step, ok: false, text: `routine "${intent.slots.name}" not found — skipped` }); continue; }
      if (visited.has(key)) { results.push({ step, ok: false, text: `recursive routine "${sub.name}" — skipped` }); continue; }
      const subRes = await runRoutineSteps(session, sub.steps, { ...opts, visited: new Set([...visited, key]) });
      const ok = subRes.results.every((r) => r.ok);
      results.push({ step: `${step} (→ ${sub.name})`, ok, text: subRes.text });
      if (subRes.cards) cards.push(...subRes.cards);
      continue;
    }
    if (isDestructiveIntent(intent) && (opts.unattended || !opts.confirmed)) {
      results.push({ step, ok: false, text: "skipped: needs confirmation" });
      continue;
    }
    let reply: Reply;
    try {
      reply = await handleMessage(session, step);
    } catch (e: any) {
      results.push({ step, ok: false, text: `failed: ${String(e?.message || e)}` });
      continue;
    }
    if (session.choice) {
      // a step needing disambiguation can't be answered mid-routine
      session.choice = undefined;
      results.push({ step, ok: false, text: "skipped: needs you to pick from matches — run it on its own" });
      continue;
    }
    if (session.pending && DESTRUCTIVE_PENDING.has(session.pending.type) && opts.confirmed && !opts.unattended) {
      // confirmed destructive step: resolve the confirmation it just raised
      const p = session.pending; session.pending = undefined;
      try { reply = await runPending(session, p); }
      catch (e: any) { results.push({ step, ok: false, text: `failed: ${String(e?.message || e)}` }); continue; }
    } else if (session.pending) {
      session.pending = undefined;
      results.push({ step, ok: false, text: "skipped: needs follow-up input — run it on its own" });
      continue;
    }
    if (/^(something went wrong|i can't reach exec-crm)/i.test(reply.text.trim())) {
      // handleMessage catches errors internally — surface them as failed steps
      results.push({ step, ok: false, text: `failed: ${reply.text}` });
      continue;
    }
    results.push({ step, ok: true, text: reply.text });
    if (reply.cards) cards.push(...reply.cards);
  }
  const text = results.map((r, i) => `**${i + 1}. ${r.step}**\n${r.ok ? r.text : `⚠️ ${r.text}`}`).join("\n\n");
  return { text, cards: cards.length ? cards : undefined, results };
}

/** Run a routine with no user present: destructive steps are skipped, never confirmed.
 *  Runs inside the pinned workspace (null = exec-crm's default). */
export async function runRoutineUnattended(name: string, kind: "schedule" | "trigger" | "manual", ref: string, workspaceId: number | null = null): Promise<auto.AutomationRun> {
  const r = auto.getRoutine(name);
  if (!r) {
    return auto.recordRun({ kind, ref, routine_name: name, status: "failed", summary: `routine "${name}" not found (renamed or deleted?)`, detail: {} });
  }
  // workspace rides on the session; handleMessage scopes every step to it (null = exec-crm's default).
  const sess: Session = { id: `auto:${kind}:${ref}:${Date.now()}`, history: [], notes: [], workspaceId: workspaceId ?? undefined, workspaceName: "" };
  const out = await runRoutineSteps(sess, r.steps, { unattended: true });
  const okCount = out.results.filter((x) => x.ok).length;
  const status = okCount === r.steps.length ? "ok" : okCount === 0 ? "failed" : "partial";
  const problems = out.results.filter((x) => !x.ok).map((x) => x.text).slice(0, 3).join("; ");
  const summary = `${okCount}/${r.steps.length} steps ok` + (problems ? ` — ${problems}` : "");
  return auto.recordRun({
    kind, ref, routine_name: r.name, status, summary,
    detail: { steps: out.results.map((x) => ({ step: x.step, ok: x.ok, text: x.text.slice(0, 500) })) },
  });
}

/** Scheduler tick: run due schedules (each in its pinned workspace), then advance their next_run past now. */
export async function tickAutomation(nowMs: number): Promise<void> {
  for (const s of auto.dueSchedules(nowMs)) {
    try {
      await runRoutineUnattended(s.routine_name, "schedule", `schedule:${s.id}`, s.workspace_id);
    } catch (e: any) {
      auto.recordRun({ kind: "schedule", ref: `schedule:${s.id}`, routine_name: s.routine_name, status: "failed", summary: `scheduler error: ${String(e?.message || e)}` });
    }
    // advance from now so downtime doesn't pile up missed fires
    auto.advanceSchedule(s.id, nowMs);
  }
  // one-shot reminders: claim (pending -> fired, atomically) then announce once
  for (const r of auto.claimDueReminders(nowMs)) {
    auto.recordRun({ kind: "reminder", ref: `reminder:${r.id}`, routine_name: "Reminder", status: "ok", summary: r.text });
  }
}

/** Incoming exec-crm webhook: match triggers, run their routines unattended in their pinned workspaces. */
export async function handleWebhookEvent(event: string, data: Record<string, any>): Promise<{ matched: number; runs: auto.AutomationRun[] }> {
  const matched = auto.matchTriggers(event, data || {});
  const runs: auto.AutomationRun[] = [];
  for (const t of matched) {
    runs.push(await runRoutineUnattended(t.routine_name, "trigger", `trigger:${t.id}:${event}`, t.workspace_id));
  }
  return { matched: matched.length, runs };
}

// ---- automation chat replies ---------------------------------------------------------
// Parses the RAW message so routine names and steps keep their original casing.
function saveRoutineReply(raw: string): Reply {
  const m = raw.trim().match(/^save routine ([a-z0-9][\w\- ]{0,40}?):(.+)$/i);
  if (!m) return { text: "Give it a name and at least one step, like `save routine EOD: my tasks; kpis`.", chips: ["List routines"] };
  const steps = m[2].split(";").map((x) => x.trim()).filter(Boolean);
  try {
    const r = auto.saveRoutine(m[1].trim(), steps);
    const list = r.steps.map((st, i) => `${i + 1}. \`${st}\``).join("\n");
    return {
      text: `Saved routine **${r.name}** (${r.steps.length} step${r.steps.length === 1 ? "" : "s"}):\n${list}\n\nSay \`run ${r.name}\` to run it, or \`schedule ${r.name} daily at 8am\`.`,
      chips: [`Run ${r.name}`, "List routines", "Morning brief"],
    };
  } catch (e: any) {
    return { text: String(e?.message || e), chips: ["List routines", "Help"] };
  }
}

async function runRoutineReply(session: Session, name: string): Promise<Reply> {
  const r = auto.getRoutine(name);
  if (!r) {
    return {
      text: `No routine named "${name}". Save one first: \`save routine ${name}: my tasks; pipeline hygiene\``,
      chips: ["List routines", "Help"],
    };
  }
  const destructive = r.steps.filter((st) => isDestructiveIntent(parseIntent(st)));
  if (destructive.length) {
    session.pending = { type: "routine_run", label: r.name, payload: { steps: r.steps } };
    return {
      text: `Routine **${r.name}** has ${r.steps.length} steps, ${destructive.length} of them destructive:\n${destructive.map((d) => `• \`${d}\``).join("\n")}\n\nRun the whole routine?`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, run it" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  const out = await runRoutineSteps(session, r.steps, { unattended: false });
  const okCount = out.results.filter((x) => x.ok).length;
  return {
    text: `▶️ **${r.name}** — ${okCount}/${r.steps.length} steps ok\n\n${out.text}`,
    cards: out.cards, chips: ["List routines", "Morning brief"],
  };
}

function listRoutinesReply(): Reply {
  const rs = auto.listRoutines();
  if (!rs.length) {
    return {
      text: "No routines yet. Save one like this:\n`save routine EOD: my tasks; pipeline hygiene`\nThen `run EOD` any time.",
      chips: ["Morning brief", "Help"],
    };
  }
  const list = rs.map((r) => `• **${r.name}** — ${r.steps.length} step${r.steps.length === 1 ? "" : "s"}: ${r.steps.join("; ")}`).join("\n");
  return { text: `**${rs.length} routine${rs.length === 1 ? "" : "s"}:**\n${list}`, chips: ["Morning brief", "Help"] };
}

function showRoutineReply(name: string): Reply {
  const r = auto.getRoutine(name);
  if (!r) return { text: `No routine named "${name}".`, chips: ["List routines"] };
  const list = r.steps.map((st, i) => `${i + 1}. \`${st}\``).join("\n");
  return { text: `**${r.name}** (${r.steps.length} steps):\n${list}`, chips: [`Run ${r.name}`, "List routines"] };
}

function deleteRoutineReply(name: string): Reply {
  const r = auto.getRoutine(name);
  if (!r) return { text: `No routine named "${name}".`, chips: ["List routines"] };
  const d = auto.deleteRoutine(r.name);
  const extra = (d.schedules || d.triggers)
    ? ` (also removed ${d.schedules} schedule${d.schedules === 1 ? "" : "s"} and ${d.triggers} trigger${d.triggers === 1 ? "" : "s"} using it)`
    : "";
  return { text: `Deleted routine **${r.name}**${extra}.`, chips: ["List routines", "Morning brief"] };
}

async function scheduleAddReply(session: Session, slots: Record<string, string>): Promise<Reply> {
  const r = auto.getRoutine(slots.routine);
  if (!r) {
    return {
      text: `No routine named "${slots.routine}" — save it first with \`save routine ${slots.routine}: …\``,
      chips: ["List routines"],
    };
  }
  const spec = auto.parseScheduleSpec(slots.when);
  if (!spec) {
    return {
      text: `I couldn't parse "${slots.when}". Try \`daily at 6pm\`, \`every weekday at 8am\`, \`every monday at 9am\`, or \`every 2 hours\`.`,
      chips: ["List schedules"],
    };
  }
  const wsId = session.workspaceId ?? null;
  const sch = auto.createSchedule(r.name, spec, Date.now(), wsId);
  const where = wsId == null ? "" : ` in workspace **${session.workspaceName || `#${wsId}`}**`;
  return {
    text: `⏰ Scheduled **${r.name}**${where} ${sch.spec_text} — next run ${new Date(sch.next_run).toLocaleString()}.`,
    chips: ["List schedules", "List routines"],
  };
}

function fmtNext(ms: number): string {
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : d.toLocaleDateString();
  return `${when} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function listSchedulesReply(): Promise<Reply> {
  const ss = auto.listSchedules();
  if (!ss.length) {
    return {
      text: "No schedules yet. Try `schedule EOD daily at 6pm` or `schedule morning brief every weekday at 8am`.",
      chips: ["List routines", "Help"],
    };
  }
  const list = await Promise.all(ss.map(async (x) => {
    const where = x.workspace_id == null ? "" : ` in **${await wss.workspaceLabel(x.workspace_id)}**`;
    return `• #${x.id} **${x.routine_name}** — ${x.spec_text}${where}, next ${fmtNext(x.next_run)}${x.active ? "" : " (paused)"}`;
  }));
  return { text: `**${ss.length} schedule${ss.length === 1 ? "" : "s"}:**\n${list.join("\n")}`, chips: ["List routines"] };
}

function findSchedule(ref: string): auto.Schedule | null {
  const id = Number(ref);
  if (Number.isInteger(id) && id > 0) return auto.getSchedule(id);
  return auto.listSchedules().find((x) => x.routine_name.toLowerCase() === ref.toLowerCase()) || null;
}

function unscheduleReply(ref: string): Reply {
  const n = auto.deleteScheduleByRef(ref);
  if (!n) return { text: `No schedule matching "${ref}".`, chips: ["List schedules"] };
  return { text: `Removed ${n} schedule${n === 1 ? "" : "s"}.`, chips: ["List schedules"] };
}

function pauseScheduleReply(ref: string, active: boolean): Reply {
  const s = findSchedule(ref);
  if (!s) return { text: `No schedule matching "${ref}".`, chips: ["List schedules"] };
  auto.setScheduleActive(s.id, active);
  return { text: `${active ? "▶️ Resumed" : "⏸️ Paused"} schedule #${s.id} (**${s.routine_name}**).`, chips: ["List schedules"] };
}

async function triggerAddReply(session: Session, slots: Record<string, string>): Promise<Reply> {
  const r = auto.getRoutine(slots.routine);
  if (!r) {
    return {
      text: `No routine named "${slots.routine}" — save it first with \`save routine ${slots.routine}: …\``,
      chips: ["List routines"],
    };
  }
  const resolved = auto.resolveTriggerEvent(slots.event);
  if (!resolved) {
    return { text: `I don't know the event "${slots.event}". Say \`trigger help\` for the full list.`, chips: ["Trigger help"] };
  }
  const wsId = session.workspaceId ?? null;
  const t = auto.createTrigger(resolved.event, resolved.filter, r.name, wsId);
  const f = Object.entries(resolved.filter).map(([k, v]) => `${k}=${v}`).join(", ");
  const where = wsId == null ? "" : ` in workspace **${session.workspaceName || `#${wsId}`}**`;
  return {
    text: `⚡ Trigger #${t.id}: when **${t.event}**${f ? ` (${f})` : ""}, run **${r.name}**${where}.\n\nTo fire it, add an outgoing webhook in exec-crm → Automations pointed at \`POST /api/hooks/exec-crm\` on this server, with the secret from MILTON_HOOK_SECRET.`,
    chips: ["List triggers", "Trigger help"],
  };
}

async function listTriggersReply(): Promise<Reply> {
  const ts = auto.listTriggers();
  if (!ts.length) {
    return {
      text: "No triggers yet. Try `when deal won run celebrate` — say `trigger help` for the event list.",
      chips: ["Trigger help", "List routines"],
    };
  }
  const list = await Promise.all(ts.map(async (t) => {
    const f = Object.entries(t.filter).map(([k, v]) => `${k}=${v}`).join(", ");
    const where = t.workspace_id == null ? "" : ` in **${await wss.workspaceLabel(t.workspace_id)}**`;
    return `• #${t.id} **${t.event}**${f ? ` (${f})` : ""} → **${t.routine_name}**${where}${t.active ? "" : " (paused)"}`;
  }));
  return { text: `**${ts.length} trigger${ts.length === 1 ? "" : "s"}:**\n${list.join("\n")}`, chips: ["Trigger help"] };
}

function deleteTriggerReply(id: string): Reply {
  if (auto.deleteTrigger(Number(id))) return { text: `Deleted trigger #${id}.`, chips: ["List triggers"] };
  return { text: `No trigger #${id}.`, chips: ["List triggers"] };
}

function triggerHelpText(): string {
  return [
    "**exec-crm events you can trigger on:**",
    ...auto.CRM_EVENTS.map((e) => `• \`${e}\``),
    "",
    "Examples:",
    "• `when deal won run celebrate` — fires when a deal hits closed_won",
    "• `when deal.stage_changed where stage=negotiation run prep` — with a filter",
    "• `when task completed run tidy`",
    "",
    "Wire exec-crm → Milton: in exec-crm's Automations view add an outgoing webhook to `POST http://<milton-host>:3009/api/hooks/exec-crm` with header `X-Milton-Secret` set to your MILTON_HOOK_SECRET.",
  ].join("\n");
}

function listRunsReply(): Reply {
  const runs = auto.listRuns(10);
  if (!runs.length) return { text: "No automation runs yet — scheduled routines and triggers will show up here.", chips: ["List schedules", "List triggers"] };
  const icon = (st: string) => st === "ok" ? "✅" : st === "partial" ? "⚠️" : st === "skipped" ? "⏭️" : "❌";
  const list = runs.map((r) =>
    `${icon(r.status)} #${r.id} [${r.kind}] **${r.routine_name}** — ${r.summary} (${new Date(r.ran_at + "Z").toLocaleString()})`
  ).join("\n");
  return { text: `**Recent automation runs:**\n${list}`, chips: ["List schedules", "List triggers"] };
}

// ---- workspaces ------------------------------------------------------------------------
// Parse from the RAW message so names keep their original casing.
function applyWorkspace(session: Session, w: { id: number; name: string }): Reply {
  wss.setSessionWorkspace(session.id, w.id, w.name);
  session.workspaceId = w.id;
  session.workspaceName = w.name;
  return {
    text: `Switched to workspace **${w.name}**. Everything I do now — deals, tasks, routines — happens in there.`,
    chips: ["Show pipeline", "Current workspace", "Morning brief"],
  };
}

async function listWorkspacesReply(): Promise<Reply> {
  const list = await wss.listWorkspaces();
  if (!list) {
    return {
      text: `I can't reach exec-crm at ${crm.crmBase()} right now, so I can't list workspaces.`,
      chips: ["Show pipeline", "Help"],
    };
  }
  if (!list.length) return { text: "exec-crm has no workspaces yet.", chips: ["Help"] };
  return {
    text: `**${list.length} workspace${list.length === 1 ? "" : "s"}:**\n` +
      list.map((w) => `• **${w.name}** (id ${w.id})`).join("\n") +
      `\n\nSay \`switch to <name>\` to work inside one.`,
    chips: ["Current workspace", "Show pipeline"],
  };
}

function currentWorkspaceReply(session: Session): Reply {
  const id = session.workspaceId ?? null;
  if (id == null) {
    return {
      text: "You're in exec-crm's **default workspace**. Say `workspaces` to see the others, or `switch to <name>`.",
      chips: ["Workspaces", "Show pipeline"],
    };
  }
  const name = session.workspaceName || `#${id}`;
  return {
    text: `Current workspace: **${name}** (id ${id}). Say \`switch to default\` to go back.`,
    chips: ["Workspaces", "Show pipeline", "Morning brief"],
  };
}

async function switchWorkspaceReply(session: Session, raw: string): Promise<Reply> {
  const m = raw.trim().match(/^(?:switch to|use workspace|switch workspace to) (.+)$/i);
  const query = (m?.[1] || "").trim();
  if (!query) return { text: "Switch to which workspace? Say `workspaces` to list them.", chips: ["Workspaces"] };
  if (/^default$/i.test(query)) {
    wss.setSessionWorkspace(session.id, null, "");
    session.workspaceId = null;
    session.workspaceName = "";
    return {
      text: "Back in exec-crm's **default workspace**.",
      chips: ["Show pipeline", "Workspaces", "Morning brief"],
    };
  }
  // Chat sessions take precedence: an exact session name or a session-list
  // number ("switch to 2") wins over a workspace. Force the workspace path
  // with "switch workspace to …"; fuzzy session names use "switch session to …".
  const sessHit = resolveChatSessionExact(query);
  if (sessHit) return applyChatSessionSwitch(sessHit);
  const matches = await wss.findWorkspace(query);
  if (matches === null) {
    return {
      text: `I can't reach exec-crm at ${crm.crmBase()} right now — staying where you are.`,
      chips: ["Current workspace", "Show pipeline"],
    };
  }
  if (!matches.length) {
    return { text: `No workspace matching "${query}". Say \`workspaces\` to see them all.`, chips: ["Workspaces"] };
  }
  const [top, second] = [matches[0], matches[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) {
    return applyWorkspace(session, top.ws);
  }
  // ambiguous: numbered disambiguation, following the existing choice pattern
  const options = matches.slice(0, 5).map((mm, i) => ({ id: mm.ws.id, n: i + 1, label: mm.ws.name, sub: `id ${mm.ws.id}` }));
  session.choice = { kind: "workspace", options, then: { action: "switch_workspace", payload: {} } };
  return {
    text: "A few workspaces match — which one did you mean?",
    cards: [{ kind: "choices", options }],
    chips: options.map((o) => String(o.n)),
  };
}

// ---- chat sessions: named conversations -------------------------------------------
function sessionIdGen(): string {
  return "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function applyChatSessionSwitch(info: chats.ChatSessionInfo): Reply {
  const w = wss.getSessionWorkspace(info.id);
  const wsBit = w.id == null ? "" : ` · workspace **${w.name || "default"}**`;
  const msgs = info.messageCount === 1 ? "1 message" : `${info.messageCount} messages`;
  return {
    text: `Switched to **${info.name}**${wsBit} (${msgs}). History, workspace, and tutorial progress here are separate from your other sessions.`,
    chips: ["Sessions", "Current session", "Morning brief"],
    activeSession: { id: info.id, name: info.name },
  };
}

function requestDeleteChatSession(session: Session, info: chats.ChatSessionInfo): Reply {
  if (chats.listChatSessions().length <= 1) {
    return { text: `Can't delete **${info.name}** — it's your only session.`, chips: ["Sessions"] };
  }
  session.pending = { type: "delete_chat_session", label: info.name, payload: { id: info.id } };
  const msgs = info.messageCount === 1 ? "1 message" : `${info.messageCount} messages`;
  return {
    text: `Delete chat session **${info.name}**? Its ${msgs} will be gone for good.`,
    cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, delete" }, { n: 2, label: "Cancel" }] }],
    chips: ["Yes", "No"],
  };
}

/** "switch to X": exact session name or session-list number wins over workspaces. */
function resolveChatSessionExact(query: string): chats.ChatSessionInfo | null {
  const list = chats.listChatSessions();
  if (/^\d+$/.test(query)) {
    const idx = Number(query) - 1;
    return idx >= 0 && idx < list.length ? list[idx] : null;
  }
  return list.find((s) => s.name.toLowerCase() === query.toLowerCase()) || null;
}

async function chatSessionReply(session: Session, intent: Intent): Promise<Reply> {
  const action = intent.slots.action || "list";
  if (action === "new") {
    // Preserve the user's casing: re-extract the name from the raw text.
    const rawName = (/^(?:new|create|start|open) session(?: (.+))?$/i.exec(intent.raw)?.[1] || "").trim();
    const name = rawName || (intent.slots.name || "").trim();
    try {
      const info = chats.createChatSession(sessionIdGen(), name);
      session.chatName = info.name;
      return {
        text: `Started **${info.name}** — a fresh conversation.`,
        chips: ["Sessions", "Morning brief", "Help"],
        activeSession: { id: info.id, name: info.name },
      };
    } catch (e: any) {
      return { text: String(e?.message || e), chips: ["Sessions"] };
    }
  }
  if (action === "list") {
    const list = chats.listChatSessions();
    const now = Date.now();
    const lines = list.map((s, i) => {
      const mark = s.id === session.id ? " ← current" : "";
      const msgs = s.messageCount === 1 ? "1 message" : `${s.messageCount} messages`;
      return `${i + 1}. **${s.name}** — ${msgs}, active ${chats.relTime(s.last_active_at, now)}${mark}`;
    });
    return {
      text: `**${list.length} chat session${list.length === 1 ? "" : "s"}:**\n${lines.join("\n")}\n\n\`switch to <name or number>\` to jump between them · \`new session <name>\` to start fresh.`,
      chips: ["New session", "Current session"],
    };
  }
  if (action === "current") {
    const info = chats.getChatSession(session.id);
    const tut = session.tutorial;
    const tutText = !tut || tut.step <= 0 ? "not started"
      : tut.done || tut.step >= TUTORIAL_STEPS.length ? "finished 🎓"
      : `step ${tut.step + 1} of ${TUTORIAL_STEPS.length} (${TUTORIAL_STEPS[tut.step]?.title || ""})`;
    return {
      text: `You're in **${info?.name || session.chatName || "General"}**\n• Workspace: **${session.workspaceName || "default"}**\n• Messages here: **${info?.messageCount ?? session.history.length}**\n• Tutorial: ${tutText}`,
      chips: ["Sessions", "New session"],
    };
  }
  if (action === "switch") {
    const target = (intent.slots.target || "").trim();
    if (!target) return { text: "Switch to which session? Say `sessions` to see them.", chips: ["Sessions"] };
    const matches = chats.findChatSession(target);
    if (!matches.length) return { text: `No chat session matching "${target}". Say \`sessions\` to see them all.`, chips: ["Sessions"] };
    const [top, second] = [matches[0], matches[1]];
    if (top.score >= 70 && (!second || top.score - second.score >= 20)) return applyChatSessionSwitch(top.info);
    const options = matches.slice(0, 5).map((mm, i) => ({ id: mm.info.id, n: i + 1, label: mm.info.name, sub: `${mm.info.messageCount} messages` }));
    session.choice = { kind: "session", options, then: { action: "switch_chat_session", payload: {} } };
    return {
      text: "A few sessions match — which one did you mean?",
      cards: [{ kind: "choices", options }],
      chips: options.map((o) => String(o.n)),
    };
  }
  if (action === "rename") {
    // Work from the raw text to preserve the new name's casing; fuzzy
    // paraphrases ("rename the session to X") fall back to the slots.
    let target = (intent.slots.target || "").trim();
    const rm = /^rename session\s+(.+)$/i.exec(intent.raw);
    if (rm) target = rm[1].trim();
    if (!target) return { text: "Rename to what? Say `rename session to <new name>`.", chips: ["Sessions"] };
    // "rename session to X" renames the current session; otherwise the
    // "old to new" form renames a named session.
    const rest = target.replace(/^to\s+/i, "");
    let id = session.id, newName = rest;
    const m = rest.match(/^(.+?)\s+to\s+(.+)$/i);
    if (m) {
      const found = chats.findChatSession(m[1].trim());
      if (found.length && found[0].score >= 40) { id = found[0].info.id; newName = m[2].trim(); }
      else return { text: `No chat session matching "${m[1].trim()}". Say \`sessions\` to see them all.`, chips: ["Sessions"] };
    }
    try {
      const info = chats.renameChatSession(id, newName);
      if (id === session.id) session.chatName = info.name;
      return {
        text: `Renamed to **${info.name}**.`,
        chips: ["Sessions", "Current session"],
        activeSession: { id: info.id, name: info.name },
      };
    } catch (e: any) {
      return { text: String(e?.message || e), chips: ["Sessions"] };
    }
  }
  if (action === "delete") {
    const target = (intent.slots.target || "").trim();
    let info: chats.ChatSessionInfo | null = null;
    if (target) {
      const matches = chats.findChatSession(target);
      if (!matches.length) return { text: `No chat session matching "${target}".`, chips: ["Sessions"] };
      const [top, second] = [matches[0], matches[1]];
      if (top.score >= 70 && (!second || top.score - second.score >= 20)) {
        info = top.info;
      } else {
        const options = matches.slice(0, 5).map((mm, i) => ({ id: mm.info.id, n: i + 1, label: mm.info.name, sub: `${mm.info.messageCount} messages` }));
        session.choice = { kind: "session", options, then: { action: "delete_chat_session", payload: {} } };
        return {
          text: "A few sessions match — which one should I delete?",
          cards: [{ kind: "choices", options }],
          chips: options.map((o) => String(o.n)),
        };
      }
    } else {
      info = chats.getChatSession(session.id);
    }
    if (!info) return { text: "That session seems to be gone already.", chips: ["Sessions"] };
    return requestDeleteChatSession(session, info);
  }
  return { text: "Say `sessions` to see your conversations." };
}

// ---- meridian (read-only recon access) ------------------------------------------------
// Meridian is a separate app; every call below is GET. Never launches recons,
// never mutates anything.
function meridianDown(): Reply {
  return {
    text: `I can't reach Meridian at ${mer.meridianBase()} right now — is it running? Start it with \`bun src/server.ts\` in the meridian folder, or point me elsewhere with MERIDIAN_URL.`,
    chips: ["Help"],
  };
}

async function listReconsReply(): Promise<Reply> {
  const list = await mer.listRecons();
  if (!list) return meridianDown();
  if (!list.length) return { text: "Meridian has no recon sprints yet.", chips: ["Help"] };
  const fmt = (r: mer.ReconSummary) =>
    `• **${r.city}**${r.country ? `, ${r.country}` : ""} — ${r.status}, ${r.nodes} nodes · ${r.edges} edges (id \`${r.id}\`)`;
  return {
    text: `**${list.length} recon sprint${list.length === 1 ? "" : "s"}** (newest first):\n` +
      list.slice(0, 10).map(fmt).join("\n") +
      `\n\nSay \`meridian dossier <city>\` for the analyst summary, or \`meridian entities <city>\` for its companies and orgs.`,
    chips: ["Meridian recons", "Help"],
  };
}

// Shared fuzzy resolution for dossier/entities. Returns a Reply when the query
// doesn't resolve cleanly (unreachable / no match / ambiguous), else the recon.
async function resolveRecon(
  session: Session, query: string,
  action: "meridian_dossier" | "meridian_entities", payload: any,
): Promise<mer.ReconDetail | Reply> {
  const matches = await mer.findRecon(query);
  if (matches === null) return meridianDown();
  if (!matches.length) {
    return { text: `No recon matching "${query}". Say \`meridian recons\` to see them all.`, chips: ["Meridian recons"] };
  }
  const [top, second] = [matches[0], matches[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) {
    const r = await mer.getRecon(top.recon.id);
    return r || { text: "That recon seems to be gone — say `meridian recons` to see the current list." };
  }
  // ambiguous: numbered disambiguation, following the existing choice pattern
  const options = matches.slice(0, 5).map((m, i) => ({
    id: m.recon.id, n: i + 1,
    label: `${m.recon.city}${m.recon.country ? ", " + m.recon.country : ""}`,
    sub: `${m.recon.status} · ${m.recon.nodes} nodes`,
  }));
  session.choice = { kind: "recon", options, then: { action, payload } };
  return {
    text: "A few recons match — which one did you mean?",
    cards: [{ kind: "choices", options }],
    chips: options.map((o) => String(o.n)),
  };
}

function fmtReconDate(iso: string): string {
  if (!iso) return "";
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(iso) ? iso + "Z" : iso;
  const d = new Date(/^\d+$/.test(s) ? Number(s) : s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

function dossierReplyFor(r: mer.ReconDetail): Reply {
  const byType = new Map<string, number>();
  for (const n of r.nodes) byType.set(n.type, (byType.get(n.type) || 0) + 1);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([t, c]) => `${t} ${c}`).join(", ") || "—";
  const factEntries = Object.entries(r.facts).slice(0, 8).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `• **${k}**: ${(s || "").slice(0, 140)}`;
  });
  const notable = r.nodes.filter((n) => mer.ENTITY_TYPES.includes(n.type)).slice(0, 5)
    .map((n) => `• **${n.label}** (${n.type}${n.subtype ? "/" + n.subtype : ""}, via ${n.source})`);
  const when = fmtReconDate(r.updated_at);
  const lines = [
    `**Recon: ${r.city}${r.country ? ", " + r.country : ""}** — ${r.status}, ${r.nodes.length} nodes · ${r.edges.length} edges${when ? `, updated ${when}` : ""}.`,
    `**By type:** ${types}.`,
  ];
  if (factEntries.length) lines.push(`**Key facts:**\n${factEntries.join("\n")}`);
  if (notable.length) lines.push(`**Notable entities:**\n${notable.join("\n")}\n\nSay \`meridian entities ${r.city}\` for the full list.`);
  return { text: lines.join("\n\n"), chips: [`Meridian entities ${r.city}`, "Meridian recons"] };
}

function entitiesReplyFor(r: mer.ReconDetail, etype?: string): Reply {
  const types = etype ? [etype] : mer.ENTITY_TYPES;
  const list = r.nodes.filter((n) => types.includes(n.type));
  if (!list.length) {
    return {
      text: `**${r.city}** has no ${etype ? `**${etype}** ` : ""}nodes on record. Try \`meridian dossier ${r.city}\` for what's there.`,
      chips: ["Meridian recons"],
    };
  }
  const items = list.slice(0, 20).map((n) => {
    const head = `• **${n.label}** — ${n.type}${n.subtype ? "/" + n.subtype : ""} · via ${n.source}`;
    const bits = [n.detail ? n.detail.slice(0, 200) : "", n.url || ""].filter(Boolean);
    return bits.length ? `${head}\n  ${bits.join(" ")}` : head;
  });
  const more = list.length > 20 ? `\n\n…and ${list.length - 20} more.` : "";
  return {
    text: `**${etype ? etype[0].toUpperCase() + etype.slice(1) : "Business entities"} in ${r.city}** (${list.length}):\n${items.join("\n")}${more}`,
    chips: [`Meridian dossier ${r.city}`, "Meridian recons"],
  };
}

async function meridianDossierReply(session: Session, raw: string): Promise<Reply> {
  const m = raw.trim().match(/^meridian dossier (.+)$/i);
  const query = (m?.[1] || "").trim();
  if (!query) return { text: "Dossier for which recon? Say `meridian recons` to see them.", chips: ["Meridian recons"] };
  const res = await resolveRecon(session, query, "meridian_dossier", {});
  return "text" in res ? res : dossierReplyFor(res);
}

async function meridianEntitiesReply(session: Session, slots: Record<string, string>, raw: string): Promise<Reply> {
  let query = (slots.query || "").trim();
  let etype = slots.etype || undefined;
  if (!query) {
    const m = raw.trim().match(/^meridian entities (.+)$/i);
    query = (m?.[1] || "").trim();
  }
  if (!query) return { text: "Entities from which recon? Say `meridian recons` to see them.", chips: ["Meridian recons"] };
  // Strip a trailing type filter the same way the parser does.
  if (!etype) {
    const parts = query.split(/\s+/);
    const maybe = parts[parts.length - 1].toLowerCase();
    if (parts.length > 1 && mer.NODE_TYPES.includes(maybe)) { etype = maybe; query = parts.slice(0, -1).join(" "); }
  }
  const res = await resolveRecon(session, query, "meridian_entities", { etype });
  return "text" in res ? res : entitiesReplyFor(res, etype);
}

// ---- meridian run requests -----------------------------------------------------------
// "meridian recon Austin" asks Meridian's run-request router for a NEW sprint.
// This is the one write Milton makes toward Meridian; the read intents above
// stay read-only. The run is persisted (pinned to this session's workspace)
// until Meridian's completion callback arrives at POST /api/hooks/meridian.

async function meridianRequestReply(session: Session, city: string): Promise<Reply> {
  city = city.trim();
  if (!city) {
    return { text: "Which city should I recon? Try `meridian recon Austin`.", chips: ["Meridian recons"] };
  }
  // Completion callbacks only work when Meridian can authenticate back to us.
  const secret = hookSecret();
  const res = await mer.requestReconRun(city, {
    callbackUrl: secret ? `${mer.miltonBase()}/api/hooks/meridian` : undefined,
    callbackHeaders: secret ? { "X-Milton-Secret": secret } : undefined,
  });
  if (!res.ok) {
    if (res.unreachable) return meridianDown();
    return { text: `Meridian wouldn't take the run: ${res.error}`, chips: ["Meridian recons"] };
  }
  reconRuns.saveRunRequest({
    runId: res.run_id,
    workspaceId: session.workspaceId ?? null,
    city,
    status: res.status,
  });
  const short = res.run_id.length > 8 ? res.run_id.slice(0, 8) : res.run_id;
  const cbNote = secret
    ? "I'll report back here when it finishes."
    : "⚠️ Completion callbacks aren't configured (set MILTON_HOOK_SECRET) — check back with `meridian recons` once it should be done.";
  return {
    text: `Run requested: recon of **${city}** is now \`${res.status}\` (run \`${short}\`). ${cbNote}`,
    chips: ["Meridian recons", "Morning brief"],
  };
}

// ---- incoming Meridian completion callback -----------------------------------------
// POST /api/hooks/meridian receives Meridian's run-completion POST
// { run_id, city, label, status, nodes, edges, result_url, export_url }.
// Recorded in automation_runs so it surfaces in the Runs tab, the 🔔 badge, and
// the SSE stream — the same path schedule/trigger runs take. A callback for an
// unknown run_id is still recorded (marked unknown) so nothing is silently dropped.

export interface MeridianHookResult { known: boolean; run: auto.AutomationRun }

export function handleMeridianCallback(p: any): MeridianHookResult {
  const runId = String(p?.run_id || "");
  const city = String(p?.city || "");
  const label = String(p?.label || "");
  const status = String(p?.status || "");
  const nodes = Number(p?.nodes || 0);
  const edges = Number(p?.edges || 0);
  const resultUrl = String(p?.result_url || "");
  const exportUrl = String(p?.export_url || "");
  const pending = runId ? reconRuns.getRunRequest(runId) : null;
  if (pending) {
    reconRuns.completeRunRequest(runId, { status, nodes, edges, resultUrl, exportUrl });
  }
  const autoStatus = status === "ready" ? "ok" : status === "partial" ? "partial" : "failed";
  const name = label || city || (pending ? pending.city : "") || runId || "unknown";
  const run = auto.recordRun({
    kind: "meridian",
    ref: runId,
    routine_name: `Recon: ${name}`,
    status: autoStatus,
    summary: pending
      ? `${status} — ${nodes} nodes · ${edges} edges`
      : `${status || "finished"} — ${nodes} nodes · ${edges} edges (run ${runId || "?"}, not requested from here)`,
    detail: {
      run_id: runId, city: city || (pending ? pending.city : ""), label,
      status, nodes, edges, result_url: resultUrl, export_url: exportUrl,
      known: Boolean(pending), workspace_id: pending ? pending.workspace_id : null,
    },
  });
  return { known: Boolean(pending), run };
}

async function dispatchMeridian(session: Session, slots: Record<string, string>, name: string, raw: string): Promise<Reply> {
  switch (name) {
    case "list_recons": return listReconsReply();
    case "meridian_dossier": return meridianDossierReply(session, raw);
    case "meridian_entities": return meridianEntitiesReply(session, slots, raw);
    case "meridian_request": return meridianRequestReply(session, slots.city || "");
  }
  return { text: "Nothing to do." };
}

async function dispatchAutomation(session: Session, slots: Record<string, string>, name: string, raw: string): Promise<Reply> {
  switch (name) {
    case "save_routine": return saveRoutineReply(raw);
    case "run_routine": return runRoutineReply(session, slots.name);
    case "list_routines": return listRoutinesReply();
    case "delete_routine": return deleteRoutineReply(slots.name);
    case "show_routine": return showRoutineReply(slots.name);
    case "schedule_add": return scheduleAddReply(session, slots);
    case "list_schedules": return listSchedulesReply();
    case "unschedule": return unscheduleReply(slots.ref);
    case "pause_schedule": return pauseScheduleReply(slots.ref, false);
    case "resume_schedule": return pauseScheduleReply(slots.ref, true);
    case "trigger_add": return triggerAddReply(session, slots);
    case "list_triggers": return listTriggersReply();
    case "delete_trigger": return deleteTriggerReply(slots.id);
    case "trigger_help": return { text: triggerHelpText(), chips: ["List triggers", "List routines"] };
    case "list_runs": return listRunsReply();
    case "list_workspaces": return listWorkspacesReply();
    case "current_workspace": return currentWorkspaceReply(session);
    case "switch_workspace": return switchWorkspaceReply(session, raw);
  }
  return { text: "Nothing to do." };
}

// ---- dispatch ----------------------------------------------------------------------
// Tutorial control commands are intercepted here so they never reach the
// normal intent switch; everything else runs normally and gets a follow-up.
async function dispatch(session: Session, intent: Intent, opts: MessageOpts): Promise<Reply> {
  if (intent.name === "tutorial") {
    if (!session.tutorial) session.tutorial = { active: false, step: 0 };
    const r = tutorialControl(session.tutorial, (intent.slots.action || "start") as TutorialAction);
    return { text: r.text, chips: r.chips };
  }
  const reply = await dispatchInner(session, intent, opts);
  if (session.tutorial?.active) {
    const f = tutorialFollowup(session.tutorial, intent.name, reply.text, reply.chips);
    return { ...reply, text: f.text, chips: f.chips ?? reply.chips };
  }
  return reply;
}

async function dispatchInner(session: Session, intent: Intent, opts: MessageOpts): Promise<Reply> {
  const s = intent.slots;
  const photo = (opts.attachments && opts.attachments[0]) || opts.latestUpload || null;
  switch (intent.name) {
    case "help": return { text: helpText(), chips: HELP_CHIPS };
    case "pipeline": return pipelineReply();
    case "deals": return dealsReply(s.stage, s.search, s.stage_name);
    case "deal_detail": return dealDetailReply(session, s.query);
    case "kpis": return withWidget(session, kpisReply());
    case "tasks": return tasksReply(s.filter, s.search);
    case "contacts": return contactsReply(s.search);
    case "companies": return companiesReply(s.search);
    case "brief": return briefReply();
    case "hygiene": return withWidget(session, hygieneReply());
    case "prep_brief": return prepBriefForName(session, s.name);
    case "analyze_pipeline": return analyzePipelineReply();
    case "forecast": return forecastReply();
    case "plan_day": return planDayReply();
    case "plan_week": return planWeekReply();
    case "plan_breakdown": return planBreakdownReply(session, s.goal || "");
    case "sales_cycle": return withWidget(session, salesCycleReply());
    case "top_deals": return withWidget(session, topDealsReply());
    case "campaign_stats": return withWidget(session, campaignStatsReply());
    case "closing_soon": return withWidget(session, closingSoonReply());
    case "pin_widget": return pinWidgetReply(session);
    case "contact_detail": return contactDetailReply(session, s.query || "");
    case "search": return searchReply(s.query || "");
    case "activities": return activitiesReply();
    case "webhooks": return webhooksReply();
    case "hooks": return hooksReply();
    case "deliveries": return deliveriesReply();
    case "notes": return notesReply(session);

    case "save_routine":
    case "run_routine":
    case "list_routines":
    case "delete_routine":
    case "show_routine":
    case "schedule_add":
    case "list_schedules":
    case "unschedule":
    case "pause_schedule":
    case "resume_schedule":
    case "trigger_add":
    case "list_triggers":
    case "delete_trigger":
    case "trigger_help":
    case "list_runs":
    case "list_workspaces":
    case "current_workspace":
    case "switch_workspace":
      try {
        return await dispatchAutomation(session, s, intent.name, opts.raw || "");
      } catch (e: any) {
        return { text: `Automations aren't available right now: ${String(e?.message || e)}`, chips: HELP_CHIPS.slice(0, 3) };
      }

    case "chat_session": return chatSessionReply(session, intent);

    case "list_recons":
    case "meridian_dossier":
    case "meridian_entities":
    case "meridian_request":
      try {
        return await dispatchMeridian(session, s, intent.name, opts.raw || "");
      } catch (e: any) {
        return { text: `Meridian isn't available right now: ${String(e?.message || e)}`, chips: HELP_CHIPS.slice(0, 3) };
      }

    case "ocr_read":
      if (!photo) return { text: "I don't see a photo yet — tap the camera button to take or upload one, then ask me to read it.", chips: ["Morning brief", "Show pipeline"] };
      return ocrPhotoReply(photo, { auto: false });
    case "handwriting":
      if (!photo) return { text: "I don't see a photo yet — tap the camera button to take or upload one, then ask me to analyze the handwriting.", chips: ["Morning brief", "Show pipeline"] };
      return handwritingReply(photo);
    case "save_note": return saveNoteReply(session);

    case "add_deal": return addDealReply(s);
    case "move_deal": return dealByName(session, s.query, "move_deal", { stage: s.stage });
    case "close_deal": return dealByName(session, s.query, "close_deal", { result: s.result });
    case "delete_deal": return dealByName(session, s.query, "delete_deal", {});
    case "set_deal_field": return dealByName(session, s.query, "set_deal_field", { field: s.field, value: s.value });
    case "add_note": return addNoteReply(session, s);
    case "add_campaign": return addCampaignReply(session, s);

    case "list_stages": return stagesReply();
    case "add_stage": return addStageReply(session, s);
    case "rename_stage": return stageByName(session, s.query, "rename_stage", { name: s.name });
    case "delete_stage": return stageByName(session, s.query, "delete_stage", {});
    case "move_stage": return stageByName(session, s.query, "move_stage", { pos: s.pos, ref: s.ref });

    case "add_contact": return addContactReply(s);
    case "capture": return captureReply(session, s.rest || "");
    case "import_contacts": return importContactsReply(session, opts);
    case "add_company": {
      if (!s.name) return { text: "What should the company be called?" };
      const c = await crm.createCompany({ name: s.name });
      return { text: `Added company "${c.name}".`, chips: ["List companies", `Add contact … at ${c.name}`] };
    }
    case "add_task": return addTaskReply(session, s);
    case "remind_add": return remindAddReply(session, s.rest || "");
    case "remind_list": return remindListReply(session);
    case "remind_cancel": return remindCancelReply(session, s.id || "");
    case "complete_task": return taskByName(session, s.query, "complete_task", {});
    case "reopen_task": return taskByName(session, s.query, "reopen_task", {});
    case "delete_task": return taskByName(session, s.query, "delete_task", {});

    case "confirm_yes":
    case "confirm_no":
    case "choose_number":
      return { text: "There's nothing pending right now.", chips: HELP_CHIPS.slice(0, 3) };

    case "unknown": {
      const llm = await llmReply(intent.raw, session.history);
      if (llm.ok) return { text: llm.text, chips: ["Show pipeline", "Morning brief", "Help"] };
      if (llmBase()) {
        // LLM is configured but the call failed — say so plainly instead of
        // pretending the question was just unrecognized.
        return {
          text: `I couldn't reach the language model (${llm.error}) — check MILTON_LLM_MODEL against \`ollama list\` if the model name looks wrong.`,
          chips: ["Show pipeline", "Morning brief", "Help"],
        };
      }
      return {
        text: `I'm not sure what you mean by "${intent.raw}". I work best with direct commands — try one of these, or type "help" for the full list.`,
        chips: ["Show pipeline", "Morning brief", "My tasks", "Help"],
      };
    }
  }
}

// ---- photo OCR + handwriting executors ---------------------------------------------
async function ocrPhotoReply(up: UploadRef, opts: { auto: boolean }): Promise<Reply> {
  let result = await ocrUpload(up.path, up.mime);
  if (result.error === "webp") {
    return {
      text: "I can keep WebP photos, but my little OCR engine can't read them yet — a PNG or JPEG works best.",
      chips: ["Morning brief", "Show pipeline"],
    };
  }
  // optional vision fallback: low-confidence handwriting -> OpenAI-compatible vision
  if (!result.error && result.confidence < 0.5 && result.script !== "print") {
    const v = await tryVisionOcr(up.path, up.mime);
    if (v) {
      result = {
        ...result,
        text: v,
        lines: v.split("\n").map((t) => ({ text: t.trim(), confidence: 0.5 })).filter((l) => l.text),
        confidence: 0.5,
      };
    }
  }
  if (result.error === "decode" || !result.text.trim()) {
    return {
      text: "I couldn't pull any text out of that photo. A straight-on, well-lit shot of printed text works best.",
      chips: ["Morning brief", "Show pipeline"],
    };
  }
  const pct = Math.round(result.confidence * 100);
  const hwNote = result.script !== "print" ? " Looks like handwriting, so take it with a grain of salt." : "";
  return {
    text: `${opts.auto ? "Photo received — " : ""}here's what I read (${pct}% confidence).${hwNote}`,
    cards: [{
      kind: "transcription", title: "Photo transcription",
      ocrText: result.text, confidence: result.confidence, script: result.script,
      lines: result.lines, uploadId: up.id, imageUrl: `/api/file/${up.id}`,
    }],
    chips: ["Analyze handwriting", "Save note to a deal", "Morning brief"],
  };
}

function handwritingReply(up: UploadRef): Promise<Reply> {
  return ocrUpload(up.path, up.mime).then((result) => {
    if (result.error === "webp") {
      return { text: "I can keep WebP photos, but my little analysis engine can't read them yet — a PNG or JPEG works best.", chips: ["Morning brief"] } as Reply;
    }
    if (result.error === "decode" || result.metrics.chars < 3) {
      return { text: "I couldn't find enough writing in that photo to analyze. A clear, straight-on shot of a few handwritten lines works best.", chips: ["Morning brief"] } as Reply;
    }
    const m = result.metrics;
    const notes: string[] = [];
    const deg = (n: number) => `${Math.abs(n).toFixed(1)}°`;
    notes.push(m.slantDeg > 5 ? `Slant: leans right by ${deg(m.slantDeg)}.` : m.slantDeg < -5 ? `Slant: leans left by ${deg(m.slantDeg)}.` : "Slant: upright (within 5° of vertical).");
    const pressure = m.strokeMedian > 0 ? m.strokeStd / m.strokeMedian : 0;
    notes.push(`Stroke width: median ${m.strokeMedian.toFixed(1)}px${pressure > 0.6 ? ", varying a lot across strokes (pressure proxy: uneven)" : " (pressure proxy: fairly even)"}.`);
    notes.push(`Letter height: average ${m.heightMean.toFixed(1)}px${m.heightMean > 0 && m.heightStd / m.heightMean > 0.25 ? ", varying noticeably line to line" : ", fairly consistent"}.`);
    notes.push(m.spacingRatio >= 2.5 ? `Word spacing is generous (words ~${m.spacingRatio.toFixed(1)}× the letter gaps).` : m.spacingRatio > 0 && m.spacingRatio < 1.5 ? `Word spacing is tight (words ~${m.spacingRatio.toFixed(1)}× the letter gaps).` : `Word spacing is moderate (words ~${m.spacingRatio.toFixed(1)}× the letter gaps).`);
    notes.push(Math.abs(m.baselineDrift) > 1 ? `Baselines drift ${m.baselineDrift > 0 ? "downward" : "upward"} by about ${deg(m.baselineDrift)} across lines.` : "Baselines sit roughly level across lines.");
    notes.push(`Ink density: ${(m.inkDensity * 100).toFixed(1)}% of the text area is ink.`);
    notes.push(`Measured over ${m.chars} characters in ${m.words} words across ${m.lines} line${m.lines === 1 ? "" : "s"}.`);
    notes.push("This is geometric stroke analysis, not personality science — it measures shapes on the page, nothing about the writer.");
    return {
      text: "Here's what the strokes themselves look like, measured — no mind-reading attached:",
      cards: [{ kind: "handwriting", title: "Handwriting analysis", metrics: m, notes, uploadId: up.id, imageUrl: `/api/file/${up.id}` }],
      chips: ["Read text", "Save note to a deal", "Morning brief"],
    } as Reply;
  });
}

function saveNoteReply(session: Session): Reply {
  const ocr = session.lastOcr;
  if (!ocr?.text) {
    return { text: "There's no transcription to save yet — send me a photo of the text first.", chips: ["Morning brief", "Show pipeline"] };
  }
  session.pending = { type: "save_note", label: "note", payload: { text: ocr.text, uploadId: ocr.uploadId } };
  return { text: "Which deal should I file this note under?", chips: ["Morning brief"] };
}

function notesReply(session: Session): Reply {
  const notes = session.notes || [];
  if (!notes.length) return { text: "No saved notes yet — transcribe a photo, then tap “Save note to a deal”.", chips: ["Morning brief"] };
  return {
    text: `**${notes.length} saved note${notes.length === 1 ? "" : "s"}:**`,
    cards: [{
      kind: "findings", title: "Saved notes",
      items: notes.slice().reverse().map((n) => ({
        icon: "📝",
        text: `${n.dealTitle} — ${n.text.length > 120 ? n.text.slice(0, 120) + "…" : n.text} (${new Date(n.at).toLocaleString()})`,
      })),
    }],
    chips: ["Morning brief", "Show pipeline"],
  };
}

/** Optional vision fallback via any OpenAI-compatible chat-completions endpoint.
 *  Set MILTON_LLM_URL (e.g. http://localhost:8080/v1); fails softly to null. */
async function tryVisionOcr(path: string, mime: string): Promise<string | null> {
  const base = process.env.MILTON_LLM_URL;
  if (!base) return null;
  try {
    const bytes = await Bun.file(path).arrayBuffer();
    const b64 = Buffer.from(bytes).toString("base64");
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.MILTON_LLM_MODEL || "llama3.2-vision",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Transcribe all text visible in this image. Return only the transcription, no commentary." },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }],
        max_tokens: 1000,
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
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

async function dealsReply(stage?: string, search?: string, stageName?: string): Promise<Reply> {
  let deals = await crm.getDeals();
  let label = "All deals";
  if (stage) {
    deals = deals.filter((d) => d.stage === stage);
    label = `Deals in ${stageLabel(stage)}`;
  } else if (stageName) {
    // Editable/custom stages: match against the workspace's real pipeline,
    // normalizing punctuation so "pre negotiation" finds "Pre-Negotiation".
    // Unambiguous normalized match wins; anything ambiguous stays honest.
    const stages = await crm.getStages();
    const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const qn = norm(stageName);
    let st = stages.find((x) => norm(x.slug) === qn || norm(x.name) === qn);
    if (!st) {
      const toks = stageName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const cands = stages.filter((x) =>
        toks.length > 0 && toks.every((t) => norm(x.name).includes(t) || norm(x.slug).includes(t)));
      if (cands.length === 1) st = cands[0];
    }
    if (!st) {
      const names = stages.map((s) => s.name).join(", ");
      return { text: `I couldn't find a stage called "${stageName}". Current stages: ${names || "none yet"}.`, chips: ["Stages", "Show pipeline"] };
    }
    deals = deals.filter((d) => d.stage === st.slug);
    label = `Deals in ${st.name}`;
  }
  if (search) {
    const q = search.toLowerCase();
    deals = deals.filter((d) => d.title.toLowerCase().includes(q) || (d.company_name || "").toLowerCase().includes(q));
    label = `Deals matching "${search}"`;
  }
  deals.sort((a, b) => (b.value || 0) - (a.value || 0));
  if (!deals.length) return { text: "No deals match.", chips: ["Show pipeline"] };
  return {
    text: `${label} — ${deals.length} deal${deals.length === 1 ? "" : "s"}, ${fmtMoney(deals.reduce((a, d) => a + (d.value || 0), 0))} total.`,
    cards: [{ kind: "deals", title: label, items: deals.slice(0, 20) }],
    chips: ["Show pipeline", "Morning brief"],
  };
}

async function dealDetailReply(session: Session, query: string): Promise<Reply> {
  if (!query) return { text: "Which deal? Try `show deal Acme`." };
  const { deal, matches } = await pickDeal(query);
  if (deal) {
    const lines = [`"${deal.title}" at a glance:`, ...dealNotesLines(deal, session)];
    return { text: lines.join("\n"), cards: [dealCard(deal)], chips: [`Move ${deal.title} to negotiation`, `Set ${deal.title} value to …`, "Show pipeline"] };
  }
  const need = await needOne(matches, "deal", (d) => d.title, (d) => `${stageLabel(d.stage)} · ${fmtMoney(d.value)}`, { action: "deal_detail", payload: {} }, "deal");
  if (need.item) return dealAction(session, "deal_detail", need.item as crm.Deal, {});
  session.choice = {
    kind: "deal",
    options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.title, sub: `${stageLabel(m.item.stage)} · ${fmtMoney(m.item.value)}` })),
    then: { action: "deal_detail", payload: {} },
  };
  return need.reply!;
}

// ---- milton widgets -----------------------------------------------------------
// Analysis replies that yield structured data attach a widget payload; the
// dispatcher stashes it on the session so "pin this as a widget" can POST it
// to exec-crm's /api/milton/widgets (rendered on exec-crm's Milton tab).
async function withWidget(session: Session, replyP: Promise<Reply>): Promise<Reply> {
  const reply = await replyP;
  if (reply.widget) session.lastWidgetable = reply.widget;
  return reply;
}
async function pinWidgetReply(session: Session): Promise<Reply> {
  const w = session.lastWidgetable;
  if (!w) {
    return {
      text: "Nothing to pin yet — ask me for something structured first, like “top deals”, “kpis”, “campaign stats”, “closing soon”, or “pipeline hygiene”, then say “pin this as a widget”.",
      chips: ["Top deals", "KPIs", "Closing soon"],
    };
  }
  try {
    const created = await crm.pinWidget(w);
    return {
      text: `Pinned “${created?.title || w.title}” to your Milton tab 📌`,
      chips: ["Top deals", "KPIs", "Closing soon"],
    };
  } catch (e: any) {
    return {
      text: `Couldn't reach exec-crm to pin the widget: ${String(e?.message || e).slice(0, 180)}`,
      chips: ["Top deals"],
    };
  }
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
  const winRateStat = stats.find((s) => /win rate/i.test(s.label));
  const widget: crm.Widgetable | undefined = stats.length ? {
    kind: "stat", title: "KPIs", source: "milton:kpis",
    payload: {
      value: stats[0].value, label: stats[0].label,
      ...(winRateStat && winRateStat !== stats[0] ? { delta: `Win rate ${winRateStat.value}` } : {}),
    },
  } : undefined;
  return {
    text: stats.length ? "Here's how the business looks right now:" : "KPIs (raw):",
    cards: [{ kind: "kpis", title: "KPIs", stats: stats.length ? stats : [{ label: "raw", value: JSON.stringify(k).slice(0, 200) }] }],
    chips: ["Show pipeline", "Morning brief"],
    widget,
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
  const noValue = open.filter((d) => !d.value);
  if (noValue.length) findings.push({ icon: "💰", text: `${noValue.length} deal${noValue.length === 1 ? "" : "s"} with no value set: ${noValue.slice(0, 4).map((d) => d.title).join(", ")}${noValue.length > 4 ? "…" : ""}`, fix: `Set ${noValue[0].title} value to …` });
  const stale = open
    .filter((d) => { const n = daysUntil(d.updated_at.slice(0, 10)); return n !== null && n < -30; })
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at)); // oldest first
  if (stale.length) findings.push({ icon: "🕸️", text: `${stale.length} stale deal${stale.length === 1 ? "" : "s"} untouched for 30+ days (oldest first): ${stale.slice(0, 4).map((d) => d.title).join(", ")}${stale.length > 4 ? "…" : ""}` });
  const noContact = open.filter((d) => !d.contact_id);
  if (noContact.length) findings.push({ icon: "👤", text: `${noContact.length} deal${noContact.length === 1 ? "" : "s"} with no contact attached: ${noContact.slice(0, 4).map((d) => d.title).join(", ")}${noContact.length > 4 ? "…" : ""}` });
  const overdue = tasks.filter((t) => !t.done && t.due_date && t.due_date < today);
  if (overdue.length) findings.push({ icon: "⏰", text: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}` });
  if (!findings.length) {
    return { text: "Pipeline is clean — every open deal has a close date, a contact, and recent activity. Nice.", chips: ["Show pipeline", "Morning brief"] };
  }
  const hygieneWidget: crm.Widgetable = {
    kind: "list", title: "Pipeline hygiene", source: "milton:hygiene",
    payload: {
      items: findings.slice(0, 15).map((f) => ({
        text: `${f.icon} ${f.text}`,
        ...(f.fix ? { sub: f.fix } : {}),
      })),
    },
  };
  return {
    text: `Found ${findings.length} thing${findings.length === 1 ? "" : "s"} worth fixing:`,
    cards: [{ kind: "findings", title: "Pipeline hygiene", items: findings }],
    chips: ["Show pipeline", "My tasks"],
    widget: hygieneWidget,
  };
}

// ---- sales cycle, top deals, campaigns, closing soon -----------------------------------
// Read-only, deterministic, offline. Every figure below is computed from the
// CRM records in this workspace — no model involved.

async function salesCycleReply(): Promise<Reply> {
  const [deals, stages] = await Promise.all([crm.getDeals(), crm.getStages()]);
  const sc = an.computeSalesCycle(deals, stages);
  const lines = [
    `⏱️ **Sales cycle**`,
    "",
    sc.avgDays !== null
      ? `**Average: ${sc.avgDays} days** from creation to won (${sc.closedWonCount} closed-won deal${sc.closedWonCount === 1 ? "" : "s"}) · median ${sc.medianDays}d · range ${sc.minDays}–${sc.maxDays}d`
      : "No closed-won deals with usable dates yet — nothing to average.",
    `_Close dates use each deal's last update; exec-crm doesn't record stage history, so treat cycle times as approximations._`,
    "",
    `**Current-stage dwell** — how long open deals have sat untouched in the stage they're in now (a stall proxy, not true per-stage history):`,
    ...sc.perStage.filter((s) => s.count > 0).map((s) =>
      `• **${s.label}** — ${s.count} deal${s.count === 1 ? "" : "s"} · median ${s.medianDwell}d in stage`),
    sc.stalest
      ? `\n🐌 **Stalest stage: ${sc.stalest.label}** — deals sitting a median ${sc.stalest.medianDwell} days. Worth a push.`
      : "",
  ];
  return {
    text: lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n"),
    chips: ["Analyze my pipeline", "What needs attention", "Show pipeline"],
    widget: sc.avgDays !== null ? {
      kind: "stat", title: "Sales cycle", source: "milton:sales-cycle",
      payload: {
        value: `${sc.avgDays}d`, label: "Avg sales cycle",
        ...(sc.stalest ? { delta: `Stalest: ${sc.stalest.label} (${sc.stalest.medianDwell}d)` } : {}),
      },
    } : undefined,
  };
}

async function topDealsReply(): Promise<Reply> {
  const deals = await crm.getDeals();
  const open = deals.filter((d) => !d.stage.startsWith("closed_")).sort((a, b) => (b.value || 0) - (a.value || 0));
  if (!open.length) return { text: "No open deals.", chips: ["Show pipeline"] };
  const top = open.slice(0, 10);
  const lines = top.map((d, i) => {
    const n = daysSince(d.updated_at);
    return `${i + 1}. **${d.title}** — ${stageLabel(d.stage)} · ${fmtMoney(d.value)}${n !== null ? ` · ${n}d since update` : ""}`;
  });
  return {
    text: `🏆 **Top ${top.length} open deal${top.length === 1 ? "" : "s"}** by value:\n${lines.join("\n")}`,
    cards: [{ kind: "deals", title: "Top deals", items: top }],
    chips: ["Show pipeline", "Closing soon", "Sales cycle"],
    widget: {
      kind: "table", title: "Top deals", source: "milton:top-deals",
      payload: {
        headers: ["Deal", "Stage", "Value", "Updated"],
        rows: top.map((d) => [
          d.title, stageLabel(d.stage), fmtMoney(d.value),
          (d.updated_at || "").slice(0, 10) || "—",
        ]),
      },
    },
  };
}

async function campaignStatsReply(): Promise<Reply> {
  const [deals, campaigns] = await Promise.all([
    crm.getDeals(), crm.getCampaigns().catch(() => [] as crm.Campaign[]),
  ]);
  const stats = an.computeCampaignStats(deals, campaigns);
  if (!stats.length) {
    return { text: "No campaigns with deals on record yet.", chips: ["Analyze my pipeline", "Show pipeline"] };
  }
  const lines = stats.map((c) =>
    `• **${c.name}** — ${c.openCount} open (${fmtMoney(c.openValue)}) · ${c.wonCount} won (${fmtMoney(c.wonValue)}) · ${c.lostCount} lost` +
    (c.winRate !== null ? ` · **win rate ${Math.round(c.winRate * 100)}%**` : ""));
  return {
    text: `📣 **Campaign performance** (ranked by open pipeline):\n${lines.join("\n")}`,
    chips: ["Analyze my pipeline", "Show pipeline"],
    widget: {
      kind: "bars", title: "Campaign performance", source: "milton:campaign-stats",
      payload: {
        items: stats.slice(0, 10).map((c) => ({ label: c.name, value: c.openValue })),
        format: "currency",
      },
    },
  };
}

async function closingSoonReply(): Promise<Reply> {
  const deals = await crm.getDeals();
  const hits = deals
    .filter((d) => !d.stage.startsWith("closed_") && d.expected_close)
    .map((d) => ({ d, n: daysUntil(d.expected_close) }))
    .filter((x): x is { d: crm.Deal; n: number } => x.n !== null && x.n >= 0 && x.n <= 30)
    .sort((a, b) => a.n - b.n);
  if (!hits.length) {
    return { text: "Nothing scheduled to close in the next 30 days.", chips: ["Show pipeline", "Forecast"] };
  }
  const total = hits.reduce((a, x) => a + (x.d.value || 0), 0);
  const wsum = Math.round(hits.reduce((a, x) => a + (x.d.value || 0) * an.dealWeight(x.d), 0));
  const when = (n: number) => n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n}d`;
  const lines = hits.map(({ d, n }) => {
    const w = Math.round((d.value || 0) * an.dealWeight(d));
    return `• **${d.title}** — closes ${d.expected_close} (${when(n)}) · ${fmtMoney(d.value)} → **${fmtMoney(w)}** weighted · ${stageLabel(d.stage)}`;
  });
  return {
    text: `📅 **Closing in the next 30 days** — ${hits.length} deal${hits.length === 1 ? "" : "s"} · ${fmtMoney(total)} pipeline → **${fmtMoney(wsum)}** weighted:\n${lines.join("\n")}\n_Weights: deal probability when set, else stage defaults (prospecting 10%, qualification 25%, proposal 50%, negotiation 75%)._`,
    cards: [{ kind: "deals", title: "Closing soon", items: hits.map((x) => x.d) }],
    chips: ["Forecast", "Show pipeline", "Plan my day"],
    widget: {
      kind: "list", title: "Closing soon", source: "milton:closing-soon",
      payload: {
        items: hits.slice(0, 15).map(({ d, n }) => ({
          text: d.title,
          sub: `closes ${d.expected_close} (${when(n)}) · ${fmtMoney(d.value)} · ${stageLabel(d.stage)}`,
        })),
      },
    },
  };
}

// ---- contact detail + cross-entity search -------------------------------------------------

function dealNotesLines(deal: crm.Deal, session: Session): string[] {
  const notes = dealNotes.getDealNotes(deal.id, session.workspaceId ?? null);
  if (!notes.length) return [];
  return [
    "",
    `**Notes on this deal (${notes.length}):**`,
    ...notes.slice(-5).reverse().map((n) => `• ${n.text} _(${(n.at || "").slice(0, 10)})_`),
  ];
}

async function contactDetailReply(session: Session, query: string): Promise<Reply> {
  if (!query) return { text: "Which contact? Try `who is Jane Doe`.", chips: ["List contacts"] };
  const matches = await crm.resolveContact(query);
  const need = await needOne(matches, "contact",
    (c) => c.name, (c) => c.company_name || c.email || "",
    { action: "contact_detail", payload: {} }, "contact");
  if (need.item) return contactDetailCard(session, need.item as crm.Contact);
  session.choice = {
    kind: "contact",
    options: matches.slice(0, 5).map((m, i) => ({ id: m.item.id, n: i + 1, label: m.item.name, sub: m.item.company_name || m.item.email || "" })),
    then: { action: "contact_detail", payload: {} },
  };
  return need.reply!;
}

async function contactDetailCard(session: Session, c: crm.Contact): Promise<Reply> {
  const [deals, companies, tasks] = await Promise.all([crm.getDeals(), crm.getCompanies(), crm.getTasks()]);
  const company = c.company_id ? companies.find((x) => x.id === c.company_id) : undefined;
  const linked = deals
    .filter((d) => !d.stage.startsWith("closed_") && (d.contact_id === c.id || (company != null && d.company_id === company.id)))
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  const dealIds = new Set(linked.map((d) => d.id));
  const linkedTasks = tasks.filter((t) => !t.done && t.deal_id != null && dealIds.has(t.deal_id));
  const openValue = linked.reduce((a, d) => a + (d.value || 0), 0);
  // exec-crm's activity feed carries no contact linkage, so "last touch" is
  // the most recent update across their linked deals — labeled honestly.
  const lastTouch = linked.map((d) => d.updated_at).filter(Boolean).sort().pop();

  const contactLine = [c.email ? `📧 ${c.email}` : "", c.phone ? `📞 ${c.phone}` : ""].filter(Boolean).join(" · ")
    || "_No email or phone on file._";
  const lines = [
    `👤 **${c.name}**${c.title ? ` — ${c.title}` : ""}`,
    contactLine,
    company ? `🏢 **${company.name}**${company.industry ? ` — ${company.industry}` : ""}` : (c.company_name ? `🏢 ${c.company_name}` : "_No company linked._"),
    c.notes ? `📝 ${c.notes.slice(0, 300)}` : "",
    "",
    linked.length
      ? `**Open deals (${linked.length}, ${fmtMoney(openValue)}):**\n${linked.map((d) => `• **${d.title}** — ${stageLabel(d.stage)} · ${fmtMoney(d.value)}`).join("\n")}`
      : "No open deals linked.",
    linkedTasks.length ? `**Open tasks:** ${linkedTasks.map((t) => t.title).join("; ")}` : "",
    lastTouch ? `**Last touch:** ${lastTouch.slice(0, 10)} (most recent linked-deal update)` : "",
  ];
  return {
    text: lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n"),
    cards: [
      ...(linked.length ? [{ kind: "deals" as const, title: "Open deals", items: linked }] : []),
      ...(linkedTasks.length ? [{ kind: "tasks" as const, title: "Open tasks", items: linkedTasks }] : []),
    ],
    chips: ["Show pipeline", "My tasks", "Morning brief"],
  };
}

async function searchReply(query: string): Promise<Reply> {
  const q = (query || "").trim().toLowerCase();
  if (!q) return { text: "Search for what? Try `search acme`.", chips: ["Help"] };
  const [deals, contacts, companies, tasks] = await Promise.all([
    crm.getDeals(), crm.getContacts(), crm.getCompanies(), crm.getTasks(),
  ]);
  const dHits = deals.filter((d) => d.title.toLowerCase().includes(q) || (d.company_name || "").toLowerCase().includes(q));
  const cHits = contacts.filter((c) =>
    c.name.toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.company_name || "").toLowerCase().includes(q));
  const coHits = companies.filter((c) => c.name.toLowerCase().includes(q));
  const tHits = tasks.filter((t) => t.title.toLowerCase().includes(q));
  const total = dHits.length + cHits.length + coHits.length + tHits.length;
  if (!total) {
    return { text: `Nothing matched "${query}" — no deals, contacts, companies, or tasks.`, chips: ["Show pipeline", "Help"] };
  }
  const grp = (icon: string, label: string, rows: string[]) => rows.length
    ? {
      icon,
      text: `**${label} (${rows.length})**\n${rows.slice(0, 5).map((r) => `• ${r}`).join("\n")}${rows.length > 5 ? `\n• …and ${rows.length - 5} more` : ""}`,
    }
    : null;
  const items = [
    grp("💼", "Deals", dHits.map((d) => `**${d.title}** — ${stageLabel(d.stage)} · ${fmtMoney(d.value)}`)),
    grp("👤", "Contacts", cHits.map((c) => `**${c.name}**${c.company_name ? ` — ${c.company_name}` : ""}${c.email ? ` · ${c.email}` : ""}`)),
    grp("🏢", "Companies", coHits.map((c) => `**${c.name}**${c.industry ? ` — ${c.industry}` : ""}`)),
    grp("✅", "Tasks", tHits.map((t) => `**${t.title}** — ${t.done ? "done" : duePhrase(t.due_date)}`)),
  ].filter((x): x is { icon: string; text: string } => x !== null);
  return {
    text: `🔎 **Search "${query}"** — ${total} hit${total === 1 ? "" : "s"}:`,
    cards: [{ kind: "findings", title: "Search results", items }],
    chips: ["Show pipeline", "My tasks"],
  };
}

// ---- deal notes + campaigns ------------------------------------------------------------------
// exec-crm has no deal-notes endpoint, so notes persist in Milton's own SQLite
// (src/deal_notes.ts), keyed by (deal_id, workspace_id), and surface on deal
// lookups. Campaign creation needs a company (exec-crm 400s without one); the
// company is asked for on the next turn when "for <company>" is missing.

async function addNoteReply(session: Session, s: Record<string, string>): Promise<Reply> {
  if (s.query && s.text) return dealByName(session, s.query, "add_note", { text: s.text });
  const rest = (s.rest || "").trim();
  if (!rest) return { text: "Note on which deal? Try `note on Acme: called today, wants the proposal`.", chips: ["List deals"] };
  // Space form: the longest known deal title that prefixes the message wins;
  // whatever follows it is the note text.
  const deals = await crm.getDeals();
  const low = rest.toLowerCase();
  const hit = deals
    .filter((d) => low.startsWith(d.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0];
  if (!hit) {
    return {
      text: `I couldn't tell which deal you meant by "${rest}". Try \`note on <deal>: <text>\` with a colon between them.`,
      chips: ["List deals"],
    };
  }
  const text = rest.slice(hit.title.length).trim();
  if (!text) return { text: `What should I note on "${hit.title}"? Try \`note on ${hit.title}: <text>\`.` };
  return dealAction(session, "add_note", hit, { text });
}

async function addCampaignReply(session: Session, s: Record<string, string>): Promise<Reply> {
  const name = (s.name || "").trim();
  if (!name) return { text: "What should the campaign be called? Try `new campaign Q4 Push for Acme`." };
  if (s.company) {
    const ms = await crm.resolveCompany(s.company);
    if (!ms.length) {
      return {
        text: `No company matching "${s.company}" — add it first with \`add company ${s.company}\`, then try again.`,
        chips: ["List companies"],
      };
    }
    return createCampaignReply(name, ms[0].item.id, ms[0].item.name);
  }
  session.pending = { type: "add_campaign_company", label: name, payload: { name } };
  return { text: `Which company is **${name}** for?`, chips: ["Cancel"] };
}

async function createCampaignReply(name: string, companyId: number, companyName: string): Promise<Reply> {
  try {
    const c = await crm.createCampaign({ name, company_id: companyId });
    return {
      text: `Created campaign **"${c.name}"** for **${companyName}** — exec-crm also added its standard workflow tasks.`,
      chips: ["Analyze my pipeline", "Campaign stats", "Show pipeline"],
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    const m = msg.match(/-> (\d+) (.*)$/);
    return { text: m ? `Couldn't create the campaign: ${m[2]}` : `Couldn't create the campaign: ${msg.slice(0, 200)}`, chips: ["Help"] };
  }
}

// ---- deterministic goal breakdown ------------------------------------------------------------
// LLM integration is parked, so "break down <goal>" no longer refuses: a
// built-in template derives numbered steps from the goal text (milestones,
// research, execution pieces, review), then the existing confirmation →
// task-creation flow. The analyst model will make breakdowns smarter when it
// returns — planBreakdownReply still prefers it when configured.

function deterministicBreakdown(goal: string): string[] {
  const g = goal.trim().replace(/\s+/g, " ");
  const parts = g.split(/\s+and\s+|,\s*|;\s*/).map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== g.toLowerCase());
  const steps = [
    `Define what "done" looks like for ${g} — the success criteria and a deadline`,
    `List the unknowns in ${g} and research the top three`,
  ];
  const execParts = parts.slice(0, 3);
  if (execParts.length) {
    for (const p of execParts) steps.push(`Execute the "${p}" piece of ${g}`);
  } else {
    steps.push(`Take the first concrete action toward ${g}`);
    steps.push(`Work through ${g} in order of biggest risk first`);
  }
  steps.push(`Review ${g} against the success criteria and close out ${g}`);
  return steps;
}

// ---- meeting prep brief -----------------------------------------------------------------
// Deterministic, read-only, offline-first: assembles a brief from exec-crm
// records. The optional LLM "talking points" section only appears when
// MILTON_LLM_URL is set, is grounded in the brief facts, and can never
// break the deterministic brief.

interface PrepCandidate { type: "contact" | "company"; id: number; label: string; sub?: string; score: number }

async function prepCandidates(query: string): Promise<PrepCandidate[]> {
  const [cm, com] = await Promise.all([crm.resolveContact(query), crm.resolveCompany(query)]);
  const list: PrepCandidate[] = [
    ...cm.map((m) => ({ type: "contact" as const, id: m.item.id, label: m.item.name, sub: m.item.title || m.item.company_name || "", score: m.score })),
    ...com.map((m) => ({ type: "company" as const, id: m.item.id, label: m.item.name, sub: m.item.industry || "", score: m.score })),
  ];
  return list.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

async function prepBriefForName(session: Session, name: string): Promise<Reply> {
  const q = (name || "").trim();
  if (!q) return { text: "Prep for whom? Try `prep me for my call with <name>`.", chips: ["Help"] };
  const cands = await prepCandidates(q);
  if (!cands.length) {
    return {
      text: `I couldn't find any contact or company matching "${q}". Want me to create it?`,
      chips: [`Add contact ${q}`, `Add company ${q}`],
    };
  }
  const [top, second] = [cands[0], cands[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) {
    return prepBriefReply(session, top.type, top.id);
  }
  // ambiguous: numbered disambiguation, following the existing choice pattern
  const options = cands.slice(0, 5).map((c, i) => ({
    id: i, n: i + 1,
    label: c.label,
    sub: `${c.type}${c.sub ? ` · ${c.sub}` : ""}`,
  }));
  session.choice = {
    kind: "prep",
    options,
    then: { action: "prep_brief", payload: { sel: Object.fromEntries(cands.slice(0, 5).map((c, i) => [i, { type: c.type, id: c.id, label: c.label }])) } },
  };
  return {
    text: "A few people and companies match — who are you meeting with?",
    cards: [{ kind: "choices", options }],
    chips: options.map((o) => String(o.n)),
  };
}

/** Days since a YYYY-MM-DD[-ish] date, or null when unparseable. */
function daysSince(isoDate: string): number | null {
  const n = daysUntil((isoDate || "").slice(0, 10));
  return n === null ? null : -n;
}

async function prepBriefReply(session: Session, type: "contact" | "company", id: number): Promise<Reply> {
  const [contacts, companies, deals, tasks] = await Promise.all([
    crm.getContacts(), crm.getCompanies(), crm.getDeals(), crm.getTasks(),
  ]);
  const contact = type === "contact" ? contacts.find((c) => c.id === id) : undefined;
  const company = type === "company"
    ? companies.find((c) => c.id === id)
    : contact?.company_id ? companies.find((c) => c.id === contact.company_id) : undefined;
  if (type === "contact" && !contact) return { text: "That contact seems to be gone — try again." };
  if (type === "company" && !company) return { text: "That company seems to be gone — try again." };

  const whoName = type === "contact" ? contact!.name : company!.name;
  // primary contact for a company brief: most open deals at that company
  let primary: crm.Contact | undefined;
  if (type === "company") {
    const atCo = contacts.filter((c) => c.company_id === company!.id);
    const dealCount = (c: crm.Contact) => deals.filter((d) => d.contact_id === c.id && !d.stage.startsWith("closed_")).length;
    primary = atCo.sort((a, b) => dealCount(b) - dealCount(a) || a.id - b.id)[0];
  }

  const open = deals.filter((d) => !d.stage.startsWith("closed_"));
  const linked = open.filter((d) =>
    (contact && d.contact_id === contact.id) ||
    (company && d.company_id != null && d.company_id === company.id)
  ).sort((a, b) => (b.value || 0) - (a.value || 0));
  const dealIds = new Set(linked.map((d) => d.id));
  const today = todayStr();
  const linkedTasks = tasks
    .filter((t) => !t.done && t.deal_id != null && dealIds.has(t.deal_id))
    .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  const overdue = linkedTasks.filter((t) => t.due_date && t.due_date < today);
  const staleDeals = linked.filter((d) => { const n = daysSince(d.updated_at); return n !== null && n >= 30; });
  const openValue = linked.reduce((a, d) => a + (d.value || 0), 0);

  // Who: contact + their company, or company + primary contact.
  const whoLine = type === "contact"
    ? `**${contact!.name}**${contact!.title ? ` — ${contact!.title}` : ""}\n` +
      [contact!.email ? `📧 ${contact!.email}` : "", contact!.phone ? `📞 ${contact!.phone}` : ""].filter(Boolean).join(" · ") +
      (company ? `\n🏢 **${company.name}**${company.industry ? ` — ${company.industry}` : ""}${company.website ? ` · ${company.website}` : ""}` : "")
    : `🏢 **${company!.name}**${company!.industry ? ` — ${company!.industry}` : ""}${company!.website ? ` · ${company!.website}` : ""}` +
      (primary ? `\n👤 **${primary.name}**${primary.title ? ` — ${primary.title}` : ""}${primary.email ? ` · ${primary.email}` : ""}` : "");

  const dealLines = linked.map((d) => {
    const n = daysSince(d.updated_at);
    const stale = n !== null && n >= 30;
    return `• **${d.title}** — ${stageLabel(d.stage)} · ${fmtMoney(d.value)}${n !== null ? ` · ${n}d since update` : ""}${stale ? " ⚠️" : ""}`;
  });
  const taskLines = linkedTasks.map((t) => {
    const n = t.due_date ? daysUntil(t.due_date) : null;
    return n !== null && n < 0 ? `⏰ **${t.title}** — ${-n}d overdue` : `• **${t.title}** — ${t.due_date ? `due ${t.due_date}` : "no due date"}`;
  });

  // Meridian angle: only when a recon city is genuinely mentioned in the
  // company/contact record. Best-effort; an unreachable Meridian means
  // no section, never an error.
  let meridianLine = "";
  try {
    const hay = [company?.name, company?.notes, company?.website, contact?.notes, contact?.company_name]
      .filter(Boolean).join(" ").toLowerCase();
    const recons = await mer.listRecons();
    const hit = recons?.find((r) => r.city && hay.includes(r.city.toLowerCase()));
    if (hit) meridianLine = `🗺️ Meridian has a recon on **${hit.city}** — say \`meridian dossier ${hit.city}\`.`;
  } catch { /* never break the brief */ }

  const lines = [
    `📋 **Meeting prep: ${whoName}**`,
    "",
    whoLine,
    "",
    linked.length
      ? `**Open deals (${linked.length}, ${fmtMoney(openValue)}):**\n${dealLines.join("\n")}`
      : "No open deals linked.",
    "",
    linkedTasks.length
      ? `**Open tasks (${linkedTasks.length}):**\n${taskLines.join("\n")}`
      : "No open tasks linked.",
    // Recent activity: exec-crm's activities carry no ref linkage
    // (ref_type/ref_id are never populated), so there's nothing honest
    // to attach here — skipped silently.
    meridianLine ? `\n${meridianLine}` : "",
    "",
    `**Bottom line:** ${linked.length} open deal${linked.length === 1 ? "" : "s"} (${fmtMoney(openValue)}), ` +
      `${staleDeals.length} stuck 30+ days, ${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}.`,
  ];

  // Optional LLM talking points: grounded only in the brief facts, clearly
  // labeled, and never allowed to break the deterministic brief above.
  if (process.env.MILTON_LLM_URL) {
    const facts = [
      `Meeting with: ${whoName}${type === "contact" && company ? ` (${contact!.title || "no title"}, ${company.name})` : ""}${type === "company" && primary ? ` (primary contact: ${primary.name})` : ""}`,
      `Open deals: ${linked.length ? linked.map((d) => `"${d.title}" (${stageLabel(d.stage)}, ${fmtMoney(d.value)})`).join("; ") : "none"}`,
      `Stale deals (30+ days since update): ${staleDeals.length ? staleDeals.map((d) => d.title).join(", ") : "none"}`,
      `Tasks: ${linkedTasks.length ? linkedTasks.map((t) => `"${t.title}" (${t.due_date ? (t.due_date < today ? `${-daysUntil(t.due_date)!}d overdue` : `due ${t.due_date}`) : "no due date"})`).join("; ") : "none"}`,
    ].join("\n");
    const llm = await llmReply(
      `Suggest 3-5 short bullet talking points for my upcoming call, based ONLY on these facts (do not invent anything):\n${facts}`,
      []
    );
    if (llm.ok) lines.push("", `**Talking points** _(from your LLM)_:\n${llm.text}`);
    else lines.push("", `_Talking points skipped — the LLM didn't respond (${llm.error.slice(0, 160)})._`);
  }

  return {
    text: lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n"),
    cards: [
      ...(linked.length ? [{ kind: "deals" as const, title: "Open deals", items: linked.map((d) => ({ ...d, sub: `${stageLabel(d.stage)} · ${fmtMoney(d.value)}` })) }] : []),
      ...(linkedTasks.length ? [{ kind: "tasks" as const, title: "Open tasks", items: linkedTasks }] : []),
    ],
    chips: ["Show pipeline", "My tasks", "Morning brief"],
  };
}

// ---- write executors -------------------------------------------------------------------

// ---- analyst & planner ---------------------------------------------------------------
// Deterministic stats always; the small analyst model adds the "so what" when
// configured. All read-only and workspace-scoped (crm.* scopes ?workspace=).

async function analyzePipelineReply(): Promise<Reply> {
  const [deals, stages, campaigns] = await Promise.all([
    crm.getDeals(), crm.getStages(), crm.getCampaigns().catch(() => [] as crm.Campaign[]),
  ]);
  const st = an.computePipelineStats(deals, stages, campaigns);
  const stageLines = st.stages.filter((s) => s.count > 0).map((s) =>
    `• **${s.label}** — ${s.count} deal${s.count === 1 ? "" : "s"} · ${fmtMoney(s.total)}` +
    (s.avgDays !== null ? ` · ${s.avgDays}d avg since update` : "") +
    (s.avgProb !== null ? ` · ${s.avgProb}% avg win prob` : ""));
  const lines = [
    `📊 **Pipeline analysis** — ${st.openCount} open deals · ${fmtMoney(st.openValue)}`,
    "",
    ...stageLines,
    "",
    st.winRate !== null
      ? `**Win rate:** ${Math.round(st.winRate * 100)}% (${st.wonCount} won · ${fmtMoney(st.wonValue)} vs ${st.lostCount} lost · ${fmtMoney(st.lostValue)})`
      : "No closed deals yet — win rate n/a.",
    st.stale.length
      ? `**Stale (30+ days since update):**\n${st.stale.slice(0, 5).map((d) => `• **${d.title}** — ${d.stage} · ${fmtMoney(d.value)} · ${d.days}d`).join("\n")}`
      : "Nothing stale — every open deal was touched in the last 30 days.",
    st.topCampaigns.length
      ? `**Top campaigns by open pipeline:**\n${st.topCampaigns.slice(0, 5).map((c) => `• **${c.name}** — ${c.count} deal${c.count === 1 ? "" : "s"} · ${fmtMoney(c.value)}`).join("\n")}`
      : "",
  ];
  if (an.analystConfigured()) {
    const r = await an.askAnalyst({ system: an.ANALYZE_SYSTEM, facts: st.facts });
    lines.push("", r.ok
      ? `**Analyst read** _(from your analyst model)_:\n${r.text}`
      : `_Analyst insight skipped — ${r.error.slice(0, 200)}._`);
  }
  return {
    text: lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n"),
    chips: ["Forecast", "Plan my day", "Show pipeline"],
  };
}

async function forecastReply(): Promise<Reply> {
  const [deals, stages] = await Promise.all([crm.getDeals(), crm.getStages()]);
  const f = an.computeForecast(deals, stages);
  const lines = [
    `🔮 **Forecast — ${f.quarter}**`,
    "",
    `**Weighted forecast: ${fmtMoney(f.weightedTotal)}** (from ${fmtMoney(f.openValue)} open pipeline, ${f.openCount} deals)`,
    ...f.perStage.map((s) => `• **${s.label}** — ${s.count} deal${s.count === 1 ? "" : "s"} · ${fmtMoney(s.value)} → **${fmtMoney(s.weighted)}** weighted`),
    "",
    `Closed won this quarter: ${f.wonThisQuarterCount} deals · ${fmtMoney(f.wonThisQuarter)}.`,
    f.topDeal
      ? `Largest open deal: **${f.topDeal.title}** · ${fmtMoney(f.topDeal.value)} (${f.topDeal.sharePct}% of open pipeline).`
      : "",
    `_Weights: deal probability when set, else stage defaults (prospecting 10%, qualification 25%, proposal 50%, negotiation 75%)._`,
  ];
  if (an.analystConfigured()) {
    const r = await an.askAnalyst({ system: an.FORECAST_SYSTEM, facts: f.facts });
    lines.push("", r.ok
      ? `**Risk read** _(from your analyst model)_:\n${r.text}`
      : `_Risk read skipped — ${r.error.slice(0, 200)}._`);
  }
  return {
    text: lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n"),
    chips: ["Analyze my pipeline", "Plan my week", "Morning brief"],
  };
}

interface PlanData {
  overdue: crm.Task[]; dueToday: crm.Task[]; dueThisWeek: crm.Task[];
  later: crm.Task[]; closingSoon: crm.Deal[]; staleTop: { title: string; stage: string; value: number; days: number }[];
}

async function gatherPlanData(): Promise<PlanData> {
  const [tasks, deals] = await Promise.all([crm.getTasks(), crm.getDeals()]);
  const today = todayStr();
  const open = tasks.filter((t) => !t.done);
  const byDue = [...open].sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  const overdue = byDue.filter((t) => t.due_date && t.due_date < today);
  const dueToday = byDue.filter((t) => t.due_date === today);
  const dueThisWeek = byDue.filter((t) => {
    if (!t.due_date || t.due_date <= today) return false;
    const n = daysUntil(t.due_date);
    return n !== null && n <= 7;
  });
  const later = byDue.filter((t) => !overdue.includes(t) && !dueToday.includes(t) && !dueThisWeek.includes(t));
  const closingSoon = deals
    .filter((d) => !d.stage.startsWith("closed_") && d.expected_close)
    .map((d) => ({ d, n: daysUntil(d.expected_close) }))
    .filter((x): x is { d: crm.Deal; n: number } => x.n !== null && x.n >= 0 && x.n <= 14)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.d);
  const staleTop = deals
    .filter((d) => !d.stage.startsWith("closed_"))
    .map((d) => ({ d, days: daysSince(d.updated_at) }))
    .filter((x): x is { d: crm.Deal; days: number } => x.days !== null && x.days >= 30)
    .sort((a, b) => (b.d.value || 0) - (a.d.value || 0))
    .slice(0, 3)
    .map((x) => ({ title: x.d.title, stage: stageLabel(x.d.stage), value: x.d.value || 0, days: x.days }));
  return { overdue, dueToday, dueThisWeek, later, closingSoon, staleTop };
}

const taskLine = (t: crm.Task) => `• **${t.title}** — ${duePhrase(t.due_date)}`;

async function planDayReply(): Promise<Reply> {
  const p = await gatherPlanData();
  const sections: [string, string[]][] = [
    ["**Do first — overdue:**", p.overdue.map(taskLine)],
    ["**Due today:**", p.dueToday.map(taskLine)],
    ["**Due this week:**", p.dueThisWeek.map(taskLine)],
    ["**Deals closing soon:**", p.closingSoon.map((d) => `• **${d.title}** — ${stageLabel(d.stage)} · ${fmtMoney(d.value)} · closes ${d.expected_close}`)],
    ["**Needs attention (stale deals):**", p.staleTop.map((d) => `• **${d.title}** — ${d.stage} · ${fmtMoney(d.value)} · ${d.days}d`)],
  ];
  const body = sections.filter(([, ls]) => ls.length).map(([h, ls]) => `${h}\n${ls.join("\n")}`).join("\n\n")
    || "Nothing open — no tasks, no deals closing soon, nothing stale. Enjoy the quiet.";
  const lines = [`🗓️ **Plan for ${todayStr()}**`, "", body];
  if (an.analystConfigured()) {
    const facts = [
      `Overdue tasks: ${p.overdue.map((t) => t.title).join("; ") || "none"}`,
      `Due today: ${p.dueToday.map((t) => t.title).join("; ") || "none"}`,
      `Due this week: ${p.dueThisWeek.map((t) => t.title).join("; ") || "none"}`,
      `Deals closing within 14 days: ${p.closingSoon.map((d) => `${d.title} (${d.expected_close}, ${d.value})`).join("; ") || "none"}`,
      `Stale deals: ${p.staleTop.map((d) => `${d.title} (${d.days}d)`).join("; ") || "none"}`,
    ].join("\n");
    const r = await an.askAnalyst({ system: an.PLAN_DAY_SYSTEM, facts });
    lines.push("", r.ok
      ? `**Suggested schedule** _(from your analyst model)_:\n${r.text}`
      : `_Schedule skipped — ${r.error.slice(0, 200)}._`);
  }
  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
    cards: p.overdue.length + p.dueToday.length ? [{ kind: "tasks", title: "Today's tasks", items: [...p.overdue, ...p.dueToday] }] : undefined,
    chips: ["Plan my week", "My tasks", "Morning brief"],
  };
}

function weekdayName(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { weekday: "long" });
}

async function planWeekReply(): Promise<Reply> {
  const p = await gatherPlanData();
  const today = todayStr();
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const lines = [`🗓️ **Plan for the week**`, ""];
  if (p.overdue.length) lines.push(`**Overdue — clear first:**\n${p.overdue.map(taskLine).join("\n")}`, "");
  for (const day of days) {
    const ts = [...p.dueToday, ...p.dueThisWeek, ...p.later].filter((t) => t.due_date === day);
    const ds = p.closingSoon.filter((d) => d.expected_close === day);
    if (!ts.length && !ds.length) continue;
    lines.push(`**${weekdayName(day)} ${day}${day === today ? " (today)" : ""}:**`);
    for (const t of ts) lines.push(taskLine(t));
    for (const d of ds) lines.push(`• 📌 **${d.title}** closes — ${stageLabel(d.stage)} · ${fmtMoney(d.value)}`);
    lines.push("");
  }
  const undated = p.later.filter((t) => !t.due_date);
  if (undated.length) lines.push(`**No due date:**\n${undated.map(taskLine).join("\n")}`, "");
  if (p.staleTop.length) lines.push(`**Needs attention (stale deals):**\n${p.staleTop.map((d) => `• **${d.title}** — ${d.stage} · ${fmtMoney(d.value)} · ${d.days}d`).join("\n")}`);
  if (an.analystConfigured()) {
    const facts = [
      `Overdue: ${p.overdue.map((t) => t.title).join("; ") || "none"}`,
      ...days.map((day) => {
        const ts = [...p.dueToday, ...p.dueThisWeek].filter((t) => t.due_date === day).map((t) => t.title);
        const ds = p.closingSoon.filter((d) => d.expected_close === day).map((d) => `${d.title} closes`);
        return `${weekdayName(day)}: ${[...ts, ...ds].join("; ") || "—"}`;
      }),
      `Stale deals: ${p.staleTop.map((d) => `${d.title} (${d.days}d)`).join("; ") || "none"}`,
    ].join("\n");
    const r = await an.askAnalyst({ system: an.PLAN_WEEK_SYSTEM, facts });
    lines.push("", r.ok
      ? `**Suggested week** _(from your analyst model)_:\n${r.text}`
      : `_Week plan skipped — ${r.error.slice(0, 200)}._`);
  }
  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    chips: ["Plan my day", "My tasks", "Morning brief"],
  };
}

async function planBreakdownReply(session: Session, goal: string): Promise<Reply> {
  const g = (goal || "").trim();
  if (!g) return { text: "What should I break down? Try `break down launch event`.", chips: ["Help"] };
  if (!an.analystConfigured()) {
    // LLM integration is parked: use the deterministic built-in template.
    const steps = deterministicBreakdown(g);
    session.pending = { type: "plan_tasks", label: g, payload: { goal: g, steps } };
    const lines = steps.map((s, i) => `${i + 1}. ${s}`);
    return {
      text: `Here's a plan for **"${g}"** — research, milestones, execution, review (generated offline from a template; the analyst model will make these smarter when it returns):\n${lines.join("\n")}\nShould I create these ${steps.length} as tasks?`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, create tasks" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  const r = await an.askAnalyst({ system: an.BREAKDOWN_SYSTEM, facts: `Goal: ${g}` });
  if (!r.ok) return { text: `I couldn't get steps from the analyst model (${r.error.slice(0, 200)}). Nothing was created.`, chips: ["Help"] };
  const steps = an.parseNumberedList(r.text);
  if (!steps.length) {
    return { text: "The analyst model didn't return a usable step list — nothing was created. Try rephrasing the goal.", chips: ["Help"] };
  }
  session.pending = { type: "plan_tasks", label: g, payload: { goal: g, steps } };
  return {
    text: `Here's a plan for **${g}** — create these ${steps.length} as tasks?\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    cards: [{ kind: "confirm", options: [{ n: 1, label: `Yes, create ${steps.length} tasks` }, { n: 2, label: "Cancel" }] }],
    chips: ["Yes", "No"],
  };
}

async function planTasksSave(session: Session, payload: { goal: string; steps: string[] }): Promise<Reply> {
  let created = 0;
  for (const step of payload.steps) {
    await crm.createTask({ title: step });
    created++;
  }
  return { text: `Created ${created} task${created === 1 ? "" : "s"} for "${payload.goal}".`, chips: ["My tasks", "Plan my day"] };
}
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

// ---- pipeline stages ------------------------------------------------------------
async function pickStage(query: string): Promise<{ stage?: crm.Stage; matches: crm.Match<crm.Stage>[] }> {
  const matches = await crm.resolveStage(query);
  if (!matches.length) return { matches };
  const [top, second] = [matches[0], matches[1]];
  if (top.score >= 70 && (!second || top.score - second.score >= 20)) return { stage: top.item, matches };
  return { matches };
}

async function stagesReply(): Promise<Reply> {
  const stages = await crm.getStages();
  if (!stages.length) return { text: "No pipeline stages yet — say `add stage <name>` to create one." };
  const lines = stages.map((s, i) => `${i + 1}. **${s.name}**${s.deals ? ` — ${s.deals} deal(s)` : ""}`);
  return {
    text: `**Pipeline stages** (in order):\n${lines.join("\n")}`,
    chips: ["Show pipeline", "Add stage …"],
  };
}

function friendlyStageError(e: any, what: string): string {
  const msg = String(e?.message || e);
  const m = msg.match(/-> (\d+) (.*)$/);
  if (m && m[1] === "409") return `There's already a stage like that — say \`stages\` to see them.`;
  if (m) return `Couldn't ${what}: ${m[2]}`;
  throw e; // connectivity etc: let handleMessage's catch phrase it
}

async function addStageReply(session: Session, s: Record<string, string>): Promise<Reply> {
  const name = (s.name || "").trim();
  if (!name) return { text: "What should the new stage be called?" };
  let ref: crm.Stage | undefined;
  if (s.ref) {
    const r = await pickStage(s.ref);
    if (!r.stage) return { text: `I couldn't find a stage called "${s.ref}". Say \`stages\` to see them.`, chips: ["Stages"] };
    ref = r.stage;
  }
  try {
    const st = await crm.addStage(name, s.pos && ref ? { [s.pos]: ref.slug } : {});
    const where = s.pos && ref ? ` ${s.pos} **${ref.name}**` : " at the end";
    return { text: `Added stage **${st.name}**${where} of the pipeline.`, chips: ["Stages", "Show pipeline"] };
  } catch (e: any) {
    return { text: friendlyStageError(e, "add the stage") };
  }
}

async function stageByName(session: Session, query: string, action: string, payload: any): Promise<Reply> {
  if (!query) return { text: "Which stage?" };
  const { stage, matches } = await pickStage(query);
  if (stage) return stageAction(session, action, stage, payload);
  if (!matches.length) {
    const names = (await crm.getStages()).map((s) => s.name).join(", ");
    return { text: `I couldn't find a stage called "${query}". Current stages: ${names}.`, chips: ["Stages"] };
  }
  const top = matches.slice(0, 5);
  session.choice = {
    kind: "stage",
    options: top.map((m, i) => ({ id: i, n: i + 1, label: m.item.name, sub: `${m.item.deals || 0} deal(s)` })),
    then: { action, payload: { ...payload, slugs: top.map((m) => m.item.slug) } },
  };
  return {
    text: "A few stages match — which one did you mean?",
    cards: [{ kind: "choices", options: session.choice.options }],
    chips: session.choice.options.map((o) => String(o.n)),
  };
}

async function stageAction(session: Session, action: string, stage: crm.Stage, payload: any): Promise<Reply> {
  if (action === "rename_stage") {
    const name = (payload.name || "").trim();
    if (!name) return { text: "What should it be renamed to?" };
    try {
      const st = await crm.patchStage(stage.slug, { name });
      return { text: `Renamed "${stage.name}" → **${st.name}**.`, chips: ["Stages", "Show pipeline"] };
    } catch (e: any) {
      return { text: friendlyStageError(e, "rename the stage") };
    }
  }
  if (action === "move_stage") {
    const r = await pickStage(payload.ref || "");
    if (!r.stage) return { text: `I couldn't find a stage called "${payload.ref}". Say \`stages\` to see them.`, chips: ["Stages"] };
    if (r.stage.slug === stage.slug) return { text: "That's the same stage — pick a different one." };
    try {
      await crm.patchStage(stage.slug, { [payload.pos]: r.stage.slug });
      return { text: `Moved **${stage.name}** ${payload.pos} **${r.stage.name}**.`, chips: ["Stages", "Show pipeline"] };
    } catch (e: any) {
      return { text: friendlyStageError(e, "move the stage") };
    }
  }
  if (action === "delete_stage") {
    const deals = stage.deals || 0;
    if (deals > 0) {
      // destructive with occupants: first pick a safe home for the deals
      session.pending = { type: "delete_stage_target", label: stage.name, payload: { slug: stage.slug, deals } };
      return { text: `🗑️ "${stage.name}" holds ${deals} deal(s). Which stage should I move them into?`, chips: ["Cancel"] };
    }
    session.pending = { type: "delete_stage", label: stage.name, payload: { slug: stage.slug, deals: 0 } };
    return {
      text: `Delete stage "${stage.name}"? It holds no deals. This can't be undone.`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, delete" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
  }
  return { text: "I lost track of that stage action — try again." };
}

async function dealAction(session: Session, action: string, deal: crm.Deal, payload: any): Promise<Reply> {
  if (action === "move_deal") {
    const d = await crm.patchDeal(deal.id, { stage: payload.stage });
    return { text: `Moved "${d.title}" to **${stageLabel(d.stage)}**.`, cards: [dealCard(d)], chips: ["Show pipeline", "Morning brief"] };
  }
  if (action === "close_deal") {
    const won = payload.result === "won";
    // Both directions ask first: closing moves pipeline state and money.
    // Unattended runs skip these (DESTRUCTIVE_PENDING / isDestructiveIntent).
    session.pending = { type: won ? "close_won" : "close_lost", label: deal.title, payload: { id: deal.id } };
    return {
      text: won
        ? `Mark "${deal.title}" as **won** (${fmtMoney(deal.value)})?`
        : `Mark "${deal.title}" as **lost**?`,
      cards: [{ kind: "confirm", options: [{ n: 1, label: won ? "Yes, mark won" : "Yes, mark lost" }, { n: 2, label: "Cancel" }] }],
      chips: ["Yes", "No"],
    };
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
  if (action === "save_note") {
    const note: SavedNote = {
      dealId: deal.id, dealTitle: deal.title,
      text: String(payload.text || "").slice(0, 2000),
      uploadId: payload.uploadId, at: new Date().toISOString(),
    };
    session.notes = [...(session.notes || []), note].slice(-20);
    return {
      text: `Saved to **"${deal.title}"** — ${(session.notes || []).length} note${(session.notes || []).length === 1 ? "" : "s"} filed this session.`,
      cards: [dealCard(deal)], chips: ["My notes", "Morning brief", "Show pipeline"],
    };
  }
  if (action === "deal_detail") {
    const lines = [`"${deal.title}" at a glance:`, ...dealNotesLines(deal, session)];
    return { text: lines.join("\n"), cards: [dealCard(deal)] };
  }
  if (action === "add_note") {
    const text = String(payload.text || "").trim().slice(0, 2000);
    if (!text) return { text: `What should I note on "${deal.title}"? Try \`note on ${deal.title}: <text>\`.` };
    dealNotes.addDealNote(deal.id, text, session.workspaceId ?? null);
    const n = dealNotes.countDealNotes(deal.id, session.workspaceId ?? null);
    return {
      text: `📝 Noted on **"${deal.title}"** — "${text.length > 120 ? text.slice(0, 120) + "…" : text}" (${n} note${n === 1 ? "" : "s"} on this deal).`,
      cards: [dealCard(deal)],
      chips: [`Show deal ${deal.title}`, "Morning brief"],
    };
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

// ---- conversational capture -----------------------------------------------------------
// "just met James from Vertex, he's evaluating the pilot" -> confirm card ->
// on Yes: fuzzy-match-or-create company, create linked contact, open a deal
// draft in the first pipeline stage. Never writes before confirmation.

interface CapturePayload { name: string; company: string; note: string }

function captureCard(p: CapturePayload): Reply {
  const lines = [
    `• Name: **${p.name}**`,
    `• Company: ${p.company ? `**${p.company}**` : "—"}`,
    `• Note: ${p.note || "—"}`,
  ];
  const plan = p.company
    ? `On confirm I'll match or create **${p.company}**, add **${p.name}** as a contact there, and open a deal draft.`
    : `On confirm I'll add **${p.name}** as a contact and open a deal draft.`;
  return {
    text: `Just met **${p.name}** — here's what I picked up:\n${lines.join("\n")}\n\n${plan}\nSay \`yes\` to save, \`no\` to drop it — or just reply with corrections.`,
    cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, save it" }, { n: 2, label: "Cancel" }] }],
    chips: ["Yes", "No"],
  };
}

function captureReply(session: Session, rest: string): Reply {
  const p = parseCapture(rest);
  if (!p.name) {
    return {
      text: `Who did you meet? I couldn't pick out a name — try \`just met Jane from Acme, she's interested in the pilot\`.`,
      chips: ["Help"],
    };
  }
  session.pending = { type: "capture", label: p.name, payload: p };
  return captureCard(p);
}

/** Non-Yes/No replies to a pending capture are treated as corrected details:
 *  reparse, update whatever fields came through, and show the card again. */
function captureCorrectReply(session: Session, raw: string): Reply {
  const p = session.pending!.payload as CapturePayload;
  const restated = raw.match(/^(?:i )?(?:just )?met (.+)$/i);
  const fix = parseCapture(restated ? restated[1] : raw);
  const nm = raw.match(/\bname is ([A-Z][\w.'-]*(?: +[A-Z][\w.'-]+){0,2})/);
  const co = raw.match(/\bcompany is ([^,.]+)/i);
  if (nm) p.name = nm[1].trim();
  else if (fix.name) p.name = fix.name;
  if (co) p.company = co[1].trim();
  else if (fix.company) p.company = fix.company;
  if (fix.note) p.note = fix.note;
  else if (!nm && !co && !fix.name && !fix.company) p.note = raw.trim();
  session.pending!.label = p.name;
  return captureCard(p);
}

async function captureSave(session: Session, p: CapturePayload): Promise<Reply> {
  let companyId: number | null = null;
  let companyName = "";
  if (p.company) {
    const ms = await crm.resolveCompany(p.company);
    if (ms.length) { companyId = ms[0].item.id; companyName = ms[0].item.name; }
    else { const c = await crm.createCompany({ name: p.company }); companyId = c.id; companyName = c.name; }
  }
  const contactPatch: Record<string, any> = { name: p.name, notes: p.note || "" };
  if (companyId) contactPatch.company_id = companyId;
  const contact = await crm.createContact(contactPatch);
  const stages = await crm.getStages();
  const stage = stages[0]?.slug || "prospecting";
  const noteShort = p.note
    ? p.note.replace(/^(he|she|they|it)'s /i, "").split(/\s+/).slice(0, 6).join(" ")
    : "";
  const title = p.company
    ? `${companyName || p.company} — ${noteShort || "new contact"}`
    : `${p.name} — ${noteShort || "introduction"}`;
  const dealPatch: Record<string, any> = {
    title, stage, notes: p.note || `Met ${p.name}`, contact_id: contact.id,
  };
  if (companyId) dealPatch.company_id = companyId;
  const deal = await crm.createDeal(dealPatch);
  return {
    text: `Saved ✅ **${p.name}**${companyName ? ` at **${companyName}**` : ""} — contact added and deal draft **"${deal.title}"** opened in ${stages[0]?.name || "the first stage"}.`,
    chips: ["Show pipeline", "List contacts"],
  };
}

// ---- vCard import ------------------------------------------------------------------
// Parses an uploaded .vcf file, shows a confirmation card listing what's inside,
// and only writes to exec-crm after the user confirms.

async function vcardOfferReply(session: Session, att: UploadRef): Promise<Reply> {
  let text: string;
  try {
    text = await Bun.file(att.path).text();
  } catch {
    return { text: "I couldn't read that file — try uploading it again.", chips: ["Help"] };
  }
  let cards: ParsedVCard[];
  try {
    cards = parseVcards(text);
  } catch (e: any) {
    return { text: `That file doesn't look like a valid vCard: ${String(e?.message || e)}`, chips: ["Help"] };
  }
  if (!cards.length) return { text: "That vCard file has no contacts in it.", chips: ["Help"] };
  const named = cards.filter((c) => c.name.trim()).length;
  session.pending = { type: "vcard_import", label: `${cards.length} contacts`, payload: { cards } };
  const items = cards.map((c) => ({
    name: c.name.trim() || "(no name — will be skipped)",
    company_name: [c.org, c.title].filter(Boolean).join(" · "),
    email: preferredEmail(c)?.email || "",
    phone: preferredPhone(c)?.number || "",
  }));
  const skipNote = named < cards.length
    ? ` ${cards.length - named} ${cards.length - named === 1 ? "entry" : "entries"} without a name will be skipped.`
    : "";
  return {
    text: `This file has **${cards.length} contact${cards.length === 1 ? "" : "s"}**. Import them into exec-crm?${skipNote}`,
    cards: [
      { kind: "contacts", title: "Contacts in file", items },
      { kind: "confirm", options: [{ n: 1, label: `Yes, import ${named || cards.length}` }, { n: 2, label: "Cancel" }] },
    ],
    chips: ["Yes", "No"],
  };
}

async function importContactsReply(session: Session, opts: MessageOpts): Promise<Reply> {
  const atts = opts.attachments || [];
  const vcf = atts.find((a) => a.mime === "text/vcard")
    || (opts.latestUpload?.mime === "text/vcard" ? opts.latestUpload : null);
  if (!vcf) {
    return { text: "Attach a `.vcf` contact file first, then say `import these contacts`.", chips: ["Help"] };
  }
  return vcardOfferReply(session, vcf);
}

/** Confirmed vCard import: dedupe by email against the session workspace, then
 *  create each contact. Never throws the whole batch away on one failure. */
async function vcardImportRun(cards: ParsedVCard[]): Promise<Reply> {
  const existing = new Set(
    (await crm.getContacts()).map((c) => (c.email || "").toLowerCase()).filter(Boolean)
  );
  let created = 0, skipped = 0, failed = 0;
  const failures: string[] = [];
  for (const vc of cards) {
    const name = vc.name.trim();
    const email = preferredEmail(vc)?.email?.trim() || "";
    if (!name) { skipped++; continue; } // nameless entry
    if (email && existing.has(email.toLowerCase())) { skipped++; continue; } // duplicate
    try {
      let company_id: number | undefined;
      let unmatchedOrg = "";
      if (vc.org) {
        const ms = await crm.resolveCompany(vc.org);
        if (ms.length && ms[0].score >= 70) company_id = ms[0].item.id;
        else unmatchedOrg = `Company: ${vc.org}`; // never silently drop the ORG
      }
      const patch: any = { name };
      if (email) patch.email = email;
      const phone = preferredPhone(vc)?.number?.trim();
      if (phone) patch.phone = phone;
      if (vc.title) patch.title = vc.title;
      if (company_id) patch.company_id = company_id;
      const noteBits = [vc.note, unmatchedOrg, vc.url ? `Website: ${vc.url}` : ""].filter(Boolean);
      if (noteBits.length) patch.notes = noteBits.join("\n");
      const done = await crm.createContact(patch);
      created++;
      if (done.email) existing.add(done.email.toLowerCase());
    } catch (e: any) {
      failed++;
      failures.push(name);
    }
  }
  const bits = [`Imported **${created}** contact${created === 1 ? "" : "s"}`];
  if (skipped) bits.push(`${skipped} skipped (no name or already in exec-crm)`);
  if (failed) bits.push(`${failed} failed (${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""})`);
  return { text: bits.join(" · ") + ".", chips: ["List contacts", "Morning brief"] };
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

// ---- one-shot reminders ------------------------------------------------------------
function remindAddReply(session: Session, rest: string): Reply {
  const now = Date.now();
  const parsed = parseReminderTime(rest, now);
  if (!parsed) {
    return { text: "When should I remind you? Try `remind me to stretch in 20 minutes` or `remind me to call Sarah tomorrow at 9am`.", chips: ["Help"] };
  }
  if (!parsed.text) {
    return { text: "Remind you to do what? Try `remind me to stretch in 20 minutes`.", chips: ["Help"] };
  }
  if (parsed.fireAt <= now) {
    return { text: "That time's already past — give me a future time?", chips: ["Help"] };
  }
  session.pending = { type: "reminder_add", label: parsed.text, payload: { text: parsed.text, fireAt: parsed.fireAt } };
  return {
    text: `Remind you to **${parsed.text}** ${formatWhen(parsed.fireAt, now)}?`,
    cards: [{ kind: "confirm", options: [{ n: 1, label: "Yes, set reminder" }, { n: 2, label: "Cancel" }] }],
    chips: ["Yes", "No"],
  };
}

function remindListReply(session: Session): Reply {
  const rs = auto.listReminders(session.id);
  if (!rs.length) {
    return { text: "No pending reminders. Set one with `remind me to stretch in 20 minutes`.", chips: ["Help"] };
  }
  const lines = rs.map((r) => `${r.id}. **${r.text}** — ${formatWhen(r.fire_at)}`);
  return {
    text: `⏰ **Pending reminders:**\n${lines.join("\n")}\n\nCancel one with \`cancel reminder <n>\`.`,
    chips: ["Help"],
  };
}

function remindCancelReply(session: Session, idRaw: string): Reply {
  const id = parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { text: "Which reminder? Use `cancel reminder <n>` with the number from `reminders`.", chips: ["Reminders"] };
  }
  if (auto.cancelReminder(id, session.id)) {
    return { text: `Cancelled reminder **${id}**.`, chips: ["Reminders"] };
  }
  return { text: `No pending reminder **${id}** in this chat.`, chips: ["Reminders"] };
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

// crm.ts — thin client for the exec-crm REST API, plus fuzzy entity resolution.
// Milton never touches exec-crm's database directly; everything goes through HTTP.

export interface Deal {
  id: number; title: string; company_id: number | null; contact_id: number | null;
  campaign_id?: number | null;
  company_name?: string; contact_name?: string;
  value: number; stage: string; probability: number;
  expected_close: string; owner: string; created_at: string; updated_at: string;
}
export interface Contact {
  id: number; name: string; email: string; phone: string;
  company_id: number | null; company_name?: string; title: string; notes: string;
}
export interface Company { id: number; name: string; industry: string; website: string; notes: string }
export interface Task {
  id: number; title: string; deal_id: number | null; campaign_id: number | null;
  due_date: string; done: number; owner: string; created_at: string;
  blocked_by?: { id: number; title: string; done: number }[];
  is_blocked?: boolean;
}
export interface DealHistoryEntry {
  id: number; from_stage: string | null; to_stage: string | null;
  created_at: string; from_name?: string | null; to_name?: string | null;
}
export interface DuplicatePair {
  a: { id: number; name: string; email?: string | null };
  b: { id: number; name: string; email?: string | null };
  reason: string;
}
export interface Kpis { [k: string]: any }
export interface Activity { id: number; kind: string; text: string; ref_type: string; ref_id: number; created_at: string }
export interface Webhook { id: number; name: string; url: string; events: string; active: number }
export interface Stage {
  slug: string; name: string; position: number; color: string; deals?: number;
}
export interface IncomingHook { id: number; name: string; key: string; created_at: string }
export interface Campaign { id: number; name: string; status?: string }

import { currentWorkspaceId } from "./workspace";

const BASE = process.env.EXEC_CRM_URL || process.env.MILTON_CRM_URL || "http://localhost:3001";

/** Exported for Data Workshop Sandbox staging (brain.ts): workspace-scoped. */
export async function req(path: string, method = "GET", body?: any): Promise<any> {
  // Session workspace scoping: ?workspace=<id> wins in exec-crm's needWs
  // (over the X-Workspace header). null = default workspace: send nothing.
  const ws = currentWorkspaceId();
  const scoped = ws == null ? path : `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(String(ws))}`;
  const res = await fetch(BASE + scoped, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`exec-crm ${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
  }
  return res.json().catch(() => ({}));
}

export const STAGES = ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
export const STAGE_LABELS: Record<string, string> = {
  prospecting: "Prospecting", qualification: "Qualification", proposal: "Proposal",
  negotiation: "Negotiation", closed_won: "Closed won", closed_lost: "Closed lost",
};

export async function ping(): Promise<boolean> {
  try { await req("/api/kpis"); return true; } catch { return false; }
}

export async function getDeals(source?: string): Promise<Deal[]> {
  const q = source ? `?source=${encodeURIComponent(source)}` : "";
  const j = await req(`/api/deals${q}`);
  return j.deals || [];
}
export async function getDealSources(): Promise<string[]> {
  const j = await req("/api/deal-sources");
  return j.sources || [];
}
export async function getDealHistory(id: number): Promise<DealHistoryEntry[]> {
  const j = await req(`/api/deals/${id}/history`);
  return j.history || [];
}
export async function getDuplicates(type: "contact" | "company"): Promise<DuplicatePair[]> {
  const j = await req(`/api/duplicates?type=${type}`);
  return j.pairs || [];
}
export async function getContacts(): Promise<Contact[]> {
  const j = await req("/api/contacts");
  return j.contacts || [];
}
export async function getCompanies(): Promise<Company[]> {
  const j = await req("/api/companies");
  return j.companies || [];
}
export async function getTasks(): Promise<Task[]> {
  const j = await req("/api/tasks");
  return j.tasks || [];
}
export async function getKpis(): Promise<Kpis> {
  return req("/api/kpis");
}
export async function getActivities(): Promise<Activity[]> {
  const j = await req("/api/activities");
  return j.activities || [];
}
export async function getWebhooks(): Promise<Webhook[]> {
  const j = await req("/api/webhooks");
  return j.webhooks || [];
}
export async function getIncomingHooks(): Promise<IncomingHook[]> {
  const j = await req("/api/hooks");
  return j.hooks || [];
}
export async function getDeliveries(): Promise<any[]> {
  const j = await req("/api/deliveries");
  return j.deliveries || [];
}
export async function getCampaigns(): Promise<Campaign[]> {
  const j = await req("/api/campaigns");
  return j.campaigns || [];
}
/** exec-crm requires a valid company_id for new campaigns (400 otherwise) and
 *  autopopulates its standard sales-workflow tasks on creation. */
export async function createCampaign(c: { name: string; company_id: number }): Promise<Campaign> {
  const j = await req("/api/campaigns", "POST", c);
  return j.campaign;
}

export async function createDeal(d: Partial<Deal>): Promise<Deal> {
  const j = await req("/api/deals", "POST", d);
  return j.deal;
}
export async function patchDeal(id: number, d: Partial<Deal>): Promise<Deal> {
  const j = await req(`/api/deals/${id}`, "PATCH", d);
  return j.deal;
}
export async function deleteDeal(id: number): Promise<void> {
  await req(`/api/deals/${id}`, "DELETE");
}

// ---- pipeline stages (per-workspace editable schema; req() scopes ?workspace=)
export async function getStages(): Promise<Stage[]> {
  const j = await req("/api/stages");
  return j.stages || [];
}
export async function addStage(name: string, opts: { before?: string; after?: string; color?: string } = {}): Promise<Stage> {
  const j = await req("/api/stages", "POST", { name, ...opts });
  return j.stage;
}
export async function patchStage(slug: string, patch: { name?: string; color?: string; before?: string; after?: string; position?: number }): Promise<Stage> {
  const j = await req(`/api/stages/${encodeURIComponent(slug)}`, "PATCH", patch);
  return j.stage;
}
export async function deleteStage(slug: string, moveTo?: string): Promise<{ ok: boolean; moved: number }> {
  const q = moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : "";
  return req(`/api/stages/${encodeURIComponent(slug)}${q}`, "DELETE");
}
/** Fuzzy-resolve a stage by display name (or slug). */
export async function resolveStage(query: string): Promise<Match<Stage>[]> {
  const stages = await getStages();
  const items = stages.map((s, i) => ({ ...s, id: i, name: s.name }));
  const bySlug = stages.findIndex((s) => s.slug === query.toLowerCase().trim());
  const matches = matchByName(items, query) as Match<Stage>[];
  if (bySlug >= 0 && !matches.some((m) => m.item.slug === stages[bySlug].slug)) {
    matches.unshift({ item: stages[bySlug] as Stage, score: 100 });
  }
  return matches;
}
export async function createContact(c: Partial<Contact>): Promise<Contact> {
  const j = await req("/api/contacts", "POST", c);
  return j.contact;
}
export async function patchContact(id: number, c: Partial<Contact>): Promise<Contact> {
  const j = await req(`/api/contacts/${id}`, "PATCH", c);
  return j.contact;
}
export async function createCompany(c: Partial<Company>): Promise<Company> {
  const j = await req("/api/companies", "POST", c);
  return j.company;
}
export async function createTask(t: Partial<Task>): Promise<Task> {
  const j = await req("/api/tasks", "POST", t);
  return j.task;
}
export async function patchTask(id: number, t: Partial<Task>): Promise<Task> {
  const j = await req(`/api/tasks/${id}`, "PATCH", t);
  return j.task;
}
/** Flip task completion. Throws on 409 when open blockers exist unless confirm=true. */
export async function toggleTask(id: number, confirm?: boolean): Promise<Task> {
  const j = await req(`/api/tasks/${id}/toggle`, "POST", confirm ? { confirm: true } : {});
  return j.task;
}
export async function deleteTask(id: number): Promise<void> {
  await req(`/api/tasks/${id}`, "DELETE");
}

// ---- fuzzy entity resolution ------------------------------------------------
// Scores candidates by substring match quality; returns ranked list.
function scoreName(name: string, query: string): number {
  const n = name.toLowerCase(), q = query.toLowerCase().trim();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  const words = n.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 70;
  if (n.includes(q)) return 50;
  // token overlap fallback: every query token found somewhere
  const qt = q.split(/\s+/);
  if (qt.length > 1 && qt.every((t) => n.includes(t))) return 40;
  return 0;
}

export interface Match<T> { item: T; score: number }

export function matchByName<T extends { id: number; name?: string; title?: string }>(
  items: T[], query: string
): Match<T>[] {
  const label = (it: T) => (it.name ?? it.title ?? "").toString();
  return items
    .map((item) => ({ item, score: scoreName(label(item), query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || label(a.item).localeCompare(label(b.item)));
}

export async function resolveDeal(query: string): Promise<Match<Deal>[]> {
  const deals = await getDeals();
  return matchByName(deals.map((d) => ({ ...d, name: d.title })), query) as Match<Deal>[];
}
export async function resolveContact(query: string): Promise<Match<Contact>[]> {
  return matchByName(await getContacts(), query);
}
export async function resolveCompany(query: string): Promise<Match<Company>[]> {
  return matchByName(await getCompanies(), query);
}
export async function resolveTask(query: string): Promise<Match<Task>[]> {
  const tasks = await getTasks();
  // allow lookup by numeric id as well
  if (/^\d+$/.test(query.trim())) {
    const t = tasks.find((t) => t.id === Number(query.trim()));
    if (t) return [{ item: t, score: 100 }];
  }
  return matchByName(tasks.map((t) => ({ ...t, name: t.title })), query) as Match<Task>[];
}
export async function resolveCampaign(query: string): Promise<Match<Campaign>[]> {
  return matchByName(await getCampaigns(), query);
}

export function crmBase(): string { return BASE; }

// ---- custom fields (exec-crm's /api/custom-fields, workspace-scoped like everything else)
export interface CustomField { id: number; name: string; field_type: string; value?: string | null }
// exec-crm definitions carry name=slug, label=display, type; the values
// endpoint carries field_id, name=label, field_type. Normalize both to one shape.
function normField(f: any): CustomField {
  return {
    id: Number(f.id ?? f.field_id),
    name: String(f.label ?? f.name ?? ""),
    field_type: String(f.type ?? f.field_type ?? "text"),
    value: f.value ?? null,
  };
}
export async function getCustomFields(entityType: string): Promise<CustomField[]> {
  const j = await req(`/api/custom-fields?entity_type=${encodeURIComponent(entityType)}`);
  return (j.fields || []).map(normField);
}
export async function addCustomField(entityType: string, name: string, fieldType: string): Promise<CustomField> {
  const j = await req("/api/custom-fields", "POST", { entity_type: entityType, name, field_type: fieldType });
  return normField(j.field);
}
export async function deleteCustomField(id: number): Promise<void> {
  await req(`/api/custom-fields/${id}`, "DELETE");
}
export async function getCustomFieldValues(entityType: string, entityId: number): Promise<CustomField[]> {
  const j = await req(`/api/custom-fields/values?entity_type=${encodeURIComponent(entityType)}&entity_id=${entityId}`);
  return (j.values || j.fields || []).map(normField);
}
export async function setCustomFieldValue(fieldId: number, entityId: number, value: string): Promise<{ ok: boolean }> {
  return req("/api/custom-fields/values", "PUT", { field_id: fieldId, entity_id: entityId, value });
}

// ---- milton widgets (published to exec-crm's /api/milton/widgets, rendered on its Milton tab)
export interface Widgetable {
  kind: "stat" | "table" | "bars" | "list";
  title: string;
  payload: any;
  source?: string;
}
/** Pin a widget to the active session workspace's Milton tab in exec-crm. */
export async function pinWidget(w: Widgetable): Promise<any> {
  const j = await req("/api/milton/widgets", "POST", w);
  return j.widget;
}

// meridian.ts — read-only client for Meridian's recon outputs.
// Milton never launches recons or mutates anything here: every call is GET.
// Meridian is a separate app (Bun + SQLite, port 3005); Milton only reads
// its recon sprints over HTTP.

export interface ReconSummary {
  id: string; city: string; country: string; status: string;
  created_at: string; updated_at: string; nodes: number; edges: number;
}
export interface ReconNode {
  id: string; label: string; type: string; subtype?: string;
  source: string; detail?: string; url?: string;
}
export interface ReconDetail {
  id: string; city: string; country: string; status: string;
  nodes: ReconNode[]; edges: { from: string; to: string; label: string }[];
  facts: Record<string, any>; sources: any[];
  created_at: string; updated_at: string;
}

export const MERIDIAN_DEFAULT = "http://localhost:3005";
export const MILTON_DEFAULT = "http://localhost:3009";

/** Meridian base URL (MERIDIAN_URL env, default http://localhost:3005). */
export function meridianBase(): string {
  return process.env.MERIDIAN_URL || MERIDIAN_DEFAULT;
}

/** Milton's own base URL (MILTON_BASE_URL env, default http://localhost:3009).
 *  Meridian must be able to reach this for run-completion callbacks. */
export function miltonBase(): string {
  return (process.env.MILTON_BASE_URL || MILTON_DEFAULT).replace(/\/+$/, "");
}

// Short timeout: a recon read must never hang the chat.
const TIMEOUT_MS = 8000;

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(meridianBase() + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---- discovery ----------------------------------------------------------------------
let cache: { at: number; list: ReconSummary[] } | null = null;
export const RECON_CACHE_MS = 60000;

/** Recent recon sprints, newest first — or null when Meridian is unreachable. */
export async function listRecons(): Promise<ReconSummary[] | null> {
  const now = Date.now();
  if (cache && now - cache.at < RECON_CACHE_MS) return cache.list;
  const j = await get<{ recons?: any[] }>("/api/recon");
  if (!j) return null;
  const list: ReconSummary[] = (j.recons || []).map((r: any) => ({
    id: String(r.id),
    city: String(r.city || "?"),
    country: String(r.country || ""),
    status: String(r.status || "?"),
    created_at: String(r.created_at || ""),
    updated_at: String(r.updated_at || ""),
    nodes: Number(r.nodes || 0),
    edges: Number(r.edges || 0),
  }));
  cache = { at: now, list };
  return list;
}

/** Full recon (nodes, edges, facts) — or null when unreachable / not found. */
export async function getRecon(id: string): Promise<ReconDetail | null> {
  const j = await get<{ recon?: any }>(`/api/recon/${encodeURIComponent(id)}`);
  const r = j?.recon;
  if (!r) return null;
  return {
    id: String(r.id),
    city: String(r.city || "?"),
    country: String(r.country || ""),
    status: String(r.status || "?"),
    nodes: Array.isArray(r.nodes) ? r.nodes : [],
    edges: Array.isArray(r.edges) ? r.edges : [],
    facts: r.facts && typeof r.facts === "object" ? r.facts : {},
    sources: Array.isArray(r.sources) ? r.sources : [],
    created_at: String(r.created_at || ""),
    updated_at: String(r.updated_at || ""),
  };
}

/** Test helper: drop the in-memory recon list cache. */
export function clearReconCache(): void {
  cache = null;
}

// ---- run requests (the one write: Meridian's run-request router) ----------------------
// Everything above is read-only. This is the call that asks Meridian to do new
// work: POST /api/runs -> 202 { run_id, status }.

export type RunRequestResult =
  | { ok: true; run_id: string; status: string }
  | { ok: false; error: string; unreachable: boolean };

/**
 * Ask Meridian's run-request router for a new recon sprint.
 * callbackUrl/callbackHeaders are sent through so Meridian can POST the
 * completion payload back; omit them and the run is fire-and-forget.
 */
export async function requestReconRun(
  city: string,
  opts: { callbackUrl?: string; callbackHeaders?: Record<string, string> } = {}
): Promise<RunRequestResult> {
  const body: Record<string, any> = { city };
  if (opts.callbackUrl) body.callback_url = opts.callbackUrl;
  if (opts.callbackHeaders) body.callback_headers = opts.callbackHeaders;
  try {
    const res = await fetch(meridianBase() + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 202) {
      let detail = res.statusText;
      try { detail = JSON.stringify(await res.json()); } catch { /* keep statusText */ }
      return { ok: false, error: `status ${res.status}: ${String(detail).slice(0, 200)}`, unreachable: false };
    }
    const j: any = await res.json();
    if (!j?.run_id) return { ok: false, error: "bad response: no run_id", unreachable: false };
    return { ok: true, run_id: String(j.run_id), status: String(j.status || "?") };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e), unreachable: true };
  }
}

// ---- enrichment jobs (the one async write: company + principal lookup) --------
// POST /api/enrich -> 201 { job_id, status: "running" }; the scrape can take
// longer than a few seconds, so the job runs in Meridian's background and
// Milton polls GET /api/enrich/:id.

export interface EnrichCompany {
  name: string; domain: string;
  description?: string; founded?: string; employees?: string;
}
export interface EnrichPrincipal {
  name: string; title: string; email?: string; source_url: string;
}
export interface EnrichJob {
  id: string; query: string; status: string;
  progress: { done: number; total: number; current?: string };
  error: string | null;
  company: EnrichCompany | null; principals: EnrichPrincipal[] | null;
  notes: string[]; nodes: any[]; edges: any[];
  created_at: number; updated_at: number;
}

export type EnrichRequestResult =
  | { ok: true; job_id: string; status: string }
  | { ok: false; error: string; unreachable: boolean };

/** Start a company enrichment job in Meridian. */
export async function requestEnrich(query: string): Promise<EnrichRequestResult> {
  try {
    const res = await fetch(meridianBase() + "/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) {
      let detail = res.statusText;
      try { detail = JSON.stringify(await res.json()); } catch { /* keep statusText */ }
      return { ok: false, error: `status ${res.status}: ${String(detail).slice(0, 200)}`, unreachable: false };
    }
    const j: any = await res.json();
    if (!j?.job_id) return { ok: false, error: "bad response: no job_id", unreachable: false };
    return { ok: true, job_id: String(j.job_id), status: String(j.status || "running") };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e), unreachable: true };
  }
}

/** Poll one enrichment job — or null when Meridian is unreachable / unknown id. */
export async function getEnrichJob(id: string): Promise<EnrichJob | null> {
  const j = await get<any>(`/api/enrich/${encodeURIComponent(id)}`);
  // Meridian returns the job at the top level (fullEnrichJob); tolerate a
  // { job } wrapper too.
  const r = j?.job ?? j;
  if (!r || r.id == null) return null;
  return {
    id: String(r.id), query: String(r.query || ""), status: String(r.status || "?"),
    progress: r.progress && typeof r.progress === "object" ? r.progress : { done: 0, total: 0 },
    error: r.error ?? null,
    company: r.company ?? null,
    principals: Array.isArray(r.principals) ? r.principals : null,
    notes: Array.isArray(r.notes) ? r.notes : [],
    nodes: Array.isArray(r.nodes) ? r.nodes : [],
    edges: Array.isArray(r.edges) ? r.edges : [],
    created_at: Number(r.created_at || 0), updated_at: Number(r.updated_at || 0),
  };
}

// ---- territory prospecting (the second async write: Meridian finds companies) --
// POST /api/prospect { location, industry } -> 201 { job_id, status: "running" };
// the Overpass + territory pipeline can take longer than a few seconds, so the
// job runs in Meridian's background and Milton polls GET /api/prospect/:id.

export interface ProspectCompany {
  name: string; address?: string; lat?: number; lon?: number;
  tags?: Record<string, string>; industry?: string; territory?: string;
  source?: string; prospect?: boolean;
}
export interface ProspectJob {
  id: string; location: string; industry: string; status: string;
  progress: { done: number; total: number; current?: string };
  error: string | null;
  companies: ProspectCompany[] | null;
  nodes: any[]; edges: any[];
  created_at: number; updated_at: number;
}

export type ProspectRequestResult =
  | { ok: true; job_id: string; status: string }
  | { ok: false; error: string; unreachable: boolean };

/** Start a territory-prospecting job in Meridian. */
export async function requestProspect(location: string, industry: string): Promise<ProspectRequestResult> {
  try {
    const res = await fetch(meridianBase() + "/api/prospect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location, industry }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) {
      let detail = res.statusText;
      try { detail = JSON.stringify(await res.json()); } catch { /* keep statusText */ }
      return { ok: false, error: `status ${res.status}: ${String(detail).slice(0, 200)}`, unreachable: false };
    }
    const j: any = await res.json();
    if (!j?.job_id) return { ok: false, error: "bad response: no job_id", unreachable: false };
    return { ok: true, job_id: String(j.job_id), status: String(j.status || "running") };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e), unreachable: true };
  }
}

/** Poll one prospect job — or null when Meridian is unreachable / unknown id. */
export async function getProspectJob(id: string): Promise<ProspectJob | null> {
  const j = await get<any>(`/api/prospect/${encodeURIComponent(id)}`);
  // Tolerate a { job } wrapper, same as the enrich endpoint.
  const r = j?.job ?? j;
  if (!r || r.id == null) return null;
  const co = (c: any): ProspectCompany => ({
    name: String(c?.name || ""),
    ...(c?.address != null ? { address: String(c.address) } : {}),
    ...(c?.lat != null ? { lat: Number(c.lat) } : {}),
    ...(c?.lon != null ? { lon: Number(c.lon) } : {}),
    tags: c?.tags && typeof c.tags === "object" ? c.tags : {},
    ...(c?.industry != null ? { industry: String(c.industry) } : {}),
    ...(c?.territory != null ? { territory: String(c.territory) } : {}),
    ...(c?.source != null ? { source: String(c.source) } : {}),
    ...(c?.prospect != null ? { prospect: Boolean(c.prospect) } : {}),
  });
  return {
    id: String(r.id),
    location: String(r.location || ""),
    industry: String(r.industry || ""),
    status: String(r.status || "?"),
    progress: r.progress && typeof r.progress === "object" ? r.progress : { done: 0, total: 0 },
    error: r.error ?? null,
    companies: Array.isArray(r.companies) ? r.companies.map(co).filter((c) => c.name) : null,
    nodes: Array.isArray(r.nodes) ? r.nodes : [],
    edges: Array.isArray(r.edges) ? r.edges : [],
    created_at: Number(r.created_at || 0), updated_at: Number(r.updated_at || 0),
  };
}

// ---- fuzzy matching (same scoring as crm.ts matchByName / workspace.ts) --------------
function scoreName(name: string, query: string): number {
  const n = name.toLowerCase(), q = query.toLowerCase().trim();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  const words = n.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 70;
  if (n.includes(q)) return 50;
  const qt = q.split(/\s+/);
  if (qt.length > 1 && qt.every((t) => n.includes(t))) return 40;
  return 0;
}

export interface ReconMatch { recon: ReconSummary; score: number }

/**
 * Find recon sprints for a user query. Returns null when Meridian is unreachable.
 * A query exactly matching an id wins outright; otherwise fuzzy-matched on city.
 */
export async function findRecon(query: string): Promise<ReconMatch[] | null> {
  const list = await listRecons();
  if (!list) return null;
  const q = query.trim();
  if (!q) return [];
  const byId = list.find((r) => r.id.toLowerCase() === q.toLowerCase());
  if (byId) return [{ recon: byId, score: 100 }];
  return list
    .map((recon) => ({ recon, score: scoreName(recon.city, q) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ---- entity types -------------------------------------------------------------------
// Node types Meridian emits (from src/sources.ts). The ENTITY_TYPES subset is what
// "meridian entities" shows by default — business/org-type nodes.
export const NODE_TYPES = [
  "aircraft", "aleph", "asn", "bank", "city", "company", "contract", "culture",
  "currency", "data", "disaster", "document", "domain", "donor", "driving",
  "earthquake", "event", "exchange", "holiday", "host", "infra", "ip", "language",
  "music", "news", "nonprofit", "org", "partner", "person", "place", "record",
  "research", "researcher", "subdomain", "time", "weather", "wifi", "wikidata",
  "wikipedia",
];
export const ENTITY_TYPES = ["org", "company", "nonprofit", "bank", "partner", "donor"];

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

/** Meridian base URL (MERIDIAN_URL env, default http://localhost:3005). */
export function meridianBase(): string {
  return process.env.MERIDIAN_URL || MERIDIAN_DEFAULT;
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

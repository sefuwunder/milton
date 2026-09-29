// reasoning.ts — Phase 1 deterministic reasoning: task DAG (Kahn topo,
// critical chain, cycle report), contact/company/deal reachability (BFS),
// and value-weighted PageRank for key accounts / champions.
//
// All functions are pure and operate on plain CRM records — no I/O, no
// Date.now(), no randomness. Deterministic by construction: every traversal
// visits neighbors in sorted id order and every tie breaks on id.

import type { Deal, Contact, Company, Task } from "./crm";

// ---- task dependency DAG (P1a) ----------------------------------------------------
// Edges run blocker -> dependent. Only open tasks participate; a blocked_by
// entry pointing at a done/missing task is not an edge.

export interface TaskNode { id: number; title: string; owner: string; done: boolean; blockedBy: number[] }

export function toTaskNode(t: Task): TaskNode {
  const blockedBy = (t.blocked_by || []).map((b) => b.id).filter((n) => Number.isFinite(n));
  return { id: t.id, title: t.title, owner: t.owner || "", done: !!t.done, blockedBy };
}

export interface TopoResult { order: number[]; cyclic: number[] }

/** Kahn's algorithm over open tasks. `order` is a valid build order;
 *  `cyclic` holds the ids stuck in dependency cycles (sorted). */
export function kahnTopo(nodes: TaskNode[]): TopoResult {
  const open = nodes.filter((n) => !n.done);
  const ids = new Set(open.map((n) => n.id));
  const indeg = new Map<number, number>();
  const outs = new Map<number, number[]>();
  for (const n of open) { indeg.set(n.id, 0); outs.set(n.id, []); }
  for (const n of open) {
    const seen = new Set<number>();
    for (const b of n.blockedBy) {
      if (!ids.has(b) || b === n.id || seen.has(b)) continue;
      seen.add(b);
      outs.get(b)!.push(n.id);
      indeg.set(n.id, indeg.get(n.id)! + 1);
    }
  }
  // deterministic: always pop the smallest available id
  const avail = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort((a, b) => a - b);
  const order: number[] = [];
  while (avail.length) {
    const id = avail.shift()!;
    order.push(id);
    for (const m of (outs.get(id) || []).sort((a, b) => a - b)) {
      const d = indeg.get(m)! - 1;
      indeg.set(m, d);
      if (d === 0) {
        const at = avail.findIndex((x) => x > m);
        if (at === -1) avail.push(m); else avail.splice(at, 0, m);
      }
    }
  }
  const cyclic = [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id).sort((a, b) => a - b);
  return { order, cyclic };
}

/** Unit-duration critical chain: longest path (in tasks) through the DAG.
 *  Cyclic nodes are excluded — they can't be scheduled. Returns task ids
 *  from first to last. Empty when there are no open tasks. */
export function criticalChain(nodes: TaskNode[]): number[] {
  const { order, cyclic } = kahnTopo(nodes);
  const cyc = new Set(cyclic);
  const dag = order.filter((id) => !cyc.has(id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dist = new Map<number, number>();
  const prev = new Map<number, number | null>();
  for (const id of dag) {
    const n = byId.get(id)!;
    let best = 0, bestPrev: number | null = null;
    const blockers = [...new Set(n.blockedBy)].filter((b) => dist.has(b)).sort((a, b) => a - b);
    for (const b of blockers) {
      const d = dist.get(b)! + 1;
      if (d > best) { best = d; bestPrev = b; }
    }
    dist.set(id, best);
    prev.set(id, bestPrev);
  }
  if (!dag.length) return [];
  let end = dag[0];
  for (const id of dag) {
    if (dist.get(id)! > dist.get(end)! || (dist.get(id) === dist.get(end) && id < end)) end = id;
  }
  const chain: number[] = [];
  for (let cur: number | null = end; cur !== null; cur = prev.get(cur) ?? null) chain.unshift(cur);
  return chain;
}

export interface BlockerInfo { task: TaskNode; blockers: TaskNode[] }

/** For each open task of the deal that has open blockers: the task plus its
 *  open-blocker frontier (transitive blockers that are themselves unblocked).
 *  Ready tasks and blocker-less tasks are omitted. */
export function blockingFrontier(nodes: TaskNode[], dealTaskIds: Set<number>): BlockerInfo[] {
  const open = nodes.filter((n) => !n.done);
  const byId = new Map(open.map((n) => [n.id, n]));
  const openBlockers = (n: TaskNode): TaskNode[] =>
    [...new Set(n.blockedBy)].filter((b) => byId.has(b)).map((b) => byId.get(b)!).sort((a, b) => a.id - b.id);
  // frontier(t): open blockers reachable from t that have no open blockers
  const frontier = (t: TaskNode): TaskNode[] => {
    const out = new Map<number, TaskNode>();
    const stack = openBlockers(t);
    const seen = new Set<number>();
    while (stack.length) {
      const b = stack.pop()!;
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const bb = openBlockers(b);
      if (!bb.length) out.set(b.id, b);
      else stack.push(...bb);
    }
    return [...out.values()].sort((a, b) => a.id - b.id);
  };
  const infos: BlockerInfo[] = [];
  for (const n of open) {
    if (!dealTaskIds.has(n.id)) continue;
    const f = frontier(n);
    if (f.length) infos.push({ task: n, blockers: f });
  }
  infos.sort((a, b) => a.task.id - b.task.id);
  return infos;
}

/** Open tasks of the deal with no open blockers — "ready now". */
export function readyTasks(nodes: TaskNode[], dealTaskIds: Set<number>): TaskNode[] {
  const open = nodes.filter((n) => !n.done);
  const byId = new Map(open.map((n) => [n.id, n]));
  return open
    .filter((n) => dealTaskIds.has(n.id))
    .filter((n) => ![...new Set(n.blockedBy)].some((b) => byId.has(b)))
    .sort((a, b) => a.id - b.id);
}

/** Subgraph of seed tasks plus every transitive open blocker (for
 *  deal-scoped analysis when blockers live on other deals). */
export function taskSubgraph(nodes: TaskNode[], seedIds: Set<number>): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<number>();
  const stack = [...seedIds].sort((a, b) => a - b);
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    const n = byId.get(id);
    if (!n || n.done) continue;
    keep.add(id);
    for (const b of n.blockedBy) if (!keep.has(b)) stack.push(b);
  }
  return nodes.filter((n) => keep.has(n.id));
}

// ---- reachability graph (P1b) -------------------------------------------------------
// Nodes: contact:<id> | company:<id> | deal:<id>. Undirected, labeled edges.

export type ReachKind = "contact" | "company" | "deal";
export interface ReachNode { kind: ReachKind; id: number; label: string }
export interface ReachStep { node: ReachNode; via: string } // via = edge label from previous node

export function nodeKey(kind: ReachKind, id: number): string {
  return `${kind}:${id}`;
}

export function buildReachGraph(contacts: Contact[], companies: Company[], deals: Deal[]): {
  nodes: Map<string, ReachNode>; adj: Map<string, { to: string; label: string }[]>;
} {
  const nodes = new Map<string, ReachNode>();
  const adj = new Map<string, { to: string; label: string }[]>();
  const addNode = (kind: ReachKind, id: number, label: string) => {
    const k = nodeKey(kind, id);
    if (!nodes.has(k)) { nodes.set(k, { kind, id, label }); adj.set(k, []); }
  };
  const link = (a: string, b: string, label: string) => {
    adj.get(a)!.push({ to: b, label });
    adj.get(b)!.push({ to: a, label });
  };
  for (const c of companies) addNode("company", c.id, c.name);
  for (const c of contacts) {
    addNode("contact", c.id, c.name);
    if (c.company_id) {
      const ck = nodeKey("company", c.company_id);
      if (nodes.has(ck)) link(nodeKey("contact", c.id), ck, "works at");
    }
  }
  for (const d of deals) {
    if (String(d.stage).startsWith("closed_")) continue;
    addNode("deal", d.id, d.title);
    const dk = nodeKey("deal", d.id);
    if (d.company_id && nodes.has(nodeKey("company", d.company_id)))
      link(dk, nodeKey("company", d.company_id), "deal with");
    if (d.contact_id && nodes.has(nodeKey("contact", d.contact_id)))
      link(dk, nodeKey("contact", d.contact_id), "contact on deal");
  }
  for (const [, edges] of adj) edges.sort((a, b) => a.to.localeCompare(b.to));
  return { nodes, adj };
}

/** BFS shortest path, cap 4 hops. Returns steps from (excluding source) to
 *  target, each with the edge label that got there. Null when unreachable
 *  within the cap. */
export function bfsPath(
  adj: Map<string, { to: string; label: string }[]>,
  nodes: Map<string, ReachNode>,
  from: string, to: string, maxHops = 4,
): ReachStep[] | null {
  if (from === to) return [];
  if (!adj.has(from) || !adj.has(to)) return null;
  const prev = new Map<string, { from: string; label: string }>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur) || []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        prev.set(e.to, { from: cur, label: e.label });
        if (e.to === to) {
          const steps: ReachStep[] = [];
          for (let k: string | undefined = to; k && k !== from; k = prev.get(k)?.from) {
            const p = prev.get(k)!;
            steps.unshift({ node: nodes.get(k)!, via: p.label });
          }
          return steps;
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return null;
}

// ---- value-weighted PageRank (P1c) ----------------------------------------------------
// Nodes: companies + contacts. Undirected weighted edges:
//   deal <-> company : the deal's open value (rank flows toward money)
//   deal <-> contact : 1 (contact on the deal)
//   contact <-> company : 1 (works at)
// Deals participate in the walk but only companies/contacts are ranked.

export interface RankNode { kind: "company" | "contact"; id: number; label: string }
export interface RankResult {
  rank: Map<string, number>;
  nodes: Map<string, RankNode>;
  /** share of each node's rank arriving over deal-value edges (0..1) */
  dealShare: Map<string, number>;
  openDealsByNode: Map<string, Set<number>>;
  companiesByContact: Map<string, Set<number>>;
}

export function pageRank(
  companies: Company[], contacts: Contact[], deals: Deal[],
  iterations = 30, damping = 0.85,
): RankResult {
  const nodes = new Map<string, RankNode>();
  const adj = new Map<string, { to: string; w: number; isDealEdge: boolean }[]>();
  const add = (kind: "company" | "contact", id: number, label: string): string => {
    const k = nodeKey(kind, id);
    if (!nodes.has(k)) { nodes.set(k, { kind, id, label }); adj.set(k, []); }
    return k;
  };
  const link = (a: string, b: string, w: number, isDealEdge: boolean) => {
    if (!nodes.has(a) || !nodes.has(b)) return;
    adj.get(a)!.push({ to: b, w, isDealEdge });
    adj.get(b)!.push({ to: a, w, isDealEdge });
  };
  const openDealsByNode = new Map<string, Set<number>>();
  const companiesByContact = new Map<string, Set<number>>();
  const track = (k: string, dealId: number) => {
    const s = openDealsByNode.get(k) || new Set<number>();
    s.add(dealId);
    openDealsByNode.set(k, s);
  };
  for (const c of companies) add("company", c.id, c.name);
  for (const c of contacts) {
    const k = add("contact", c.id, c.name);
    if (c.company_id && nodes.has(nodeKey("company", c.company_id))) {
      link(k, nodeKey("company", c.company_id), 1, false);
      const s = companiesByContact.get(k) || new Set<number>();
      s.add(c.company_id);
      companiesByContact.set(k, s);
    }
  }
  // Deal nodes are transient carriers: each open deal becomes a node with a
  // value-weighted edge to its company and a weight-1 edge to its contact.
  // Rank flows toward nodes adjacent to money.
  for (const d of deals) {
    if (String(d.stage).startsWith("closed_") || !(d.value > 0)) continue;
    const dk = `deal:${d.id}`;
    adj.set(dk, []);
    const ck = d.company_id ? nodeKey("company", d.company_id) : null;
    const tk = d.contact_id ? nodeKey("contact", d.contact_id) : null;
    if (ck && nodes.has(ck)) {
      adj.get(dk)!.push({ to: ck, w: d.value, isDealEdge: true });
      adj.get(ck)!.push({ to: dk, w: d.value, isDealEdge: true });
      track(ck, d.id);
    }
    if (tk && nodes.has(tk)) {
      adj.get(dk)!.push({ to: tk, w: 1, isDealEdge: true });
      adj.get(tk)!.push({ to: dk, w: 1, isDealEdge: true });
      track(tk, d.id);
      if (ck && nodes.has(ck)) {
        const s = companiesByContact.get(tk) || new Set<number>();
        s.add(d.company_id!);
        companiesByContact.set(tk, s);
        track(ck, d.id);
      }
    }
  }
  // contact <-> company edges (employment)
  for (const c of contacts) {
    const k = nodeKey("contact", c.id);
    if (c.company_id && nodes.has(nodeKey("company", c.company_id))) {
      const ck = nodeKey("company", c.company_id);
      if (!adj.get(k)!.some((e) => e.to === ck)) link(k, ck, 1, false);
    }
  }

  const all = [...nodes.keys(), ...[...adj.keys()].filter((k) => k.startsWith("deal:"))].sort();
  const outW = new Map<string, number>();
  for (const k of all) outW.set(k, (adj.get(k) || []).reduce((s, e) => s + e.w, 0));
  let rank = new Map(all.map((k) => [k, 1 / all.length]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const k of all) {
      let acc = (1 - damping) / all.length;
      for (const e of adj.get(k) || []) {
        const ow = outW.get(e.to) || 0;
        if (ow > 0) acc += damping * rank.get(e.to)! * (e.w / ow);
      }
      next.set(k, acc);
    }
    rank = next;
  }
  // dealShare: fraction of rank arriving over deal-value-weighted edges
  const dealShare = new Map<string, number>();
  for (const k of nodes.keys()) {
    let dealPart = 0, total = 0;
    for (const e of adj.get(k) || []) {
      const ow = outW.get(e.to) || 0;
      if (ow <= 0) continue;
      const contrib = damping * rank.get(e.to)! * (e.w / ow);
      total += contrib;
      if (e.isDealEdge && e.w > 1) dealPart += contrib;
    }
    dealShare.set(k, total > 0 ? dealPart / total : 0);
  }
  // propagate open-deal sets through company membership for contacts
  for (const [ck] of nodes) {
    if (!ck.startsWith("contact:")) continue;
    const comps = companiesByContact.get(ck) || new Set<number>();
    const mine = openDealsByNode.get(ck) || new Set<number>();
    for (const e of adj.get(ck) || []) {
      if (e.to.startsWith("company:")) {
        for (const d of openDealsByNode.get(e.to) || []) mine.add(d);
      }
    }
    void comps;
    openDealsByNode.set(ck, mine);
  }
  return { rank, nodes, dealShare, openDealsByNode, companiesByContact };
}

/** Top-N companies by rank with decomposition lines. */
export function topCompanies(r: RankResult, n: number): { node: RankNode; score: number; openValue: number; dealCount: number; dealPct: number }[] {
  const rows: { node: RankNode; score: number; openValue: number; dealCount: number; dealPct: number }[] = [];
  for (const [k, node] of r.nodes) {
    if (node.kind !== "company") continue;
    rows.push({
      node, score: r.rank.get(k) || 0,
      openValue: 0, // filled by caller from deals when needed
      dealCount: (r.openDealsByNode.get(k) || new Set()).size,
      dealPct: Math.round((r.dealShare.get(k) || 0) * 100),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.node.id - b.node.id);
  return rows.slice(0, n);
}

/** Top-N contacts by rank: the multi-account connectors. */
export function topContacts(r: RankResult, n: number): { node: RankNode; score: number; dealCount: number; companyCount: number }[] {
  const rows: { node: RankNode; score: number; dealCount: number; companyCount: number }[] = [];
  for (const [k, node] of r.nodes) {
    if (node.kind !== "contact") continue;
    rows.push({
      node, score: r.rank.get(k) || 0,
      dealCount: (r.openDealsByNode.get(k) || new Set()).size,
      companyCount: (r.companiesByContact.get(k) || new Set()).size,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.node.id - b.node.id);
  return rows.slice(0, n);
}

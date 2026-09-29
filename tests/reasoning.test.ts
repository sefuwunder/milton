// reasoning.test.ts — Phase 1 pure algorithms: Kahn topo, critical chain,
// cycles, blocking frontier, BFS reach, value-weighted PageRank.
import { describe, test, expect } from "bun:test";
import {
  kahnTopo, criticalChain, blockingFrontier, readyTasks, taskSubgraph, toTaskNode,
  buildReachGraph, bfsPath, nodeKey, pageRank, topCompanies, topContacts,
  type TaskNode,
} from "/home/hatch/workspace/your_files/milton/src/reasoning";

const N = (id: number, blockedBy: number[] = [], done = false, title = `t${id}`, owner = ""): TaskNode =>
  ({ id, title, owner, done, blockedBy });

// ---- Kahn -------------------------------------------------------------------------
describe("kahnTopo", () => {
  test("diamond DAG orders deterministically", () => {
    const r = kahnTopo([N(1), N(2, [1]), N(3, [1]), N(4, [2, 3])]);
    expect(r.order).toEqual([1, 2, 3, 4]);
    expect(r.cyclic).toEqual([]);
  });
  test("done tasks and dangling blockers are ignored", () => {
    const r = kahnTopo([N(1, [], true), N(2, [1]), N(3, [99])]);
    expect(r.order).toEqual([2, 3]);
    expect(r.cyclic).toEqual([]);
  });
  test("self-loop and duplicates don't corrupt", () => {
    const r = kahnTopo([N(1, [1, 2, 2]), N(2)]);
    expect(r.order).toEqual([2, 1]);
  });
  test("cycle members are reported, rest still ordered", () => {
    const r = kahnTopo([N(1, [2]), N(2, [1]), N(3)]);
    expect(r.order).toEqual([3]);
    expect(r.cyclic).toEqual([1, 2]);
  });
  test("empty input", () => {
    expect(kahnTopo([])).toEqual({ order: [], cyclic: [] });
  });
});

// ---- critical chain ------------------------------------------------------------------
describe("criticalChain", () => {
  test("longest path wins, ties break on smaller id", () => {
    // 1->2->4 and 1->3->4 are both length 3; chain picks [1,2,4]
    const c = criticalChain([N(1), N(2, [1]), N(3, [1]), N(4, [2, 3])]);
    expect(c).toEqual([1, 2, 4]);
  });
  test("single chain", () => {
    expect(criticalChain([N(5, [6]), N(6)])).toEqual([6, 5]);
  });
  test("cyclic nodes excluded", () => {
    expect(criticalChain([N(1, [2]), N(2, [1]), N(3)])).toEqual([3]);
  });
  test("no open tasks -> empty", () => {
    expect(criticalChain([N(1, [], true)])).toEqual([]);
  });
});

// ---- frontier / ready ------------------------------------------------------------------
describe("blockingFrontier + readyTasks", () => {
  // deal tasks: 1 (open, unblocked), 2 (blocked by 1), 3 (blocked by 2), 4 (done)
  const nodes = [N(1, [], false, "Sign SOW", "Dana"), N(2, [1], false, "Ship v2"), N(3, [2], false, "Launch", "Sam"), N(4, [1], true, "Old")];
  const dealIds = new Set([1, 2, 3, 4]);
  test("frontier lists transitive open blockers that are themselves unblocked", () => {
    const f = blockingFrontier(nodes, dealIds);
    expect(f.map((x) => x.task.id)).toEqual([2, 3]);
    // task 3's frontier is task 1 (task 2 is itself blocked)
    expect(f.find((x) => x.task.id === 3)!.blockers.map((b) => b.id)).toEqual([1]);
    expect(f.find((x) => x.task.id === 2)!.blockers.map((b) => b.id)).toEqual([1]);
  });
  test("readyTasks are open deal tasks with no open blockers", () => {
    expect(readyTasks(nodes, dealIds).map((t) => t.id)).toEqual([1]);
  });
  test("tasks outside the deal are ignored", () => {
    expect(blockingFrontier(nodes, new Set([99]))).toEqual([]);
  });
  test("taskSubgraph pulls in transitive blockers", () => {
    const other = N(9, [], false, "Other deal task");
    const sub = taskSubgraph([...nodes, other], new Set([3]));
    expect(sub.map((n) => n.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
  test("toTaskNode maps blocked_by entries", () => {
    const t: any = { id: 7, title: "x", owner: "Bo", done: 0, blocked_by: [{ id: 1, title: "a", done: 0 }, { id: 2, title: "b", done: 1 }] };
    expect(toTaskNode(t)).toEqual({ id: 7, title: "x", owner: "Bo", done: false, blockedBy: [1, 2] });
  });
});

// ---- BFS reach ----------------------------------------------------------------------------
describe("bfsPath", () => {
  const companies = [
    { id: 1, name: "Acme", industry: "", website: "", notes: "" },
    { id: 2, name: "Beta", industry: "", website: "", notes: "" },
  ];
  const contacts = [
    { id: 1, name: "Tom", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
    { id: 2, name: "Dana", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
    { id: 3, name: "Zed", email: "", phone: "", company_id: 2, company_name: "Beta", title: "", notes: "" },
  ];
  const deals: any[] = [
    { id: 1, title: "Big", company_id: 1, contact_id: 1, value: 1000, stage: "negotiation", probability: 1, expected_close: "", owner: "", created_at: "", updated_at: "" },
  ];
  const g = buildReachGraph(contacts as any, companies as any, deals as any);
  test("two-hop path through a shared company", () => {
    const p = bfsPath(g.adj, g.nodes, nodeKey("contact", 1), nodeKey("contact", 2))!;
    expect(p).not.toBeNull();
    expect(p.map((s) => s.node.label)).toEqual(["Acme", "Dana"]);
    expect(p[0].via).toBe("works at");
  });
  test("three-hop path via deal", () => {
    // Zed(Beta) -> Tom: no link; Tom -> Big deal -> Acme -> Dana
    const p = bfsPath(g.adj, g.nodes, nodeKey("contact", 1), nodeKey("deal", 1))!;
    expect(p!.map((s) => s.node.label)).toEqual(["Big"]);
    expect(p![0].via).toBe("contact on deal");
  });
  test("unreachable within cap returns null", () => {
    expect(bfsPath(g.adj, g.nodes, nodeKey("contact", 3), nodeKey("contact", 1))).toBeNull();
  });
  test("same node returns empty path", () => {
    expect(bfsPath(g.adj, g.nodes, nodeKey("contact", 1), nodeKey("contact", 1))).toEqual([]);
  });
  test("closed deals are excluded from the graph", () => {
    expect(g.nodes.has(nodeKey("deal", 1))).toBe(true);
    const g2 = buildReachGraph(contacts as any, companies as any,
      [{ ...deals[0], stage: "closed_won" }] as any);
    expect(g2.nodes.has(nodeKey("deal", 1))).toBe(false);
  });
});

// ---- PageRank ------------------------------------------------------------------------------
describe("pageRank", () => {
  const companies = [
    { id: 1, name: "Acme", industry: "", website: "", notes: "" },
    { id: 2, name: "Beta", industry: "", website: "", notes: "" },
    { id: 3, name: "Gamma", industry: "", website: "", notes: "" },
  ];
  const contacts: any[] = [
    { id: 1, name: "Tom", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
    { id: 2, name: "Dana", email: "", phone: "", company_id: 1, company_name: "Acme", title: "", notes: "" },
    { id: 3, name: "Zed", email: "", phone: "", company_id: 2, company_name: "Beta", title: "", notes: "" },
    // Wren touches two companies: employed at Beta, contact on Acme's deal
    { id: 4, name: "Wren", email: "", phone: "", company_id: 2, company_name: "Beta", title: "", notes: "" },
  ];
  const deals: any[] = [
    { id: 1, title: "A1", company_id: 1, contact_id: 4, value: 100000, stage: "negotiation", probability: 1, expected_close: "", owner: "", created_at: "", updated_at: "" },
    { id: 2, title: "B1", company_id: 2, contact_id: 3, value: 10000, stage: "proposal", probability: 1, expected_close: "", owner: "", created_at: "", updated_at: "" },
    { id: 3, title: "Cold", company_id: 3, contact_id: null, value: 5000, stage: "closed_won", probability: 1, expected_close: "", owner: "", created_at: "", updated_at: "" },
  ];
  test("ranks money-adjacent companies first, with deal-driven decomposition", () => {
    const r = pageRank(companies as any, contacts, deals);
    const tops = topCompanies(r, 3);
    expect(tops[0].node.label).toBe("Acme");
    expect(tops[0].dealPct).toBeGreaterThan(50);
    // closed deal value does not flow
    expect(tops.find((t) => t.node.label === "Gamma")!.dealCount).toBe(0);
  });
  test("champions surface multi-account connectors", () => {
    const r = pageRank(companies as any, contacts, deals);
    const tops = topContacts(r, 4);
    const wren = tops.find((t) => t.node.label === "Wren")!;
    expect(wren.companyCount).toBe(2);
    expect(wren.dealCount).toBeGreaterThanOrEqual(2);
  });
  test("deterministic: same input, same order", () => {
    const a = topCompanies(pageRank(companies as any, contacts, deals), 3).map((t) => t.node.id);
    const b = topCompanies(pageRank(companies as any, contacts, deals), 3).map((t) => t.node.id);
    expect(a).toEqual(b);
  });
  test("empty graph ranks nothing", () => {
    const r = pageRank([], [], []);
    expect(topCompanies(r, 5)).toEqual([]);
    expect(topContacts(r, 5)).toEqual([]);
  });
});

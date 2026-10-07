// A generated graph of about the size of the real one, for tests and for frame-rate checks. It uses fixed
// pseudo-random numbers so that two runs give the same graph.
import type { Family, GraphEdge, GraphFile, GraphNode, Sensitivity } from "@shared/types";

const CLASSES: { type: string; family: Family; share: number }[] = [
  { type: "Rule", family: "instruction", share: 0.4 },
  { type: "Section", family: "instruction", share: 0.1 },
  { type: "RuleFile", family: "instruction", share: 0.01 },
  { type: "ReferenceFile", family: "instruction", share: 0.01 },
  { type: "TaskType", family: "instruction", share: 0.005 },
  { type: "Agent", family: "machinery", share: 0.005 },
  { type: "Tool", family: "machinery", share: 0.04 },
  { type: "Hook", family: "machinery", share: 0.02 },
  { type: "MemoryFile", family: "record", share: 0.05 },
  { type: "OpenItem", family: "record", share: 0.1 },
  { type: "Project", family: "work", share: 0.02 },
  { type: "Deliverable", family: "work", share: 0.05 },
  { type: "Client", family: "world", share: 0.01 },
  { type: "Person", family: "world", share: 0.02 },
  { type: "Concept", family: "language", share: 0.15 },
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeGraph(nodeCount = 2500, edgeCount = 5000, seed = 7): GraphFile {
  const rand = rng(seed);
  const nodes: GraphNode[] = [];
  const sens: Sensitivity[] = ["public", "internal", "client-confidential"];
  CLASSES.forEach((c, ci) => {
    const n = Math.max(2, Math.round(nodeCount * c.share));
    for (let i = 0; i < n; i += 1) {
      const used = rand() < 0.5;
      nodes.push({
        id: `${c.type.toLowerCase()}:${ci}-${i}`,
        type: c.type,
        label: `${c.type} ${i}`,
        family: c.family,
        path: null,
        summary: null,
        date: null,
        status: null,
        sensitivity: sens[Math.floor(rand() * rand() * 3)],
        props: {},
        metrics: { uses: used ? Math.floor(rand() * 40) : 0, last_used: null, base_level: used ? rand() * 6 - 3 : null, degree: 0 },
      });
    }
  });
  const edges: GraphEdge[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    // Edges prefer a nearby index, so that the graph has the lobes a real one has.
    const a = Math.floor(rand() * nodes.length);
    const b = rand() < 0.7 ? Math.min(nodes.length - 1, a + 1 + Math.floor(rand() * 40)) : Math.floor(rand() * nodes.length);
    if (a === b) continue;
    edges.push({ s: nodes[a].id, r: "contains", t: nodes[b].id, w: 0.6, evidence: null });
    nodes[a].metrics.degree += 1;
    nodes[b].metrics.degree += 1;
  }
  const by_class: Record<string, number> = {};
  for (const n of nodes) by_class[n.type] = (by_class[n.type] ?? 0) + 1;
  return {
    v: 1,
    built: "2026-10-05T00:00:00Z",
    source: { claude_home: "", projects_root: "", git: null, host: "test" },
    classes: [],
    relations: [{ id: "contains", label: "contains", inverse_label: "is part of", weight: 0.6, reverse_weight: 0.35 }],
    nodes,
    edges,
    schemes: [],
    health: { errors: 0, warnings: 0, infos: 0, checked: "2026-10-05T00:00:00Z" },
    stats: { nodes: nodes.length, edges: edges.length, by_class },
  };
}

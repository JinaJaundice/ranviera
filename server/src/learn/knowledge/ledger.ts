// Read time merge of the proposition and argument ledgers, birth sources,
// clusters and the derived canvas image. docs/CONTRACTS.md, "Proposition and
// argument ledgers". The Python harvester and the skill repeat these rules, and
// kg/tests/fixtures/knowledge/ holds the files that both sides test against.

import type { ChainLine, Cluster, NodeLine, ProvenancePoint } from "../../../../shared/learn/knowledge.ts";
import type { Sensitivity } from "../../../../shared/learn/sources.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isProvenance(v: unknown): v is ProvenancePoint[] {
  return Array.isArray(v) && v.every((p) => isObject(p) && typeof p.chatId === "string" && typeof p.messageId === "string");
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** A valid node line has string id, createdAt, name and statement, a provenance list and an alias list. */
export function isNodeLine(v: unknown): v is NodeLine {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.name === "string" &&
    typeof v.statement === "string" &&
    isProvenance(v.provenance) &&
    isStringList(v.aliases)
  );
}

/** A valid chain line has string id, createdAt and conclusion, a provenance list and a non empty premise list. */
export function isChainLine(v: unknown): v is ChainLine {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.conclusion === "string" &&
    isProvenance(v.provenance) &&
    isStringList(v.premises) &&
    v.premises.length > 0
  );
}

export function isCheckpointLine(v: unknown): v is { chatId: string; foldedAt: string } {
  return isObject(v) && typeof v.chatId === "string" && typeof v.foldedAt === "string";
}

export function isCoverageLine(v: unknown): v is { chatId: string; fp: string; tokens: number; foldedAt: string } {
  return (
    isObject(v) &&
    typeof v.chatId === "string" &&
    typeof v.fp === "string" &&
    typeof v.tokens === "number" &&
    typeof v.foldedAt === "string"
  );
}

export interface MergedNode {
  id: string;
  name: string;
  statement: string;
  aliases: string[];
  createdAt: string;
  provenance: ProvenancePoint[];
}

export interface LedgerChain {
  id: string;
  premises: string[];
  conclusion: string;
  createdAt: string;
  provenance: ProvenancePoint[];
  /** the chain key, for example n_a+n_b>n_c */
  key: string;
}

/** Union of provenance points by the exact pair, in first seen order. */
function unionProvenance(into: ProvenancePoint[], seen: Set<string>, more: ProvenancePoint[]): void {
  for (const p of more) {
    const k = JSON.stringify([p.chatId, p.messageId]);
    if (seen.has(k)) continue;
    seen.add(k);
    into.push({ chatId: p.chatId, messageId: p.messageId });
  }
}

/**
 * Node lines merge by id. The first line fixes name, statement and createdAt.
 * Every later line adds its statement and aliases as aliases, skipping empty
 * strings, the fixed statement and exact duplicates of an alias already held (so
 * that merging a merged result again changes nothing). A later name is ignored. Result order is the order in which ids first appear.
 */
export function mergeNodes(lines: NodeLine[]): MergedNode[] {
  const out = new Map<string, MergedNode>();
  const seenPoints = new Map<string, Set<string>>();
  for (const line of lines) {
    const held = out.get(line.id);
    if (!held) {
      const node: MergedNode = {
        id: line.id,
        name: line.name,
        statement: line.statement,
        aliases: [],
        createdAt: line.createdAt,
        provenance: [],
      };
      for (const a of line.aliases) if (a !== "" && a !== node.statement && !node.aliases.includes(a)) node.aliases.push(a);
      const seen = new Set<string>();
      unionProvenance(node.provenance, seen, line.provenance);
      out.set(line.id, node);
      seenPoints.set(line.id, seen);
      continue;
    }
    for (const a of [line.statement, ...line.aliases]) {
      if (a !== "" && a !== held.statement && !held.aliases.includes(a)) held.aliases.push(a);
    }
    unionProvenance(held.provenance, seenPoints.get(line.id) as Set<string>, line.provenance);
  }
  return [...out.values()];
}

/** The chain key: sorted premise ids joined by a plus sign, a greater than sign, then the conclusion. */
export function chainKey(premises: string[], conclusion: string): string {
  return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** Chain lines merge by key. The first line fixes id, premise order and createdAt, and provenance is the union. */
export function mergeChains(lines: ChainLine[]): LedgerChain[] {
  const out = new Map<string, LedgerChain>();
  const seenPoints = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = chainKey(line.premises, line.conclusion);
    const held = out.get(key);
    if (!held) {
      const chain: LedgerChain = {
        id: line.id,
        premises: [...line.premises],
        conclusion: line.conclusion,
        createdAt: line.createdAt,
        provenance: [],
        key,
      };
      const seen = new Set<string>();
      unionProvenance(chain.provenance, seen, line.provenance);
      out.set(key, chain);
      seenPoints.set(key, seen);
      continue;
    }
    unionProvenance(held.provenance, seenPoints.get(key) as Set<string>, line.provenance);
  }
  return [...out.values()];
}

/** The birth source: the chatId of the first surviving provenance point, or null. */
export function birthSource(provenance: ProvenancePoint[]): string | null {
  return provenance.length > 0 ? provenance[0].chatId : null;
}

/** The file name with only its last extension removed, from the label of a source. */
export function fileLabel(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export const MIN_CLUSTER_SIZE = 3;

/** The junction node of a chain with several premises. The chain id is the node id. */
export const JUNCTION_NAME = "⇒";

export interface DerivedView {
  nodes: { id: string; name: string; statement: string; kind: "proposition" | "junction" }[];
  edges: { from: string; to: string }[];
  logicalEdges: { from: string; to: string }[];
  impLinks: { id: string; premises: string[]; conclusion: string }[];
  /** the chains whose conclusion and premises all exist */
  live: LedgerChain[];
}

/**
 * The canvas image. A chain whose conclusion or any premise is missing is
 * skipped. A single premise is one arrow, and several premises meet at a
 * junction whose id is the chain id.
 */
export function deriveView(nodes: MergedNode[], chains: LedgerChain[]): DerivedView {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const view: DerivedView = {
    nodes: nodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement, kind: "proposition" as const })),
    edges: [],
    logicalEdges: [],
    impLinks: [],
    live: [],
  };
  const logicalSeen = new Set<string>();
  for (const c of chains) {
    if (!byId.has(c.conclusion) || !c.premises.every((p) => byId.has(p))) continue;
    view.live.push(c);
    for (const p of c.premises) {
      const k = `${p}\u0000${c.conclusion}`;
      if (logicalSeen.has(k)) continue;
      logicalSeen.add(k);
      view.logicalEdges.push({ from: p, to: c.conclusion });
    }
    if (c.premises.length === 1) {
      view.edges.push({ from: c.premises[0], to: c.conclusion });
      continue;
    }
    const names = [...c.premises].sort().map((p) => byId.get(p)?.name ?? p);
    const conclusionName = byId.get(c.conclusion)?.name ?? c.conclusion;
    view.nodes.push({
      id: c.id,
      name: JUNCTION_NAME,
      statement: `${names.join(", ")} → ${conclusionName}`,
      kind: "junction",
    });
    for (const p of c.premises) view.edges.push({ from: p, to: c.id });
    view.edges.push({ from: c.id, to: c.conclusion });
    view.impLinks.push({ id: c.id, premises: [...c.premises], conclusion: c.conclusion });
  }
  return view;
}

/**
 * Clusters: a birth source with at least 3 propositions. Members are sorted by
 * id, and groups by size descending and then source id. A junction joins the
 * cluster of the majority of its premises after the size filter, so it never
 * revives a small cluster. On a tie it joins the cluster of the chain's own
 * first provenance source, and when that is missing the first winner by id.
 */
export function deriveClusters(
  nodes: MergedNode[],
  junctions: LedgerChain[],
  labelOf: (sourceId: string) => string | null,
): Cluster[] {
  const birth = new Map<string, string | null>();
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const b = birthSource(n.provenance);
    birth.set(n.id, b);
    if (b === null) continue;
    const list = groups.get(b) ?? [];
    list.push(n.id);
    groups.set(b, list);
  }
  const kept = [...groups.entries()]
    .filter(([, m]) => m.length >= MIN_CLUSTER_SIZE)
    .map(([id, m]) => ({ id, members: [...m].sort() }))
    .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const clusters: Cluster[] = kept.map((g) => ({ id: g.id, label: labelOf(g.id), members: g.members }));
  const index = new Map(clusters.map((c) => [c.id, c]));
  for (const j of [...junctions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (j.premises.length < 2) continue;
    const votes = new Map<string, number>();
    for (const p of j.premises) {
      const b = birth.get(p) ?? null;
      if (b !== null) votes.set(b, (votes.get(b) ?? 0) + 1);
    }
    if (votes.size === 0) continue;
    const top = Math.max(...votes.values());
    const winners = [...votes.entries()].filter(([, n]) => n === top).map(([id]) => id).sort();
    let home: string = winners[0];
    if (winners.length > 1) {
      const own = birthSource(j.provenance);
      if (own !== null) home = own;
    }
    index.get(home)?.members.push(j.id);
  }
  return clusters;
}

export const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, "client-confidential": 2 };

export function maxSensitivity(list: Sensitivity[], fallback: Sensitivity = "internal"): Sensitivity {
  if (list.length === 0) return fallback;
  return list.reduce((a, b) => (SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a));
}

export function isSensitivity(v: unknown): v is Sensitivity {
  return v === "public" || v === "internal" || v === "client-confidential";
}

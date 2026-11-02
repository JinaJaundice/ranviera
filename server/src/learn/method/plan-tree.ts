// The plan tree and the position on it. The tree holds structure only. Status
// is derived from the record and never stored: the current node is the node of
// the newest graded teach question call, the visited nodes are the earlier
// stays, and nothing is current before the first tagged question.
import type { NativeMessage, NodeStatus, PlanEdge, PlanNode, PlanTree } from "../../../../shared/learn/index.ts";
import { findCycle, SLUG } from "./mermaid.ts";
import { isFailedAssistant, toolCallsOf } from "../runtime/scans.ts";

export type TreeResult = { ok: true; tree: PlanTree } | { ok: false; problems: string[] };

/** Builds a tree and refuses a duplicate id, an unknown endpoint, a self loop, a duplicate edge and a cycle. Inputs are not changed. */
export function createPlanTree(nodes: PlanNode[], edges: PlanEdge[], version = 1): TreeResult {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || !SLUG.test(n.id) || typeof n.title !== "string" || !n.title.trim()) {
      problems.push(`A node needs a slug identifier and a title (got ${JSON.stringify(n?.id)}).`);
      continue;
    }
    if (ids.has(n.id)) problems.push(`The node identifier ${n.id} is used twice.`);
    ids.add(n.id);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e?.from) || !ids.has(e?.to)) {
      problems.push(`The edge ${e?.from} to ${e?.to} names a node that is not in the map.`);
      continue;
    }
    if (e.from === e.to) {
      problems.push(`The node ${e.from} points to itself.`);
      continue;
    }
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) problems.push(`The edge ${e.from} to ${e.to} appears twice.`);
    seen.add(key);
  }
  if (problems.length === 0) {
    const cycle = findCycle([...ids], edges);
    if (cycle) problems.push(`The edges form a cycle (${cycle.join(" to ")}).`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    tree: {
      nodes: nodes.map((n) => ({ ...n, title: n.title.trim() })),
      edges: edges.map((e) => ({ from: e.from, to: e.to })),
      version,
    },
  };
}

/** A teach question call that names a node. Failed generations never count, and a call of any result state does. */
const TAGGED = new Set(["quiz", "explain"]);

export function taggedNodeIds(messages: NativeMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || isFailedAssistant(m)) continue;
    for (const call of toolCallsOf(m)) {
      const node = call.arguments.nodeId;
      if (TAGGED.has(call.name) && typeof node === "string" && node) out.push(node);
    }
  }
  return out;
}

export interface Position {
  current: string | null;
  /** earlier stays in order, without repeats. A revisited node appears here and is also current. */
  visited: string[];
  statuses: Record<string, NodeStatus>;
}

/** Derives the position against the tree as it stands now, so a rewritten map derives anew. */
export function derivePosition(messages: NativeMessage[], tree: PlanTree | undefined | null): Position {
  const known = new Set((tree?.nodes ?? []).map((n) => n.id));
  const stays: string[] = [];
  for (const id of taggedNodeIds(messages)) {
    if (!known.has(id)) continue;
    if (stays[stays.length - 1] !== id) stays.push(id);
  }
  const current = stays.length ? stays[stays.length - 1] : null;
  const earlier = stays.slice(0, -1);
  const visited = [...new Set(earlier)];
  const statuses: Record<string, NodeStatus> = {};
  for (const n of tree?.nodes ?? []) {
    statuses[n.id] = n.id === current ? "current" : visited.includes(n.id) ? "visited" : "upcoming";
  }
  return { current, visited, statuses };
}

/** The `plan-block` details of CONTRACTS "Messages, markers and answer details". */
export function planBlockDetails(planCallId: string, tree: PlanTree, messages: NativeMessage[], at: string) {
  const position = derivePosition(messages, tree);
  return {
    planCallId,
    kind: "full" as const,
    at,
    current: position.current,
    nodes: tree.nodes.map((n) => ({ id: n.id, title: n.title, status: position.statuses[n.id] })),
    edges: tree.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

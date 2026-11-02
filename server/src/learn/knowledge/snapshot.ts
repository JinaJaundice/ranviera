// The graph snapshot and the derived metrics. The snapshot is built from the
// ledgers at read time and filtered by sensitivity. The metrics are derived from
// outcomes and are never written to the ledgers. docs/CONTRACTS.md, "Derived
// metrics" and "Request and response shapes".

import type {
  ChainLine,
  GraphSnapshot,
  KnowledgeMetrics,
  MergedChain,
  NodeLine,
  PropositionView,
  SourceRecord,
} from "../../../../shared/learn/knowledge.ts";
import type { OrganizationFile, OutcomeLine, Sensitivity } from "../../../../shared/learn/sources.ts";
import {
  SENSITIVITY_RANK,
  deriveClusters,
  deriveView,
  fileLabel,
  maxSensitivity,
  mergeChains,
  mergeNodes,
} from "./ledger.ts";
import type { PositionMap } from "./positions.ts";

export const CALIBRATION_MINIMUM = 5;
export const CALIBRATION_BAND = 0.15;

const GENTLE_RUNGS = new Set<string | null>([null, "R0", "R1"]);

export function isOutcomeLine(v: unknown): v is OutcomeLine {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    Array.isArray(o.target) &&
    o.target.every((t) => typeof t === "string") &&
    (o.correct === null || typeof o.correct === "boolean") &&
    (o.source === "choice" || o.source === "practice")
  );
}

/** Outcomes grouped by proposition, each list ordered by time and then by line order. */
export function groupOutcomes(outcomes: OutcomeLine[]): Map<string, OutcomeLine[]> {
  const indexed = outcomes.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => (a.o.at < b.o.at ? -1 : a.o.at > b.o.at ? 1 : a.i - b.i));
  const out = new Map<string, OutcomeLine[]>();
  for (const { o } of indexed) {
    for (const t of new Set(o.target)) (out.get(t) ?? out.set(t, []).get(t)!).push(o);
  }
  return out;
}

/** support, held and calibration of one proposition. Thresholds are Cortex proposals in the contracts. */
export function computeMetrics(provenance: { chatId: string }[], outcomes: OutcomeLine[]): KnowledgeMetrics {
  const support = new Set(provenance.map((p) => p.chatId)).size;
  if (outcomes.length === 0) return { support, held: "unknown", lastTested: null, calibration: null };
  const newest2 = outcomes.slice(-2);
  const newest3 = outcomes.slice(-3);
  const held =
    outcomes.length >= 2 &&
    newest2.every((o) => o.correct === true && GENTLE_RUNGS.has(o.rung ?? null)) &&
    newest3.every((o) => o.missClass !== "structural");
  const rated = outcomes.filter((o) => o.source === "choice" && typeof o.confidence === "number");
  let calibration: KnowledgeMetrics["calibration"] = null;
  if (rated.length >= CALIBRATION_MINIMUM) {
    const meanConfidence = rated.reduce((s, o) => s + (o.confidence as number), 0) / rated.length / 100;
    const accuracy = rated.filter((o) => o.correct === true).length / rated.length;
    const gap = meanConfidence - accuracy;
    const band = Math.abs(gap) <= CALIBRATION_BAND ? "calibrated" : gap > 0 ? "overconfident" : "underconfident";
    calibration = { n: rated.length, meanConfidence, accuracy, gap, band };
  }
  return { support, held: held ? "held" : "shaky", lastTested: outcomes[outcomes.length - 1].at, calibration };
}

export interface SnapshotInput {
  nodeLines: NodeLine[];
  chainLines: ChainLine[];
  /** session id to its title */
  titles: Record<string, string>;
  sources: Record<string, SourceRecord>;
  organization: OrganizationFile;
  positions: PositionMap;
  outcomes: OutcomeLine[];
  /** the sensitivity of a session or source, from its root or its context */
  sensitivityOf: (id: string) => Sensitivity;
  /** drops everything above this sensitivity */
  max?: Sensitivity;
  revision: number;
}

export function buildSnapshot(input: SnapshotInput): GraphSnapshot {
  const limit = SENSITIVITY_RANK[input.max ?? "client-confidential"];
  const within = (s: Sensitivity): boolean => SENSITIVITY_RANK[s] <= limit;
  const sensitivityOfPoints = (points: { chatId: string }[]): Sensitivity =>
    maxSensitivity([...new Set(points.map((p) => p.chatId))].map((id) => input.sensitivityOf(id)));

  const grouped = groupOutcomes(input.outcomes);
  const merged = mergeNodes(input.nodeLines);
  const nodes = merged.filter((n) => within(sensitivityOfPoints(n.provenance)));
  const keptIds = new Set(nodes.map((n) => n.id));
  const dropped = new Set(merged.filter((n) => !keptIds.has(n.id)).map((n) => n.id));
  // a chain that names a dropped proposition goes. One that names an id with no line stays in the stored truth but out of the image
  const chains = mergeChains(input.chainLines).filter(
    (c) => within(sensitivityOfPoints(c.provenance)) && !dropped.has(c.conclusion) && !c.premises.some((p) => dropped.has(p)),
  );
  const view = deriveView(nodes, chains);

  const sessions: Record<string, string> = {};
  for (const [id, title] of Object.entries(input.titles)) if (within(input.sensitivityOf(id))) sessions[id] = title;
  const fileSources: Record<string, string> = {};
  for (const [id, rec] of Object.entries(input.sources)) if (within(input.sensitivityOf(id))) fileSources[id] = rec.filePath;

  const labelOf = (id: string): string | null => {
    if (id in sessions) return sessions[id];
    if (id in fileSources) return input.organization.placements[id]?.name ?? fileLabel(fileSources[id]);
    return null;
  };

  const propositions: PropositionView[] = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    statement: n.statement,
    aliases: n.aliases,
    createdAt: n.createdAt,
    provenance: n.provenance,
    sensitivity: sensitivityOfPoints(n.provenance),
    metrics: computeMetrics(n.provenance, grouped.get(n.id) ?? []),
  }));
  const mergedChains: MergedChain[] = chains.map((c) => ({
    id: c.id,
    premises: c.premises,
    conclusion: c.conclusion,
    createdAt: c.createdAt,
    provenance: c.provenance,
    sensitivity: sensitivityOfPoints(c.provenance),
  }));

  const nodeSessions: Record<string, string[]> = {};
  for (const n of nodes) {
    const ids = [...new Set(n.provenance.map((p) => p.chatId))].filter((id) => id in sessions || id in fileSources);
    nodeSessions[n.id] = ids;
  }

  const visible = new Set(view.nodes.map((n) => n.id));
  const positions: PositionMap = {};
  for (const [id, p] of Object.entries(input.positions)) if (visible.has(id)) positions[id] = p;

  const snapshot: GraphSnapshot = {
    nodes: view.nodes,
    propositions,
    edges: view.edges,
    logicalEdges: view.logicalEdges,
    impLinks: view.impLinks,
    chains: mergedChains,
    sessions,
    fileSources,
    nodeSessions,
    clusters: deriveClusters(nodes, view.live, labelOf),
    revision: input.revision,
  };
  if (Object.keys(positions).length > 0) snapshot.positions = positions;
  return snapshot;
}

// Learning upgrade: proposition and argument ledgers, extraction records,
// layout and the graph snapshot. The source of truth is docs/CONTRACTS.md,
// section "Learning and knowledge (1 November 2026)", and a change is made
// there first.

import type { Sensitivity } from "../types.ts";
import type { CallUsage } from "./sessions.ts";

/** Proposition and argument ledgers: where a line came from. chatId is a chat_ id or a src_ id, messageId is "" for source level attribution. */
export interface ProvenancePoint {
  chatId: string;
  messageId: string;
}

/** Proposition and argument ledgers: one line of graph/nodes.jsonl. An id may repeat. */
export interface NodeLine {
  /** n_<12 hex> */
  id: string;
  /** short handle */
  name: string;
  /** one true, self contained proposition */
  statement: string;
  aliases: string[];
  createdAt: string;
  provenance: ProvenancePoint[];
}

/** Proposition and argument ledgers: one line of graph/chains.jsonl. */
export interface ChainLine {
  /** arg_<12 hex> */
  id: string;
  /** at least 1, used jointly */
  premises: string[];
  conclusion: string;
  createdAt: string;
  provenance: ProvenancePoint[];
}

/** Sources, checkpoints and coverage: one entry of graph/sources.json, an object keyed by id. */
export interface SourceRecord {
  /** src_<12 hex> */
  id: string;
  /** a label: "<root label>/<path relative to the root>" */
  filePath: string;
  importedAt: string;
  extractions?: ExtractionRunUsage[];
}

/** Sources, checkpoints and coverage: usage of one extraction run. */
export interface ExtractionRunUsage {
  /** milliseconds, strictly increasing, the idempotency key */
  startedAt: number;
  at: string;
  durationMs: number;
  /** absent when the run never merged */
  stats?: { nodes: number; chains: number; droppedChains?: number };
  stages: { extractor?: StageUsage; auditor?: StageUsage };
}

/** Sources, checkpoints and coverage: usage of one stage of a run. */
export interface StageUsage {
  /** provider:id */
  model: string;
  steps: CallUsage[];
}

/** Sources, checkpoints and coverage: a line of graph/sessions.jsonl, where chatId is a src_ id. */
export interface CheckpointLine {
  chatId: string;
  foldedAt: string;
}

/** Sources, checkpoints and coverage: a line of graph/coverage.jsonl. */
export interface CoverageLine {
  chatId: string;
  fp: string;
  tokens: number;
  foldedAt: string;
}

/** Positions and render settings: graph/positions.json. */
export interface PositionsFile {
  positions: Record<string, { x: number; y: number }>;
  updatedAt: string;
}

/** Positions and render settings: graph/render-settings.json, sanitised on read and again on write. */
export interface RenderSettings {
  /** a file without it is legacy, and nodeSize, arrowLength, labelSize and regions.dilation reset */
  sizeUnits: "world";
  nodeSize: number;
  edgeWidth: number;
  arrowLength: number;
  labelZoom: number;
  labelSize: number;
  clusterLabels: boolean;
  clusterLabelSize: number;
  regions: { dilation: number; blur: number; bitmap: 128 | 192 | 256 | 384 | 512; edgeAlpha: number; enabled: boolean };
  physics: {
    chargeStrength: number;
    linkStrength: number;
    linkDistance: number;
    gravity: number;
    clusterPull: number;
    velocityDecay: number;
    depthMode: "off" | "vertical" | "radial";
    depthStrength: number;
    depthSpacing: number;
    depthBaseRadius: number;
  };
}

/** Request and response shapes: body of POST /api/learn/graph/ratify. reason is required for rejected. */
export interface RatifyClaim {
  /** claim:<12 hex> */
  claim: string;
  status: "ratified" | "rejected";
  reason?: string;
}

/** Request and response shapes: a proposition with its derived fields. */
export interface PropositionView {
  id: string;
  name: string;
  statement: string;
  aliases: string[];
  createdAt: string;
  provenance: ProvenancePoint[];
  sensitivity: Sensitivity;
  metrics: KnowledgeMetrics;
}

/** Request and response shapes: an argument after the read time merge. */
export interface MergedChain {
  id: string;
  premises: string[];
  conclusion: string;
  createdAt: string;
  provenance: ProvenancePoint[];
  sensitivity: Sensitivity;
}

/** Request and response shapes: a birth source with at least 3 propositions. */
export interface Cluster {
  id: string;
  label: string | null;
  members: string[];
}

/** Request and response shapes: GET /api/learn/graph. */
export interface GraphSnapshot {
  /** the canvas image */
  nodes: { id: string; name: string; statement: string; kind: "proposition" | "junction" }[];
  /** the stored truth */
  propositions: PropositionView[];
  edges: { from: string; to: string }[];
  /** over propositions only */
  logicalEdges: { from: string; to: string }[];
  impLinks: { id: string; premises: string[]; conclusion: string }[];
  chains: MergedChain[];
  /** session id to title */
  sessions: Record<string, string>;
  /** source id to file label */
  fileSources: Record<string, string>;
  /** proposition id to the sessions and sources that touched it */
  nodeSessions: Record<string, string[]>;
  clusters: Cluster[];
  /** present only when the positions file is not empty */
  positions?: Record<string, { x: number; y: number }>;
  /** the newest modification time, in milliseconds, of the graph files */
  revision: number;
}

/** Request and response shapes: mode of a deletion. */
export type DeletionMode = "preserve-graph" | "delete-nodes";

/** Request and response shapes: what a deletion removed. */
export interface DeletionStats {
  nodesRemoved: number;
  chainsRemoved: number;
  coverageRemoved: number;
  checkpointsRemoved: number;
}

/** Request and response shapes: one row of GET /api/learn/graph/status. */
export interface ExtractionRun {
  id: string;
  sessionId: string | null;
  sourceId: string | null;
  title: string;
  phase: "queued" | "extracting" | "waiting" | "auditing" | "merging";
  startedAt: string;
  usage?: ExtractionRunUsage;
}

/** Request and response shapes: GET /api/learn/graph/costs, the 10 newest runs. */
export interface GraphCosts {
  cost: number | null;
  unpriced: number;
  runs: { id: string; title: string; at: string; cost: number | null; stats?: { nodes: number; chains: number } }[];
}

/** Request and response shapes: derived metrics of a proposition, never written to the ledgers. */
export interface KnowledgeMetrics {
  /** distinct sources and sessions in the provenance */
  support: number;
  held: "unknown" | "shaky" | "held";
  lastTested: string | null;
  calibration: {
    n: number;
    meanConfidence: number;
    accuracy: number;
    gap: number;
    band: "calibrated" | "overconfident" | "underconfident";
  } | null;
}

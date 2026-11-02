// The merge stage. Plain code resolves the links of the auditor, rebuilds identifiers, times and provenance, appends
// the ledger lines, drops the arguments that another argument makes redundant, writes the locators, and writes the
// checkpoint and the coverage last, so that a batch which stops early stays uncovered. No model is trusted for an
// identifier, a time or a source (docs/LEARNING.md, "The extraction pipeline", stage 4).
import { randomBytes } from "node:crypto";
import type { ChainLine, CoverageLine, NodeLine, ProvenancePoint } from "../../../../shared/learn/knowledge.ts";
import type { LocatorLine } from "../../../../shared/learn/sources.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { chainKey, isChainLine, isNodeLine, mergeChains, mergeNodes } from "../knowledge/ledger.ts";
import { locateQuote, locatorLine, type LocatorContext } from "./locate.ts";
import type { Findings, SourceShape } from "./types.ts";

export interface MergeStats {
  nodes: number;
  chains: number;
  droppedChains?: number;
}

export interface MergeDeps {
  knowledge: Knowledge;
  now: () => Date;
  /** a fresh identifier body of 12 hex characters */
  newKey?: () => string;
}

export interface MergeInput {
  sourceId: string;
  shape: SourceShape;
  findings: Findings;
  /** local finding id to the id of the existing proposition that it repeats */
  links: ReadonlyMap<string, string>;
  /** the chunk that the extractor read, and the line of the whole text on which it starts. Null writes no locator */
  chunk: { text: string; firstLine: number } | null;
  locator: LocatorContext | null;
  /** hash of the file when it was extracted */
  fileSha256: string;
  /** message fingerprints to mark as covered, after everything else is written */
  coverage?: { fp: string; tokens: number }[];
  /** true writes the whole file checkpoint, after everything else is written */
  checkpoint?: boolean;
}

export interface MergeResult {
  stats: MergeStats;
  /** the propositions that this merge added or linked, in order, without repeats */
  nodeIds: string[];
}

/** A step after the first append failed. The appends stay, and the committed figures say what they were. */
export class PostMergeError extends Error {
  committed: MergeStats;
  nodeIds: string[];
  constructor(message: string, committed: MergeStats, nodeIds: string[]) {
    super(message);
    this.name = "PostMergeError";
    this.committed = committed;
    this.nodeIds = nodeIds;
  }
}

const defaultKey = (): string => randomBytes(6).toString("hex");

export const isLocator = (v: unknown): v is LocatorLine =>
  !!v && typeof v === "object" && typeof (v as LocatorLine).nodeId === "string" && typeof (v as LocatorLine).sourceId === "string" && typeof (v as LocatorLine).found === "boolean";

/** The merge of one chunk or one batch. Throws PostMergeError when a step after an append fails. */
export function mergeRun(deps: MergeDeps, input: MergeInput): MergeResult {
  const { knowledge: k } = deps;
  const key = deps.newKey ?? defaultKey;
  const at = deps.now().toISOString();
  const store = k.store;
  const merged = mergeNodes(store.readLedger(store.graphFile("nodes.jsonl"), isNodeLine));
  const held = new Map(merged.map((n) => [n.id, n]));
  const heldChains = new Map(mergeChains(store.readLedger(store.graphFile("chains.jsonl"), isChainLine)).map((c) => [c.key, c]));

  // 1. resolution: a repeated local id keeps its first resolution, and a link to a missing id makes a new node
  const local = new Map<string, string>();
  const nodeLines: NodeLine[] = [];
  const placed: { nodeId: string; quote?: string }[] = [];
  for (const p of input.findings.propositions) {
    if (local.has(p.id)) continue;
    const point: ProvenancePoint = { chatId: input.sourceId, messageId: input.shape === "notes" ? "" : (p.messageId ?? "") };
    const target = input.links.get(p.id);
    const existing = target ? held.get(target) : undefined;
    if (existing) {
      local.set(p.id, existing.id);
      const known = existing.statement === p.statement || existing.aliases.includes(p.statement);
      const aliasesKnown = p.aliases.every((a) => a === existing.statement || existing.aliases.includes(a));
      const seen = existing.provenance.some((q) => q.chatId === point.chatId && q.messageId === point.messageId);
      if (!(known && aliasesKnown && seen)) {
        nodeLines.push({ id: existing.id, name: p.name, statement: p.statement, aliases: p.aliases, createdAt: at, provenance: [point] });
      }
      placed.push({ nodeId: existing.id, quote: p.quote });
      continue;
    }
    const id = `n_${key()}`;
    local.set(p.id, id);
    held.set(id, { id, name: p.name, statement: p.statement, aliases: p.aliases, createdAt: at, provenance: [point] });
    nodeLines.push({ id, name: p.name, statement: p.statement, aliases: p.aliases, createdAt: at, provenance: [point] });
    placed.push({ nodeId: id, quote: p.quote });
  }

  // 2. chains: endpoints resolve through the local map or pass through when they name a proposition of the graph
  const resolve = (id: string): string | null => local.get(id) ?? (held.has(id) ? id : null);
  const chainLines: ChainLine[] = [];
  const queued = new Set<string>();
  for (const c of input.findings.chains) {
    const conclusion = resolve(c.conclusion);
    if (conclusion === null) continue;
    const premises = [...new Set(c.premises.map(resolve).filter((x): x is string => x !== null && x !== conclusion))];
    if (premises.length === 0) continue;
    const ck = chainKey(premises, conclusion);
    if (queued.has(ck)) continue;
    const other = heldChains.get(ck);
    if (other?.provenance.some((q) => q.chatId === input.sourceId)) continue;
    queued.add(ck);
    chainLines.push({
      id: other ? other.id : `arg_${key()}`,
      premises: other ? other.premises : premises,
      conclusion,
      createdAt: at,
      provenance: [{ chatId: input.sourceId, messageId: "" }],
    });
  }

  const nodeIds = [...new Set(placed.map((p) => p.nodeId))];
  const committed: MergeStats = { nodes: 0, chains: 0 };
  const guard = <T>(step: () => T): T => {
    try {
      return step();
    } catch (e) {
      if (committed.nodes + committed.chains === 0) throw e;
      throw new PostMergeError(e instanceof Error && e.message ? e.message : "A step after the merge failed.", { ...committed }, nodeIds);
    }
  };

  // 3. appends, then simplification, locators, and last the checkpoint and the coverage
  k.appendNodes(nodeLines);
  committed.nodes = nodeLines.length;
  guard(() => k.appendChains(chainLines));
  committed.chains = chainLines.length;
  const dropped = guard(() => k.simplify());
  if (dropped > 0) committed.droppedChains = dropped;

  guard(() => {
    if (!input.chunk || !input.locator) return;
    const known = new Map<string, LocatorLine>();
    for (const l of store.readLedger(store.cortexFile("locators.jsonl"), isLocator)) known.set(`${l.nodeId}|${l.sourceId}`, l);
    const lines: LocatorLine[] = [];
    const done = new Set<string>();
    for (const p of placed) {
      const id = `${p.nodeId}|${input.sourceId}`;
      if (done.has(id)) continue;
      done.add(id);
      const where = locateQuote(input.chunk.text, p.quote, input.chunk.firstLine);
      const line = locatorLine(p.nodeId, input.sourceId, input.fileSha256, p.quote, where, input.locator, at);
      const old = known.get(id);
      const same = old && old.fileSha256 === line.fileSha256 && old.startLine === line.startLine && old.endLine === line.endLine && old.quote === line.quote && old.found === line.found;
      if (!same) lines.push(line);
    }
    store.appendLines(store.cortexFile("locators.jsonl"), lines);
  });

  guard(() => {
    if (input.coverage && input.coverage.length > 0) {
      const lines: CoverageLine[] = input.coverage.map((c) => ({ chatId: input.sourceId, fp: c.fp, tokens: c.tokens, foldedAt: at }));
      k.appendCoverage(lines);
    }
    if (input.checkpoint) k.appendCheckpoint({ chatId: input.sourceId, foldedAt: at });
  });
  // a merge that changed nothing leaves the layout alone
  if (committed.nodes + committed.chains + (committed.droppedChains ?? 0) > 0) guard(() => k.settle());
  return { stats: committed, nodeIds };
}

/** Writes the whole file checkpoint of a notes file, after every chunk has merged. */
export function checkpointFile(deps: MergeDeps, sourceId: string): void {
  deps.knowledge.appendCheckpoint({ chatId: sourceId, foldedAt: deps.now().toISOString() });
}

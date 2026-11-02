// Deletion. Session deletion modes, the full death of a proposition, deletion
// of one argument and deletion of sources by the organisation route. Every
// removed line is archived to archive/<date>/ before it leaves a ledger. The
// rules are those of docs/CONTRACTS.md, "Request and response shapes" (the
// deletion rules), and the work is synchronous so that no append can interleave.

import type {
  ChainLine,
  CheckpointLine,
  CoverageLine,
  DeletionMode,
  DeletionStats,
  NodeLine,
  PositionsFile,
  SourceRecord,
} from "../../../../shared/learn/knowledge.ts";
import type { OrganizationFile } from "../../../../shared/learn/sources.ts";
import { KnowledgeError, badRequest, checkId, extractionRunning, notFound } from "./errors.ts";
import { isChainLine, isCheckpointLine, isCoverageLine, isNodeLine } from "./ledger.ts";
import { pruneAfterDeletion } from "./organization.ts";
import { readPositionsFile } from "./positions.ts";
import type { KnowledgeStore } from "./store.ts";

export function parseMode(value: unknown): DeletionMode {
  if (value === "preserve-graph" || value === "delete-nodes") return value;
  throw badRequest("The mode must be preserve-graph or delete-nodes. There is no default.");
}

export interface PurgePlan {
  nodes: NodeLine[];
  chains: ChainLine[];
  /** the lines as they were, for every line that was removed or changed */
  archivedNodes: NodeLine[];
  archivedChains: ChainLine[];
  deadNodeIds: Set<string>;
  /** chain ids that have no line left */
  deadChainIds: Set<string>;
}

/**
 * The purge of delete-nodes mode over in memory ledgers. A proposition survives
 * when any of its lines has a provenance point from a source that is not
 * deleted, and a proposition with no provenance at all is outside the blast
 * radius. A dead proposition loses every line. On a survivor, a line that loses
 * every point is dropped if it is a link line, and a create line keeps its
 * name, statement and createdAt and loses its aliases and points. An argument
 * assertion goes when its provenance becomes empty or when a proposition it
 * names died.
 */
export function planPurge(nodeLines: NodeLine[], chainLines: ChainLine[], deleted: ReadonlySet<string>): PurgePlan {
  const byId = new Map<string, NodeLine[]>();
  for (const l of nodeLines) (byId.get(l.id) ?? byId.set(l.id, []).get(l.id)!).push(l);
  const deadNodeIds = new Set<string>();
  const nodes: NodeLine[] = [];
  const archivedNodes: NodeLine[] = [];
  const replacement = new Map<NodeLine, NodeLine | null>();
  for (const [id, lines] of byId) {
    const total = lines.reduce((n, l) => n + l.provenance.length, 0);
    if (total === 0) continue;
    const alive = lines.some((l) => l.provenance.some((p) => !deleted.has(p.chatId)));
    if (!alive) {
      deadNodeIds.add(id);
      for (const l of lines) replacement.set(l, null);
      continue;
    }
    lines.forEach((l, i) => {
      if (l.provenance.length === 0) return;
      const left = l.provenance.filter((p) => !deleted.has(p.chatId));
      if (left.length === l.provenance.length) return;
      if (left.length > 0) {
        replacement.set(l, { ...l, provenance: left });
      } else if (i === 0) {
        replacement.set(l, { ...l, aliases: [], provenance: [] });
      } else {
        replacement.set(l, null);
      }
    });
  }
  for (const l of nodeLines) {
    if (!replacement.has(l)) {
      nodes.push(l);
      continue;
    }
    archivedNodes.push(l);
    const r = replacement.get(l);
    if (r) nodes.push(r);
  }

  const chains: ChainLine[] = [];
  const archivedChains: ChainLine[] = [];
  for (const l of chainLines) {
    const memberDied = deadNodeIds.has(l.conclusion) || l.premises.some((p) => deadNodeIds.has(p));
    if (memberDied) {
      archivedChains.push(l);
      continue;
    }
    if (l.provenance.length === 0) {
      chains.push(l);
      continue;
    }
    const left = l.provenance.filter((p) => !deleted.has(p.chatId));
    if (left.length === l.provenance.length) {
      chains.push(l);
    } else if (left.length > 0) {
      archivedChains.push(l);
      chains.push({ ...l, provenance: left });
    } else {
      archivedChains.push(l);
    }
  }
  const remaining = new Set(chains.map((c) => c.id));
  const deadChainIds = new Set(archivedChains.map((c) => c.id).filter((id) => !remaining.has(id)));
  return { nodes, chains, archivedNodes, archivedChains, deadNodeIds, deadChainIds };
}

function prunePositions(store: KnowledgeStore, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  const file = store.graphFile("positions.json");
  const raw = store.readJson<PositionsFile>(file);
  if (!raw) return;
  const positions = readPositionsFile(raw);
  let changed = false;
  for (const id of ids) {
    if (id in positions) {
      delete positions[id];
      changed = true;
    }
  }
  if (changed) store.writeJson(file, { positions, updatedAt: store.now().toISOString() } satisfies PositionsFile);
}

interface EvidenceLine {
  nodeId?: string;
  sourceId: string;
}

const isEvidenceLine = (v: unknown): v is EvidenceLine => !!v && typeof v === "object" && typeof (v as EvidenceLine).sourceId === "string";

/**
 * Removes the locators and the file records that belong to what a deletion removes: a locator of a deleted source
 * or of a proposition that died, and the record of a deleted file. The lines go to archive/<date>/ first, and a line
 * of another shape stays where it is. The locator of a surviving proposition for a source that survives is kept.
 */
function purgeEvidence(store: KnowledgeStore, deletedSources: ReadonlySet<string>, deadNodeIds: ReadonlySet<string>): void {
  const locators = store.cortexFile("locators.jsonl");
  const all = store.readLedger<EvidenceLine>(locators, isEvidenceLine);
  const gone = all.filter((l) => deletedSources.has(l.sourceId) || (typeof l.nodeId === "string" && deadNodeIds.has(l.nodeId)));
  if (gone.length > 0) {
    store.archive("locators", gone);
    store.rewriteLedger(locators, all.filter((l) => !gone.includes(l)));
  }
  if (deletedSources.size === 0) return;
  const files = store.cortexFile("files.jsonl");
  const records = store.readLedger<EvidenceLine>(files, isEvidenceLine);
  const goneFiles = records.filter((l) => deletedSources.has(l.sourceId));
  if (goneFiles.length > 0) {
    store.archive("files", goneFiles);
    store.rewriteLedger(files, records.filter((l) => !deletedSources.has(l.sourceId)));
  }
}

/**
 * Removes the traces of the given sources and sessions. Coverage lines and
 * checkpoint lines always go. In preserve-graph mode that is all, and the node
 * and argument ledgers are not touched. The caller has already checked that no
 * extraction is registered.
 */
export function purgeSources(store: KnowledgeStore, ids: readonly string[], mode: DeletionMode): DeletionStats {
  store.assertWritable();
  const deleted = new Set(ids);
  const stats: DeletionStats = { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 };
  const coverage = store.readLedger<CoverageLine>(store.graphFile("coverage.jsonl"), isCoverageLine);
  const checkpoints = store.readLedger<CheckpointLine>(store.graphFile("sessions.jsonl"), isCheckpointLine);
  const coverageGone = coverage.filter((l) => deleted.has(l.chatId));
  const checkpointsGone = checkpoints.filter((l) => deleted.has(l.chatId));
  let plan: PurgePlan | null = null;
  if (mode === "delete-nodes") {
    const nodeLines = store.readLedger<NodeLine>(store.graphFile("nodes.jsonl"), isNodeLine);
    const chainLines = store.readLedger<ChainLine>(store.graphFile("chains.jsonl"), isChainLine);
    plan = planPurge(nodeLines, chainLines, deleted);
  }
  // archive first, then rewrite, so that no line leaves a ledger unrecorded
  if (plan) {
    store.archive("nodes", plan.archivedNodes);
    store.archive("chains", plan.archivedChains);
  }
  store.archive("coverage", coverageGone);
  store.archive("sessions", checkpointsGone);
  if (plan) {
    if (plan.archivedNodes.length > 0) store.rewriteLedger(store.graphFile("nodes.jsonl"), plan.nodes);
    if (plan.archivedChains.length > 0) store.rewriteLedger(store.graphFile("chains.jsonl"), plan.chains);
    purgeEvidence(store, deleted, plan.deadNodeIds);
    prunePositions(store, new Set([...plan.deadNodeIds, ...plan.deadChainIds]));
    stats.nodesRemoved = plan.deadNodeIds.size;
    stats.chainsRemoved = plan.deadChainIds.size;
  }
  if (coverageGone.length > 0) {
    store.rewriteLedger(store.graphFile("coverage.jsonl"), coverage.filter((l) => !deleted.has(l.chatId)));
  }
  if (checkpointsGone.length > 0) {
    store.rewriteLedger(store.graphFile("sessions.jsonl"), checkpoints.filter((l) => !deleted.has(l.chatId)));
  }
  stats.coverageRemoved = coverageGone.length;
  stats.checkpointsRemoved = checkpointsGone.length;
  return stats;
}

/**
 * Deletes one proposition by full death: every line of it, every argument that
 * names it whoever asserted it, and its position. An arg_ identifier deletes
 * that argument only. Returns null for an unknown identifier.
 */
export function deleteNode(store: KnowledgeStore, id: string): DeletionStats | null {
  store.assertWritable();
  const stats: DeletionStats = { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 };
  const chainLines = store.readLedger<ChainLine>(store.graphFile("chains.jsonl"), isChainLine);
  if (id.startsWith("arg_")) {
    const gone = chainLines.filter((c) => c.id === id);
    if (gone.length === 0) return null;
    store.archive("chains", gone);
    store.rewriteLedger(store.graphFile("chains.jsonl"), chainLines.filter((c) => c.id !== id));
    prunePositions(store, new Set([id]));
    stats.chainsRemoved = 1;
    return stats;
  }
  const nodeLines = store.readLedger<NodeLine>(store.graphFile("nodes.jsonl"), isNodeLine);
  const own = nodeLines.filter((n) => n.id === id);
  if (own.length === 0) return null;
  const goneChains = chainLines.filter((c) => c.conclusion === id || c.premises.includes(id));
  store.archive("nodes", own);
  store.archive("chains", goneChains);
  store.rewriteLedger(store.graphFile("nodes.jsonl"), nodeLines.filter((n) => n.id !== id));
  if (goneChains.length > 0) {
    store.rewriteLedger(store.graphFile("chains.jsonl"), chainLines.filter((c) => !goneChains.includes(c)));
  }
  const keptChainIds = new Set(chainLines.filter((c) => !goneChains.includes(c)).map((c) => c.id));
  const deadChainIds = new Set(goneChains.map((c) => c.id).filter((c) => !keptChainIds.has(c)));
  purgeEvidence(store, new Set(), new Set([id]));
  prunePositions(store, new Set([id, ...deadChainIds]));
  stats.nodesRemoved = 1;
  stats.chainsRemoved = deadChainIds.size;
  return stats;
}

export interface SelectionRequest {
  sourceIds: string[];
  folderIds: string[];
  deleteSessions: boolean;
}

/** Reads and checks the body of DELETE /api/learn/source-organization. deleteSessions has no default. */
export function parseSelection(body: Record<string, unknown>): SelectionRequest {
  const list = (key: string): string[] => {
    const v = body[key];
    if (!Array.isArray(v)) throw badRequest(`The field ${key} must be a list.`);
    return [...new Set(v.map((x) => checkId(x, `identifiers in ${key}`)))];
  };
  const sourceIds = list("sourceIds");
  const folderIds = list("folderIds");
  if (typeof body.deleteSessions !== "boolean") throw badRequest("The field deleteSessions must be true or false. There is no default.");
  if (sourceIds.length === 0 && folderIds.length === 0) throw badRequest("Select at least one source or folder to delete.");
  return { sourceIds, folderIds, deleteSessions: body.deleteSessions };
}

export interface SelectionDeps {
  /** tells whether an extraction is registered */
  extractionRegistered: () => boolean;
  /** tells whether a turn or a job is live for a session */
  chatBusy?: (id: string) => boolean;
  /** removes a session record and its jobs. Absent when sessions are not stored here */
  deleteChat?: (id: string) => void;
}

export interface SelectionResult {
  organization: OrganizationFile;
  sourcesRemoved: string[];
  stats: DeletionStats;
}

/**
 * Deletes sources by the delete-nodes rules, in the order of the route: refuse
 * first, purge the graph in one rewrite, remove the source records, delete idle
 * sessions only when asked, then drop placements and the selected folders from
 * the bottom up while they are empty. The organisation is validated by the
 * caller before this runs.
 */
export function deleteSelection(
  store: KnowledgeStore,
  organization: OrganizationFile,
  req: SelectionRequest,
  deps: SelectionDeps,
): SelectionResult {
  for (const f of req.folderIds) {
    if (!organization.folders.some((x) => x.id === f)) throw notFound("A selected folder does not exist.");
  }
  if (deps.extractionRegistered()) throw extractionRunning();
  const isChat = (id: string): boolean => id.startsWith("chat_");
  if (req.deleteSessions) {
    for (const id of req.sourceIds.filter(isChat)) {
      if (deps.chatBusy?.(id)) throw new KnowledgeError(409, "turn_running", "A turn or a background job is running for a selected session. Stop it and then try again.");
    }
  }
  const stats = purgeSources(store, req.sourceIds, "delete-nodes");
  const file = store.graphFile("sources.json");
  const records = store.readJson<Record<string, SourceRecord>>(file);
  const fileIds = req.sourceIds.filter((id) => !isChat(id));
  if (records && fileIds.some((id) => id in records)) {
    const next: Record<string, SourceRecord> = {};
    for (const [k, v] of Object.entries(records)) if (!fileIds.includes(k)) next[k] = v;
    store.writeJson(file, next);
  }
  if (req.deleteSessions) for (const id of req.sourceIds.filter(isChat)) deps.deleteChat?.(id);
  // a kept session keeps its placement, and so blocks the removal of its folder
  const placed = req.sourceIds.filter((id) => !isChat(id) || req.deleteSessions);
  const next = pruneAfterDeletion(organization, new Set(placed), new Set(req.folderIds));
  return { organization: next, sourcesRemoved: req.sourceIds, stats };
}

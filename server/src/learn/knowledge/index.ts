// The knowledge ledger core: a factory over explicit paths and dependencies.
// It reads no global configuration. Claude wires it into server/src/learn/http.ts
// and server/src/main.ts at merge time.

import fs from "node:fs";
import path from "node:path";
import type {
  ChainLine,
  CheckpointLine,
  CoverageLine,
  DeletionMode,
  DeletionStats,
  GraphSnapshot,
  NodeLine,
  PositionsFile,
  RatifyClaim,
  RenderSettings,
  SourceRecord,
} from "../../../../shared/learn/knowledge.ts";
import type {
  FileRecord,
  OrganizationAction,
  OrganizationFile,
  OutcomeLine,
  Sensitivity,
  SourceDirectory,
  SourceRegistryFile,
} from "../../../../shared/learn/sources.ts";
import {
  deleteNode,
  deleteSelection,
  purgeSources,
  type SelectionDeps,
  type SelectionRequest,
} from "./deletion.ts";
import { KnowledgeError, extractionRunning, notFound } from "./errors.ts";
import {
  deriveClusters,
  deriveView,
  fileLabel,
  isChainLine,
  isCheckpointLine,
  isCoverageLine,
  isNodeLine,
  isSensitivity,
  mergeChains,
  mergeNodes,
} from "./ledger.ts";
import { applyAction, emptyOrganization, parseOrganization } from "./organization.ts";
import { layout, readPositionsFile, sanitizePositions, type PositionMap } from "./positions.ts";
import { Ratifier, type RatifyDeps } from "./ratify.ts";
import { defaultRenderSettings, sanitizeRenderSettings } from "./render-settings.ts";
import { simplifyChains } from "./simplify.ts";
import { buildSnapshot, isOutcomeLine } from "./snapshot.ts";
import { KnowledgeStore, type StoreOptions } from "./store.ts";

export interface SessionInfo {
  title: string;
  createdAt: string | null;
}

export interface KnowledgeOptions extends StoreOptions {
  /** tells whether an extraction is registered, which blocks every deletion */
  extractionRegistered?: () => boolean;
  /** the sessions that exist, by id. The default reads the titles in chats/ */
  sessions?: () => Record<string, SessionInfo>;
  /** tells whether a turn or a job is live for a session */
  chatBusy?: (id: string) => boolean;
  /** removes a session record and its jobs */
  deleteChat?: (id: string) => void;
  /** the sensitivity of a session or source. The default reads cortex/sources.json and cortex/files.jsonl */
  sensitivityOf?: (id: string) => Sensitivity;
  /** the writer of the assertions of a ratified claim and the rebuild of the graph */
  ratify?: Omit<RatifyDeps, "revision">;
  /** an identifier for a new folder. Tests replace it */
  newFolderId?: () => string;
}

function readChatInfo(dir: string): Record<string, SessionInfo> {
  const out: Record<string, SessionInfo> = {};
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { id?: unknown; title?: unknown; createdAt?: unknown };
      if (typeof v.id === "string" && typeof v.title === "string") {
        out[v.id] = { title: v.title, createdAt: typeof v.createdAt === "string" ? v.createdAt : null };
      }
    } catch {
      // a corrupt record is skipped
    }
  }
  return out;
}

export class Knowledge {
  readonly store: KnowledgeStore;
  private readonly o: KnowledgeOptions;
  private readonly ratifier: Ratifier | null;

  constructor(o: KnowledgeOptions) {
    this.o = o;
    this.store = new KnowledgeStore(o);
    this.ratifier = o.ratify ? new Ratifier({ ...o.ratify, revision: () => this.store.revision() }) : null;
  }

  // ---- reads ----------------------------------------------------------

  private nodeLines(): NodeLine[] {
    return this.store.readLedger<NodeLine>(this.store.graphFile("nodes.jsonl"), isNodeLine);
  }

  private chainLines(): ChainLine[] {
    return this.store.readLedger<ChainLine>(this.store.graphFile("chains.jsonl"), isChainLine);
  }

  private sessions(): Record<string, SessionInfo> {
    return this.o.sessions ? this.o.sessions() : readChatInfo(path.join(this.store.learnDir, "chats"));
  }

  private sourceRecords(): Record<string, SourceRecord> {
    const raw = this.store.readJson<Record<string, SourceRecord>>(this.store.graphFile("sources.json"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  /** The default gate input: a source takes the sensitivity of its root, and a session is internal. */
  private sensitivityResolver(): (id: string) => Sensitivity {
    if (this.o.sensitivityOf) return this.o.sensitivityOf;
    const registry = this.store.readJson<SourceRegistryFile>(this.store.cortexFile("sources.json"));
    const roots = registry && typeof registry.roots === "object" && registry.roots ? registry.roots : {};
    const rootOf = new Map<string, string>();
    for (const f of this.store.readLedger<FileRecord>(this.store.cortexFile("files.jsonl"), (v): v is FileRecord => {
      return typeof v === "object" && v !== null && typeof (v as FileRecord).sourceId === "string" && typeof (v as FileRecord).rootId === "string";
    })) {
      rootOf.set(f.sourceId, f.rootId);
    }
    return (id) => {
      const root = roots[rootOf.get(id) ?? ""];
      return root && isSensitivity(root.sensitivity) ? root.sensitivity : "internal";
    };
  }

  private readOrganization(): OrganizationFile {
    const raw = this.store.readJson<unknown>(this.store.graphFile("source-organization.json"));
    if (raw === null) {
      if (fs.existsSync(this.store.graphFile("source-organization.json"))) {
        throw new KnowledgeError(500, undefined, "The source organisation file cannot be read. It was left unchanged.");
      }
      return emptyOrganization();
    }
    return parseOrganization(raw);
  }

  snapshot(max?: Sensitivity): GraphSnapshot {
    this.store.assertReadable();
    const sessions = this.sessions();
    const titles: Record<string, string> = {};
    for (const [id, s] of Object.entries(sessions)) titles[id] = s.title;
    const positions = readPositionsFile(this.store.readJson<PositionsFile>(this.store.graphFile("positions.json")));
    return buildSnapshot({
      nodeLines: this.nodeLines(),
      chainLines: this.chainLines(),
      titles,
      sources: this.sourceRecords(),
      organization: this.readOrganization(),
      positions,
      outcomes: this.store.readLedger<OutcomeLine>(this.store.cortexFile("outcomes.jsonl"), isOutcomeLine),
      sensitivityOf: this.sensitivityResolver(),
      max,
      revision: this.store.revision(),
    });
  }

  revision(): number {
    return this.store.revision();
  }

  // ---- layout ---------------------------------------------------------

  private layoutInput(prior: PositionMap, physics: RenderSettings["physics"]) {
    const merged = mergeNodes(this.nodeLines());
    const view = deriveView(merged, mergeChains(this.chainLines()));
    const clusters = deriveClusters(merged, view.live, () => null);
    const clusterOf = new Map<string, string>();
    for (const c of clusters) for (const m of c.members) clusterOf.set(m, c.id);
    return { nodes: view.nodes, links: view.edges, logicalEdges: view.logicalEdges, impLinks: view.impLinks, clusterOf, prior, physics };
  }

  /** The settle after a merge: warm starts from the file and replaces it as a whole. */
  settle(): PositionMap {
    this.store.assertReadable();
    const prior = readPositionsFile(this.store.readJson<PositionsFile>(this.store.graphFile("positions.json")));
    const physics = (this.readRenderSettings() ?? defaultRenderSettings()).physics;
    const positions = layout(this.layoutInput(prior, physics));
    this.store.writeGraphJson("positions.json", { positions, updatedAt: this.store.now().toISOString() } satisfies PositionsFile);
    return positions;
  }

  /**
   * The commit of a drag. Only ids in the current image are kept, a value that is
   * not finite is dropped and the rest is clamped. When the graph grew during the
   * drag, one settle runs with the client positions as anchors. An empty result
   * writes nothing.
   */
  commitPositions(raw: unknown): PositionMap {
    this.store.assertReadable();
    const physics = (this.readRenderSettings() ?? defaultRenderSettings()).physics;
    const input = this.layoutInput({}, physics);
    const allowed = new Set(input.nodes.map((n) => n.id));
    const clean = sanitizePositions(raw, allowed);
    if (Object.keys(clean).length === 0) return {};
    const complete = input.nodes.every((n) => n.id in clean);
    const positions = complete ? clean : layout({ ...input, prior: clean });
    this.store.writeGraphJson("positions.json", { positions, updatedAt: this.store.now().toISOString() } satisfies PositionsFile);
    return positions;
  }

  // ---- render settings -----------------------------------------------

  /** A missing or corrupt file reads as null, which means the defaults. */
  readRenderSettings(): RenderSettings | null {
    this.store.assertReadable();
    const raw = this.store.readJson<unknown>(this.store.graphFile("render-settings.json"));
    return raw === null ? null : sanitizeRenderSettings(raw);
  }

  writeRenderSettings(raw: unknown): RenderSettings {
    const clean = sanitizeRenderSettings(raw);
    this.store.writeGraphJson("render-settings.json", clean);
    return clean;
  }

  // ---- appends for the merge run --------------------------------------

  appendNodes(lines: NodeLine[]): void {
    this.store.appendLines(this.store.graphFile("nodes.jsonl"), lines);
  }

  appendChains(lines: ChainLine[]): void {
    this.store.appendLines(this.store.graphFile("chains.jsonl"), lines);
  }

  appendCoverage(lines: CoverageLine[]): void {
    this.store.appendLines(this.store.graphFile("coverage.jsonl"), lines);
  }

  appendCheckpoint(line: CheckpointLine): void {
    this.store.appendLines(this.store.graphFile("sessions.jsonl"), [line]);
  }

  readCoverage(chatId: string): CoverageLine[] {
    this.store.assertReadable();
    return this.store.readLedger<CoverageLine>(this.store.graphFile("coverage.jsonl"), isCoverageLine).filter((l) => l.chatId === chatId);
  }

  readCheckpoints(): CheckpointLine[] {
    this.store.assertReadable();
    return this.store.readLedger<CheckpointLine>(this.store.graphFile("sessions.jsonl"), isCheckpointLine);
  }

  /** Drops the redundant chains, archiving their lines first. Returns the number of distinct arguments dropped. */
  simplify(): number {
    this.store.assertWritable();
    const lines = this.chainLines();
    const { kept, removed } = simplifyChains(lines);
    if (removed.length === 0) return 0;
    this.store.archive("chains", removed);
    this.store.rewriteLedger(this.store.graphFile("chains.jsonl"), kept);
    return new Set(removed.map((l) => `${[...l.premises].sort().join("+")}>${l.conclusion}`)).size;
  }

  // ---- deletion -------------------------------------------------------

  private blockWhileExtracting(): void {
    if (this.o.extractionRegistered?.()) throw extractionRunning();
  }

  /** Deletes the traces of sources or sessions by a mode. Refused while an extraction is registered. */
  deleteSources(ids: string[], mode: DeletionMode): DeletionStats {
    this.blockWhileExtracting();
    return purgeSources(this.store, ids, mode);
  }

  /** Route 37. Null for an unknown identifier. */
  deleteNode(id: string): { stats: DeletionStats; graphRevision: number } | null {
    this.blockWhileExtracting();
    const stats = deleteNode(this.store, id);
    return stats ? { stats, graphRevision: this.store.revision() } : null;
  }

  // ---- source organisation --------------------------------------------

  directory(): SourceDirectory {
    this.store.assertReadable();
    const organization = this.readOrganization();
    const sessions = this.sessions();
    const records = this.sourceRecords();
    const known = new Set([...Object.keys(sessions), ...Object.keys(records)]);
    const missing = new Set<string>();
    for (const l of [...this.nodeLines(), ...this.chainLines()]) {
      for (const p of l.provenance) if (!known.has(p.chatId)) missing.add(p.chatId);
    }
    const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const chats = Object.entries(sessions)
      .map(([id, s]) => ({ id, kind: "chat" as const, label: s.title, createdAt: s.createdAt }))
      .sort(byId);
    const notes = Object.values(records)
      .map((r) => ({
        id: r.id,
        kind: "notes" as const,
        label: organization.placements[r.id]?.name ?? fileLabel(r.filePath),
        createdAt: r.importedAt,
        filePath: r.filePath,
      }))
      .sort(byId);
    const gone = [...missing].sort().map((id) => ({ id, kind: "missing" as const, label: null, createdAt: null }));
    return { organization, sources: [...chats, ...notes, ...gone] };
  }

  organize(action: OrganizationAction): { directory: SourceDirectory; createdFolderId?: string } {
    this.store.assertWritable();
    const current = this.readOrganization();
    const result = applyAction(current, action, this.store.now(), this.o.newFolderId);
    this.store.writeGraphJson("source-organization.json", result.organization);
    return { directory: this.directory(), ...(result.createdFolderId ? { createdFolderId: result.createdFolderId } : {}) };
  }

  /** Route 49. The organisation is read and validated before any destructive write. */
  deleteBySelection(req: SelectionRequest): { directory: SourceDirectory; graphRevision: number; stats: DeletionStats } {
    this.store.assertWritable();
    const current = this.readOrganization();
    const deps: SelectionDeps = {
      extractionRegistered: () => this.o.extractionRegistered?.() ?? false,
      chatBusy: this.o.chatBusy,
      deleteChat: this.o.deleteChat,
    };
    const result = deleteSelection(this.store, current, req, deps);
    if (JSON.stringify(result.organization) !== JSON.stringify(current)) {
      this.store.writeGraphJson("source-organization.json", result.organization);
    }
    return { directory: this.directory(), graphRevision: this.store.revision(), stats: result.stats };
  }

  // ---- ratify ---------------------------------------------------------

  ratify(claim: RatifyClaim): Promise<{ assertions: number; graphRevision: number }> {
    if (!this.ratifier) return Promise.reject(notFound("Ratification is not available in this build."));
    return this.ratifier.ratify(claim);
  }

  // ---- lock -----------------------------------------------------------

  acquireLock(): void {
    this.store.acquireLock();
  }

  releaseLock(): void {
    this.store.releaseLock();
  }
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  return new Knowledge(options);
}


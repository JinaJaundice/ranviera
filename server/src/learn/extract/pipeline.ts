// The extraction pipeline. One source runs its chunks in order through the extractor, the auditor and the merge.
// Different sources run side by side, and the audit and the merge run one at a time in first in first out order, so
// that the auditor always sees the graph after every earlier merge (docs/LEARNING.md, "The extraction pipeline").
import { randomBytes } from "node:crypto";
import type { ExtractionRun, ExtractionRunUsage, GraphCosts, SourceRecord } from "../../../../shared/learn/knowledge.ts";
import type { LearnEventName, LearnStreamMessage } from "../../../../shared/learn/events.ts";
import type { ProviderClass } from "../../../../shared/learn/models.ts";
import type { FileRecord, ExtractionOutcome, Sensitivity, SourceRoot } from "../../../../shared/learn/sources.ts";
import { visibleMessage, type VisibleMessage } from "../knowledge/coverage.ts";
import { badRequest, notFound } from "../knowledge/errors.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { isChainLine, isNodeLine, mergeChains, mergeNodes, type MergedNode } from "../knowledge/ledger.ts";
import { LearnError } from "../models/errors.ts";
import { gateDecision, rootAllowedFor, sensitivityRefusal, type GateRoot } from "../models/gate.ts";
import { modelsNotConfigured } from "../models/slots.ts";
import type { SourcesService } from "../sources/index.ts";
import { runAuditor } from "./auditor.ts";
import { chunkBudget, chunkFile, messageBatches, messageStartLines } from "./chunk.ts";
import type { ExtractModels, StageEngine } from "./engines.ts";
import { buildDigest, runExtractor } from "./extractor.ts";
import { locatorContext, type LocatorContext } from "./locate.ts";
import { checkpointFile, mergeRun, PostMergeError, type MergeDeps, type MergeStats } from "./merge-run.ts";
import { AbortedError, processSemaphore, Semaphore } from "./semaphore.ts";
import type { SourceShape } from "./types.ts";
import { appendSourceUsage, foldCosts, RunTally, type UsageRow } from "./usage.ts";

/** The files that one service holds in flight, which the contracts set at 3. */
export const FILES_IN_FLIGHT = 3;
/** The most claims that one merge puts in the event learn.extract. */
export const FIRE_LIMIT = 20;

/** What the pipeline needs to know about a learning session. The runtime phase supplies it. */
export interface SessionSource {
  /** The extractable view of a session, or null when the session does not exist. */
  get(sessionId: string): { title: string; sensitivity: Sensitivity; view: VisibleMessage[] } | null;
  /** Adds a usage record to the session record. Null-safe: a session that has gone records nothing. */
  appendUsage?(sessionId: string, usage: ExtractionRunUsage): void;
  /** The usage records of every session, for the cost summary. */
  usage?(): UsageRow[];
}

/** The event learn.extract, which the composition root connects to the event hub. It holds identifiers only. */
export interface ExtractFire {
  /** the run identifier */
  key: string;
  /** the source or session identifier */
  sourceId: string;
  /** at most 20 of the propositions that the merge added or linked */
  nodeIds: string[];
}

export interface ExtractDeps {
  knowledge: Knowledge;
  sources: Pick<SourcesService, "get" | "files" | "file" | "updateFile" | "readText">;
  models: ExtractModels;
  /** the learning event bus */
  emit?: (event: LearnEventName, extra?: Omit<LearnStreamMessage, "type" | "event">) => void;
  fire?: (event: ExtractFire) => void;
  /** the permits for all background model work. The default is the semaphore of the process */
  semaphore?: Semaphore;
  fileLimit?: number;
  now?: () => Date;
  newKey?: () => string;
  log?: (message: string) => void;
}

export interface FileResult {
  outcome: ExtractionOutcome;
  stats?: MergeStats;
  notice?: string;
}

/** One chunk of a file or one batch of messages. */
interface Job {
  view: string;
  chunk: { text: string; firstLine: number } | null;
  anchors?: ReadonlySet<string>;
  coverage?: { fp: string; tokens: number }[];
}

interface Loaded {
  jobs: Job[];
  fileSha256: string;
  locator: LocatorContext | null;
  /** write the whole file checkpoint when every job succeeded */
  checkpoint: boolean;
  /** records the outcome in the file record, after the run */
  finish: (result: FileResult, jobs: number) => void;
}

interface Plan {
  /** the key of the single flight: a source id or a session id */
  key: string;
  sourceId: string | null;
  sessionId: string | null;
  title: string;
  shape: SourceShape;
  gateRoots: GateRoot[];
  /** The roots as they stand now, read again before each chunk so that a withdrawn consent or a raised sensitivity takes effect at once. */
  currentRoots: () => GateRoot[];
  load: () => Promise<Loaded | { refusal: string }>;
  /** false once the session or the source has gone */
  alive: () => boolean;
  /** stores the usage record of the run */
  storeUsage: (usage: ExtractionRunUsage) => void;
}

interface Active {
  row: ExtractionRun;
  controller: AbortController;
  tally: RunTally;
  startedAt: number;
  plan: Plan;
}

type Phase = ExtractionRun["phase"];

const failureText = (e: unknown): string => (e instanceof Error && e.message ? e.message : "The step failed.");

export class ExtractService {
  readonly semaphore: Semaphore;
  /** the audit and the merge, one at a time */
  readonly auditLock = new Semaphore(1);
  private readonly deps: ExtractDeps;
  private readonly files: Semaphore;
  private readonly active = new Map<string, Active>();
  private readonly settled = new Set<Promise<unknown>>();
  private sessionSource: SessionSource | null = null;
  private lastStart = 0;

  constructor(deps: ExtractDeps) {
    this.deps = deps;
    this.semaphore = deps.semaphore ?? processSemaphore();
    this.files = new Semaphore(deps.fileLimit ?? FILES_IN_FLIGHT);
  }

  // ---- wiring ---------------------------------------------------------

  /** Connects the learning sessions. Route 33 answers 404 until this is called. */
  setSessionSource(source: SessionSource | null): void {
    this.sessionSource = source;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private key(): string {
    return (this.deps.newKey ?? (() => randomBytes(6).toString("hex")))();
  }

  private emit(event: LearnEventName, extra: Omit<LearnStreamMessage, "type" | "event"> = {}): void {
    this.deps.emit?.(event, extra);
  }

  private nextStart(): number {
    this.lastStart = Math.max(this.now().getTime(), this.lastStart + 1);
    return this.lastStart;
  }

  // ---- reads ----------------------------------------------------------

  /** True while a run is registered. It blocks every deletion of knowledge. */
  registered(): boolean {
    return this.active.size > 0;
  }

  /** Route 31. */
  runs(): ExtractionRun[] {
    return [...this.active.values()].map((a) => {
      const usage = a.tally.record(a.startedAt, this.now().toISOString(), 0);
      return { ...a.row, ...(usage.stages.extractor || usage.stages.auditor ? { usage } : {}) };
    });
  }

  /** Route 32. */
  costs(): GraphCosts {
    const rows: UsageRow[] = [];
    const store = this.deps.knowledge.store;
    const records = store.readJson<Record<string, SourceRecord>>(store.graphFile("sources.json"));
    if (records && typeof records === "object" && !Array.isArray(records)) {
      for (const r of Object.values(records)) for (const usage of r.extractions ?? []) rows.push({ id: `${r.id}:${usage.startedAt}`, title: r.filePath, usage });
    }
    rows.push(...(this.sessionSource?.usage?.() ?? []));
    return foldCosts(rows, this.deps.models.price);
  }

  /** Resolves when no run is in flight. Tests and shutdown use it. */
  async idle(): Promise<void> {
    while (this.settled.size > 0) await Promise.allSettled([...this.settled]);
  }

  // ---- control --------------------------------------------------------

  /** Stops the model requests of the runs that match, or of every run. Nothing is merged for a chunk in flight. */
  abort(match: { runId?: string; sourceId?: string; sessionId?: string } = {}): number {
    let n = 0;
    for (const a of this.active.values()) {
      const hit =
        (!match.runId && !match.sourceId && !match.sessionId) ||
        a.row.id === match.runId ||
        (match.sourceId !== undefined && a.row.sourceId === match.sourceId) ||
        (match.sessionId !== undefined && a.row.sessionId === match.sessionId);
      if (hit) {
        a.controller.abort();
        n++;
      }
    }
    return n;
  }

  // ---- the checks that come before a model call -----------------------

  /** Throws the refusal that applies, in the order of the contracts: the switch, the slots, the key, the consent and the gate. */
  async precheck(roots: GateRoot[]): Promise<void> {
    const m = this.deps.models;
    if (m.settings().graph?.enabled === false) throw badRequest("Extraction is switched off in Settings, under Learning.");
    const refused = await m.preflight();
    if (refused) throw refused;
    this.engines(roots);
  }

  /** The engines of both stages, after the gate. Throws when a slot is empty or the gate refuses. */
  private engines(roots: GateRoot[]): { extractor: StageEngine; auditor: StageEngine; auditorClass: ProviderClass } {
    const m = this.deps.models;
    const extractor = m.engine("extractor");
    const auditor = m.engine("auditor");
    if (!extractor || !auditor) throw modelsNotConfigured(["cheap"]);
    for (const e of [extractor, auditor]) {
      const decision = gateDecision(m.providerClassOf(e.ref), roots);
      if (!decision.allowed) throw sensitivityRefusal(decision);
    }
    return { extractor, auditor, auditorClass: m.providerClassOf(auditor.ref) };
  }

  // ---- starting runs --------------------------------------------------

  /** Route 45. Returns how many files began and how many wait for a free place. */
  async extractRoot(rootId: string, body: { paths?: unknown; force?: unknown; confirm?: unknown } = {}): Promise<{ started: number; queued: number }> {
    const { sources } = this.deps;
    const root = sources.get(rootId);
    if (!root) throw notFound("No linked source has that id.");
    if (!root.enabled) throw badRequest("This root is switched off. Switch it on before an extraction.");
    if (root.kind === "learnharness") throw badRequest("A LearnHarness folder is imported by a scan and needs no extraction.");
    if (body.paths !== undefined && (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string"))) {
      throw badRequest("The field paths must be a list of paths relative to the root.");
    }
    if (body.force !== undefined && typeof body.force !== "boolean") throw badRequest("The field force must be true or false.");
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") throw badRequest("The field confirm must be true or false.");
    const known = sources.files(rootId);
    let chosen: FileRecord[];
    if (body.paths !== undefined) {
      const byPath = new Map(known.map((f) => [f.path, f]));
      chosen = [];
      for (const p of body.paths as string[]) {
        const f = byPath.get(p);
        if (!f) throw badRequest("A path in the list is not a file of this root. Scan the root first, and use paths relative to it.");
        chosen.push(f);
      }
    } else {
      chosen = known.filter((f) => f.state === "pending" || (body.force === true && f.state === "current"));
    }
    chosen = chosen.filter((f) => f.state !== "missing" && f.state !== "refused");
    await this.precheck([root]);
    // Change C13: a bulk request over more files than one scan pass holds waits for a yes (the estimate is bytes / 4)
    const passLimit = this.deps.models.settings().scan?.maxFilesPerPass ?? 50;
    if (body.paths === undefined && body.confirm !== true && chosen.length > passLimit) {
      const tokens = Math.ceil(chosen.reduce((n, f) => n + f.bytes, 0) / 4);
      throw new LearnError(409, "confirm_required", `This request would read ${chosen.length} files, which is more than one scan pass of ${passLimit}. Confirm it to start the extraction.`, { files: chosen.length, tokens });
    }
    return this.launchFiles(chosen, body.force === true);
  }

  /** The scan hands over the files it queued. A refusal leaves the files pending, and the next pass tries again. */
  async queueScan(root: SourceRoot, paths: string[]): Promise<void> {
    try {
      await this.precheck([root]);
    } catch {
      return;
    }
    const wanted = new Set(paths);
    this.launchFiles(this.deps.sources.files(root.id).filter((f) => wanted.has(f.path) && f.state === "pending"), false);
  }

  private launchFiles(chosen: FileRecord[], force: boolean): { started: number; queued: number } {
    const free = Math.max(0, this.files.limit - this.files.active - this.files.waiting);
    const fresh = chosen.filter((f) => !this.active.has(f.sourceId));
    for (const f of fresh) void this.fileResult(f.sourceId, force);
    const started = Math.min(fresh.length, free);
    return { started, queued: fresh.length - started };
  }

  /** Route 33. Starts an extraction of the uncovered text of a session. */
  async extractSession(sessionId: string): Promise<{ started: boolean }> {
    const source = this.sessionSource;
    const session = source?.get(sessionId);
    if (!source || !session) throw notFound(source ? "No session has that id." : "Learning sessions are not available in this build yet.");
    if (this.active.has(sessionId)) throw new LearnError(409, "extraction_busy", "An extraction of this session is already running.");
    const roots: GateRoot[] = [{ id: sessionId, sensitivity: session.sensitivity, hostedConsentAt: null }];
    await this.precheck(roots);
    const plan = this.sessionPlan(sessionId, source);
    const jobs = messageBatches(session.view, this.deps.knowledge.readCoverage(sessionId), chunkBudget(this.deps.models.settings()));
    if (jobs.length === 0) return { started: false };
    this.track(this.run(plan));
    return { started: true };
  }

  /** The automatic start at the end of a teaching turn: it runs when the uncovered text reaches the chunk budget, and a refusal is quiet. */
  async maybeExtractSession(sessionId: string): Promise<boolean> {
    const session = this.sessionSource?.get(sessionId);
    if (!session || this.active.has(sessionId)) return false;
    const budget = chunkBudget(this.deps.models.settings());
    const uncovered = messageBatches(session.view, this.deps.knowledge.readCoverage(sessionId), Number.MAX_SAFE_INTEGER).reduce((n, b) => n + b.tokens, 0);
    if (uncovered < budget) return false;
    try {
      return (await this.extractSession(sessionId)).started;
    } catch {
      return false;
    }
  }

  /** Keeps a run in the set that idle() waits for. A run never rejects, so the catch only guards the log. */
  private track(done: Promise<FileResult>): Promise<FileResult> {
    const tracked: Promise<unknown> = done.catch((e: unknown) => this.deps.log?.(`Extraction failed: ${failureText(e)}`)).finally(() => this.settled.delete(tracked));
    this.settled.add(tracked);
    return done;
  }

  /** Runs one file and returns its result. The routes do not wait for it, and tests and the evaluation script do. */
  fileResult(sourceId: string, force = false): Promise<FileResult> {
    const plan = this.filePlan(sourceId, force);
    if (!plan) return Promise.resolve({ outcome: "failed", notice: "No linked file has that source id." });
    return this.track(this.run(plan));
  }

  // ---- plans ----------------------------------------------------------

  private filePlan(sourceId: string, force: boolean): Plan | null {
    const { sources, knowledge, models } = this.deps;
    const ctx = sources.file(sourceId);
    if (!ctx) return null;
    const { root } = ctx;
    const transcript = root.kind === "claude-transcripts";
    const title = `${root.label}/${ctx.record.path}`;
    return {
      key: sourceId,
      sourceId,
      sessionId: null,
      title,
      shape: transcript ? "transcript" : "notes",
      gateRoots: [root],
      currentRoots: () => {
        const now = sources.file(sourceId);
        return [now ? now.root : root];
      },
      alive: () => sources.file(sourceId) !== null,
      storeUsage: (usage) => {
        appendSourceUsage(knowledge, sourceId, usage);
      },
      load: async () => {
        const read = await sources.readText(sourceId);
        if (!read) return { refusal: "The file is no longer linked." };
        if (!read.text.ok) return { refusal: read.text.message };
        const text = read.text;
        const budget = chunkBudget(models.settings());
        const current = (): FileRecord => sources.file(sourceId)?.record ?? read.record;
        const mark = (result: FileResult, jobs: number, extra: Partial<FileRecord>): void => {
          const patch: Partial<FileRecord> = {
            lastExtractedAt: this.now().toISOString(),
            outcome: result.outcome,
            chunks: jobs,
            ...(result.stats ? { stats: result.stats } : {}),
            // a run without a notice clears the notice of an earlier run, so a fixed failure stops showing its old reason
            notice: text.notice || result.notice || undefined,
            ...(text.pages !== undefined ? { pages: text.pages } : {}),
            ...(text.imagePages !== undefined ? { imagePages: text.imagePages } : {}),
            ...extra,
          };
          sources.updateFile(sourceId, { ...patch, state: extra.state ?? current().state });
        };
        if (transcript) {
          const view = (text.messages ?? []).map((m) => visibleMessage(m.label, m.id, [m.text]));
          const covered = force ? [] : knowledge.readCoverage(sourceId);
          const starts = messageStartLines(view.map((m) => m.lines.join("\n")));
          const batches = messageBatches(view, covered, budget);
          const jobs: Job[] = batches.map((b, i) => {
            const first = view.findIndex((m) => m.messageId === b.messages[0].messageId && m.fp === b.messages[0].fp);
            return {
              view: `File: ${title} (part ${i + 1} of ${batches.length})\n\n${b.view}`,
              chunk: { text: b.view, firstLine: starts[Math.max(0, first)] ?? 1 },
              anchors: new Set(b.ids),
              coverage: b.messages.map((m) => ({ fp: m.fp, tokens: m.tokens })),
            };
          });
          return {
            jobs,
            fileSha256: text.sha256,
            locator: locatorContext(root.kind, text.text),
            checkpoint: false,
            finish: (result, n) => {
              const done = new Set(knowledge.readCoverage(sourceId).map((c) => c.fp));
              const left = view.filter((m) => m.tokens > 0 && !done.has(m.fp)).reduce((t, m) => t + m.tokens, 0);
              mark(result, n, {
                uncoveredTokens: left,
                state: left > 0 ? "pending" : "current",
                ...(result.outcome === "completed" ? { lastExtractedSha256: text.sha256 } : {}),
              });
            },
          };
        }
        const chunks = chunkFile(title, text.text, budget);
        return {
          jobs: chunks.map((c) => ({ view: c.view, chunk: { text: c.text, firstLine: c.segment.firstLine } })),
          fileSha256: text.sha256,
          locator: locatorContext(root.kind, text.text),
          checkpoint: true,
          finish: (result, n) => {
            const complete = result.outcome === "completed";
            mark(result, n, {
              ...(complete ? { lastExtractedSha256: text.sha256 } : {}),
              state: complete ? (text.sha256 === read.record.sha256 ? "current" : "pending") : current().state,
            });
          },
        };
      },
    };
  }

  private sessionPlan(sessionId: string, source: SessionSource): Plan {
    const { knowledge, models } = this.deps;
    const first = source.get(sessionId);
    return {
      key: sessionId,
      sourceId: null,
      sessionId,
      title: first?.title ?? sessionId,
      shape: "session",
      gateRoots: [{ id: sessionId, sensitivity: first?.sensitivity ?? "internal", hostedConsentAt: null }],
      currentRoots: () => [{ id: sessionId, sensitivity: source.get(sessionId)?.sensitivity ?? "client-confidential", hostedConsentAt: null }],
      alive: () => source.get(sessionId) !== null,
      storeUsage: (usage) => source.appendUsage?.(sessionId, usage),
      load: async () => {
        const session = source.get(sessionId);
        if (!session) return { refusal: "The session no longer exists." };
        const batches = messageBatches(session.view, knowledge.readCoverage(sessionId), chunkBudget(models.settings()));
        return {
          jobs: batches.map((b) => ({ view: b.view, chunk: null, anchors: new Set(b.ids), coverage: b.messages.map((m) => ({ fp: m.fp, tokens: m.tokens })) })),
          fileSha256: "",
          locator: null,
          checkpoint: false,
          finish: () => undefined,
        };
      },
    };
  }

  // ---- the run --------------------------------------------------------

  private setPhase(a: Active, phase: Phase): void {
    if (a.row.phase === phase) return;
    a.row.phase = phase;
    this.emit("activity-changed");
  }

  private graph(): { nodes: MergedNode[]; chains: ReturnType<typeof mergeChains> } {
    const s = this.deps.knowledge.store;
    return {
      nodes: mergeNodes(s.readLedger(s.graphFile("nodes.jsonl"), isNodeLine)),
      chains: mergeChains(s.readLedger(s.graphFile("chains.jsonl"), isChainLine)),
    };
  }

  /**
   * Hosted models see no proposition that rests on a client-confidential source without consent. A file takes the
   * sensitivity of its root, a session takes its derived sensitivity, and an identifier that is neither a file nor a
   * session fails closed.
   */
  private visibleTo(cls: ProviderClass): (n: { provenance: { chatId: string }[] }) => boolean {
    if (cls !== "hosted") return () => true;
    const sessions = new Map<string, boolean>();
    const allowed = (id: string): boolean => {
      const f = this.deps.sources.file(id);
      if (f) return rootAllowedFor(f.root, cls);
      let ok = sessions.get(id);
      if (ok === undefined) {
        const session = this.sessionSource?.get(id);
        ok = !!session && session.sensitivity !== "client-confidential";
        sessions.set(id, ok);
      }
      return ok;
    };
    return (n) => n.provenance.every((p) => allowed(p.chatId));
  }

  /** One run of a source or a session. Registration is synchronous, so a second call for the same key meets busy before anything changes. */
  private async run(plan: Plan): Promise<FileResult> {
    if (this.active.has(plan.key)) return { outcome: "busy" };
    const startedAt = this.nextStart();
    const controller = new AbortController();
    const active: Active = {
      row: { id: `ext_${startedAt.toString(36)}${this.key().slice(0, 4)}`, sessionId: plan.sessionId, sourceId: plan.sourceId, title: plan.title, phase: "queued", startedAt: new Date(startedAt).toISOString() },
      controller,
      tally: new RunTally(),
      startedAt,
      plan,
    };
    this.active.set(plan.key, active);
    this.emit("activity-changed");
    this.emit("sources-changed");
    const signal = controller.signal;
    const total: MergeStats = { nodes: 0, chains: 0 };
    let merged = false;
    let result: FileResult;
    let jobCount = 0;
    let loaded: Loaded | null = null;
    try {
      const releaseFile = await this.files.acquire(signal);
      try {
        // the gate is checked before the file is read, and again before each chunk
        this.engines(plan.gateRoots);
        const got = await plan.load();
        if ("refusal" in got) {
          result = { outcome: "failed", notice: got.refusal };
        } else {
          loaded = got;
          jobCount = got.jobs.length;
          result = await this.runJobs(active, plan, got, signal, total, () => (merged = true));
        }
      } finally {
        releaseFile();
      }
    } catch (e) {
      result = signal.aborted || e instanceof AbortedError ? { outcome: "aborted", notice: "The extraction was stopped." } : { outcome: "failed", notice: failureText(e) };
    } finally {
      this.active.delete(plan.key);
    }
    if (merged || total.nodes + total.chains > 0) result.stats = total;
    try {
      if (loaded) loaded.finish(result, jobCount);
    } catch (e) {
      this.deps.log?.(`The file record could not be updated: ${failureText(e)}`);
    }
    try {
      const usage = active.tally.record(startedAt, this.now().toISOString(), Math.max(0, this.now().getTime() - startedAt), result.stats);
      if ((usage.stages.extractor || usage.stages.auditor) && plan.alive()) plan.storeUsage(usage);
    } catch (e) {
      this.deps.log?.(`The usage could not be stored: ${failureText(e)}`);
    }
    this.emit("activity-changed");
    this.emit("sources-changed");
    return result;
  }

  private async runJobs(
    active: Active,
    plan: Plan,
    loaded: Loaded,
    signal: AbortSignal,
    total: MergeStats,
    markMerged: () => void,
  ): Promise<FileResult> {
    let fulfilled = 0;
    let failed = 0;
    let aborted = false;
    let afterMerge: string | null = null;
    let lastError: string | null = null;
    let refusal: string | null = null;
    const add = (s: MergeStats) => {
      total.nodes += s.nodes;
      total.chains += s.chains;
      if (s.droppedChains) total.droppedChains = (total.droppedChains ?? 0) + s.droppedChains;
    };
    const mergeDeps: MergeDeps = { knowledge: this.deps.knowledge, now: this.deps.now ?? (() => new Date()), newKey: this.deps.newKey };
    for (const job of loaded.jobs) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      try {
        const r = await this.runJob(active, plan, loaded, job, signal, mergeDeps);
        add(r.stats);
        markMerged();
        fulfilled++;
        this.emit("graph-changed", { revision: this.deps.knowledge.revision() });
        this.deps.fire?.({ key: active.row.id, sourceId: plan.key, nodeIds: r.nodeIds.slice(0, FIRE_LIMIT) });
      } catch (e) {
        if (signal.aborted || e instanceof AbortedError) {
          aborted = true;
          break;
        }
        if (e instanceof PostMergeError) {
          add(e.committed);
          markMerged();
          afterMerge = e.message;
          this.emit("graph-changed", { revision: this.deps.knowledge.revision() });
        }
        failed++;
        lastError = failureText(e);
        // a refusal of the gate holds for every chunk that follows, so the run ends here
        if (e instanceof LearnError && e.code === "sensitivity_refused") {
          refusal = e.message;
          break;
        }
      }
    }
    if (aborted) return { outcome: "aborted", notice: "The extraction was stopped." };
    if (afterMerge !== null) return { outcome: "failed", notice: `A step after the merge failed, and the lines already written stay. ${afterMerge}` };
    if (refusal !== null) return { outcome: fulfilled > 0 ? "partial" : "failed", notice: refusal };
    if (failed === 0 && loaded.checkpoint) {
      try {
        checkpointFile(mergeDeps, plan.key);
      } catch (e) {
        return { outcome: "failed", notice: `The checkpoint could not be written. ${failureText(e)}` };
      }
    }
    if (failed === 0) return { outcome: "completed" };
    return { outcome: fulfilled > 0 ? "partial" : "failed", notice: lastError ?? undefined };
  }

  /** One chunk or one batch: permit, extract, audit lock, audit, merge. */
  private async runJob(
    active: Active,
    plan: Plan,
    loaded: Loaded,
    job: Job,
    signal: AbortSignal,
    mergeDeps: MergeDeps,
  ): Promise<{ stats: MergeStats; nodeIds: string[] }> {
    this.setPhase(active, "queued");
    const permit = await this.semaphore.acquire(signal);
    try {
      this.setPhase(active, "extracting");
      this.deps.knowledge.store.assertReadable();
      if (!plan.alive()) throw new AbortedError("The source has gone, so nothing was merged.");
      // the slots, the consent and the sensitivity are read again, because they may have changed since the run began
      const engines = this.engines(plan.currentRoots());
      const before = this.graph();
      // the digest goes to the extractor, so it holds only what a model of the extractor's class may see
      const seenByExtractor = this.visibleTo(this.deps.models.providerClassOf(engines.extractor.ref));
      const shown = before.nodes.filter(seenByExtractor);
      const shownIds = new Set(shown.map((n) => n.id));
      const shownChains = before.chains.filter((c) => seenByExtractor(c) && c.premises.every((id) => shownIds.has(id)) && shownIds.has(c.conclusion));
      const extracted = await runExtractor({
        engine: engines.extractor.engine,
        ctx: { shape: plan.shape, anchors: job.anchors, existingIds: new Set(before.nodes.map((n) => n.id)) },
        digest: buildDigest(plan.key, shown, shownChains),
        view: job.view,
        signal,
        onUsage: active.tally.stage("extractor", `${engines.extractor.ref.provider}:${engines.extractor.ref.id}`),
      });
      if (!extracted.findings) throw new Error(`The extractor did not submit valid findings. ${extracted.lastError ?? "It ended without a call of submit_findings."}`);
      const findings = extracted.findings;

      this.setPhase(active, "waiting");
      const release = await this.auditLock.acquire(signal);
      try {
        this.setPhase(active, "auditing");
        if (!plan.alive()) throw new AbortedError("The source has gone, so nothing was merged.");
        const auditing = this.engines(plan.currentRoots());
        const visible = this.visibleTo(auditing.auditorClass);
        const audit = await runAuditor({
          engine: auditing.auditor.engine,
          findings: findings.propositions,
          nodes: this.graph().nodes.filter(visible),
          signal,
          onUsage: active.tally.stage("auditor", `${auditing.auditor.ref.provider}:${auditing.auditor.ref.id}`),
        });
        if (!audit.done) throw new Error("The auditor did not submit a review, so nothing was merged.");
        this.setPhase(active, "merging");
        if (signal.aborted) throw new AbortedError();
        if (!plan.alive()) throw new AbortedError("The source has gone, so nothing was merged.");
        return mergeRun(mergeDeps, {
          sourceId: plan.key,
          shape: plan.shape,
          findings,
          links: audit.links,
          chunk: job.chunk,
          locator: loaded.locator,
          fileSha256: loaded.fileSha256,
          coverage: job.coverage,
        });
      } finally {
        release();
      }
    } finally {
      permit();
    }
  }
}

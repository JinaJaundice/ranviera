// The sources service: the registry of linked roots, their scans, their file records and their passages. The factory reads no global
// configuration. Claude wires it into server/src/learn/http.ts and main.ts at merge (see docs/learning/sources.md).
import fs from "node:fs";
import path from "node:path";
import type { DeletionMode, DeletionStats } from "../../../../shared/learn/knowledge.ts";
import type { AddRoot, FileRecord, Passage, RootChange, RootSummary, ScanResult, SourceRoot } from "../../../../shared/learn/sources.ts";
import { dayKey, norm } from "../../util.ts";
import { SourceError, badRequest, notFound } from "./errors.ts";
import { createCoverageReader, createFileStore, type CoverageReader } from "./files.ts";
import { KIND_DEFAULTS, isSensitivity, isSourceKind } from "./kinds.ts";
import { createFileLedger, type AppendLedger, type SeenLines } from "./ledger.ts";
import { checkRootPath, createDenyList, hasControlChar, resolveInRoot, type RootEnvironment } from "./paths.ts";
import { readPassage } from "./passage.ts";
import { importLearnHarness } from "./readers/learnharness.ts";
import { DEFAULT_LIMITS, readSourceText, type Limits, type SourceText } from "./readers/index.ts";
import { createRegistry, registryFile } from "./registry.ts";
import { appendJsonLines, isObject } from "./store.ts";
import { createScanner } from "./scan.ts";

export interface SourcesOptions {
  /** <data_dir>/learn */
  learnDir: string;
  dataDir: string;
  claudeHome: string;
  projectsRoot: string | null;
  /** the memory_dir setting: a folder, or "auto" for every memory folder under <claude_home>/projects that holds a MEMORY.md */
  memoryDir?: string;
  /** writes the graph ledgers. The default appends to the files of learnDir. */
  appendLedger?: AppendLedger;
  seen?: () => SeenLines;
  coverage?: CoverageReader;
  limits?: Partial<Limits>;
  now?: () => Date;
  /** scan.intervalSeconds and scan.maxFilesPerPass of the learning settings, read fresh at each use */
  settings?: () => { intervalSeconds?: number; maxFilesPerPass?: number };
  /** announces the event sources-changed */
  emit?: (event: "sources-changed", rootId?: string) => void;
  /** true while an extraction is registered, which blocks a deletion */
  extractionRunning?: () => boolean;
  /**
   * Removes the knowledge of a root by the mode, archiving what it removes. It owns the graph files: source records, coverage lines,
   * checkpoint lines and, for delete-nodes, the propositions and arguments that no other source supports. Phase 2 supplies it.
   */
  deleteKnowledge?: (rootId: string, mode: DeletionMode, ctx: { sourceIds: string[] }) => Promise<DeletionStats | void> | DeletionStats | void;
  /** the sensitivity gate of the models phase: true when the cheap slot may read the root. The scan queues nothing without it. */
  canExtract?: (root: SourceRoot) => boolean;
  /** receives the paths that a scan pass queued for extraction (at most maxFilesPerPass) */
  onQueue?: (root: SourceRoot, paths: string[]) => void | Promise<void>;
}

export interface SourcesService {
  list(): RootSummary[];
  get(rootId: string): SourceRoot | null;
  add(body: AddRoot): SourceRoot;
  update(rootId: string, change: RootChange): SourceRoot;
  remove(rootId: string, mode: DeletionMode): Promise<{ mode: DeletionMode; files: number; stats?: DeletionStats }>;
  scan(rootId: string): Promise<ScanResult>;
  /** one pass of the scheduler: every enabled root in scan mode */
  scanPass(): Promise<void>;
  start(): void;
  stop(): void;
  files(rootId: string): FileRecord[];
  passage(sourceId: string, from: number, to: number): Promise<Passage>;
  /** the newest record of a source file and the root that holds it, for the extraction phase */
  file(sourceId: string): { record: FileRecord; root: SourceRoot } | null;
  /** appends a newer line for a file, with the fields of the patch replacing those of the record. Null for an unknown source */
  updateFile(sourceId: string, patch: Partial<FileRecord>): FileRecord | null;
  /** the text of a file as the extractor reads it: the file, the converted PDF or the prose view of a transcript */
  readText(sourceId: string): Promise<{ record: FileRecord; root: SourceRoot; text: SourceText } | null>;
  readonly env: RootEnvironment;
}

const strList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.length > 100 || !v.every((s) => typeof s === "string" && s.trim() && s.length <= 256 && !hasControlChar(s))) {
    throw badRequest(`The field ${name} must be a list of at most 100 non-empty globs.`);
  }
  return v.map((s: string) => s.trim());
};

function findMemoryDirs(claudeHome: string, memoryDir: string | undefined): string[] {
  if (memoryDir && memoryDir !== "auto") return [norm(memoryDir)];
  const projects = path.join(claudeHome, "projects");
  const out: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return out;
  }
  for (const n of names) {
    for (const c of [path.join(projects, n, "memory"), path.join(projects, n)]) {
      if (fs.existsSync(path.join(c, "MEMORY.md"))) {
        out.push(norm(c));
        break;
      }
    }
  }
  return out;
}

export function createSources(opts: SourcesOptions): SourcesService {
  const now = opts.now ?? (() => new Date());
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const claudeHome = norm(opts.claudeHome);
  const deny = createDenyList({ dataDir: opts.dataDir });
  const env: RootEnvironment = {
    claudeHome,
    projectsRoot: opts.projectsRoot ? norm(opts.projectsRoot) : null,
    memoryDirs: () => findMemoryDirs(claudeHome, opts.memoryDir),
    learnDir: norm(opts.learnDir),
    deny,
  };
  const registry = createRegistry({ file: registryFile(opts.learnDir) });
  const files = createFileStore(path.join(opts.learnDir, "cortex", "files.jsonl"));
  const fileLedger = createFileLedger(opts.learnDir);
  const appendLedger = opts.appendLedger ?? fileLedger.append;
  const seen = opts.seen ?? (opts.appendLedger ? undefined : fileLedger.seen);
  const scanner = createScanner({ files, deny, limits, appendLedger, coverage: opts.coverage ?? createCoverageReader(opts.learnDir), now });
  const scanning = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const settings = () => ({ intervalSeconds: 300, maxFilesPerPass: 50, ...opts.settings?.() });
  const emit = (id?: string) => opts.emit?.("sources-changed", id);

  const need = (id: string): SourceRoot => {
    const r = registry.get(id);
    if (!r) throw notFound("No linked source has that id.");
    return r;
  };

  async function scanDetailed(root: SourceRoot, maxQueue?: number) {
    if (scanning.has(root.id)) throw new SourceError(409, "busy", "A scan of this root is already running.");
    scanning.add(root.id);
    try {
      const out = await scanner.scanRoot(root, { maxQueue });
      if (root.kind === "learnharness") {
        const waiting = files.forRoot(root.id).filter((f) => f.state === "pending");
        if (waiting.length) {
          const byPath = new Map(files.forRoot(root.id).map((f) => [f.path, f.sourceId]));
          await importLearnHarness({ folder: root.path, rootId: root.id, label: root.label, idFor: (rel) => byPath.get(rel), appendLedger, seen, now });
          const at = now().toISOString();
          files.append(waiting.map((f) => ({ ...f, state: "current" as const, lastExtractedAt: at, lastExtractedSha256: f.sha256, outcome: "completed" as const })));
          out.queue = [];
        }
      }
      registry.update(root.id, { lastScanAt: out.result.startedAt });
      emit(root.id);
      return out;
    } finally {
      scanning.delete(root.id);
    }
  }

  const summary = (r: SourceRoot): RootSummary => {
    const fs_ = files.forRoot(r.id);
    const n = (s: FileRecord["state"]) => fs_.filter((f) => f.state === s).length;
    return { ...r, counts: { files: fs_.length, pending: n("pending"), current: n("current"), missing: n("missing"), refused: n("refused") } };
  };

  return {
    env,
    list: () => registry.list().map(summary),
    get: (id) => registry.get(id),
    add(body) {
      if (!isObject(body)) throw badRequest("The request body must be a JSON object.");
      if (!isSourceKind(body.kind)) throw badRequest("The kind must be notes, pdf, claude-memory, claude-transcripts, claude-instructions, projects-md or learnharness.");
      const kind = body.kind;
      const checked = checkRootPath(env, kind, body.path as string);
      if (registry.list().some((r) => r.kind === kind && r.path.toLowerCase() === checked.path.toLowerCase())) throw badRequest("That path is already linked as a source of the same kind.");
      let label = body.label === undefined ? path.posix.basename(checked.path) : body.label;
      if (typeof label !== "string" || !label.trim() || label.length > 200 || hasControlChar(label)) throw badRequest("The label must be a non-empty text of at most 200 characters.");
      label = label.trim().replace(/\//g, "-");
      if (body.sensitivity !== undefined && !isSensitivity(body.sensitivity)) throw badRequest("The sensitivity must be public, internal or client-confidential.");
      if (body.mode !== undefined && body.mode !== "manual" && body.mode !== "scan") throw badRequest("The mode must be manual or scan.");
      const root: SourceRoot = {
        id: registry.newId(),
        kind,
        path: checked.path,
        label,
        include: body.include === undefined ? [] : strList(body.include, "include"),
        exclude: body.exclude === undefined ? [] : strList(body.exclude, "exclude"),
        sensitivity: body.sensitivity ?? KIND_DEFAULTS[kind].sensitivity,
        mode: body.mode ?? "manual",
        enabled: true,
        hostedConsentAt: null,
        createdAt: now().toISOString(),
        lastScanAt: null,
      };
      registry.add(root);
      emit(root.id);
      return root;
    },
    update(id, change) {
      const cur = need(id);
      if (!isObject(change)) throw badRequest("The request body must be a JSON object.");
      const patch: Partial<SourceRoot> = {};
      if (change.label !== undefined) {
        if (typeof change.label !== "string" || !change.label.trim() || change.label.length > 200) throw badRequest("The label must be a non-empty text of at most 200 characters.");
        patch.label = change.label.trim().replace(/\//g, "-");
      }
      if (change.include !== undefined) patch.include = strList(change.include, "include");
      if (change.exclude !== undefined) patch.exclude = strList(change.exclude, "exclude");
      if (change.sensitivity !== undefined) {
        if (!isSensitivity(change.sensitivity)) throw badRequest("The sensitivity must be public, internal or client-confidential.");
        patch.sensitivity = change.sensitivity;
      }
      if (change.mode !== undefined) {
        if (change.mode !== "manual" && change.mode !== "scan") throw badRequest("The mode must be manual or scan.");
        patch.mode = change.mode;
      }
      if (change.enabled !== undefined) {
        if (typeof change.enabled !== "boolean") throw badRequest("The field enabled must be true or false.");
        patch.enabled = change.enabled;
      }
      if (change.hostedConsent !== undefined) {
        if (typeof change.hostedConsent !== "boolean") throw badRequest("The field hostedConsent must be true or false.");
        patch.hostedConsentAt = change.hostedConsent ? now().toISOString() : null;
      }
      const next = registry.update(cur.id, patch)!;
      emit(cur.id);
      return next;
    },
    async remove(id, mode) {
      const root = need(id);
      if (opts.extractionRunning?.()) throw new SourceError(409, "extraction_running", "An extraction is running. Wait for it to finish before unlinking a source.");
      if (scanning.has(id)) throw new SourceError(409, "busy", "A scan of this root is running. Try again when it has finished.");
      if (!opts.deleteKnowledge) throw new SourceError(500, "not_available", "Deleting the knowledge of a root is not available in this build.");
      const records = files.forRoot(id);
      const sourceIds = records.map((f) => f.sourceId);
      const stats = (await opts.deleteKnowledge(id, mode, { sourceIds })) ?? undefined;
      const archive = path.join(opts.learnDir, "archive", dayKey(now()));
      // the knowledge deletion may already have archived and removed the file records of these sources, so the count is
      // taken before it ran and the removal below takes whatever records remain
      files.removeRoot(id, path.join(archive, "files.jsonl"));
      appendJsonLines(path.join(archive, "source-roots.jsonl"), [root]);
      registry.remove(id);
      emit(id);
      return { mode, files: records.length, ...(stats ? { stats } : {}) };
    },
    async scan(id) {
      return (await scanDetailed(need(id))).result;
    },
    async scanPass() {
      const { maxFilesPerPass } = settings();
      for (const root of registry.list()) {
        if (!root.enabled || root.mode !== "scan" || scanning.has(root.id)) continue;
        try {
          const { queue } = await scanDetailed(root, maxFilesPerPass);
          if (queue.length && opts.canExtract?.(root)) await opts.onQueue?.(root, queue);
        } catch {
          // A failed pass is tried again at the next interval. A manual scan shows the error.
        }
      }
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void this.scanPass(), Math.max(10, settings().intervalSeconds ?? 300) * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    files: (id) => (need(id), files.forRoot(id)),
    file(sourceId) {
      const record = files.all().get(sourceId);
      const root = record ? registry.get(record.rootId) : null;
      return record && root ? { record, root } : null;
    },
    updateFile(sourceId, patch) {
      const record = files.all().get(sourceId);
      if (!record) return null;
      const next: FileRecord = { ...record, ...patch, sourceId: record.sourceId, rootId: record.rootId, path: record.path };
      files.append([next]);
      return next;
    },
    async readText(sourceId) {
      const record = files.all().get(sourceId);
      const root = record ? registry.get(record.rootId) : null;
      if (!record || !root) return null;
      const rootIsFile = fs.existsSync(root.path) && fs.lstatSync(root.path).isFile();
      const abs = resolveInRoot(deny, root.path, record.path, rootIsFile);
      return { record, root, text: await readSourceText(root.kind, abs, limits) };
    },
    passage: (sourceId, from, to) => readPassage({ files, deny, limits, getRoot: (i) => registry.get(i) }, sourceId, from, to),
  };
}

export { handleSources } from "./http.ts";

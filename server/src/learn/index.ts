// The composition root of the learning upgrade. It creates each phase's service with the paths of the configuration,
// connects the services to one another and relays their events onto the existing stream (docs/CONTRACTS.md,
// "Shared files and registrations", 1 November 2026). Each service reads no global configuration of its own.
// The adapters in ./adapters implement the interfaces that the runtime and the method take as injected dependencies.
import type { Provider } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { GraphStore } from "../graph.ts";
import { runPython } from "../python.ts";
import type { StreamMessage } from "../../../shared/types.ts";
import type { LearnEventName, LearnStreamMessage } from "../../../shared/learn/events.ts";
import type { ClaudeCodeStatus } from "../../../shared/learn/models.ts";
import type { SourceRoot } from "../../../shared/learn/sources.ts";
import {
  createBrainEvents,
  createExtractionActivity,
  createKnowledgeDeletion,
  createKnowledgeReader,
  createModelResolver,
  createPathPolicy,
  createSessionSensitivity,
  createSessionSource,
  createSummariser,
  createTargetResolver,
  type BrainEvents,
  type EventSink,
} from "./adapters/index.ts";
import { createExtract, createExtractModels, type ExtractFire, type ExtractService } from "./extract/index.ts";
import { createJobModels, createJobs, createWake, type JobsService } from "./jobs/index.ts";
import { createKnowledge, type Knowledge } from "./knowledge/index.ts";
import { createMethodService, type MethodService } from "./method/index.ts";
import { claudeCodeStatus, createClaudeCodeProvider, findClaudeExecutable, type ClaudeCodeProvider } from "./models/claude-code/index.ts";
import { gateDecision, rootAllowedFor, sensitivityRefusal } from "./models/gate.ts";
import { createModelsService, type ModelsService } from "./models/index.ts";
import { resolveSlots } from "./models/slots.ts";
import { writeClaimAssertions } from "./ratify-writer.ts";
import type { ActivityProviders } from "./runtime/deps.ts";
import { createSessionService, type SessionService } from "./runtime/index.ts";
import { createSources, type SourcesService } from "./sources/index.ts";

export interface LearnDeps {
  cfg: Config;
  graph: GraphStore;
  broadcast: (msg: StreamMessage) => void;
  /** the person named on a ratification. The default is the configured actor, or "the owner". */
  actor?: () => string;
  /** receives the event learn.extract after each merge, in addition to the brain view event */
  fire?: (event: ExtractFire) => void;
  /** where the brain view events learn.turn, learn.answer and learn.extract go. The event hub satisfies it. */
  events?: EventSink;
  /** providers added to the model collection after the Claude Code provider. A test registers a scripted provider here. */
  extraProviders?: Provider[];
  /** the environment that the keys store reads. It defaults to process.env */
  env?: NodeJS.ProcessEnv;
  ignoreEnvKeys?: boolean;
  /** the probe of the Claude Code CLI, for tests */
  claudeCodeStatus?: () => Promise<ClaudeCodeStatus>;
  /** the claude executable, for tests. The default searches the configured path, PATH and the usual places. */
  findClaude?: () => string | null;
  /** the rebuild of the graph after a ratification, for tests. The default runs the build command. */
  rebuild?: () => Promise<void>;
  /** providers of the jobs phase. The activity members of extraction are added to them. */
  activity?: ActivityProviders;
  /** the folder that the file tools reach for a Claude Code or local model. It defaults to the home folder. */
  homeDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** The services of the learning upgrade, created once per server. */
export class LearnRuntime {
  readonly cfg: Config;
  readonly models: ModelsService;
  readonly claudeCode: ClaudeCodeProvider;
  readonly knowledge: Knowledge;
  readonly sources: SourcesService;
  readonly extract: ExtractService;
  readonly method: MethodService;
  readonly sessions: SessionService;
  /** background jobs: the researcher and the PDF reader (Phase 10) */
  readonly jobs: JobsService;
  readonly brain: BrainEvents;
  /** The activity providers of the runtime. The jobs phase adds its members here, and the runtime reads them at each call. */
  readonly activity: ActivityProviders;
  private readonly deps: LearnDeps;
  private started = false;
  private lockedOut = false;

  constructor(deps: LearnDeps) {
    this.deps = deps;
    const cfg = (this.cfg = deps.cfg);
    const learnDir = cfg.learn_dir ?? `${cfg.data_dir}/learn`;
    const authFile = cfg.auth_file ?? `${cfg.data_dir}/auth.json`;
    const findExe = () => findClaudeExecutable({ claudeCmd: cfg.claude_cmd ?? null });
    const findClaude = deps.findClaude ?? findExe;
    const log = deps.log ?? (() => {});
    const now = deps.now ?? Date.now;

    // The Claude Code provider needs the names that the key store injected, and the key store lives in the models
    // service, which needs the provider. The closure reads the service once it exists.
    let models: ModelsService | null = null;
    this.claudeCode = createClaudeCodeProvider({
      findExecutable: findExe,
      injectedNames: () => models?.keys.injectedNames() ?? [],
    });
    models = this.models = createModelsService({
      authFile,
      learnDir,
      env: deps.env,
      ignoreEnvKeys: deps.ignoreEnvKeys,
      extraProviders: [this.claudeCode.provider, ...(deps.extraProviders ?? [])],
      claudeCodeStatus: deps.claudeCodeStatus ?? (() => claudeCodeStatus({ exe: findExe(), enabled: true, allowBackground: false })),
      emit: (event) => this.emit(event),
    });

    this.brain = createBrainEvents(deps.events, log);

    this.knowledge = createKnowledge({
      learnDir,
      extractionRegistered: () => this.extract?.registered() ?? false,
      // a turn or a job that computes blocks the deletion, and a deleted session takes its jobs with it as the session route does
      chatBusy: (id) => (this.sessions?.turns.isRunning(id) ?? false) || (this.jobs?.activity.computingJobs(id).length ?? 0) > 0,
      deleteChat: (id) => {
        this.jobs?.activity.removeJobs(id);
        void this.sessions?.store.archive(id);
        this.sessions?.turns.forget(id);
      },
      ratify: {
        writeAssertions: (claim) =>
          writeClaimAssertions(deps.graph.getGraph(), cfg.profile_dir ?? `${cfg.data_dir}/profile`, claim, this.actor(), new Date().toISOString().slice(0, 10)),
        rebuild:
          deps.rebuild ??
          (async () => {
            const b = await runPython(cfg, ["build"]);
            if (b.code !== 0) throw new Error("The graph could not be rebuilt after the ratification.");
            deps.graph.reload(true);
          }),
      },
    });

    this.sources = createSources({
      learnDir,
      dataDir: cfg.data_dir,
      claudeHome: cfg.claude_home,
      projectsRoot: cfg.projects_root,
      memoryDir: cfg.memory_dir,
      settings: () => this.models.settings.read().scan ?? {},
      emit: (event, root) => this.emit(event, root ? { root } : {}),
      deleteKnowledge: (_rootId, mode, ctx) => this.knowledge.deleteSources(ctx.sourceIds, mode),
      extractionRunning: () => this.extract?.registered() ?? false,
      canExtract: (root) => this.cheapSlotMayRead(root),
      onQueue: (root, paths) => this.extract.queueScan(root, paths),
    });

    this.extract = createExtract({
      knowledge: this.knowledge,
      sources: this.sources,
      models: createExtractModels(this.models),
      emit: (event, extra) => this.emit(event, extra),
      fire: (event) => {
        this.brain.extract(event);
        deps.fire?.(event);
      },
    });

    // the runtime and the method
    const sensitivity = createSessionSensitivity({ knowledge: this.knowledge, sources: this.sources, homeDir: deps.homeDir, session: (id) => this.sessions?.store.get(id) });
    const resolver = createModelResolver({ models: this.models, claudeCode: this.claudeCode, findClaude, gateRoots: (s) => sensitivity.gateRoots(s), now });
    const reader = createKnowledgeReader({
      knowledge: this.knowledge,
      sources: this.sources,
      settings: () => this.models.settings.read(),
      sessionSensitivity: sensitivity,
      session: (id) => this.sessions?.store.get(id),
      extracting: (id) => this.extract.runs().some((r) => r.sessionId === id),
    });
    this.method = createMethodService({
      learnDir,
      // the store belongs to the session service, which takes the hooks of this service, so the calls go through a delegate
      store: {
        get: (id) => this.sessions.store.get(id),
        setTree: (id, tree) => this.sessions.store.setTree(id, tree),
        appendMessages: (id, messages) => this.sessions.store.appendMessages(id, messages),
      },
      policy: createPathPolicy(this.sources),
      knowledge: reader,
      settings: {
        tools: () => this.models.settings.read().agent?.tools ?? {},
        promptSwitches: () => this.models.settings.read().agent?.prompts ?? {},
        clearPromptSwitch: (segment) =>
          void this.models.settings.update((cur) => {
            const prompts = { ...(cur.agent?.prompts ?? {}) };
            delete prompts[segment];
            return { ...cur, agent: { ...cur.agent, prompts } };
          }),
      },
      targets: createTargetResolver(reader, this.knowledge),
      // the jobs service needs the session store and turns, which are built after this service, so dispatch goes through a delegate
      // a research call sends text to a web search provider, so it meets the gate as a hosted model whatever the cheap slot holds
      jobs: {
        dispatch: (request) => {
          if (request.kind === "research") {
            const record = this.sessions.store.get(request.sessionId);
            const roots = record ? sensitivity.gateRoots(record) : [{ id: request.sessionId, sensitivity: "client-confidential" as const, hostedConsentAt: null }];
            const decision = gateDecision("hosted", roots);
            if (!decision.allowed) return { refused: sensitivityRefusal(decision).message };
          }
          return this.jobs.dispatcher.dispatch(request);
        },
      },
      events: { answer: (e) => this.brain.answer(e) },
      // the teacher takes over after the probe: the handoff marker makes a continue input valid
      wake: (id) =>
        void this.sessions.input(id, { type: "continue" }).catch((e: unknown) => log(`The teacher did not start for ${id}: ${e instanceof Error ? e.message : String(e)}`)),
      now,
      homeDir: deps.homeDir,
      log,
    });
    const hooks = this.method.runtimeHooks();
    this.activity = { ...(deps.activity ?? {}), ...createExtractionActivity(this.extract) };
    this.sessions = createSessionService({
      learnDir,
      models: resolver,
      composer: hooks.composer,
      summariser: createSummariser(),
      knowledge: reader,
      deletion: createKnowledgeDeletion(this.knowledge, this.extract),
      settings: {
        compactionThresholdTokens: () => {
          const v = this.models.settings.read().compaction?.thresholdTokens;
          return typeof v === "number" && Number.isFinite(v) ? Math.max(32_000, Math.round(v)) : 150_000;
        },
      },
      emit: (message) => deps.broadcast(message),
      activity: this.activity,
      now,
      grader: hooks.grader,
      onInput: hooks.onInput,
      onSettled: (id) => {
        hooks.onSettled?.(id);
        this.jobs.onSettled(id);
        this.afterTurn(id);
      },
      log,
    });
    this.extract.setSessionSource(createSessionSource(this.sessions.store, sensitivity));

    // background jobs share the three permits of extraction through the process semaphore
    this.jobs = createJobs({
      learnDir,
      readOnly: () => this.readOnly,
      store: this.sessions.store,
      turns: this.sessions.turns,
      wake: createWake(this.sessions.store, this.sessions.turns),
      // a job takes the sensitivity of its session, so a hosted model for the cheap or vision slot meets the same gate as the session
      models: createJobModels(this.models, (sessionId, providerClass) => {
        const record = this.sessions.store.get(sessionId);
        const roots = record ? sensitivity.gateRoots(record) : [{ id: sessionId, sensitivity: "client-confidential" as const, hostedConsentAt: null }];
        const decision = gateDecision(providerClass, roots);
        return decision.allowed ? null : sensitivityRefusal(decision).message;
      }),
      keys: this.models.keys,
      policy: createPathPolicy(this.sources),
      emit: (message) => deps.broadcast(message),
      homeDir: deps.homeDir,
      log,
    });
    // the runtime reads the activity providers at each call, so the jobs members join the same object
    Object.assign(this.activity, this.jobs.activity);
  }

  /**
   * True when another live process holds cortex/writer.lock. The flag is set at start and lasts for the life of the
   * process: every learning request other than GET answers 409 busy, and no scan, job or extraction starts.
   */
  get readOnly(): boolean {
    return this.lockedOut;
  }

  /** The brain view event of a settled turn, and the automatic extraction of the teacher text that no run has covered yet. */
  private afterTurn(sessionId: string): void {
    const record = this.sessions.store.get(sessionId);
    if (!record) return;
    this.brain.turn(record);
    if (this.lockedOut || record.kind === "practice" || this.models.settings.read().graph?.enabled === false) return;
    void this.extract.maybeExtractSession(sessionId).catch(() => false);
  }

  /** The cheap slot reads linked sources for extraction, so the gate decides whether its provider may read the root. */
  private cheapSlotMayRead(root: SourceRoot): boolean {
    const cheap = resolveSlots(this.models.settings.read()).cheap;
    if (!cheap) return false;
    return rootAllowedFor(root, this.models.providerClassOf(cheap));
  }

  private actor(): string {
    return this.deps.actor?.() ?? this.cfg.oversight_actor ?? "the owner";
  }

  /** Relays one learning event onto GET /api/stream. An event carries the fact and never the data. */
  emit(event: LearnEventName, extra: Omit<LearnStreamMessage, "type" | "event"> = {}): void {
    this.deps.broadcast({ type: "learn", event, ...extra });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.knowledge.acquireLock();
    } catch (e) {
      // another process writes the folder: the runtime still starts, and every write to the graph refuses until that process ends
      this.deps.log?.(`The learning graph is read only: ${e instanceof Error ? e.message : String(e)}`);
      this.lockedOut = true;
    }
    const lock = this.sessions.start();
    if (!lock.acquired) {
      this.deps.log?.("Another process holds the writer lock of the learning folder.");
      this.lockedOut = true;
    }
    if (this.lockedOut) return;
    this.sources.start();
    this.jobs.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.sources.stop();
    this.jobs.stop();
    for (const t of this.sessions.turns.running()) this.sessions.turns.abort(t.sessionId);
    this.extract.abort();
    this.sessions.stop();
    this.claudeCode.dispose();
    this.knowledge.releaseLock();
  }
}

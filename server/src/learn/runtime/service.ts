// The session service: the store, turns, compaction, activity, deletion and
// export behind one object. The factory takes explicit paths and injected
// dependencies and reads no global configuration.
import type {
  CoverageBlock,
  CreateSession,
  DeletionMode,
  DeletionStats,
  InputEvent,
  ModelRef,
  SessionDetail,
  SessionPricing,
  SessionRecord,
  SessionSummary,
  ThinkingLevel,
} from "../../../../shared/learn/index.ts";
import { createActivity, type Activity } from "./activity.ts";
import { createCompactionService, type CompactionService } from "./compaction.ts";
import { TEXT_LABEL, wrapUntrusted } from "../untrusted.ts";
import type {
  ActivityProviders,
  AgentComposer,
  Emit,
  KnowledgeDeletion,
  KnowledgeReader,
  ModelResolver,
  RuntimeSettings,
  Summariser,
} from "./deps.ts";
import { RuntimeError, badRequest, notFound } from "./errors.ts";
import { markdownFileName, sessionToMarkdown } from "./export-md.ts";
import { newMessageId } from "./ids.ts";
import { activeProblemOf, danglingQuestions, phaseOf } from "./scans.ts";
import { createSessionStore, type SessionStore } from "./store.ts";
import { createTurnService, type SubmitResult, type TurnDeps, type TurnService } from "./turns.ts";
import { acquireWriterLock, releaseWriterLock, type LockResult } from "./writer-lock.ts";

export interface RuntimeDeps {
  learnDir: string;
  models: ModelResolver;
  composer: AgentComposer;
  summariser: Summariser;
  knowledge: KnowledgeReader;
  deletion: KnowledgeDeletion;
  settings: RuntimeSettings;
  emit: Emit;
  activity?: ActivityProviders;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** called after a turn settles */
  onSettled?: (sessionId: string) => void;
  /** replaces the default grader of choice answers (the method phase) */
  grader?: TurnDeps["grader"];
  /** called after an input has been saved (the method phase writes outcomes) */
  onInput?: (sessionId: string) => void;
  flushMs?: number;
  guardMs?: number;
  toolTimeoutMs?: number;
  toolGraceMs?: number;
  log?: (line: string) => void;
}

export interface SessionService {
  store: SessionStore;
  turns: TurnService;
  compaction: CompactionService;
  activity: Activity;
  list(): SessionSummary[];
  create(body: CreateSession): SessionRecord;
  detail(id: string): SessionDetail;
  rename(id: string, title: unknown): SessionRecord;
  setSettings(id: string, body: { model?: unknown; thinkingLevel?: unknown }): SessionRecord;
  input(id: string, input: InputEvent): Promise<SubmitResult>;
  markdown(id: string): { fileName: string; body: string };
  remove(id: string, mode: unknown): Promise<{ deleted: true; stats: DeletionStats }>;
  /** Takes the writer lock of the learning folder. */
  start(): LockResult;
  stop(): void;
}

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const MAX_GRAPH_CONTEXT = 64;
const DELETION_POLL_MS = 50;
const DELETION_WAIT_MS = 10_000;

const emptyCoverage = (): CoverageBlock => ({
  totalMessages: 0,
  coveredCount: 0,
  uncoveredCount: 0,
  coveredTokens: 0,
  uncoveredTokens: 0,
  running: false,
  lastFoldedAt: null,
  threshold: 4096,
});

function pricingOf(record: SessionRecord): SessionPricing {
  const turns = record.turns ?? [];
  let cacheRead = 0;
  let denominator = 0;
  for (const t of turns) {
    for (const s of t.steps) {
      cacheRead += s.cacheReadTokens ?? 0;
      denominator += (s.inputTokens ?? 0) + (s.cacheReadTokens ?? 0) + (s.cacheWriteTokens ?? 0);
    }
  }
  // the model phase prices turns from the catalogue, so every turn is unpriced here
  return { cost: null, unpriced: turns.length, turnCosts: turns.map(() => null), cacheHitRate: denominator > 0 ? cacheRead / denominator : null };
}

export function createSessionService(deps: RuntimeDeps): SessionService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store = createSessionStore({ learnDir: deps.learnDir, now });
  const compaction = createCompactionService({
    store,
    models: deps.models,
    summariser: deps.summariser,
    emit: deps.emit,
    thresholdSetting: () => deps.settings.compactionThresholdTokens(),
    now,
  });
  const turns = createTurnService({
    store,
    models: deps.models,
    composer: deps.composer,
    compaction,
    emit: deps.emit,
    now,
    guardMs: deps.guardMs,
    flushMs: deps.flushMs,
    toolTimeoutMs: deps.toolTimeoutMs,
    toolGraceMs: deps.toolGraceMs,
    onSettled: deps.onSettled,
    grader: deps.grader,
    onInput: deps.onInput,
  });
  const activity = createActivity({ turns, store, providers: deps.activity });

  const need = (id: string): SessionRecord => {
    const record = store.get(id);
    if (!record) throw notFound("That session does not exist.");
    return record;
  };

  function summaryOf(r: SessionRecord): SessionSummary {
    return {
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      kind: r.kind === "practice" ? "practice" : "teach",
      messageCount: r.messages.length,
      phase: phaseOf(r.messages),
      pendingQuestion: danglingQuestions(r.messages).length > 0 || (r.kind === "practice" && activeProblemOf(r.messages) !== null),
      busy: turns.isRunning(r.id),
      compacting: compaction.isCompacting(r.id),
    };
  }

  return {
    store,
    turns,
    compaction,
    activity,
    list: () =>
      store
        .list()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summaryOf),
    create(body) {
      const ids = body.graphContext?.propositions;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((i) => typeof i !== "string"))) throw badRequest("The graph context must be a list of proposition identifiers.");
      if (ids && ids.length > MAX_GRAPH_CONTEXT) throw badRequest(`A graph context holds at most ${MAX_GRAPH_CONTEXT} propositions.`);
      if (body.kind !== undefined && body.kind !== "teach" && body.kind !== "practice") throw badRequest("The kind must be teach or practice.");
      const strong = deps.models.strongSlot();
      const messages = [];
      if (ids && ids.length) {
        const picked = deps.knowledge.contextFor(ids, strong?.providerClass ?? "hosted");
        if (picked.propositions.length) {
          const lines = picked.propositions.map((p) => `- ${p.name} (${p.id}): ${p.statement}`);
          const chains = picked.chains.map((c) => `- ${c.premises.join(" and ")} together support ${c.conclusion}`);
          messages.push({
            role: "custom" as const,
            id: newMessageId(now()),
            customType: "graph-context" as const,
            content: [
              "Context that the learner selected from the knowledge graph before the session began. Treat it as injected context and not as something the learner said.",
              wrapUntrusted(["Propositions:", ...lines, ...(chains.length ? ["Arguments among them:", ...chains] : [])].join("\n"), TEXT_LABEL),
            ].join("\n"),
            display: true,
            details: { propositions: picked.propositions, chains: picked.chains },
            timestamp: now(),
          });
        }
      }
      // a new session copies the strong slot's model and level, and stamps nothing when no slot is set
      const created = store.create({
        title: body.title,
        kind: body.kind,
        settings: strong ? { model: strong.model, ...(strong.thinkingLevel ? { thinkingLevel: strong.thinkingLevel } : {}) } : undefined,
        messages,
      });
      deps.emit({ type: "learn", event: "sessions-changed" });
      return created;

    },
    detail(id) {
      const session = need(id);
      return {
        session,
        pricing: pricingOf(session),
        turnInFlight: turns.isRunning(id),
        turnError: turns.turnError(session),
        compacting: compaction.isCompacting(id),
        coverage: deps.knowledge.coverageOf?.(session) ?? { ...emptyCoverage(), totalMessages: session.messages.length },
        sensitivity: deps.knowledge.sensitivityOf?.(session) ?? "public",
      };
    },
    rename(id, title) {
      need(id);
      if (typeof title !== "string") throw badRequest("The title must be text.");
      const renamed = store.rename(id, title);
      deps.emit({ type: "learn", event: "sessions-changed" });
      return renamed;
    },
    setSettings(id, body) {
      const record = need(id);
      let model: ModelRef | undefined;
      if (body.model !== undefined && body.model !== null) {
        const m = body.model as Partial<ModelRef>;
        if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || !m.provider || !m.id) throw badRequest("The model must have a provider and an id.");
        model = { provider: m.provider, id: m.id };
      }
      let level: ThinkingLevel | undefined;
      if (body.thinkingLevel !== undefined && body.thinkingLevel !== null) {
        if (!LEVELS.includes(body.thinkingLevel as ThinkingLevel)) throw badRequest(`The thinking level must be one of ${LEVELS.join(", ")}.`);
        level = body.thinkingLevel as ThinkingLevel;
      }
      const stored = deps.models.validate(model, level, record);
      const next = store.setSettings(id, stored);
      deps.emit({ type: "learn", event: "record-changed", session: id });
      return next;
    },
    input: (id, input) => turns.submit(id, input),
    markdown(id) {
      const record = need(id);
      return { fileName: markdownFileName(record.title), body: sessionToMarkdown(record) };
    },
    async remove(id, mode) {
      if (mode !== "preserve-graph" && mode !== "delete-nodes") {
        throw badRequest("Give the mode preserve-graph or delete-nodes. There is no default.");
      }
      const record = need(id);
      const gates = () => {
        if (turns.isRunning(id)) {
          throw new RuntimeError(409, "A turn is running for this session. Stop it before deleting the session.", "turn_running");
        }
        const jobs = deps.activity?.computingJobs?.(id) ?? [];
        if (jobs.length) throw new RuntimeError(409, "A job of this session is still computing. Stop it before deleting the session.", "job_running", { jobs });
      };
      gates();
      if (deps.deletion.extractionRunning(id)) {
        deps.deletion.abortExtraction(id);
        let waited = 0;
        while (deps.deletion.extractionRunning(id) && waited < DELETION_WAIT_MS) {
          await sleep(DELETION_POLL_MS);
          waited += DELETION_POLL_MS;
        }
        if (deps.deletion.extractionRunning(id)) {
          throw new RuntimeError(503, "An extraction of this session did not stop in time. Try again in a moment.", "extraction_busy");
        }
      }
      // the gates are checked again immediately before the purge
      gates();
      // graph traces first, then job records, then the session file last: a crash leaves a deletable session, never the reverse
      const stats = await deps.deletion.deleteSession(record.id, mode as DeletionMode);
      deps.activity?.removeJobs?.(id);
      store.archive(id);
      turns.forget(id);
      deps.emit({ type: "learn", event: "sessions-changed" });
      return { deleted: true, stats };
    },
    start: () => acquireWriterLock(deps.learnDir, deps.log),
    stop: () => releaseWriterLock(deps.learnDir),
  };
}

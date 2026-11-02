// Interfaces of the services that the runtime takes as injected dependencies.
// Other phases supply the real implementations at merge, and tests supply fakes.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { FinishTurn, StreamFn } from "@earendil-works/pi-agent-core";
import type { AnyTool } from "./tools/define.ts";
import type {
  ActivityItem,
  CallUsage,
  CoverageBlock,
  DeletionMode,
  DeletionStats,
  LearnStreamMessage,
  ModelRef,
  ProviderClass,
  SessionRecord,
  Sensitivity,
  ThinkingLevel,
} from "../../../../shared/learn/index.ts";

/** A model that is ready to run: the library model, its stream function and the facts the runtime needs. */
export interface ResolvedModel {
  model: Model<Api>;
  ref: ModelRef;
  thinkingLevel: ThinkingLevel;
  providerClass: ProviderClass;
  streamFn: StreamFn;
  /** tokens, null when the window is unknown */
  contextWindow: number | null;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

/** Supplied by the models phase. Every method throws a RuntimeError that carries the refusal envelope. */
export interface ModelResolver {
  /** The model of a session: its own setting, else the strong slot. Checks slot, key, consent and gate. */
  forSession(session: SessionRecord): ResolvedModel;
  /** The cheap slot, used for summaries. */
  cheap(): ResolvedModel;
  /** The strong slot as it stands, for the birth stamp of a new session. Null when no slot is set. */
  strongSlot(): { model: ModelRef; thinkingLevel?: ThinkingLevel; providerClass: ProviderClass } | null;
  /** Checks a model choice for a session (gate included) and returns the stored form with the level clamped. */
  validate(ref: ModelRef | undefined, level: ThinkingLevel | undefined, session: SessionRecord): { model?: ModelRef; thinkingLevel?: ThinkingLevel };
}

/** What a role needs to run one turn. The method phase supplies the roles and their tools. */
export interface ComposedAgent {
  role: string;
  systemPrompt: string;
  tools: AnyTool[];
  /** Ends the run after a turn, for example when a question was posed cleanly. */
  finishTurn?: FinishTurn;
}

export interface AgentComposer {
  compose(input: {
    session: SessionRecord;
    model: ResolvedModel;
    /** Reads the record as it stands now, for gates that must see the turn's own writes. */
    record: () => SessionRecord;
  }): ComposedAgent;
}

/** Writes a summary with the cheap model. The runtime builds the prompt and judges the result. */
export type Summariser = (request: {
  system: string;
  prompt: string;
  model: ResolvedModel;
  signal?: AbortSignal;
}) => Promise<{ text: string; stopReason: string; usage?: CallUsage }>;

/** A linked root that the gate allows for a provider class. */
export interface AllowedRoot {
  id: string;
  label: string;
  /** absolute, forward slashes */
  path: string;
  kind: string;
  sensitivity: Sensitivity;
}

/** Supplied by the linked sources phase. */
export interface PathPolicy {
  /** The deny list. True when the path names or lies inside a protected location. */
  isDenied(absPath: string): boolean;
  /** The linked roots that the gate allows for a model of this class. */
  allowedRoots(providerClass: ProviderClass): AllowedRoot[];
}

export interface SourceListing {
  id: string;
  label: string;
  kind: "chat" | "notes";
  propositionCount: number;
  lastAt: string | null;
}

export interface PropositionListing {
  id: string;
  name: string;
  held: "unknown" | "shaky" | "held";
  support: number;
}

export interface PropositionDetail {
  id: string;
  name: string;
  statement: string;
  aliases: string[];
  sources: { id: string; label: string }[];
}

/** Supplied by the knowledge core. The class decides what a hosted model may see. */
export interface KnowledgeReader {
  listSources(providerClass: ProviderClass): SourceListing[];
  listPropositions(sourceOrSessionId: string, providerClass: ProviderClass): PropositionListing[];
  getProposition(id: string, providerClass: ProviderClass): PropositionDetail | null;
  /** The propositions and the chains among them for a graph context marker. Unknown ids are left out. */
  contextFor(
    ids: string[],
    providerClass: ProviderClass,
  ): { propositions: { id: string; name: string; statement: string }[]; chains: { id: string; premises: string[]; conclusion: string }[] };
  coverageOf?(session: SessionRecord): CoverageBlock;
  sensitivityOf?(session: SessionRecord): Sensitivity;
}

/** Supplied by the knowledge core. */
export interface KnowledgeDeletion {
  extractionRunning(sessionId: string): boolean;
  abortExtraction(sessionId: string): void;
  deleteSession(sessionId: string, mode: DeletionMode): DeletionStats | Promise<DeletionStats>;
}

/** Supplied by the jobs phase and the extraction phase. Every member is optional. */
export interface ActivityProviders {
  jobs?(): ActivityItem[];
  extractions?(): ActivityItem[];
  /** Jobs of a session that are still computing. */
  computingJobs?(sessionId: string): string[];
  removeJobs?(sessionId: string): void;
  abortJob?(id: string): "ok" | "not_found" | "not_running";
  abortExtraction?(id: string): void;
}

export interface RuntimeSettings {
  /** The setting of CONTRACTS "Settings and prompt overrides", already sanitised. */
  compactionThresholdTokens(): number;
}

export type Emit = (message: LearnStreamMessage) => void;

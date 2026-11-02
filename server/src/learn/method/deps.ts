// Interfaces of the services that the learning method takes as injected
// dependencies. The runtime, models, knowledge, sources and jobs phases supply
// the real ones at merge, and tests supply fakes.
import type { ProviderClass, ThinkingLevel } from "../../../../shared/learn/index.ts";
import type { PathPolicy, KnowledgeReader } from "../runtime/deps.ts";
import type { SessionStore } from "../runtime/store.ts";

/** The switches of CONTRACTS "Settings and prompt overrides" that the method reads and clears. */
export interface MethodSettings {
  /** agent.tools: research, pdf and explain. An absent key means the default. */
  tools(): Partial<Record<"research" | "pdf" | "explain", boolean>>;
  /** agent.prompts: the segment key with its .md suffix to the switch. */
  promptSwitches(): Record<string, boolean>;
  /** Removes one switch, so that deleting an override never leaves an orphan. */
  clearPromptSwitch(segment: string): void;
}

/** Turns a name or an identifier that a model wrote into the identifier of a proposition. Null means unknown. */
export interface TargetResolver {
  resolve(raw: string, providerClass: ProviderClass): string | null;
}

/** Supplied by the jobs phase. When it is absent, the research and pdf tools answer that they are not available. */
export type DispatchResult = { jobId: string } | { refused: string };

export interface JobDispatcher {
  dispatch(request: {
    kind: "research" | "pdf";
    sessionId: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }): DispatchResult | Promise<DispatchResult>;
}

/** Receives the learning events of CONTRACTS "Turn stream, stream messages and event kinds". */
export interface LearnEvents {
  /** One graded answer or conclusion, fired once for each outcome line. */
  answer(event: { session: string; key: string; target: string[]; tool: string; correct: boolean | null }): void;
}

export interface MethodDeps {
  /** The learning folder, `<data_dir>/learn`. */
  learnDir: string;
  /** The session store of the runtime. The method writes the plan tree and its markers through it. */
  store: Pick<SessionStore, "get" | "setTree" | "appendMessages">;
  policy: PathPolicy;
  knowledge: KnowledgeReader;
  settings: MethodSettings;
  targets?: TargetResolver;
  jobs?: JobDispatcher;
  events?: LearnEvents;
  /** Starts a turn for a session after a handoff marker was saved. The merge wires it to the runtime. */
  wake?: (sessionId: string) => void;
  now?: () => number;
  /** defaults to the home folder of the operating system */
  homeDir?: string;
  /** the folder of the numbered fragments, defaults to the folder beside this file */
  promptsDir?: string;
  log?: (line: string) => void;
}

export type { ThinkingLevel };

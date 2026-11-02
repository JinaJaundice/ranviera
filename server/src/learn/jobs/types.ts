// What the jobs service takes as injected dependencies. The composition root supplies the real ones, and the tests
// supply fakes. Nothing in this folder reads a global configuration.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRef, NativeMessage, ProviderClass, ThinkingLevel } from "../../../../shared/learn/index.ts";
import type { Emit, PathPolicy } from "../runtime/deps.ts";
import type { SessionStore } from "../runtime/store.ts";
import type { TurnService } from "../runtime/turns.ts";
import type { Semaphore } from "../extract/semaphore.ts";
import type { ResizeOptions } from "../images/index.ts";
import type { SearchPin } from "./web/search.ts";

/** A model that is ready to run a background role. */
export interface JobEngine {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  stream: StreamFn;
  ref: ModelRef;
  providerClass: ProviderClass;
  /** whether the model takes images, which decides whether pdf_render is offered */
  imageInput: boolean;
  /** the resize limits of the model for pictures */
  imageLimits?: ResizeOptions;
}

export type JobRole = "researcher" | "pdfReader";

/** The refusal of a role, in the words that the learner sees. */
export interface JobRefusal {
  refused: string;
}

export interface JobModels {
  /** The engine of a role, or a refusal when its slot holds no model, the key is gone or the gate says no. */
  engine(role: JobRole, sessionId: string): JobEngine | JobRefusal | Promise<JobEngine | JobRefusal>;
}

/** The search keys, read fresh on every call so that a key saved in Settings takes effect at once. */
export interface JobKeys {
  effective(name: string): { value: string } | null;
}

/** Starts a turn after the markers were saved, or saves them and starts the turn. A running turn answers with status 409. */
export type WakeFn = (sessionId: string, markers: NativeMessage[]) => Promise<void> | void;

export interface JobsDeps {
  /** the learning folder, <data_dir>/learn */
  learnDir: string;
  /** true while another process holds the writer lock: the sweep and the recovery do not run */
  readOnly?: () => boolean;
  store: Pick<SessionStore, "get" | "appendMessages">;
  turns: Pick<TurnService, "isRunning" | "steer">;
  wake: WakeFn;
  models: JobModels;
  keys: JobKeys;
  policy: PathPolicy;
  emit: Emit;
  /** pins the search engine. Without a pin, Tavily wins when both keys exist. */
  searchPin?: () => SearchPin | undefined;
  /** the three permits for all background model work, shared with the extraction pipeline */
  semaphore?: Semaphore;
  /** defaults to the home folder of the operating system */
  homeDir?: string;
  /** the folder for the downloads of one job, defaults to the system temporary folder */
  tempDir?: string;
  fetch?: typeof fetch;
  /** let the researcher fetch loopback and private addresses. Off in production, on in tests that use a local server. */
  allowPrivateHosts?: boolean;
  /** replaces the web search endpoints, for tests */
  searchEndpoints?: { tavily?: string; brave?: string };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  wakeGraceMs?: number;
  pollMs?: number;
  backoffMs?: number[];
  sweepIntervalMs?: number;
  log?: (line: string) => void;
}

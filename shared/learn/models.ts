// Learning upgrade: model layer, settings and prompts. The source of truth is
// docs/CONTRACTS.md, section "Learning and knowledge (1 November 2026)", and a
// change is made there first.

import type { ThinkingLevel } from "./sessions.ts";

/** Settings and prompt overrides: the three model slots. */
export type ModelSlotName = "strong" | "cheap" | "vision";

/** Settings and prompt overrides: a model named by provider and id. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** Settings and prompt overrides: one slot. An unset retention passes nothing to the library. */
export interface ModelSlot {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  cacheRetention?: "none" | "short" | "long";
}

/** Settings and prompt overrides: roles that run in the background. */
export type BackgroundRole = "researcher" | "extractor" | "auditor" | "pdfReader";

/** Settings and prompt overrides: settings.json, delta shaped and non secret. */
export interface LearnSettings {
  /** a private schema counter */
  version: 1;
  /** both off by default, even when the tool is installed */
  claudeCode?: { enabled?: boolean; enabledAt?: string; allowBackground?: boolean; allowBackgroundAt?: string };
  /** no factory model */
  models?: Partial<Record<ModelSlotName, ModelSlot>>;
  agent?: {
    /** beats the slot */
    models?: Partial<Record<BackgroundRole, { model?: ModelRef; thinkingLevel?: ThinkingLevel }>>;
    /** explain true arms free recall in place of multiple choice */
    tools?: Partial<Record<"research" | "pdf" | "explain", boolean>>;
    /** segment key to switch, none on by default */
    prompts?: Record<string, boolean>;
  };
  customProvider?: CustomProviderSettings;
  /** default 150000, floor 32000 */
  compaction?: { thresholdTokens?: number };
  /** enabled by default, chunk default 4096, floor 500 */
  graph?: { enabled?: boolean; extractionChunkTokens?: number };
  /** Cortex extension, defaults 300 and 50 */
  scan?: { intervalSeconds?: number; maxFilesPerPass?: number };
}

/** Settings and prompt overrides: the custom OpenAI compatible endpoint as stored. */
export interface CustomProviderSettings {
  /** 32 hex */
  credentialBindingId?: string;
  authMode?: "keyless" | "apiKey";
  baseUrl?: string;
  models?: { id: string; image?: boolean; reasoning?: boolean; context?: number; maxTokens?: number }[];
  overrides?: Record<string, { context?: number; maxTokens?: number; reasoning?: boolean }>;
  manualModels?: string[];
  /** Cortex extension: the person states that the endpoint runs on their own machine or network */
  localConfirmedAt?: string | null;
}

/** Model layer: one row of the catalogue. Cost is dollars per million tokens, null for the Claude Code provider and a custom endpoint. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  supportedLevels: ThinkingLevel[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  contextWindow: number | null;
  maxTokens: number | null;
}

/** Model layer: GET /api/learn/models. */
export interface ModelCatalogResponse {
  /** only providers that have a key, sorted by provider and id */
  models: ModelCatalogEntry[];
  /** the strong slot */
  defaults: ModelRef | null;
  rolePins: Partial<Record<BackgroundRole, ModelRef | null>>;
  slots: Record<ModelSlotName, ModelRef | null>;
  providers: { id: string; envVar: string; keyPresent: boolean }[];
}

/** Model layer: status of one key, GET /api/learn/keys. */
export interface AuthKeyStatus {
  /** the environment variable name */
  id: string;
  info: { label: string; description: string; docsUrl: string } | null;
  present: boolean;
  /** the last four characters */
  masked: string | null;
  length: number | null;
  source: "env" | "file" | "none";
  shadowedByEnv: boolean;
}

/** Model layer: GET /api/learn/claude-code. */
export interface ClaudeCodeStatus {
  enabled: boolean;
  state: "meets-minimum" | "not-found" | "version-unchecked" | "update-required";
  allowBackground: boolean;
  minimumVersion: "2.1.316";
  version: string | null;
}

/** Model layer: GET /api/learn/custom-provider, with an ETag header. */
export interface CustomProviderState {
  baseUrl: string | null;
  authMode: "keyless" | "apiKey" | null;
  models: NonNullable<CustomProviderSettings["models"]>;
  overrides: NonNullable<CustomProviderSettings["overrides"]>;
  manualModels: string[];
  keyPresent: boolean;
  keySource: "env" | "file" | "none";
  keyReuseRequired: boolean;
  localConfirmedAt: string | null;
}

/** Request and response shapes: body of POST /api/learn/custom-provider. */
export interface CustomProviderConnect {
  baseUrl: string;
  authMode: "keyless" | "apiKey";
  apiKey?: string;
  reuseKey?: boolean;
  manualModels?: string[];
  localConfirmed?: boolean;
}

/** Request and response shapes: one prompt fragment of GET /api/learn/prompts. */
export interface PromptEntry {
  key: string;
  agent: "prober" | "teacher" | "practice" | "shared" | "base";
  source: string;
  override: string | null;
  enabled: boolean;
  shared: boolean;
}

/** Request and response shapes: GET /api/learn/prompts. A shared fragment appears in each list that includes it, with the same key. */
export interface PromptList {
  prober: PromptEntry[];
  teacher: PromptEntry[];
  practice: PromptEntry[];
}

/** Keys file: one entry of the flat auth.json map, name to value. */
export type AuthFile = Record<string, string>;

/** Keys file: the reserved entry __cortex_custom_provider_binding. */
export interface CustomProviderBinding {
  version: 1;
  id: string;
  baseUrl?: string;
  authMode: "apiKey" | "keyless" | "disabled";
  fileKeyBaseUrl?: string;
}

/** Sensitivity gate and model policy: the class of a model that receives text. */
export type ProviderClass = "claude-code" | "local" | "hosted";

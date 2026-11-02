// The model layer service: keys, settings, the collection of providers, the custom
// endpoint, the catalogue and the checks that a model call needs. It takes explicit
// paths and dependencies and reads no global configuration. Claude wires it into
// server/src/learn/http.ts and server/src/main.ts at merge.
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ClaudeCodeStatus, LearnSettings, ModelCatalogResponse, ModelRef, ProviderClass } from "../../../../shared/learn/models.ts";
import type { LearnEventName } from "../../../../shared/learn/events.ts";
import { buildCatalog, providerKeyPresent, type CatalogDeps } from "./catalog.ts";
import { createCustomService, type CustomService } from "./custom.ts";
import type { LearnError } from "./errors.ts";
import { providerClass } from "./gate.ts";
import { createKeysStore, type KeysStore } from "./keys.ts";
import { createModelRegistry, type ModelRegistry } from "./registry.ts";
import { createSettingsStore, type SettingsStore } from "./settings.ts";
import { checkSlots } from "./slots.ts";
import type { ModelSlotName } from "../../../../shared/learn/models.ts";

export interface ModelsOptions {
  /** the keys file, <data_dir>/auth.json */
  authFile: string;
  /** the learning folder, <data_dir>/learn. Settings are <learnDir>/settings.json */
  learnDir: string;
  /** the environment that the keys store reads and fills. It defaults to process.env */
  env?: NodeJS.ProcessEnv;
  ignoreEnvKeys?: boolean;
  /** the network call of endpoint discovery, for tests */
  fetch?: typeof fetch;
  /** providers added to the collection, for example the Claude Code provider */
  extraProviders?: Provider[];
  /** the status of the Claude Code CLI. Phase 1 supplies it through the claude-code folder */
  claudeCodeStatus?: () => Promise<ClaudeCodeStatus>;
  /** the learning event bus, for the events settings-changed and models-changed */
  emit?: (event: LearnEventName) => void;
  now?: () => Date;
}

export interface ModelsService {
  keys: KeysStore;
  settings: SettingsStore;
  registry: ModelRegistry;
  custom: CustomService;
  catalog(): Promise<ModelCatalogResponse>;
  /** The status of the CLI. When the person has not switched the provider on, nothing is probed and the state is version-unchecked. */
  claudeCodeStatus(): Promise<ClaudeCodeStatus>;
  providerKeyPresent(provider: string): Promise<boolean>;
  /** The first refusal for the slots that a task needs, or null. */
  checkSlots(needed: ModelSlotName[]): Promise<LearnError | null>;
  providerClassOf(model: ModelRef): ProviderClass;
  emit(event: LearnEventName): void;
  now(): Date;
}

export const MINIMUM_CLAUDE_CODE_VERSION = "2.1.316" as const;

export function createModelsService(options: ModelsOptions): ModelsService {
  const keys = createKeysStore({ authFile: options.authFile, env: options.env, ignoreEnvKeys: options.ignoreEnvKeys });
  const settings = createSettingsStore({ file: path.join(options.learnDir, "settings.json") });
  const registry = createModelRegistry({ keys, settings, extraProviders: options.extraProviders });
  const emit = (event: LearnEventName) => options.emit?.(event);
  const custom = createCustomService({ keys, settings, fetch: options.fetch, now: options.now, onChange: () => emit("models-changed") });
  const deps: CatalogDeps = { registry, keys, settings, claudeCodeStatus: options.claudeCodeStatus };

  const claudeCodeStatus = async (): Promise<ClaudeCodeStatus> => {
    const cc: LearnSettings["claudeCode"] = settings.read().claudeCode;
    const flags = { enabled: cc?.enabled === true, allowBackground: cc?.allowBackground === true };
    if (!flags.enabled || !options.claudeCodeStatus) return { state: "version-unchecked", version: null, minimumVersion: MINIMUM_CLAUDE_CODE_VERSION, ...flags };
    return { ...(await options.claudeCodeStatus()), ...flags };
  };

  return {
    keys,
    settings,
    registry,
    custom,
    catalog: () => buildCatalog(deps),
    claudeCodeStatus,
    providerKeyPresent: (provider) => providerKeyPresent(deps, provider),
    checkSlots: (needed) => checkSlots(settings.read(), needed, (p) => providerKeyPresent(deps, p)),
    providerClassOf: (model) => providerClass(model, settings.read().customProvider),
    emit,
    now: options.now ?? (() => new Date()),
  };
}

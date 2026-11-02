// The catalogue of GET /api/learn/models. The source of truth is docs/CONTRACTS.md,
// "Model layer". Only providers that have a key are listed, sorted by provider and id.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ClaudeCodeStatus, LearnSettings, ModelCatalogEntry, ModelCatalogResponse } from "../../../../shared/learn/models.ts";
import { CUSTOM_PROVIDER_ID } from "./endpoint.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "./gate.ts";
import { CUSTOM_KEY_NAME, PROVIDER_KEY_TABLE, type KeysStore } from "./keys.ts";
import type { ModelRegistry } from "./registry.ts";
import { resolveRolePins, resolveSlots, supportedLevels } from "./slots.ts";
import type { SettingsStore } from "./settings.ts";

export interface CatalogDeps {
  registry: ModelRegistry;
  keys: KeysStore;
  settings: SettingsStore;
  /** The Claude Code status. It is called only when the person switched the provider on. */
  claudeCodeStatus?: () => Promise<ClaudeCodeStatus>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** True when a request to this provider would find a key at this moment. */
export async function providerKeyPresent(deps: CatalogDeps, provider: string): Promise<boolean> {
  const settings = deps.settings.read();
  if (provider === CLAUDE_CODE_PROVIDER_ID) {
    if (!deps.registry.extraProviderIds().includes(provider) || settings.claudeCode?.enabled !== true || !deps.claudeCodeStatus) return false;
    return (await deps.claudeCodeStatus()).state !== "not-found";
  }
  if (provider === CUSTOM_PROVIDER_ID) {
    if (!deps.registry.customRegistered()) return false;
    return settings.customProvider?.authMode === "keyless" || deps.keys.effective(CUSTOM_KEY_NAME) !== null;
  }
  return deps.keys.providerKeyPresent(provider) === true;
}

export function catalogEntry(model: Model<Api>): ModelCatalogEntry {
  const unpriced = model.provider === CLAUDE_CODE_PROVIDER_ID || model.provider === CUSTOM_PROVIDER_ID;
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    input: model.input.filter((m): m is "text" | "image" => m === "text" || m === "image"),
    supportedLevels: supportedLevels(model),
    cost: unpriced ? null : { input, output, cacheRead, cacheWrite },
    // the Claude Code provider reports no window until its probe replies
    contextWindow: model.provider === CLAUDE_CODE_PROVIDER_ID ? null : Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null,
    maxTokens: model.provider === CLAUDE_CODE_PROVIDER_ID ? null : Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null,
  };
}

export async function buildCatalog(deps: CatalogDeps): Promise<ModelCatalogResponse> {
  const settings: LearnSettings = deps.settings.read();
  deps.registry.sync();
  const providers: ModelCatalogResponse["providers"] = [];
  for (const row of PROVIDER_KEY_TABLE) providers.push({ id: row.id, envVar: row.envVar, keyPresent: deps.keys.providerKeyPresent(row.id) === true });
  for (const id of deps.registry.extraProviderIds()) providers.push({ id, envVar: "", keyPresent: await providerKeyPresent(deps, id) });
  if (deps.registry.customRegistered()) providers.push({ id: CUSTOM_PROVIDER_ID, envVar: CUSTOM_KEY_NAME, keyPresent: await providerKeyPresent(deps, CUSTOM_PROVIDER_ID) });
  const models: ModelCatalogEntry[] = [];
  for (const p of providers) {
    if (!p.keyPresent) continue;
    for (const m of deps.registry.models.getModels(p.id)) models.push(catalogEntry(m));
  }
  models.sort((a, b) => cmp(a.provider, b.provider) || cmp(a.id, b.id));
  const slots = resolveSlots(settings);
  return { models, defaults: slots.strong, rolePins: resolveRolePins(settings), slots, providers };
}

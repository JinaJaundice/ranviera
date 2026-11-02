// A models collection of @earendil-works/pi-ai with every built in key based provider,
// the custom OpenAI compatible endpoint (provider id custom) and any extra provider
// that the caller passes in. The Claude Code provider is one such extra provider, and
// the merge supplies it. See docs/CONTRACTS.md, "Model layer".
import { createProvider, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "../../../../shared/learn/models.ts";
import { buildCustomModels, CUSTOM_PROVIDER_ID, customUsable, parseBinding } from "./endpoint.ts";
import { BINDING_ENTRY, CUSTOM_KEY_NAME, type KeysStore } from "./keys.ts";
import type { SettingsStore } from "./settings.ts";

export interface ModelRegistryOptions {
  keys: KeysStore;
  settings: SettingsStore;
  /** providers added after the built in ones, for example the Claude Code provider */
  extraProviders?: Provider[];
}

export interface ModelRegistry {
  /** The library collection. Call sync() first when the settings may have changed. */
  readonly models: MutableModels;
  /** Registers or removes the custom endpoint to match the settings and the keys file. Cheap when nothing changed. */
  sync(): void;
  /** One model by provider and id, after sync(). */
  lookup(ref: ModelRef): Model<Api> | undefined;
  getModel(provider: string, id: string): Model<Api> | undefined;
  /** True when the custom endpoint is registered at this moment. */
  customRegistered(): boolean;
  /** Ids of the providers that the caller passed in. */
  extraProviderIds(): string[];
}

export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { keys, settings } = options;
  const models = builtinModels({
    identity: { userAgent: { custom: "ranviera" }, attribution: { name: "Ranviera", url: "https://github.com/JinaJaundice/ranviera" } },
  });
  for (const p of options.extraProviders ?? []) models.setProvider(p);

  let signature = "";
  let registered = false;

  function customProvider(): Provider {
    return createProvider({
      id: CUSTOM_PROVIDER_ID,
      name: "Custom endpoint",
      auth: {
        apiKey: {
          name: "Custom endpoint key",
          // read fresh for every request, and only while the binding still authorises the stored endpoint
          resolve: async () => {
            const current = settings.read().customProvider;
            if (!customUsable(current, parseBinding(keys.rawEntry(BINDING_ENTRY)))) return undefined;
            if (current?.authMode === "keyless") return { auth: { apiKey: "keyless" }, source: "keyless" };
            const key = keys.effective(CUSTOM_KEY_NAME);
            return key ? { auth: { apiKey: key.value }, source: key.source === "env" ? CUSTOM_KEY_NAME : "keys file" } : undefined;
          },
        },
      },
      models: buildCustomModels(settings.read().customProvider ?? {}),
      api: openAICompletionsApi(),
    }) as unknown as Provider;
  }

  function sync(): void {
    const custom = settings.read().customProvider;
    const binding = parseBinding(keys.rawEntry(BINDING_ENTRY));
    const usable = customUsable(custom, binding);
    const next = usable ? JSON.stringify([custom, binding?.id]) : "";
    if (next === signature) return;
    signature = next;
    if (usable) {
      models.setProvider(customProvider());
      registered = true;
    } else {
      models.deleteProvider(CUSTOM_PROVIDER_ID);
      registered = false;
    }
  }
  sync();

  const getModel = (provider: string, id: string) => {
    sync();
    return models.getModel(provider, id);
  };

  return {
    models,
    sync,
    getModel,
    lookup: (ref) => getModel(ref.provider, ref.id),
    customRegistered: () => {
      sync();
      return registered;
    },
    extraProviderIds: () => (options.extraProviders ?? []).map((p) => p.id),
  };
}

// What the pipeline needs from the model layer: the settings, the checks that come before any model call, the engine
// of each stage and the price of a model. The adapter reads the models service, and a test supplies a fake.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { LearnSettings, ModelRef, ProviderClass } from "../../../../shared/learn/models.ts";
import { LearnError } from "../models/errors.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "../models/gate.ts";
import type { ModelsService } from "../models/index.ts";
import type { PriceLookup } from "../models/pricing.ts";
import { resolveLevel, resolveRole } from "../models/slots.ts";
import type { AgentEngine } from "./submit-agent.ts";

export type StageRole = "extractor" | "auditor";

export interface StageEngine {
  engine: AgentEngine;
  ref: ModelRef;
}

export interface ExtractModels {
  settings(): LearnSettings;
  /** The first refusal that applies before a model call, or null: a slot with no model, a provider with no key, or a Claude Code switch that is off. */
  preflight(): Promise<LearnError | null>;
  /** The engine of a stage, or null when its slot holds no model that the library knows. */
  engine(role: StageRole): StageEngine | null;
  providerClassOf(ref: ModelRef): ProviderClass;
  price: PriceLookup;
}

/** Both stages use the cheap slot unless the person pinned a model to a role. */
export function createExtractModels(models: ModelsService): ExtractModels {
  return {
    settings: () => models.settings.read(),
    async preflight() {
      const refused = await models.checkSlots(["cheap"]);
      if (refused) return refused;
      const settings = models.settings.read();
      for (const role of ["extractor", "auditor"] as const) {
        const spec = resolveRole(settings, role);
        if (spec?.model.provider === CLAUDE_CODE_PROVIDER_ID && settings.claudeCode?.allowBackground !== true) {
          return new LearnError(403, "consent_required", "Extraction runs in the background. Allow background use of Claude Code in Settings, under Models and keys, or choose another model for the cheap slot.", {
            consent: "claude-code-background",
          });
        }
      }
      return null;
    },
    engine(role) {
      const spec = resolveRole(models.settings.read(), role);
      if (!spec) return null;
      const model = models.registry.lookup(spec.model) as Model<Api> | undefined;
      if (!model) return null;
      const cacheRetention = spec.cacheRetention;
      const engine: AgentEngine = {
        model,
        thinkingLevel: resolveLevel(model, spec.thinkingLevel),
        stream: (m, context, options) => models.registry.models.streamSimple(m, context, cacheRetention ? { ...options, cacheRetention } : options),
      };
      return { engine, ref: spec.model };
    },
    providerClassOf: (ref) => models.providerClassOf(ref),
    price: (provider, id) => models.registry.getModel(provider, id),
  };
}

// The adapter from the models service to the engines of the two background roles. The researcher takes the cheap slot
// and the PDF reader takes the vision slot. A slot without a model, a provider without a key, a Claude Code provider
// without consent for background use, and a gate that says no all become a refusal in plain words.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderClass } from "../../../../shared/learn/index.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "../models/gate.ts";
import type { ModelsService } from "../models/index.ts";
import { resolveLevel, resolveRole } from "../models/slots.ts";
import type { ResizeOptions } from "../images/index.ts";
import type { JobEngine, JobModels, JobRole } from "./types.ts";

/** Returns the sentence of a refusal when the sensitivity gate does not allow a model of this class for a session. */
export type SessionGate = (sessionId: string, providerClass: ProviderClass) => string | null;

export function createJobModels(models: ModelsService, gate?: SessionGate): JobModels {
  return {
    async engine(role: JobRole, sessionId: string) {
      const slot = role === "researcher" ? "cheap" : "vision";
      const refused = await models.checkSlots([slot]);
      if (refused) return { refused: refused.message };
      const settings = models.settings.read();
      const spec = resolveRole(settings, role);
      if (!spec) return { refused: "No model is set for this task. Choose one in Settings." };
      if (spec.model.provider === CLAUDE_CODE_PROVIDER_ID && settings.claudeCode?.allowBackground !== true) {
        return { refused: "Background jobs run without you. Allow background use of Claude Code in Settings, under Models and keys, or choose another model for this task." };
      }
      const model = models.registry.lookup(spec.model) as Model<Api> | undefined;
      if (!model) return { refused: "The model for this task is not available any more. Choose another in Settings." };
      const providerClass = models.providerClassOf(spec.model);
      const gated = gate?.(sessionId, providerClass);
      if (gated) return { refused: gated };
      const cacheRetention = spec.cacheRetention;
      const limits = (model as unknown as { inputLimits?: { images?: { resize?: ResizeOptions } } }).inputLimits?.images?.resize;
      const engine: JobEngine = {
        model,
        thinkingLevel: resolveLevel(model, spec.thinkingLevel),
        stream: (m, context, options) => models.registry.models.streamSimple(m, context, cacheRetention ? { ...options, cacheRetention } : options),
        ref: spec.model,
        providerClass,
        imageInput: Array.isArray(model.input) && model.input.includes("image"),
        ...(limits ? { imageLimits: limits } : {}),
      };
      return engine;
    },
  };
}

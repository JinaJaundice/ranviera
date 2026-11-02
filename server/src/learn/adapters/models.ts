// The ModelResolver and the Summariser of the runtime, over the models service and its registry. A resolution runs
// the checks of docs/CONTRACTS.md in the order slot, key, consent, gate, and a refusal is a RuntimeError that carries
// the envelope. The checks are synchronous because the runtime resolves a model before it awaits anything, so the
// state of the Claude Code CLI comes from the last probe and the probe is refreshed in the background.
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ClaudeCodeStatus, ModelRef, ModelSlotName } from "../../../../shared/learn/models.ts";
import type { SessionRecord, ThinkingLevel } from "../../../../shared/learn/sessions.ts";
import { callUsageOf } from "../extract/submit-agent.ts";
import type { ClaudeCodeProvider } from "../models/claude-code/index.ts";
import { MINIMUM_VERSION } from "../models/claude-code/version.ts";
import { CUSTOM_PROVIDER_ID } from "../models/endpoint.ts";
import { LearnError, badRequest } from "../models/errors.ts";
import { CLAUDE_CODE_PROVIDER_ID, enforceGate, type GateRoot } from "../models/gate.ts";
import type { ModelsService } from "../models/index.ts";
import { CUSTOM_KEY_NAME } from "../models/keys.ts";
import { modelsNotConfigured, providerKeyMissing, resolveConversation, resolveLevel, resolveSlot } from "../models/slots.ts";
import type { ModelResolver, ResolvedModel, Summariser } from "../runtime/deps.ts";
import { converting } from "./errors.ts";

const STATUS_REFRESH_MS = 30_000;

export interface ResolverDeps {
  models: ModelsService;
  claudeCode: ClaudeCodeProvider;
  /** the claude executable, or null when none is found */
  findClaude: () => string | null;
  /** the gate input of a session */
  gateRoots: (session: SessionRecord) => GateRoot[];
  now?: () => number;
}

const consent = (which: "claude-code" | "claude-code-background"): LearnError =>
  new LearnError(
    403,
    "consent_required",
    which === "claude-code"
      ? "Claude Code is switched off. Allow it in Settings, under Models and keys, or choose another model."
      : "This work runs in the background. Allow background use of Claude Code in Settings, under Models and keys, or choose another model.",
    { consent: which },
  );

const unavailable = (state: ClaudeCodeStatus["state"]): LearnError =>
  new LearnError(
    503,
    "claude_code_unavailable",
    state === "update-required"
      ? "The Claude Code CLI is older than the minimum version. Update it and then try again."
      : "The Claude Code CLI was not found. Install it or set its path in the configuration.",
    { state, minimumVersion: MINIMUM_VERSION },
  );

export function createModelResolver(deps: ResolverDeps): ModelResolver {
  const { models, claudeCode } = deps;
  const now = deps.now ?? Date.now;
  let status: ClaudeCodeStatus["state"] | null = null;
  let probedAt = 0;
  let probing = false;

  /** Refreshes the cached state of the CLI. The result is used by the next resolution. */
  function refreshStatus(): void {
    if (probing || now() - probedAt < STATUS_REFRESH_MS) return;
    probing = true;
    probedAt = now();
    void models
      .claudeCodeStatus()
      .then((s) => {
        status = s.state;
      })
      .catch(() => {
        status = null;
      })
      .finally(() => {
        probing = false;
      });
  }

  /** The first refusal about the key or the consent, or null. */
  function accessProblem(ref: ModelRef, slots: ModelSlotName[], background: boolean): LearnError | null {
    const settings = models.settings.read();
    if (ref.provider === CLAUDE_CODE_PROVIDER_ID) {
      const cc = settings.claudeCode;
      if (cc?.enabled !== true) return consent("claude-code");
      if (background && cc.allowBackground !== true) return consent("claude-code-background");
      if (!deps.findClaude()) return unavailable("not-found");
      refreshStatus();
      if (status === "not-found" || status === "update-required") return unavailable(status);
      return null;
    }
    if (ref.provider === CUSTOM_PROVIDER_ID) {
      const ok = models.registry.customRegistered() && (settings.customProvider?.authMode === "keyless" || models.keys.effective(CUSTOM_KEY_NAME) !== null);
      return ok ? null : providerKeyMissing(ref.provider, slots);
    }
    return models.keys.providerKeyPresent(ref.provider) === true ? null : providerKeyMissing(ref.provider, slots);
  }

  function build(
    spec: { model: ModelRef; thinkingLevel?: ThinkingLevel; cacheRetention?: "none" | "short" | "long" },
    slots: ModelSlotName[],
    opts: { sessionId?: string; background: boolean; roots: GateRoot[] },
  ): ResolvedModel {
    const found = models.registry.lookup(spec.model) as Model<Api> | undefined;
    if (!found) {
      throw new LearnError(503, "models_not_configured", `The model ${spec.model.provider}:${spec.model.id} is not in the catalogue. Choose a model in Settings, under Models and keys.`, { missing: slots });
    }
    const problem = accessProblem(spec.model, slots, opts.background);
    if (problem) throw problem;
    enforceGate(spec.model, opts.roots, models.settings.read().customProvider);
    const sessionId = opts.sessionId;
    const cacheRetention = spec.cacheRetention;
    // The Claude Code provider holds one process for each session, and it does so only when the options carry the id.
    const streamFn: StreamFn = (m, context, options) =>
      models.registry.models.streamSimple(m, context as never, {
        ...options,
        ...(options?.sessionId || !sessionId ? {} : { sessionId }),
        ...(cacheRetention ? { cacheRetention } : {}),
      } as never);
    const claude = spec.model.provider === CLAUDE_CODE_PROVIDER_ID;
    const window = claude ? claudeCode.contextWindow(sessionId, found.id) : Number.isFinite(found.contextWindow) && found.contextWindow > 0 ? found.contextWindow : undefined;
    return {
      model: found,
      ref: spec.model,
      thinkingLevel: resolveLevel(found, spec.thinkingLevel),
      providerClass: models.providerClassOf(spec.model),
      streamFn,
      contextWindow: window ?? null,
    };
  }

  return {
    forSession(session) {
      return converting(() => {
        const spec = resolveConversation(models.settings.read(), session.settings);
        if (!spec) throw modelsNotConfigured(["strong"]);
        return build(spec, ["strong"], { sessionId: session.id, background: false, roots: deps.gateRoots(session) });
      });
    },
    cheap() {
      return converting(() => {
        const spec = resolveSlot(models.settings.read(), "cheap");
        if (!spec) throw modelsNotConfigured(["cheap"]);
        return build(spec, ["cheap"], { background: true, roots: [] });
      });
    },
    strongSlot() {
      const spec = resolveSlot(models.settings.read(), "strong");
      if (!spec) return null;
      return { model: spec.model, ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}), providerClass: models.providerClassOf(spec.model) };
    },
    validate(ref, level, session) {
      return converting(() => {
        const settings = models.settings.read();
        const target = ref ?? resolveConversation(settings, session.settings)?.model;
        const out: { model?: ModelRef; thinkingLevel?: ThinkingLevel } = {};
        if (ref) {
          if (!models.registry.lookup(ref)) throw badRequest(`The model ${ref.provider}:${ref.id} is not in the catalogue of its provider.`);
          enforceGate(ref, deps.gateRoots(session), settings.customProvider);
          out.model = ref;
        }
        if (level) {
          const found = target ? (models.registry.lookup(target) as Model<Api> | undefined) : undefined;
          out.thinkingLevel = found ? resolveLevel(found, level) : level;
        }
        return out;
      });
    },
  };
}

/** Writes a summary on the model that the resolver chose for the cheap slot. */
export function createSummariser(): Summariser {
  return async ({ system, prompt, model, signal }) => {
    const context = normalizeContext({ systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    const stream = await model.streamFn(model.model, context, { signal, ...(model.thinkingLevel !== "off" ? { reasoning: model.thinkingLevel } : {}) } as never);
    const message = await stream.result();
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const usage = callUsageOf(message.usage);
    return { text, stopReason: message.stopReason, ...(usage ? { usage } : {}) };
  };
}

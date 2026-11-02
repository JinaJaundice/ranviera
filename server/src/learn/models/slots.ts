// The three slots, background role pins, resolution, the thinking clamp and the two
// refusal envelopes. The source of truth is docs/CONTRACTS.md ("Settings and prompt
// overrides", "Model layer" and "Error envelopes").
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { BackgroundRole, LearnSettings, ModelRef, ModelSlot, ModelSlotName } from "../../../../shared/learn/models.ts";
import type { ThinkingLevel } from "../../../../shared/learn/sessions.ts";
import { badRequest, LearnError } from "./errors.ts";
import { CACHE_RETENTIONS, SLOT_NAMES, THINKING_LEVELS, sanitiseModelRef } from "./settings.ts";

/** What the slots need from the registry: a lookup of one model. */
export interface ModelLookup {
  getModel(provider: string, id: string): Model<Api> | undefined;
}

/** The slot that serves each background role. The conversation roles use the strong slot. */
export const ROLE_SLOT: Record<BackgroundRole, ModelSlotName> = {
  researcher: "cheap",
  extractor: "cheap",
  auditor: "cheap",
  pdfReader: "vision",
};

/** The order in which an unset thinking level is chosen from the levels that a model supports. */
export const DEFAULT_THINKING_ORDER: readonly ThinkingLevel[] = ["medium", "low", "high", "minimal", "xhigh", "max"];

export interface ResolvedSpec {
  model: ModelRef;
  thinkingLevel?: ThinkingLevel;
  cacheRetention?: "none" | "short" | "long";
}

/** The model of each slot. A slot counts as configured only when it holds a model. */
export function resolveSlots(settings: LearnSettings): Record<ModelSlotName, ModelRef | null> {
  const slots = settings.models ?? {};
  return { strong: slots.strong?.model ?? null, cheap: slots.cheap?.model ?? null, vision: slots.vision?.model ?? null };
}

/** A slot as a spec, or null when it holds no model. A level with no model is inert. */
export function resolveSlot(settings: LearnSettings, name: ModelSlotName): ResolvedSpec | null {
  const slot: ModelSlot | undefined = settings.models?.[name];
  if (!slot?.model) return null;
  const spec: ResolvedSpec = { model: slot.model };
  if (slot.thinkingLevel) spec.thinkingLevel = slot.thinkingLevel;
  if (slot.cacheRetention) spec.cacheRetention = slot.cacheRetention;
  return spec;
}

/** A background role takes its override and then its slot, each field on its own. */
export function resolveRole(settings: LearnSettings, role: BackgroundRole): ResolvedSpec | null {
  // each field is read from the raw slot, so an override may borrow the level of a slot that holds no model
  const slot: ModelSlot | undefined = settings.models?.[ROLE_SLOT[role]];
  const pin = settings.agent?.models?.[role];
  const model = pin?.model ?? slot?.model;
  if (!model) return null;
  const spec: ResolvedSpec = { model };
  const lv = pin?.thinkingLevel ?? slot?.thinkingLevel;
  if (lv) spec.thinkingLevel = lv;
  if (slot?.cacheRetention) spec.cacheRetention = slot.cacheRetention;
  return spec;
}

/** The pinned model of each background role, or null. */
export function resolveRolePins(settings: LearnSettings): Partial<Record<BackgroundRole, ModelRef | null>> {
  const out: Partial<Record<BackgroundRole, ModelRef | null>> = {};
  for (const role of Object.keys(ROLE_SLOT) as BackgroundRole[]) out[role] = resolveRole(settings, role)?.model ?? null;
  return out;
}

/** A conversation takes the model and level of its session and falls back to the strong slot, each field on its own. */
export function resolveConversation(settings: LearnSettings, session?: { model?: ModelRef; thinkingLevel?: ThinkingLevel }): ResolvedSpec | null {
  const strong = resolveSlot(settings, "strong");
  const model = session?.model ?? strong?.model;
  if (!model) return null;
  const spec: ResolvedSpec = { model };
  const lv = session?.thinkingLevel ?? strong?.thinkingLevel;
  if (lv) spec.thinkingLevel = lv;
  // a chat inherits the retention of the strong slot even when it keeps its own model
  if (strong?.cacheRetention) spec.cacheRetention = strong.cacheRetention;
  return spec;
}

/** The levels that a model supports. A model that does not reason supports only off. */
export function supportedLevels(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}

/** The first level of the default order that the model supports, or off. */
export function defaultLevel(model: Model<Api>): ThinkingLevel {
  const supported = supportedLevels(model);
  return DEFAULT_THINKING_ORDER.find((l) => supported.includes(l)) ?? "off";
}

/** Clamps a level to the nearest one that the model supports. An unset level takes the default. A swap never fails. */
export function resolveLevel(model: Model<Api>, requested?: ThinkingLevel): ThinkingLevel {
  return requested ? clampThinkingLevel(model, requested) : defaultLevel(model);
}

/** The models section after a write: validated against the catalogue and clamped. Throws 400 with a plain sentence. */
export function validateModelsSection(body: unknown, stored: LearnSettings["models"], lookup: ModelLookup): NonNullable<LearnSettings["models"]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("The models section must be an object that names the slots strong, cheap and vision.");
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((k) => !(SLOT_NAMES as readonly string[]).includes(k));
  if (unknown.length > 0) throw badRequest(`The slot ${unknown[0]} is not known. The supported slots are ${SLOT_NAMES.join(", ")}.`);
  const out: NonNullable<LearnSettings["models"]> = {};
  for (const name of SLOT_NAMES) {
    const raw = input[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest(`The slot ${name} must be an object with a model.`);
    const slotIn = raw as Record<string, unknown>;
    const model = sanitiseModelRef(slotIn.model);
    if (!model) throw badRequest(`The slot ${name} needs a model with a provider and an id.`);
    const keep = stored?.[name]?.model;
    const unchanged = !!keep && keep.provider === model.provider && keep.id === model.id;
    const found = lookup.getModel(model.provider, model.id);
    if (!found && !unchanged) throw badRequest(`The model ${model.provider}:${model.id} is not in the catalogue of its provider.`);
    if (found && name === "vision" && !found.input.includes("image") && !unchanged) throw badRequest("The vision slot needs a model that accepts images.");
    const slot: ModelSlot = { model };
    if (slotIn.thinkingLevel !== undefined) {
      if (typeof slotIn.thinkingLevel !== "string" || !(THINKING_LEVELS as readonly string[]).includes(slotIn.thinkingLevel)) {
        throw badRequest(`The thinking level must be one of ${THINKING_LEVELS.join(", ")}.`);
      }
      const asked = slotIn.thinkingLevel as ThinkingLevel;
      slot.thinkingLevel = found ? clampThinkingLevel(found, asked) : asked;
    }
    if (slotIn.cacheRetention !== undefined) {
      if (typeof slotIn.cacheRetention !== "string" || !(CACHE_RETENTIONS as readonly string[]).includes(slotIn.cacheRetention)) {
        throw badRequest(`The cache retention must be one of ${CACHE_RETENTIONS.join(", ")}, or left out.`);
      }
      slot.cacheRetention = slotIn.cacheRetention as ModelSlot["cacheRetention"];
    }
    out[name] = slot;
  }
  return out;
}

/** The refusal for slots that hold no model: 503 models_not_configured. */
export function modelsNotConfigured(missing: ModelSlotName[]): LearnError {
  return new LearnError(503, "models_not_configured", `No model is chosen for ${missing.join(", ")}. Choose a model in Settings, under Models and keys.`, { missing });
}

/** The refusal for a slot whose provider has no key: 503 provider_key_missing. */
export function providerKeyMissing(provider: string, slots: ModelSlotName[]): LearnError {
  return new LearnError(503, "provider_key_missing", `The provider ${provider} has no key for ${slots.join(", ")}. Add the key in Settings, under Models and keys.`, { provider, slots });
}

/**
 * The first refusal for the slots that a task needs, or null. A missing model is checked
 * before a missing key. The test of a key is injected, because the Claude Code provider
 * and the custom endpoint have their own rules.
 */
export async function checkSlots(settings: LearnSettings, needed: ModelSlotName[], keyPresent: (provider: string) => Promise<boolean>): Promise<LearnError | null> {
  const slots = resolveSlots(settings);
  const missing = needed.filter((n) => !slots[n]);
  if (missing.length > 0) return modelsNotConfigured(missing);
  const lost = new Map<string, ModelSlotName[]>();
  for (const n of needed) {
    const ref = slots[n] as ModelRef;
    if (!(await keyPresent(ref.provider))) lost.set(ref.provider, [...(lost.get(ref.provider) ?? []), n]);
  }
  const first = lost.entries().next();
  if (!first.done) return providerKeyMissing(first.value[0], first.value[1]);
  return null;
}

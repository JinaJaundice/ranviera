// The provider class of a model and the sensitivity gate. The source of truth is
// docs/CONTRACTS.md, "Sensitivity gate and model policy".
import type { CustomProviderSettings, ModelRef, ProviderClass } from "../../../../shared/learn/models.ts";
import type { Sensitivity } from "../../../../shared/learn/sources.ts";
import { CUSTOM_PROVIDER_ID, isLoopbackUrl } from "./endpoint.ts";
import { LearnError } from "./errors.ts";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, "client-confidential": 2 };

/** The higher of two sensitivities. */
export function higherSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The highest sensitivity of a list, or public for an empty list. */
export function maxSensitivity(list: Iterable<Sensitivity>): Sensitivity {
  let top: Sensitivity = "public";
  for (const s of list) top = higherSensitivity(top, s);
  return top;
}

/**
 * claude-code for the aliases of the Claude Code provider. local for the custom endpoint
 * when its host is a loopback address or when the person stated that it runs on their own
 * machine or network. hosted for every other model.
 */
export function providerClass(model: ModelRef, custom?: CustomProviderSettings): ProviderClass {
  if (model.provider === CLAUDE_CODE_PROVIDER_ID) return "claude-code";
  if (model.provider === CUSTOM_PROVIDER_ID && custom && (isLoopbackUrl(custom.baseUrl) || !!custom.localConfirmedAt)) return "local";
  return "hosted";
}

/** What the gate needs to know about the roots that supplied the text. */
export interface GateRoot {
  id: string;
  sensitivity: Sensitivity;
  hostedConsentAt?: string | null;
}

export type GateDecision =
  | { allowed: true }
  | { allowed: false; sensitivity: Sensitivity; providerClass: ProviderClass; roots: string[] };

/** True when a model of this class may receive the text of this root. */
export function rootAllowedFor(root: GateRoot, cls: ProviderClass): boolean {
  if (cls !== "hosted") return true;
  return root.sensitivity !== "client-confidential" || !!root.hostedConsentAt;
}

/** Decides whether a model of this class may receive text from these roots. A hosted model is refused client-confidential text without consent. */
export function gateDecision(cls: ProviderClass, roots: GateRoot[]): GateDecision {
  const refused = roots.filter((r) => !rootAllowedFor(r, cls));
  if (refused.length === 0) return { allowed: true };
  return { allowed: false, sensitivity: maxSensitivity(refused.map((r) => r.sensitivity)), providerClass: cls, roots: refused.map((r) => r.id) };
}

/** The 403 envelope for a refusal. */
export function sensitivityRefusal(decision: Extract<GateDecision, { allowed: false }>): LearnError {
  return new LearnError(
    403,
    "sensitivity_refused",
    "This material is client-confidential and the chosen model is hosted. Choose Claude Code or a local model, or record consent for the source in Sources.",
    { sensitivity: decision.sensitivity, providerClass: decision.providerClass, roots: decision.roots },
  );
}

/** Throws the sensitivity_refused envelope when the gate refuses. */
export function enforceGate(model: ModelRef, roots: GateRoot[], custom?: CustomProviderSettings): void {
  const decision = gateDecision(providerClass(model, custom), roots);
  if (!decision.allowed) throw sensitivityRefusal(decision);
}

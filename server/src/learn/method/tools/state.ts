// What the method tools share inside one turn. The record changes only when a
// turn settles, so a gate that reads the record alone would not see a call made
// earlier in the same turn. Each turn therefore seeds a small closure from the
// record once, and the tools flip it as they run.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { NativeMessage, ProviderClass, SessionRecord } from "../../../../../shared/learn/index.ts";
import { activeProblemOf, danglingQuestions, hasProbeDone } from "../../runtime/scans.ts";
import type { TargetResolver } from "../deps.ts";

export interface TurnState {
  sessionId: string;
  providerClass: ProviderClass;
  /** the record as it stands now */
  record: () => SessionRecord;
  /** a clean question was posed in this turn */
  posed: boolean;
  /** a successful probe_done was recorded, in the record or in this turn */
  probeDone: boolean;
  /** the problem that is open, from the record or from this turn */
  problem: { callId: string; modelSolution: string; target: string[] } | null;
  targets?: TargetResolver;
}

export function seedTurnState(input: { record: () => SessionRecord; providerClass: ProviderClass; targets?: TargetResolver }): TurnState {
  const messages = input.record().messages;
  const open = activeProblemOf(messages);
  return {
    sessionId: input.record().id,
    providerClass: input.providerClass,
    record: input.record,
    posed: false,
    probeDone: hasProbeDone(messages),
    problem: open
      ? {
          callId: open.id,
          modelSolution: typeof open.arguments.modelSolution === "string" ? open.arguments.modelSolution : "",
          target: Array.isArray(open.arguments.target) ? (open.arguments.target as unknown[]).filter((t): t is string => typeof t === "string") : [],
        }
      : null,
    targets: input.targets,
  };
}

export const questionOpen = (messages: NativeMessage[]): boolean => danglingQuestions(messages).length > 0;

const text = (t: string) => [{ type: "text" as const, text: t }];

/** A clean result that carries structured details for the window. */
export const accepted = (t: string, details: unknown, terminate = false): AgentToolResult<unknown> => ({ content: text(t), details, ...(terminate ? { terminate: true } : {}) });

/** The placeholder of a posed question. It has no details, so the runtime does not save it and the call stays open in the record. */
export const posedPlaceholder = (t: string): AgentToolResult<null> => ({ content: text(t), details: null, terminate: true });

/** A refusal. The model reads the text and retries in the same turn. */
export const refused = (t: string, terminate = false): AgentToolResult<unknown> => ({ content: text(t), details: { ok: false }, isError: true, ...(terminate ? { terminate: true } : {}) });

export const problemsText = (problems: string[]): string => (problems.length === 1 ? problems[0] : problems.map((p, i) => `${i + 1}. ${p}`).join("\n"));

/**
 * Normalises the target field of a call: a name becomes its identifier, an
 * empty list is dropped and an unknown name is reported. With no resolver
 * there is nothing to check against, so the values pass unchanged.
 */
export function normaliseTargets(raw: unknown, state: Pick<TurnState, "targets" | "providerClass">): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) return { ok: false, error: "The target must be a list of proposition identifiers. Leaving it out always works." };
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) continue;
    const id = state.targets ? state.targets.resolve(item.trim(), state.providerClass) : item.trim();
    if (!id) return { ok: false, error: `The target "${item.trim()}" is not a known proposition. Leave the target out, which always works, or use list_propositions for valid names.` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** The target ids that a stored call carries, resolved again through the resolver when there is one. */
export function targetsOfCall(args: Record<string, unknown>, resolver: TargetResolver | undefined, providerClass: ProviderClass = "claude-code"): string[] {
  const raw = args.target;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) continue;
    const id = resolver ? (resolver.resolve(item.trim(), providerClass) ?? item.trim()) : item.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Drops an empty target list before validation, so that an empty array never reaches the schema. */
export function dropEmptyTarget(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  if (Array.isArray(a.target) && a.target.length === 0) {
    const { target: _target, ...rest } = a;
    void _target;
    return rest;
  }
  return args;
}

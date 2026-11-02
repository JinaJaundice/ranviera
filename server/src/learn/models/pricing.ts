// Cost derived at read time from the library's catalogue. The source of truth is
// docs/CONTRACTS.md, "Model layer" (Cost). An unknown price is null and never zero.
// Claude Code and the custom endpoint are always unpriced.
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../../../shared/learn/sessions.ts";
import type { SessionPricing, TurnUsage } from "../../../../shared/learn/sessions.ts";
import { CUSTOM_PROVIDER_ID } from "./endpoint.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "./gate.ts";

const UNPRICED_PROVIDERS = new Set([CLAUDE_CODE_PROVIDER_ID, CUSTOM_PROVIDER_ID]);

/** Finds a model by provider and id. The caller supplies it from the registry. */
export type PriceLookup = (provider: string, id: string) => Model<Api> | undefined;

const valid = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Dollars for one call, or null when the price cannot be known. */
export function callCost(model: Model<Api> | undefined, usage: CallUsage): number | null {
  if (!model || UNPRICED_PROVIDERS.has(model.provider)) return null;
  if (!valid(usage.inputTokens) || !valid(usage.outputTokens)) return null;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  if (!valid(read) || !valid(write)) return null;
  const long = usage.cacheWrite1hTokens;
  if (long !== undefined && (!valid(long) || long > write)) return null;
  // an old record with cache writes and no split of the one hour part is priced only
  // when every rate tier charges twice the input price for a cache write, so the split
  // cannot change the answer
  if (write > 0 && long === undefined) {
    const tiers = [model.cost, ...(model.cost.tiers ?? [])];
    if (tiers.some((t) => t.cacheWrite !== 2 * t.input)) return null;
  }
  const fresh: Usage = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: read,
    cacheWrite: write,
    totalTokens: usage.inputTokens + usage.outputTokens + read + write,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (long !== undefined) fresh.cacheWrite1h = long;
  const total = calculateCost(model, fresh).total;
  return Number.isFinite(total) ? total : null;
}

/** A turn costs the sum of its steps and is null when any step is unpriced. */
export function turnCost(lookup: PriceLookup, turn: TurnUsage): number | null {
  const sep = turn.model.indexOf(":");
  const model = sep > 0 ? lookup(turn.model.slice(0, sep), turn.model.slice(sep + 1)) : undefined;
  let sum = 0;
  for (const step of turn.steps) {
    const c = callCost(model, step);
    if (c === null) return null;
    sum += c;
  }
  return turn.steps.length === 0 ? null : sum;
}

/** Cache reads divided by fresh input, reads and writes over all steps. Null until a read exists or when any step lacks input or has bad counts. */
export function cacheHitRate(turns: TurnUsage[]): number | null {
  let read = 0;
  let all = 0;
  for (const t of turns) {
    for (const s of t.steps) {
      const r = s.cacheReadTokens ?? 0;
      const w = s.cacheWriteTokens ?? 0;
      if (!valid(s.inputTokens) || !valid(r) || !valid(w)) return null;
      read += r;
      all += s.inputTokens + r + w;
    }
  }
  return read > 0 && all > 0 ? read / all : null;
}

/** The pricing block of a session. The sum covers priced turns only and the count of unpriced turns is kept apart. */
export function sessionPricing(lookup: PriceLookup, turns: TurnUsage[] | undefined): SessionPricing {
  const list = turns ?? [];
  const turnCosts = list.map((t) => turnCost(lookup, t));
  const unpriced = turnCosts.filter((c) => c === null).length;
  const priced = turnCosts.filter((c): c is number => c !== null);
  const cost = priced.length > 0 ? priced.reduce((a, b) => a + b, 0) : null;
  return { cost, unpriced, turnCosts, cacheHitRate: cacheHitRate(list) };
}

/** The tokens of the last completed response against the window, for the context meter. Null window shows usage only. */
export function contextMeter(model: Model<Api> | undefined, last: CallUsage | undefined): { used: number | null; window: number | null; fraction: number | null } {
  if (!last || !valid(last.inputTokens) || !valid(last.outputTokens)) return { used: null, window: null, fraction: null };
  const used = last.inputTokens + last.outputTokens + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0);
  const window = model && model.provider !== CLAUDE_CODE_PROVIDER_ID && model.contextWindow > 0 ? model.contextWindow : null;
  return { used, window, fraction: window ? used / window : null };
}

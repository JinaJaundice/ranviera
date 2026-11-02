import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { TurnUsage } from "../../../../shared/learn/sessions.ts";
import { cacheHitRate, callCost, contextMeter, sessionPricing, turnCost } from "./pricing.ts";

const models = builtinModels();
const priced = models.getModels("anthropic").find((m) => m.cost.input > 0 && m.cost.cacheWrite !== 2 * m.cost.input);
if (!priced) throw new Error("the catalogue holds no Anthropic model with a price, so the fixture needs a new choice");
const lookup = (provider: string, id: string) => models.getModel(provider, id);

describe("call cost", () => {
  // B-1-88
  it("prices fresh input directly and the cache buckets at their own rates", () => {
    const c = priced.cost;
    const got = callCost(priced, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 300, cacheWrite1hTokens: 100 });
    const want = (1000 * c.input + 500 * c.output + 2000 * c.cacheRead + 200 * c.cacheWrite + 100 * 2 * c.input) / 1_000_000;
    expect(got).toBeCloseTo(want, 10);
    expect(callCost(priced, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo((1000 * c.input + 500 * c.output) / 1_000_000, 10);
  });

  // B-1-88
  it("returns null for an unknown model, a missing count, a bad count and an unsplit cache write that the rates cannot settle", () => {
    expect(callCost(undefined, { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(callCost(priced, { outputTokens: 1 })).toBeNull();
    expect(callCost(priced, { inputTokens: 1 })).toBeNull();
    expect(callCost(priced, { inputTokens: -1, outputTokens: 1 })).toBeNull();
    expect(callCost(priced, { inputTokens: Number.NaN, outputTokens: 1 })).toBeNull();
    expect(callCost(priced, { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 10, cacheWrite1hTokens: 11 })).toBeNull();
    expect(callCost(priced, { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 10 })).toBeNull();
  });

  it("never gives a price to the Claude Code provider or a custom endpoint, and never a zero", () => {
    const faux = fauxProvider({ provider: "claude-code", models: [{ id: "sonnet", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const cc = faux.getModel();
    expect(callCost(cc, { inputTokens: 10, outputTokens: 10 })).toBeNull();
    const custom = { ...cc, provider: "custom" };
    expect(callCost(custom, { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe("turn and session pricing", () => {
  const turn = (id: string, model: string, steps: TurnUsage["steps"]): TurnUsage => ({ id, messageId: `msg_${id}`, at: "2026-11-01T10:00:00.000Z", model, steps });
  const ref = `anthropic:${priced.id}`;

  // B-1-89
  it("sums the steps of a turn and counts an unpriced turn apart", () => {
    const a = turn("a", ref, [{ inputTokens: 100, outputTokens: 10 }, { inputTokens: 200, outputTokens: 20 }]);
    const b = turn("b", ref, [{ inputTokens: 100, outputTokens: 10 }, { inputTokens: 50 }]);
    const c = turn("c", "claude-code:sonnet", [{ inputTokens: 100, outputTokens: 10 }]);
    expect(turnCost(lookup, a)).toBeCloseTo((300 * priced.cost.input + 30 * priced.cost.output) / 1_000_000, 10);
    expect(turnCost(lookup, b)).toBeNull();
    expect(turnCost(lookup, c)).toBeNull();
    const pricing = sessionPricing(lookup, [a, b, c]);
    expect(pricing.unpriced).toBe(2);
    expect(pricing.turnCosts.map((x) => x === null)).toEqual([false, true, true]);
    expect(pricing.cost).toBeCloseTo(turnCost(lookup, a) as number, 12);
  });

  it("reports no cost at all, and not zero, when every turn is unpriced or there is none", () => {
    expect(sessionPricing(lookup, []).cost).toBeNull();
    expect(sessionPricing(lookup, undefined)).toMatchObject({ cost: null, unpriced: 0, turnCosts: [], cacheHitRate: null });
    expect(sessionPricing(lookup, [turn("c", "claude-code:sonnet", [{ inputTokens: 1, outputTokens: 1 }])]).cost).toBeNull();
  });

  it("derives costs at read time and does not alter the stored usage", () => {
    const t = turn("a", ref, [{ inputTokens: 100, outputTokens: 10 }]);
    const copy = JSON.stringify(t);
    sessionPricing(lookup, [t]);
    expect(JSON.stringify(t)).toBe(copy);
  });

  it("computes a cache hit rate only once a read exists and returns null on a step with no input", () => {
    expect(cacheHitRate([turn("a", ref, [{ inputTokens: 100, cacheReadTokens: 0 }])])).toBeNull();
    expect(cacheHitRate([turn("a", ref, [{ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }])])).toBeCloseTo(300 / 500, 10);
    expect(cacheHitRate([turn("a", ref, [{ cacheReadTokens: 300 }])])).toBeNull();
  });
});

describe("context meter", () => {
  it("adds the four buckets of the last response against the window and shows usage only without a window", () => {
    const m = contextMeter(priced, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 500 });
    expect(m.used).toBe(2000);
    expect(m.window).toBe(priced.contextWindow);
    expect(m.fraction).toBeCloseTo(2000 / priced.contextWindow, 10);
    const faux = fauxProvider({ provider: "claude-code", models: [{ id: "sonnet" }] }).getModel();
    expect(contextMeter(faux, { inputTokens: 10, outputTokens: 5 })).toEqual({ used: 15, window: null, fraction: null });
    expect(contextMeter(priced, undefined)).toEqual({ used: null, window: null, fraction: null });
  });
});

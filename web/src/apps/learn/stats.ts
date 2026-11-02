// The figures of the stats row. A figure that is not known says so in words: a zero is never shown for a price that is
// missing, and a context limit that is not reported is not guessed.

const n = (v: number) => v.toLocaleString("en-GB");

export function contextWords(tokens: number | null, limit: number | null): string {
  if (tokens === null) return "Context not reported";
  return limit === null ? `${n(tokens)} tokens` : `${n(tokens)} of ${n(limit)} tokens`;
}

export function costWords(cost: number | null): string {
  if (cost === null) return "Not priced";
  return `$${cost.toFixed(cost < 1 ? 3 : 2)}`;
}

export function cacheWords(rate: number | null): string {
  return rate === null || !Number.isFinite(rate) ? "Not reported" : `${Math.round(rate * 100)}%`;
}

/** The share of the window in use, between 0 and 1, or null when either figure is missing. */
export function contextShare(tokens: number | null, limit: number | null): number | null {
  if (tokens === null || limit === null || limit <= 0) return null;
  return Math.min(1, tokens / limit);
}

/** The share of the extraction budget in use, between 0 and 1. */
export function coverageFill(c: { uncoveredTokens: number; threshold: number } | null): number {
  if (!c || c.threshold <= 0) return 0;
  return Math.min(1, Math.max(0, c.uncoveredTokens / c.threshold));
}

// A small fuzzy matcher for the chain table. Every word of the query must match in some field. An exact field ranks
// above a prefix, a prefix above a substring and a substring above scattered letters, and letters that sit together
// score higher than letters that are far apart. An empty query matches everything with a score of 0.

function scoreWord(word: string, field: string): number | null {
  if (!field) return null;
  if (field === word) return 100;
  if (field.startsWith(word)) return 80 - Math.min(10, (field.length - word.length) / 8);
  const at = field.indexOf(word);
  if (at >= 0) return 60 - Math.min(20, at / 4);
  // scattered letters in order, rewarded for the longest unbroken run
  let pos = 0;
  let run = 0;
  let best = 0;
  let prev = -2;
  for (const ch of word) {
    const found = field.indexOf(ch, pos);
    if (found < 0) return null;
    run = found === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = found;
    pos = found + 1;
  }
  return 10 + (best / word.length) * 25;
}

/** Returns null for no match. Higher is better. */
export function fuzzyScore(query: string, fields: string[]): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const lower = fields.map((f) => f.toLowerCase());
  let total = 0;
  for (const word of words) {
    let top: number | null = null;
    for (const f of lower) {
      const s = scoreWord(word, f);
      if (s !== null && (top === null || s > top)) top = s;
    }
    if (top === null) return null;
    total += top;
  }
  return total / words.length;
}

/** Filters and ranks. The order of equal scores is the order of the input. */
export function fuzzyFilter<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(query, fields(item));
    if (s !== null) scored.push({ item, score: s, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

// Chain simplification. After every merge, an argument for a conclusion is
// dropped when a smaller argument for the same conclusion already covers it
// (briefs 02 and 03, section on simplification). The ledgers are never edited
// here: the function names the keys to drop and the caller rewrites the file.

import type { ChainLine } from "../../../../shared/learn/knowledge.ts";
import { chainKey } from "./ledger.ts";

export interface Distinct {
  key: string;
  premises: string[];
  conclusion: string;
  createdAt: string;
}

/** The distinct chains of a ledger, one for each key, with the createdAt of the first line. */
export function distinctChains(lines: ChainLine[]): Distinct[] {
  const out = new Map<string, Distinct>();
  for (const l of lines) {
    const key = chainKey(l.premises, l.conclusion);
    if (out.has(key)) continue;
    out.set(key, { key, premises: [...new Set(l.premises)].sort(), conclusion: l.conclusion, createdAt: l.createdAt });
  }
  return [...out.values()];
}

/**
 * Ancestors over the whole chain set before simplification: the premises of
 * every chain that concludes an id, and their own ancestors, without looping on
 * a cycle.
 */
export function ancestry(chains: Distinct[]): (id: string) => Set<string> {
  const concluding = new Map<string, Distinct[]>();
  for (const c of chains) {
    const list = concluding.get(c.conclusion) ?? [];
    list.push(c);
    concluding.set(c.conclusion, list);
  }
  const memo = new Map<string, Set<string>>();
  return (id) => {
    const held = memo.get(id);
    if (held) return held;
    // a walk with a visited set, so that a cycle ends and an id never counts itself unless it is reached again
    const out = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      for (const c of concluding.get(next) ?? []) {
        for (const p of c.premises) {
          if (out.has(p)) continue;
          out.add(p);
          queue.push(p);
        }
      }
    }
    memo.set(id, out);
    return out;
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The keys of the chains to drop. For each conclusion the distinct chains are
 * sorted by premise count, createdAt and key, and kept greedily. A candidate is
 * redundant when the premise set of a kept chain is a subset of its own, or
 * when a single kept chain covers it: every premise of the candidate is a
 * premise of that kept chain or an ancestor of one of them.
 */
export function redundantKeys(lines: ChainLine[]): Set<string> {
  const chains = distinctChains(lines);
  const ancestorsOf = ancestry(chains);
  const byConclusion = new Map<string, Distinct[]>();
  for (const c of chains) {
    const list = byConclusion.get(c.conclusion) ?? [];
    list.push(c);
    byConclusion.set(c.conclusion, list);
  }
  const dropped = new Set<string>();
  for (const group of byConclusion.values()) {
    const sorted = [...group].sort(
      (a, b) => a.premises.length - b.premises.length || compare(a.createdAt, b.createdAt) || compare(a.key, b.key),
    );
    const kept: { chain: Distinct; cover: Set<string> }[] = [];
    for (const cand of sorted) {
      const redundant = kept.some(({ chain, cover }) => {
        const subset = chain.premises.every((p) => cand.premises.includes(p));
        return subset || cand.premises.every((p) => cover.has(p));
      });
      if (redundant) {
        dropped.add(cand.key);
        continue;
      }
      const cover = new Set<string>();
      for (const p of cand.premises) {
        cover.add(p);
        for (const a of ancestorsOf(p)) cover.add(a);
      }
      kept.push({ chain: cand, cover });
    }
  }
  return dropped;
}

/** The lines that stay after simplification, and the lines that go with every point of provenance they held. */
export function simplifyChains(lines: ChainLine[]): { kept: ChainLine[]; removed: ChainLine[] } {
  const drop = redundantKeys(lines);
  if (drop.size === 0) return { kept: lines, removed: [] };
  const kept: ChainLine[] = [];
  const removed: ChainLine[] = [];
  for (const l of lines) (drop.has(chainKey(l.premises, l.conclusion)) ? removed : kept).push(l);
  return { kept, removed };
}

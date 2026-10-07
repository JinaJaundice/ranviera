// The timing of one step of the thought trail (docs/BRAIN.md): hop 0 lights at once, each node of hop 1 lights
// 250 ms later and each node of hop 2 another 250 ms later, with a pulse from its via node. Pure, so that it is tested.
import type { Activation } from "@shared/types";
import type { RegionId } from "@shared/brain";

export const HOP_DELAY_MS = 250;
/** The longest time a pulse takes along a link. */
export const PULSE_MS = 250;
/** At most this many node labels are shown at once. */
export const MAX_NODE_LABELS = 14;

export interface Entry {
  id: string;
  a: number;
  hop: number;
  via: string | null;
  /** milliseconds after the start of the step */
  at: number;
  /** whether a pulse travels from the via node */
  pulse: boolean;
}

/** One entry for each activation. With reduced motion every node lights at once and no pulse is drawn. */
export function planStep(activation: Activation[], reduced: boolean): Entry[] {
  return activation.map((x) => ({
    id: x.id,
    a: x.a,
    hop: x.hop,
    via: x.via,
    at: reduced ? 0 : x.hop * HOP_DELAY_MS,
    pulse: !reduced && x.hop > 0 && x.via !== null,
  }));
}

/** The nodes to label for a step, in the order of their activation (hop first, then the order given), without repeats. */
export function labelOrder(activation: Activation[], max = MAX_NODE_LABELS): string[] {
  const order = activation.map((x, i) => ({ x, i })).sort((p, q) => p.x.hop - q.x.hop || p.i - q.i);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { x } of order) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x.id);
    if (out.length >= max) break;
  }
  return out;
}

/** The region that the camera turns to at the start of a step: the one with the most activation at hop 0, or at the lowest hop. */
export function leadRegion(activation: Activation[], regionOfId: (id: string) => RegionId | undefined): RegionId | null {
  if (!activation.length) return null;
  const lowest = Math.min(...activation.map((x) => x.hop));
  const total = new Map<RegionId, number>();
  for (const x of activation) {
    if (x.hop !== lowest) continue;
    const r = regionOfId(x.id);
    if (r) total.set(r, (total.get(r) ?? 0) + x.a);
  }
  let best: RegionId | null = null;
  let top = -1;
  for (const [r, v] of total) {
    if (v > top) {
      top = v;
      best = r;
    }
  }
  return best;
}

/** The time when the last node of a step lights. */
export function stepDuration(entries: Entry[]): number {
  return entries.reduce((m, e) => Math.max(m, e.at), 0);
}

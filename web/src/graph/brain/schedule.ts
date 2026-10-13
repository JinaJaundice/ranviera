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

// ------------------------------------------------------------------- the head of the traced path (docs/BRAIN.md, 13 October 2026)

/** The head takes this long for each segment of hop 0. */
export const HEAD_SEGMENT_MS = 250;
/** A step with more than 8 segments shortens them so that its head takes 2,000 ms at most. */
export const HEAD_CAP_MS = 2000;
/** A step lasts at least this long, so that a person can read its sentence. */
export const MIN_STEP_MS = 900;
/** The branches of a step end this long before the step does. */
export const BRANCH_TAIL_MS = 400;

export interface StepTiming {
  /** the slots of the head: one for the entry segment from the step before and one for each further node of hop 0 */
  slots: number;
  /** milliseconds for one slot */
  perSlot: number;
  /** the time for the head to reach the first node of the step */
  entry: number;
  /** the time of the head for the whole step */
  head: number;
  /** the time of the branches: 250 ms for each hop */
  branches: number;
  /** the length of the step at normal speed */
  total: number;
}

/** The timing of one step at normal speed. It follows from the step number and its activation alone, so that the queue and the scene agree. */
export function stepTiming(n: number, activation: Activation[]): StepTiming {
  const hop0 = activation.filter((a) => a.hop === 0).length;
  const slots = (n > 1 ? 1 : 0) + Math.max(0, hop0 - 1);
  const perSlot = slots > 8 ? HEAD_CAP_MS / slots : HEAD_SEGMENT_MS;
  const head = slots * perSlot;
  const maxHop = activation.reduce((m, a) => Math.max(m, a.hop), 0);
  const branches = maxHop * HOP_DELAY_MS;
  return { slots, perSlot, entry: n > 1 ? perSlot : 0, head, branches, total: Math.max(MIN_STEP_MS, head, branches + BRANCH_TAIL_MS) };
}

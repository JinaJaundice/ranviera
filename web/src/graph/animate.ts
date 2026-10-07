// Glow timing for the graph canvas. Pure functions and one small tracker, tested in animate.test.ts.
import type { Activation } from "@shared/types";

export const HOP_MS = 180;
export const HALF_LIFE_MS = 1600;
export const PREVIEW_HALF_LIFE_MS = 2400;
export const RING_MS = 600;
export const GLOW_FLOOR = 0.01;
export const MAX_BOOST = 1.8;
/** One turn in 4 minutes. OrbitControls turns once in 60 / speed seconds. */
export const ORBIT_SECONDS = 240;
export const orbitSpeed = (seconds = ORBIT_SECONDS): number => 60 / seconds;

/** The value after dtMs, for a given half-life. */
export function decay(value: number, dtMs: number, halfLifeMs: number): number {
  return value * Math.pow(0.5, dtMs / halfLifeMs);
}

/** The factor that raises brightness and size, from 1 at rest to 1.8 at full glow. */
export function boost(glow: number): number {
  return 1 + (MAX_BOOST - 1) * Math.min(1, Math.max(0, glow));
}

export interface Scheduled {
  id: string;
  a: number;
  hop: number;
  via: string | null;
  /** milliseconds after the firing starts */
  at: number;
  halfLife: number;
}

/** One entry for each activation, due at hop * 180 ms. */
export function planFiring(activation: Activation[], preview: boolean): Scheduled[] {
  const halfLife = preview ? PREVIEW_HALF_LIFE_MS : HALF_LIFE_MS;
  return activation.map((x) => ({ id: x.id, a: x.a, hop: x.hop, via: x.via, at: x.hop * HOP_MS, halfLife }));
}

/** The ring of a directly fired node: its scale from 1 to 4 and its opacity from 0.8 to 0 over 600 ms, or null when done. */
export function ringState(ageMs: number): { scale: number; opacity: number } | null {
  if (ageMs < 0 || ageMs >= RING_MS) return null;
  const t = ageMs / RING_MS;
  return { scale: 1 + 3 * t, opacity: 0.8 * (1 - t) };
}

interface Glow {
  g: number;
  half: number;
}

/** The glow of each node: the larger of the current and the new value, decaying with a half-life. */
export class GlowTracker {
  private map = new Map<string, Glow>();

  add(id: string, a: number, halfLife: number): void {
    const cur = this.map.get(id);
    if (!cur || a >= cur.g) this.map.set(id, { g: a, half: halfLife });
  }

  glow(id: string): number {
    return this.map.get(id)?.g ?? 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** Advance by dtMs. Returns the ids still glowing and the ids that fell below the floor in this step. */
  step(dtMs: number): { active: string[]; ended: string[] } {
    const active: string[] = [];
    const ended: string[] = [];
    for (const [id, v] of this.map) {
      v.g = decay(v.g, dtMs, v.half);
      if (v.g > GLOW_FLOOR) active.push(id);
      else {
        this.map.delete(id);
        ended.push(id);
      }
    }
    return { active, ended };
  }

  clear(): void {
    this.map.clear();
  }
}

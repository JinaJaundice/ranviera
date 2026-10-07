// The rules of how the brain looks at rest, in focus and over the thought trail (docs/BRAIN.md, "Looking at the brain").
// Pure, and tested in look.test.ts. The engine applies them.
import type { RegionId } from "@shared/brain";

/** The strength of the other regions' neurons while one region is focused. */
export const FOCUS_FADE = 0.05;

/** The size of the neurons of the other regions while one region is focused, as a share of their size. */
export const FOCUS_SHRINK = 0.6;

/** The halo of a neuron at rest is at most this strong, so that a dense cluster shows single neurons. */
export const HALO_REST = 0.04;

/** The most step labels shown at once over the thought trail. */
export const STEP_LABELS_MAX = 3;

/** How much of its tint a region surface shows: none at rest, full while the region is focused. A firing region lights through uGlow. */
export function regionTint(id: RegionId | "shell", focused: RegionId | null): number {
  if (id === "shell") return 1;
  return focused === id ? 1 : 0;
}

/** The strength of the glow of a neuron: only a firing or a selected neuron glows, and no neuron of a region that is not focused. */
export function glowOf(firing: number, selected: boolean, regionDimmed: boolean): number {
  if (regionDimmed) return 0;
  return selected ? Math.max(firing, 1) : firing;
}

export interface CalloutMode {
  focused: RegionId | null;
  /** the thought trail panel is open */
  trail: boolean;
  /** the regions of the step that is playing */
  stepRegions: ReadonlySet<RegionId>;
}

/** The regions whose callouts show: all at rest, the focused region alone, and over the trail the regions of the current step. */
export function calloutRegions<T extends RegionId>(all: readonly T[], mode: CalloutMode): T[] {
  if (mode.focused) return all.filter((id) => id === mode.focused);
  if (mode.trail) return all.filter((id) => mode.stepRegions.has(id));
  return all.slice();
}

/**
 * The distance of the camera at which a sphere of the given radius fills the given half size, in pixels, of the free area.
 * `pxAtOne` is the number of pixels that one scene unit spans at a distance of 1.
 */
export function framingDistance(radius: number, halfFree: number, pxAtOne: number, min: number, max: number): number {
  if (!(halfFree > 0) || !(pxAtOne > 0)) return max;
  const d = (radius * pxAtOne) / halfFree;
  return Math.min(max, Math.max(min, d));
}

/** The centre and the radius of the box of a set of points (a flat array of x, y, z). */
export function boundsOf(points: ArrayLike<number>): { centre: [number, number, number]; radius: number } | null {
  const n = Math.floor(points.length / 3);
  if (!n) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = points[i * 3 + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const centre: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { centre, radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
}

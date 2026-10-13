// The rules of how the brain looks at rest, in focus and over the thought trail (docs/BRAIN.md, "Looking at the brain").
// Pure, and tested in look.test.ts. The engine applies them.
import type { RegionId } from "@shared/brain";
import type { Rgb } from "../palette";
import { contrastRatio } from "./colourblind";

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

// ------------------------------------------------------------------- the traced path (docs/BRAIN.md, 13 October 2026)

/** The widths of the lines in CSS pixels: the trail, the segment under the head or of the selected step, a branch and the previous path. */
export const PATH_TRAIL_PX = 3;
export const PATH_HEAD_PX = 5;
export const PATH_BRANCH_PX = 1.5;
export const PATH_PREVIOUS_PX = 2;
/** The casing is this much wider than the line it edges. */
export const PATH_CASING_EXTRA_PX = 3;
export const PATH_CASING_OPACITY = 0.85;
/** The opacity of the trail behind the head, of a branch, of the previous path and of a branch of a step that is not playing or selected. */
export const PATH_TRAIL_OPACITY = 0.55;
export const PATH_BRANCH_OPACITY = 0.5;
export const PATH_BRANCH_QUIET = 0.25;
export const PATH_PREVIOUS_OPACITY = 0.3;
/** The segments of a step that is not selected, while a step is selected. */
export const PATH_UNSELECTED_OPACITY = 0.55;
/** The pieces of the line inside one step (the hops of a chain), unless the step plays or is selected (13 October 2026). */
export const PATH_INNER_OPACITY = 0.22;
/** The close-up view of a playing path (13 October 2026): the steps it frames at once, the opacity of the neurons off the path and the
 * strength of the brain surface while a path is shown, so that the path reads as a scene of its own. */
export const PATH_WATCH_STEPS = 3;
export const PATH_WATCH_FADE = 0.22;
export const PATH_WATCH_SURFACE = 0.55;
/** The share of the region glow kept while a path is drawn, and the nearest the close-up view comes, in scene units (13 October 2026). */
export const PATH_WATCH_GLOW = 0.25;
export const PATH_WATCH_MIN_DISTANCE = 95;
/** The part of the line on the far side of the brain, as for the neurons. */
export const PATH_FAR_OPACITY = 0.55;
/** The comet behind the head, in scene units, and the head sprite in pixels. */
export const PATH_COMET_UNITS = 30;
export const PATH_HEAD_SPRITE_PX = 14;
/** The pull of a segment towards the centre of the brain, as a share of the distance of its midpoint from the centre, and the sideways bow for each earlier visit to a node. */
export const PATH_PULL = 0.3;
export const PATH_BOW_UNITS = 3;
/** The samples of a segment: 20, and fewer for a long path so that no path holds more than 60,000 points. */
export const PATH_SAMPLES_MAX = 20;
export const PATH_SAMPLES_MIN = 6;
export const PATH_MAX_POINTS = 60_000;
/** The samples of a branch. */
export const PATH_BRANCH_SAMPLES = 6;
/** Waypoint badges closer than this many pixels merge into one capsule, and at most this many capsules are drawn. */
export const BADGE_MERGE_PX = 22;
export const BADGE_MAX = 120;
/** The diameter of a waypoint badge, of a small knot and of a branch knot, in pixels. */
export const BADGE_PX = 20;
export const KNOT_PX = 8;
export const BRANCH_KNOT_PX = 5;
/** The sentence plates while the whole path is shown, and the callouts of visited regions. */
export const PATH_PLATES_MAX = 12;
export const PATH_CALLOUT_VISITED = 0.7;
/** A region tint falls over this long once the head has left the region. */
export const PATH_TINT_FALL_MS = 600;
/** The camera eases to a selected step over this long. */
export const PATH_EASE_MS = 600;
/** The bloom while the head moves and at rest (the rest value is BLOOM_REST of the engine). */
export const PATH_BLOOM_MOVING = 0.85;
/** Segments that share both ends, or an end with 2 or more others, fan out by this many scene units each, to at most PATH_FAN_MAX_UNITS across. */
export const PATH_FAN_UNITS = 2.2;
export const PATH_FAN_MAX_UNITS = 16;
/** The tangent at a waypoint is at most this share of the length of the segment, so that a curve cannot loop outside the brain. */
export const PATH_TANGENT_MAX = 0.7;
/**
 * A step with more than PATH_CROWD branches draws 1 in PATH_CROWD_SHARE of them as a short faint branch (to PATH_CROWD_REACH of the
 * way) and the rest as dots. A step that loads more than PATH_FAN_AFTER further nodes keeps them off the main line.
 */
export const PATH_CROWD = 6;
export const PATH_CROWD_SHARE = 3;
export const PATH_CROWD_REACH = 0.55;
export const PATH_FAN_AFTER = 6;
/** The head rests this far short of the end of a step, so that the end of step 10 is not read as the start of step 11. */
export const PATH_END_EPS = 5e-5;
/** The room kept round the whole path in the free area of the canvas, in pixels. */
export const PATH_FRAME_MARGIN = 48;
/**
 * The pattern of a segment by the label of the step it enters, in pixels along the line: solid for recorded, dashes for a claim of the
 * agent whose cause is unverified, dots for loaded. Each is the length on and the length of the whole period.
 */
export const PATH_DASH_PX = { on: 9, period: 16 };
export const PATH_DOT_PX = { on: 2.6, period: 8.5 };
/** The diameter of the badge of a hop of a chain, and the most hops of one step whose plates stand on the canvas. */
export const SUB_BADGE_PX = 18;
export const HOP_PLATES_MAX = 8;
/** The plate of a step on the canvas holds at most this many characters of its sentence (the panel holds all of it), and a hovered capsule shows at most this many plates. */
export const PATH_PLATE_CHARS = 110;
/** A node that 3 or more steps end at (steps 9 to 14 of AL-2026-0001 all end at one provision) stands at the centre of a ring: the 2nd and later visits end on a ring of this radius in scene units, in the order of the steps. */
export const PATH_SPREAD_AFTER = 3;
export const PATH_SPREAD_UNITS = 12;
/** The first node of a step that lies within this many scene units of the first node of an earlier step is moved to a place round it, so that the waypoints of neighbouring nodes do not merge into one badge. */
export const PATH_NEAR_UNITS = 8;
export const PATH_HOVER_PLATES_MAX = 6;
/** A path of more than this many steps is grouped by the runs of its route in the panel. */
export const PATH_GROUP_AFTER = 40;

/** The regions whose callouts show over the thought trail with a path: those the path has entered, and the lead region of the step. */
export function pathCalloutRegions(visited: ReadonlySet<RegionId>, lead: RegionId | null): Set<RegionId> {
  const out = new Set(visited);
  if (lead) out.add(lead);
  return out;
}

/** The colour of the number on a waypoint badge: the colour of the background or of the text, whichever has the greater contrast with the fill. */
export function badgeInk(fill: Rgb, background: Rgb, text: Rgb): "void" | "ink" {
  return contrastRatio(fill, background) >= contrastRatio(fill, text) ? "void" : "ink";
}

// The Expand control of the brain view (docs/BRAIN.md, "Visibility and navigation"). At 0 every region lies where the model
// puts it. At 1 each region has moved outwards from the centre of the brain, along the direction of its own centre, so
// that the deep regions come out from under the cortex and can be reached. Pure, and tested in expand.test.ts.
import type { RegionId } from "@shared/brain";
import type { Vec3 } from "../layout";

/** How far a cortical region moves at Expand 1, in scene units (the brain spans 200). */
export const CORTICAL_SPREAD = 55;
/** How far a deep region moves at Expand 1. The deep regions lie under the cortex, so they travel further. */
export const DEEP_SPREAD = 100;
/** How much the camera draws back at Expand 1, as a share of its distance, so that the spread brain stays in view. */
export const EXPAND_ZOOM = 0.8;

/**
 * The deep regions have centres close to the middle of the brain, where the direction of the centre says little, and
 * several share the same side. Each has a fixed direction that leaves the cortex free: the thalamus goes up, the basal
 * ganglia forwards and down, the cerebellum back and down and the brainstem straight down. The x part is mirrored for the
 * hemisphere on the other side.
 */
const DEEP_DIRECTIONS: Partial<Record<RegionId, Vec3>> = {
  thalamus: { x: 0.12, y: 0.95, z: 0 },
  basal: { x: 0.45, y: -0.35, z: 0.85 },
  cerebellum: { x: 0.3, y: -0.55, z: -0.8 },
  brainstem: { x: 0.1, y: -1, z: 0.1 },
};

export interface RegionCentre {
  region: RegionId;
  hemisphere: "L" | "R";
  centre: Vec3;
}

export const expandKey = (region: RegionId, hemisphere: "L" | "R"): string => `${region}:${hemisphere}`;

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-6 ? { x: 0, y: 1, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** The direction in which a region moves, as a unit vector. */
export function expandDirection(entry: RegionCentre): Vec3 {
  const fixed = DEEP_DIRECTIONS[entry.region];
  if (!fixed) return unit(entry.centre);
  const sign = entry.centre.x !== 0 ? Math.sign(entry.centre.x) : entry.hemisphere === "L" ? 1 : -1;
  return unit({ x: fixed.x * sign, y: fixed.y, z: fixed.z });
}

/** The offset of one region at an Expand value from 0 to 1. */
export function expandOffset(entry: RegionCentre, expand: number): Vec3 {
  const e = Math.min(1, Math.max(0, Number.isFinite(expand) ? expand : 0));
  const dir = expandDirection(entry);
  const spread = (entry.region in DEEP_DIRECTIONS ? DEEP_SPREAD : CORTICAL_SPREAD) * e;
  return { x: dir.x * spread, y: dir.y * spread, z: dir.z * spread };
}

/** The offsets of every region and hemisphere, by expandKey. */
export function expandOffsets(entries: RegionCentre[], expand: number): Map<string, Vec3> {
  return new Map(entries.map((e) => [expandKey(e.region, e.hemisphere), expandOffset(e, expand)]));
}

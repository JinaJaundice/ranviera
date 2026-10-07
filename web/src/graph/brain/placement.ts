// Deterministic placement of nodes on the sample points of their region (docs/BRAIN.md, "Placement"). Pure, so that
// placement.test.ts can show that the same graph gives the same positions.
import type { RegionId } from "@shared/brain";
import type { RegionEntry } from "./types";

export interface PlaceNode {
  id: string;
  region: RegionId;
  /** the key of the file that holds the node, so that the nodes of one file stay together */
  group: string;
}

export interface Placed {
  x: number;
  y: number;
  z: number;
  hemisphere: "L" | "R";
}

export interface PlacementResult {
  positions: Map<string, Placed>;
  /** the regions with more nodes than sample points, and by how many */
  overflow: Partial<Record<RegionId, number>>;
}

/** The distance from the surface along its normal. Cortical regions sit outside it, deep structures on it. */
export const CORTICAL_OFFSET = 1.5;
const DEEP = new Set<RegionId>(["basal", "thalamus", "brainstem"]);

/** A small stable hash of a string, from 0 to 1, for the offset of a node that has no free point. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Farthest-point sampling over the points of a pool: the first seed is the first point, and each next seed is the
 * point farthest from every seed so far. The sequence does not depend on how many seeds are asked for.
 */
export function farthestSeeds(pts: Float32Array, pool: number[], count: number): number[] {
  const seeds: number[] = [];
  if (!pool.length || count <= 0) return seeds;
  const dist = new Float64Array(pool.length).fill(Infinity);
  let next = 0;
  while (seeds.length < Math.min(count, pool.length)) {
    seeds.push(pool[next]);
    const sx = pts[pool[next] * 6];
    const sy = pts[pool[next] * 6 + 1];
    const sz = pts[pool[next] * 6 + 2];
    let far = -1;
    let best = -1;
    for (let i = 0; i < pool.length; i += 1) {
      const p = pool[i] * 6;
      const d = (pts[p] - sx) ** 2 + (pts[p + 1] - sy) ** 2 + (pts[p + 2] - sz) ** 2;
      if (d < dist[i]) dist[i] = d;
      if (dist[i] > best) {
        best = dist[i];
        far = i;
      }
    }
    next = far;
  }
  return seeds;
}

/** Place every node. `points` is the content of brain-points.bin and `entries` the regions of brain-regions.json. */
export function placeNodes(nodes: PlaceNode[], points: Float32Array, entries: RegionEntry[]): PlacementResult {
  const positions = new Map<string, Placed>();
  const overflow: Partial<Record<RegionId, number>> = {};

  const byRegion = new Map<RegionId, PlaceNode[]>();
  for (const n of nodes) {
    let list = byRegion.get(n.region);
    if (!list) byRegion.set(n.region, (list = []));
    list.push(n);
  }

  for (const [region, list] of byRegion) {
    const pools: Record<"L" | "R", number[]> = { L: [], R: [] };
    for (const e of entries) {
      if (e.id !== region) continue;
      for (let i = 0; i < e.pointCount; i += 1) pools[e.hemisphere].push(e.pointOffset + i);
    }
    const usable = (["L", "R"] as const).filter((h) => pools[h].length > 0);
    if (!usable.length) continue;

    // Group by file, in the order of the keys, and alternate the groups between the hemispheres.
    const groups = new Map<string, PlaceNode[]>();
    for (const n of list) {
      let g = groups.get(n.group);
      if (!g) groups.set(n.group, (g = []));
      g.push(n);
    }
    const keys = [...groups.keys()].sort(compare);
    const perHemisphere: Record<"L" | "R", string[]> = { L: [], R: [] };
    keys.forEach((k, i) => perHemisphere[usable[i % usable.length]].push(k));

    let missing = 0;
    const offset = DEEP.has(region) ? 0 : CORTICAL_OFFSET;
    for (const h of usable) {
      const pool = pools[h];
      const taken = new Uint8Array(pool.length);
      const seeds = farthestSeeds(points, pool, perHemisphere[h].length);
      const poolIndex = new Map<number, number>(pool.map((p, i) => [p, i]));
      // A seed belongs to its group, and no other group takes it before its owner has.
      const reserved = new Uint8Array(pool.length);
      for (const s of seeds) reserved[poolIndex.get(s)!] = 1;

      perHemisphere[h].forEach((key, gi) => {
        const seed = seeds[gi % seeds.length] * 6;
        reserved[poolIndex.get(seeds[gi % seeds.length])!] = 0;
        const members = groups.get(key)!.slice().sort((a, b) => compare(a.id, b.id));
        for (const node of members) {
          let best = -1;
          let bestD = Infinity;
          for (let i = 0; i < pool.length; i += 1) {
            if (taken[i] || reserved[i]) continue;
            const p = pool[i] * 6;
            const d = (points[p] - points[seed]) ** 2 + (points[p + 1] - points[seed + 1]) ** 2 + (points[p + 2] - points[seed + 2]) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          let jitter = 0;
          if (best < 0) {
            // No free point is left: reuse the nearest point with a small offset.
            missing += 1;
            for (let i = 0; i < pool.length; i += 1) {
              const p = pool[i] * 6;
              const d = (points[p] - points[seed]) ** 2 + (points[p + 1] - points[seed + 1]) ** 2 + (points[p + 2] - points[seed + 2]) ** 2;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
            jitter = 0.6 + 1.2 * hash01(node.id);
          } else {
            taken[best] = 1;
          }
          const p = pool[best] * 6;
          const k = offset + jitter;
          positions.set(node.id, {
            x: points[p] + points[p + 3] * k + (jitter ? (hash01(`${node.id}x`) - 0.5) * 1.2 : 0),
            y: points[p + 1] + points[p + 4] * k + (jitter ? (hash01(`${node.id}y`) - 0.5) * 1.2 : 0),
            z: points[p + 2] + points[p + 5] * k + (jitter ? (hash01(`${node.id}z`) - 0.5) * 1.2 : 0),
            hemisphere: h,
          });
        }
      });
    }
    if (missing > 0) {
      overflow[region] = missing;
      console.warn(`brain: the ${region} region has ${missing} more nodes than sample points, so those nodes reuse points with a small offset`);
    }
  }
  return { positions, overflow };
}

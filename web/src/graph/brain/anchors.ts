// Where the caption of a region stands (docs/BRAIN.md, "Names"). The caption belongs at the centre of the neurons that
// the region draws, pushed outwards from the centre of the brain just far enough to clear the surface, so that it sits
// beside its region. Pure, and tested in anchors.test.ts.
import type { RegionId } from "@shared/brain";
import type { Vec3 } from "../layout";

export interface Anchor {
  region: RegionId;
  hemisphere: "L" | "R";
  /** the centre of the neurons of the region in this hemisphere */
  centre: Vec3;
  /** where the caption stands: the centre pushed outwards past the surface */
  caption: Vec3;
  /** how many neurons the centre was taken from */
  count: number;
  /** the root mean square distance of those neurons from the centre, in world units */
  spread: number;
}

export interface Located {
  region: RegionId;
  hemisphere: "L" | "R";
  x: number;
  y: number;
  z: number;
}

const CONE = Math.cos((14 * Math.PI) / 180);

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-6 ? { x: 0, y: 1, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * The reach of the surface along a direction: the largest distance from the origin of a sample point that lies within
 * a narrow cone around the direction. `points` holds x, y, z and a normal for each point, so its stride is 6.
 */
export function surfaceReach(points: Float32Array, dir: Vec3): number {
  let reach = 0;
  for (let i = 0; i + 2 < points.length; i += 6) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) continue;
    const dot = (x * dir.x + y * dir.y + z * dir.z) / len;
    if (dot >= CONE && len > reach) reach = len;
  }
  return reach;
}

/** The anchor of each region and hemisphere that holds neurons. */
export function regionAnchors(nodes: Located[], points: Float32Array, clearance = 7): Anchor[] {
  const groups = new Map<string, { region: RegionId; hemisphere: "L" | "R"; sum: Vec3; count: number; members: Located[] }>();
  for (const n of nodes) {
    const key = `${n.region}:${n.hemisphere}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { region: n.region, hemisphere: n.hemisphere, sum: { x: 0, y: 0, z: 0 }, count: 0, members: [] }));
    g.sum.x += n.x;
    g.sum.y += n.y;
    g.sum.z += n.z;
    g.count += 1;
    g.members.push(n);
  }
  const out: Anchor[] = [];
  for (const g of groups.values()) {
    const centre = { x: g.sum.x / g.count, y: g.sum.y / g.count, z: g.sum.z / g.count };
    const dir = unit(centre);
    const reach = Math.max(Math.hypot(centre.x, centre.y, centre.z), surfaceReach(points, dir));
    const r = reach + clearance;
    let sq = 0;
    for (const m of g.members) sq += (m.x - centre.x) ** 2 + (m.y - centre.y) ** 2 + (m.z - centre.z) ** 2;
    const spread = Math.sqrt(sq / g.count);
    out.push({ region: g.region, hemisphere: g.hemisphere, centre, caption: { x: dir.x * r, y: dir.y * r, z: dir.z * r }, count: g.count, spread });
  }
  return out;
}

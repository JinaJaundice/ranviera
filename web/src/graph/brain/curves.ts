// Links of the brain view are curves that bend towards the centre of the brain, in the manner of white matter tracts.
import type { Vec3 } from "../layout";

/** How far the middle of a link is pulled towards the centre: 0 is a straight line and 1 passes through the centre. */
export const BEND = 0.55;

/** The point at t (0 to 1) of the quadratic curve from a to b, whose control point is the midpoint pulled to the centre. */
export function curvePoint(a: Vec3, b: Vec3, t: number, bend = BEND): Vec3 {
  const cx = ((a.x + b.x) / 2) * (1 - bend);
  const cy = ((a.y + b.y) / 2) * (1 - bend);
  const cz = ((a.z + b.z) / 2) * (1 - bend);
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
    y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
    z: u * u * a.z + 2 * u * t * cz + t * t * b.z,
  };
}

/** The curve as a flat list of segment end points, 2 vertices (6 numbers) for each segment, written into out from index at. */
export function curveSegments(a: Vec3, b: Vec3, segments: number, out: Float32Array, at: number, bend = BEND): number {
  let prev = a;
  let i = at;
  for (let s = 1; s <= segments; s += 1) {
    const p = s === segments ? b : curvePoint(a, b, s / segments, bend);
    out[i++] = prev.x;
    out[i++] = prev.y;
    out[i++] = prev.z;
    out[i++] = p.x;
    out[i++] = p.y;
    out[i++] = p.z;
    prev = p;
  }
  return i;
}

// The placement of the waypoint badges (docs/BRAIN.md, "Waypoints and branches"). A badge that would overlap another badge, a finding
// marker or a box that the window covers moves to the nearest free place and keeps a leader line to its node, and the step labels are
// then placed round the badges that were placed (labelplace.ts takes the boxes as blocked), so that no 2 boxes shown overlap.
// Pure, and tested in pathboxes.test.ts.
import { overlaps } from "./labelplace";

export interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

/** A merged badge before it is placed: its centre on the node and its size. */
export interface CapsuleIn {
  steps: number[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapsuleOut extends CapsuleIn {
  /** the top left corner of the placed box */
  left: number;
  top: number;
  /** true when the badge is not on its node, and so needs a leader line from (ax, ay) */
  moved: boolean;
  ax: number;
  ay: number;
}

export interface CapsuleLayout {
  placed: CapsuleOut[];
  /** the capsules that no free place held within reach: their steps stay in the thought trail */
  hidden: CapsuleIn[];
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The width of the text of a capsule when it has not been measured: 6.8 pixels for a character, 10 for the padding, never below the height. */
export function estimateWidth(text: string, height: number): number {
  return Math.max(height, Math.ceil(text.length * 6.8 + 10));
}

const ANGLES = 16;
const RINGS = 14;

/**
 * Place the capsules in the order of their first step. Each stands on its node where the box is free, and otherwise on the nearest ring
 * position that is free, from 14 pixels out in steps of 14, so that a badge moves as little as it can. `pad` is the gap kept between boxes.
 */
export function layoutCapsules(caps: CapsuleIn[], obstacles: Box[] = [], bounds: Bounds | null = null, pad = 2): CapsuleLayout {
  const placed: CapsuleOut[] = [];
  const hidden: CapsuleIn[] = [];
  const free = (b: Box): boolean => {
    if (bounds && (b.left < bounds.left || b.top < bounds.top || b.left + b.w > bounds.right || b.top + b.h > bounds.bottom)) return false;
    return !obstacles.some((o) => overlaps(b, o, pad)) && !placed.some((p) => overlaps(b, { left: p.left, top: p.top, w: p.w, h: p.h }, pad));
  };
  for (const c of caps) {
    let found: Box | null = null;
    let moved = false;
    for (let ring = 0; ring <= RINGS && !found; ring += 1) {
      const turns = ring === 0 ? 1 : ANGLES;
      for (let a = 0; a < turns && !found; a += 1) {
        const r = ring * 14;
        // the order of the angles starts to the right and above, which is where the eye looks for the next label
        const angle = -Math.PI / 4 + (a / turns) * Math.PI * 2;
        const dx = r * Math.cos(angle) * (ring ? 1.4 : 1);
        const dy = r * Math.sin(angle);
        const box = { left: Math.round(c.x + dx - c.w / 2), top: Math.round(c.y + dy - c.h / 2), w: c.w, h: c.h };
        if (free(box)) {
          found = box;
          moved = ring > 0;
        }
      }
    }
    if (found) placed.push({ ...c, left: found.left, top: found.top, moved, ax: c.x, ay: c.y });
    else hidden.push(c);
  }
  return { placed, hidden };
}

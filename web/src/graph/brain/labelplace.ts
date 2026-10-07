// The placement pass for the labels over the brain canvas (docs/BRAIN.md, "Labels"). Each label is tried at 8
// positions around its point, in priority order, and a label that would overlap one already placed is dropped. A label
// that is moved off its point keeps a leader line. Pure, and tested in labelplace.test.ts.

export interface LabelRequest {
  key: string;
  /** the screen position of the point that the label names */
  x: number;
  y: number;
  /** the size of the text box in pixels */
  w: number;
  h: number;
  /** the radius of the point in pixels, so that the label stands clear of it */
  radius?: number;
  /** a caption is tried centred on its point first */
  centred?: boolean;
}

export interface PlacedLabel {
  key: string;
  /** the top left corner of the text box */
  left: number;
  top: number;
  w: number;
  h: number;
  /** the point that the label names */
  x: number;
  y: number;
  /** true when the label is not at its first position, and so needs a leader line */
  moved: boolean;
}

const GAP = 3;

interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a.left < b.left + b.w + pad && b.left < a.left + a.w + pad && a.top < b.top + b.h + pad && b.top < a.top + a.h + pad;
}

/** The 8 positions around a point, then the centred one first for a caption: right, left, above, below and the 4 corners. */
export function candidates(r: LabelRequest): Box[] {
  const { x, y, w, h } = r;
  const d = (r.radius ?? 3) + GAP;
  const list: Box[] = [
    { left: x + d, top: y - h / 2, w, h },
    { left: x - d - w, top: y - h / 2, w, h },
    { left: x - w / 2, top: y - d - h, w, h },
    { left: x - w / 2, top: y + d, w, h },
    { left: x + d, top: y - d - h, w, h },
    { left: x - d - w, top: y - d - h, w, h },
    { left: x + d, top: y + d, w, h },
    { left: x - d - w, top: y + d, w, h },
  ];
  if (r.centred) list.unshift({ left: x - w / 2, top: y - h / 2, w, h });
  return list;
}

/** The margins of the canvas that a label keeps clear, eg under the top bar and beside the rail of the window. */
export interface Safe {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NO_MARGIN: Safe = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Place the labels in the order given, which is the order of priority. A label is dropped when none of its positions
 * is inside the canvas and clear of the labels placed before it and of the boxes that other parts of the window cover
 * (the control group, the thought trail).
 */
export function placeLabels(requests: LabelRequest[], width: number, height: number, pad = 2, safe: Safe = NO_MARGIN, blocked: Box[] = []): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const r of requests) {
    const options = candidates(r);
    for (let i = 0; i < options.length; i += 1) {
      const c = options[i];
      if (c.left < safe.left || c.top < safe.top || c.left + c.w > width - safe.right || c.top + c.h > height - safe.bottom) continue;
      if (blocked.some((b) => overlaps(c, b, 0))) continue;
      if (placed.some((p) => overlaps(c, p, pad))) continue;
      placed.push({ key: r.key, left: c.left, top: c.top, w: c.w, h: c.h, x: r.x, y: r.y, moved: i > 0 });
      break;
    }
  }
  return placed;
}

/** The point of the box edge nearest to the target, for the end of a leader line. */
export function leaderEnd(box: Box, x: number, y: number): { x: number; y: number } {
  return { x: Math.min(box.left + box.w, Math.max(box.left, x)), y: Math.min(box.top + box.h, Math.max(box.top, y)) };
}

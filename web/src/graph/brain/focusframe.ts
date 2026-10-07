// The framing of a focused region (docs/BRAIN.md, "Focus"). The camera fits the 5th to 95th percentile box of the projected
// neurons of the region, in each axis, to the free area, so that a few outlying neurons do not shrink the frame: they may sit
// at the edge of the view or just outside it. Pure, and tested in focusframe.test.ts.

/** The value at the fraction q of an ascending list (linear between neighbours). */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const i = Math.floor(at);
  const j = Math.min(sorted.length - 1, i + 1);
  return sorted[i] + (sorted[j] - sorted[i]) * (at - i);
}

/** The lower and upper percentile of a list of numbers. */
export function percentileRange(values: number[], lo: number, hi: number): [number, number] {
  const s = values.slice().sort((a, b) => a - b);
  return [percentile(s, lo), percentile(s, hi)];
}

export interface FocusFit {
  /** each point as [along the screen x axis, along the screen y axis, along the view direction] in world units */
  co: number[][];
  /** scale (framing scale times focal length in pixels) */
  sf: number;
  /** the size of the free area in pixels that the percentile box must fit */
  availW: number;
  availH: number;
  /** where the centre of the box should land, in pixels from the view centre */
  wantX: number;
  wantY: number;
  minDist: number;
  maxDist: number;
  /** the percentiles that bound the box (by default the 5th and the 95th) */
  lo?: number;
  hi?: number;
}

export interface FocusResult {
  dist: number;
  /** the middle of the percentile box in world units along x, y and the view direction (depth uses the full range) */
  mid: number[];
  shift: number;
  lift: number;
  /** the projected percentile box in pixels from the view centre */
  box: { x0: number; x1: number; y0: number; y1: number };
}

/**
 * The distance, shift and lift at which the percentile box of the projected points fills the free area in width or height
 * and is centred where wanted. A point nearer to the camera looks larger and moves more with the shift, so the 3 values are
 * refined on the projected box.
 */
export function fitFocusFrame(f: FocusFit): FocusResult {
  const lo = f.lo ?? 0.05;
  const hi = f.hi ?? 0.95;
  const [x0, x1] = percentileRange(f.co.map((c) => c[0]), lo, hi);
  const [y0, y1] = percentileRange(f.co.map((c) => c[1]), lo, hi);
  let zlo = Infinity;
  let zhi = -Infinity;
  for (const c of f.co) {
    zlo = Math.min(zlo, c[2]);
    zhi = Math.max(zhi, c[2]);
  }
  const mid = [(x0 + x1) / 2, (y0 + y1) / 2, (zlo + zhi) / 2];
  let dist = Math.max(((x1 - x0) * f.sf) / f.availW, ((y1 - y0) * f.sf) / f.availH, f.minDist);
  let shift = (f.wantX * dist) / f.sf;
  let lift = 0;
  let box = { x0: 0, x1: 0, y0: 0, y1: 0 };
  const px = new Array<number>(f.co.length);
  const py = new Array<number>(f.co.length);
  for (let pass = 0; pass < 40; pass += 1) {
    f.co.forEach((c, i) => {
      const k = f.sf / Math.max(10, dist - (c[2] - mid[2]));
      px[i] = (c[0] - mid[0] + shift) * k;
      py[i] = (c[1] - mid[1] + lift) * k;
    });
    const [bx0, bx1] = percentileRange(px, lo, hi);
    const [by0, by1] = percentileRange(py, lo, hi);
    box = { x0: bx0, x1: bx1, y0: by0, y1: by1 };
    shift += (f.wantX - (bx0 + bx1) / 2) * (dist / f.sf);
    lift += (f.wantY - (by0 + by1) / 2) * (dist / f.sf);
    // the box must fit the free area in width and in height, so the larger of the 2 ratios sets the distance
    const need = Math.max((bx1 - bx0) / f.availW, (by1 - by0) / f.availH);
    dist = Math.max(f.minDist, Math.min(f.maxDist, dist * (1 + (need - 1) * 0.8)));
  }
  return { dist, mid, shift, lift, box };
}

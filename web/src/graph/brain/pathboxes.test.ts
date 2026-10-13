import { describe, expect, it } from "vitest";
import { mergeBadges, stepsLabel } from "./path";
import { estimateWidth, layoutCapsules, type Box, type CapsuleIn } from "./pathboxes";
import { overlaps, placeLabels, type LabelRequest } from "./labelplace";
import { BADGE_MAX, BADGE_MERGE_PX, BADGE_PX } from "./look";

/** The shown boxes of a frame: the placed capsules and the placed labels. */
function shownOverall(caps: CapsuleIn[], labels: LabelRequest[], obstacles: Box[] = []) {
  const layout = layoutCapsules(caps, obstacles, { left: 0, top: 0, right: 1440, bottom: 900 });
  const boxes: Box[] = layout.placed.map((c) => ({ left: c.left - 2, top: c.top - 2, w: c.w + 4, h: c.h + 4 }));
  const placed = placeLabels(labels, 1440, 900, 6, { left: 0, top: 0, right: 0, bottom: 0 }, [...obstacles, ...boxes]);
  return { layout, shown: [...layout.placed.map((c) => ({ left: c.left, top: c.top, w: c.w, h: c.h })), ...placed.map((p) => ({ left: p.left, top: p.top, w: p.w, h: p.h }))] };
}

function noTwoOverlap(boxes: Box[]): boolean {
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (overlaps(boxes[i], boxes[j], 0)) return false;
  return true;
}

const capsuleOf = (steps: number[], x: number, y: number): CapsuleIn => ({ steps, x, y, w: estimateWidth(stepsLabel(steps), BADGE_PX), h: BADGE_PX });

describe("the boxes over the canvas", () => {
  it("moves a badge that would cover another and keeps a leader to its node", () => {
    const { placed, hidden } = layoutCapsules([capsuleOf([3, 8], 500, 400), capsuleOf([4, 16], 512, 404), capsuleOf([5, 6, 7], 505, 396)]);
    expect(hidden).toHaveLength(0);
    expect(placed).toHaveLength(3);
    expect(noTwoOverlap(placed)).toBe(true);
    // the first stays on its node and the others stand off it with their node kept as the end of a leader
    expect(placed[0].moved).toBe(false);
    expect(placed.slice(1).every((c) => c.moved)).toBe(true);
    expect(placed[1].ax).toBe(512);
    expect(placed[1].ay).toBe(404);
  });

  it("keeps a badge clear of a finding marker and of a box that the window covers", () => {
    const pin: Box = { left: 508, top: 366, w: 22, h: 22 };
    const covered: Box = { left: 380, top: 380, w: 100, h: 40 };
    const { placed } = layoutCapsules([capsuleOf([2], 500, 380), capsuleOf([9], 440, 400)], [pin, covered]);
    for (const c of placed) {
      expect(overlaps(c, pin, 0)).toBe(false);
      expect(overlaps(c, covered, 0)).toBe(false);
    }
  });

  it("shows a revisited node as one badge with the step numbers in order", () => {
    const caps = mergeBadges([
      { step: 8, x: 300, y: 300 },
      { step: 3, x: 300, y: 300 },
      { step: 12, x: 640, y: 380 },
    ]);
    const sorted = caps.map((c) => stepsLabel(c.steps.slice().sort((a, b) => a - b)));
    expect(sorted).toEqual(["3 and 8", "12"]);
  });

  it("leaves no 2 shown boxes overlapping, badges and step labels together, over 200 random frames", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let frame = 0; frame < 200; frame += 1) {
      const count = 5 + Math.floor(rnd() * 60);
      const pts = Array.from({ length: count }, (_, i) => ({ step: i + 1, x: 420 + rnd() * 380, y: 80 + rnd() * 380 }));
      const caps = mergeBadges(pts, BADGE_MERGE_PX, BADGE_MAX).map((c) => capsuleOf(c.steps.slice().sort((a, b) => a - b), c.x, c.y));
      const labels: LabelRequest[] = pts.slice(0, 12).map((p) => ({ key: `s:${p.step}`, x: p.x, y: p.y, w: 150, h: 36, radius: 13 }));
      const obstacles: Box[] = [{ left: 0, top: 0, w: 380, h: 900 }];
      const { layout, shown } = shownOverall(caps, labels, obstacles);
      expect(noTwoOverlap(shown)).toBe(true);
      // every step is in a badge that is shown, in this density
      expect(layout.hidden).toHaveLength(0);
      expect(layout.placed.reduce((n, c) => n + c.steps.length, 0)).toBe(count);
    }
  });
});

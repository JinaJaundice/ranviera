// The tests of the third round of the traced path (13 October 2026): curves that stay in the brain, a fan of parallel segments,
// short faint branches for a step that loads many nodes, and one value for every caption of the position.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathControls } from "../PathControls";
import { PATH_CROWD, PATH_END_EPS, PATH_FAN_MAX_UNITS } from "./look";
import {
  agentPath,
  buildPath,
  clampVolume,
  currentStep,
  fanAmounts,
  pathAtEnd,
  samplePoint,
  stepCaption,
  stepOfProgress,
  type V3,
} from "./path";
import { BRAIN, RUN_0001, RUN_0012, promptSteps, volumeFor, worldOf } from "./pathfixtures";

const inside = (p: V3, h: V3): number => Math.hypot(p.x / h.x, p.y / h.y, p.z / h.z);

describe("curves stay inside the brain", () => {
  it("does not let a far neighbour throw a segment outside the brain", () => {
    const a: V3 = { x: 60, y: 10, z: 0 };
    const b: V3 = { x: 40, y: 10, z: 30 };
    const far0: V3 = { x: 900, y: 700, z: -800 };
    const far3: V3 = { x: -900, y: 800, z: 900 };
    const zero = { x: 0, y: 0, z: 0 };
    let worst = 0;
    for (let i = 0; i <= 20; i += 1) {
      const p = samplePoint(far0, a, b, far3, i / 20, zero);
      worst = Math.max(worst, Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z));
    }
    // the tangent is at most 0.7 of the segment, so the curve stays within a segment length of its ends
    expect(worst).toBeLessThan(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 1.1);
  });

  it("clamps a point to the volume and leaves one inside alone", () => {
    expect(clampVolume({ x: 10, y: 5, z: 3 }, BRAIN)).toEqual({ x: 10, y: 5, z: 3 });
    const out = clampVolume({ x: 500, y: 400, z: 300 }, BRAIN);
    expect(inside(out, BRAIN)).toBeCloseTo(1, 9);
  });

  it.each([
    ["the prompt of 45 steps", () => promptSteps(45)],
    ["run AL-2026-0001", () => agentPath(RUN_0001(), () => true).steps],
    ["run AL-2026-0012", () => agentPath(RUN_0012(), () => true).steps],
  ])("keeps every sample point and branch point of %s inside the volume of the brain", (_n, make) => {
    const g = buildPath(make(), worldOf, { volume: volumeFor() });
    const e = g.line.ends;
    let worst = 0;
    for (let i = 0; i + 2 < e.length; i += 3) worst = Math.max(worst, inside({ x: e[i], y: e[i + 1], z: e[i + 2] }, BRAIN));
    for (const b of g.branches) for (const p of b.points) worst = Math.max(worst, inside(p, BRAIN));
    expect(worst).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe("a step that loads many nodes", () => {
  const g = buildPath(agentPath(RUN_0001(), () => true).steps, worldOf, { volume: volumeFor() });
  const loaded = agentPath(RUN_0001(), () => true).steps[1];

  it("keeps the 27 instructions off the main line and draws them as branches of the step", () => {
    expect(loaded.sentence).toBe("Loaded 27 instructions");
    expect(loaded.activation.filter((a) => a.hop === 0)).toHaveLength(1);
    expect(g.ranges[1].slots).toHaveLength(1);
    expect(g.branches.filter((b) => b.step === 2)).toHaveLength(27);
  });

  it("draws at most 1 branch in 3 as a short faint branch and the rest as dots", () => {
    const own = g.branches.filter((b) => b.step === 2);
    expect(own.length).toBeGreaterThan(PATH_CROWD);
    expect(own.every((b) => b.crowded)).toBe(true);
    const lines = own.filter((b) => !b.dot);
    expect(lines.length).toBeLessThanOrEqual(Math.ceil(own.length / 3));
    expect(lines.length).toBeGreaterThan(0);
    for (const b of lines) {
      // a short branch stops before its node, where its knot stands
      const end = b.points[b.points.length - 1];
      const full = Math.hypot(b.tip.x - b.points[0].x, b.tip.y - b.points[0].y, b.tip.z - b.points[0].z);
      expect(Math.hypot(end.x - b.points[0].x, end.y - b.points[0].y, end.z - b.points[0].z)).toBeLessThan(full);
    }
    // a dot has a line of almost no length that is never zero
    for (const b of own.filter((x) => x.dot)) {
      const first = b.points[0];
      const last = b.points[b.points.length - 1];
      const d = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(1);
    }
  });

  it("leaves a step with few nodes on the main line", () => {
    const few = agentPath(RUN_0012(), () => true).steps[1];
    expect(few.activation.every((a) => a.hop === 0)).toBe(false);
    const small = buildPath(promptSteps(6), worldOf, { volume: volumeFor() });
    expect(small.branches.every((b) => !b.crowded)).toBe(true);
  });
});

describe("segments that share their ends", () => {
  it("offsets segments that share both ends by their step order, a few units apart", () => {
    const amounts = fanAmounts([
      { from: "", to: "a", drawn: false },
      { from: "a", to: "b", drawn: true },
      { from: "b", to: "a", drawn: true },
      { from: "a", to: "b", drawn: true },
      { from: "x", to: "c", drawn: true },
    ]);
    expect(amounts[4]).toBe(0);
    const three = [amounts[1], amounts[2] * -1, amounts[3]];
    expect(three[0]).toBeLessThan(three[1]);
    expect(three[1]).toBeLessThan(three[2]);
    expect(Math.abs(three[2] - three[0])).toBeGreaterThan(2);
    expect(Math.abs(three[2] - three[0])).toBeLessThanOrEqual(PATH_FAN_MAX_UNITS);
  });

  it("separates the chains of run AL-2026-0001 that end at one provision, so that each curve can be followed", () => {
    const steps = agentPath(RUN_0001(), () => true).steps;
    const g = buildPath(steps, worldOf, { volume: volumeFor() });
    // the chain steps are those of kind run.chain, and each has a main line piece that ends at the shared provision
    const chains = steps.filter((s) => s.kind === "run.chain").map((s) => s.n);
    expect(chains.length).toBe(6);
    const end = (n: number): V3 => {
      const r = g.ranges[n - 1];
      const slot = r.slots[r.slots.length - 1];
      // the middle of the last piece of the step: the point at half of its arc length
      const arc = (slot.arc0 + slot.arc1) / 2;
      let best = 0;
      for (let i = 0; i < g.line.count; i += 1) if (g.line.arcs[i * 2] <= arc) best = i;
      return { x: g.line.ends[best * 6], y: g.line.ends[best * 6 + 1], z: g.line.ends[best * 6 + 2] };
    };
    const mids = chains.map(end);
    for (let i = 0; i < mids.length; i += 1) {
      for (let j = i + 1; j < mids.length; j += 1) {
        expect(Math.hypot(mids[i].x - mids[j].x, mids[i].y - mids[j].y, mids[i].z - mids[j].z)).toBeGreaterThan(1.5);
      }
    }
  });
});

describe("one value for every caption of the position", () => {
  it("names the step that has just played, not the next one, when the head parks at the end of a step", () => {
    const parked = 11 - PATH_END_EPS;
    expect(currentStep(parked, 16)).toBe(10);
    expect(stepOfProgress(buildPath(promptSteps(16), worldOf, { volume: volumeFor() }), parked).n).toBe(10);
    expect(stepCaption(parked, 16)).toBe("End of step 10");
    expect(stepCaption(11, 16)).toBe("Step 11");
    expect(stepCaption(10.5, 16)).toBe("Step 10, 50 per cent");
    expect(stepCaption(0, 16)).toBe("Before step 1");
  });

  it("reads the last step to the end of the path", () => {
    expect(currentStep(17, 16)).toBe(16);
    expect(currentStep(40, 16)).toBe(16);
    expect(pathAtEnd(17, 16)).toBe(true);
    expect(pathAtEnd(17 - PATH_END_EPS, 16)).toBe(true);
    expect(pathAtEnd(11 - PATH_END_EPS, 16)).toBe(false);
    expect(stepCaption(17, 16)).toBe("End of step 16");
  });

  it("gives the caption, the value text and the paused line of the panel the same step at every position", () => {
    const html = (position: number) =>
      renderToStaticMarkup(
        createElement(PathControls, {
          count: 16,
          track: [],
          position,
          playing: false,
          held: Math.max(1, currentStep(position, 16)),
          follow: true,
          previous: false,
          canPrevious: false,
          onToggle: () => undefined,
          onSeek: () => undefined,
          onWhole: () => undefined,
          onFollow: () => undefined,
          onPrevious: () => undefined,
          onLive: () => undefined,
        }),
      );
    for (const position of [1, 3.25, 9.99, 10, 10.5, 11 - PATH_END_EPS, 11, 16.5, 17 - PATH_END_EPS, 17]) {
      const n = Math.max(1, currentStep(position, 16));
      const out = html(position);
      expect(out).toContain(`Paused at step ${n}`);
      expect(out).toContain(`aria-valuetext="${stepCaption(position, 16)}"`);
      expect(out).toContain(`>${stepCaption(position, 16)}<`);
      // the caption never names a different step from the paused line
      const named = stepCaption(position, 16).match(/step (\d+)|Step (\d+)/i);
      expect(Number(named?.[1] ?? named?.[2])).toBe(n);
    }
    // the case of the review: the head parked at the end of step 10 reads step 10 in the caption and in the panel
    const parked = html(11 - PATH_END_EPS);
    expect(parked).toContain("Paused at step 10");
    expect(parked).not.toContain("Step 11");
  });
});

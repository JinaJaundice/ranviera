// The tests of the fourth round of the traced path (13 October 2026): the plates that every step can show, the finding that is always
// captioned, the ends of steps that share a node, the step by step keys of the scrubber and the labels that are placed far.
import { describe, expect, it } from "vitest";
import { candidates, placeLabels } from "./labelplace";
import { agentPath, buildPath, neighbourStep, orderPlatePicks, plateSentence, platePicks, spreadAround } from "./path";
import { PATH_PLATE_CHARS, PATH_SPREAD_AFTER, PATH_SPREAD_UNITS } from "./look";
import { BRAIN, RUN_0001, RUN_0012, volumeFor, worldOf } from "./pathfixtures";

describe("the plates of the whole path", () => {
  it("places the steps with a finding first, then those of the badge under the pointer, then the rest", () => {
    const base = platePicks(17, [8], []);
    const out = orderPlatePicks(base, [8], [4, 5, 6]);
    expect(out.picks.slice(0, 4)).toEqual([8, 4, 5, 6]);
    expect(out.urgent).toEqual([8, 4, 5, 6]);
    expect(new Set(out.picks).size).toBe(out.picks.length);
    expect(out.picks.length).toBe(new Set([...base, 4, 5, 6]).size);
  });

  it("keeps a step with a finding in the list when the plates are limited", () => {
    expect(platePicks(40, [33], [], 3)).toContain(33);
    expect(orderPlatePicks(platePicks(40, [33], [], 3), [33], []).picks[0]).toBe(33);
  });

  it("cuts a long sentence at a word and keeps a short one whole", () => {
    expect(plateSentence("Read the alert")).toBe("Read the alert");
    const long = "Compare date and place of birth (version 1) implements clause FCP 8.2 Comparison of identifiers, which realises the control Assessment of each screening alert";
    const cut = plateSentence(long);
    expect(cut.length).toBeLessThanOrEqual(PATH_PLATE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut).not.toMatch(/[ ,;:]…$/);
  });
});

describe("a label that must be shown", () => {
  it("tries places further out when the 8 places round its point are taken", () => {
    const near = { key: "s:8", x: 400, y: 300, w: 200, h: 40 };
    expect(candidates({ ...near, far: true }).length).toBeGreaterThan(candidates(near).length);
    const blocked = candidates(near).map((c) => ({ ...c }));
    expect(placeLabels([near], 1000, 800, 6, undefined, blocked)).toHaveLength(0);
    const placed = placeLabels([{ ...near, far: true }], 1000, 800, 6, undefined, blocked);
    expect(placed).toHaveLength(1);
    expect(placed[0].moved).toBe(true);
  });
});

describe("steps that end at one node", () => {
  const steps = () => agentPath(RUN_0001(), () => true).steps;

  it("ends each of the steps 9 to 14 of AL-2026-0001 at a place of its own round the provision", () => {
    const g = buildPath(steps(), worldOf, { volume: volumeFor() });
    const node = g.knots.filter((k) => k.id === "prov:shared");
    expect(node.length).toBeGreaterThanOrEqual(PATH_SPREAD_AFTER);
    for (let i = 0; i < node.length; i += 1) {
      for (let j = i + 1; j < node.length; j += 1) {
        const a = node[i].pos;
        const b = node[j].pos;
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(PATH_SPREAD_UNITS * 0.4);
      }
    }
    const home = worldOf("prov:shared")!.pos;
    for (const w of node) expect(Math.hypot(w.pos.x - home.x, w.pos.y - home.y, w.pos.z - home.z)).toBeLessThanOrEqual(PATH_SPREAD_UNITS + 1e-6);
    // the line of a step ends where its knot stands
    const e = g.line.ends;
    const ends = new Set<string>();
    for (let i = 0; i + 5 < e.length; i += 6) ends.add(`${e[i + 3].toFixed(3)},${e[i + 4].toFixed(3)},${e[i + 5].toFixed(3)}`);
    for (const k of node) expect(ends.has(`${k.pos.x.toFixed(3)},${k.pos.y.toFixed(3)},${k.pos.z.toFixed(3)}`)).toBe(true);
  });

  it("leaves a node that only 2 steps visit on the node", () => {
    const g = buildPath(agentPath(RUN_0012(), () => true).steps, worldOf, { volume: volumeFor() });
    const twice = new Map<string, number>();
    for (const w of g.waypoints) if (w.node) twice.set(w.node, (twice.get(w.node) ?? 0) + 1);
    for (const w of g.waypoints) if (w.node && (twice.get(w.node) ?? 0) === 2) expect(w.pos).toEqual(worldOf(w.node)!.pos);
  });

  it("spreads n places over a sphere without two the same", () => {
    const at = { x: 10, y: 20, z: 30 };
    const pts = Array.from({ length: 5 }, (_, k) => spreadAround(at, k, 5));
    for (const p of pts) expect(Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z)).toBeLessThanOrEqual(PATH_SPREAD_UNITS + 1e-9);
    expect(new Set(pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`)).size).toBe(5);
    expect(BRAIN.x).toBeGreaterThan(0);
  });
});

describe("the arrow keys of the scrubber", () => {
  it("move to the next whole step and back to the start of the step or the one before", () => {
    expect(neighbourStep(3, 17, 1)).toBe(4);
    expect(neighbourStep(3.5, 17, 1)).toBe(4);
    expect(neighbourStep(17.2, 17, 1)).toBe(17);
    expect(neighbourStep(3.5, 17, -1)).toBe(3);
    expect(neighbourStep(3, 17, -1)).toBe(2);
    expect(neighbourStep(1, 17, -1)).toBe(1);
  });
});

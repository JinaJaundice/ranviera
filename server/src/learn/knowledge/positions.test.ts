import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COORDINATE_LIMIT, depthRanks, layout, sanitizePositions, unit, type LayoutInput, type PositionMap } from "./positions.ts";
import { defaultRenderSettings } from "./render-settings.ts";
import { chain, lines, node, open, prov, read, rng, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

const physics = defaultRenderSettings().physics;

function chainGraph(n: number, extra: { id: string; link: string }[] = []): LayoutInput {
  const ids = [...Array.from({ length: n }, (_, i) => `n_${String(i).padStart(2, "0")}`), ...extra.map((e) => e.id)];
  const links = [
    ...Array.from({ length: n - 1 }, (_, i) => ({ from: ids[i], to: ids[i + 1] })),
    ...extra.map((e) => ({ from: e.link, to: e.id })),
  ];
  return { nodes: ids.map((id) => ({ id })), links, logicalEdges: links, impLinks: [], prior: {}, physics };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("seeds", () => {
  it("property: a seed depends only on the id and the salt, and lies in [0, 1)", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const id = `n_${Math.floor(r() * 1e9).toString(16)}`;
      const u = unit(id, "x");
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(unit(id, "x")).toBe(u);
    }
    expect(unit("n_1", "x")).not.toBe(unit("n_1", "y"));
    expect(unit("n_1", "x")).not.toBe(unit("n_2", "x"));
  });
});

describe("layout", () => {
  it("property: the same input gives the same positions, whatever the order of nodes and links", () => {
    const r = rng(11);
    for (let round = 0; round < 5; round++) {
      const input = chainGraph(8 + round, [{ id: "n_x1", link: "n_03" }, { id: "n_x2", link: "n_x1" }]);
      const first = layout(input);
      expect(layout(input)).toEqual(first);
      const shuffle = <T>(xs: T[]): T[] => xs.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
      expect(layout({ ...input, nodes: shuffle(input.nodes), links: shuffle(input.links) })).toEqual(first);
    }
  });

  it("the first settle scatters and then lays out every node with finite coordinates", () => {
    const out = layout(chainGraph(12));
    expect(Object.keys(out)).toHaveLength(12);
    for (const p of Object.values(out)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(layout({ ...chainGraph(1), links: [] })).toEqual({ n_00: expect.any(Object) });
  });

  it("a warm start keeps the nodes near their anchors and seeds a new node near its neighbour", () => {
    const base = layout(chainGraph(10));
    const grown = layout({ ...chainGraph(10, [{ id: "n_new", link: "n_05" }]), prior: base });
    const moved = Object.keys(base).map((id) => dist(base[id], grown[id]));
    expect(Math.max(...moved)).toBeLessThan(40);
    expect(dist(grown.n_new, grown.n_05)).toBeLessThan(150);
    const again = layout({ ...chainGraph(10, [{ id: "n_new", link: "n_05" }]), prior: base });
    expect(again).toEqual(grown);
  });

  it("a new node with no positioned neighbour seeds on a rim outside the core", () => {
    const base = layout(chainGraph(6));
    const input: LayoutInput = { ...chainGraph(6), prior: base };
    input.nodes = [...input.nodes, { id: "n_lone" }];
    const out = layout(input);
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    const meanAnchored = Object.values(base).reduce((s, p) => s + radius(p), 0) / 6;
    expect(radius(out.n_lone)).toBeGreaterThan(meanAnchored);
  });

  it("depth anchoring in vertical mode puts a conclusion above its premises", () => {
    const input = chainGraph(4);
    const out = layout({ ...input, physics: { ...physics, depthMode: "vertical", depthStrength: 3.2, depthSpacing: 120 } });
    expect(out.n_03.y).toBeLessThan(out.n_02.y);
    expect(out.n_02.y).toBeLessThan(out.n_01.y);
    expect(out.n_01.y).toBeLessThan(out.n_00.y);
  });

  it("depth anchoring in radial mode puts deeper nodes on larger rings", () => {
    const input = chainGraph(4);
    const out = layout({ ...input, physics: { ...physics, depthMode: "radial", depthStrength: 3.2, depthSpacing: 120, depthBaseRadius: 100 } });
    const r = (id: string) => Math.hypot(out[id].x, out[id].y);
    expect(r("n_03")).toBeGreaterThan(r("n_02"));
    expect(r("n_02")).toBeGreaterThan(r("n_00"));
  });

  it("ignores a link to an unknown node and a self loop", () => {
    const input = chainGraph(3);
    input.links.push({ from: "n_00", to: "n_missing" }, { from: "n_01", to: "n_01" });
    expect(Object.keys(layout(input))).toEqual(["n_00", "n_01", "n_02"]);
  });
});

describe("depth ranks", () => {
  it("is the longest path from a base node, and a cycle shares one depth", () => {
    const rank = depthRanks(["a", "b", "c", "d", "x", "y", "lone"], [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "c", to: "d" },
      { from: "x", to: "y" }, { from: "y", to: "x" }, { from: "y", to: "d" },
    ]);
    expect(Object.fromEntries(rank)).toEqual({ a: 0, b: 1, c: 2, d: 3, x: 0, y: 0, lone: 0 });
  });
});

describe("committing positions", () => {
  it("B-2-19 keeps finite values of known ids and clamps them to plus or minus 1,000,000", () => {
    const out = sanitizePositions(
      { a: { x: 5, y: -5 }, b: { x: 9e9, y: -9e9 }, c: { x: Number.NaN, y: 1 }, d: { x: 1 }, e: "no", unknown: { x: 1, y: 1 } },
      new Set(["a", "b", "c", "d", "e"]),
    );
    expect(out).toEqual({ a: { x: 5, y: -5 }, b: { x: COORDINATE_LIMIT, y: -COORDINATE_LIMIT } });
    expect(sanitizePositions(null)).toEqual({});
    expect(sanitizePositions([1, 2])).toEqual({});
  });

  function seeded() {
    const dir = tempDir();
    write(dir, "graph/nodes.jsonl", lines([node("n_1", "One", "A."), node("n_2", "Two", "B."), node("n_3", "Three", "C.")]));
    write(dir, "graph/chains.jsonl", lines([chain("arg_1", ["n_1", "n_2"], "n_3", [prov("c")])]));
    return dir;
  }

  it("writes a complete drag as it is and an empty one not at all", () => {
    const dir = seeded();
    const k = open(dir);
    expect(k.commitPositions({ nope: { x: 1, y: 1 } })).toEqual({});
    expect(fs.existsSync(path.join(dir, "graph/positions.json"))).toBe(false);
    const all = { n_1: { x: 1, y: 2 }, n_2: { x: 3, y: 4 }, n_3: { x: 5, y: 6 }, arg_1: { x: 7, y: 8 } };
    expect(k.commitPositions({ ...all, stray: { x: 0, y: 0 } })).toEqual(all);
    expect(JSON.parse(read(dir, "graph/positions.json")).positions).toEqual(all);
  });

  it("settles once with the client positions as anchors when the graph grew during the drag", () => {
    const dir = seeded();
    const out = open(dir).commitPositions({ n_1: { x: 100, y: 100 }, n_2: { x: 120, y: 100 } });
    expect(Object.keys(out).sort()).toEqual(["arg_1", "n_1", "n_2", "n_3"]);
    expect(dist(out.n_1, { x: 100, y: 100 })).toBeLessThan(60);
  });

  it("the settle after a merge writes every node and junction, and a second settle is warm started and equal", () => {
    const dir = seeded();
    const k = open(dir);
    const first: PositionMap = k.settle();
    expect(Object.keys(first).sort()).toEqual(["arg_1", "n_1", "n_2", "n_3"]);
    expect(Object.keys(k.snapshot().positions ?? {}).sort()).toEqual(["arg_1", "n_1", "n_2", "n_3"]);
    const twin = tempDir();
    fs.cpSync(dir, twin, { recursive: true });
    const second = k.settle();
    for (const id of Object.keys(first)) expect(dist(first[id], second[id])).toBeLessThan(40);
    expect(open(twin).settle()).toEqual(second);
  });
});

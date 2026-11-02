import { describe, expect, it } from "vitest";
import { buildChainTable, filterSources, searchClaims, sortSources, spokenLine, symbolLine, visibleRows, DEFAULT_SORT } from "./chains";
import { CARD_WIDTH, calibrationWords, cardPosition, locatorFor, locatorWords, passageRange, sourcesOf, supportWords } from "./card";
import { buildScene, clusterOutlines, nodeRadius, positionsOf, settleJunctions } from "./scene";
import { LADDERS, defaultSettings, gateWords, positionOf, readSettings, stopOf, valueAt, withLadder, withRegion } from "./settings";
import { makeSnapshot } from "./testkit";

describe("scene", () => {
  it("makes a disc for each claim and a junction for each multi premise argument, with no label or pick for the junction", () => {
    const scene = buildScene(makeSnapshot(), 2);
    expect(scene.nodes.filter((n) => n.kind === "junction").map((n) => n.id)).toEqual(["arg_1"]);
    expect(scene.byId.get("n_a1")?.kind).toBe("proposition");
  });

  it("draws a head only on a line that ends on a claim", () => {
    const scene = buildScene(makeSnapshot(), 2);
    const into = scene.links.filter((l) => l.to === "arg_1");
    const out = scene.links.find((l) => l.from === "arg_1");
    expect(into.every((l) => !l.arrow)).toBe(true);
    expect(out?.arrow).toBe(true);
    expect(scene.links.find((l) => l.from === "n_a3")?.arrow).toBe(true);
  });

  it("sizes a claim by the arguments it joins", () => {
    const scene = buildScene(makeSnapshot(), 2);
    expect(scene.byId.get("n_b2")!.chains).toBe(2);
    expect(scene.byId.get("n_c1")!.chains).toBe(0);
    expect(scene.byId.get("n_b2")!.r).toBeGreaterThan(scene.byId.get("n_c1")!.r);
    expect(nodeRadius(0, 4)).toBe(2 * nodeRadius(0, 2));
  });

  it("keeps known positions exactly and places a junction between its premises and its conclusion", () => {
    const scene = buildScene(makeSnapshot(), 2);
    expect(scene.byId.get("n_a1")).toMatchObject({ x: 0, y: 0 });
    const j = scene.byId.get("arg_1")!;
    expect(j.x).toBeCloseTo((((40 + 0) / 2) + 240) / 2);
    expect(j.y).toBeCloseTo((((40 + 0) / 2) + 40) / 2);
  });

  it("moves the junction when a premise moves, and commits every node of the view", () => {
    const scene = buildScene(makeSnapshot(), 2);
    const before = scene.byId.get("arg_1")!.x;
    scene.byId.get("n_a1")!.x -= 100;
    settleJunctions(scene);
    expect(scene.byId.get("arg_1")!.x).toBeLessThan(before);
    const out = positionsOf(scene);
    expect(Object.keys(out).sort()).toEqual(scene.nodes.map((n) => n.id).sort());
  });

  it("lets a position that was just committed win over the snapshot", () => {
    const scene = buildScene(makeSnapshot(), 2, { n_a1: { x: 5, y: 6 } });
    expect(scene.byId.get("n_a1")).toMatchObject({ x: 5, y: 6 });
  });

  it("gives a cluster of three or more members an outline and names it from the session or file", () => {
    const snap = makeSnapshot();
    snap.clusters.push({ id: "chat_1", label: null, members: ["n_c1"] });
    const scene = buildScene(snap, 2);
    expect(scene.clusters.map((c) => c.label)).toEqual(["Notes/entropy.md", "Notes/thermodynamics.md", "Thermodynamics lecture"]);
    const outlines = clusterOutlines(scene, 10);
    expect(outlines.map((o) => o.cluster.id)).toEqual(["src_ent", "src_th"]);
  });
});

describe("chain table (B-6-09, B-6-11, B-6-13, B-6-15)", () => {
  const snap = makeSnapshot();
  const table = buildChainTable(snap);

  it("groups each chain under the source where it was first read", () => {
    expect(table.map((s) => s.label).sort()).toEqual(["Notes/entropy.md", "Notes/thermodynamics.md"]);
    const th = table.find((s) => s.id === "src_th")!;
    expect(th.chains).toHaveLength(2);
    expect(th.propositions).toBe(4);
  });

  it("writes the logic as symbols and as words for assistive technology", () => {
    expect(symbolLine(["A", "B"], "C")).toBe("A ∧ B ⟹ C");
    expect(symbolLine([], "C")).toBe("C");
    expect(spokenLine(["A", "B"], "C")).toBe("A and B imply C");
    expect(spokenLine(["A"], "C")).toBe("A implies C");
    expect(spokenLine(["A", "B", "D"], "C")).toBe("A, B and D imply C");
    const chain = table.flatMap((s) => s.chains).find((c) => c.id === "arg_1")!;
    expect(chain.symbols).toBe("Entropy rise ∧ Heat flow ⟹ Engine limit");
  });

  it("sorts largest first by default, with the direction and the tie break by name", () => {
    expect(sortSources(table, DEFAULT_SORT).map((s) => s.id)).toEqual(["src_th", "src_ent"]);
    expect(sortSources(table, { key: "name", dir: "asc" }).map((s) => s.label)).toEqual(["Notes/entropy.md", "Notes/thermodynamics.md"]);
    expect(sortSources(table, { key: "created", dir: "desc" })[0].id).toBe("src_th");
    const chains = sortSources(table, { key: "propositions", dir: "desc" }).find((s) => s.id === "src_th")!.chains;
    expect(chains[0].statements.length).toBeGreaterThanOrEqual(chains[1].statements.length);
  });

  it("filters by a fuzzy query over names, aliases and statements, keeping the chains that match", () => {
    expect(filterSources(table, "").length).toBe(2);
    const hit = filterSources(table, "downhill");
    expect(hit.map((s) => s.id)).toEqual(["src_th"]);
    expect(hit[0].chains.map((c) => c.id)).toEqual(["arg_1"]);
    expect(filterSources(table, "zzzzqq")).toEqual([]);
    expect(filterSources(table, "entropy.md")[0].chains).toHaveLength(1);
  });

  it("starts collapsed, opens the matching sources while searching and honours a closed source", () => {
    expect(visibleRows(table, new Set(), new Set(), false)).toHaveLength(2);
    const opened = visibleRows(table, new Set(["src_th"]), new Set(), false);
    expect(opened.map((r) => r.level)).toEqual([1, 1, 2, 2].sort());
    const searching = visibleRows(table, new Set(), new Set(), true);
    expect(searching.filter((r) => r.level === 2).length).toBeGreaterThan(0);
    const closedOne = visibleRows(table, new Set(), new Set(["src_th", "src_ent"]), true);
    expect(closedOne).toHaveLength(2);
  });

  it("opens a chain into its statements and links each row to its parent", () => {
    const rows = visibleRows(table, new Set(["src_th", "src_th/arg_1"]), new Set(), false);
    const stmt = rows.filter((r) => r.level === 3);
    expect(stmt).toHaveLength(3);
    expect(stmt.every((r) => r.parentId === "src_th/arg_1")).toBe(true);
  });

  it("searches claims across names, aliases and statements, best first", () => {
    expect(searchClaims(snap, "engines convert")[0]).toBe("n_a2");
    expect(searchClaims(snap, "")).toEqual([]);
    expect(searchClaims(snap, "entropy")[0]).toBe("n_a3");
  });
});

describe("node card", () => {
  it("lists each source once in the order recorded, naming sessions and files", () => {
    const snap = makeSnapshot();
    const p = snap.propositions[0];
    p.provenance = [
      { chatId: "src_ent", messageId: "" },
      { chatId: "chat_1", messageId: "m1" },
      { chatId: "src_ent", messageId: "" },
      { chatId: "gone", messageId: "" },
    ];
    expect(sourcesOf(p, snap)).toEqual([
      { id: "src_ent", label: "Notes/entropy.md", kind: "file" },
      { id: "chat_1", label: "Thermodynamics lecture", kind: "session" },
    ]);
  });

  it("hangs below a claim in the upper part of the canvas and above one near the bottom, inside the sides", () => {
    const area = { w: 800, h: 700 };
    expect(cardPosition({ x: 400, y: 100 }, area).top).toBeDefined();
    const low = cardPosition({ x: 400, y: 600 }, area);
    expect(low.bottom).toBeDefined();
    expect(low.top).toBeUndefined();
    expect(cardPosition({ x: 5, y: 100 }, area).left).toBe(8);
    expect(cardPosition({ x: 795, y: 100 }, area).left).toBe(800 - CARD_WIDTH - 8);
    expect(cardPosition({ x: 400, y: 100 }, area).maxHeight).toBeGreaterThan(300);
  });

  it("words the derived fields", () => {
    expect(supportWords(0)).toBe("No source recorded");
    expect(supportWords(1)).toBe("1 source or session");
    expect(supportWords(3)).toBe("3 sources and sessions");
    expect(calibrationWords(null)).toBe("Not yet measured");
    expect(calibrationWords({ n: 12, meanConfidence: 0.8, accuracy: 0.6, gap: 0.2, band: "overconfident" })).toBe(
      "Overconfident. Over 12 answers, the mean confidence was 80% and the accuracy was 60%.",
    );
  });

  it("chooses the newest locator and opens the passage a little wider than the quote", () => {
    const l = (at: string, start: number | null, found = true) => ({ nodeId: "n1", sourceId: "src_a", fileSha256: "x", startLine: start, endLine: start === null ? null : start + 2, page: null, heading: null, quote: "q", found, at });
    const list = [l("2026-10-01", 5), l("2026-10-03", 40), { ...l("2026-10-05", 9), sourceId: "src_b" }];
    expect(locatorFor(list, "n1", "src_a")?.startLine).toBe(40);
    expect(locatorWords(locatorFor(list, "n1", "src_a"))).toBe("Lines 40 to 42");
    expect(locatorWords(l("2026-10-01", null, false))).toBeNull();
    expect(passageRange(l("2026-10-01", 40))).toEqual({ from: 37, to: 45 });
    expect(passageRange(l("2026-10-01", 2))).toEqual({ from: 1, to: 7 });
    expect(passageRange(undefined)).toEqual({ from: 1 });
  });
});

describe("render settings (B-6-53, B-6-55)", () => {
  it("has eleven stops in every ladder, with the default at stop five", () => {
    const d = defaultSettings();
    for (const ladder of Object.values(LADDERS)) expect(ladder).toHaveLength(11);
    expect(stopOf(d.nodeSize, LADDERS.nodeSize)).toBe(5);
    expect(stopOf(d.edgeWidth, LADDERS.edgeWidth)).toBe(5);
    expect(stopOf(d.labelSize, LADDERS.labelSize)).toBe(5);
    expect(stopOf(d.labelZoom, LADDERS.labelZoom)).toBe(5);
    expect(stopOf(d.clusterLabelSize, LADDERS.clusterLabelSize)).toBe(5);
  });

  it("round trips every slider position from 0 to 100 through every ladder", () => {
    for (const ladder of Object.values(LADDERS)) {
      for (let p = 0; p <= 100; p += 10) expect(positionOf(valueAt(p, ladder), ladder)).toBe(p);
    }
  });

  it("snaps to the nearest stop, with a tie going to the lower stop", () => {
    expect(stopOf(2.2, LADDERS.nodeSize)).toBe(5);
    expect(stopOf(2.3, LADDERS.nodeSize)).toBe(5);
    expect(stopOf(99, LADDERS.nodeSize)).toBe(10);
    expect(valueAt(-50, LADDERS.nodeSize)).toBe(0.25);
    expect(valueAt(500, LADDERS.nodeSize)).toBe(12);
  });

  it("changes one value and leaves the rest, and fills the gaps of a stored file", () => {
    const d = defaultSettings();
    expect(withLadder(d, "nodeSize", 100).nodeSize).toBe(12);
    expect(withLadder(d, "nodeSize", 100).edgeWidth).toBe(d.edgeWidth);
    expect(withRegion(d, { enabled: false }).regions.dilation).toBe(20);
    expect(readSettings(null)).toEqual(d);
    const partial = readSettings({ ...d, nodeSize: 4, regions: { enabled: false } } as never);
    expect(partial.nodeSize).toBe(4);
    expect(partial.regions.blur).toBe(40);
    expect(gateWords(0.5)).toBe("1 times");
  });
});

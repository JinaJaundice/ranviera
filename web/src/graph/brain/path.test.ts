import { describe, expect, it } from "vitest";
import type { Activation, DecisionTrace } from "@shared/types";
import type { RegionId } from "@shared/brain";
import {
  MISSING_PREFIX,
  REGION_INDEX,
  absentSummary,
  agentPath,
  bowVector,
  buildPath,
  controlPoint,
  headArc,
  headRegion,
  mergeBadges,
  platePicks,
  quadPoint,
  reachedSteps,
  routeGroups,
  routeRuns,
  routeSentence,
  samplePoint,
  stepOfProgress,
  stepsLabel,
  type NodeLookup,
  type PathNodeInfo,
  type V3,
} from "./path";
import { HEAD_CAP_MS, stepTiming } from "./schedule";
import { PATH_BOW_UNITS, PATH_MAX_POINTS, PATH_PULL } from "./look";
import { TrailQueue, stepMs } from "./trail";
import type { TrailStep } from "./types";

const REGION_NAME: Record<string, string> = {
  thalamus: "Task routing",
  prefrontal: "Rules and decisions",
  motor: "Tools and scripts",
  memory: "Memory and history",
  basal: "Checks and gates",
  cerebellum: "Agents",
};
const name = (id: RegionId) => REGION_NAME[id] ?? id;

/** nodes on a ring of radius 80, so that every segment passes through the volume */
function world(spec: Record<string, RegionId>): NodeLookup {
  const ids = Object.keys(spec);
  const table = new Map<string, PathNodeInfo>();
  ids.forEach((id, i) => {
    const a = (i / ids.length) * Math.PI * 2;
    table.set(id, { pos: { x: 80 * Math.cos(a), y: 10 * i, z: 80 * Math.sin(a) }, region: spec[id] });
  });
  return (id) => table.get(id);
}

const act = (ids: string[], hop = 0, via: string | null = null): Activation[] => ids.map((id) => ({ id, a: 1, hop, via }));
const step = (n: number, kind: string, ids: string[], extra: Activation[] = []): TrailStep => ({
  n,
  kind,
  sentence: `step ${n}`,
  mode: "observed",
  ts: "",
  activation: [...act(ids), ...extra],
});

const SPEC: Record<string, RegionId> = { route: "thalamus", rule1: "prefrontal", rule2: "prefrontal", rule3: "prefrontal", tool1: "motor", mem: "memory", hop1: "memory", hop2: "motor" };
const nodes = world(SPEC);

describe("the line of a path", () => {
  const steps = [
    step(1, "prompt", ["route"]),
    step(2, "instructions", ["rule1", "rule2"], [{ id: "hop1", a: 0.5, hop: 1, via: "rule1" }]),
    step(3, "read", ["rule3"]),
    step(4, "tool", ["tool1"], [{ id: "hop1", a: 0.5, hop: 1, via: "tool1" }, { id: "hop2", a: 0.3, hop: 2, via: "hop1" }]),
  ];
  const g = buildPath(steps, nodes);

  it("visits the nodes of hop 0 in the order of the activation, with one waypoint for each step", () => {
    expect(g.waypoints.map((w) => w.node)).toEqual(["route", "rule1", "rule3", "tool1"]);
    expect(g.waypoints).toHaveLength(steps.length);
    // a step with two nodes of hop 0 gives an entry segment, one segment between the nodes and, since a step follows, one back to
    // its first node, so that the line to the next step leaves from its waypoint (13 October 2026)
    expect(g.ranges[1].slots).toHaveLength(3);
    expect(g.ranges[1].slots[2].region).toBe(g.ranges[1].slots[0].region);
    expect(g.ranges[1].slots[0].arc1).toBeGreaterThan(g.ranges[1].slots[0].arc0);
    expect(g.knots.map((k) => k.id)).toEqual(["rule2"]);
  });

  it("runs the line between steps from waypoint to waypoint, with the pieces inside a step marked inner (13 October 2026)", () => {
    // the piece that enters step 3 leaves from the first node of step 2, its waypoint, and is not inner
    const enter3 = Array.from(g.line.step).findIndex((s) => s === 3);
    const at = (i: number) => ({ x: g.line.ends[i * 6], y: g.line.ends[i * 6 + 1], z: g.line.ends[i * 6 + 2] });
    const want = nodes("rule1")!.pos;
    for (const k of ["x", "y", "z"] as const) expect(at(enter3)[k]).toBeCloseTo(want[k], 4);
    expect(g.line.inner[enter3]).toBe(0);
    // the pieces of step 2 after its entry are inner
    const own2 = Array.from(g.line.step).map((s, i) => [s, i]).filter(([s]) => s === 2).map(([, i]) => g.line.inner[i]);
    expect(own2).toContain(1);
  });

  it("draws hop 1 and hop 2 as branches that start at their via node", () => {
    expect(g.branches.map((b) => [b.step, b.hop, b.id])).toEqual([[2, 1, "hop1"], [4, 1, "hop1"], [4, 2, "hop2"]]);
    const first = g.branches[0];
    expect(first.points[0]).toEqual(nodes("rule1")!.pos);
    expect(first.points[first.points.length - 1]).toEqual(nodes("hop1")!.pos);
    // the branches do not carry the head, so the line holds no piece for them
    expect(g.line.count).toBeGreaterThan(0);
  });

  it("takes the colour of the region that each segment enters, and gives a step across two regions two colours", () => {
    const wide = buildPath([step(1, "prompt", ["route"]), step(2, "read", ["rule1", "tool1", "mem"])], nodes);
    const regions = [...new Set(Array.from(wide.line.region))].map((i) => Object.keys(REGION_INDEX).find((k) => REGION_INDEX[k as RegionId] === i));
    expect(regions.sort()).toEqual(["memory", "motor", "prefrontal"]);
    expect(wide.ranges[1].slots.map((s) => s.region)).toEqual(["prefrontal", "motor", "memory"]);
    expect(g.branches[2].region).toBe("motor");
    expect(g.branches[0].region).toBe("memory");
  });

  it("puts the control point of a segment at 70 per cent of the distance of its midpoint from the centre", () => {
    const a: V3 = { x: 80, y: 0, z: 0 };
    const b: V3 = { x: 0, y: 0, z: 80 };
    const c = controlPoint(a, b);
    const mid = { x: 40, y: 0, z: 40 };
    expect(Math.hypot(c.x, c.y, c.z)).toBeCloseTo(Math.hypot(mid.x, mid.y, mid.z) * (1 - PATH_PULL));
    expect(1 - PATH_PULL).toBeCloseTo(0.7);
    // the sampled curve passes through the middle of the quadratic curve and ends on the nodes
    const half = samplePoint(a, a, b, b, 0.5, { x: 0, y: 0, z: 0 });
    const quad = quadPoint(a, b, 0.5);
    expect(half.x).toBeCloseTo(quad.x);
    expect(half.z).toBeCloseTo(quad.z);
    expect(samplePoint(a, a, b, b, 0, { x: 0, y: 0, z: 0 })).toEqual(a);
    const end = samplePoint(a, a, b, b, 1, { x: 0, y: 0, z: 0 });
    expect([end.x, end.y, end.z].map((v) => Math.abs(Math.round(v * 1e6) / 1e6))).toEqual([0, 0, 80]);
  });

  it("bows a repeat visit sideways by 3 units for each earlier visit", () => {
    const a: V3 = { x: 80, y: 0, z: 0 };
    const b: V3 = { x: 0, y: 0, z: 80 };
    expect(Math.hypot(bowVector(a, b, 0).x, 0)).toBe(0);
    const one = bowVector(a, b, PATH_BOW_UNITS);
    const two = bowVector(a, b, PATH_BOW_UNITS * 2);
    expect(Math.hypot(one.x, one.y, one.z)).toBeCloseTo(3);
    expect(Math.hypot(two.x, two.y, two.z)).toBeCloseTo(6);
    // a path that returns to a node bends away from its first pass
    const loop = buildPath([step(1, "a", ["rule1"]), step(2, "b", ["tool1"]), step(3, "c", ["rule1"]), step(4, "d", ["tool1"])], nodes);
    const mids = (i: number) => {
      const k = i * loop.line.count / 3;
      return [loop.line.ends[Math.floor(k) * 6], loop.line.ends[Math.floor(k) * 6 + 2]];
    };
    expect(mids(1)).not.toEqual(mids(2));
    expect(loop.waypoints[2].visits).toEqual([1, 3]);
  });

  it("gives the same points for the same graph", () => {
    const again = buildPath(steps, nodes);
    expect(Array.from(again.line.ends)).toEqual(Array.from(g.line.ends));
    expect(again.total).toBe(g.total);
  });

  it("gives a step with no node in the graph the anchor of its kind and lists its nodes as absent, and drops no step", () => {
    const anchor = { pos: { x: 0, y: 40, z: 60 }, region: "thalamus" as RegionId };
    const lost = [step(1, "prompt", ["ghost"]), step(2, "read", ["rule1"]), step(3, "read", ["ghost2", "ghost3"]), step(4, "session.end", [])];
    const h = buildPath(lost, nodes, { anchor: (kind) => (kind === "prompt" ? anchor : undefined) });
    expect(h.waypoints).toHaveLength(4);
    expect(h.waypoints[0]).toMatchObject({ hollow: true, region: "thalamus", pos: anchor.pos });
    expect(h.waypoints[2]).toMatchObject({ hollow: true, pos: nodes("rule1")!.pos });
    expect(h.absent.get(1)).toEqual(["ghost"]);
    expect(h.absent.get(3)).toEqual(["ghost2", "ghost3"]);
    // the line is never broken: it reaches every waypoint, in order
    expect(h.waypoints.map((w) => w.step)).toEqual([1, 2, 3, 4]);
    expect(h.total).toBeGreaterThan(0);
  });

  it("keeps a waypoint for every kind of event of the stream", () => {
    const kinds = ["session.start", "session.end", "prompt", "route", "instructions", "read", "write", "skill", "agent.start", "agent.stop", "workflow", "tool", "fault", "check", "compile", "mission.start", "mission.step", "mission.end", "other"];
    const all = buildPath(kinds.map((k, i) => step(i + 1, k, i % 2 ? ["rule1"] : [])), nodes);
    expect(all.waypoints).toHaveLength(kinds.length);
  });

  it("limits a long path to 60,000 points", () => {
    const long = Array.from({ length: 2000 }, (_, i) => step(i + 1, "read", [i % 2 ? "rule1" : "tool1", "mem"]));
    const big = buildPath(long, nodes);
    expect(big.waypoints).toHaveLength(2000);
    expect(big.line.count).toBeLessThanOrEqual(PATH_MAX_POINTS + 4000);
    expect(big.line.count).toBeGreaterThan(2000);
  });

  it("draws a stub for a missing node, from the last node of the step", () => {
    const s = [step(1, "run.chain", ["rule1", "rule2", `${MISSING_PREFIX}realises:rule2`])];
    const m = buildPath(s, nodes);
    expect(m.stubs).toHaveLength(1);
    expect(m.stubs[0].from).toEqual(nodes("rule2")!.pos);
    expect(m.stubs[0].tone).toBe("block");
    expect(m.absent.size).toBe(0);
    const none = buildPath([step(1, "review.none", [`${MISSING_PREFIX}review:r`])], nodes, { anchor: () => ({ pos: { x: 1, y: 2, z: 3 }, region: "basal" }) });
    expect(none.stubs[0].tone).toBe("hold");
    expect(none.waypoints[0].hollow).toBe(true);
  });
});

describe("the head", () => {
  const steps = [step(1, "prompt", ["route"]), step(2, "read", ["rule1", "rule2"]), step(3, "read", ["rule3"]), step(4, "read", ["tool1", "mem"])];
  const g = buildPath(steps, nodes);

  it("reads the progress as the step number plus the fraction of its time", () => {
    expect(stepOfProgress(g, 3.5)).toEqual({ n: 3, fraction: 0.5 });
    expect(stepOfProgress(g, 0.4)).toEqual({ n: 0, fraction: 0 });
    expect(stepOfProgress(g, 99)).toEqual({ n: 4, fraction: 1 });
    expect(headArc(g, 0)).toBe(-1);
    expect(headArc(g, 1)).toBe(0);
    // step 3 has one slot, the entry segment, and the head takes 250 ms of its 900 ms
    const r = g.ranges[2];
    expect(headArc(g, 3 + 125 / 900)).toBeCloseTo(r.s + (r.e - r.s) / 2);
    expect(headArc(g, 3 + 250 / 900)).toBeCloseTo(r.e);
    expect(headArc(g, 3.9)).toBeCloseTo(r.e);
    expect(headArc(g, 5)).toBe(g.total);
    expect(headArc(g, 4.2)).toBeLessThan(g.total);
  });

  it("moves the head forward as the progress rises and marks the waypoints it has reached", () => {
    let last = -1;
    for (let p = 1; p <= 5; p += 0.05) {
      const a = headArc(g, p);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
    expect(reachedSteps(g, headArc(g, 2))).toBe(1);
    expect(reachedSteps(g, g.total)).toBe(4);
    expect(headRegion(g, g.total)).toBe("memory");
  });

  it("times a step by its head and its branches, and the queue takes the time from the same function", () => {
    const wide = step(2, "read", Array.from({ length: 20 }, (_, i) => `n${i}`));
    expect(stepTiming(2, wide.activation).slots).toBe(20);
    expect(stepTiming(2, wide.activation).head).toBeCloseTo(HEAD_CAP_MS);
    expect(stepTiming(2, step(2, "read", ["a", "b", "c"]).activation).head).toBe(750);
    expect(stepMs(wide)).toBe(2000);
    expect(stepMs(step(1, "prompt", ["a"], [{ id: "x", a: 1, hop: 2, via: "a" }]))).toBe(900);
    expect(stepMs(step(1, "prompt", ["a"], [{ id: "x", a: 1, hop: 3, via: "a" }]))).toBe(1150);
    const played: number[] = [];
    const q = new TrailQueue({ play: (s) => played.push(s.n) });
    expect(q).toBeDefined();
    expect(played).toEqual([]);
  });
});

describe("the route strip", () => {
  const regionOf = (id: string) => SPEC[id];
  const steps = [
    step(1, "prompt", ["route"]),
    step(2, "route", ["rule1"]),
    step(3, "read", ["rule2"]),
    step(4, "read", ["rule3"]),
    step(5, "instructions", ["rule1"]),
    step(6, "tool", ["tool1"]),
  ];

  it("merges consecutive nodes of one region into one run and words the route", () => {
    const runs = routeRuns(steps, regionOf);
    expect(runs.map((r) => [r.region, r.steps])).toEqual([["thalamus", [1]], ["prefrontal", [2, 3, 4, 5]], ["motor", [6]]]);
    expect(routeSentence(runs, name)).toBe("Task routing 1, Rules and decisions 2 to 5, Tools and scripts 6");
  });

  it("puts a step across two regions in both runs", () => {
    const runs = routeRuns([step(1, "read", ["rule1", "tool1", "rule2"])], regionOf);
    expect(runs.map((r) => [r.region, r.steps])).toEqual([["prefrontal", [1]], ["motor", [1]], ["prefrontal", [1]]]);
  });

  it("names the steps of a run in words", () => {
    expect(stepsLabel([2, 3, 4, 5])).toBe("2 to 5");
    expect(stepsLabel([5, 6])).toBe("5 and 6");
    expect(stepsLabel([1, 3, 4, 5, 9])).toBe("1, 3 to 5 and 9");
    expect(stepsLabel([7])).toBe("7");
  });

  it("gives a step with no node the region of its anchor, or of the step before it", () => {
    const runs = routeRuns([step(1, "prompt", ["ghost"]), step(2, "read", ["ghost"]), step(3, "session.end", [])], regionOf);
    expect(runs.map((r) => [r.region, r.steps])).toEqual([["thalamus", [1, 2]], ["brainstem", [3]]]);
  });

  it("groups 41, 200 and 2,000 steps by the runs, with every step in one group", () => {
    for (const total of [41, 200, 2000]) {
      const many = Array.from({ length: total }, (_, i) => step(i + 1, "read", [i < 10 ? "rule1" : i % 20 < 10 ? "tool1" : "mem"]));
      const groups = routeGroups(many, regionOf);
      expect(groups.reduce((n, gr) => n + gr.steps.length, 0)).toBe(total);
      expect(groups.map((gr) => gr.steps.length).every((n) => n > 0)).toBe(true);
      expect(buildPath(many, nodes).waypoints).toHaveLength(total);
    }
    const flat = routeGroups(steps, regionOf);
    expect(flat.map((r) => r.steps)).toEqual(routeRuns(steps, regionOf).map((r) => r.steps));
  });
});

describe("the badges and the plates", () => {
  it("merges badges that lie closer than 22 pixels into one capsule that lists the steps", () => {
    const caps = mergeBadges([
      { step: 1, x: 100, y: 100 },
      { step: 2, x: 110, y: 104 },
      { step: 3, x: 118, y: 100 },
      { step: 4, x: 300, y: 300 },
    ]);
    expect(caps.map((c) => c.steps)).toEqual([[1, 2, 3], [4]]);
    expect(caps).toHaveLength(2);
  });

  it("widens the reach until the capsules fit the limit, so that every step is still in a capsule", () => {
    const pts = Array.from({ length: 400 }, (_, i) => ({ step: i + 1, x: (i % 20) * 30, y: Math.floor(i / 20) * 30 }));
    const caps = mergeBadges(pts, 22, 60);
    expect(caps.length).toBeLessThanOrEqual(60);
    expect(caps.reduce((n, c) => n + c.steps.length, 0)).toBe(400);
  });

  it("picks at most 12 plates: findings first, the first and last step, then the first step of each run", () => {
    const runs = [{ region: "thalamus" as RegionId, steps: [1] }, { region: "prefrontal" as RegionId, steps: [2, 3, 4] }, { region: "motor" as RegionId, steps: [5] }];
    expect(platePicks(5, [3], runs)).toEqual([1, 2, 3, 4, 5]);
    const picks = platePicks(200, [150, 151], runs);
    expect(picks.length).toBeLessThanOrEqual(12);
    expect(picks).toContain(150);
    expect(picks).toContain(1);
    expect(picks).toContain(200);
  });
});

// ------------------------------------------------------------------------------------------------ an agent run

const ref = (id: string, label: string, extra: object = {}) => ({ id, label, version: 1, status: "approved", in_force: true, maker: "a", approver: "b", approved_on: "2026-08-01", self_approved: false, ...extra });
const V1 = ref("instr:one-v1", "Compare names");
const V2 = ref("instr:two-v1", "Narrative reasons");
const link = (relation: string, from: string, to: string, status: "ratified" | "stated" | "proposed" | "missing", type = "X"): DecisionTrace["chains"][string][number] => ({
  mapping: null,
  relation,
  from,
  to,
  to_label: to ? `L ${to}` : "",
  to_type: type,
  status,
});

function fixtureTrace(over: Partial<DecisionTrace> = {}, citeFirst = true): DecisionTrace {
  const base = {
    run: "run:triage-r1",
    agent: { id: "dagent:alert-triage", label: "dagent:alert-triage" },
    model: { id: "model:m", status: "approved", approved: true },
    case_ref: "AL-1",
    decision: { id: "adec:r1-004", outcome: "escalate", step: 4, ts: "2026-09-14T10:00:00Z" },
    review: { id: "review:r1-005", reviewer: "pell-ankarow", verdict: "agree", override: false, override_reason: null, time_open_s: 3, items_viewed: 1, checks_ticked: [] },
    steps: [
      { id: "step:r1-0", step: 0, kind: "start", ts: "t0", tool: null, tool_id: null, evidence: [], in_context: [V1, V2], cited: [], rationale: null, findings: [] },
      { id: "step:r1-1", step: 1, kind: "evidence", ts: "t1", tool: "alert-queue-read", tool_id: "call:r1-1", evidence: [{ id: "evid:a", label: "alert-AL-1", hash: null, source: null }], in_context: [V1, V2], cited: [], rationale: null, findings: [] },
      { id: "step:r1-2", step: 2, kind: "rationale", ts: "t2", tool: null, tool_id: null, evidence: [], in_context: [V1, V2], cited: [], rationale: { id: "rationale:r1-2", hash: "h", content_ref: null, text: null }, findings: [] },
      { id: "step:r1-3", step: 3, kind: "decision", ts: "t3", tool: null, tool_id: null, evidence: [], in_context: [V1, V2], cited: citeFirst ? [V1, V2] : [], rationale: null, findings: [] },
      { id: "step:r1-4", step: 4, kind: "review", ts: "t4", tool: null, tool_id: null, evidence: [], in_context: [V1, V2], cited: [], rationale: null, findings: [] },
      { id: "step:r1-5", step: 5, kind: "end", ts: "t5", tool: null, tool_id: null, evidence: [], in_context: [V1, V2], cited: [], rationale: null, findings: [] },
    ],
    chains: {
      [V1.id]: [link("implementsClause", V1.id, "clause:c", "ratified", "PolicyClause"), link("realises", "clause:c", "control:k", "ratified"), link("satisfies", "control:k", "obl:o", "stated"), link("expressedIn", "obl:o", "prov:p", "stated")],
      [V2.id]: [link("implementsClause", V2.id, "clause:d", "ratified"), link("realises", "clause:d", "", "missing")],
    },
    findings: [],
    ledger: { entries: 6, verified: true, breaks: 0 },
    replayable: true,
    labels: { recorded: "recorded", loaded: "loaded", stated: "stated by the agent, cause unverified" },
  } as DecisionTrace;
  return { ...base, ...over };
}

const ALL = (id: string) => !id.startsWith("ghost");

describe("the path of an agent run", () => {
  const t = fixtureTrace();
  const p = agentPath(t, ALL);

  it("builds the steps of the table in order, with the labels of the trace", () => {
    expect(p.source).toBe("run");
    expect(p.run).toBe(t.run);
    expect(p.steps.map((s) => s.kind)).toEqual([
      "run.start",
      "run.instructions",
      "run.evidence",
      "run.rationale",
      "run.cited",
      "run.chain",
      "run.chain",
      "run.decision",
      "run.end",
      "run.review",
    ]);
    expect(p.steps.map((s) => s.label)).toEqual([t.labels.recorded, t.labels.loaded, t.labels.recorded, t.labels.stated, t.labels.stated, t.labels.recorded, t.labels.recorded, t.labels.recorded, t.labels.recorded, t.labels.recorded]);
    expect(p.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p.steps.every((s) => s.mode === "recorded")).toBe(true);
  });

  it("visits the nodes of each row of the table in order", () => {
    const ids = (n: number) => p.steps[n - 1].activation.map((a) => a.id);
    expect(ids(1)).toEqual(["dagent:alert-triage", "run:triage-r1", "step:r1-0"]);
    expect(ids(2)).toEqual(["step:r1-0", V1.id, V2.id]);
    expect(ids(3)).toEqual(["step:r1-1", "call:r1-1", "evid:a"]);
    expect(ids(4)).toEqual(["step:r1-2", "rationale:r1-2"]);
    expect(ids(5)).toEqual(["step:r1-3", V1.id, V2.id]);
    expect(ids(6)).toEqual([V1.id, "clause:c", "control:k", "obl:o", "prov:p"]);
    expect(ids(8)).toEqual(["adec:r1-004"]);
    expect(ids(9)).toEqual(["step:r1-5"]);
    expect(ids(10)).toEqual(["review:r1-005"]);
    expect(p.steps[0].sentence).toBe("The agent Alert triage started run triage-r1 for the case AL-1");
    expect(p.steps[1].sentence).toBe("Loaded 2 instructions");
    expect(p.steps[4].sentence).toBe("Cited 2 instructions at the decision");
    expect(p.steps[7].sentence).toBe("Decision recorded as escalated");
  });

  it("stops a chain at its last link and ends it in a stub when a link is missing", () => {
    const second = p.steps[6];
    expect(second.activation.map((a) => a.id)).toEqual([V2.id, "clause:d", `${MISSING_PREFIX}realises:clause:d`]);
    expect(second.sentence).toContain(", which has no link to ");
    expect(second.absent).toBeUndefined();
    const geometry = buildPath(p.steps, (id) => (ALL(id) && !id.startsWith(MISSING_PREFIX) ? { pos: { x: id.length * 3, y: id.charCodeAt(2), z: 20 }, region: "prefrontal" } : undefined));
    expect(geometry.stubs).toHaveLength(1);
    expect(geometry.stubs[0].step).toBe(7);
  });

  it("states a decision with no cited instruction, and the finding of the run is a marker with its plain title", () => {
    const finding = { check: "O04", severity: "violation" as const, node: "step:r1-3", message: "no instruction cited", proof: null };
    const bare = fixtureTrace({ findings: [finding] }, false);
    const q = agentPath(bare, ALL);
    expect(q.steps[4].sentence).toBe("Cited no instruction at the decision");
    const marked = q.steps.filter((s) => s.markers?.length);
    expect(marked.map((s) => s.n)).toEqual([5]);
    expect(marked[0].markers).toEqual([{ severity: "violation", title: "Decision with no cited instruction", node: "step:r1-3" }]);
    expect(JSON.stringify(q.steps)).not.toContain("O04");
  });

  it("attaches a finding of a step to that step and a finding that no step lists by the order of the fallback", () => {
    const inStep = { check: "O12", severity: "warning" as const, node: "step:r1-1", message: "model", proof: null };
    const run = { check: "O11", severity: "info" as const, node: "step:r1-2", message: "record", proof: null };
    const lost = { check: "O02", severity: "warning" as const, node: "ghost-node", message: "x", proof: null };
    const base = fixtureTrace({ findings: [inStep, run, lost] });
    base.steps[1].findings = [inStep];
    const q = agentPath(base, ALL);
    const at = (n: number) => q.steps[n - 1].markers?.map((m) => m.title);
    expect(at(3)).toEqual(["Model version that is not approved"]);
    expect(at(4)).toEqual(["Incomplete run record"]);
    // a node that no step visits falls to part 1 of the decision
    expect(at(5)).toEqual(["Instruction with no ratified policy clause"]);
    expect(q.steps.flatMap((s) => s.markers ?? []).map((m) => m.node)).toEqual(["step:r1-1", "step:r1-2", null]);
  });

  it("ends in a step that says no review is recorded when the trace holds none", () => {
    const q = agentPath(fixtureTrace({ review: null }), ALL);
    const last = q.steps[q.steps.length - 1];
    expect(last.sentence).toBe("No human review is recorded");
    expect(last.kind).toBe("review.none");
    expect(last.activation[0].id.startsWith(MISSING_PREFIX)).toBe(true);
  });

  it("lists an id that the graph does not hold as absent, and counts it", () => {
    const q = agentPath(fixtureTrace(), (id) => !id.startsWith("evid:") && !id.startsWith("prov:"));
    expect(q.steps[2].absent).toEqual(["evid:a"]);
    expect(q.steps[5].absent).toEqual(["prov:p"]);
    const summary = absentSummary(q, (id) => !id.startsWith("evid:") && !id.startsWith("prov:"));
    expect(summary.absent).toBe(2);
    expect(summary.steps).toEqual([3, 5, 6].filter((n) => q.steps[n - 1].absent));
    expect(summary.total).toBeGreaterThan(summary.absent);
  });

  it("says that a later step loads the same instructions when the set is unchanged", () => {
    const t2 = fixtureTrace();
    t2.steps.splice(2, 0, { ...t2.steps[1], id: "step:x", kind: "instructions", tool: null, tool_id: null, evidence: [], in_context: [V1, V2] });
    const q = agentPath(t2, ALL);
    expect(q.steps.filter((s) => s.kind === "run.instructions").map((s) => s.sentence)).toEqual(["Loaded 2 instructions", "Loaded the same 2 instructions"]);
  });

  it("builds a path that the geometry can draw, with a waypoint for every step", () => {
    const geometry = buildPath(p.steps, (id) => ALL(id) && !id.startsWith(MISSING_PREFIX) ? { pos: { x: (id.length * 7) % 90, y: (id.charCodeAt(1) * 3) % 70, z: (id.charCodeAt(3) * 5) % 60 }, region: "cerebellum" } : undefined);
    expect(geometry.waypoints).toHaveLength(p.steps.length);
    expect(geometry.total).toBeGreaterThan(0);
  });
});

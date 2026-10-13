// The traced path (docs/BRAIN.md, "Revision of 13 October 2026: the traced path"): the geometry of the line that joins the
// nodes of the steps of a prompt or of an agent run, the head that travels along it, the route through the regions, the
// merged waypoint badges and the path of a recorded agent run. Pure, and tested in path.test.ts. The drawing is pathLayer.ts.
import type { Activation, ChainLink, DecisionTrace, TraceFinding } from "@shared/types";
import { REGION_IDS, type RegionId } from "@shared/brain";
import { agentName, outcomeWord } from "../../apps/oversight/model";
import { checkTitle, evidenceName } from "../../apps/oversight/wording";
import {
  BADGE_MAX,
  BADGE_MERGE_PX,
  PATH_BRANCH_SAMPLES,
  PATH_BOW_UNITS,
  PATH_CROWD,
  PATH_CROWD_REACH,
  PATH_CROWD_SHARE,
  PATH_END_EPS,
  PATH_FAN_AFTER,
  PATH_FAN_MAX_UNITS,
  PATH_FAN_UNITS,
  PATH_MAX_POINTS,
  PATH_PLATES_MAX,
  PATH_PLATE_CHARS,
  PATH_NEAR_UNITS,
  PATH_SPREAD_AFTER,
  PATH_SPREAD_UNITS,
  PATH_PULL,
  PATH_SAMPLES_MAX,
  PATH_SAMPLES_MIN,
  PATH_TANGENT_MAX,
} from "./look";
import { HOP_DELAY_MS, stepTiming, type StepTiming } from "./schedule";
import type { PathHop, PathMarker, TracePath, TrailStep } from "./types";

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** A node of the graph on screen, as the path needs it. */
export interface PathNodeInfo {
  pos: V3;
  region: RegionId;
}

export type NodeLookup = (id: string) => PathNodeInfo | undefined;

/** The id of a node that a recorded run lacks, such as a missing link of a chain (docs/BRAIN.md, "The shape of an agent run path"). */
export const MISSING_PREFIX = "missing:";
export const isMissing = (id: string): boolean => id.startsWith(MISSING_PREFIX);

// ----------------------------------------------------------------------------------------------------------- curves

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a: V3, b: V3): V3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const same = (a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** The control point of a segment: its midpoint pulled towards the centre of the brain by `pull` of its distance from the centre. */
export function controlPoint(a: V3, b: V3, pull = PATH_PULL): V3 {
  const m = mid(a, b);
  return { x: m.x * (1 - pull), y: m.y * (1 - pull), z: m.z * (1 - pull) };
}

/** The point at t of the quadratic curve of a segment, which is the route through the volume of the brain. */
export function quadPoint(a: V3, b: V3, t: number, pull = PATH_PULL): V3 {
  const c = controlPoint(a, b, pull);
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  };
}

/** The sideways direction of a bow: perpendicular to the segment and to the line from the centre to its midpoint. */
export function bowVector(a: V3, b: V3, amount: number): V3 {
  if (!amount) return { x: 0, y: 0, z: 0 };
  let side = cross(sub(b, a), mid(a, b));
  if (len(side) < 1e-6) side = cross(sub(b, a), { x: 0, y: 1, z: 0 });
  if (len(side) < 1e-6) side = { x: 1, y: 0, z: 0 };
  const k = amount / len(side);
  return { x: side.x * k, y: side.y * k, z: side.z * k };
}

/**
 * A point of a segment from a to b. The Catmull-Rom curve through the nodes before and after keeps the line smooth at each
 * waypoint, the pull towards the centre is weighted by half of sin squared so that it vanishes at both ends and equals the
 * quadratic curve of controlPoint at the middle, and a bow moves the segment sideways.
 */
export function samplePoint(p0: V3, a: V3, b: V3, p3: V3, t: number, bow: V3, pull = PATH_PULL): V3 {
  const t2 = t * t;
  const t3 = t2 * t;
  // the Hermite form of the Catmull-Rom curve, with each tangent limited to a share of the segment so that a far neighbour cannot make a loop
  const chord = len(sub(b, a));
  const m0 = limited(sub(b, p0), chord);
  const m1 = limited(sub(p3, a), chord);
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const cr = (k: "x" | "y" | "z"): number => h00 * a[k] + h10 * m0[k] + h01 * b[k] + h11 * m1[k];
  const s = Math.sin(Math.PI * t);
  const w = 0.5 * s * s;
  const m = mid(a, b);
  return { x: cr("x") - pull * m.x * w + bow.x * s * s, y: cr("y") - pull * m.y * w + bow.y * s * s, z: cr("z") - pull * m.z * w + bow.z * s * s };
}

/** Half of a chord vector, shortened to PATH_TANGENT_MAX of the length of the segment that it belongs to. */
function limited(v: V3, chord: number): V3 {
  const half = { x: v.x * 0.5, y: v.y * 0.5, z: v.z * 0.5 };
  const l = len(half);
  const max = PATH_TANGENT_MAX * chord;
  if (l <= max || l === 0) return half;
  const k = max / l;
  return { x: half.x * k, y: half.y * k, z: half.z * k };
}

/** The half extents of the volume that a curve of the path stays in: the box of the nodes the path names, never less than `floor`. */
export function volumeOf(points: V3[], floor = 20): V3 {
  const h = { x: floor, y: floor, z: floor };
  for (const p of points) {
    h.x = Math.max(h.x, Math.abs(p.x));
    h.y = Math.max(h.y, Math.abs(p.y));
    h.z = Math.max(h.z, Math.abs(p.z));
  }
  return h;
}

/** A point moved to the surface of the ellipsoid of half extents `h` where it lies outside, and left alone where it lies inside. */
export function clampVolume(p: V3, h: V3): V3 {
  const r = Math.hypot(p.x / h.x, p.y / h.y, p.z / h.z);
  return r <= 1 ? p : { x: p.x / r, y: p.y / r, z: p.z / r };
}

/**
 * The sideways amount of each segment of the chain, in scene units, so that segments which share both ends, or an end with 2 or more
 * others, run side by side in the order of their steps instead of on top of one another. Index k is the segment from entry k-1 to k.
 */
export function fanAmounts(ends: { from: string; to: string; drawn: boolean }[]): number[] {
  const out = new Array<number>(ends.length).fill(0);
  const pair = new Map<string, number[]>();
  const into = new Map<string, number[]>();
  const outOf = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, key: string, k: number) => m.set(key, [...(m.get(key) ?? []), k]);
  ends.forEach((e, k) => {
    if (!e.drawn) return;
    push(pair, e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`, k);
    push(into, e.to, k);
    push(outOf, e.from, k);
  });
  ends.forEach((e, k) => {
    if (!e.drawn) return;
    const shared = pair.get(e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`) as number[];
    const group = shared.length > 1 ? shared : (into.get(e.to) as number[]).length >= 3 ? (into.get(e.to) as number[]) : (outOf.get(e.from) as number[]).length >= 3 ? (outOf.get(e.from) as number[]) : null;
    if (!group) return;
    const n = group.length;
    const spread = Math.min(PATH_FAN_UNITS, PATH_FAN_MAX_UNITS / Math.max(1, n - 1));
    // a segment that runs the other way round bows to the other side, so the sign follows the direction
    out[k] = (group.indexOf(k) - (n - 1) / 2) * spread * (shared.length > 1 && e.from > e.to ? -1 : 1);
  });
  return out;
}

// ------------------------------------------------------------------------------------------------------- geometry

export interface PathWaypoint {
  step: number;
  pos: V3;
  region: RegionId | null;
  /** the step has no node in the graph on screen, so the waypoint stands at an anchor */
  hollow: boolean;
  /** the arc length at which the head reaches the waypoint, and the progress value at which it appears */
  arc: number;
  at: number;
  /** the graph id of the node, or null for a hollow waypoint */
  node: string | null;
  /** every step that starts at this node, this one included, in order */
  visits: number[];
}

export interface PathKnot {
  step: number;
  pos: V3;
  region: RegionId;
  id: string;
  /** the progress value at which the head reaches the knot */
  at: number;
}

export interface PathBranch {
  step: number;
  hop: number;
  id: string;
  via: string | null;
  region: RegionId;
  points: V3[];
  /** the node at the end of the branch, where its knot stands (the points of a short branch stop before it) */
  tip: V3;
  /** the branch is one of many for its step: a short faint branch, or a dot with a line of no length */
  crowded: boolean;
  dot: boolean;
  /** the progress at which the branch starts to grow */
  at: number;
}

export interface PathStub {
  step: number;
  from: V3;
  to: V3;
  tone: "block" | "hold";
  /** the words at its end: "no link" for a missing link of a chain, and empty for the missing review */
  label: string;
  /** the progress at which the stub appears: the end of its step */
  at: number;
}

/** A hop of a chain on the line: the sub-step 9a, 9b and so on, at the node of the clause, the control, the obligation or the provision. */
export interface PathSub {
  step: number;
  letter: string;
  id: string;
  pos: V3;
  region: RegionId;
  hop: PathHop;
  /** the progress at which the head has reached the step */
  at: number;
}

/** How the segments into a step are drawn: solid for recorded, dashed for stated by the agent with its cause unverified, dotted for loaded. */
export type SegmentStyle = "solid" | "dashed" | "dotted";
export const STYLE_CODE: Record<SegmentStyle, number> = { solid: 0, dashed: 1, dotted: 2 };

/** The style of the segments into a step by its label (the labels of `trace.labels`). A step without a label, as in a prompt, is solid. */
export function segmentStyle(label: string | undefined): SegmentStyle {
  if (!label) return "solid";
  if (label.startsWith("stated")) return "dashed";
  if (label === "loaded") return "dotted";
  return "solid";
}

export interface PathSlot {
  /** the arc length at the start and the end of the slot, which are equal for a slot of zero length */
  arc0: number;
  arc1: number;
  region: RegionId | null;
}

export interface StepRange {
  n: number;
  /** the arc length at the start and at the end of the step */
  s: number;
  e: number;
  timing: StepTiming;
  slots: PathSlot[];
}

export interface PathGeometry {
  steps: number;
  waypoints: PathWaypoint[];
  knots: PathKnot[];
  branches: PathBranch[];
  stubs: PathStub[];
  subs: PathSub[];
  ranges: StepRange[];
  /** the length of the whole line */
  total: number;
  /** for the line: the two end points of each piece (6 numbers), its arc lengths (2) and its region (index into REGION_IDS, 255 for none) */
  line: { count: number; ends: Float32Array; arcs: Float32Array; region: Uint8Array; step: Uint16Array; style: Uint8Array; inner: Uint8Array };
  /** the ids of the nodes of each step that the graph on screen does not hold, by step number */
  absent: Map<number, string[]>;
}

export const REGION_INDEX = Object.fromEntries(REGION_IDS.map((r, i) => [r, i])) as Record<RegionId, number>;

export interface BuildOptions {
  /** the anchor of a step that has no node in the graph, by the kind of the step */
  anchor?: (kind: string) => PathNodeInfo | undefined;
  maxPoints?: number;
  /** the half extents of the volume of the brain, which every curve stays in (by default the box of the nodes the path names) */
  volume?: V3;
}

interface Entry {
  pos: V3;
  region: RegionId | null;
  id: string | null;
  step: number;
  hollow: boolean;
  /** the return to the first node of a step of several nodes, so that the line between steps runs from waypoint to waypoint (13 October 2026) */
  back?: boolean;
}

const ORIGIN: V3 = { x: 0, y: 0, z: 0 };

/** The k-th of n points spread over a sphere of PATH_SPREAD_UNITS round a place (a Fibonacci spiral, so that any view of it shows them apart). */
export function spreadAround(at: V3, k: number, n: number, radius = PATH_SPREAD_UNITS): V3 {
  const y = n > 1 ? 1 - (2 * (k + 0.5)) / n : 0;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = k * 2.399963229728653;
  return { x: at.x + Math.cos(a) * r * radius, y: at.y + y * radius, z: at.z + Math.sin(a) * r * radius };
}

/** The geometry of a path, from its steps and the positions of the nodes on screen. Every step gets a waypoint, whatever its nodes. */
export function buildPath(steps: TrailStep[], node: NodeLookup, opts: BuildOptions = {}): PathGeometry {
  const chain: Entry[] = [];
  const firstOf: number[] = [];
  const countOf: number[] = [];
  const absent = new Map<number, string[]>();
  const stubWant: { step: number; ids: string[] }[] = [];
  let lastPos: V3 | null = null;
  let lastRegion: RegionId | null = null;
  steps.forEach((step, i) => {
    const n = i + 1;
    const entries: Entry[] = [];
    const missed: string[] = [];
    const lost: string[] = [];
    for (const a of step.activation) {
      if (a.hop !== 0) continue;
      if (isMissing(a.id)) {
        missed.push(a.id);
        continue;
      }
      const info = node(a.id);
      if (!info) {
        lost.push(a.id);
        continue;
      }
      entries.push({ pos: info.pos, region: info.region, id: a.id, step: n, hollow: false });
    }
    for (const a of step.activation) {
      if (a.hop > 0 && !node(a.id) && !isMissing(a.id)) lost.push(a.id);
    }
    if (lost.length) absent.set(n, [...new Set(lost)]);
    if (!entries.length) {
      const anchor = opts.anchor?.(step.kind);
      entries.push({ pos: anchor?.pos ?? lastPos ?? ORIGIN, region: anchor?.region ?? lastRegion, id: null, step: n, hollow: true });
    }
    if (missed.length) stubWant.push({ step: n, ids: missed });
    firstOf.push(chain.length);
    countOf.push(entries.length);
    // a step of several nodes goes out to its other nodes and back to its first, faint, so that the line to the next step leaves from the
    // waypoint of this step and the order of the steps reads badge by badge (13 October 2026)
    if (entries.length > 1 && entries[0].id && i < steps.length - 1) entries.push({ ...entries[0], back: true });
    chain.push(...entries);
    const last = entries[entries.length - 1];
    lastPos = last.pos;
    lastRegion = last.region;
  });

  // the pieces of the line: one segment from each entry to the next
  // a node that many steps end at has the later visits spread round it, so that each line ends at a place of its own
  const total = new Map<string, number>();
  for (const e of chain) if (e.id && !e.back) total.set(e.id, (total.get(e.id) ?? 0) + 1);
  const seenAt = new Map<string, number>();
  for (const e of chain) {
    if (!e.id || e.back) continue;
    const seen = seenAt.get(e.id) ?? 0;
    seenAt.set(e.id, seen + 1);
    const n = total.get(e.id) as number;
    if (seen > 0 && n >= PATH_SPREAD_AFTER) {
      const spread = spreadAround(e.pos, seen - 1, n - 1);
      e.pos = opts.volume ? clampVolume(spread, opts.volume) : spread;
    }
  }
  // the first nodes of steps that lie close together (the instructions of AL-2026-0001 stand in one cluster) are spread round the first of them
  const firsts: V3[] = [];
  for (const idx of firstOf) {
    const e = chain[idx];
    if (!e.id) continue;
    const near = firsts.filter((f) => !same(f, e.pos) && len(sub(f, e.pos)) < PATH_NEAR_UNITS).length;
    if (near > 0) {
      // twice the spread of revisits, so that the line between the waypoints of a cluster of steps reads step by step (13 October 2026)
      const spread = spreadAround(e.pos, near - 1, Math.max(3, near + 2), PATH_SPREAD_UNITS * 2);
      e.pos = opts.volume ? clampVolume(spread, opts.volume) : spread;
    }
    firsts.push(e.pos);
  }
  for (let k = 0; k < chain.length; k += 1) if (chain[k].back) chain[k].pos = chain[firstOf[chain[k].step - 1]].pos;
  const visits = new Map<string, number>();
  const bowOf: number[] = chain.map((e) => {
    if (!e.id || e.back) return 0;
    const seen = visits.get(e.id) ?? 0;
    visits.set(e.id, seen + 1);
    return seen;
  });
  let drawn = 0;
  for (let k = 1; k < chain.length; k += 1) if (!same(chain[k - 1].pos, chain[k].pos)) drawn += 1;
  const keyOf = (e: Entry): string => e.id ?? `@${e.pos.x},${e.pos.y},${e.pos.z}`;
  const fan = fanAmounts(chain.map((e, k) => ({ from: k ? keyOf(chain[k - 1]) : "", to: keyOf(e), drawn: k > 0 && !same(chain[k - 1].pos, e.pos) })));
  const named: V3[] = chain.map((e) => e.pos);
  for (const step of steps) for (const a of step.activation) if (a.hop > 0) {
    const info = node(a.id);
    if (info) named.push(info.pos);
  }
  const volume = opts.volume ?? volumeOf(named);
  const maxPoints = opts.maxPoints ?? PATH_MAX_POINTS;
  const samples = Math.max(PATH_SAMPLES_MIN, Math.min(PATH_SAMPLES_MAX, Math.floor(maxPoints / Math.max(1, drawn))));

  const ends: number[] = [];
  const arcs: number[] = [];
  const regionIdx: number[] = [];
  const stepIdx: number[] = [];
  const styleIdx: number[] = [];
  // 1 for a piece between 2 nodes of the same step (the hops of a chain), which is drawn faint unless the step plays or is chosen
  const innerIdx: number[] = [];
  const ranges: StepRange[] = steps.map((s, i) => ({ n: i + 1, s: 0, e: 0, timing: stepTiming(i + 1, s.activation), slots: [] }));
  let arc = 0;
  for (let k = 1; k < chain.length; k += 1) {
    const from = chain[k - 1];
    const to = chain[k];
    const range = ranges[to.step - 1];
    if (!range.slots.length && range.s === 0 && range.e === 0) range.s = arc;
    const slot: PathSlot = { arc0: arc, arc1: arc, region: to.region };
    if (!same(from.pos, to.pos)) {
      const p0 = k >= 2 ? chain[k - 2].pos : from.pos;
      const p3 = k + 1 < chain.length ? chain[k + 1].pos : to.pos;
      const bow = bowVector(from.pos, to.pos, PATH_BOW_UNITS * bowOf[k] + fan[k]);
      let prev = from.pos;
      for (let j = 1; j <= samples; j += 1) {
        const p = j === samples ? to.pos : clampVolume(samplePoint(p0, from.pos, to.pos, p3, j / samples, bow), volume);
        const d = len(sub(p, prev));
        ends.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        arcs.push(arc, arc + d);
        regionIdx.push(to.region ? REGION_INDEX[to.region] : 255);
        stepIdx.push(to.step);
        styleIdx.push(STYLE_CODE[segmentStyle(steps[to.step - 1].label)]);
        innerIdx.push(from.step === to.step ? 1 : 0);
        arc += d;
        prev = p;
      }
      slot.arc1 = arc;
    }
    range.slots.push(slot);
  }
  // each step starts where the line was when its first slot began, and the slots that a step lacks are slots of zero length
  let at = 0;
  ranges.forEach((r) => {
    if (!r.slots.length) r.s = at;
    else r.s = r.slots[0].arc0;
    while (r.slots.length < r.timing.slots) r.slots.push({ arc0: r.slots.length ? r.slots[r.slots.length - 1].arc1 : r.s, arc1: r.slots.length ? r.slots[r.slots.length - 1].arc1 : r.s, region: r.slots.length ? r.slots[r.slots.length - 1].region : null });
    r.e = r.slots.length ? r.slots[r.slots.length - 1].arc1 : r.s;
    at = r.e;
  });

  const waypoints: PathWaypoint[] = steps.map((_, i) => {
    const e = chain[firstOf[i]];
    const r = ranges[i];
    // the head reaches the waypoint when its entry segment ends, and the first step starts on it
    const arcAt = i > 0 && r.slots.length ? r.slots[0].arc1 : r.s;
    const at = i > 0 && r.timing.slots ? i + 1 + r.timing.perSlot / r.timing.total : i + 1;
    return { step: i + 1, pos: e.pos, region: e.region, hollow: e.hollow, arc: arcAt, at, node: e.id, visits: [] };
  });
  const byNode = new Map<string, number[]>();
  waypoints.forEach((w) => {
    if (!w.node) return;
    const list = byNode.get(w.node) ?? [];
    list.push(w.step);
    byNode.set(w.node, list);
  });
  waypoints.forEach((w) => {
    w.visits = w.node ? (byNode.get(w.node) as number[]) : [w.step];
  });

  const knots: PathKnot[] = [];
  const branches: PathBranch[] = [];
  steps.forEach((step, i) => {
    const n = i + 1;
    const r = ranges[i];
    for (let k = 1; k < countOf[i]; k += 1) {
      const e = chain[firstOf[i] + k];
      // the head reaches this node at the end of its slot: slot 0 is the entry segment of every step after the first
      const slot = (i > 0 ? k : k - 1) + 1;
      if (e.id && e.region) knots.push({ step: n, pos: e.pos, region: e.region, id: e.id, at: n + (slot * r.timing.perSlot) / r.timing.total });
    }
    const first = chain[firstOf[i]];
    const wp = first.pos;
    const hops = step.activation.filter((a) => a.hop > 0 && node(a.id)).sort((p, q) => p.hop - q.hop);
    // a step with many branches keeps the main line readable: 1 branch in 3 is a short faint tick towards its node, and the others are dots
    const crowded = hops.length > PATH_CROWD;
    hops.forEach((a, idx) => {
      const to = node(a.id) as PathNodeInfo;
      const via = a.via ? node(a.via) : undefined;
      const from = via?.pos ?? wp;
      const dot = crowded && idx % PATH_CROWD_SHARE !== 0;
      const reach = crowded ? PATH_CROWD_REACH : 1;
      const pts: V3[] = [];
      for (let j = 0; j <= PATH_BRANCH_SAMPLES; j += 1) {
        const t = (j / PATH_BRANCH_SAMPLES) * reach;
        if (dot) {
          // a dot has a line of almost no length, so that the line material never meets a zero length
          const q = quadPoint(from, to.pos, 0.002);
          const u = j / PATH_BRANCH_SAMPLES;
          pts.push({ x: from.x + (q.x - from.x) * u, y: from.y + (q.y - from.y) * u, z: from.z + (q.z - from.z) * u });
        } else pts.push(j === 0 ? from : j === PATH_BRANCH_SAMPLES && !crowded ? to.pos : clampVolume(quadPoint(from, to.pos, t), volume));
      }
      branches.push({ step: n, hop: a.hop, id: a.id, via: a.via, region: to.region, points: pts, tip: to.pos, crowded, dot, at: n + (r.timing.entry + a.hop * HOP_DELAY_MS) / r.timing.total });
    });
  });

  const stubs: PathStub[] = [];
  for (const w of stubWant) {
    const i = w.step - 1;
    const last = chain[firstOf[i] + countOf[i] - 1];
    const dir = len(last.pos) > 1e-6 ? { x: last.pos.x / len(last.pos), y: last.pos.y / len(last.pos), z: last.pos.z / len(last.pos) } : { x: 0, y: 1, z: 0 };
    w.ids.forEach((id, k) => {
      const side = bowVector(last.pos, { x: last.pos.x + dir.x, y: last.pos.y + dir.y, z: last.pos.z + dir.z }, 6 * (k % 2 ? -1 : 1) * Math.ceil(k / 2));
      const to = { x: last.pos.x + dir.x * 9 + side.x, y: last.pos.y + dir.y * 9 + side.y, z: last.pos.z + dir.z * 9 + side.z };
      const review = id.startsWith(`${MISSING_PREFIX}review`);
      stubs.push({ step: w.step, from: last.pos, to, tone: review ? "hold" : "block", label: review ? "" : "no link", at: w.step + 1 - 1e-4 });
    });
  }

  // the hops of a chain: a sub-step at the node of each hop that the graph holds
  const subs: PathSub[] = [];
  steps.forEach((step, i) => {
    for (const hop of step.hops ?? []) {
      const info = hop.node ? node(hop.node) : undefined;
      if (hop.node && info) subs.push({ step: i + 1, letter: hop.letter, id: hop.node, pos: info.pos, region: info.region, hop, at: waypoints[i].at });
    }
  });

  return {
    steps: steps.length,
    waypoints,
    knots,
    branches,
    stubs,
    subs,
    ranges,
    total: arc,
    line: {
      count: arcs.length / 2,
      ends: Float32Array.from(ends),
      arcs: Float32Array.from(arcs),
      region: Uint8Array.from(regionIdx),
      step: Uint16Array.from(stepIdx),
      style: Uint8Array.from(styleIdx),
      inner: Uint8Array.from(innerIdx),
    },
    absent,
  };
}

// ---------------------------------------------------------------------------------------------------------- the head

/**
 * The arc length of the head at a progress value. The progress is the step number plus the fraction of the step, so that
 * 3.5 is step 3 at half of its time. A value below 1 is before the first step, and a value of the number of steps plus 1 or
 * more is the end of the line. The head takes the same time for each slot of a step and then rests while the branches grow.
 */
export function headArc(g: PathGeometry, p: number): number {
  if (!(p >= 1) || !g.steps) return -1;
  if (p >= g.steps + 1) return g.total;
  const n = Math.floor(p);
  const f = p - n;
  const r = g.ranges[n - 1];
  if (!r.slots.length) return r.s;
  const phase = r.timing.head > 0 ? Math.min(1, (f * r.timing.total) / r.timing.head) : 1;
  const at = phase * r.slots.length;
  const k = Math.min(r.slots.length - 1, Math.floor(at));
  const s = r.slots[k];
  return s.arc0 + (s.arc1 - s.arc0) * (at - k);
}

/**
 * The step that the head is in at a progress value, which every caption of the panel reads: 0 before the first step, and the last
 * step from its start to the end of the path. The end of step 10 (the head parks at PATH_END_EPS short of 11) is still step 10.
 */
export function currentStep(p: number, count: number): number {
  if (!(p >= 1) || count < 1) return 0;
  return Math.min(count, Math.floor(p));
}

/** The head has played the whole path: the last step is over. */
export function pathAtEnd(p: number, count: number): boolean {
  return count >= 1 && p >= count + 1 - 1e-3;
}

/** The caption of the position in words, for the scrubber and its value text. It names the same step as the panel does. */
export function stepCaption(p: number, count: number): string {
  if (!(p >= 1)) return "Before step 1";
  const n = currentStep(p, count);
  if (pathAtEnd(p, count) || p - Math.floor(p) >= 1 - 1e-3) return `End of step ${n}`;
  const part = Math.round((p - Math.floor(p)) * 100);
  return part === 0 ? `Step ${n}` : `Step ${n}, ${part} per cent`;
}

/** The progress value of the step before or after the one at a value: the start of the next step, and the start (or a fraction in) of the current step going back. */
export function neighbourStep(value: number, count: number, dir: 1 | -1): number {
  const n = Math.floor(value);
  const into = value - n;
  if (dir > 0) return Math.min(count, n + 1);
  return into > 0.02 ? Math.max(1, n) : Math.max(1, n - 1);
}

/** The plates of the whole path in the order of placement: steps with a finding, then the steps of the badge under the pointer, then the rest. The first two groups must be shown. */
export function orderPlatePicks(picks: number[], markerSteps: number[], hovered: number[]): { picks: number[]; urgent: number[] } {
  const urgent = [...new Set([...markerSteps, ...hovered])];
  return { picks: [...urgent, ...picks.filter((k) => !urgent.includes(k))], urgent };
}

/** The sentence of a step as the plate on the canvas shows it: cut at a word to at most PATH_PLATE_CHARS characters, with the whole sentence in the panel. */
export function plateSentence(sentence: string, max = PATH_PLATE_CHARS): string {
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:s]+$/, "")}…`;
}

/** The step and the fraction of a progress value, clamped to the path. */
export function stepOfProgress(g: PathGeometry, p: number): { n: number; fraction: number } {
  if (!(p >= 1) || !g.steps) return { n: 0, fraction: 0 };
  if (p >= g.steps + 1) return { n: g.steps, fraction: 1 };
  const n = Math.floor(p);
  return { n, fraction: p - n };
}

/** The progress value for a step and a fraction of it. */
export function progressOf(n: number, fraction: number): number {
  // the end of a step is a hair short of the next one, so that every caption still names step n
  return n + Math.min(1 - PATH_END_EPS, Math.max(0, fraction));
}

/** The region the head is in at an arc length: the region of the segment it is travelling along. */
export function headRegion(g: PathGeometry, arc: number): RegionId | null {
  if (arc < 0) return null;
  let found: RegionId | null = null;
  for (const r of g.ranges) {
    for (const s of r.slots) {
      if (s.region && s.arc1 > s.arc0 && arc <= s.arc1 + 1e-6 && arc >= s.arc0 - 1e-6) return s.region;
      if (s.region && arc >= s.arc0) found = s.region;
    }
  }
  return found;
}

/** The step and the waypoints the head has reached: those whose arc length is not above the head. */
export function reachedSteps(g: PathGeometry, arc: number): number {
  let n = 0;
  for (const w of g.waypoints) if (arc >= w.arc - 1e-6) n = w.step;
  return n;
}

// -------------------------------------------------------------------------------------------------- the route strip

/** The region that a step with no node in the graph takes from its kind, or null where it takes the region before it. */
export function anchorRegion(kind: string): RegionId | null {
  switch (kind) {
    case "prompt":
    case "session.start":
    case "mission.start":
      return "thalamus";
    case "session.end":
    case "mission.end":
    case "compile":
      return "brainstem";
    case "review.none":
      return "basal";
    default:
      return null;
  }
}

/** The regions of the hop 0 nodes of a step in order, consecutive repeats once. A step with no node takes the region of its anchor. */
export function stepRegions(step: TrailStep, regionOf: (id: string) => RegionId | undefined, before: RegionId | null): RegionId[] {
  const out: RegionId[] = [];
  for (const a of step.activation) {
    if (a.hop !== 0 || isMissing(a.id)) continue;
    const r = regionOf(a.id);
    if (r && out[out.length - 1] !== r) out.push(r);
  }
  if (out.length) return out;
  const fallback = anchorRegion(step.kind) ?? before;
  return fallback ? [fallback] : [];
}

export interface RouteRun {
  region: RegionId;
  steps: number[];
}

/** The regions in the order in which the path visited them: consecutive nodes in one region form one run, and a step across two regions is in both runs. */
export function routeRuns(steps: TrailStep[], regionOf: (id: string) => RegionId | undefined): RouteRun[] {
  const runs: RouteRun[] = [];
  let before: RegionId | null = null;
  steps.forEach((step, i) => {
    const n = i + 1;
    for (const r of stepRegions(step, regionOf, before)) {
      const cur = runs[runs.length - 1];
      if (cur && cur.region === r) {
        if (cur.steps[cur.steps.length - 1] !== n) cur.steps.push(n);
      } else runs.push({ region: r, steps: [n] });
      before = r;
    }
  });
  return runs;
}

/** The runs with each step in its first run only, which are the groups of the panel for a path of more than 40 steps. */
export function routeGroups(steps: TrailStep[], regionOf: (id: string) => RegionId | undefined): RouteRun[] {
  const groups: RouteRun[] = [];
  let before: RegionId | null = null;
  steps.forEach((step, i) => {
    const r = stepRegions(step, regionOf, before)[0] ?? before;
    if (!r) return;
    before = r;
    const cur = groups[groups.length - 1];
    if (cur && cur.region === r) cur.steps.push(i + 1);
    else groups.push({ region: r, steps: [i + 1] });
  });
  return groups;
}

/** Step numbers in words: "2 to 5" for 3 or more in a row, "5 and 6" for 2, and a list otherwise. */
export function stepsLabel(steps: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < steps.length) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1] === steps[j] + 1) j += 1;
    const count = j - i + 1;
    if (count >= 3) parts.push(`${steps[i]} to ${steps[j]}`);
    else for (let k = i; k <= j; k += 1) parts.push(String(steps[k]));
    i = j + 1;
  }
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** One run in words, for example "Rules and decisions 2 to 5". */
export function runLabel(run: RouteRun, regionName: (id: RegionId) => string): string {
  return `${regionName(run.region)} ${stepsLabel(run.steps)}`;
}

/** The whole route in one sentence, for example "Task routing 1, Rules and decisions 2 to 5, Tools and scripts 6". */
export function routeSentence(runs: RouteRun[], regionName: (id: RegionId) => string): string {
  return runs.map((r) => runLabel(r, regionName)).join(", ");
}

// ------------------------------------------------------------------------------------------------ badges and plates

export interface BadgePoint {
  step: number;
  x: number;
  y: number;
}

export interface BadgeCapsule {
  steps: number[];
  x: number;
  y: number;
}

/**
 * Merge the waypoint badges that lie closer than `radius` pixels into capsules that list their step numbers, so that every
 * step stays shown at any distance. Where more than `max` capsules result, the radius grows until they fit.
 */
export function mergeBadges(points: BadgePoint[], radius = BADGE_MERGE_PX, max = BADGE_MAX): BadgeCapsule[] {
  let r = radius;
  for (let pass = 0; pass < 8; pass += 1) {
    const out: BadgeCapsule[] = [];
    for (const p of points) {
      const hit = out.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < r);
      if (hit) {
        hit.steps.push(p.step);
        hit.x += (p.x - hit.x) / hit.steps.length;
        hit.y += (p.y - hit.y) / hit.steps.length;
      } else out.push({ steps: [p.step], x: p.x, y: p.y });
    }
    if (out.length <= max || pass === 7) return out;
    r *= 1.5;
  }
  return [];
}

/** The steps whose sentences stand on plates while the whole path is shown: findings first, then the first and last step, the first step of each run, and steps spaced evenly. */
export function platePicks(count: number, markerSteps: number[], runs: RouteRun[], max = PATH_PLATES_MAX): number[] {
  const picks: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= count && !picks.includes(n) && picks.length < max) picks.push(n);
  };
  markerSteps.forEach(add);
  add(1);
  add(count);
  runs.forEach((r) => add(r.steps[0]));
  const room = max - picks.length;
  for (let k = 1; k <= room && count > 2; k += 1) add(Math.round(1 + (k * (count - 1)) / (room + 1)));
  return picks.sort((a, b) => a - b);
}

// ------------------------------------------------------------------------------------------------ an agent run path

const ACTIVATION = (ids: string[]): Activation[] => ids.map((id) => ({ id, a: 1, hop: 0, via: null }));
/** The first node on the main line and the rest as branches from it, for a step that names many nodes (docs/BRAIN.md, "The shape of an agent run path"). */
const FANNED = (ids: string[]): Activation[] => (ids.length - 1 > PATH_FAN_AFTER ? ids.map((id, i) => ({ id, a: 1, hop: i ? 1 : 0, via: i ? ids[0] : null })) : ACTIVATION(ids));
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const KIND_OF_TYPE: Record<string, PathHop["kind"]> = { PolicyClause: "clause", Control: "control", Obligation: "obligation", LegislativeProvision: "provision" };
const KIND_WORD: Record<PathHop["kind"], string> = { clause: "policy clause", control: "control", obligation: "obligation", provision: "provision", item: "item" };
const withArticle = (word: string): string => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
const hopLetter = (k: number): string => (k < 26 ? String.fromCharCode(97 + k) : `h${k + 1}`);

/** The name of a hop in plain words: the clause number and its name, or the label of the control, the obligation or the provision. */
function hopName(kind: PathHop["kind"], l: ChainLink): string {
  const label = l.to_label || l.to;
  return kind === "clause" && l.clause_ref ? `${l.clause_ref} ${label}` : label;
}

/** The words that join a hop to the one before it in the sentence of a chain step. */
function hopPhrase(kind: PathHop["kind"], name: string, first: boolean): string {
  switch (kind) {
    case "clause":
      return first ? `implements clause ${name}` : `is set out in clause ${name}`;
    case "control":
      return `realises the control ${name}`;
    case "obligation":
      return `satisfies the obligation ${name}`;
    case "provision":
      return `is expressed in ${name}`;
    default:
      return `links to ${name}`;
  }
}

export interface ChainSteps {
  sentence: string;
  /** the graph ids of the main line after the instruction, in order */
  main: string[];
  /** nodes that hang off the main line, each from the node it comes from */
  extra: { id: string; via: string }[];
  /** the ids of the missing links, which end in a dashed stub */
  stubs: string[];
  hops: PathHop[];
}

/**
 * The chain of a cited instruction as hops (docs/BRAIN.md, "The hops of a chain"). The main line follows the links from the instruction while
 * each link starts where the one before ended, so that it reads clause, control, obligation and provision. A link that starts elsewhere
 * (a second obligation of the same control, say) is a hop of its own whose node is a branch of the step. A missing link is a hop with no
 * node, and it ends the sentence and the line in a dashed stub.
 */
export function chainSteps(instr: { id: string; label: string }, links: ChainLink[]): ChainSteps {
  const main: string[] = [];
  const extra: { id: string; via: string }[] = [];
  const stubs: string[] = [];
  const hops: PathHop[] = [];
  const parts: string[] = [];
  let current = instr.id;
  let ended = false;
  for (const l of links) {
    const kind = KIND_OF_TYPE[l.to_type] ?? "item";
    const letter = hopLetter(hops.length);
    if (l.status === "missing") {
      hops.push({ letter, node: null, kind, name: "", status: "missing", main: !ended && l.from === current });
      stubs.push(`${MISSING_PREFIX}${l.relation}:${l.from}`);
      if (!ended && l.from === current) {
        parts.push(`has no link to ${withArticle(KIND_WORD[kind])}`);
        ended = true;
      }
      continue;
    }
    const name = hopName(kind, l);
    const onLine = !ended && l.from === current;
    hops.push({ letter, node: l.to, kind, name, status: l.status, main: onLine });
    if (onLine) {
      if (main[main.length - 1] !== l.to) main.push(l.to);
      parts.push(hopPhrase(kind, name, parts.length === 0));
      current = l.to;
    } else if (l.to !== instr.id && !main.includes(l.to) && !extra.some((e) => e.id === l.to)) extra.push({ id: l.to, via: l.from });
  }
  const none = hops.length === 0 || hops.every((h) => h.status === "missing");
  const sentence = none
    ? `Looked for the ${KIND_WORD[hops[0]?.kind ?? "clause"]} of ${instr.label}. No ${KIND_WORD[hops[0]?.kind ?? "clause"]} is mapped to this instruction`
    : `${instr.label} ${parts.join(", which ")}`;
  return { sentence, main, extra, stubs, hops };
}

/** The chain hop as one line of the panel, for example "9a Policy clause FCP 8.2 Comparison of identifiers, ratified". */
export function hopLine(n: number, h: PathHop): string {
  if (h.status === "missing") return `${n}${h.letter} No link to ${withArticle(KIND_WORD[h.kind])}`;
  const word = KIND_WORD[h.kind];
  return `${n}${h.letter} ${word.charAt(0).toUpperCase()}${word.slice(1)} ${h.name}, ${h.status}`;
}

/** The finding markers of a path, each on the waypoint of the step that carries it (docs/BRAIN.md, "Findings on the path"). */
export function markerSpots(steps: TrailStep[], waypointOf: (step: number) => V3 | undefined): { step: number; pos: V3; marker: PathMarker }[] {
  const out: { step: number; pos: V3; marker: PathMarker }[] = [];
  steps.forEach((step, i) => {
    const pos = waypointOf(i + 1);
    if (!pos) return;
    for (const marker of step.markers ?? []) out.push({ step: i + 1, pos, marker });
  });
  return out;
}

/** The steps whose sentence stands on a plate while the path plays or a step is selected: that step, and every step with a finding that the head has reached. */
export function livePlatePicks(current: number, markerSteps: number[], reached: (n: number) => boolean, max = PATH_PLATES_MAX): number[] {
  const out: number[] = [];
  if (current >= 1) out.push(current);
  for (const n of markerSteps) if (reached(n) && !out.includes(n) && out.length < max) out.push(n);
  return out;
}

function personWords(id: string): string {
  const s = id.replace(/^person:/, "").replace(/[-_]+/g, " ").trim();
  return s ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : "The reviewer";
}

function verdictWords(verdict: string | null, override: boolean): string {
  if (override) return "overrode it";
  switch (verdict) {
    case "agree":
      return "agreed with it";
    case "disagree":
      return "disagreed with it";
    case null:
    case undefined:
    case "":
      return "recorded no verdict";
    default:
      return `recorded the verdict ${verdict.replace(/[-_]+/g, " ")}`;
  }
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The path of a recorded agent run, by the table of docs/BRAIN.md. The labels are those of the trace, so that this view and
 * the Oversight window use the same words. `hasNode` says whether the graph on screen holds an id, and `findCase` returns the
 * graph id of the alert or case that the run names, where there is one.
 */
export function agentPath(trace: DecisionTrace, hasNode: (id: string) => boolean, findCase?: (ref: string) => string | null): TracePath {
  const L = trace.labels;
  const steps: TrailStep[] = [];
  const firstOfTraceStep = new Map<string, number>();
  const stepsVisiting = new Map<string, number[]>();
  const add = (kind: string, sentence: string, label: string, ids: string[], ts: string, trace_step?: string, fan = false, own?: { activation: Activation[]; hops: PathHop[] }): number => {
    const n = steps.length + 1;
    const lost = ids.filter((id) => !isMissing(id) && !hasNode(id));
    steps.push({ n, kind, sentence, mode: "recorded", ts, activation: own ? own.activation : fan ? FANNED(ids) : ACTIVATION(ids), label, ...(own ? { hops: own.hops } : {}), ...(lost.length ? { absent: [...new Set(lost)] } : {}) });
    if (trace_step && !firstOfTraceStep.has(trace_step)) firstOfTraceStep.set(trace_step, n);
    for (const id of ids) stepsVisiting.set(id, [...(stepsVisiting.get(id) ?? []), n]);
    return n;
  };
  const ref = trace.run.replace(/^run:/, "");
  let loaded: string[] = [];
  let decisionPart1 = 0;
  const decisionOf = trace.decision;
  const loadStep = (ids: string[], ts: string, why: string, again: boolean) => {
    add("run.instructions", again ? `Loaded the same ${count(ids.length, "instruction")}` : `Loaded ${count(ids.length, "instruction")}`, L.loaded, [why, ...ids], ts, why, true);
  };

  for (const s of trace.steps) {
    const ts = s.ts;
    const inCtx = s.in_context.map((i) => i.id);
    switch (s.kind) {
      case "start": {
        const ids = [trace.agent.id, trace.run, s.id];
        const caseNode = trace.case_ref ? findCase?.(trace.case_ref) : null;
        if (caseNode) ids.push(caseNode);
        add("run.start", `The agent ${agentName(trace.agent.label || trace.agent.id)} started run ${ref}${trace.case_ref ? ` for the case ${trace.case_ref}` : ""}`, L.recorded, ids, ts, s.id);
        break;
      }
      case "instructions":
        loadStep(inCtx, ts, s.id, sameSet(inCtx, loaded));
        loaded = inCtx;
        continue;
      case "evidence":
      case "retrieval":
      case "tool": {
        const ids = [s.id, ...(s.tool_id ? [s.tool_id] : []), ...s.evidence.map((e) => e.id)];
        let sentence: string;
        if (s.evidence.length === 1) sentence = `Read ${evidenceName(s.evidence[0].label)}`;
        else if (s.evidence.length > 1) sentence = `Read ${count(s.evidence.length, "item")} of evidence`;
        else sentence = s.tool ? `Used the tool ${s.tool.replace(/[-_]+/g, " ")}` : `Ran the step ${s.kind}`;
        add(s.kind === "tool" ? "run.tool" : "run.evidence", sentence, L.recorded, ids, ts, s.id);
        break;
      }
      case "rationale":
        add("run.rationale", "The agent wrote its rationale", L.stated, [s.id, ...(s.rationale?.id ? [s.rationale.id] : [])], ts, s.id);
        break;
      case "decision": {
        const cited = s.cited.map((c) => c.id);
        decisionPart1 = add("run.cited", cited.length ? `Cited ${count(cited.length, "instruction")} at the decision` : "Cited no instruction at the decision", L.stated, [s.id, ...cited], ts, s.id, true);
        for (const c of s.cited) {
          const chain = chainSteps(c, trace.chains[c.id] ?? []);
          const onLine = [c.id, ...chain.main];
          const ids = [...onLine, ...chain.extra.map((e) => e.id), ...chain.stubs];
          const activation: Activation[] = [
            ...ACTIVATION(onLine),
            ...chain.extra.map((e) => ({ id: e.id, a: 1, hop: 1, via: e.via })),
            ...ACTIVATION(chain.stubs),
          ];
          add("run.chain", chain.sentence, L.recorded, ids, ts, s.id, false, { activation, hops: chain.hops });
        }
        const outcome = decisionOf ? outcomeWord(decisionOf.outcome).toLowerCase() : "recorded";
        add("run.decision", `Decision recorded as ${outcome}`, L.recorded, [decisionOf?.id ?? s.id, ...(s.rationale?.id ? [s.rationale.id] : [])], ts, s.id);
        break;
      }
      case "review":
        // the review is a separate act that is recorded after the run, so trace.review adds the step below
        continue;
      case "end":
        add("run.end", "The run ended", L.recorded, [s.id], ts, s.id);
        break;
      default:
        add("run.step", `Ran the step ${s.kind.replace(/[-_]+/g, " ")}`, L.recorded, [s.id], ts, s.id);
    }
    // the instruction versions that a step has in context: one step when the set first appears or changes
    if (s.kind !== "instructions" && inCtx.length && !sameSet(inCtx, loaded)) {
      loadStep(inCtx, ts, s.id, false);
      loaded = inCtx;
    }
  }
  const endTs = trace.steps[trace.steps.length - 1]?.ts ?? "";
  if (trace.review) {
    const rv = trace.review;
    add("run.review", `${personWords(rv.reviewer)} reviewed the decision and ${verdictWords(rv.verdict, rv.override)}`, L.recorded, [rv.id ?? `${MISSING_PREFIX}review-id:${trace.run}`], endTs);
  } else {
    add("review.none", "No human review is recorded", L.recorded, [`${MISSING_PREFIX}review:${trace.run}`], endTs);
  }

  // the findings of the run, as markers on the steps that they concern
  const seen = new Set<string>();
  const mark = (f: TraceFinding, n: number) => {
    const key = `${f.check}|${f.node}|${f.message}`;
    const step = steps[n - 1];
    const title = checkTitle(f.check);
    step.markers = [...(step.markers ?? []), { severity: f.severity, title, node: hasNode(f.node) ? f.node : null } satisfies PathMarker];
    seen.add(key);
  };
  const keyOf = (f: TraceFinding) => `${f.check}|${f.node}|${f.message}`;
  for (const s of trace.steps) {
    const n = firstOfTraceStep.get(s.id) ?? steps.length;
    for (const f of s.findings) {
      if (seen.has(keyOf(f))) continue;
      // a finding of the decision step belongs to part 1 of the decision
      mark(f, s.kind === "decision" && decisionPart1 ? decisionPart1 : n);
    }
  }
  for (const f of trace.findings) {
    if (seen.has(keyOf(f))) continue;
    const visiting = stepsVisiting.get(f.node)?.[0];
    mark(f, visiting ?? (decisionPart1 || steps.length));
  }
  return { id: `run-${trace.run}`, source: "run", run: trace.run, steps };
}

/** The ids of the nodes of a run path that the graph on screen does not hold, and the number of nodes the path names. */
export function absentSummary(path: TracePath, hasNode: (id: string) => boolean): { absent: number; total: number; steps: number[] } {
  const all = new Set<string>();
  const lost = new Set<string>();
  const steps: number[] = [];
  for (const s of path.steps) {
    let any = false;
    for (const a of s.activation) {
      if (isMissing(a.id)) continue;
      all.add(a.id);
      if (!hasNode(a.id)) {
        lost.add(a.id);
        any = true;
      }
    }
    if (any) steps.push(s.n);
  }
  return { absent: lost.size, total: all.size, steps };
}

/** The point of the line at an arc length, or null where the line holds no piece. */
export function pointAt(g: PathGeometry, arc: number): V3 | null {
  const n = g.line.count;
  if (!n || arc < 0) return null;
  const a = g.line.arcs;
  const e = g.line.ends;
  if (arc >= a[n * 2 - 1]) return { x: e[n * 6 - 3], y: e[n * 6 - 2], z: e[n * 6 - 1] };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m * 2 + 1] < arc) lo = m + 1;
    else hi = m;
  }
  const a0 = a[lo * 2];
  const a1 = a[lo * 2 + 1];
  const t = a1 > a0 ? Math.min(1, Math.max(0, (arc - a0) / (a1 - a0))) : 0;
  const o = lo * 6;
  return { x: e[o] + (e[o + 3] - e[o]) * t, y: e[o + 1] + (e[o + 4] - e[o + 1]) * t, z: e[o + 2] + (e[o + 5] - e[o + 2]) * t };
}

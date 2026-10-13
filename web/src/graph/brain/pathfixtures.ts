// Shared fixtures for the tests of the traced path: a deterministic world of nodes inside the volume of a brain, the prompts of the
// reviews of 13 October 2026 (12 and 45 steps) and two recorded runs shaped like AL-2026-0001 and AL-2026-0012. Not used by the app.
import type { Activation, DecisionTrace } from "@shared/types";
import { REGION_IDS, type RegionId } from "@shared/brain";
import type { NodeLookup, PathNodeInfo, V3 } from "./path";
import type { TrailStep } from "./types";

/** The half extents of the volume of the test brain, in scene units. */
export const BRAIN: V3 = { x: 95, y: 72, z: 110 };

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const unit = (s: string, k: number): number => (hash(`${k}:${s}`) % 100000) / 100000;

/** Every id has a fixed place inside the ellipsoid of the brain, and a region taken from the id. */
export const worldOf: NodeLookup = (id): PathNodeInfo => {
  const u = unit(id, 1);
  const v = unit(id, 2);
  const r = 0.35 + 0.65 * Math.cbrt(unit(id, 3));
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  return {
    pos: { x: BRAIN.x * r * Math.sin(phi) * Math.cos(theta), y: BRAIN.y * r * Math.cos(phi), z: BRAIN.z * r * Math.sin(phi) * Math.sin(theta) },
    region: REGION_IDS[hash(id) % REGION_IDS.length] as RegionId,
  };
};

const act = (ids: string[], hop = 0, via: string | null = null): Activation[] => ids.map((id) => ({ id, a: 1, hop, via }));

/** A prompt of `count` steps, each on 1 to 3 nodes with a few nodes of hop 1 and 2, like the screenshot prompts. */
export function promptSteps(count: number): TrailStep[] {
  return Array.from({ length: count }, (_, i) => {
    const own = Array.from({ length: 1 + (i % 3) }, (_, k) => `node:${i}:${k}`);
    const more = i % 2 ? [...act([`far:${i}:a`, `far:${i}:b`], 1, own[0]), ...act([`far:${i}:c`], 2, `far:${i}:a`)] : [];
    return { n: i + 1, kind: i === 0 ? "prompt" : "read", sentence: `Step ${i + 1}`, mode: "observed", ts: "", activation: [...act(own), ...more] } satisfies TrailStep;
  });
}

const ref = (id: string, label: string) => ({ id, label, version: 1, status: "approved", in_force: true, maker: "a", approver: "b", approved_on: "2026-08-01", self_approved: false });

type Link = DecisionTrace["chains"][string][number];
const TYPE_OF: Record<string, string> = { implementsClause: "PolicyClause", realises: "Control", satisfies: "Obligation", expressedIn: "LegislativeProvision" };
export const link = (relation: string, from: string, to: string, status: Link["status"], extra: Partial<Link> = {}): Link => ({ mapping: null, relation, from, to, to_label: to ? `L ${to}` : "", to_type: TYPE_OF[relation] ?? "X", status, ...extra });

/**
 * A recorded run: `loaded` instructions in context, `cited` of them cited at the decision, and a chain from each to the same
 * provision (as in AL-2026-0001, where steps 9 to 14 all end at one provision), or ending in a missing link (as in AL-2026-0012).
 */
export function runTrace(opts: { run: string; loaded: number; cited: number; shared: boolean; missing: number }): DecisionTrace {
  const all = Array.from({ length: opts.loaded }, (_, i) => ref(`instr:${opts.run}-${i}`, `Instruction ${i}`));
  const cited = all.slice(0, opts.cited);
  const chains: DecisionTrace["chains"] = {};
  cited.forEach((c, i) => {
    const prov = opts.shared ? "prov:shared" : `prov:${opts.run}-${i}`;
    chains[c.id] = [
      link("implementsClause", c.id, `clause:${opts.run}-${i}`, "ratified"),
      link("realises", `clause:${opts.run}-${i}`, `control:${opts.run}-${i}`, "ratified"),
      link("satisfies", `control:${opts.run}-${i}`, `obl:${opts.run}-${i % 3}`, "stated"),
      link("expressedIn", `obl:${opts.run}-${i % 3}`, prov, i < opts.missing ? "missing" : "stated"),
    ];
  });
  const s = (id: string, step: number, kind: string, extra: object = {}) => ({ id, step, kind, ts: `t${step}`, tool: null, tool_id: null, evidence: [], in_context: all, cited: [], rationale: null, findings: [], ...extra });
  return {
    run: `run:${opts.run}`,
    agent: { id: "dagent:alert-triage", label: "dagent:alert-triage" },
    model: { id: "model:m", status: "approved", approved: true },
    case_ref: opts.run,
    decision: { id: `adec:${opts.run}`, outcome: "escalate", step: 4, ts: "2026-09-14T10:00:00Z" },
    review: { id: `review:${opts.run}`, reviewer: "pell-ankarow", verdict: "agree", override: false, override_reason: null, time_open_s: 3, items_viewed: 1, checks_ticked: [] },
    steps: [
      s(`step:${opts.run}-0`, 0, "start"),
      s(`step:${opts.run}-1`, 1, "evidence", { tool: "alert-queue-read", tool_id: `call:${opts.run}-1`, evidence: [{ id: `evid:${opts.run}`, label: "alert", hash: null, source: null }] }),
      s(`step:${opts.run}-2`, 2, "rationale", { rationale: { id: `rationale:${opts.run}`, hash: "h", content_ref: null, text: null } }),
      s(`step:${opts.run}-3`, 3, "decision", { cited }),
      s(`step:${opts.run}-4`, 4, "review"),
      s(`step:${opts.run}-5`, 5, "end"),
    ],
    chains,
    findings: [],
    ledger: { entries: 6, verified: true, breaks: 0 },
    replayable: true,
    labels: { recorded: "recorded", loaded: "loaded", stated: "stated by the agent, cause unverified" },
  } as DecisionTrace;
}

/** The runs of the review: AL-2026-0001 loads 27 instructions and cites 6 that end at one provision, AL-2026-0012 cites 3 with missing links. */
export const RUN_0001 = () => runTrace({ run: "AL-2026-0001", loaded: 27, cited: 6, shared: true, missing: 0 });
export const RUN_0012 = () => runTrace({ run: "AL-2026-0012", loaded: 9, cited: 3, shared: true, missing: 2 });

/** The volume that the curves of a test path stay in: the box of the test brain. */
export const volumeFor = (): V3 => BRAIN;

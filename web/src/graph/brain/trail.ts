// The thought trail (docs/BRAIN.md, "The thought trail"): the sentence of each event, the numbering of the steps of a
// prompt, the steps of a predicted plan, and the queue that plays steps one at a time. Pure apart from the timers of
// the queue, so that the sentences and the timing are tested with fake timers.
import type { Activation, CortexEvent, GraphNode, Plan } from "@shared/types";
import { DEFAULT_BRAIN_DOMAINS, regionOf, type BrainDomains, type RegionId } from "@shared/brain";
import { leadRegion } from "./schedule";
import type { TrailStep } from "./types";

/** The background class of each region colour, written out so that Tailwind finds it. */
export const REGION_BG: Record<RegionId, string> = {
  prefrontal: "bg-region-prefrontal",
  language: "bg-region-language",
  occipital: "bg-region-occipital",
  motor: "bg-region-motor",
  parietal: "bg-region-parietal",
  memory: "bg-region-memory",
  basal: "bg-region-basal",
  thalamus: "bg-region-thalamus",
  cerebellum: "bg-region-cerebellum",
  brainstem: "bg-region-brainstem",
};

let domains: BrainDomains = DEFAULT_BRAIN_DOMAINS;

/** Use the brain_domains of /api/status for the region of every node, or the defaults when the status has none. */
export function setBrainDomains(next: BrainDomains | undefined | null): void {
  domains = next ?? DEFAULT_BRAIN_DOMAINS;
}

/** The word lists in use, for the scene. */
export function brainDomains(): BrainDomains {
  return domains;
}

/** The region of a node of the graph, by the same rule as the scene. */
export function regionOfNode(node: GraphNode): RegionId {
  return regionOf(node, node.path, domains);
}

/** The region that a step turns the camera to, or null when none of its nodes is in the graph. */
export function stepRegion(step: TrailStep, byId: Map<string, GraphNode>): RegionId | null {
  return leadRegion(step.activation, (id) => {
    const n = byId.get(id);
    return n ? regionOfNode(n) : undefined;
  });
}

/** A step lasts at least this long, so that a person can read its sentence. */
export const MIN_STEP_MS = 900;
/** More than this many steps waiting makes the queue play at double speed. */
export const CATCH_UP_AFTER = 8;

/** The last part of a path or an identifier, for a sentence. */
function tail(text: string): string {
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

/** The sentence of one event, by the table of docs/BRAIN.md. */
export function sentenceFor(event: Pick<CortexEvent, "kind" | "label" | "meta">): string {
  const label = event.label.trim();
  const file = tail(label) || "a file";
  const name = label || "unnamed";
  switch (event.kind) {
    case "prompt":
      return "Prompt received";
    case "route":
      return `Routed to the task type ${name}`;
    case "instructions":
      return `Loaded ${file}`;
    case "read":
      return `Read ${file}`;
    case "write":
      return `Wrote ${file}`;
    case "skill":
      return `Used the skill ${name}`;
    case "agent.start":
      return `Agent ${name} started`;
    case "agent.stop":
      return `Agent ${name} finished`;
    case "tool":
      return `Used the tool ${name}`;
    case "check":
      return `Ran the check ${name}`;
    case "fault":
      return `Found the fault ${name}`;
    case "session.start":
      return "Session started";
    case "session.end":
      return "Session ended";
    case "mission.start":
      return "Mission started";
    case "mission.step": {
      const n = event.meta?.step ?? event.meta?.n;
      return typeof n === "number" ? `Mission step ${n}` : "Mission step";
    }
    case "mission.end":
      return "Mission finished";
    default:
      return label ? `${event.kind} ${label}` : event.kind;
  }
}

/** The steps of the current prompt, and those of the prompt before it, which Replay uses when the current one is empty. */
export interface TrailState {
  current: TrailStep[];
  previous: TrailStep[];
}

export const EMPTY_TRAIL: TrailState = { current: [], previous: [] };

/** Add an event. A prompt event starts a new prompt: its steps are numbered from 1 and the old steps move to `previous`. */
export function addEvent(state: TrailState, event: CortexEvent, activation: Activation[]): { state: TrailState; step: TrailStep } {
  const starts = event.kind === "prompt";
  const base = starts ? [] : state.current;
  const step: TrailStep = {
    n: base.length + 1,
    kind: event.kind,
    sentence: sentenceFor(event),
    mode: "observed",
    ts: event.ts,
    activation,
  };
  return {
    state: { current: [...base, step], previous: starts && state.current.length ? state.current : state.previous },
    step,
  };
}

/** A prompt with no new step for this long counts as completed. */
export const PROMPT_IDLE_MS = 60_000;

/** Whether the current prompt is still running: its last step is not an end and arrived a short time ago. */
export function promptRunning(state: TrailState, now: number = Date.now()): boolean {
  const last = state.current[state.current.length - 1];
  if (!last || last.kind === "session.end" || last.kind === "mission.end") return false;
  const at = Date.parse(last.ts);
  return Number.isFinite(at) && now - at < PROMPT_IDLE_MS;
}

/** The steps that Replay plays: the last completed prompt, which is the one before the current prompt while that runs. */
export function replaySteps(state: TrailState, now: number = Date.now()): TrailStep[] {
  if (promptRunning(state, now) && state.previous.length) return state.previous;
  return state.current.length ? state.current : state.previous;
}

/** The most steps that a plan is split into. */
export const MAX_PLAN_STEPS = 8;

/**
 * Split the predicted spread of a plan into steps. Each node at hop 0 starts a step, with the nodes that its via
 * chain reaches. Without a spread the nodes of plan.fire are used, all at hop 0. Beyond the limit the remaining
 * starting nodes share the last step. Predicted steps are never recorded.
 */
export function stepsFromPlan(plan: Plan, labelOf: (id: string) => string, now: Date = new Date()): TrailStep[] {
  const spread: Activation[] = plan.spread?.length
    ? plan.spread
    : plan.fire.map((f) => ({ id: f.id, a: f.a, hop: 0, via: null }));
  const roots = spread.filter((x) => x.hop === 0);
  if (!roots.length) return [];
  const viaOf = new Map(spread.map((x) => [x.id, x.via]));
  const rootOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 4; i += 1) {
      const v = viaOf.get(cur);
      if (!v) break;
      cur = v;
    }
    return cur;
  };
  const taskIds = new Set(plan.task_types.map((t) => t.id));
  const entityIds = new Set(plan.entities.map((e) => e.id));
  const sorted = [...roots.filter((r) => taskIds.has(r.id)), ...roots.filter((r) => !taskIds.has(r.id))];
  const groups: { head: Activation[]; ids: Set<string> }[] = sorted.map((r) => ({ head: [r], ids: new Set([r.id]) }));
  while (groups.length > MAX_PLAN_STEPS) {
    const last = groups.pop()!;
    groups[groups.length - 1].head.push(...last.head);
    last.ids.forEach((id) => groups[groups.length - 1].ids.add(id));
  }
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.ids.forEach((id) => groupOf.set(id, i)));
  const members: Activation[][] = groups.map((g) => [...g.head]);
  for (const x of spread) {
    if (x.hop === 0) continue;
    const gi = groupOf.get(rootOf(x.id)) ?? 0;
    members[gi].push(x);
  }
  const ts = now.toISOString();
  return groups.map((g, i) => {
    const first = g.head[0];
    let sentence: string;
    if (g.head.length > 1) sentence = `Would load ${g.head.length} more starting nodes`;
    else if (taskIds.has(first.id)) sentence = `Would route to the task type ${labelOf(first.id)}`;
    else if (entityIds.has(first.id)) sentence = `Would match ${labelOf(first.id)}`;
    else sentence = `Would load ${labelOf(first.id)}`;
    return { n: i + 1, kind: "plan", sentence, mode: "predicted" as const, ts, activation: members[i] };
  });
}

/** The longest hop of a step, which sets how long its nodes take to light. */
function span(step: TrailStep): number {
  return step.activation.reduce((m, a) => Math.max(m, a.hop), 0) * 250;
}

export interface QueueHooks {
  /** play the step now: draw it on the canvas */
  play: (step: TrailStep) => void;
  /** the queue started or stopped catching up, with more than 8 steps waiting */
  catchingUp?: (on: boolean) => void;
  /** the queue has played everything it held */
  idle?: () => void;
}

/**
 * Plays steps one at a time. A step lasts at least 900 ms, or its hop span and 400 ms where that is longer, divided
 * by the speed. The speed doubles while more than 8 steps wait. A step that arrives when the queue is empty plays at once.
 */
export class TrailQueue {
  private waiting: TrailStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private catching = false;
  private base = 1;

  constructor(private hooks: QueueHooks) {}

  get pending(): number {
    return this.waiting.length;
  }

  /** The speed chosen for Replay: 0.5, 1 or 2. Live steps play at 1. */
  setSpeed(speed: number): void {
    this.base = speed;
  }

  push(step: TrailStep): void {
    this.waiting.push(step);
    this.note();
    if (!this.busy) this.next();
  }

  /** Drop what waits and stop the timer, for a new prompt that replaces the replay. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = [];
    this.busy = false;
    this.note();
  }

  private note(): void {
    const on = this.waiting.length > CATCH_UP_AFTER;
    if (on !== this.catching) {
      this.catching = on;
      this.hooks.catchingUp?.(on);
    }
  }

  private next(): void {
    const crowded = this.waiting.length > CATCH_UP_AFTER;
    const step = this.waiting.shift();
    this.note();
    if (!step) {
      this.busy = false;
      this.hooks.idle?.();
      return;
    }
    this.busy = true;
    this.hooks.play(step);
    const factor = this.base * (crowded ? 2 : 1);
    const ms = Math.max(MIN_STEP_MS, span(step) + 400) / factor;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.next();
    }, ms);
  }
}

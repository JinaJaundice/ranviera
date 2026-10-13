import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CortexEvent, Plan } from "@shared/types";
import { EMPTY_TRAIL, TrailQueue, addEvent, replaySteps, regionOfNode, setBrainDomains, sentenceFor, stepsFromPlan } from "./trail";
import type { TrailStep } from "./types";

const ev = (kind: CortexEvent["kind"], label = "", meta: Record<string, unknown> = {}): CortexEvent => ({
  v: 1,
  ts: "2026-10-06T10:00:00.000Z",
  session: "s",
  source: "hook",
  kind,
  nodes: [],
  weight: 1,
  label,
  key: null,
  meta,
});

describe("sentenceFor", () => {
  it("gives the sentence of each kind in docs/BRAIN.md", () => {
    expect(sentenceFor(ev("prompt"))).toBe("Prompt received");
    expect(sentenceFor(ev("route", "Write a deck"))).toBe("Routed to the task type Write a deck");
    expect(sentenceFor(ev("instructions", "rules/writing.md"))).toBe("Loaded writing.md");
    expect(sentenceFor(ev("read", "C:\\a\\notes.md"))).toBe("Read notes.md");
    expect(sentenceFor(ev("write", "a/b/out.md"))).toBe("Wrote out.md");
    expect(sentenceFor(ev("skill", "sample-skill"))).toBe("Used the skill sample-skill");
    expect(sentenceFor(ev("agent.start", "builder"))).toBe("Agent builder started");
    expect(sentenceFor(ev("agent.stop", "builder"))).toBe("Agent builder finished");
    expect(sentenceFor(ev("tool", "Bash"))).toBe("Used the tool Bash");
    expect(sentenceFor(ev("check", "prose"))).toBe("Ran the check prose");
    expect(sentenceFor(ev("fault", "F03"))).toBe("Found the fault F03");
    expect(sentenceFor(ev("session.start"))).toBe("Session started");
    expect(sentenceFor(ev("session.end"))).toBe("Session ended");
    expect(sentenceFor(ev("mission.start"))).toBe("Mission started");
    expect(sentenceFor(ev("mission.step", "", { step: 3 }))).toBe("Mission step 3");
    expect(sentenceFor(ev("mission.end"))).toBe("Mission finished");
  });
});

describe("numbering", () => {
  it("numbers the steps of a prompt and starts again at a prompt event", () => {
    let s = EMPTY_TRAIL;
    s = addEvent(s, ev("prompt"), []).state;
    s = addEvent(s, ev("route", "X"), []).state;
    const third = addEvent(s, ev("read", "a.md"), []);
    expect(third.step.n).toBe(3);
    s = third.state;
    expect(s.current.map((x) => x.n)).toEqual([1, 2, 3]);
    const again = addEvent(s, ev("prompt"), []);
    expect(again.step.n).toBe(1);
    expect(again.state.current).toHaveLength(1);
    expect(again.state.previous).toHaveLength(3);
    expect(replaySteps(again.state)).toHaveLength(1);
    expect(replaySteps({ current: [], previous: s.current })).toHaveLength(3);
  });
});

describe("stepsFromPlan", () => {
  const plan = {
    prompt_hash: "h",
    task_types: [{ id: "t1", label: "Deck", matched: [] }],
    entities: [{ id: "e1", label: "Acme", matched: "acme" }],
    fire: [{ id: "t1", a: 1 }, { id: "e1", a: 0.8 }],
    steps: [],
    gates: [],
    cautions: [],
    spread: [
      { id: "t1", a: 1, hop: 0, via: null },
      { id: "e1", a: 0.8, hop: 0, via: null },
      { id: "r1", a: 0.5, hop: 1, via: "t1" },
      { id: "r2", a: 0.3, hop: 2, via: "r1" },
      { id: "p1", a: 0.4, hop: 1, via: "e1" },
    ],
  } as unknown as Plan;
  const label = (id: string) => `label ${id}`;

  it("makes one predicted step for each starting node, with the nodes that follow from it", () => {
    const steps = stepsFromPlan(plan, label);
    expect(steps.map((x) => x.mode)).toEqual(["predicted", "predicted"]);
    expect(steps[0].sentence).toBe("Would route to the task type label t1");
    expect(steps[0].activation.map((a) => a.id)).toEqual(["t1", "r1", "r2"]);
    expect(steps[1].sentence).toBe("Would match label e1");
    expect(steps[1].activation.map((a) => a.id)).toEqual(["e1", "p1"]);
  });

  it("falls back to the fire list at hop 0 when there is no spread", () => {
    const steps = stepsFromPlan({ ...plan, spread: undefined }, label);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.activation.every((a) => a.hop === 0))).toBe(true);
  });

  it("shares the last step among starting nodes beyond 8", () => {
    const fire = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, a: 1 }));
    const steps = stepsFromPlan({ ...plan, task_types: [], entities: [], fire, spread: undefined }, label);
    expect(steps).toHaveLength(8);
    expect(steps[7].activation).toHaveLength(5);
  });
});

describe("TrailQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const step = (n: number, hop = 0): TrailStep => ({
    n,
    kind: "read",
    sentence: `s${n}`,
    mode: "observed",
    ts: "",
    activation: [{ id: `n${n}`, a: 1, hop, via: null }],
  });

  it("plays the first step at once and each later step after at least 900 ms", () => {
    const played: number[] = [];
    const q = new TrailQueue({ play: (s) => played.push(s.n) });
    q.push(step(1));
    q.push(step(2));
    expect(played).toEqual([1]);
    vi.advanceTimersByTime(899);
    expect(played).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([1, 2]);
  });

  it("lets a step with hops last for its span and 400 ms", () => {
    const played: number[] = [];
    const q = new TrailQueue({ play: (s) => played.push(s.n) });
    q.push(step(1, 2));
    q.push(step(2));
    vi.advanceTimersByTime(899);
    expect(played).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([1, 2]);
  });

  it("keeps the pace of a replay or a recorded run, however many steps wait", () => {
    const played: number[] = [];
    const notes: boolean[] = [];
    const q = new TrailQueue({ play: (s) => played.push(s.n), catchingUp: (on) => notes.push(on) });
    q.setCatchUp(false);
    for (let i = 1; i <= 12; i += 1) q.push(step(i));
    expect(played).toEqual([1]);
    expect(notes).toEqual([]);
    vi.advanceTimersByTime(900);
    // a step that starts with 11 waiting still lasts the full 900 ms
    vi.advanceTimersByTime(899);
    expect(played).toEqual([1, 2]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([1, 2, 3]);
    expect(notes).toEqual([]);
  });

  it("plays at double speed and says so when more than 8 steps wait", () => {
    const played: number[] = [];
    const notes: boolean[] = [];
    const q = new TrailQueue({ play: (s) => played.push(s.n), catchingUp: (on) => notes.push(on) });
    for (let i = 1; i <= 10; i += 1) q.push(step(i));
    expect(played).toEqual([1]);
    expect(notes).toEqual([true]);
    vi.advanceTimersByTime(900);
    expect(played).toEqual([1, 2]);
    // step 2 started with 9 waiting, so it lasts 450 ms
    vi.advanceTimersByTime(450);
    expect(played).toEqual([1, 2, 3]);
    // step 3 started with 8 waiting, so the speed is back to normal and the note is off
    expect(notes).toEqual([true, false]);
    vi.advanceTimersByTime(899);
    expect(played).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(played).toHaveLength(4);
  });

  it("honours the replay speed and reports when it is idle", () => {
    const played: number[] = [];
    let idle = 0;
    const q = new TrailQueue({ play: (s) => played.push(s.n), idle: () => idle++ });
    q.setSpeed(0.5);
    q.push(step(1));
    q.push(step(2));
    vi.advanceTimersByTime(1799);
    expect(played).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual([1, 2]);
    vi.advanceTimersByTime(1800);
    expect(idle).toBe(1);
    q.clear();
    expect(q.pending).toBe(0);
  });
});

describe("replay during a running prompt", () => {
  const at = Date.parse("2026-10-06T10:00:10.000Z");
  it("replays the last completed prompt while a new prompt is running", () => {
    let s = EMPTY_TRAIL;
    s = addEvent(s, ev("prompt"), []).state;
    s = addEvent(s, ev("route", "X"), []).state;
    s = addEvent(s, ev("prompt"), []).state;
    expect(replaySteps(s, at)).toHaveLength(2);
    expect(replaySteps(s, at).map((x) => x.kind)).toEqual(["prompt", "route"]);
  });

  it("replays the current prompt once it has finished or has been idle", () => {
    let s = EMPTY_TRAIL;
    s = addEvent(s, ev("prompt"), []).state;
    s = addEvent(s, ev("route", "X"), []).state;
    s = addEvent(s, ev("prompt"), []).state;
    expect(replaySteps(s, at + 120_000)).toHaveLength(1);
    s = addEvent(s, ev("session.end"), []).state;
    expect(replaySteps(s, at)).toHaveLength(2);
  });
});

describe("brain_domains", () => {
  const node = { id: "n", type: "Skill", label: "Deck notes", path: "x/deck.md", metrics: { uses: 0 } } as never;
  it("uses the word lists of the status when present, else the defaults", () => {
    setBrainDomains({ writing: ["deck"], visual: ["zzzz"] });
    const custom = regionOfNode(node);
    setBrainDomains(undefined);
    const dflt = regionOfNode(node);
    expect(custom).not.toBe(dflt);
  });
});

describe("tool sentences (13 October 2026)", () => {
  it("keeps a label that is already a sentence and names any other tool", () => {
    expect(sentenceFor({ kind: "tool", label: "Ran a Bash command" } as Parameters<typeof sentenceFor>[0])).toBe("Ran a Bash command");
    expect(sentenceFor({ kind: "tool", label: "Bash" } as Parameters<typeof sentenceFor>[0])).toBe("Used the tool Bash");
  });
});

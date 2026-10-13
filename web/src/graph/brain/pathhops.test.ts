// The tests of the fourth round of the traced path (13 October 2026): the hops of a chain as sub-steps 9a, 9b, 9c and 9d, the styles of
// the segments (solid, dashed, dotted) with their legend, the finding marker on its waypoint with its label, and the route strip that
// does not scroll.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionTrace } from "@shared/types";
import { PathLegend } from "../PathLegend";
import { RouteStrip } from "../RouteStrip";
import { agentPath, buildPath, chainSteps, hopLine, livePlatePicks, markerSpots, segmentStyle, MISSING_PREFIX } from "./path";
import { RUN_0001, RUN_0012, link, promptSteps, volumeFor, worldOf } from "./pathfixtures";

const instr = { id: "instr:compare-dates-v1", label: "Compare date and place of birth (version 1)" };
const northgate = [
  link("implementsClause", instr.id, "clause:ng-compare-identifiers", "ratified", { to_label: "Comparison of identifiers", clause_ref: "FCP 8.2" }),
  link("realises", "clause:ng-compare-identifiers", "control:ng-alert-assessment", "ratified", { to_label: "Assessment of each screening alert" }),
  link("satisfies", "control:ng-alert-assessment", "obligation:ng-assess-matches", "ratified", { to_label: "Tell a name match from a target match using the data on the list" }),
  link("expressedIn", "obligation:ng-assess-matches", "provision:ofsi-gg-2-2", "stated", { to_label: "OFSI general guidance 2.2" }),
  link("satisfies", "control:ng-alert-assessment", "obligation:ng-controls-procedures", "proposed", { to_label: "Maintain policies, controls and procedures against money laundering" }),
  link("expressedIn", "obligation:ng-controls-procedures", "provision:mlr-19", "stated", { to_label: "MLR 2017 regulation 19" }),
];

describe("the hops of a chain", () => {
  it("names each hop in plain words in one sentence", () => {
    const c = chainSteps(instr, northgate);
    expect(c.sentence).toBe(
      "Compare date and place of birth (version 1) implements clause FCP 8.2 Comparison of identifiers, which realises the control Assessment of each screening alert, which satisfies the obligation Tell a name match from a target match using the data on the list, which is expressed in OFSI general guidance 2.2",
    );
    expect(c.main).toEqual(["clause:ng-compare-identifiers", "control:ng-alert-assessment", "obligation:ng-assess-matches", "provision:ofsi-gg-2-2"]);
    // the second obligation and its provision are hops of their own that branch off the main line
    expect(c.hops.map((h) => `${h.letter}:${h.kind}:${h.main}`)).toEqual(["a:clause:true", "b:control:true", "c:obligation:true", "d:provision:true", "e:obligation:false", "f:provision:false"]);
    expect(c.extra.map((e) => e.id)).toEqual(["obligation:ng-controls-procedures", "provision:mlr-19"]);
    expect(c.extra[0].via).toBe("control:ng-alert-assessment");
  });

  it("gives each hop a line of the panel with the status of its link", () => {
    const c = chainSteps(instr, northgate);
    expect(hopLine(9, c.hops[0])).toBe("9a Policy clause FCP 8.2 Comparison of identifiers, ratified");
    expect(hopLine(9, c.hops[1])).toBe("9b Control Assessment of each screening alert, ratified");
    expect(hopLine(9, c.hops[3])).toBe("9d Provision OFSI general guidance 2.2, stated");
    expect(hopLine(9, c.hops[4])).toBe("9e Obligation Maintain policies, controls and procedures against money laundering, proposed");
  });

  it("visits the clause, the control, the obligation and the provision of step 9 in order, as sub-steps a to d", () => {
    const steps = agentPath(RUN_0001(), () => true).steps;
    const step = steps.find((s) => s.kind === "run.chain") as (typeof steps)[number];
    const g = buildPath(steps, worldOf, { volume: volumeFor() });
    const own = g.subs.filter((s) => s.step === step.n);
    expect(own.map((s) => `${s.letter}:${s.hop.kind}`)).toEqual(["a:clause", "b:control", "c:obligation", "d:provision"]);
    // the line visits them in that order: the instruction is the waypoint, and the others are the knots of the step, in order
    expect(g.knots.filter((k) => k.step === step.n).map((k) => k.id)).toEqual(own.map((s) => s.id));
    expect(step.activation.filter((a) => a.hop === 0).map((a) => a.id).slice(1)).toEqual(own.map((s) => s.id));
    // the head has a slot for the entry to the step, one for each hop and one back to the instruction (13 October 2026)
    expect(g.ranges[step.n - 1].slots.length).toBe(own.length + 2);
    expect(own.every((s) => s.at === g.waypoints[step.n - 1].at)).toBe(true);
  });

  it("numbers the sub-steps of every chain step with its own step number", () => {
    const steps = agentPath(RUN_0001(), () => true).steps;
    const g = buildPath(steps, worldOf, { volume: volumeFor() });
    const chains = steps.filter((s) => s.kind === "run.chain");
    expect(chains).toHaveLength(6);
    for (const c of chains) expect(g.subs.filter((s) => s.step === c.n).map((s) => s.letter)).toEqual(["a", "b", "c", "d"]);
  });

  it("ends a chain with a missing link in a dashed stub with the words no link", () => {
    const steps = agentPath(RUN_0012(), () => true).steps;
    const broken = steps.filter((s) => s.kind === "run.chain").find((s) => s.hops?.some((h) => h.status === "missing"));
    expect(broken).toBeDefined();
    const b = broken as (typeof steps)[number];
    expect(b.sentence).toContain(", which has no link to a provision");
    const missing = (b.hops ?? []).filter((h) => h.status === "missing");
    expect(missing).toHaveLength(1);
    expect(hopLine(b.n, missing[0])).toMatch(/^\d+d No link to a provision$/);
    expect(b.activation.some((a) => a.id.startsWith(MISSING_PREFIX))).toBe(true);
    const g = buildPath(steps, worldOf, { volume: volumeFor() });
    const stubs = g.stubs.filter((s) => s.step === b.n);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].label).toBe("no link");
    // the hops before the gap are still sub-steps, and the gap is not
    expect(g.subs.filter((s) => s.step === b.n).map((s) => s.letter)).toEqual(["a", "b", "c"]);
  });

  it("says what was looked for when no policy clause is mapped", () => {
    const c = chainSteps(instr, [link("implementsClause", instr.id, "", "missing")]);
    expect(c.sentence).toBe("Looked for the policy clause of Compare date and place of birth (version 1). No policy clause is mapped to this instruction");
    expect(c.hops).toHaveLength(1);
    expect(chainSteps(instr, []).sentence).toContain("No policy clause is mapped to this instruction");
    expect(hopLine(9, c.hops[0])).toBe("9a No link to a policy clause");
  });

  it("keeps the sentence of a plain chain free of dashes, semicolons and contractions", () => {
    const text = [chainSteps(instr, northgate).sentence, chainSteps(instr, []).sentence, ...northgate.map((_, i) => hopLine(9, chainSteps(instr, northgate).hops[i] ?? chainSteps(instr, northgate).hops[0]))].join(" ");
    expect(text).not.toMatch(/[;]|\s-\s|–|—|n't|'s\b/);
  });
});

describe("the style of each segment", () => {
  it("is solid for recorded, dashed for stated by the agent with its cause unverified, and dotted for loaded", () => {
    expect(segmentStyle("recorded")).toBe("solid");
    expect(segmentStyle("stated by the agent, cause unverified")).toBe("dashed");
    expect(segmentStyle("loaded")).toBe("dotted");
    expect(segmentStyle(undefined)).toBe("solid");
  });

  it("gives every piece of the line the style of the step that it enters", () => {
    // the alert node stands before the instructions are loaded, so that the loaded step has a segment of its own
    const path = agentPath(RUN_0001(), () => true, () => "case:AL-2026-0001");
    const g = buildPath(path.steps, worldOf, { volume: volumeFor() });
    expect(g.line.style).toHaveLength(g.line.count);
    const seen = new Map<string, Set<number>>();
    for (let i = 0; i < g.line.count; i += 1) {
      const step = path.steps[g.line.step[i] - 1];
      const key = step.label ?? "";
      seen.set(key, (seen.get(key) ?? new Set()).add(g.line.style[i]));
    }
    expect([...(seen.get("recorded") ?? [])]).toEqual([0]);
    expect([...(seen.get("stated by the agent, cause unverified") ?? [])]).toEqual([1]);
    expect([...(seen.get("loaded") ?? [])]).toEqual([2]);
    // all three kinds occur in a run, and a prompt has none but solid
    expect(seen.size).toBe(3);
    const prompt = buildPath(promptSteps(12), worldOf, { volume: volumeFor() });
    expect([...new Set(prompt.line.style)]).toEqual([0]);
  });

  it("is named by a legend of three lines in the panel", () => {
    const html = renderToStaticMarkup(createElement(PathLegend));
    expect(html).toContain("Solid line for recorded");
    expect(html).toContain("Dashed line for stated by the agent, cause unverified");
    expect(html).toContain("Dotted line for loaded");
    expect(html).toContain("stroke-dasharray");
  });
});

describe("a finding on the path", () => {
  const finding = { check: "O04", severity: "violation" as const, node: "prov:shared", message: "no instruction cited", proof: null };
  const trace = (): DecisionTrace => ({ ...RUN_0012(), findings: [finding] });

  it("stands on the waypoint of the step that carries it, and not on the node of the finding", () => {
    const path = agentPath(trace(), () => true);
    const g = buildPath(path.steps, worldOf, { volume: volumeFor() });
    const spots = markerSpots(path.steps, (n) => g.waypoints[n - 1]?.pos);
    expect(spots).toHaveLength(1);
    const carrier = path.steps.findIndex((s) => s.markers?.length) + 1;
    expect(spots[0]?.step).toBe(carrier);
    expect(spots[0]?.pos).toEqual(g.waypoints[carrier - 1]?.pos);
    expect(spots[0]?.pos).not.toEqual(worldOf(finding.node)?.pos);
  });

  it("keeps the label of the step with a finding once the head has reached it, while another step plays", () => {
    const reached = (n: number) => n <= 7;
    expect(livePlatePicks(3, [5], reached)).toEqual([3, 5]);
    expect(livePlatePicks(3, [9], reached)).toEqual([3]);
    expect(livePlatePicks(5, [5], reached)).toEqual([5]);
    expect(livePlatePicks(0, [5], reached)).toEqual([5]);
  });
});

describe("the route strip", () => {
  const runs = Array.from({ length: 14 }, (_, i) => ({ region: (i % 2 ? "memory" : "prefrontal") as "memory" | "prefrontal", steps: [i + 1] }));

  it("wraps in an area of its own and does not scroll", () => {
    const html = renderToStaticMarkup(createElement(RouteStrip, { runs, findings: 0, onPick: () => undefined }));
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain("overflow");
    expect(html).not.toMatch(/max-h-/);
    expect((html.match(/data-run=/g) ?? []).length).toBe(14);
  });
});

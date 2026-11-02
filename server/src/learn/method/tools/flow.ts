// The tools that move a session between phases and that run practice: plan_init,
// probe_done, problem and conclude. Result text echoes nothing that the model
// just wrote. The full data goes into details for the window.
import { Type } from "typebox";
import type { PlanTree } from "../../../../../shared/learn/index.ts";
import { defineTool, type AnyTool } from "../../runtime/tools/define.ts";
import { danglingQuestions } from "../../runtime/scans.ts";
import type { MethodDeps } from "../deps.ts";
import { describeProblems, parsePlan } from "../mermaid.ts";
import { createPlanTree } from "../plan-tree.ts";
import { accepted, dropEmptyTarget, normaliseTargets, problemsText, refused, type TurnState } from "./state.ts";

type Args = Record<string, unknown>;

export const PROBE_HANDOFF_ACK = "The assessment is recorded.";

/** plan_init replaces the whole map. Success returns only the valid identifiers and a reminder. */
export function planInitTool(state: TurnState, deps: Pick<MethodDeps, "store">): AnyTool {
  return defineTool({
    name: "plan_init",
    label: "Draw the plan map",
    description:
      "Replaces the whole dependency map with one diagram block. Nodes are lower case slugs, as id, id[title] or id(\"title\"). The arrows --> , ==> and -.-> all mean that the first node is a prerequisite of the second. Subgraphs, styles and classes are refused. A map of 5 to 15 nodes with one reasoning step for each node is usual. Every problem is reported in one reply.\n\nExample call:\n" +
      JSON.stringify({ mermaid: "graph TD\n  parts[\"Parts of a whole\"] --> common-denominator[\"Common denominator\"]\n  common-denominator --> add-fractions[\"Adding fractions\"]" }),
    parameters: Type.Object({ mermaid: Type.String({ description: "A single graph block." }) }),
    execute: async (_id: string, params: Args) => {
      const parsed = parsePlan(typeof params.mermaid === "string" ? params.mermaid : "");
      if (!parsed.ok) return refused(`The map was not saved. Fix every problem and call plan_init again.\n${describeProblems(parsed.problems)}`);
      const previous: PlanTree | undefined = state.record().tree;
      const built = createPlanTree(parsed.plan.nodes, parsed.plan.edges, (previous?.version ?? 0) + 1);
      if (!built.ok) return refused(`The map was not saved. Fix every problem and call plan_init again.\n${problemsText(built.problems)}`);
      deps.store.setTree(state.sessionId, built.tree);
      const ids = built.tree.nodes.map((n) => n.id);
      return accepted(
        `The map is saved as version ${built.tree.version}. The valid node ids are ${ids.join(", ")}. These are now the only valid values for nodeId.`,
        { ok: true, tree: built.tree },
      );
    },
  });
}

/** probe_done is the seam between the prober and the teacher. It succeeds once, and never while a question is open. */
export function probeDoneTool(state: TurnState): AnyTool {
  return defineTool({
    name: "probe_done",
    label: "Finish the probe",
    description:
      "Files the assessment of the learner and hands the session to the teacher. It is refused while a question is open and after the first success. Give one entry for each strand, written from the evidence.",
    parameters: Type.Object({
      assessment: Type.Object({
        strands: Type.Array(Type.Object({ strand: Type.String(), assessment: Type.String() }), { minItems: 1 }),
        summary: Type.Optional(Type.String()),
      }),
    }),
    execute: async (_id: string, params: Args) => {
      if (state.probeDone) return refused("The probe is already concluded. It can be concluded once only. Continue with the next step.");
      if (state.posed || danglingQuestions(state.record().messages).length > 0) {
        return refused("A question is still open. Wait for the learner to answer it before concluding the probe.");
      }
      const assessment = params.assessment as { strands?: { strand?: unknown; assessment?: unknown }[] } | undefined;
      const strands = Array.isArray(assessment?.strands) ? assessment.strands.filter((s) => typeof s?.strand === "string" && s.strand.trim() && typeof s?.assessment === "string" && s.assessment.trim()) : [];
      if (strands.length === 0) return refused("The assessment needs at least one strand with a name and a reading of the learner on it.");
      state.probeDone = true;
      return accepted(PROBE_HANDOFF_ACK, { ok: true }, true);
    },
  });
}

const MODES = ["recall", "discrimination", "composition"] as const;
const OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered"] as const;
const RUNGS = ["R0", "R1", "R2", "R3", "R4", "R5"] as const;
const MISS = ["cue", "discrimination", "execution", "careless", "structural"] as const;
const literals = <T extends readonly string[]>(values: T) => Type.Union(values.map((v) => Type.Literal(v)) as never);

/** problem poses one problem and ends the turn. Only one problem may be active. */
export function problemTool(state: TurnState): AnyTool {
  return defineTool({
    name: "problem",
    label: "Pose a practice problem",
    description:
      "Poses one practice problem. The model solution is committed now, kept hidden and shown unchanged when the problem concludes. Only one problem may be active. Leave the target out when it is not known.\n\nExample call:\n" +
      JSON.stringify({
        statement: "A recipe needs $\\frac{1}{2}$ cup of milk and $\\frac{1}{3}$ cup of cream. How much liquid is that?",
        mode: "recall",
        modelSolution: "The fractions share the denominator 6, so $\\frac{3}{6} + \\frac{2}{6} = \\frac{5}{6}$ of a cup.",
      }),
    parameters: Type.Object({
      statement: Type.String({ description: "The problem, self contained, never announcing which proposition it tests." }),
      mode: literals(MODES),
      modelSolution: Type.String({ description: "The full worked solution, solved before posing." }),
      target: Type.Optional(Type.Array(Type.String(), { description: "Identifiers or names of the propositions tested. Leaving it out always works." })),
    }),
    prepareArguments: dropEmptyTarget as never,
    execute: async (id: string, params: Args) => {
      if (state.problem) return refused("A problem is already active. Conclude it with the conclude tool before posing another.");
      const problems: string[] = [];
      if (typeof params.statement !== "string" || !params.statement.trim()) problems.push("The statement is empty. Write the problem.");
      if (typeof params.modelSolution !== "string" || !params.modelSolution.trim()) problems.push("The model solution is empty. Solve the problem first and commit the solution.");
      if (!MODES.includes(params.mode as (typeof MODES)[number])) problems.push(`The mode must be one of ${MODES.join(", ")}.`);
      const targets = normaliseTargets(params.target, state);
      if (!targets.ok) problems.push(targets.error);
      if (problems.length || !targets.ok) return refused(problemsText(problems));
      state.problem = { callId: id, modelSolution: String(params.modelSolution), target: targets.ids };
      return accepted("The problem is shown to the learner. End your turn now and wait for the learner.", { ok: true }, true);
    },
  });
}

/** conclude closes the active problem. A pause follows, and the next problem waits for the learner to ask for it. */
export function concludeTool(state: TurnState): AnyTool {
  return defineTool({
    name: "conclude",
    label: "Conclude the problem",
    description:
      "Closes the active problem and reveals the committed model solution. The outcome is solved, solvedWithHints, movedOn or surrendered. The rung is the highest hint rung used, or null. The miss class is set only after a miss. After the call, a pause follows.\n\nExample call:\n" +
      JSON.stringify({ outcome: "solved", verdict: "Correct. The common denominator was found without a hint.", rung: null, missClass: null, retest: false }),
    parameters: Type.Object({
      outcome: literals(OUTCOMES),
      verdict: Type.String({ description: "A plain verdict on the attempt." }),
      rung: Type.Optional(Type.Union([literals(RUNGS), Type.Null()])),
      missClass: Type.Optional(Type.Union([literals(MISS), Type.Null()])),
      retest: Type.Optional(Type.Boolean({ description: "True when the problem must be tested again later in a fresh surface." })),
    }),
    execute: async (_id: string, params: Args) => {
      const open = state.problem;
      if (!open) return refused("No problem is active, so there is nothing to conclude. Pose a problem first.");
      const problems: string[] = [];
      if (!OUTCOMES.includes(params.outcome as (typeof OUTCOMES)[number])) problems.push(`The outcome must be one of ${OUTCOMES.join(", ")}. The system writes dismissed itself.`);
      if (typeof params.verdict !== "string" || !params.verdict.trim()) problems.push("The verdict is empty. Write a plain verdict.");
      if (params.rung != null && !RUNGS.includes(params.rung as (typeof RUNGS)[number])) problems.push(`The rung must be one of ${RUNGS.join(", ")} or null.`);
      if (params.missClass != null && !MISS.includes(params.missClass as (typeof MISS)[number])) problems.push(`The miss class must be one of ${MISS.join(", ")} or null.`);
      if (problems.length) return refused(problemsText(problems));
      state.problem = null;
      return accepted(
        "The problem is concluded and the model solution is shown to the learner. A pause begins. Answer questions about this problem and pose no new problem until the learner asks for the next one.",
        { ok: true, outcome: params.outcome, problemCallId: open.callId, modelSolution: open.modelSolution, target: open.target },
      );
    },
  });
}

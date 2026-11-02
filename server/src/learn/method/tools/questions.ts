// The question tools probe, recall, quiz, explain and ask_user_question. Their
// descriptions carry mechanics only, and the craft of a good question lives in
// the shared prompt fragments. Each graded tool ends with one complete example
// call, which also shows how mathematics is escaped inside JSON.
//
// A call is checked at the boundary and every problem comes back in one reply,
// so that the model corrects them together. A clean call returns a placeholder
// that ends the run and is not saved, so that the question stays open in the
// record until the learner answers. One question is allowed for each turn.
import { Type } from "typebox";
import { defineTool, type AnyTool } from "../../runtime/tools/define.ts";
import { authorChoice, authorRecall, normaliseOptions } from "../questions.ts";
import { dropEmptyTarget, normaliseTargets, posedPlaceholder, problemsText, refused, type TurnState } from "./state.ts";

const OptionSchema = Type.Union([Type.String(), Type.Object({ label: Type.String(), value: Type.Optional(Type.String()) })]);
const AskOptionSchema = Type.Union([Type.String(), Type.Object({ label: Type.String(), value: Type.Optional(Type.String()), description: Type.Optional(Type.String()) })]);
const AnswerSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

const targetField = () =>
  Type.Optional(Type.Array(Type.String(), { description: "Identifiers or names of the propositions that this question tests. Leave it out when unsure. Leaving it out always works." }));

const choiceFields = () => ({
  question: Type.String({ description: "The question text. Markdown and LaTeX are allowed." }),
  options: Type.Array(OptionSchema, { description: "At least two options. Each has a label and an optional value that defaults to the label." }),
  multiSelect: Type.Optional(Type.Boolean({ description: "True when more than one option is correct." })),
  details: Type.Optional(Type.String({ description: "Optional material that the learner needs to read before answering." })),
  // the reasoning comes before the pick, so that the explanation is written before the answer is committed
  explanation: Type.String({ description: "Why the correct option is correct and why each other option is wrong. The learner sees it after answering." }),
  correctAnswer: Type.Union([AnswerSchema], { description: "The value of the correct option, or a list of values when multiSelect is true." }),
  target: targetField(),
});

const recallFields = () => ({
  question: Type.String({ description: "The question text. The learner answers in their own words." }),
  details: Type.Optional(Type.String({ description: "Optional material that the learner needs to read before answering." })),
  correctAnswer: Type.String({ description: "The full correct answer with its reasoning, written before the learner sees the question and never changed afterwards." }),
  target: targetField(),
});

const typeField = () => Type.String({ description: 'Either "predict" or "check". Use the exact word.' });
const nodeField = () => Type.String({ description: "The identifier of the plan node that this question is about." });

const example = (args: Record<string, unknown>): string => `\n\nExample call:\n${JSON.stringify(args)}`;

const choiceExample = {
  question: "What is the value of $\\frac{1}{2} + \\frac{1}{3}$?",
  options: [
    { label: "$\\frac{5}{6}$", value: "a" },
    { label: "$\\frac{2}{5}$", value: "b" },
    { label: "$\\frac{1}{5}$", value: "c" },
  ],
  explanation: "A common denominator of 6 gives $\\frac{3}{6} + \\frac{2}{6} = \\frac{5}{6}$. Adding the numerators and the denominators gives $\\frac{2}{5}$, which is the usual error.",
  correctAnswer: "a",
};
const recallExample = {
  question: "Why does adding the denominators give the wrong sum of two fractions?",
  correctAnswer: "A denominator names the size of the part. Parts of different sizes cannot be counted together until they are cut to one size, so the sum needs a common denominator.",
};

export const PROBE_EXAMPLE = choiceExample;
export const QUIZ_EXAMPLE = { type: "check", nodeId: "common-denominator", ...choiceExample };
export const RECALL_EXAMPLE = recallExample;
export const EXPLAIN_EXAMPLE = { type: "check", nodeId: "common-denominator", ...recallExample };

type Args = Record<string, unknown>;

/** The node identifiers of the live plan, or null when no plan exists. */
function planIds(state: TurnState): string[] | null {
  const tree = state.record().tree;
  return tree && tree.nodes.length ? tree.nodes.map((n) => n.id) : null;
}

function checkNode(state: TurnState, raw: unknown): string | null {
  const ids = planIds(state);
  if (!ids) return "There is no plan yet, so a teach question cannot name a node. Call plan_init first, or use ask_user_question for a question that is off the plan.";
  if (typeof raw !== "string" || !raw.trim()) return `The nodeId is missing. Valid node ids: ${ids.join(", ")}.`;
  if (!ids.includes(raw)) return `The node "${raw}" is not in the plan. Valid node ids: ${ids.join(", ")}.`;
  return null;
}

const secondQuestion = () =>
  refused("A question is already posed in this turn. Ask one question for each turn and end the turn. The learner answers before the next one.", true);

function pose(state: TurnState, args: Args, check: (problems: string[]) => void): ReturnType<typeof posedPlaceholder> | ReturnType<typeof refused> {
  if (state.posed) return secondQuestion();
  const problems: string[] = [];
  check(problems);
  const targets = normaliseTargets(args.target, state);
  if (!targets.ok) problems.push(targets.error);
  if (problems.length) return refused(problemsText(problems));
  state.posed = true;
  return posedPlaceholder("The question is shown to the learner. End your turn now and wait for the answer.");
}

export function buildQuestionTools(state: TurnState): Record<"probe" | "recall" | "quiz" | "explain" | "ask", AnyTool> {
  const probe = defineTool({
    name: "probe",
    label: "Ask a graded question",
    description: `Poses one graded multiple choice question to measure what the learner holds. The system adds a not known option.${example(choiceExample)}`,
    parameters: Type.Object(choiceFields()),
    prepareArguments: dropEmptyTarget as never,
    execute: async (_id: string, params: Args) =>
      pose(state, params, (problems) => {
        const authored = authorChoice(params);
        if (!authored.ok) problems.push(authored.error);
        else if (typeof params.explanation !== "string" || !params.explanation.trim()) problems.push("The explanation is empty. Explain why the correct option is correct.");
      }),
  });
  const recall = defineTool({
    name: "recall",
    label: "Ask a free recall question",
    description: `Poses one free recall question. The learner answers in their own words and the answer is graded by you against the correct answer that you commit now.${example(recallExample)}`,
    parameters: Type.Object(recallFields()),
    prepareArguments: dropEmptyTarget as never,
    execute: async (_id: string, params: Args) =>
      pose(state, params, (problems) => {
        const authored = authorRecall(params);
        if (!authored.ok) problems.push(authored.error);
      }),
  });
  const quiz = defineTool({
    name: "quiz",
    label: "Ask a teaching question",
    description: `Poses one graded multiple choice question about one node of the plan. The type is predict before a step is taught and check after it. The system adds a not known option.${example(QUIZ_EXAMPLE)}`,
    parameters: Type.Object({ type: typeField(), nodeId: nodeField(), ...choiceFields() }),
    prepareArguments: dropEmptyTarget as never,
    execute: async (_id: string, params: Args) =>
      pose(state, params, (problems) => {
        const node = checkNode(state, params.nodeId);
        if (node) problems.push(node);
        const authored = authorChoice(params);
        if (!authored.ok) problems.push(authored.error);
        else if (typeof params.explanation !== "string" || !params.explanation.trim()) problems.push("The explanation is empty. Explain why the correct option is correct.");
      }),
  });
  const explain = defineTool({
    name: "explain",
    label: "Ask a teaching recall question",
    description: `Poses one free recall question about one node of the plan. The type is predict before a step is taught and check after it. You commit the full correct answer now and grade the learner's words against it.${example(EXPLAIN_EXAMPLE)}`,
    parameters: Type.Object({ type: typeField(), nodeId: nodeField(), ...recallFields() }),
    prepareArguments: dropEmptyTarget as never,
    execute: async (_id: string, params: Args) =>
      pose(state, params, (problems) => {
        const node = checkNode(state, params.nodeId);
        if (node) problems.push(node);
        const authored = authorRecall(params);
        if (!authored.ok) problems.push(authored.error);
      }),
  });
  const ask = defineTool({
    name: "ask_user_question",
    label: "Ask an open question",
    description:
      "Poses one question that has no right answer, such as a goal, a preference or a direction. It is never graded. Give options with an optional description, or leave the options out for a written answer. The system adds a not known option and an Other entry.",
    parameters: Type.Object({
      question: Type.String({ description: "The question text." }),
      details: Type.Optional(Type.String({ description: "Optional context." })),
      options: Type.Optional(Type.Array(AskOptionSchema)),
      multiSelect: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id: string, params: Args) => {
      if (state.posed) return secondQuestion();
      const problems: string[] = [];
      if (typeof params.question !== "string" || !params.question.trim()) problems.push("The question is empty. Write the question text.");
      if (params.options !== undefined) {
        const normalised = normaliseOptions(params.options);
        if (!normalised.ok) problems.push(normalised.error);
        else if (normalised.options.length === 1) problems.push("Give at least two options, or leave the options out.");
      }
      if (problems.length) return refused(problemsText(problems));
      state.posed = true;
      return posedPlaceholder("The question is shown to the learner. End your turn now and wait for the answer.");
    },
  });
  return { probe, recall, quiz, explain, ask };
}

/** The prober: free recall in place of multiple choice when the explain switch is on. */
export function proberQuestionTools(state: TurnState, switches: { explain: boolean }): AnyTool[] {
  const t = buildQuestionTools(state);
  return switches.explain ? [t.recall, t.ask] : [t.probe, t.ask];
}

/** The teacher: the same switch, with the node and the role on every graded question. */
export function teacherQuestionTools(state: TurnState, switches: { explain: boolean }): AnyTool[] {
  const t = buildQuestionTools(state);
  return switches.explain ? [t.explain, t.ask] : [t.quiz, t.ask];
}

// One scripted run through the runtime service with the method composer, the
// grader and the callbacks: measure, plan, teach and practise. A scripted model
// of the library plays the agents, so no network model is called.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AnswerDetails, OutcomeLine } from "../../../../shared/learn/index.ts";
import { readOutcomes } from "./outcomes.ts";
import { derivePosition } from "./plan-tree.ts";
import { makeMethodEnv, type MethodEnv } from "./support.ts";
import { until } from "../runtime/support.ts";

const names = { n_aaa: "Common denominator", n_bbb: "Adding fractions" };
const opts = [{ label: "5/6", value: "a" }, { label: "2/5", value: "b" }];
const choice = (extra: Record<string, unknown> = {}) => ({ question: "What is 1/2 + 1/3?", options: opts, explanation: "Common denominator 6.", correctAnswer: "a", ...extra });
const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const callWithText = (text: string, name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxText(text), fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });

const send = async (env: MethodEnv, id: string, input: Parameters<MethodEnv["service"]["input"]>[1]) => {
  const out = await env.service.input(id, input);
  await env.service.turns.whenSettled(id);
  return out;
};
const record = (env: MethodEnv, id: string) => env.service.store.get(id)!;
const answerOf = (env: MethodEnv, id: string, callId: string) =>
  (record(env, id).messages.find((m) => m.role === "toolResult" && m.toolCallId === callId) as { details: unknown }).details as AnswerDetails;

describe("a full measure, plan, teach and practise run", () => {
  it("produces the expected record, phases, plan blocks and outcomes", async () => {
    const env = makeMethodEnv({ names });
    const session = env.service.create({});
    const id = session.id;
    const phase = () => env.service.list().find((s) => s.id === id)!.phase;
    env.faux.setResponses([
      // 1. the prober poses a graded question with a target given by name
      call("probe", choice({ target: ["common denominator"] }), "c_probe1"),
      // 2. after the answer, the prober files the assessment
      call("probe_done", { assessment: { strands: [{ strand: "fractions", assessment: "Floor at halves. Ceiling at unlike denominators." }], summary: "Goal: add fractions." } }, "c_done"),
      // 3. the teacher presents the plan and draws the map, then ends with a short line
      callWithText("The approach: parts first, then a common denominator, then the sum.", "plan_init", { mermaid: 'graph TD\n  parts["Parts of a whole"] --> common-denominator["Common denominator"]\n  common-denominator --> add-fractions["Adding fractions"]' }, "c_plan"),
      fauxAssistantMessage([fauxText("Tell me if the order suits you.")]),
      // 4. after a go ahead, a prediction about the first node
      call("quiz", { type: "predict", nodeId: "parts", ...choice() }, "c_pred"),
      // 5. after the prediction, teaching and a check on the second node with a target
      callWithText("The prediction resolves like this.", "quiz", { type: "check", nodeId: "common-denominator", ...choice({ target: ["n_aaa"] }) }, "c_check"),
      // 6. a wrong check later, which ends the teaching in this script
      fauxAssistantMessage([fauxText("The step landed.")]),
    ]);

    // measure
    await send(env, id, { type: "text", text: "Teach me to add fractions" });
    expect(phase()).toBe("probe");
    expect(env.service.list()[0].pendingQuestion).toBe(true);
    expect(record(env, id).messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    await send(env, id, { type: "answer", toolCallId: "c_probe1", answer: { values: ["a"], confidence: 90, thinking: "Common denominator is 6." } });
    const probeAnswer = answerOf(env, id, "c_probe1");
    expect(probeAnswer).toMatchObject({ kind: "quiz", tool: "probe", correct: true, confidence: 90, target: ["n_aaa"] });
    expect(probeAnswer.correctIndices).toHaveLength(1);
    // the seam: probe_done succeeded once, the handoff marker is saved and the wake was asked for
    expect(record(env, id).messages.some((m) => m.role === "custom" && m.customType === "probe-handoff" && m.id === `steer_probe_${id}`)).toBe(true);
    expect(env.wakes).toEqual([id]);
    expect(phase()).toBe("plan");

    // plan: the merge wires the wake to a continue input, and the teacher takes over
    await send(env, id, { type: "continue" });
    const afterPlan = record(env, id);
    expect(afterPlan.tree?.version).toBe(1);
    expect(afterPlan.tree?.nodes.map((n) => n.id)).toEqual(["parts", "common-denominator", "add-fractions"]);
    const blocks = afterPlan.messages.filter((m) => m.role === "custom" && m.customType === "plan-block");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { details: unknown }).details).toMatchObject({ planCallId: "c_plan", kind: "full", current: null });
    expect(((blocks[0] as { details: unknown }).details as { nodes: { status: string }[] }).nodes.every((n) => n.status === "upcoming")).toBe(true);
    expect(phase()).toBe("plan");

    // teach: the teacher asks a tagged prediction and then a tagged check
    await send(env, id, { type: "text", text: "Go ahead" });
    expect(phase()).toBe("teach");
    await send(env, id, { type: "answer", toolCallId: "c_pred", answer: { values: ["b"], confidence: 70, thinking: "Add across." } });
    expect(answerOf(env, id, "c_pred")).toMatchObject({ questionType: "predict", correct: false, confidence: 70 });
    await send(env, id, { type: "answer", toolCallId: "c_check", answer: { values: ["a"], confidence: 90, readingThinking: "That makes sense." } });
    const check = answerOf(env, id, "c_check");
    expect(check).toMatchObject({ questionType: "check", correct: true, readingThinking: "That makes sense." });

    const final = record(env, id);
    const position = derivePosition(final.messages, final.tree);
    expect(position.current).toBe("common-denominator");
    expect(position.visited).toEqual(["parts"]);

    // the plan block of a later read derives against the saved record
    expect(final.messages.filter((m) => m.role === "custom" && m.customType === "plan-block")).toHaveLength(1);

    // outcomes: the probe answer and the tagged check have targets, the untagged prediction has none
    const lines = readOutcomes(env.dir);
    expect(lines.map((l) => l.toolCallId)).toEqual(["c_probe1", "c_check"]);
    expect(lines[0]).toMatchObject({ tool: "probe", source: "choice", planNode: null, target: ["n_aaa"], correct: true, confidence: 90, rung: null, missClass: null, sessionId: id });
    expect(lines[0].thinkingChars).toBe("Common denominator is 6.".length);
    expect(lines[1]).toMatchObject({ tool: "quiz", planNode: "common-denominator", correct: true, confidence: 90 });
    expect(env.answers.map((a) => a.key)).toEqual(["c_probe1", "c_check"]);
  });

  it("runs a practice session to its conclusion and writes the practice outcome", async () => {
    const env = makeMethodEnv({ names });
    const session = env.service.create({ kind: "practice" });
    const id = session.id;
    env.faux.setResponses([
      call("problem", { statement: "Add 1/2 and 1/3.", mode: "recall", modelSolution: "5/6", target: ["common denominator"] }, "c_prob1"),
      // the learner submits thinking, and the agent concludes in the same turn
      call("conclude", { outcome: "solvedWithHints", verdict: "Correct after a hint.", rung: "R1", missClass: null, retest: true }, "c_conc1"),
      fauxAssistantMessage([fauxText("That closes the problem. Ask when you want the next one.")]),
    ]);
    await send(env, id, { type: "text", text: "Practise common denominators" });
    // an open problem counts as pending, and it needs no model call to reopen
    expect(env.service.list()[0].pendingQuestion).toBe(true);
    await send(env, id, { type: "thinking", problemCallId: "c_prob1", text: "Use sixths." });
    const concluded = record(env, id);
    expect((concluded.messages.find((m) => m.role === "toolResult" && m.toolName === "conclude") as { details?: unknown }).details).toMatchObject({ ok: true, outcome: "solvedWithHints", modelSolution: "5/6" });
    const lines = readOutcomes(env.dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: "problem",
      source: "practice",
      toolCallId: "c_conc1",
      target: ["n_aaa"],
      outcome: "solvedWithHints",
      rung: "R1",
      retest: true,
      correct: true,
      confidence: null,
      planNode: null,
      thinkingChars: "Use sixths.".length,
    });
    expect(env.answers.at(0)).toMatchObject({ tool: "problem", correct: true, target: ["n_aaa"] });
  });

  it("refuses a second problem while one is active, inside a real turn", async () => {
    const env = makeMethodEnv({ names });
    const id = env.service.create({ kind: "practice" }).id;
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("problem", { statement: "One.", mode: "recall", modelSolution: "1" }, { id: "c_p1" }), fauxToolCall("problem", { statement: "Two.", mode: "recall", modelSolution: "2" }, { id: "c_p2" })], { stopReason: "toolUse" }),
    ]);
    await send(env, id, { type: "text", text: "Practise" });
    const results = record(env, id).messages.filter((m) => m.role === "toolResult");
    expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([["c_p1", false], ["c_p2", true]]);
  });

  it("answers a dismissed problem with the outcome dismissed and a null verdict", async () => {
    const env = makeMethodEnv({ names });
    const id = env.service.create({ kind: "practice" }).id;
    env.faux.setResponses([
      call("problem", { statement: "One.", mode: "recall", modelSolution: "1", target: ["n_aaa"] }, "c_p1"),
      fauxAssistantMessage([fauxText("Understood.")]),
    ]);
    await send(env, id, { type: "text", text: "Practise" });
    env.service.turns.dismiss(id, { problemCallId: "c_p1" });
    // the next text input adds the synthesised conclusion before the learner's message
    await send(env, id, { type: "text", text: "Never mind" });
    await until(() => readOutcomes(env.dir).length === 1);
    const line = readOutcomes(env.dir)[0] as OutcomeLine;
    expect(line).toMatchObject({ outcome: "dismissed", correct: null, target: ["n_aaa"], toolCallId: "c_p1~dismissed" });
  });

  it("uses the teacher tool set after the probe and the explain switch for free recall", async () => {
    const env = makeMethodEnv({ names });
    env.switches.tools = { explain: true, research: false };
    const id = env.service.create({}).id;
    const rec = () => record(env, id);
    const tools = env.method.composer.compose({ session: rec(), model: env.deps.models.forSession(rec()), record: rec }).tools.map((t) => t.name);
    expect(tools).toContain("recall");
    expect(tools).not.toContain("probe");
    expect(tools).not.toContain("research");
    expect(tools).toContain("pdf");
    expect(tools).toContain("probe_done");
    expect(tools).toContain("list_propositions");
    expect(tools).not.toContain("plan_init");
    expect(tools).not.toContain("send_to_user");
  });
});

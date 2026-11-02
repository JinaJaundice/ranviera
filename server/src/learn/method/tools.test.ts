import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { NativeMessage } from "../../../../shared/learn/index.ts";
import { assistantMsg, call, resultMsg, userMsg } from "../runtime/support.ts";
import { derivePosition } from "./plan-tree.ts";
import { phaseOf, phaseSpans } from "./phases.ts";
import { EXPLAIN_EXAMPLE, PROBE_EXAMPLE, QUIZ_EXAMPLE, RECALL_EXAMPLE, buildQuestionTools, proberQuestionTools, teacherQuestionTools } from "./tools/questions.ts";
import { concludeTool, planInitTool, probeDoneTool, problemTool } from "./tools/flow.ts";
import { pdfTool, researchTool, sendToUserTool } from "./tools/extras.ts";
import { endsRun, roleFor } from "./roles.ts";
import { newRecord, nameResolver, run, stateOf, textOf, treeOf } from "./support.ts";
import { healTool } from "../runtime/tools/heal.ts";

const quizArgs = (extra: Record<string, unknown> = {}) => ({
  type: "check",
  nodeId: "n1",
  question: "Which?",
  options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
  explanation: "Because.",
  correctAnswer: "a",
  ...extra,
});

describe("graded question tools", () => {
  it("rejects a correct answer that is not among the options and names the valid values (B-8-02)", async () => {
    const state = stateOf(newRecord([], treeOf("n1")));
    const r = await run(buildQuestionTools(state).quiz, quizArgs({ correctAnswer: "zzz" }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/matches no option/);
    expect(textOf(r)).toContain('"a", "b"');
    expect(state.posed).toBe(false);
  });

  it("rejects a node id that is not in the map and gives the valid slugs (B-8-17)", async () => {
    const state = stateOf(newRecord([], treeOf("n1", "n2")));
    const r = await run(buildQuestionTools(state).quiz, quizArgs({ nodeId: "elsewhere" }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/"elsewhere" is not in the plan/);
    expect(textOf(r)).toContain("n1, n2");
  });

  it("rejects a teach question before any plan exists and one with no node id", async () => {
    const none = stateOf(newRecord());
    expect(textOf(await run(buildQuestionTools(none).quiz, quizArgs()))).toMatch(/no plan yet/);
    const state = stateOf(newRecord([], treeOf("n1")));
    const { nodeId: _n, ...noNode } = quizArgs();
    void _n;
    expect(textOf(await run(buildQuestionTools(state).quiz, noNode))).toMatch(/nodeId is missing/);
  });

  it("reports every problem of one call in one reply", async () => {
    const state = stateOf(newRecord([], treeOf("n1")));
    const r = await run(buildQuestionTools(state).quiz, quizArgs({ nodeId: "x", correctAnswer: "zzz" }));
    expect(textOf(r)).toMatch(/1\. .*not in the plan/s);
    expect(textOf(r)).toMatch(/2\. .*matches no option/s);
  });

  it("returns an unsaved placeholder that ends the run, and allows one question for each turn (B-8-37 pattern)", async () => {
    const state = stateOf(newRecord([], treeOf("n1")));
    const tools = buildQuestionTools(state);
    const first = await run(tools.quiz, quizArgs());
    expect(first.isError).toBeUndefined();
    expect(first.details).toBeNull();
    expect(first.terminate).toBe(true);
    const second = await run(tools.quiz, quizArgs({ nodeId: "n1" }), "call_2");
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/one question for each turn/);
    // the open question tool counts as the same question
    const ask = await run(tools.ask, { question: "Which way?" }, "call_3");
    expect(ask.isError).toBe(true);
  });

  it("validates the target against the graph, and omitting it always works (B-8-39 pattern)", async () => {
    const targets = nameResolver({ n_aaa: "Common denominator" });
    const state = stateOf(newRecord([], treeOf("n1")), targets);
    const tools = buildQuestionTools(state);
    const unknown = await run(tools.quiz, quizArgs({ target: ["No such thing"] }));
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/Leave the target out/);
    expect(state.posed).toBe(false);
    const empty = await run(tools.quiz, quizArgs({ target: [] }));
    expect(empty.isError).toBeUndefined();
    const state2 = stateOf(newRecord([], treeOf("n1")), targets);
    const named = await run(buildQuestionTools(state2).quiz, quizArgs({ target: ["common denominator"] }));
    expect(named.isError).toBeUndefined();
    // with no resolver nothing is checked
    const open = stateOf(newRecord([], treeOf("n1")));
    expect((await run(buildQuestionTools(open).quiz, quizArgs({ target: ["whatever"] }))).isError).toBeUndefined();
  });

  it("puts the type and node first on a teach question and the explanation before the answer (B-8-01, B-8-15)", () => {
    const state = stateOf(newRecord());
    const t = buildQuestionTools(state);
    const keys = (tool: { parameters: unknown }) => Object.keys((tool.parameters as { properties: object }).properties);
    expect(keys(t.quiz).slice(0, 2)).toEqual(["type", "nodeId"]);
    expect(keys(t.explain).slice(0, 2)).toEqual(["type", "nodeId"]);
    const probeKeys = keys(t.probe);
    expect(probeKeys.indexOf("explanation")).toBeLessThan(probeKeys.indexOf("correctAnswer"));
    expect(probeKeys).not.toContain("nodeId");
    expect(probeKeys).not.toContain("type");
    expect(keys(t.recall)).not.toContain("nodeId");
  });

  it("carries a complete example that is valid for its own schema (B-8-19)", () => {
    const state = stateOf(newRecord());
    const t = buildQuestionTools(state);
    const cases: [keyof typeof t, Record<string, unknown>][] = [["probe", PROBE_EXAMPLE], ["quiz", QUIZ_EXAMPLE], ["recall", RECALL_EXAMPLE], ["explain", EXPLAIN_EXAMPLE]];
    for (const [name, example] of cases) {
      expect(Value.Check(t[name].parameters as never, example), name).toBe(true);
      expect(t[name].description).toContain(JSON.stringify(example));
    }
    expect(t.quiz.description).toContain("\\\\frac");
  });

  it("keeps doctrine out of the descriptions (B-8-23)", () => {
    const t = buildQuestionTools(stateOf(newRecord()));
    for (const tool of Object.values(t)) expect(tool.description).not.toMatch(/misconception|bias|Socratic/i);
  });

  it("heals a string encoded options list before validation (B-8-21)", async () => {
    const state = stateOf(newRecord([], treeOf("n1")));
    const tool = healTool(buildQuestionTools(state).quiz);
    const healed = tool.prepareArguments!(quizArgs({ options: JSON.stringify([{ label: "A", value: "a" }, { label: "B", value: "b" }]), multiSelect: "false" })) as { options: unknown; multiSelect: unknown };
    expect(Array.isArray(healed.options)).toBe(true);
    expect(healed.multiSelect).toBe(false);
    const dropped = tool.prepareArguments!(quizArgs({ target: [] })) as Record<string, unknown>;
    expect("target" in dropped).toBe(false);
  });

  it("arms free recall in place of multiple choice with the explain switch (B-8-20, B-8-58)", () => {
    const state = stateOf(newRecord());
    expect(proberQuestionTools(state, { explain: false }).map((t) => t.name)).toEqual(["probe", "ask_user_question"]);
    expect(proberQuestionTools(state, { explain: true }).map((t) => t.name)).toEqual(["recall", "ask_user_question"]);
    expect(teacherQuestionTools(state, { explain: false }).map((t) => t.name)).toEqual(["quiz", "ask_user_question"]);
    expect(teacherQuestionTools(state, { explain: true }).map((t) => t.name)).toEqual(["explain", "ask_user_question"]);
  });

  it("checks a free recall commitment and the open question options", async () => {
    const state = stateOf(newRecord([], treeOf("n1")));
    const t = buildQuestionTools(state);
    expect(textOf(await run(t.recall, { question: "Q", correctAnswer: "  " }))).toMatch(/correct answer is empty/);
    expect(textOf(await run(t.ask, { question: "Q", options: ["only one"] }))).toMatch(/at least two/);
    expect((await run(t.ask, { question: "Q", options: ["One", "Two"] })).terminate).toBe(true);
  });
});

describe("plan_init", () => {
  const store = () => {
    const saved: { id: string; tree: unknown }[] = [];
    return { saved, store: { setTree: (id: string, tree: unknown) => void saved.push({ id, tree }), get: () => null, appendMessages: () => ({}) } as never };
  };

  it("parses, saves the whole tree with version plus 1 and returns only the valid ids (B-8-28)", async () => {
    const { saved, store: s } = store();
    const state = stateOf(newRecord([], treeOf("old")));
    const r = await run(planInitTool(state, { store: s }), { mermaid: 'graph TD\n  a["A"] --> b' });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("version 2");
    expect(textOf(r)).toContain("a, b");
    expect(saved).toHaveLength(1);
    expect((saved[0].tree as { version: number; nodes: unknown[] }).version).toBe(2);
    expect((r.details as { tree: { nodes: unknown[] } }).tree.nodes).toHaveLength(2);
    // the first tree of a session has version 1
    const first = await run(planInitTool(stateOf(newRecord()), { store: s }), { mermaid: "graph TD\n  a --> b" });
    expect((first.details as { tree: { version: number } }).tree.version).toBe(1);
  });

  it("saves nothing on failure and reports every problem with its line", async () => {
    const { saved, store: s } = store();
    const r = await run(planInitTool(stateOf(newRecord()), { store: s }), { mermaid: "graph TD\n  A --> b\n  c --> c" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Line 2/);
    expect(textOf(r)).toMatch(/Line 3/);
    expect(saved).toHaveLength(0);
  });
});

describe("probe_done (B-8-35, B-8-36)", () => {
  const assessment = { strands: [{ strand: "fractions", assessment: "Floor at halves, ceiling at unlike denominators." }], summary: "Goal: add fractions." };

  it("is refused while a question is open in the record", async () => {
    const open: NativeMessage[] = [userMsg("m1", "hi"), assistantMsg("m2", [call("q1", "probe", { question: "Q" })], { stopReason: "toolUse" })];
    const state = stateOf(newRecord(open));
    const r = await run(probeDoneTool(state), { assessment });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/question is still open/);
    expect(state.probeDone).toBe(false);
  });

  it("is refused after a question in the same turn, succeeds once with a fixed acknowledgement and then refuses", async () => {
    const state = stateOf(newRecord());
    state.posed = true;
    expect((await run(probeDoneTool(state), { assessment })).isError).toBe(true);
    state.posed = false;
    const tool = probeDoneTool(state);
    const ok = await run(tool, { assessment });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toBe("The assessment is recorded.");
    expect(ok.terminate).toBe(true);
    const again = await run(tool, { assessment });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/already concluded/);
  });

  it("is refused when a past record already holds a successful probe_done", async () => {
    const done: NativeMessage[] = [assistantMsg("m1", [call("pd", "probe_done", { assessment })], { stopReason: "toolUse" }), resultMsg("m2", "pd", "probe_done", "ok", { details: { ok: true } })];
    expect((await run(probeDoneTool(stateOf(newRecord(done))), { assessment })).isError).toBe(true);
  });

  it("needs at least one strand with a reading", async () => {
    const r = await run(probeDoneTool(stateOf(newRecord())), { assessment: { strands: [{ strand: "x", assessment: " " }] } });
    expect(r.isError).toBe(true);
  });
});

describe("practice tools (B-8-37, B-8-38, B-8-39)", () => {
  const problemArgs = (extra: Record<string, unknown> = {}) => ({ statement: "Add 1/2 and 1/3.", mode: "recall", modelSolution: "5/6", ...extra });
  const concludeArgs = (extra: Record<string, unknown> = {}) => ({ outcome: "solved", verdict: "Correct.", rung: null, missClass: null, retest: false, ...extra });

  it("poses on a quiet record and ends the run, and refuses a second problem while one is active", async () => {
    const state = stateOf(newRecord());
    const pose = problemTool(state);
    const first = await run(pose, problemArgs());
    expect(first.isError).toBeUndefined();
    expect(first.terminate).toBe(true);
    const second = await run(pose, problemArgs(), "call_2");
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/already active/);
  });

  it("seeds the gate from the record, so a problem left open in a past turn blocks a new one", async () => {
    const msgs: NativeMessage[] = [
      userMsg("m1", "go"),
      assistantMsg("m2", [call("p1", "problem", problemArgs())], { stopReason: "toolUse" }),
      resultMsg("m3", "p1", "problem", "posed", { details: { ok: true } }),
    ];
    const state = stateOf(newRecord(msgs, undefined, { kind: "practice" }));
    expect(textOf(await run(problemTool(state), problemArgs()))).toMatch(/already active/);
    const concluded = await run(concludeTool(state), concludeArgs());
    expect(concluded.isError).toBeUndefined();
    expect((concluded.details as { modelSolution: string }).modelSolution).toBe("5/6");
  });

  it("accepts a conclude then a pose in one turn, because the gate follows the turn (B-8-38)", async () => {
    const state = stateOf(newRecord());
    await run(problemTool(state), problemArgs());
    expect((await run(concludeTool(state), concludeArgs())).isError).toBeUndefined();
    expect((await run(problemTool(state), problemArgs(), "call_3")).isError).toBeUndefined();
  });

  it("refuses a conclude with nothing active and a dismissed outcome that the model must not choose", async () => {
    const state = stateOf(newRecord());
    expect(textOf(await run(concludeTool(state), concludeArgs()))).toMatch(/No problem is active/);
    await run(problemTool(state), problemArgs());
    const bad = await run(concludeTool(state), concludeArgs({ outcome: "dismissed", rung: "R9" }));
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/solved, solvedWithHints, movedOn, surrendered/);
    expect(textOf(bad)).toMatch(/R0, R1, R2, R3, R4, R5/);
  });

  it("normalises a target name and rejects an unknown one without arming the gate (B-8-39)", async () => {
    const state = stateOf(newRecord(), nameResolver({ n_aaa: "Common denominator" }));
    const pose = problemTool(state);
    const bad = await run(pose, problemArgs({ target: ["Unknown idea"] }));
    expect(bad.isError).toBe(true);
    expect(state.problem).toBeNull();
    const good = await run(pose, problemArgs({ target: ["common denominator"] }));
    expect(good.isError).toBeUndefined();
    expect(state.problem?.target).toEqual(["n_aaa"]);
    // an empty list is healed away and an absent target poses freely
    const state2 = stateOf(newRecord());
    expect((await run(problemTool(state2), problemArgs({ target: [] }))).isError).toBeUndefined();
  });

  it("validates the mode and the statement", async () => {
    const r = await run(problemTool(stateOf(newRecord())), problemArgs({ mode: "essay", statement: " " }));
    expect(textOf(r)).toMatch(/statement is empty/);
    expect(textOf(r)).toMatch(/recall, discrimination, composition/);
  });
});

describe("jobs and send_to_user", () => {
  it("answers that jobs are not available when no dispatcher is wired", async () => {
    const state = stateOf(newRecord());
    const r = await run(researchTool(state, undefined), { question: "Q" });
    expect(textOf(r)).toMatch(/not available/);
    expect(textOf(await run(pdfTool(state, undefined), { path: "a.pdf", question: "Q" }))).toMatch(/not available/);
  });

  it("dispatches through the injected dispatcher with the tool call identifier", async () => {
    const seen: unknown[] = [];
    const jobs = { dispatch: (req: unknown) => (seen.push(req), { jobId: "job_9" }) };
    const r = await run(researchTool(stateOf(newRecord()), jobs), { question: "Q", context: "C" }, "tc_7");
    expect(textOf(r)).toContain("job_9");
    expect(seen).toEqual([{ kind: "research", sessionId: "chat_test", toolCallId: "tc_7", input: { question: "Q", context: "C" } }]);
  });

  it("sends a message to the learner", async () => {
    const r = await run(sendToUserTool(), { message: "Checking a source." });
    expect((r.details as { message: string }).message).toBe("Checking a source.");
  });
});

describe("position and phases (B-8-24, B-8-25, B-8-26, B-8-31, B-8-32)", () => {
  const tagged = (id: string, node: string, name = "quiz") => assistantMsg(`a_${id}`, [call(id, name, { type: "check", nodeId: node })], { stopReason: "toolUse" });
  const tree = treeOf("a", "b", "c", "d");

  it("has nothing current before the first tagged question", () => {
    const pos = derivePosition([userMsg("u", "hi"), assistantMsg("a1", [call("q", "quiz", { type: "check" })])], tree);
    expect(pos.current).toBeNull();
    expect(Object.values(pos.statuses).every((s) => s === "upcoming")).toBe(true);
  });

  it("derives current, visited and upcoming, and keeps both for a revisited node", () => {
    const msgs = [tagged("1", "a"), tagged("2", "b"), tagged("3", "c"), tagged("4", "a")];
    const pos = derivePosition(msgs, tree);
    expect(pos.current).toBe("a");
    expect(pos.visited).toEqual(["a", "b", "c"]);
    expect(pos.statuses).toEqual({ a: "current", b: "visited", c: "visited", d: "upcoming" });
  });

  it("collapses consecutive repeats into one stay and ignores unknown and untagged calls", () => {
    const msgs = [tagged("1", "a"), tagged("2", "a"), tagged("3", "ghost"), assistantMsg("x", [call("5", "quiz", { type: "check" })]), tagged("6", "b")];
    const pos = derivePosition(msgs, tree);
    expect(pos.current).toBe("b");
    expect(pos.visited).toEqual(["a"]);
  });

  it("counts a tagged explain call like a quiz call and derives against the rewritten map", () => {
    const msgs = [tagged("1", "a", "explain"), tagged("2", "b", "explain")];
    expect(derivePosition(msgs, tree).current).toBe("b");
    expect(derivePosition(msgs, treeOf("b", "z")).statuses).toEqual({ b: "current", z: "upcoming" });
    expect(derivePosition(msgs, null).current).toBeNull();
  });

  it("counts a call of any result state and skips a failed generation", () => {
    const failed = assistantMsg("f", [call("9", "quiz", { type: "check", nodeId: "d" })], { stopReason: "error" });
    expect(derivePosition([tagged("1", "a"), failed], tree).current).toBe("a");
  });

  const done = (id: string, extra: Record<string, unknown> = {}): NativeMessage[] => [
    assistantMsg(`a_${id}`, [call(id, "probe_done", { assessment: { strands: [] } })], { stopReason: "toolUse" }),
    resultMsg(`r_${id}`, id, "probe_done", "ok", extra),
  ];

  it("is probe until a concluded probe_done, then plan, then teach from the first tagged question", () => {
    expect(phaseOf([])).toBe("probe");
    expect(phaseOf([userMsg("u", "hi"), assistantMsg("a", [call("q", "probe", {})])])).toBe("probe");
    expect(phaseOf(done("pd"))).toBe("plan");
    expect(phaseOf([...done("pd"), assistantMsg("a2", [call("q", "quiz", { type: "check" })])])).toBe("plan");
    expect(phaseOf([...done("pd"), tagged("1", "a")])).toBe("teach");
  });

  it("keeps the probe phase for a refused or errored probe_done and for input that is only available (B-8-25)", () => {
    expect(phaseOf(done("pd", { isError: true }))).toBe("probe");
    expect(phaseOf(done("pd", { details: { ok: false } }))).toBe("probe");
    const bare = [assistantMsg("a", [call("pd", "probe_done", {})], { stopReason: "toolUse" })];
    expect(phaseOf(bare)).toBe("probe");
  });

  it("folds the messages into phase spans (B-8-26)", () => {
    expect(phaseSpans([])).toEqual([]);
    expect(phaseSpans([userMsg("u", "hi")])).toEqual([{ phase: "probe", from: 0, to: 0 }]);
    const msgs = [userMsg("u", "hi"), ...done("pd"), userMsg("go", "go"), tagged("1", "a")];
    expect(phaseSpans(msgs)).toEqual([
      { phase: "probe", from: 0, to: 2 },
      { phase: "plan", from: 3, to: 3 },
      { phase: "teach", from: 4, to: 4 },
    ]);
  });
});

describe("role selection and the end of a run", () => {
  it("picks the prober, then the teacher after a successful probe_done, and the practice agent for a practice session", () => {
    const done: NativeMessage[] = [assistantMsg("a", [call("pd", "probe_done", {})], { stopReason: "toolUse" }), resultMsg("r", "pd", "probe_done", "ok")];
    expect(roleFor({}, [])).toBe("prober");
    expect(roleFor({ kind: "teach" }, done)).toBe("teacher");
    expect(roleFor({ kind: "practice" }, done)).toBe("practice");
  });

  it("ends the run after a clean question, problem or probe_done and not after an error", () => {
    const res = (toolName: string, isError = false) => ({ toolResults: [{ toolName, isError }] as never });
    expect(endsRun(res("quiz"))).toEqual({ action: "end" });
    expect(endsRun(res("problem"))).toEqual({ action: "end" });
    expect(endsRun(res("probe_done"))).toEqual({ action: "end" });
    expect(endsRun(res("quiz", true))).toBeUndefined();
    expect(endsRun(res("read"))).toBeUndefined();
    expect(endsRun(res("conclude"))).toBeUndefined();
  });
});

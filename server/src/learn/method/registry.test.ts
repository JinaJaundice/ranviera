// The tool sets of the three roles, the wire schemas of the question tools and
// the plan block bookkeeping, checked through the composer and the service.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { buildQuestionTools } from "./tools/questions.ts";
import { makeMethodEnv, newRecord, run, stateOf, textOf, treeOf, type MethodEnv } from "./support.ts";

const names = { n_aaa: "Common denominator" };
const rec = (env: MethodEnv, id: string) => env.service.store.get(id)!;
const toolNames = (env: MethodEnv, id: string) =>
  env.method.composer.compose({ session: rec(env, id), model: env.deps.models.forSession(rec(env, id)), record: () => rec(env, id) }).tools.map((t) => t.name);

describe("the tool set of each role", () => {
  it("gives the prober the plain probe, probe_done and the learner file tools, and no plan tool (B-8-18)", () => {
    const env = makeMethodEnv({ names });
    const id = env.service.create({}).id;
    const t = toolNames(env, id);
    expect(t).toEqual(expect.arrayContaining(["probe", "ask_user_question", "probe_done", "read", "list_sources"]));
    expect(t).not.toContain("quiz");
    expect(t).not.toContain("plan_init");
  });

  it("has no node field in the wire schema of the probe tools (B-8-18, B-8-22)", () => {
    const t = buildQuestionTools(stateOf(newRecord([], treeOf("n1"))));
    for (const tool of [t.probe, t.recall]) expect(JSON.stringify(tool.parameters)).not.toContain("nodeId");
    for (const tool of [t.quiz, t.explain]) expect(JSON.stringify(tool.parameters)).toContain("nodeId");
  });

  it("checks the node of a teach explain like a quiz, and the probe recall needs none (B-8-22)", async () => {
    const t = buildQuestionTools(stateOf(newRecord([], treeOf("n1"))));
    const ok = { type: "check", nodeId: "n1", question: "Why?", correctAnswer: "Because." };
    expect((await run(t.explain, ok)).isError).toBeUndefined();
    const bad = await run(buildQuestionTools(stateOf(newRecord([], treeOf("n1")))).explain, { ...ok, nodeId: "zzz" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("n1");
    expect((await run(buildQuestionTools(stateOf(newRecord())).recall, { question: "Why?", correctAnswer: "Because." })).isError).toBeUndefined();
  });

  it("gives the practice agent two practice tools and the learner file set, with only plan_init as a plan tool (B-8-29, B-8-40)", () => {
    const env = makeMethodEnv({ names });
    const practice = toolNames(env, env.service.create({ kind: "practice" }).id);
    expect(practice).toEqual(expect.arrayContaining(["problem", "conclude", "read"]));
    for (const absent of ["probe", "quiz", "probe_done", "plan_init"]) expect(practice).not.toContain(absent);
    expect(practice.filter((n) => /^plan_/.test(n))).toEqual([]);
  });
});

describe("plan blocks (B-8-33, B-8-34)", () => {
  const plan = (n: string, id: string) =>
    fauxAssistantMessage([fauxText(`Plan ${n}.`), fauxToolCall("plan_init", { mermaid: n === "1" ? "graph TD\n  a --> b" : "graph TD\n  a --> b\n  b --> c" } as never, { id })], { stopReason: "toolUse" });

  it("adds one block for a successful plan_init, none for a failed one, and does not repeat it", async () => {
    const env = makeMethodEnv({ names });
    const id = env.service.create({}).id;
    // a record that already passed the probe, so the teacher plans
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe_done", { assessment: { strands: [{ strand: "s", assessment: "a" }], summary: "g" } } as never, { id: "pd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("plan_init", { mermaid: "graph TD\n  Bad Id --> b" } as never, { id: "bad" })], { stopReason: "toolUse" }),
      plan("1", "p1"),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    await env.service.input(id, { type: "text", text: "measure" });
    await env.service.turns.whenSettled(id);
    expect(env.wakes).toEqual([id]);
    await env.service.input(id, { type: "text", text: "go" });
    await env.service.turns.whenSettled(id);
    const blocks = () => rec(env, id).messages.filter((m) => m.role === "custom" && m.customType === "plan-block");
    expect(blocks()).toHaveLength(1);
    expect((blocks()[0] as { details?: { planCallId?: string } }).details?.planCallId).toBe("p1");
    env.method.afterTurn(id);
    env.method.afterTurn(id);
    expect(blocks()).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import type { AnswerDetails, NativeMessage, PlanBlockDetails } from "@shared/learn/sessions";
import { activeProblem, contextTokens, derivePhase, planStatuses, practicePause, projectBlocks } from "./project";

const quiz = (id: string, nodeId: string | undefined, mid = `a_${id}`): NativeMessage => ({
  role: "assistant",
  id: mid,
  content: [{ type: "toolCall", id, name: "quiz", arguments: { type: "check", ...(nodeId ? { nodeId } : {}), question: "Q?", options: ["a", "b"], correctAnswer: "a", explanation: "E" } }],
});
const answer = (id: string, extra: Partial<AnswerDetails> = {}): NativeMessage => ({
  role: "toolResult",
  id: `r_${id}`,
  toolCallId: id,
  toolName: "quiz",
  content: [],
  isError: false,
  details: { kind: "quiz", tool: "quiz", questionText: "Q?", answers: [{ label: "a", value: "a", index: 1 }], correct: true, answeredAt: "", ...extra },
});

describe("phase and plan position (B-9-28, B-9-29, B-9-31)", () => {
  it("is probe, then plan after a successful probe_done, then teach at the first tagged call", () => {
    expect(derivePhase([])).toBe("probe");
    const done: NativeMessage = { role: "toolResult", id: "p", toolCallId: "p", toolName: "probe_done", content: [], isError: false };
    expect(derivePhase([done])).toBe("plan");
    expect(derivePhase([{ ...done, isError: true }])).toBe("probe");
    expect(derivePhase([done, quiz("c1", undefined)])).toBe("plan");
    expect(derivePhase([done, quiz("c1", "n1")])).toBe("teach");
  });

  it("places one Teaching divider where the first tagged question is posed, and none for untagged calls", () => {
    const labels = (m: NativeMessage[]) => projectBlocks(m).filter((b) => b.kind === "divider").map((b) => (b as { label: string }).label);
    expect(labels([quiz("c1", undefined)])).toEqual([]);
    expect(labels([quiz("c1", "n1"), answer("c1"), quiz("c2", "n2")])).toEqual(["Teaching"]);
  });

  it("derives the current and visited nodes, collapsing repeats and ignoring unknown nodes", () => {
    const tree = { nodes: [{ id: "n1", title: "A" }, { id: "n2", title: "B" }, { id: "n3", title: "C" }] };
    const msgs = [quiz("c1", "n1"), quiz("c2", "n1"), quiz("c3", "n2"), quiz("c4", "zzz")];
    expect(planStatuses(tree, msgs)).toEqual({ n1: "visited", n2: "current", n3: "upcoming" });
    expect(planStatuses(tree, [])).toEqual({ n1: "upcoming", n2: "upcoming", n3: "upcoming" });
  });

  it("draws the plan block with a divider that counts its nodes", () => {
    const details: PlanBlockDetails = { planCallId: "p", kind: "full", at: "", current: null, nodes: [{ id: "n1", title: "A", status: "upcoming" }, { id: "n2", title: "B", status: "upcoming" }], edges: [{ from: "n1", to: "n2" }] };
    const blocks = projectBlocks([{ role: "custom", id: "pb_1", customType: "plan-block", content: "", details }]);
    expect(blocks.map((b) => b.kind)).toEqual(["divider", "plan"]);
    expect((blocks[0] as { label: string }).label).toBe("Plan with 2 nodes");
  });
});

describe("the transcript blocks (B-9-06, B-9-10)", () => {
  it("shows an answered card at the call and keeps a pending question out of the transcript", () => {
    expect(projectBlocks([quiz("c1", "n1")]).some((b) => b.kind === "answered")).toBe(false);
    const blocks = projectBlocks([quiz("c1", "n1"), answer("c1")]);
    expect(blocks.find((b) => b.kind === "answered")).toMatchObject({ callId: "c1" });
  });

  it("shows a dismissed question as one skipped line", () => {
    const blocks = projectBlocks([quiz("c1", "n1"), answer("c1", { dismissed: true, answers: [] })]);
    expect(blocks.map((b) => b.kind)).toContain("skipped");
    expect(blocks.map((b) => b.kind)).not.toContain("answered");
  });

  it("offers a retry card only for the current malformed call", () => {
    const bad: NativeMessage = { role: "assistant", id: "a1", stopReason: "toolUse", content: [{ type: "toolCall", id: "bad", name: "quiz", arguments: { question: "Q" } }] };
    expect(projectBlocks([bad]).map((b) => b.kind)).toEqual(["malformed"]);
    expect(projectBlocks([bad, { role: "user", id: "u", content: "go" }, { role: "assistant", id: "a2", content: [{ type: "text", text: "ok" }] }]).map((b) => b.kind)).not.toContain("malformed");
  });

  it("puts reasoning above the text, shows an empty streaming message as a thinking row, and keeps learner notes out of the teacher text", () => {
    const m: NativeMessage = { role: "assistant", id: "a1", content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "hmm" }] };
    expect(projectBlocks([m]).map((b) => b.kind)).toEqual(["thinking", "teacher"]);
    expect(projectBlocks([{ role: "assistant", id: "a2", content: [] }], new Set(["a2"])).map((b) => b.kind)).toEqual(["thinking"]);
  });

  it("shows a failed tool call that is retried as one quiet line", () => {
    const call: NativeMessage = { role: "assistant", id: "a1", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }] };
    const fail: NativeMessage = { role: "toolResult", id: "r1", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "no" }], isError: true };
    const again: NativeMessage = { role: "assistant", id: "a2", content: [{ type: "text", text: "Retried" }] };
    expect(projectBlocks([call, fail, again]).map((b) => b.kind)).toEqual(["retrying", "teacher"]);
  });

  it("hides a probe handoff, shows a compaction note and counts the graph context", () => {
    const blocks = projectBlocks([
      { role: "custom", id: "h", customType: "probe-handoff", content: "" },
      { role: "custom", id: "c", customType: "compaction", content: "summary text" },
      { role: "custom", id: "g", customType: "graph-context", content: "", details: { propositions: [{ id: "n_1", name: "a", statement: "s" }], chains: [] } },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["compaction", "context"]);
    expect(JSON.stringify(blocks)).not.toContain("summary text");
  });
});

describe("practice (B-9-33, B-9-34)", () => {
  const problem: NativeMessage = { role: "assistant", id: "ap", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Solve it", mode: "recall", modelSolution: "SECRET", target: ["n_1"] } }] };
  const concluded: NativeMessage[] = [
    { role: "assistant", id: "ac", content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solved", verdict: "Good", rung: null, missClass: null } }] },
    { role: "toolResult", id: "rc", toolCallId: "c1", toolName: "conclude", content: [], isError: false, details: { ok: true, outcome: "solved", problemCallId: "p1", modelSolution: "SECRET", target: ["n_1"] } },
  ];

  it("has an active problem until it is concluded or dismissed", () => {
    expect(activeProblem([problem])?.callId).toBe("p1");
    expect(activeProblem([problem, ...concluded])).toBeNull();
    expect(activeProblem([problem, { role: "custom", id: "d", customType: "problem-dismissed", content: "", details: { problemCallId: "p1" } }])).toBeNull();
  });

  it("never carries the model solution in the problem block, and reveals it only in the concluded block", () => {
    expect(JSON.stringify(projectBlocks([problem]))).not.toContain("SECRET");
    const blocks = projectBlocks([problem, ...concluded]);
    expect(blocks.find((b) => b.kind === "concluded")).toMatchObject({ solution: "SECRET", outcome: "solved", mode: "recall", targets: ["n_1"] });
  });

  it("pauses after a conclusion until the next problem is asked for", () => {
    expect(practicePause([problem])).toBe(false);
    expect(practicePause([problem, ...concluded])).toBe(true);
    expect(practicePause([problem, ...concluded, { role: "custom", id: "n", customType: "practice-next", content: "" }])).toBe(false);
  });
});

describe("context", () => {
  it("reads the last call, and says nothing when it reported nothing", () => {
    expect(contextTokens([{ role: "assistant", id: "a", content: [], usage: { totalTokens: 1200 } }])).toBe(1200);
    expect(contextTokens([{ role: "assistant", id: "a", content: [], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 } }])).toBe(150);
    expect(contextTokens([{ role: "assistant", id: "a", content: [] }])).toBeNull();
  });
});

describe("the probe conclusion and the thinking rows (B-9-09, B-9-47)", () => {
  it("shows the strands of a conclusion from the call, and none from a partial call", () => {
    const done: NativeMessage = { role: "assistant", id: "a", content: [{ type: "toolCall", id: "pd", name: "probe_done", arguments: { strands: [{ strand: "Growth", assessment: "Holds it" }], summary: "Short plan" } }] };
    expect(projectBlocks([done])[0]).toMatchObject({ kind: "probeDone", strands: [{ strand: "Growth", assessment: "Holds it" }], summary: "Short plan" });
    const partial: NativeMessage = { role: "assistant", id: "b", content: [{ type: "toolCall", id: "pd2", name: "probe_done", arguments: {} }] };
    expect(projectBlocks([partial])[0]).toMatchObject({ kind: "probeDone", strands: [] });
  });
});

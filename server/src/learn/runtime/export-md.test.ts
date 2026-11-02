import { describe, expect, it } from "vitest";
import type { NativeMessage, SessionRecord } from "../../../../shared/learn/index.ts";
import { markdownFileName, sessionToMarkdown } from "./export-md.ts";
import { assistantMsg, call, resultMsg, userMsg } from "./support.ts";

const record = (title: string, messages: NativeMessage[]): SessionRecord => ({
  id: "chat_x_00000000",
  title,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  messages,
});

describe("Markdown export (B-7-86 to B-7-89)", () => {
  it("is a bare header for an empty session", () => {
    expect(sessionToMarkdown(record("Empty", []))).toBe("# Empty\n");
  });

  it("renders speaker blocks in order with no identifiers", () => {
    const md = sessionToMarkdown(
      record("Bonds", [
        userMsg("msg_user1", "What is duration?"),
        assistantMsg("msg_asst1", [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text: "Duration is a sensitivity." }, call("call_abc", "quiz", { question: "Which is it?", type: "check" })]),
        resultMsg("msg_res1", "call_abc", "quiz", "The learner chose: A.", {
          details: { kind: "quiz", tool: "quiz", questionText: "Which is it?", answers: [{ label: "A", value: "a", index: 1 }], correct: true, thinking: "I remembered it", answeredAt: "x" },
        }),
        assistantMsg("msg_asst2", [{ type: "text", text: "Correct." }]),
      ]),
    );
    expect(md).toBe(
      [
        "# Bonds",
        "### Learner\n\nWhat is duration?",
        "### Teacher\n\nDuration is a sensitivity.",
        "### Quiz\n\nWhich is it?\n\nAnswered correctly.\n\nThe learner's reasoning: I remembered it",
        "### Teacher\n\nCorrect.",
      ].join("\n\n") + "\n",
    );
    expect(md).not.toMatch(/msg_|call_|HIDDEN/);
  });

  it("renders the outcomes of questions in the learner's words", () => {
    const md = sessionToMarkdown(
      record("T", [
        assistantMsg("a1", [call("c1", "quiz", { question: "Q1" }), call("c2", "quiz", { question: "Q2" }), call("c3", "explain", { question: "Q3" }), call("c4", "ask_user_question", { question: "Q4" })]),
        resultMsg("r1", "c1", "quiz", "x", { details: { kind: "quiz", tool: "quiz", questionText: "Q1", answers: [], dontKnow: true, answeredAt: "x" } }),
        resultMsg("r2", "c2", "quiz", "x", { details: { kind: "quiz", tool: "quiz", questionText: "Q2", answers: [], dismissed: true, answeredAt: "x" } }),
        resultMsg("r3", "c3", "explain", "x", { details: { kind: "explain", tool: "explain", questionText: "Q3", answers: [], text: "my own words", answeredAt: "x" } }),
        resultMsg("r4", "c4", "ask_user_question", "x", { details: { kind: "ask", tool: "ask_user_question", questionText: "Q4", answers: [{ label: "Beginner", value: "b", index: 1 }], answeredAt: "x" } }),
      ]),
    );
    expect(md).toContain("### Quiz\n\nQ1\n\nThe learner did not know.");
    expect(md).toContain("### Quiz\n\nQ2\n\nSkipped.");
    expect(md).toContain("### Recall check\n\nQ3\n\nThe learner wrote: my own words");
    expect(md).toContain("### Question\n\nQ4\n\nThe learner chose: Beginner.");
  });

  it("leaves out failed calls, failed responses and markers", () => {
    const md = sessionToMarkdown(
      record("T", [
        userMsg("u", "hello"),
        assistantMsg("a1", [{ type: "text", text: "FAILED RESPONSE" }], { stopReason: "error" }),
        assistantMsg("a2", [call("c1", "quiz", { question: "Broken?" })]),
        resultMsg("r1", "c1", "quiz", "bad", { isError: true }),
        { role: "custom", id: "m", customType: "plan-block", content: "PLAN", timestamp: 1 },
      ]),
    );
    expect(md).not.toMatch(/FAILED RESPONSE|Broken|PLAN/);
  });

  it("renders a problem and its conclusion with the model solution as a quotation", () => {
    const md = sessionToMarkdown(
      record("P", [
        assistantMsg("a1", [call("p1", "problem", { statement: "Compute 6 times 7.", mode: "recall", modelSolution: "42, because 6 times 7 is 42." })]),
        resultMsg("r1", "p1", "problem", "posed", { details: { ok: true } }),
        assistantMsg("a2", [call("k1", "conclude", { outcome: "solvedWithHints", verdict: "Solved after one hint.", rung: "R1", missClass: null, retest: false })]),
        resultMsg("r2", "k1", "conclude", "ok", { details: { ok: true } }),
      ]),
    );
    expect(md).toContain("### Problem\n\nCompute 6 times 7.");
    expect(md).toContain("Outcome: Solved with hints.");
    expect(md).toContain("Solved after one hint.");
    expect(md).toContain("> 42, because 6 times 7 is 42.");
  });

  it("never leaks the solution of a dismissed problem", () => {
    const md = sessionToMarkdown(
      record("P", [
        assistantMsg("a1", [call("p1", "problem", { statement: "Hard one.", mode: "recall", modelSolution: "SECRET SOLUTION" })]),
        resultMsg("r1", "p1", "problem", "posed", { details: { ok: true } }),
        { role: "custom", id: "d", customType: "problem-dismissed", content: "dismissed", details: { problemCallId: "p1" }, timestamp: 1 },
        assistantMsg("a2", [call("p1~dismissed", "conclude", { outcome: "dismissed", verdict: "x" })]),
        resultMsg("r2", "p1~dismissed", "conclude", "ok", { details: { ok: true } }),
      ]),
    );
    expect(md).not.toContain("SECRET SOLUTION");
    expect(md).toContain("### Conclusion\n\nSkipped.");
  });

  it("does not render a problem that was posed with an error", () => {
    const md = sessionToMarkdown(
      record("P", [assistantMsg("a1", [call("p1", "problem", { statement: "Bad one.", modelSolution: "S" })]), resultMsg("r1", "p1", "problem", "invalid", { isError: true })]),
    );
    expect(md).not.toContain("Bad one.");
  });

  it("includes the output of a successful send_to_user call", () => {
    const md = sessionToMarkdown(
      record("S", [
        assistantMsg("a1", [call("s1", "send_to_user", { message: "Delivered text." }), call("s2", "send_to_user", { message: "Failed text." })]),
        resultMsg("r1", "s1", "send_to_user", "ok"),
        resultMsg("r2", "s2", "send_to_user", "no", { isError: true }),
      ]),
    );
    expect(md).toContain("Delivered text.");
    expect(md).not.toContain("Failed text.");
  });

  it("names the attachment from the title with a fallback", () => {
    expect(markdownFileName("Bond duration: a first look!")).toBe("bond-duration-a-first-look.md");
    expect(markdownFileName("???")).toBe("session.md");
  });
});

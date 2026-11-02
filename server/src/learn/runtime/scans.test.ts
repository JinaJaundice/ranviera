import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { NativeMessage } from "../../../../shared/learn/index.ts";
import { activeProblemOf, danglingQuestions, hasProbeDone, needsContinuation, phaseOf } from "./scans.ts";
import { assistantMsg, call, makeEnv, resultMsg, userMsg } from "./support.ts";

const q = (id: string) => call(id, "quiz", { question: id, nodeId: "n-one", options: [{ label: "A", value: "a" }], correctAnswer: "a" });

describe("pending questions are derived from the record", () => {
  it("lets a later assistant question supersede an unanswered earlier one (B-7-53)", () => {
    const messages = [userMsg("u1", "go"), assistantMsg("a1", [q("q1")]), userMsg("u2", "skip it"), assistantMsg("a2", [q("q2"), q("q3")])];
    expect(danglingQuestions(messages).map((c) => c.id)).toEqual(["q2", "q3"]);
  });

  it("never lets a response that stopped at its length limit own a question (B-7-56)", () => {
    const messages = [userMsg("u", "go"), assistantMsg("a", [q("q1")], { stopReason: "length" })];
    expect(danglingQuestions(messages)).toEqual([]);
    const failed = [userMsg("u", "go"), assistantMsg("a", [q("q1")], { stopReason: "error" })];
    expect(danglingQuestions(failed)).toEqual([]);
  });

  it("drops a question from the list once it has a result", () => {
    const messages = [userMsg("u", "go"), assistantMsg("a", [q("q1"), q("q2")]), resultMsg("r", "q1", "quiz")];
    expect(danglingQuestions(messages).map((c) => c.id)).toEqual(["q2"]);
  });
});

describe("phase and problems", () => {
  it("is probe until a successful probe_done, plan after it and teach from the first tagged teach question", () => {
    expect(phaseOf([userMsg("u", "go")])).toBe("probe");
    const done = [userMsg("u", "go"), assistantMsg("a", [call("p", "probe_done", {})]), resultMsg("r", "p", "probe_done", "ok", { details: { ok: true } })];
    expect(hasProbeDone(done)).toBe(true);
    expect(phaseOf(done)).toBe("plan");
    const teach = [...done, assistantMsg("b", [q("q1")])];
    expect(phaseOf(teach)).toBe("teach");
  });

  it("does not count a refused or failed probe_done, or one from a failed generation", () => {
    const refused = [assistantMsg("a", [call("p", "probe_done", {})]), resultMsg("r", "p", "probe_done", "no", { isError: true })];
    expect(phaseOf(refused)).toBe("probe");
    const notOk = [assistantMsg("a", [call("p", "probe_done", {})]), resultMsg("r", "p", "probe_done", "no", { details: { ok: false } })];
    expect(phaseOf(notOk)).toBe("probe");
    const failedGen = [assistantMsg("a", [call("p", "probe_done", {})], { stopReason: "error" }), resultMsg("r", "p", "probe_done", "ok")];
    expect(phaseOf(failedGen)).toBe("probe");
  });

  it("counts a problem as active only through its clean result, until it is concluded", () => {
    const base: NativeMessage[] = [assistantMsg("a", [call("p1", "problem", {})])];
    expect(activeProblemOf(base)).toBeNull();
    const posed = [...base, resultMsg("r", "p1", "problem", "posed", { details: { ok: true } })];
    expect(activeProblemOf(posed)?.id).toBe("p1");
    const concluded = [...posed, assistantMsg("b", [call("k1", "conclude", {})]), resultMsg("r2", "k1", "conclude", "ok", { details: { ok: true } })];
    expect(activeProblemOf(concluded)).toBeNull();
  });
});

describe("continuation (B-7-38, B-7-39)", () => {
  it("never continues from a text tail, a dangling question or an orphan result", () => {
    expect(needsContinuation([userMsg("u", "x"), assistantMsg("a", [{ type: "text", text: "hi" }])])).toBe(false);
    expect(needsContinuation([userMsg("u", "x"), assistantMsg("a", [q("q1")])])).toBe(false);
    expect(needsContinuation([resultMsg("r", "orphan", "echo")])).toBe(false);
  });

  it("continues only when every parallel question is answered", () => {
    const base = [userMsg("u", "x"), assistantMsg("a", [q("q1"), q("q2")]), resultMsg("r1", "q1", "quiz")];
    expect(needsContinuation(base)).toBe(false);
    expect(needsContinuation([...base, resultMsg("r2", "q2", "quiz")])).toBe(true);
  });

  it("does not continue from a dismissal or a posed problem", () => {
    const dismissed = [assistantMsg("a", [q("q1")]), resultMsg("r", "q1", "quiz", "skipped", { details: { dismissed: true } })];
    expect(needsContinuation(dismissed)).toBe(false);
    const posed = [assistantMsg("a", [call("p1", "problem", {})]), resultMsg("r", "p1", "problem", "posed", { details: { ok: true } })];
    expect(needsContinuation(posed)).toBe(false);
  });
});

describe("input handling around failures", () => {
  it("refuses the turn when the input cannot be saved, with no agent built and nothing running (B-7-05)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const original = env.service.store.appendMessages;
    env.service.store.appendMessages = () => {
      throw new Error("disk full");
    };
    await expect(env.service.input(s.id, { type: "text", text: "hello" })).rejects.toThrow("disk full");
    env.service.store.appendMessages = original;
    expect(env.faux.state.callCount).toBe(0);
    expect(env.service.turns.isRunning(s.id)).toBe(false);
    expect(env.service.store.get(s.id)!.messages).toEqual([]);
  });

  it("recovers a malformed question by writing an error result and starting one turn (B-7-57)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.service.store.appendMessages(s.id, [userMsg("m1", "go"), assistantMsg("m2", [q("q1")], { stopReason: "toolUse" })]);
    await expect(env.service.input(s.id, { type: "retry-question", messageId: "m2", contentIndex: 0, toolCallId: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(env.service.input(s.id, { type: "retry-question", messageId: "gone", contentIndex: 0, toolCallId: "q1" })).rejects.toMatchObject({ status: 400 });
    env.faux.setResponses([fauxAssistantMessage([fauxText("posed again")])]);
    await env.service.input(s.id, { type: "retry-question", messageId: "m2", contentIndex: 0, toolCallId: "q1" });
    await env.service.turns.whenSettled(s.id);
    const msgs = env.service.store.get(s.id)!.messages;
    expect(msgs[2]).toMatchObject({ role: "toolResult", toolCallId: "q1", isError: true });
    expect(msgs[3].role).toBe("assistant");
    await expect(env.service.input(s.id, { type: "retry-question", messageId: "m2", contentIndex: 0, toolCallId: "q1" })).rejects.toMatchObject({ status: 400 });
  });

  it("saves the thinking of an open practice problem and asks for the next one only when none is open", async () => {
    const env = makeEnv();
    const s = env.service.create({ kind: "practice" });
    env.service.store.appendMessages(s.id, [
      userMsg("m1", "practise"),
      assistantMsg("m2", [call("p1", "problem", { statement: "S" })], { stopReason: "toolUse" }),
      resultMsg("m3", "p1", "problem", "posed", { details: { ok: true } }),
    ]);
    await expect(env.service.input(s.id, { type: "next" })).rejects.toMatchObject({ status: 400 });
    await expect(env.service.input(s.id, { type: "thinking", problemCallId: "other", text: "t" })).rejects.toMatchObject({ status: 400 });
    env.faux.setResponses([fauxAssistantMessage([fauxText("read it")])]);
    await env.service.input(s.id, { type: "thinking", problemCallId: "p1", text: "my working" });
    await env.service.turns.whenSettled(s.id);
    const marker = env.service.store.get(s.id)!.messages[3] as { customType: string; details: { text: string; problemCallId: string } };
    expect(marker.customType).toBe("practice-thinking");
    expect(marker.details).toEqual({ problemCallId: "p1", text: "my working" });
  });
});

describe("a delivered job marker", () => {
  it("is a place to continue, so that the idle wake can start a turn from it", () => {
    const steer = { role: "custom", id: "steer_job_1", customType: "subagent-steer", content: "The research brief.", display: true, details: {} } as const;
    const abort = { role: "custom", id: "abort_job_2", customType: "subagent-abort", content: "No result is coming.", display: true, details: {} } as const;
    expect(needsContinuation([userMsg("u", "x"), assistantMsg("a", [{ type: "text", text: "Noted." }]), steer as never])).toBe(true);
    expect(needsContinuation([userMsg("u", "x"), assistantMsg("a", [{ type: "text", text: "Noted." }]), abort as never])).toBe(true);
  });
});

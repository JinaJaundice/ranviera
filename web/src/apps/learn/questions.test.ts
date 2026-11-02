import { describe, expect, it } from "vitest";
import type { AssistantMessage, NativeMessage } from "@shared/learn/sessions";
import {
  CONFIDENCE_STOPS,
  DONT_KNOW,
  OTHER,
  actOnRow,
  buildAnswer,
  emptyForm,
  hasAnswer,
  malformedQuestionsOf,
  nearestStop,
  pendingQuestionOf,
  rowIds,
  seededShuffle,
  stepStop,
  stopFromFraction,
  teaser,
  toClientQuestion,
  toggleOther,
  toggleValue,
  typeOther,
  walkRows,
} from "./questions";

const call = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, name, arguments: args });
const quizArgs = { type: "check", nodeId: "n1", question: "Which is larger?", options: ["one", "two", "three"], correctAnswer: "two", explanation: "Because." };
const asst = (blocks: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}, id = "a1"): AssistantMessage => ({ role: "assistant", id, content: blocks, stopReason: "toolUse", ...extra });

describe("confidence stops (B-9-03, B-9-04)", () => {
  it("has the six stops, rests at 50 and snaps to the nearest", () => {
    expect([...CONFIDENCE_STOPS]).toEqual([0, 30, 50, 70, 90, 100]);
    expect(CONFIDENCE_STOPS[emptyForm().confidenceIdx]).toBe(50);
    expect(CONFIDENCE_STOPS[nearestStop(61)]).toBe(70);
    expect(CONFIDENCE_STOPS[nearestStop(40)]).toBe(30); // a tie takes the lower stop
    expect(CONFIDENCE_STOPS[nearestStop(250)]).toBe(100);
    expect(CONFIDENCE_STOPS[nearestStop(-5)]).toBe(0);
    expect(CONFIDENCE_STOPS[stopFromFraction(0.93)]).toBe(90);
  });

  it("steps through the stops and clamps at both ends", () => {
    expect(stepStop(0, -1)).toBe(0);
    expect(stepStop(5, 1)).toBe(5);
    expect(stepStop(2, 1)).toBe(3);
  });
});

describe("the question as the window may see it", () => {
  it("shows the question and options and never the answer or the explanation", () => {
    const q = toClientQuestion(call("quiz", quizArgs))!;
    const text = JSON.stringify(q);
    expect(q.question).toBe("Which is larger?");
    expect(q.options).toHaveLength(3);
    expect(text).not.toContain("Because.");
    expect(text).not.toContain("correctAnswer");
    expect(q.label).toBe("Check");
  });

  it("shuffles by the call id, so the order is stable and differs between questions", () => {
    const a = toClientQuestion(call("quiz", quizArgs, "x"))!.options!.map((o) => o.value);
    const b = toClientQuestion(call("quiz", quizArgs, "x"))!.options!.map((o) => o.value);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(["one", "three", "two"]);
    expect(seededShuffle([1, 2, 3, 4, 5, 6], "seed")).toEqual(seededShuffle([1, 2, 3, 4, 5, 6], "seed"));
  });

  it("labels each kind (B-9-11, B-9-12)", () => {
    expect(toClientQuestion(call("quiz", { ...quizArgs, type: "predict" }))!.label).toBe("Prediction");
    expect(toClientQuestion(call("probe", quizArgs))!.label).toBe("Probe");
    expect(toClientQuestion(call("recall", { question: "Say it" }))!.label).toBe("Recall");
    expect(toClientQuestion(call("explain", { type: "check", question: "Say it" }))!.label).toBe("Explain");
    expect(toClientQuestion(call("ask_user_question", { question: "Which?" }))!.label).toBe("Question");
  });

  it("collapses a graded teaching check but not a prediction, a probe or an open question", () => {
    expect(toClientQuestion(call("quiz", quizArgs))!.collapsed).toBe(true);
    expect(toClientQuestion(call("quiz", { ...quizArgs, type: "predict" }))!.collapsed).toBe(false);
    expect(toClientQuestion(call("probe", quizArgs))!.collapsed).toBe(false);
    expect(toClientQuestion(call("ask_user_question", { question: "Which?", options: ["a", "b"] }))!.collapsed).toBe(false);
  });

  it("returns null for a malformed call and heals a string encoded options list", () => {
    expect(toClientQuestion(call("quiz", { question: "Q", options: "nonsense" }))).toBeNull();
    expect(toClientQuestion(call("quiz", { ...quizArgs, options: ["same", "same"] }))).toBeNull();
    expect(toClientQuestion(call("quiz", { ...quizArgs, options: JSON.stringify(["a", "b"]) }))!.options).toHaveLength(2);
  });

  it("flattens maths for the folded teaser", () => {
    expect(teaser("Find $x^2$ when **x** is 3")).toBe("Find a formula when x is 3");
  });
});

describe("the pending question and its key (B-9-72)", () => {
  it("is the first answerable call of the newest assistant message", () => {
    const msgs: NativeMessage[] = [asst([{ type: "toolCall", id: "bad", name: "quiz", arguments: { question: "Q" } }, { type: "toolCall", id: "good", name: "quiz", arguments: quizArgs }])];
    expect(pendingQuestionOf(msgs)?.toolCallId).toBe("good");
    expect(malformedQuestionsOf(msgs).map((c) => c.toolCallId)).toEqual(["bad"]);
  });

  it("never owns a question for a failed or streaming generation", () => {
    const body: AssistantMessage["content"] = [{ type: "toolCall", id: "c1", name: "quiz", arguments: quizArgs }];
    expect(pendingQuestionOf([asst(body, { stopReason: "error" })])).toBeNull();
    expect(pendingQuestionOf([asst(body, { stopReason: "aborted" })])).toBeNull();
    expect(pendingQuestionOf([asst(body)], new Set(["a1"]))).toBeNull();
    expect(pendingQuestionOf([asst(body, { stopReason: "length" })])).toBeNull();
  });

  it("is closed by a real answer and not by a bare acknowledgement", () => {
    const base = asst([{ type: "toolCall", id: "c1", name: "quiz", arguments: quizArgs }]);
    const ack: NativeMessage = { role: "toolResult", id: "r1", toolCallId: "c1", toolName: "quiz", content: [], isError: false };
    expect(pendingQuestionOf([base, ack])?.toolCallId).toBe("c1");
    expect(pendingQuestionOf([base, { ...ack, details: { kind: "quiz", answers: [] } }])).toBeNull();
  });

  it("uses the call id as the key, and an occurrence qualified key when the id repeats", () => {
    const first = asst([{ type: "toolCall", id: "dup", name: "quiz", arguments: quizArgs }], {}, "a0");
    const second = asst([{ type: "toolCall", id: "dup", name: "quiz", arguments: quizArgs }], {}, "a1");
    expect(pendingQuestionOf([second])?.key).toBe("dup");
    expect(pendingQuestionOf([first, second])?.key).toBe(JSON.stringify(["a1", 0, "dup"]));
  });
});

describe("the form (B-9-01, B-9-04)", () => {
  const single = toClientQuestion(call("quiz", quizArgs))!;
  const multi = toClientQuestion(call("quiz", { ...quizArgs, multiSelect: true }))!;
  const ask = toClientQuestion(call("ask_user_question", { question: "Which?", options: ["a", "b"] }))!;
  const askMulti = toClientQuestion(call("ask_user_question", { question: "Which?", options: ["a", "b"], multiSelect: true }))!;
  const text = toClientQuestion(call("ask_user_question", { question: "Why?" }))!;

  it("a single choice replaces and the not known option displaces the pick", () => {
    let f = toggleValue(emptyForm(), single, "one");
    f = toggleValue(f, single, "two");
    expect(f.selected).toEqual(["two"]);
    f = actOnRow(f, single, DONT_KNOW);
    expect(f).toMatchObject({ dontKnow: true, selected: [] });
    f = toggleValue(f, single, "one");
    expect(f).toMatchObject({ dontKnow: false, selected: ["one"] });
  });

  it("a multiple choice toggles each option", () => {
    let f = toggleValue(emptyForm(), multi, "one");
    f = toggleValue(f, multi, "two");
    expect(f.selected).toEqual(["one", "two"]);
    expect(toggleValue(f, multi, "one").selected).toEqual(["two"]);
  });

  it("Other displaces options in a single choice and sits with them in a multiple choice, and typing selects it", () => {
    let s = toggleValue(emptyForm(), ask, "a");
    s = toggleOther(s, ask);
    expect(s).toMatchObject({ otherSelected: true, selected: [] });
    let m = toggleValue(emptyForm(), askMulti, "a");
    m = toggleOther(m, askMulti);
    expect(m).toMatchObject({ otherSelected: true, selected: ["a"] });
    expect(typeOther(emptyForm(), ask, "my own").otherSelected).toBe(true);
  });

  it("needs an answer before it can be submitted", () => {
    expect(hasAnswer(emptyForm(), single)).toBe(false);
    expect(hasAnswer(toggleValue(emptyForm(), single, "one"), single)).toBe(true);
    expect(hasAnswer(toggleDont(), single)).toBe(true);
    expect(hasAnswer(toggleOther(emptyForm(), ask), ask)).toBe(false);
    expect(hasAnswer(typeOther(emptyForm(), ask, "x"), ask)).toBe(true);
    expect(hasAnswer({ ...emptyForm(), text: "  " }, text)).toBe(false);
    expect(hasAnswer({ ...emptyForm(), text: "words" }, text)).toBe(true);
  });

  function toggleDont() {
    return actOnRow(emptyForm(), single, DONT_KNOW);
  }

  it("sends confidence for a graded choice, none for the not known option, and the reading notes with it", () => {
    const f = { ...toggleValue(emptyForm(), single, "two"), thinking: " because ", confidenceIdx: 4 };
    expect(buildAnswer(f, single, " read ")).toEqual({ values: ["two"], thinking: "because", readingThinking: "read", confidence: 90 });
    expect(buildAnswer(toggleDont(), single)).toEqual({ dontKnow: true });
    expect(buildAnswer({ ...emptyForm(), text: " hi " }, text)).toEqual({ text: "hi" });
    expect(buildAnswer(typeOther(emptyForm(), ask, " mine "), ask)).toEqual({ other: "mine" });
  });

  it("walks the rows and clamps at both ends", () => {
    const rows = rowIds(single);
    expect(rows.at(-1)).toBe(DONT_KNOW);
    expect(rowIds(ask).at(-1)).toBe(OTHER);
    expect(walkRows(rows, null, 1)).toBe(rows[0]);
    expect(walkRows(rows, rows[0], -1)).toBe(rows[0]);
    expect(walkRows(rows, rows.at(-1)!, 1)).toBe(rows.at(-1));
    expect(walkRows(rows, rows[0], 1)).toBe(rows[1]);
    expect(rowIds(text)).toEqual([]);
  });
});

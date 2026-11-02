import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_STOPS,
  DEFAULT_CONFIDENCE,
  authorChoice,
  authorRecall,
  clampConfidence,
  coerceCorrect,
  displayOptions,
  gradeAnswer,
  isCorrectSelection,
  needsReveal,
  normaliseOptions,
  resolveCorrect,
  roleOf,
  seededShuffle,
  toClientQuestion,
} from "./questions.ts";
import type { ToolCallRef } from "../runtime/scans.ts";

const call = (name: string, args: Record<string, unknown>, id = "call_abc"): ToolCallRef => ({ messageId: "msg_1", contentIndex: 0, id, name, arguments: args });
const options = [
  { label: "Alpha", value: "a" },
  { label: "Beta", value: "b" },
  { label: "Gamma", value: "c" },
];
const quiz = (extra: Record<string, unknown> = {}) =>
  call("quiz", { type: "check", nodeId: "n1", question: "Which?", options, explanation: "Because.", correctAnswer: "b", ...extra });
const now = () => Date.UTC(2026, 10, 1);

describe("authoring a graded question (B-8-02, B-8-03)", () => {
  it("accepts a single select with a label, a value or a list of values", () => {
    expect(authorChoice({ question: "Q", options, correctAnswer: "a" }).ok).toBe(true);
    expect(authorChoice({ question: "Q", options, correctAnswer: "Beta" }).ok).toBe(true);
    const multi = authorChoice({ question: "Q", options, multiSelect: true, correctAnswer: ["a", "c"] });
    expect(multi.ok && multi.value.correct).toEqual(["a", "c"]);
    const stringy = authorChoice({ question: "Q", options: JSON.stringify(options), multiSelect: "true", correctAnswer: '["a","b"]' });
    expect(stringy.ok && stringy.value.correct).toEqual(["a", "b"]);
  });

  it("rejects a correct answer that is not among the options and names the valid values", () => {
    const r = authorChoice({ question: "Q", options, correctAnswer: "z" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/matches no option/);
    expect(!r.ok && r.error).toContain('"a", "b", "c"');
  });

  it("rejects several answers without multiSelect, repeated values, an empty label and a missing answer", () => {
    expect((authorChoice({ question: "Q", options, correctAnswer: ["a", "b"] }) as { error: string }).error).toMatch(/multiSelect/);
    expect((authorChoice({ question: "Q", options: [{ label: "A", value: "x" }, { label: "B", value: "x" }], correctAnswer: "x" }) as { error: string }).error).toMatch(/used twice/);
    expect((authorChoice({ question: "Q", options: [{ label: "A" }, { label: "  " }], correctAnswer: "A" }) as { error: string }).error).toMatch(/label is empty/);
    expect((authorChoice({ question: "Q", options, correctAnswer: "" }) as { error: string }).error).toMatch(/missing/);
    expect((authorChoice({ question: "Q", options: [{ label: "A" }], correctAnswer: "A" }) as { error: string }).error).toMatch(/at least two/);
    expect((authorChoice({ question: " ", options, correctAnswer: "a" }) as { error: string }).error).toMatch(/question is empty/);
  });

  it("matches an exact label before any cleanup, so a final full stop is kept (B-8-06)", () => {
    const opts = [
      { label: "It rises.", value: "x1" },
      { label: "It rises", value: "x2" },
    ];
    const exact = resolveCorrect(opts, "It rises.", false);
    expect(exact.ok && exact.values).toEqual(["x1"]);
    const cleaned = resolveCorrect(opts, '"It rises."', false);
    expect(cleaned.ok && cleaned.values.length).toBe(1);
    const quoted = resolveCorrect(options, "`b`", false);
    expect(quoted.ok && quoted.values).toEqual(["b"]);
  });

  it("requires a commitment for free recall and nothing else (B-8-14)", () => {
    expect(authorRecall({ question: "Q", correctAnswer: "  " }).ok).toBe(false);
    expect(authorRecall({ question: "Q", correctAnswer: " The answer. " })).toEqual({ ok: true, committed: "The answer." });
  });
});

describe("options and shuffling (B-8-04, B-8-05)", () => {
  it("trims labels, defaults the value, drops an empty label and throws on a repeated value", () => {
    const r = normaliseOptions([" One ", { label: " Two ", value: " v2 " }, { label: "" }, { label: "Three" }]);
    expect(r.ok && r.options).toEqual([
      { label: "One", value: "One" },
      { label: "Two", value: "v2" },
      { label: "Three", value: "Three" },
    ]);
    expect(normaliseOptions(["Same", "Same"]).ok).toBe(false);
  });

  it("coerces the correct answer from a string, a list or a JSON string", () => {
    expect(coerceCorrect("a")).toEqual(["a"]);
    expect(coerceCorrect(["a", " b "])).toEqual(["a", "b"]);
    expect(coerceCorrect('["a","b"]')).toEqual(["a", "b"]);
    expect(coerceCorrect("")).toBeNull();
    expect(coerceCorrect(undefined)).toBeNull();
  });

  it("shuffles by a seed without adding, removing or changing any option", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: `v${i}` }));
    const copy = JSON.stringify(list);
    const a = seededShuffle(list, "call_1");
    expect(JSON.stringify(list)).toBe(copy);
    expect(JSON.stringify(seededShuffle(list, "call_1"))).toBe(JSON.stringify(a));
    expect(JSON.stringify(seededShuffle(list, "call_2"))).not.toBe(JSON.stringify(a));
    expect([...a].sort((x, y) => x.value.localeCompare(y.value))).toEqual([...list].sort((x, y) => x.value.localeCompare(y.value)));
  });

  it("shuffles a graded question and keeps an open question in its authored order", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, value: `v${i}` }));
    expect(displayOptions(call("quiz", { options: many }, "call_x")).map((o) => o.value)).not.toEqual(many.map((o) => o.value));
    expect(displayOptions(call("ask_user_question", { options: many }, "call_x")).map((o) => o.value)).toEqual(many.map((o) => o.value));
  });
});

describe("confidence (B-8-08, B-8-09)", () => {
  it("has the six stops and rests at 50", () => {
    expect([...CONFIDENCE_STOPS]).toEqual([0, 30, 50, 70, 90, 100]);
    expect(DEFAULT_CONFIDENCE).toBe(50);
  });

  it("clamps to 0 to 100 and rounds, and treats a non number as absent", () => {
    expect(clampConfidence(-20)).toBe(0);
    expect(clampConfidence(250)).toBe(100);
    expect(clampConfidence(69.6)).toBe(70);
    expect(clampConfidence(Number.NaN)).toBeUndefined();
    expect(clampConfidence("90")).toBeUndefined();
  });
});

describe("grading (B-8-07, B-8-09, B-8-10, B-8-11)", () => {
  it("grades by the set of values in any order", () => {
    expect(isCorrectSelection(["b", "a"], ["a", "b"])).toBe(true);
    expect(isCorrectSelection(["a"], ["a", "b"])).toBe(false);
    expect(isCorrectSelection(["a", "c"], ["a", "b"])).toBe(false);
    expect(isCorrectSelection([], ["a"])).toBe(false);
  });

  it("grades a quiz against the committed answer with display indices and a clamped confidence", () => {
    const q = quiz();
    const display = displayOptions(q);
    const { content, details } = gradeAnswer(q, { values: ["b"], confidence: 250, thinking: " because of beta ", readingThinking: "hm" }, now);
    expect(details.correct).toBe(true);
    expect(details.confidence).toBe(100);
    expect(details.answers).toEqual([{ label: "Beta", value: "b", index: display.findIndex((o) => o.value === "b") + 1 }]);
    expect(details.correctIndices).toEqual([display.findIndex((o) => o.value === "b") + 1]);
    expect(details.options).toEqual(display.map((o) => ({ label: o.label, value: o.value })));
    expect(details.questionType).toBe("check");
    expect(details.explanation).toBe("Because.");
    expect(details.thinking).toBe("because of beta");
    expect(details.readingThinking).toBe("hm");
    expect(content).toContain("Verdict: correct.");
    expect(content).toContain("Stated confidence: 100 per cent.");
    // nothing the model authored about the correct answer or the explanation is echoed back
    expect(content).not.toContain("Because.");
  });

  it("marks a wrong choice and ignores an option value that the question does not hold", () => {
    const { details } = gradeAnswer(quiz(), { values: ["a", "zzz"], confidence: 90 }, now);
    expect(details.correct).toBe(false);
    expect(details.answers.map((a) => a.value)).toEqual(["a"]);
  });

  it("treats the not known option as never correct, with no answers and no confidence", () => {
    const { content, details } = gradeAnswer(quiz(), { dontKnow: true, values: ["b"], confidence: 90 }, now);
    expect(details.dontKnow).toBe(true);
    expect(details.correct).toBeUndefined();
    expect(details.answers).toEqual([]);
    expect(details.confidence).toBeUndefined();
    expect(content).toMatch(/not known/);
    expect(content).not.toMatch(/Verdict/);
  });

  it("never grades an open question and carries no confidence on it", () => {
    const ask = call("ask_user_question", { question: "Which direction?", options: [{ label: "North", value: "n", description: "up" }, { label: "South", value: "s" }] });
    const { details } = gradeAnswer(ask, { values: ["n"], confidence: 70, other: "somewhere" }, now);
    expect(details.kind).toBe("ask");
    expect(details.correct).toBeUndefined();
    expect(details.confidence).toBeUndefined();
    expect(details.other).toBe("somewhere");
  });

  it("never grades free recall, keeps the commitment in details and the learner's words in the compact form", () => {
    const explain = call("explain", { type: "predict", nodeId: "n1", question: "Why?", correctAnswer: "Because of X." });
    const { content, details } = gradeAnswer(explain, { text: "Maybe Y.", confidence: 80 }, now);
    expect(details.kind).toBe("explain");
    expect(details.correct).toBeUndefined();
    expect(details.committed).toBe("Because of X.");
    expect(details.questionType).toBe("predict");
    expect(details.confidence).toBeUndefined();
    expect(content).toContain("Maybe Y.");
    expect(content).not.toContain("Because of X.");
  });

  it("records the target of the call", () => {
    const { details } = gradeAnswer(quiz({ target: ["n_a1", "n_b2"] }), { values: ["b"] }, now);
    expect(details.target).toEqual(["n_a1", "n_b2"]);
  });
});

describe("roles and the client view (B-8-12, B-8-15)", () => {
  it("makes a prediction only for the exact literal and degrades the rest to a check", () => {
    expect(roleOf({ type: "predict" })).toBe("predict");
    for (const wobble of ["Predict", "predict ", "prediction", "", undefined]) expect(roleOf({ type: wobble })).toBe("check");
  });

  it("collapses a teach check behind a button and never a prediction or a probe question", () => {
    expect(needsReveal("quiz", { type: "check" })).toBe(true);
    expect(needsReveal("explain", { type: "check" })).toBe(true);
    expect(needsReveal("quiz", { type: "predict" })).toBe(false);
    expect(needsReveal("probe", {})).toBe(false);
    expect(needsReveal("ask_user_question", {})).toBe(false);
  });

  it("never exposes the correct indices, the correct answer or the explanation", () => {
    const view = toClientQuestion(quiz());
    const json = JSON.stringify(view);
    expect(json).not.toContain("Because.");
    expect(json).not.toContain("correct");
    expect(view.options).toHaveLength(3);
    expect(view.collapsed).toBe(true);
    expect(view.nodeId).toBe("n1");
    expect(toClientQuestion(call("mystery_tool", { question: "Q" })).kind).toBe("ask");
    expect(toClientQuestion(call("explain", { question: "Q", correctAnswer: "secret" })).options).toBeUndefined();
    expect(JSON.stringify(toClientQuestion(call("explain", { question: "Q", correctAnswer: "secret" })))).not.toContain("secret");
  });
});

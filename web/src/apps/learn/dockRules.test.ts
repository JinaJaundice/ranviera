import { describe, expect, it } from "vitest";
import { areaCeiling, arrival, composerButton, dockStateKey, dockVariant, enterAction, enterSubmits, escTarget, foldDecision } from "./dockRules";
import { countWords, findMatches, stepMatch } from "./find";
import { Starter, buildCreate, canStart, draftKey, isSetupRefusal, setupNotice, titleOf } from "./draft";

describe("the dock fold (B-9-62, B-9-63, B-9-67)", () => {
  const base = { atBottom: false, folded: false, mutedUntil: 0, now: 1000 };

  it("folds beyond 96px when the reader is not at the bottom, and expands within 16px", () => {
    expect(foldDecision({ ...base, distance: 120 })).toBe("fold");
    expect(foldDecision({ ...base, distance: 96 })).toBe("keep");
    expect(foldDecision({ ...base, distance: 120, atBottom: true })).toBe("keep");
    expect(foldDecision({ ...base, folded: true, distance: 10 })).toBe("expand");
    expect(foldDecision({ ...base, folded: true, distance: 50 })).toBe("keep");
  });

  it("ignores scroll events in the mute window after a change of geometry", () => {
    expect(foldDecision({ ...base, distance: 500, mutedUntil: 1400 })).toBe("keep");
    expect(foldDecision({ ...base, distance: 500, mutedUntil: 900 })).toBe("fold");
  });

  it("changes its state key on a fold or a variant change and not on typing", () => {
    expect(dockStateKey("question", true, true)).not.toBe(dockStateKey("question", true, false));
    expect(dockStateKey("composer", false, true)).toBe(dockStateKey("composer", false, false));
    expect(dockStateKey("problem", true, true)).toBe(dockStateKey("problem", true, true));
  });

  it("opens a teaching check behind a reveal bar unless it follows another question", () => {
    expect(arrival({ collapsedKind: true, atBottom: true, followsQuestion: false })).toBe("reveal");
    expect(arrival({ collapsedKind: true, atBottom: true, followsQuestion: true })).toBe("open");
    expect(arrival({ collapsedKind: false, atBottom: true, followsQuestion: false })).toBe("open");
    expect(arrival({ collapsedKind: false, atBottom: false, followsQuestion: false })).toBe("folded");
  });

  it("shows the question, else the problem, else the composer", () => {
    expect(dockVariant({ pendingQuestion: true, activeProblem: true })).toBe("question");
    expect(dockVariant({ pendingQuestion: false, activeProblem: true })).toBe("problem");
    expect(dockVariant({ pendingQuestion: false, activeProblem: false })).toBe("composer");
  });

  it("never gives a negative ceiling to the area", () => {
    expect(areaCeiling(700, 100)).toBe(355);
    expect(areaCeiling(100, 400)).toBe(0);
  });
});

describe("the composer (B-9-14, B-9-15, B-9-16)", () => {
  it("steers while busy with text, stops while busy and empty, sends when idle", () => {
    expect(enterAction({ busy: true, hasText: true, blocked: false, pause: false })).toBe("steer");
    expect(enterAction({ busy: true, hasText: false, blocked: false, pause: false })).toBe("stop-prompt");
    expect(enterAction({ busy: false, hasText: true, blocked: false, pause: false })).toBe("send");
    expect(enterAction({ busy: false, hasText: false, blocked: false, pause: true })).toBe("next");
    expect(enterAction({ busy: false, hasText: false, blocked: false, pause: false })).toBe("none");
    expect(enterAction({ busy: false, hasText: true, blocked: true, pause: false })).toBe("none");
  });

  it("morphs the button and lets busy outrank the pause", () => {
    expect(composerButton({ busy: false, hasText: false, pause: false })).toBe("disabled");
    expect(composerButton({ busy: false, hasText: false, pause: true })).toBe("next");
    expect(composerButton({ busy: false, hasText: true, pause: true })).toBe("send");
    expect(composerButton({ busy: true, hasText: false, pause: true })).toBe("stop");
    expect(composerButton({ busy: true, hasText: true, pause: false })).toBe("steer");
  });
});

describe("Escape and Enter (B-9-68, B-9-69)", () => {
  it("chooses the topmost layer and does nothing while the confirmation is open", () => {
    const none = { confirmOpen: false, plan: false, setup: false, question: false, problem: false, busy: false };
    expect(escTarget({ ...none, confirmOpen: true, plan: true })).toBeNull();
    expect(escTarget({ ...none, plan: true, question: true, busy: true })).toBe("plan");
    expect(escTarget({ ...none, question: true, busy: true })).toBe("question");
    expect(escTarget({ ...none, problem: true, busy: true })).toBe("problem");
    expect(escTarget({ ...none, busy: true })).toBe("turn");
    expect(escTarget(none)).toBeNull();
  });

  it("submits on a plain Enter outside a field and a pointer focused button, and leaves a keyboard focused button its own Enter", () => {
    const t = { tag: "div", editable: false, keyboardFocusedButton: false, inOverlay: false, modified: false };
    expect(enterSubmits(t)).toBe(true);
    expect(enterSubmits({ ...t, tag: "button" })).toBe(true);
    expect(enterSubmits({ ...t, tag: "button", keyboardFocusedButton: true })).toBe(false);
    expect(enterSubmits({ ...t, tag: "button", inOverlay: true })).toBe(false);
    expect(enterSubmits({ ...t, tag: "textarea" })).toBe(false);
    expect(enterSubmits({ ...t, editable: true })).toBe(false);
    expect(enterSubmits({ ...t, modified: true })).toBe(false);
  });
});

describe("find in session (B-9-85)", () => {
  it("matches literal text without case, treats pattern characters as plain, and uses UTF-16 offsets", () => {
    expect(findMatches("Cat cat CAT", "cat")).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(findMatches("a.b a*b axb", "a.b")).toEqual([[0, 3]]);
    expect(findMatches("x (a) y", "(a)")).toEqual([[2, 5]]);
    expect(findMatches("😀 hit", "hit")).toEqual([[3, 6]]);
    expect(findMatches("anything", "")).toEqual([]);
  });

  it("steps with wrap and reads the count in words", () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
    expect(countWords(1, 7, "x")).toBe("2 of 7");
    expect(countWords(-1, 0, "x")).toBe("No matches");
    expect(countWords(0, 0, "")).toBe("");
  });
});

describe("a new session (B-9-17, B-9-19, B-9-23)", () => {
  const teach = { text: "  Teach me about fractions  ", kind: "teach" as const, picks: [] };

  it("titles the session with the first message and sends no kind and no settings for a teaching session", () => {
    expect(buildCreate(teach)).toEqual({ title: "Teach me about fractions" });
    expect(titleOf("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("carries picks as graph context with the practice kind, and none for a practice session without picks", () => {
    expect(buildCreate({ text: "Drill", kind: "practice", picks: ["n_1", "n_2", "n_1"] })).toEqual({ title: "Drill", kind: "practice", graphContext: { propositions: ["n_1", "n_2"] } });
    expect(buildCreate({ text: "Drill", kind: "practice", picks: [] })).toEqual({ title: "Drill", kind: "practice" });
    expect(buildCreate({ text: "Drill", kind: "teach", picks: ["n_1"] }).graphContext).toBeUndefined();
    expect((buildCreate({ text: "x", kind: "practice", picks: Array.from({ length: 80 }, (_, i) => `n_${i}`) }).graphContext?.propositions ?? []).length).toBe(64);
  });

  it("creates nothing for an empty message", async () => {
    let made = 0;
    const s = new Starter();
    expect(canStart({ ...teach, text: "   " })).toBe(false);
    expect(await s.start({ ...teach, text: "  " }, async () => (made++, { id: "x" }))).toBeNull();
    expect(made).toBe(0);
  });

  it("reuses the created session for an unchanged draft and creates a new one when text, mode or picks change", async () => {
    let made = 0;
    const create = async () => ({ id: `chat_${++made}` });
    const s = new Starter();
    expect(await s.start(teach, create)).toBe("chat_1");
    expect(await s.start({ ...teach }, create)).toBe("chat_1");
    expect(await s.start({ ...teach, text: "Different" }, create)).toBe("chat_2");
    expect(await s.start({ ...teach, text: "Different", kind: "practice" }, create)).toBe("chat_3");
    expect(await s.start({ ...teach, text: "Different", kind: "practice", picks: ["n_1"] }, create)).toBe("chat_4");
    expect(made).toBe(4);
    expect(draftKey({ ...teach, picks: ["b", "a"] })).toBe(draftKey({ ...teach, picks: ["a", "b"] }));
  });

  it("words the setup notices and names the informational refusals", () => {
    expect(setupNotice("keys")).toBe("Add a provider key");
    expect(setupNotice("models")).toBe("Choose your models");
    expect(setupNotice(null)).toBeNull();
    expect(isSetupRefusal("models_not_configured")).toBe(true);
    expect(isSetupRefusal("turn_running")).toBe(false);
  });
});

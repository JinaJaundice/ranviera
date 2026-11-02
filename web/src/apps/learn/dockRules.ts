// The rules of the dock, as pure functions: which variant it shows, when it folds, how a question arrives, what Enter
// does in the composer and which layer the Escape key belongs to.

export const FOLD_DISTANCE = 96;
export const EXPAND_DISTANCE = 16;
export const MUTE_MS = 400;
/**
 * A question or problem may take at most this share of the height of the window before its own options scroll. The
 * confidence control and the thinking field stay in view below the options and share this budget, so the share is 0.65
 * and the transcript keeps more than a third of the window (2 November 2026).
 */
export const QUESTION_SHARE = 0.65;

export type DockVariant = "composer" | "question" | "problem";

export interface Foldable {
  pendingQuestion: boolean;
  activeProblem: boolean;
}

/** The dock shows the question, else the practice problem, else the composer. */
export function dockVariant(s: Foldable): DockVariant {
  if (s.pendingQuestion) return "question";
  if (s.activeProblem) return "problem";
  return "composer";
}

/**
 * Folding follows the position of the reader. Scrolling more than 96px away from the bottom folds the dock, and coming back
 * within 16px opens it. Scroll events inside the mute window after a change of geometry are ignored, so growth of the
 * transcript does not fold the dock by itself. The fold needs both the distance and the flag that the reader is not at the bottom.
 */
export function foldDecision(i: { distance: number; atBottom: boolean; folded: boolean; mutedUntil: number; now: number }): "fold" | "expand" | "keep" {
  if (i.now < i.mutedUntil) return "keep";
  if (!i.folded && i.distance > FOLD_DISTANCE && !i.atBottom) return "fold";
  if (i.folded && i.distance <= EXPAND_DISTANCE) return "expand";
  return "keep";
}

/** The change of this key is what animates the height of the dock. Typing does not change it. */
export const dockStateKey = (mode: DockVariant, docked: boolean, expanded: boolean): string => (docked ? `${mode}:${expanded ? "open" : "folded"}` : `${mode}:-`);

export type Arrival = "open" | "reveal" | "folded";

/** A graded teaching check waits behind a reveal bar, unless it follows another question. Any other question opens at the bottom and folds in history. */
export function arrival(i: { collapsedKind: boolean; atBottom: boolean; followsQuestion: boolean }): Arrival {
  if (i.collapsedKind) return i.followsQuestion ? "open" : "reveal";
  return i.atBottom ? "open" : "folded";
}

export type EnterAction = "steer" | "stop-prompt" | "send" | "next" | "none";

/** What Enter does in the composer. Busy outranks the practice pause, so that Stop stays reachable. */
export function enterAction(i: { busy: boolean; hasText: boolean; blocked: boolean; pause: boolean }): EnterAction {
  if (i.blocked) return "none";
  if (i.busy) return i.hasText ? "steer" : "stop-prompt";
  if (i.hasText) return "send";
  if (i.pause) return "next";
  return "none";
}

export type ComposerButton = "send" | "steer" | "stop" | "next" | "disabled";

export function composerButton(i: { busy: boolean; hasText: boolean; pause: boolean }): ComposerButton {
  if (i.busy) return i.hasText ? "steer" : "stop";
  if (i.hasText) return "send";
  return i.pause ? "next" : "disabled";
}

export type EscTarget = "plan" | "setup" | "question" | "problem" | "turn" | null;

/** The window level fallback of the Escape key, from the topmost layer down. Only a confirmation performs the action. */
export function escTarget(i: { confirmOpen: boolean; plan: boolean; setup: boolean; question: boolean; problem: boolean; busy: boolean }): EscTarget {
  if (i.confirmOpen) return null;
  if (i.plan) return "plan";
  if (i.setup) return "setup";
  if (i.question) return "question";
  if (i.problem) return "problem";
  if (i.busy) return "turn";
  return null;
}

/** The ceiling of the area of a question or problem, as pixels, for a window of a given height. Never negative. */
export function areaCeiling(windowHeight: number, chromeHeight: number): number {
  return Math.max(0, Math.floor(windowHeight * QUESTION_SHARE) - Math.max(0, chromeHeight));
}

/** Whether a plain Enter outside a typing surface should submit. A focused button keeps its own Enter when the focus came from the keyboard. */
export function enterSubmits(t: { tag: string; editable: boolean; keyboardFocusedButton: boolean; inOverlay: boolean; modified: boolean }): boolean {
  if (t.modified) return false;
  if (t.editable || ["input", "textarea", "select"].includes(t.tag)) return false;
  if (t.tag === "button" && (t.keyboardFocusedButton || t.inOverlay)) return false;
  return true;
}

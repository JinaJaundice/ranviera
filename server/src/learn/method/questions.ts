// The question core: the authoring rules for a graded question, a seeded
// shuffle of the display order, the resolution of the correct answer, the
// grading of a learner answer and the compact form that the model reads. All of
// it is pure. Grading is by the set of option values, so that it does not
// depend on the order in which the learner saw the options.
import type { AnswerDetails, AnswerRequest } from "../../../../shared/learn/index.ts";
import type { ToolCallRef } from "../runtime/scans.ts";

/** The stops of the confidence rail, with resolution concentrated at the top. */
export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100] as const;
export const DEFAULT_CONFIDENCE = 50;

/** Clamps to 0 to 100 and rounds. A value that is not a finite number is absent. */
export const clampConfidence = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : undefined;

/** 32 bit FNV-1a hash of a string. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A small seeded generator (mulberry32), so that a question keeps its order across reloads. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle that returns a new list with the same members, keyed by the seed. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = generator(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
};

/**
 * Normalises raw options. Labels are trimmed, a missing value defaults to the
 * label, an empty label is dropped and a repeated value is an error. A JSON
 * string of an array is parsed first.
 */
export function normaliseOptions(raw: unknown): { ok: true; options: ChoiceOption[] } | { ok: false; error: string } {
  const list = parseJson(raw);
  if (!Array.isArray(list)) return { ok: false, error: "The options must be a list of at least two options." };
  const out: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let label = "";
    let value = "";
    let description: string | undefined;
    if (typeof item === "string") {
      label = item.trim();
      value = label;
    } else if (item && typeof item === "object") {
      const o = item as { label?: unknown; value?: unknown; description?: unknown };
      label = typeof o.label === "string" ? o.label.trim() : "";
      value = typeof o.value === "string" && o.value.trim() ? o.value.trim() : label;
      if (typeof o.description === "string" && o.description.trim()) description = o.description.trim();
    }
    if (!label) continue;
    if (seen.has(value)) return { ok: false, error: `The option value "${value}" is used twice. Give each option a distinct value.` };
    seen.add(value);
    out.push({ label, value, ...(description ? { description } : {}) });
  }
  return { ok: true, options: out };
}

/** Checks the raw labels of an authored question, because normalising drops an empty label silently. */
function emptyLabel(raw: unknown): boolean {
  const list = parseJson(raw);
  if (!Array.isArray(list)) return false;
  return list.some((o) => (typeof o === "string" ? !o.trim() : !o || typeof o !== "object" || typeof (o as { label?: unknown }).label !== "string" || !(o as { label: string }).label.trim()));
}

/** Removes the debris that a model puts around a value: wrapping quotes, backticks, a final full stop or colon. */
function stripDebris(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/^(["'`])(.*)\1$/s, "$2").replace(/[.:;,]+$/, "").trim();
    if (t === before) break;
  }
  return t;
}

/** The correct answer as a list of strings: a string, a list, or a JSON string of a list. */
export function coerceCorrect(raw: unknown): string[] | null {
  const parsed = parseJson(raw);
  if (typeof parsed === "string") return parsed.trim() ? [parsed.trim()] : null;
  if (Array.isArray(parsed)) {
    const list = parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    return list.length ? list : null;
  }
  return null;
}

/**
 * Resolves the correct answer to option values. An exact match on a value or a
 * label comes first, so that a label that ends in a full stop is never
 * redirected to another option. Only then is the debris cleaned.
 */
export function resolveCorrect(options: ChoiceOption[], raw: unknown, multiSelect: boolean): { ok: true; values: string[] } | { ok: false; error: string } {
  const wanted = coerceCorrect(raw);
  const valid = options.map((o) => `"${o.value}"`).join(", ");
  if (!wanted) return { ok: false, error: `The correct answer is missing. Give the value of the correct option. Valid values are ${valid}.` };
  const values: string[] = [];
  for (const w of wanted) {
    const exact = options.find((o) => o.value === w) ?? options.find((o) => o.label === w);
    const found =
      exact ??
      (() => {
        const cleaned = stripDebris(w).toLowerCase();
        return options.find((o) => stripDebris(o.value).toLowerCase() === cleaned) ?? options.find((o) => stripDebris(o.label).toLowerCase() === cleaned);
      })();
    if (!found) return { ok: false, error: `The correct answer "${w}" matches no option. Valid values are ${valid}.` };
    if (!values.includes(found.value)) values.push(found.value);
  }
  if (values.length > 1 && !multiSelect) return { ok: false, error: "Several correct answers need multiSelect set to true. Set it, or give one correct answer." };
  return { ok: true, values };
}

export interface AuthoredChoice {
  options: ChoiceOption[];
  correct: string[];
  multiSelect: boolean;
}

/** The authoring rules of a graded multiple choice question. The rules mirror the grading path, so a valid question can be graded. */
export function authorChoice(args: Record<string, unknown>): { ok: true; value: AuthoredChoice } | { ok: false; error: string } {
  if (typeof args.question !== "string" || !args.question.trim()) return { ok: false, error: "The question is empty. Write the question text." };
  if (emptyLabel(args.options)) return { ok: false, error: "An option label is empty. Give every option a label." };
  const normalised = normaliseOptions(args.options);
  if (!normalised.ok) return normalised;
  if (normalised.options.length < 2) return { ok: false, error: "A graded question needs at least two options." };
  const multiSelect = parseBoolean(args.multiSelect);
  const correct = resolveCorrect(normalised.options, args.correctAnswer, multiSelect);
  if (!correct.ok) return correct;
  return { ok: true, value: { options: normalised.options, correct: correct.values, multiSelect } };
}

export function parseBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}

/** The authoring rule of free recall: the commitment is the only field that can be wrong. */
export function authorRecall(args: Record<string, unknown>): { ok: true; committed: string } | { ok: false; error: string } {
  if (typeof args.question !== "string" || !args.question.trim()) return { ok: false, error: "The question is empty. Write the question text." };
  if (typeof args.correctAnswer !== "string" || !args.correctAnswer.trim()) {
    return { ok: false, error: "The correct answer is empty. Write the full answer with its reasoning before the learner sees the question." };
  }
  return { ok: true, committed: args.correctAnswer.trim() };
}

/** The role of a teach question. Only the exact literal predict makes a prediction, and anything else degrades to a check. */
export const roleOf = (args: Record<string, unknown>): "predict" | "check" => (args.type === "predict" ? "predict" : "check");

const QUESTION_KIND: Record<string, AnswerDetails["kind"]> = { quiz: "quiz", probe: "quiz", recall: "explain", explain: "explain", ask_user_question: "ask" };
/** Unknown tools fall to ask. */
export const kindOfTool = (tool: string): AnswerDetails["kind"] => QUESTION_KIND[tool] ?? "ask";

/** A graded teach question collapses behind a button, unless it is a prediction. Probe questions and open questions never collapse. */
export const needsReveal = (tool: string, args: Record<string, unknown>): boolean => (tool === "quiz" || tool === "explain") && roleOf(args) !== "predict";

/** The options in the order that the learner sees. Graded questions are shuffled by the call identifier. An open question keeps its order. */
export function displayOptions(call: Pick<ToolCallRef, "id" | "name" | "arguments">): ChoiceOption[] {
  const normalised = normaliseOptions(call.arguments.options);
  if (!normalised.ok) return [];
  return kindOfTool(call.name) === "quiz" ? seededShuffle(normalised.options, call.id) : normalised.options;
}

export interface ClientQuestion {
  kind: AnswerDetails["kind"];
  tool: string;
  questionType?: "predict" | "check";
  nodeId?: string;
  question: string;
  details?: string;
  options?: { label: string; value: string; description?: string }[];
  multiSelect: boolean;
  /** true when the window shows the question behind a button */
  collapsed: boolean;
}

/** What the window may know about a question. It never carries the correct indices, the correct answer or the explanation. */
export function toClientQuestion(call: Pick<ToolCallRef, "id" | "name" | "arguments">): ClientQuestion {
  const kind = kindOfTool(call.name);
  const a = call.arguments;
  const options = kind === "explain" ? undefined : displayOptions(call);
  return {
    kind,
    tool: call.name,
    ...(call.name === "quiz" || call.name === "explain" ? { questionType: roleOf(a) } : {}),
    ...(typeof a.nodeId === "string" && a.nodeId ? { nodeId: a.nodeId } : {}),
    question: typeof a.question === "string" ? a.question : "",
    ...(typeof a.details === "string" && a.details ? { details: a.details } : {}),
    ...(options ? { options: options.map((o) => ({ label: o.label, value: o.value, ...(kind === "ask" && o.description ? { description: o.description } : {}) })) } : {}),
    multiSelect: parseBoolean(a.multiSelect),
    collapsed: needsReveal(call.name, a),
  };
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v) => b.includes(v)) && new Set(a).size === a.length;

/** A selection is correct only when its set equals the answer set, in any order. */
export const isCorrectSelection = (selected: string[], correct: string[]): boolean => selected.length > 0 && sameSet(selected, correct);

const trimmed = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Grades an answer and builds the two forms of the result: the compact text
 * that the model reads, and the full details that the window keeps. A choice
 * is graded against the committed answer of the call. An open question and a
 * free recall answer are never graded here.
 */
export function gradeAnswer(call: ToolCallRef, answer: AnswerRequest, now: () => number): { content: string; details: AnswerDetails } {
  const kind = kindOfTool(call.name);
  const a = call.arguments;
  const display = kind === "explain" ? [] : displayOptions(call);
  const questionText = typeof a.question === "string" ? a.question : "";
  const requested = Array.isArray(answer.values) ? answer.values.filter((v): v is string => typeof v === "string") : [];
  // an option value that the question does not hold is ignored
  const picked = answer.dontKnow ? [] : [...new Set(requested)].filter((v) => display.some((o) => o.value === v));
  const answers = picked.map((value) => {
    const idx = display.findIndex((o) => o.value === value);
    return { label: display[idx].label, value, index: idx + 1 };
  });
  const details: AnswerDetails = {
    kind,
    tool: call.name as AnswerDetails["tool"],
    ...(call.name === "quiz" || call.name === "explain" ? { questionType: roleOf(a) } : {}),
    questionText,
    ...(kind !== "explain" ? { options: display.map((o) => ({ label: o.label, value: o.value })) } : {}),
    answers,
    answeredAt: new Date(now()).toISOString(),
  };
  const text = trimmed(answer.text);
  const other = trimmed(answer.other);
  const thinking = trimmed(answer.thinking);
  const reading = trimmed(answer.readingThinking);
  if (text) details.text = text;
  if (other) details.other = other;
  if (thinking) details.thinking = thinking;
  if (reading) details.readingThinking = reading;
  if (answer.dontKnow) details.dontKnow = true;
  // confidence belongs to graded multiple choice only, and the not known option sends none
  else if (kind === "quiz") {
    const c = clampConfidence(answer.confidence);
    if (c !== undefined) details.confidence = c;
  }
  if (Array.isArray(a.target) && a.target.length > 0 && a.target.every((t) => typeof t === "string")) details.target = a.target as string[];

  if (kind === "quiz") {
    const normalised = normaliseOptions(a.options);
    const resolved = normalised.ok ? resolveCorrect(normalised.options, a.correctAnswer, parseBoolean(a.multiSelect)) : null;
    if (resolved && resolved.ok) {
      details.correctIndices = resolved.values.map((v) => display.findIndex((o) => o.value === v) + 1).filter((i) => i > 0);
      if (!answer.dontKnow) details.correct = isCorrectSelection(picked, resolved.values);
    }
    if (typeof a.explanation === "string" && a.explanation.trim()) details.explanation = a.explanation.trim();
  }
  if (kind === "explain" && typeof a.correctAnswer === "string" && a.correctAnswer.trim()) details.committed = a.correctAnswer.trim();

  const parts: string[] = [];
  if (answer.dontKnow) parts.push(kind === "ask" ? "The learner chose the option for not knowing." : "The learner chose the not known option. This is a gap in knowledge and not a wrong answer.");
  else if (answers.length) parts.push(`The learner selected ${answers.map((x) => `"${x.label}"`).join(", ")}.`);
  if (details.correct !== undefined) parts.push(details.correct ? "Verdict: correct." : "Verdict: not correct.");
  if (details.confidence !== undefined) parts.push(`Stated confidence: ${details.confidence} per cent.`);
  if (text) parts.push(`The learner wrote: ${text}`);
  if (other) parts.push(`The learner added: ${other}`);
  if (thinking) parts.push(`The learner's thinking about the question: ${thinking}`);
  if (reading) parts.push(`The learner's thinking while reading the teaching: ${reading}`);
  return { content: parts.join(" ") || "The learner answered with no selection.", details };
}

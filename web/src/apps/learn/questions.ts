// Questions in the Learn window: how a question tool call is read for display, the key that a draft hangs on, and the logic
// of the question form (the choice rows, the not known option, the confidence stops and the answer that is sent). Everything
// here is pure. The correct answer and the explanation sit in the call arguments of the record, and nothing here returns them.
import type { AnswerRequest, AssistantMessage, NativeMessage, ToolResultMessage } from "@shared/learn/sessions";

export const QUESTION_TOOLS = ["quiz", "probe", "explain", "recall", "ask_user_question"] as const;
export const isQuestionTool = (name: string): boolean => (QUESTION_TOOLS as readonly string[]).includes(name);

/** The stops of the confidence control and its resting value. */
export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100] as const;
export const DEFAULT_CONFIDENCE_INDEX = 2;
export const DEFAULT_CONFIDENCE = 50;

/** The index of the stop that is nearest to a value. A tie takes the lower stop, and a value outside 0 to 100 is clamped first. */
export function nearestStop(value: number): number {
  const v = Math.min(100, Math.max(0, Number.isFinite(value) ? value : DEFAULT_CONFIDENCE));
  const gaps = CONFIDENCE_STOPS.map((stop) => Math.abs(stop - v));
  return gaps.indexOf(Math.min(...gaps));
}

/** A drag position as a fraction of the rail, snapped to a stop. */
export const stopFromFraction = (fraction: number): number => nearestStop(Math.min(1, Math.max(0, fraction)) * 100);

/** One step through the stops, clamped at both ends. */
export const stepStop = (index: number, dir: -1 | 1): number => Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, index + dir));

/** 32 bit FNV-1a hash and a small seeded generator, so that the order of the options is the same on the server and here. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Choice {
  label: string;
  value: string;
  description?: string;
}

function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if (!t.startsWith("[")) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

/** Options as a model wrote them: a string, or an object with a label, a value and a description. Null when the list cannot be read. */
export function readOptions(raw: unknown): Choice[] | null {
  const list = parseMaybeJson(raw);
  if (!Array.isArray(list)) return null;
  const out: Choice[] = [];
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
    if (seen.has(value)) return null;
    seen.add(value);
    out.push({ label, value, ...(description ? { description } : {}) });
  }
  return out;
}

export type QuestionKind = "quiz" | "ask" | "explain";

export const kindOfTool = (tool: string): QuestionKind => (tool === "quiz" || tool === "probe" ? "quiz" : tool === "explain" || tool === "recall" ? "explain" : "ask");

/** The word above a question. */
export function questionLabel(tool: string, questionType?: string): string {
  if (tool === "probe") return "Probe";
  if (tool === "recall") return "Recall";
  if (tool === "explain") return "Explain";
  if (tool === "ask_user_question") return "Question";
  return questionType === "predict" ? "Prediction" : "Check";
}

/** What the window may know about a question. It carries no correct answer and no explanation. */
export interface ClientQuestion {
  tool: string;
  kind: QuestionKind;
  label: string;
  questionType?: "predict" | "check";
  nodeId?: string;
  question: string;
  details?: string;
  /** in display order, absent for a free text question */
  options?: Choice[];
  multiSelect: boolean;
  /** a graded teaching check waits behind a button, unless it is a prediction */
  collapsed: boolean;
}

const asBool = (v: unknown): boolean => v === true || v === "true";

/** Reads a question call for display, or null when its arguments cannot be shown. */
export function toClientQuestion(call: { id: string; name: string; arguments: Record<string, unknown> }): ClientQuestion | null {
  const a = call.arguments ?? {};
  const kind = kindOfTool(call.name);
  const question = typeof a.question === "string" ? a.question.trim() : "";
  if (!question) return null;
  let options: Choice[] | undefined;
  if (kind === "quiz") {
    const read = readOptions(a.options);
    if (!read || read.length < 2) return null;
    options = seededShuffle(read, call.id).map(({ label, value }) => ({ label, value }));
  } else if (kind === "ask" && a.options !== undefined && a.options !== null) {
    const read = readOptions(a.options);
    if (!read) return null;
    options = read.length ? read : undefined;
  }
  const questionType = call.name === "quiz" || call.name === "explain" ? (a.type === "predict" ? "predict" : "check") : undefined;
  return {
    tool: call.name,
    kind,
    label: questionLabel(call.name, questionType),
    ...(questionType ? { questionType } : {}),
    ...(typeof a.nodeId === "string" && a.nodeId ? { nodeId: a.nodeId } : {}),
    question,
    ...(typeof a.details === "string" && a.details.trim() ? { details: a.details.trim() } : {}),
    ...(options ? { options } : {}),
    multiSelect: asBool(a.multiSelect),
    collapsed: (call.name === "quiz" || call.name === "explain") && questionType !== "predict",
  };
}

export type CallStatus = "answerable" | "streaming" | "malformed" | "failed";

export interface QuestionCall {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  messageId: string;
  contentIndex: number;
  status: CallStatus;
  /** the call id when it occurs once in settled history, otherwise the occurrence qualified form */
  key: string;
  question: ClientQuestion | null;
}

const isLocal = (id: string) => id.startsWith("c_");

/** A clean acknowledgement of a question call has no details. Only a real answer closes the call. */
export function isAnswer(r: ToolResultMessage): boolean {
  return !!r.details && typeof r.details === "object" && "kind" in (r.details as object);
}

export function answeredIds(messages: readonly NativeMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) if (m.role === "toolResult" && (isAnswer(m) || !isQuestionTool(m.toolName))) out.add(m.toolCallId);
  return out;
}

function statusOf(msg: AssistantMessage, block: { arguments: Record<string, unknown>; name: string; id: string }, streaming: boolean): CallStatus {
  const stop = msg.stopReason;
  if (stop === "error" || stop === "aborted") return "failed";
  if (streaming || stop === "pending") return "streaming";
  if (stop === "length" || (block as { argumentsError?: unknown }).argumentsError) return "malformed";
  return toClientQuestion(block) ? "answerable" : "malformed";
}

/** The question calls of the newest assistant message that have no answer, with their status. Older messages never own a question. */
export function questionCallsOf(messages: readonly NativeMessage[], streamingIds: ReadonlySet<string> = new Set()): QuestionCall[] {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      at = i;
      break;
    }
  }
  if (at < 0) return [];
  const msg = messages[at] as AssistantMessage;
  const done = answeredIds(messages.slice(at + 1));
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "assistant" || isLocal(m.id)) continue;
    for (const b of m.content) if (b.type === "toolCall") counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
  }
  const out: QuestionCall[] = [];
  msg.content.forEach((b, contentIndex) => {
    if (b.type !== "toolCall" || !isQuestionTool(b.name) || done.has(b.id)) return;
    const key = (counts.get(b.id) ?? 0) > 1 ? JSON.stringify([msg.id, contentIndex, b.id]) : b.id;
    out.push({ toolCallId: b.id, tool: b.name, args: b.arguments, messageId: msg.id, contentIndex, status: statusOf(msg, b, streamingIds.has(msg.id)), key, question: toClientQuestion(b) });
  });
  return out;
}

/** The pending question is the first answerable call. A valid sibling takes precedence over a malformed one. */
export function pendingQuestionOf(messages: readonly NativeMessage[], streamingIds?: ReadonlySet<string>): QuestionCall | null {
  return questionCallsOf(messages, streamingIds).find((c) => c.status === "answerable") ?? null;
}

export function malformedQuestionsOf(messages: readonly NativeMessage[], streamingIds?: ReadonlySet<string>): QuestionCall[] {
  return questionCallsOf(messages, streamingIds).filter((c) => c.status === "malformed");
}

/* The form ------------------------------------------------------------------------------------------------------ */

export const DONT_KNOW = "__dont_know";
export const OTHER = "__other";

export interface FormState {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
  dontKnow: boolean;
  text: string;
  thinking: string;
  confidenceIdx: number;
}

export const emptyForm = (): FormState => ({ selected: [], otherSelected: false, otherText: "", dontKnow: false, text: "", thinking: "", confidenceIdx: DEFAULT_CONFIDENCE_INDEX });

/** A question is read in text mode when it has no options. */
export const isTextMode = (q: ClientQuestion): boolean => !q.options || q.options.length === 0;

/** Chooses or releases one option. A single choice replaces, a multiple choice toggles, and either way the not known option and Other are released as the brief sets out. */
export function toggleValue(f: FormState, q: ClientQuestion, value: string): FormState {
  const has = f.selected.includes(value);
  if (q.multiSelect) return { ...f, dontKnow: false, selected: has ? f.selected.filter((v) => v !== value) : [...f.selected, value] };
  return { ...f, dontKnow: false, otherSelected: false, selected: has ? [] : [value] };
}

export function toggleOther(f: FormState, q: ClientQuestion): FormState {
  if (q.multiSelect) return { ...f, otherSelected: !f.otherSelected };
  return { ...f, otherSelected: !f.otherSelected, selected: f.otherSelected ? f.selected : [], dontKnow: false };
}

/** Typing in Other selects the row. */
export function typeOther(f: FormState, q: ClientQuestion, text: string): FormState {
  return { ...(f.otherSelected ? f : toggleOther(f, q)), otherText: text };
}

export function toggleDontKnow(f: FormState): FormState {
  return f.dontKnow ? { ...f, dontKnow: false } : { ...f, dontKnow: true, selected: [], otherSelected: false };
}

/** Whether an answer exists. */
export function hasAnswer(f: FormState, q: ClientQuestion): boolean {
  if (isTextMode(q)) return f.text.trim().length > 0;
  if (f.dontKnow) return true;
  if (f.selected.length > 0) return true;
  return f.otherSelected && f.otherText.trim().length > 0;
}

/** The answer as it is sent. Confidence belongs to a graded choice and is absent when the not known option is chosen. */
export function buildAnswer(f: FormState, q: ClientQuestion, readingThinking?: string): AnswerRequest {
  const out: AnswerRequest = {};
  const thinking = f.thinking.trim();
  if (thinking) out.thinking = thinking;
  if (readingThinking && readingThinking.trim()) out.readingThinking = readingThinking.trim();
  if (isTextMode(q)) {
    out.text = f.text.trim();
    return out;
  }
  if (f.dontKnow) {
    out.dontKnow = true;
    return out;
  }
  if (f.selected.length) out.values = [...f.selected];
  if (f.otherSelected && f.otherText.trim()) out.other = f.otherText.trim();
  if (q.kind === "quiz") out.confidence = CONFIDENCE_STOPS[Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, f.confidenceIdx))];
  return out;
}

/** The ids of the rows that the arrow keys walk: the options, then the not known option or Other. */
export function rowIds(q: ClientQuestion): string[] {
  if (isTextMode(q)) return [];
  return [...(q.options ?? []).map((o) => o.value), q.kind === "quiz" ? DONT_KNOW : OTHER];
}

/** One step through the rows, clamped at both ends with no wrap. Before the first step the walk starts at the first row. */
export function walkRows(rows: readonly string[], current: string | null, dir: -1 | 1): string | null {
  if (!rows.length) return null;
  const at = current === null ? -1 : rows.indexOf(current);
  if (at < 0) return rows[dir === 1 ? 0 : rows.length - 1];
  return rows[Math.min(rows.length - 1, Math.max(0, at + dir))];
}

/** The selection state of the row that the walk stands on, as a click would change it. */
export function actOnRow(f: FormState, q: ClientQuestion, row: string): FormState {
  if (row === DONT_KNOW) return toggleDontKnow(f);
  if (row === OTHER) return toggleOther(f, q);
  return toggleValue(f, q, row);
}

/** The word under the thinking field and the hint beside it. */
export function thinkingLabel(q: ClientQuestion): string {
  return isTextMode(q) ? "Your answer" : "Your thinking";
}

/** One line of the question for a folded bar, with maths and Markdown marks reduced to plain words. */
export function teaser(question: string, max = 90): string {
  const flat = question
    .replace(/\$\$[\s\S]*?\$\$/g, " a formula ")
    .replace(/\$[^$\n]+\$/g, " a formula ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}...` : flat;
}

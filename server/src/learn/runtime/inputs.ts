// The messages that an input event adds to the record, and the messages that a
// silent dismissal adds. These are pure functions of the record and the input.
// A bad input throws a RuntimeError with status 400, before anything is written.
import type { AnswerDetails, AnswerRequest, CustomMessage, InputEvent, NativeMessage, ToolResultMessage, UserMessage } from "../../../../shared/learn/index.ts";
import { badRequest } from "./errors.ts";
import { newMessageId } from "./ids.ts";
import {
  QUESTION_TOOLS,
  activeProblemOf,
  danglingQuestions,
  failedTail,
  needsContinuation,
  toolCallsOf,
  type ToolCallRef,
} from "./scans.ts";

export const MAX_TEXT_CHARS = 100_000;

export interface InputContext {
  now: () => number;
  /** Replaces the default grader. The method phase supplies the grader that knows the committed answer and the display order. */
  grade?: (call: ToolCallRef, answer: AnswerRequest) => { content: string; details: AnswerDetails };
}

const kindOf = (tool: string): AnswerDetails["kind"] => (tool === "ask_user_question" ? "ask" : tool === "explain" || tool === "recall" ? "explain" : "quiz");

function optionsOf(call: ToolCallRef): { label: string; value: string }[] | undefined {
  const raw = call.arguments.options;
  if (!Array.isArray(raw)) return undefined;
  const out: { label: string; value: string }[] = [];
  for (const o of raw) {
    if (typeof o === "string") out.push({ label: o, value: o });
    else if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
      const label = (o as { label: string }).label;
      const value = (o as { value?: unknown }).value;
      out.push({ label, value: typeof value === "string" && value ? value : label });
    }
  }
  return out;
}

const clampConfidence = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : undefined;

/**
 * The graded answer. Grading here is by value: a choice is correct when the
 * chosen values equal the correct answer or answers of the call. The method
 * phase may replace this with a seeded shuffle aware grader through the same
 * result shape.
 */
export function buildAnswer(call: ToolCallRef, answer: AnswerRequest, ctx: InputContext): { content: string; details: AnswerDetails } {
  const options = optionsOf(call);
  const questionText = typeof call.arguments.question === "string" ? call.arguments.question : "";
  const values = Array.isArray(answer.values) ? answer.values.filter((v): v is string => typeof v === "string") : [];
  const answers = values.map((value) => {
    const idx = options?.findIndex((o) => o.value === value) ?? -1;
    return { label: options?.[idx]?.label ?? value, value, index: idx + 1 };
  });
  const details: AnswerDetails = {
    kind: kindOf(call.name),
    tool: call.name as AnswerDetails["tool"],
    ...(call.name === "quiz" && (call.arguments.type === "predict" || call.arguments.type === "check") ? { questionType: call.arguments.type } : {}),
    questionText,
    ...(options ? { options } : {}),
    answers,
    answeredAt: new Date(ctx.now()).toISOString(),
  };
  if (typeof answer.text === "string" && answer.text.trim()) details.text = answer.text.trim();
  if (typeof answer.other === "string" && answer.other.trim()) details.other = answer.other.trim();
  if (typeof answer.thinking === "string" && answer.thinking.trim()) details.thinking = answer.thinking.trim();
  if (typeof answer.readingThinking === "string" && answer.readingThinking.trim()) details.readingThinking = answer.readingThinking.trim();
  if (answer.dontKnow) details.dontKnow = true;
  else {
    const c = clampConfidence(answer.confidence);
    if (c !== undefined) details.confidence = c;
  }
  if (Array.isArray(call.arguments.target) && call.arguments.target.every((t) => typeof t === "string")) details.target = call.arguments.target as string[];
  const correct = call.arguments.correctAnswer;
  if (details.kind === "quiz" && !answer.dontKnow && options && correct !== undefined) {
    const wanted = (Array.isArray(correct) ? correct : [correct]).filter((c): c is string => typeof c === "string");
    const wantedValues = wanted.map((w) => options.find((o) => o.value === w || o.label === w)?.value ?? w);
    details.correctIndices = wantedValues.map((w) => options.findIndex((o) => o.value === w) + 1).filter((i) => i > 0);
    details.correct = values.length === wantedValues.length && wantedValues.every((w) => values.includes(w));
  }
  if (details.kind === "explain" && typeof correct === "string") {
    details.committed = correct;
  }
  // the model sees the compact learner form, and the interface keeps the full graded form in details
  const parts: string[] = [];
  if (answer.dontKnow) parts.push("The learner chose the option for not knowing.");
  else if (answers.length) parts.push(`The learner chose: ${answers.map((a) => a.label).join(", ")}.`);
  if (details.text) parts.push(`The learner wrote: ${details.text}`);
  if (details.other) parts.push(`The learner added: ${details.other}`);
  if (details.confidence !== undefined) parts.push(`Stated confidence: ${details.confidence} per cent.`);
  if (details.thinking) parts.push(`The learner's reasoning: ${details.thinking}`);
  if (details.readingThinking) parts.push(`The learner's thoughts while reading: ${details.readingThinking}`);
  if (details.correct !== undefined) parts.push(details.correct ? "The answer is correct." : "The answer is not correct.");
  if (details.committed) parts.push(`The committed answer was: ${details.committed}`);
  return { content: parts.join(" ") || "The learner answered.", details };
}

const result = (call: ToolCallRef, content: string, details: unknown, ctx: InputContext, isError = false): ToolResultMessage => ({
  role: "toolResult",
  id: newMessageId(ctx.now()),
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text: content }],
  details,
  isError,
  timestamp: ctx.now(),
});

const userMessage = (text: string, ctx: InputContext, id?: string): UserMessage => ({
  role: "user",
  id: id ?? newMessageId(ctx.now()),
  content: text,
  timestamp: ctx.now(),
});

const marker = (customType: CustomMessage["customType"], content: string, details: unknown, ctx: InputContext, id?: string): CustomMessage => ({
  role: "custom",
  id: id ?? newMessageId(ctx.now()),
  customType,
  content,
  display: true,
  details,
  timestamp: ctx.now(),
});

/** The synthesised conclusion that tells the model a dismissed problem is closed. Ids derive from the problem call. */
function dismissalPair(messages: NativeMessage[], ctx: InputContext): NativeMessage[] {
  const present = new Set(messages.map((m) => m.id));
  const out: NativeMessage[] = [];
  for (const m of messages) {
    if (m.role !== "custom" || m.customType !== "problem-dismissed") continue;
    const callId = (m.details as { problemCallId?: unknown } | undefined)?.problemCallId;
    if (typeof callId !== "string") continue;
    const assistantId = `msg_dismissed_${callId}`;
    if (present.has(assistantId)) continue;
    const concludeId = `${callId}~dismissed`;
    out.push({
      role: "assistant",
      id: assistantId,
      content: [{ type: "toolCall", id: concludeId, name: "conclude", arguments: { outcome: "dismissed", verdict: "The learner dismissed the problem.", rung: null, missClass: null, retest: false } }],
      timestamp: ctx.now(),
      stopReason: "toolUse",
    } as NativeMessage);
    out.push({
      role: "toolResult",
      id: `msg_dismissed_result_${callId}`,
      toolCallId: concludeId,
      toolName: "conclude",
      content: [{ type: "text", text: "The problem was dismissed by the learner and is closed." }],
      details: { ok: true, outcome: "dismissed" },
      isError: false,
      timestamp: ctx.now(),
    });
  }
  return out;
}

export interface InputPlan {
  /** messages to save before inference */
  appends: NativeMessage[];
  /** false when the input is saved and no turn starts */
  startsTurn: boolean;
}

/** Plans one input: the messages to write, and whether a turn follows. */
export function planInput(messages: NativeMessage[], input: InputEvent, ctx: InputContext): InputPlan {
  if (!input || typeof input !== "object" || typeof (input as { type?: unknown }).type !== "string") throw badRequest("The input must be an object with a type.");
  switch (input.type) {
    case "text": {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) throw badRequest("The message is empty.");
      if (text.length > MAX_TEXT_CHARS) throw badRequest("The message is too long.");
      return { appends: [...dismissalPair(messages, ctx), userMessage(text, ctx)], startsTurn: true };
    }
    case "answer": {
      const open = danglingQuestions(messages);
      const call = open.find((c) => c.id === input.toolCallId);
      if (!call) throw badRequest("No open question has that identifier, so the answer was not saved.");
      if (!input.answer || typeof input.answer !== "object") throw badRequest("The answer must be an object.");
      const built = ctx.grade ? ctx.grade(call, input.answer) : buildAnswer(call, input.answer, ctx);
      // with parallel questions, an answer that leaves a sibling open waits for the last one
      return { appends: [result(call, built.content, built.details, ctx)], startsTurn: open.length === 1 };
    }
    case "continue":
      if (!needsContinuation(messages)) throw badRequest("There is nothing to continue.");
      return { appends: [], startsTurn: true };
    case "retry": {
      if (failedTail(messages).length === 0) throw badRequest("There is no failed response to retry.");
      return { appends: [], startsTurn: true };
    }
    case "retry-question": {
      const msg = messages.find((m) => m.id === input.messageId);
      if (!msg || msg.role !== "assistant") throw badRequest("That response does not exist.");
      const call = toolCallsOf(msg).find((c) => c.id === input.toolCallId && c.contentIndex === input.contentIndex && QUESTION_TOOLS.has(c.name));
      if (!call) throw badRequest("That question call does not exist.");
      const answered = messages.some((m) => m.role === "toolResult" && m.toolCallId === call.id);
      if (answered) throw badRequest("That question already has a result.");
      const note = "The question could not be shown. Pose it again with valid arguments.";
      return { appends: [result(call, note, { dismissed: false, questionRecovery: true }, ctx, true)], startsTurn: true };
    }
    case "thinking": {
      const active = activeProblemOf(messages);
      if (!active || active.id !== input.problemCallId) throw badRequest("No open problem has that identifier.");
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) throw badRequest("The thinking is empty.");
      return {
        appends: [marker("practice-thinking", `The learner's thinking on the open problem:\n${text}`, { problemCallId: input.problemCallId, text }, ctx)],
        startsTurn: true,
      };
    }
    case "next":
      if (activeProblemOf(messages)) throw badRequest("A problem is still open. Conclude it before asking for the next one.");
      return { appends: [marker("practice-next", "The learner asks for the next problem.", undefined, ctx)], startsTurn: true };
    default:
      throw badRequest("The input type is not known.");
  }
}

/** The messages of a silent dismissal of an open question or problem. A dismissal wakes no model. */
export function planDismissal(messages: NativeMessage[], body: { toolCallId?: unknown; problemCallId?: unknown }, ctx: InputContext): NativeMessage[] {
  if (typeof body.toolCallId === "string") {
    const call = danglingQuestions(messages).find((c) => c.id === body.toolCallId);
    if (!call) throw badRequest("No open question has that identifier.");
    const details: AnswerDetails = {
      kind: kindOf(call.name),
      tool: call.name as AnswerDetails["tool"],
      questionText: typeof call.arguments.question === "string" ? call.arguments.question : "",
      answers: [],
      dismissed: true,
      answeredAt: new Date(ctx.now()).toISOString(),
    };
    return [result(call, "The learner skipped this question.", details, ctx)];
  }
  if (typeof body.problemCallId === "string") {
    const active = activeProblemOf(messages);
    if (!active || active.id !== body.problemCallId) throw badRequest("No open problem has that identifier.");
    return [marker("problem-dismissed", "The learner dismissed the problem.", { problemCallId: active.id }, ctx)];
  }
  throw badRequest("Give a toolCallId or a problemCallId.");
}

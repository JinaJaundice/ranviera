// Pure scans over the stored messages. They decide what is pending, what a turn
// may do next and which phase a session is in. None of them throws.
import type { AssistantMessage, NativeMessage, Phase, ToolResultMessage } from "../../../../shared/learn/index.ts";

export const QUESTION_TOOLS = new Set(["quiz", "probe", "ask_user_question", "explain", "recall"]);

export interface ToolCallRef {
  messageId: string;
  contentIndex: number;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export const isFailedAssistant = (m: NativeMessage): boolean =>
  m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted");

/** A generation that stopped at its length limit never owns a question. */
const ownsQuestions = (m: AssistantMessage): boolean => m.stopReason !== "error" && m.stopReason !== "aborted" && m.stopReason !== "length";

export function toolCallsOf(m: AssistantMessage): ToolCallRef[] {
  const out: ToolCallRef[] = [];
  m.content.forEach((block, contentIndex) => {
    if (block && block.type === "toolCall") out.push({ messageId: m.id, contentIndex, id: block.id, name: block.name, arguments: block.arguments ?? {} });
  });
  return out;
}

export function resultsById(messages: NativeMessage[]): Map<string, ToolResultMessage> {
  const out = new Map<string, ToolResultMessage>();
  for (const m of messages) if (m.role === "toolResult") out.set(m.toolCallId, m);
  return out;
}

/** The newest message that passes the test, read from the end of the record. */
function newestWhere<T extends NativeMessage>(messages: NativeMessage[], test: (m: NativeMessage) => m is T): T | undefined {
  for (let k = messages.length; k-- > 0; ) {
    const candidate = messages[k];
    if (test(candidate)) return candidate;
  }
  return undefined;
}

const isAssistant = (m: NativeMessage): m is AssistantMessage => m.role === "assistant";

/** The question calls of the newest assistant message that have no result yet, in call order. */
export function danglingQuestions(messages: NativeMessage[]): ToolCallRef[] {
  const newest = newestWhere(messages, isAssistant);
  if (!newest || !ownsQuestions(newest)) return [];
  const results = resultsById(messages);
  return toolCallsOf(newest).filter((c) => QUESTION_TOOLS.has(c.name) && !results.has(c.id));
}

/** The question calls of the newest assistant message, answered or not. */
export function questionCallsOfNewest(messages: NativeMessage[]): ToolCallRef[] {
  const m = newestWhere(messages, isAssistant);
  if (!m) return [];
  return ownsQuestions(m) ? toolCallsOf(m).filter((c) => QUESTION_TOOLS.has(c.name)) : [];
}

const isCleanResult = (r: ToolResultMessage | undefined): r is ToolResultMessage => {
  if (!r || r.isError) return false;
  const d = r.details as { ok?: unknown } | null | undefined;
  return !(d && typeof d === "object" && d.ok === false);
};

/** A problem that was posed cleanly and has no conclusion and no dismissal. */
export function activeProblemOf(messages: NativeMessage[]): ToolCallRef | null {
  const results = resultsById(messages);
  const dismissed = new Set<string>();
  for (const m of messages) {
    if (m.role === "custom" && m.customType === "problem-dismissed") {
      const d = m.details as { problemCallId?: unknown } | undefined;
      if (typeof d?.problemCallId === "string") dismissed.add(d.problemCallId);
    }
  }
  let active: ToolCallRef | null = null;
  for (const m of messages) {
    if (m.role !== "assistant" || isFailedAssistant(m)) continue;
    for (const call of toolCallsOf(m)) {
      if (call.name === "problem" && isCleanResult(results.get(call.id)) && !dismissed.has(call.id)) active = call;
      else if (call.name === "conclude" && isCleanResult(results.get(call.id))) active = null;
    }
  }
  return active;
}

/** A successful probe_done: from a sound generation, with a later clean result of the same name. */
export function hasProbeDone(messages: NativeMessage[]): boolean {
  const results = resultsById(messages);
  for (const m of messages) {
    if (m.role !== "assistant" || isFailedAssistant(m)) continue;
    for (const call of toolCallsOf(m)) {
      if (call.name !== "probe_done") continue;
      const r = results.get(call.id);
      if (r && r.toolName === "probe_done" && isCleanResult(r)) return true;
    }
  }
  return false;
}

/** The phase is derived and never stored. */
export function phaseOf(messages: NativeMessage[]): Phase {
  if (!hasProbeDone(messages)) return "probe";
  for (const m of messages) {
    if (m.role !== "assistant" || isFailedAssistant(m)) continue;
    for (const call of toolCallsOf(m)) {
      if ((call.name === "quiz" || call.name === "explain") && typeof call.arguments.nodeId === "string" && call.arguments.nodeId) return "teach";
    }
  }
  return "plan";
}

const lastVisible = (messages: NativeMessage[]): NativeMessage | undefined =>
  newestWhere(messages, (m): m is NativeMessage => !(m.role === "custom" && m.customType === "plan-block"));

/** True when the record ends in a learner message or a result that no assistant has answered yet. */
export function endsOwed(messages: NativeMessage[]): boolean {
  const last = lastVisible(messages);
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "toolResult";
}

/** The record ends in tool results whose calls are all answered, so a turn may continue with no new input. */
export function needsContinuation(messages: NativeMessage[]): boolean {
  const last = lastVisible(messages);
  // the handoff marker of a finished probe is a valid place to start the teacher
  if (last && last.role === "custom" && last.customType === "probe-handoff") return true;
  // a delivered job result, or the notice that a job was aborted, is a valid place to continue: the idle wake saves the
  // marker and then starts a turn (docs/learning/jobs.md, "Contract changes proposed", 2 November 2026)
  if (last && last.role === "custom" && (last.customType === "subagent-steer" || last.customType === "subagent-abort")) return true;
  if (!last || last.role !== "toolResult") return false;
  const details = last.details as { dismissed?: unknown; questionRecovery?: unknown } | null | undefined;
  if (details && typeof details === "object" && (details.dismissed === true || details.questionRecovery === true)) return false;
  const owner = newestWhere(messages, isAssistant);
  if (!owner || isFailedAssistant(owner)) return false;
  const results = resultsById(messages);
  const calls = toolCallsOf(owner);
  if (!calls.every((c) => results.has(c.id))) return false;
  // a problem that was posed and not concluded waits for the learner
  if (calls.some((c) => c.name === "problem") && activeProblemOf(messages)) return false;
  return true;
}

/** A failed response at the tail of the record, looking past plan blocks. Returns the failed messages, newest last. */
export function failedTail(messages: NativeMessage[]): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let idx = messages.length;
  while (idx-- > 0) {
    const msg = messages[idx];
    if (msg.role === "custom" && msg.customType === "plan-block") continue;
    if (msg.role !== "assistant" || msg.stopReason !== "error") break;
    out.unshift(msg);
  }
  return out;
}

/** The text of the latest failure at the tail of the record, or null. */
export function tailErrorText(messages: NativeMessage[]): string | null {
  const last = lastVisible(messages);
  if (last && last.role === "assistant" && last.stopReason === "error") {
    const text = typeof last.errorMessage === "string" && last.errorMessage ? last.errorMessage : "The model returned an error.";
    return text;
  }
  return null;
}

/** The prose of an assistant message: its text blocks joined by blank lines. */
export function assistantText(m: AssistantMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

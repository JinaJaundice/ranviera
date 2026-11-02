// The phase of a session: probe until a successful probe_done, then plan, and
// teach from the first graded teach question that carries a node identifier.
// The phase is derived from the record and never stored.
import type { NativeMessage, Phase } from "../../../../shared/learn/index.ts";
import { hasProbeDone, phaseOf, resultsById, isFailedAssistant, toolCallsOf } from "../runtime/scans.ts";

export { hasProbeDone, phaseOf };

export interface PhaseSpan {
  phase: Phase;
  /** index of the first message of the span */
  from: number;
  /** index of the last message of the span */
  to: number;
}

/** Folds the messages into spans, for the dividers of the transcript. An empty record is one probe span with no messages. */
export function phaseSpans(messages: NativeMessage[]): PhaseSpan[] {
  if (messages.length === 0) return [];
  const results = resultsById(messages);
  let probeDoneAt = -1;
  let teachAt = -1;
  messages.forEach((m, index) => {
    if (m.role !== "assistant" || isFailedAssistant(m)) return;
    for (const call of toolCallsOf(m)) {
      if (probeDoneAt < 0 && call.name === "probe_done") {
        const r = results.get(call.id);
        const details = r?.details as { ok?: unknown } | null | undefined;
        if (r && r.toolName === "probe_done" && !r.isError && !(details && details.ok === false)) {
          probeDoneAt = Math.max(index, messages.indexOf(r));
        }
      }
      if (teachAt < 0 && (call.name === "quiz" || call.name === "explain") && typeof call.arguments.nodeId === "string" && call.arguments.nodeId) teachAt = index;
    }
  });
  const spans: PhaseSpan[] = [];
  if (probeDoneAt < 0) return [{ phase: "probe", from: 0, to: messages.length - 1 }];
  spans.push({ phase: "probe", from: 0, to: probeDoneAt });
  if (probeDoneAt + 1 > messages.length - 1) return spans;
  const start = teachAt >= 0 ? Math.max(teachAt, probeDoneAt + 1) : -1;
  if (start < 0) {
    spans.push({ phase: "plan", from: probeDoneAt + 1, to: messages.length - 1 });
    return spans;
  }
  if (start > probeDoneAt + 1) spans.push({ phase: "plan", from: probeDoneAt + 1, to: start - 1 });
  spans.push({ phase: "teach", from: start, to: messages.length - 1 });
  return spans;
}

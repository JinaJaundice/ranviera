// The transcript as a list of blocks, and the facts that the header and the dock derive from the record: the phase, the
// status of each plan node, the active practice problem and the context in use. Pure functions of the message list.
import type { AnswerDetails, AssistantMessage, NativeMessage, NodeStatus, PlanBlockDetails, PlanTree, ToolResultMessage } from "@shared/learn/sessions";
import { isAnswer, isQuestionTool, malformedQuestionsOf, toClientQuestion, type ClientQuestion } from "./questions";

export type Block =
  | { kind: "user"; id: string; text: string; images: number }
  | { kind: "teacher"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | { kind: "answered"; id: string; callId: string; tool: string; question: ClientQuestion | null; details: AnswerDetails; explanation: string; committed: string }
  | { kind: "skipped"; id: string; question: string }
  | { kind: "malformed"; id: string; messageId: string; contentIndex: number; callId: string }
  | { kind: "problem"; id: string; callId: string; statement: string; mode: string }
  | { kind: "concluded"; id: string; callId: string; outcome: string; verdict: string; solution: string; mode: string; targets: string[]; rung: string | null; missClass: string | null; retest: boolean }
  | { kind: "problemDismissed"; id: string }
  | { kind: "divider"; id: string; label: string }
  | { kind: "plan"; id: string; details: PlanBlockDetails }
  | { kind: "compaction"; id: string }
  | { kind: "retrying"; id: string }
  | { kind: "trace"; id: string; tool: string; headline: string; input: unknown; output: string; isError: boolean }
  | { kind: "probeDone"; id: string; strands: { strand: string; assessment: string }[]; summary: string }
  | { kind: "context"; id: string; count: number; chains: number }
  | { kind: "result"; id: string; jobKind: string; aborted: boolean; brief: string; sources: { title: string; url: string }[] }
  | { kind: "next"; id: string }
  | { kind: "learnerThinking"; id: string; text: string }
  | { kind: "failure"; id: string; text: string };

const textOfUser = (m: Extract<NativeMessage, { role: "user" }>): { text: string; images: number } =>
  typeof m.content === "string"
    ? { text: m.content, images: 0 }
    : { text: m.content.map((b) => (b.type === "text" ? b.text : "")).join(""), images: m.content.filter((b) => b.type === "image").length };

const textOfResult = (r: ToolResultMessage): string =>
  r.content
    .map((c) => (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join("")
    .trim();

const pick = (...v: unknown[]): string => String(v.find((x) => typeof x === "string" && x.trim()) ?? "");

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One headline argument for a tool trace. */
export function headlineOf(args: Record<string, unknown>): string {
  for (const k of ["path", "pattern", "query", "session", "question"]) if (typeof args[k] === "string" && args[k]) return String(args[k]);
  return "";
}

/** The call, by id, that a result answers. The newest call with the id wins, so a reused id routes each result to its own card. */
function callsById(messages: readonly NativeMessage[]) {
  const out = new Map<string, { name: string; arguments: Record<string, unknown>; messageId: string; contentIndex: number }>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    m.content.forEach((b, i) => {
      if (b.type === "toolCall") out.set(b.id, { name: b.name, arguments: b.arguments, messageId: m.id, contentIndex: i });
    });
  }
  return out;
}

/** The teaching divider goes where the first graded question that names a plan node is posed. */
const isTeachCall = (name: string, args: Record<string, unknown>): boolean => (name === "quiz" || name === "explain") && typeof args.nodeId === "string" && args.nodeId.length > 0;

export function projectBlocks(messages: readonly NativeMessage[], streamingIds: ReadonlySet<string> = new Set()): Block[] {
  const out: Block[] = [];
  const results = new Map<string, ToolResultMessage>();
  for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
  const calls = callsById(messages);
  const malformed = malformedQuestionsOf(messages, streamingIds);
  const lastAssistantAt = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();
  let taught = false;

  messages.forEach((m, at) => {
    if (m.role === "user") {
      const u = textOfUser(m);
      if (u.text || u.images) out.push({ kind: "user", id: m.id, text: u.text, images: u.images });
      return;
    }
    if (m.role === "custom") {
      const d = asObj(m.details);
      switch (m.customType) {
        case "plan-block": {
          const details = m.details as PlanBlockDetails;
          if (details && Array.isArray(details.nodes)) {
            out.push({ kind: "divider", id: `${m.id}-d`, label: `Plan with ${details.nodes.length} ${details.nodes.length === 1 ? "node" : "nodes"}` });
            out.push({ kind: "plan", id: m.id, details });
          }
          return;
        }
        case "compaction":
          out.push({ kind: "compaction", id: m.id });
          return;
        case "graph-context": {
          const props = Array.isArray(d.propositions) ? d.propositions.length : 0;
          out.push({ kind: "context", id: m.id, count: props, chains: Array.isArray(d.chains) ? d.chains.length : 0 });
          return;
        }
        case "practice-thinking":
          if (typeof d.text === "string" && d.text) out.push({ kind: "learnerThinking", id: m.id, text: d.text });
          return;
        case "practice-next":
          out.push({ kind: "next", id: m.id });
          return;
        case "problem-dismissed":
          out.push({ kind: "problemDismissed", id: m.id });
          return;
        case "subagent-steer": {
          const r = asObj(d.result);
          out.push({
            kind: "result",
            id: m.id,
            jobKind: String(d.kind ?? "research"),
            aborted: false,
            brief: typeof r.brief === "string" ? r.brief : "",
            sources: Array.isArray(r.sources) ? (r.sources as { title: string; url: string }[]).filter((s) => s && typeof s.url === "string") : [],
          });
          return;
        }
        case "subagent-abort":
          out.push({ kind: "result", id: m.id, jobKind: String(d.kind ?? "research"), aborted: true, brief: "", sources: [] });
          return;
        default:
          return; // the probe handoff and any later marker show nothing of their own
      }
    }
    if (m.role === "toolResult") {
      // a question answer, a conclusion and a trace are drawn at the call, and a dismissed question draws as one line
      const call = calls.get(m.toolCallId);
      if (call && isQuestionTool(call.name) && (m.details as { dismissed?: boolean } | undefined)?.dismissed) {
        out.push({ kind: "skipped", id: m.id, question: String(call.arguments.question ?? "") });
      }
      return;
    }

    // an assistant message: reasoning first, then the text and the calls in their order
    const streaming = streamingIds.has(m.id);
    const reasoning = m.content.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking");
    if (reasoning.length || (streaming && m.content.length === 0)) {
      out.push({ kind: "thinking", id: `${m.id}-th`, text: reasoning.map((r) => r.thinking).join("\n\n"), streaming });
    }
    if (m.stopReason === "error" && at === messages.length - 1 && !streaming) {
      // the failure banner is drawn by the window from the snapshot, so nothing is added here
    }
    m.content.forEach((b, i) => {
      if (b.type === "text" && b.text.trim()) {
        out.push({ kind: "teacher", id: `${m.id}-t${i}`, text: b.text, streaming });
        return;
      }
      if (b.type !== "toolCall") return;
      const args = b.arguments ?? {};
      const result = results.get(b.id);
      if (!taught && isTeachCall(b.name, args)) {
        taught = true;
        out.push({ kind: "divider", id: `${m.id}-teach`, label: "Teaching" });
      }
      if (isQuestionTool(b.name)) {
        if (result && isAnswer(result) && !(result.details as { dismissed?: boolean }).dismissed) {
          out.push({ kind: "answered", id: `${m.id}-q${i}`, callId: b.id, tool: b.name, question: toClientQuestion({ id: b.id, name: b.name, arguments: args }), details: result.details as AnswerDetails, explanation: pick((result.details as AnswerDetails).explanation, args.explanation), committed: pick((result.details as AnswerDetails).committed, args.correctAnswer) });
        } else if (!result && malformed.some((q) => q.toolCallId === b.id && q.messageId === m.id && q.contentIndex === i)) {
          out.push({ kind: "malformed", id: `${m.id}-q${i}`, callId: b.id, messageId: m.id, contentIndex: i });
        }
        return;
      }
      if (b.name === "problem") {
        out.push({ kind: "problem", id: `${m.id}-p${i}`, callId: b.id, statement: String(args.statement ?? ""), mode: String(args.mode ?? "") });
        return;
      }
      if (b.name === "conclude") {
        const det = asObj(result?.details);
        const pid = typeof det.problemCallId === "string" ? det.problemCallId : "";
        const posed = calls.get(pid);
        out.push({
          kind: "concluded",
          id: `${m.id}-c${i}`,
          callId: b.id,
          outcome: String(args.outcome ?? ""),
          verdict: String(args.verdict ?? ""),
          solution: typeof det.modelSolution === "string" ? det.modelSolution : "",
          mode: String(posed?.arguments.mode ?? ""),
          targets: Array.isArray(det.target) ? (det.target as unknown[]).filter((t): t is string => typeof t === "string") : [],
          rung: typeof args.rung === "string" ? args.rung : null,
          missClass: typeof args.missClass === "string" ? args.missClass : null,
          retest: args.retest === true,
        });
        return;
      }
      if (b.name === "probe_done") {
        const strands = Array.isArray(args.strands) ? (args.strands as { strand?: unknown; assessment?: unknown }[]).filter((s) => s && typeof s.strand === "string").map((s) => ({ strand: String(s.strand), assessment: String(s.assessment ?? "") })) : [];
        out.push({ kind: "probeDone", id: `${m.id}-pd${i}`, strands, summary: typeof args.summary === "string" ? args.summary : "" });
        return;
      }
      if (b.name === "plan_init" || b.name === "send_to_user") return;
      if (b.name === "research" || b.name === "pdf") return; // the result arrives as a marker
      if (result?.isError) {
        if (at < lastAssistantAt) out.push({ kind: "retrying", id: `${m.id}-r${i}` });
        else out.push({ kind: "trace", id: `${m.id}-x${i}`, tool: b.name, headline: headlineOf(args), input: args, output: textOfResult(result), isError: true });
        return;
      }
      if (result) out.push({ kind: "trace", id: `${m.id}-x${i}`, tool: b.name, headline: headlineOf(args), input: args, output: textOfResult(result), isError: false });
    });
  });
  return out;
}

/* Facts derived from the record -------------------------------------------------------------------------------- */

export type PhaseWord = "probe" | "plan" | "teach";

/** The phase is probe until a successful probe_done, then plan, and teach from the first graded teaching question that names a node. */
export function derivePhase(messages: readonly NativeMessage[]): PhaseWord {
  let done = false;
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolName === "probe_done" && !m.isError) done = true;
    if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall" && isTeachCall(b.name, b.arguments ?? {})) return "teach";
  }
  return done ? "plan" : "probe";
}

export const PHASE_WORDS: Record<PhaseWord, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };

/** The status of each plan node. The current node is named by the newest graded teaching call, the visited ones are the earlier stays. */
export function planStatuses(tree: Pick<PlanTree, "nodes">, messages: readonly NativeMessage[]): Record<string, NodeStatus> {
  const known = new Set(tree.nodes.map((n) => n.id));
  const stays: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "toolCall" || !isTeachCall(b.name, b.arguments ?? {})) continue;
      const id = String(b.arguments.nodeId);
      if (!known.has(id)) continue;
      if (stays[stays.length - 1] !== id) stays.push(id);
    }
  }
  const current = stays.length ? stays[stays.length - 1] : null;
  const visited = new Set(stays.slice(0, -1));
  const out: Record<string, NodeStatus> = {};
  for (const n of tree.nodes) out[n.id] = n.id === current ? "current" : visited.has(n.id) ? "visited" : "upcoming";
  return out;
}

export interface ActiveProblem {
  callId: string;
  statement: string;
  mode: string;
  messageId: string;
}

/** The newest problem that has neither a conclusion nor a dismissal after it. */
export function activeProblem(messages: readonly NativeMessage[]): ActiveProblem | null {
  let found: ActiveProblem | null = null;
  let at = -1;
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    for (const b of m.content) {
      if (b.type === "toolCall" && b.name === "problem") {
        found = { callId: b.id, statement: String(b.arguments?.statement ?? ""), mode: String(b.arguments?.mode ?? ""), messageId: m.id };
        at = i;
      }
    }
  });
  if (!found) return null;
  const callId = (found as ActiveProblem).callId;
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult" && m.toolName === "conclude" && !m.isError) return null;
    if (m.role === "custom" && m.customType === "problem-dismissed") {
      const pid = asObj(m.details).problemCallId;
      if (pid === undefined || pid === callId) return null;
    }
  }
  return found;
}

/** The pause of a practice session: the last problem is closed and the learner has not asked for the next one. */
export function practicePause(messages: readonly NativeMessage[]): boolean {
  if (activeProblem(messages)) return false;
  let lastProblem = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.name === "problem")) lastProblem = i;
  });
  if (lastProblem < 0) return false;
  return !messages.slice(lastProblem + 1).some((m) => m.role === "custom" && m.customType === "practice-next");
}

/** Tokens in use at the last call of the model: input, output and both cache buckets. Null when the last call reported nothing. */
export function contextTokens(messages: readonly NativeMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const u = asObj((m as AssistantMessage).usage);
    if (typeof u.totalTokens === "number" && u.totalTokens > 0) return u.totalTokens;
    const parts = ["input", "output", "cacheRead", "cacheWrite"].map((k) => (typeof u[k] === "number" ? (u[k] as number) : 0));
    const sum = parts.reduce((a, b) => a + b, 0);
    return sum > 0 ? sum : null;
  }
  return null;
}

/** The thinking of the learner that sits above an answered card, as its own block. */
export function thinkingOf(d: AnswerDetails): { reading?: string; thinking?: string } {
  return { ...(d.readingThinking ? { reading: d.readingThinking } : {}), ...(d.thinking ? { thinking: d.thinking } : {}) };
}

/** Whether the first phase divider and a plan exist, for the header chip. */
export function planBlockOf(messages: readonly NativeMessage[]): PlanBlockDetails | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "custom" && m.customType === "plan-block" && m.details) return m.details as PlanBlockDetails;
  }
  return null;
}

// Compaction of long sessions. The full history stays on disk and a summary of
// an older span stands in for it in the projection. The arithmetic and the
// limits are in CONTRACTS "Limits". Compaction runs between turns, never inside
// one, because a question or a problem always ends a run.
import type { CallUsage, CompactionDetails, CustomMessage, NativeMessage, SessionRecord } from "../../../../shared/learn/index.ts";
import type { Emit, ModelResolver, ResolvedModel, Summariser } from "./deps.ts";
import { activeCompaction } from "./projection.ts";
import { danglingQuestions } from "./scans.ts";
import type { SessionStore } from "./store.ts";
import { newMessageId } from "./ids.ts";

export const DEFAULT_THRESHOLD = 150_000;
export const THRESHOLD_FLOOR = 32_000;
export const RESERVE_TOKENS = 16_384;
export const KEEP_RECENT_TOKENS = 20_000;
export const TOOL_RESULT_CHARS = 2_000;
export const IMAGE_CHARS = 4_800;
export const COMPACTION_HEADER = "The earlier part of this session was summarised to save space. The summary follows, and the messages after it are the original ones.";

const chars = (n: number) => Math.ceil(n / 4);

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
    if (p.type === "text" && typeof p.text === "string") n += p.text.length;
    else if (p.type === "image") n += IMAGE_CHARS;
    else if (p.type === "thinking" && typeof p.thinking === "string") n += p.thinking.length;
    else if (p.type === "toolCall") n += (p.name?.length ?? 0) + JSON.stringify(p.arguments ?? {}).length;
  }
  return n;
}

/** The wire text of a message, in tokens. Scaffolding and encrypted signatures are not counted. */
export function estimateMessageTokens(m: { role: string; content?: unknown }): number {
  return chars(contentChars(m.content));
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function usageTotal(m: NativeMessage): number | null {
  if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") return null;
  const u = m.usage as UsageLike | undefined;
  if (!u) return null;
  const total = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * The context size of the next request. It anchors on the newest assistant
 * message with provider usage and estimates only what follows it. The scan
 * stops at the newest compaction marker, because earlier usage described
 * context that the next request no longer carries.
 */
export function estimateContextTokens(messages: NativeMessage[], projected: { role: string; content?: unknown }[], systemChars = 0): number {
  let markerAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "custom" && m.customType === "compaction") {
      markerAt = i;
      break;
    }
  }
  for (let i = messages.length - 1; i > markerAt; i--) {
    const total = usageTotal(messages[i]);
    if (total === null) continue;
    let after = 0;
    for (let k = i + 1; k < messages.length; k++) {
      const m = messages[k];
      if (m.role === "custom" && (m.customType === "plan-block" || m.customType === "problem-dismissed" || m.customType === "compaction")) continue;
      after += estimateMessageTokens(m);
    }
    return total + after;
  }
  return chars(systemChars) + projected.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

/** The smaller of the setting and the model window less the reserve, never below 1. */
export function effectiveThreshold(setting: number | undefined, contextWindow: number | null): number {
  const base = Math.max(THRESHOLD_FLOOR, Math.round(setting ?? DEFAULT_THRESHOLD));
  if (contextWindow === null || !Number.isFinite(contextWindow)) return base;
  return Math.max(1, Math.min(base, contextWindow - RESERVE_TOKENS));
}

const HIDDEN_MARKERS = new Set(["compaction", "plan-block", "problem-dismissed"]);

/** True when the message may begin the kept tail: it is visible to the model and is not a tool result. */
const isCutCandidate = (m: NativeMessage): boolean => {
  if (m.role === "user" || m.role === "assistant") return true;
  return m.role === "custom" && !HIDDEN_MARKERS.has(m.customType);
};

/**
 * Chooses the first kept message of a compaction, as an index into the record,
 * or null when nothing would be dropped. It walks back until the retained tail
 * budget is met, never starts the tail on a tool result, never crosses an
 * earlier compaction and never drops a pending question call.
 */
export function findCut(messages: NativeMessage[], keepTokens = KEEP_RECENT_TOKENS): number | null {
  const active = activeCompaction(messages);
  const floor = active ? active.keptIndex : 0;
  let pos = -1;
  let acc = 0;
  for (let i = messages.length - 1; i >= floor; i--) {
    const m = messages[i];
    if (m.role === "custom" && HIDDEN_MARKERS.has(m.customType)) continue;
    acc += estimateMessageTokens(m);
    if (acc >= keepTokens) {
      pos = i;
      break;
    }
  }
  if (pos < 0) return null;
  let cut = pos;
  if (messages[cut].role === "toolResult") {
    while (cut > floor && messages[cut].role === "toolResult") cut--;
  } else {
    while (cut < messages.length && !isCutCandidate(messages[cut])) cut++;
  }
  if (cut >= messages.length || messages[cut].role === "toolResult") return null;
  // a pending question call stays in the tail
  const pending = danglingQuestions(messages);
  if (pending.length) {
    const at = messages.findIndex((m) => m.id === pending[0].messageId);
    if (at >= 0 && cut > at) cut = at;
  }
  // an anti churn guard: the new cut must advance past the previous one
  if (cut <= floor) return null;
  return cut;
}

/** The span to summarise as labelled lines. Thinking, plan blocks and compaction markers are left out. */
export function serialiseSpan(span: NativeMessage[]): string {
  const lines: string[] = [];
  for (const m of span) {
    switch (m.role) {
      case "user":
        lines.push(`Learner: ${typeof m.content === "string" ? m.content : contentTextOf(m.content)}`);
        break;
      case "assistant": {
        const parts: string[] = [];
        for (const b of m.content) {
          if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
          else if (b.type === "toolCall") parts.push(`[tool call ${b.name} ${JSON.stringify(b.arguments)}]`);
        }
        if (parts.length) lines.push(`Teacher: ${parts.join(" ")}`);
        break;
      }
      case "toolResult": {
        const body = contentTextOf(m.content);
        const cut = body.length > TOOL_RESULT_CHARS ? `${body.slice(0, TOOL_RESULT_CHARS)} [cut]` : body;
        lines.push(`Tool result ${m.toolName}${m.isError ? " (error)" : ""}: ${cut}`);
        break;
      }
      case "custom":
        if (!HIDDEN_MARKERS.has(m.customType)) lines.push(`System note: ${m.content}`);
        break;
    }
  }
  return lines.join("\n");
}

function contentTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : (p as { type?: string })?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join(" ");
}

export const SUMMARY_SYSTEM = "You write a faithful summary of part of a learning session so that the session can continue without the original messages. You do not praise, you keep every identifier exactly as written and you tie each claim to the transcript.";

/** The prompt of the four section summary. The plan tree is reproduced as stored, with a status for each node. */
export function buildSummaryPrompt(input: { span: string; priorSummary?: string; tree?: SessionRecord["tree"]; statuses?: Record<string, string> }): string {
  const tree = input.tree && input.tree.nodes.length
    ? [
        "Nodes:",
        ...input.tree.nodes.map((n) => `- ${n.id}: ${n.title}${input.statuses?.[n.id] ? ` (${input.statuses[n.id]})` : ""}`),
        "Edges, each from a prerequisite to the node that needs it:",
        ...input.tree.edges.map((e) => `- ${e.from} to ${e.to}`),
      ].join("\n")
    : "No plan map exists for this session.";
  return [
    input.priorSummary ? `An earlier summary of this session, which stays authoritative:\n${input.priorSummary}\n` : "",
    "Summarise the transcript below in exactly four sections, in this order, with these headings.",
    "1. What the learner holds and how that changed",
    "2. How the session progressed",
    "3. The plan map and its status",
    "4. The current moment, with any pending question and the next step",
    "Give no praise or filler. Keep every identifier exact. Do not state anything that the transcript does not support.",
    "For section 3, reproduce the plan map below with the status of each node.",
    "",
    "Plan map as stored:",
    tree,
    "",
    "Transcript:",
    input.span,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface CompactionDeps {
  store: SessionStore;
  models: ModelResolver;
  summariser: Summariser;
  emit: Emit;
  thresholdSetting: () => number;
  now?: () => number;
}

export type CompactionOutcome = "compacted" | "skipped" | "failed";

export interface CompactionService {
  /** True when the record would be over the threshold at the next request. */
  isOver(record: SessionRecord): boolean;
  isCompacting(id: string): boolean;
  /** Runs a compaction when the record is over the threshold. Concurrent callers share one run. */
  compactIfNeeded(id: string): Promise<CompactionOutcome>;
  /** Starts a compaction in the background and returns at once. */
  kick(id: string): void;
  /** Resolves when no compaction is running for the session. */
  whenIdle(id: string): Promise<void>;
}

export function createCompactionService(deps: CompactionDeps): CompactionService {
  const now = deps.now ?? Date.now;
  const running = new Map<string, Promise<CompactionOutcome>>();

  function thresholdFor(record: SessionRecord): { over: boolean } {
    try {
      const resolved = deps.models.forSession(record);
      const threshold = effectiveThreshold(deps.thresholdSetting(), resolved.contextWindow);
      return { over: tokensOf(record) > threshold };
    } catch {
      return { over: false };
    }
  }

  function tokensOf(record: SessionRecord): number {
    return estimateContextTokens(record.messages, projectedOf(record), 0);
  }

  function projectedOf(record: SessionRecord): { role: string; content?: unknown }[] {
    const active = activeCompaction(record.messages);
    const from = active ? active.keptIndex : 0;
    return record.messages
      .slice(from)
      .filter((m) => !(m.role === "custom" && HIDDEN_MARKERS.has(m.customType)))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * The model that writes the summary. The cheap slot is used when the sensitivity gate allows it for this session,
   * because the span holds tool results and learner text. When the gate refuses the cheap slot, the session's own
   * model writes the summary, and a refusal there ends the compaction.
   */
  function summaryModel(record: SessionRecord): ResolvedModel {
    const cheap = deps.models.cheap();
    try {
      deps.models.validate(cheap.ref, undefined, record);
      return cheap;
    } catch {
      return deps.models.forSession(record);
    }
  }

  async function run(id: string): Promise<CompactionOutcome> {
    const record = deps.store.get(id);
    if (!record || !thresholdFor(record).over) return "skipped";
    const cut = findCut(record.messages);
    if (cut === null) return "skipped";
    const active = activeCompaction(record.messages);
    const spanStart = active ? active.keptIndex : 0;
    const span = record.messages.slice(spanStart, cut).filter((m) => !(m.role === "custom" && m.customType === "compaction"));
    if (span.length === 0) return "skipped";
    deps.emit({ type: "learn", event: "compaction-changed", session: id, running: true });
    try {
      const cheap = summaryModel(record);
      const prompt = buildSummaryPrompt({
        span: serialiseSpan(span),
        priorSummary: active ? active.marker.content.replace(COMPACTION_HEADER, "").trim() : undefined,
        tree: record.tree,
        statuses: undefined,
      });
      const reply = await deps.summariser({ system: SUMMARY_SYSTEM, prompt, model: cheap });
      const summary = reply.text.trim();
      // a summary that stopped at the output limit, or an empty one, is discarded
      if (reply.stopReason === "length" || reply.stopReason === "error" || reply.stopReason === "aborted" || !summary) {
        deps.emit({ type: "learn", event: "compaction-changed", session: id, running: false });
        return "failed";
      }
      const fresh = deps.store.get(id);
      if (!fresh) return "failed";
      const kept = fresh.messages.find((m) => m.id === record.messages[cut].id);
      if (!kept) return "failed";
      const details: CompactionDetails = {
        firstKeptMessageId: kept.id,
        tokensBefore: tokensOf(record),
        model: `${cheap.ref.provider}:${cheap.ref.id}`,
        at: new Date(now()).toISOString(),
      };
      const marker: CustomMessage = {
        role: "custom",
        id: newMessageId(now()),
        customType: "compaction",
        content: `${COMPACTION_HEADER}\n\n${summary}`,
        display: true,
        details,
        timestamp: now(),
      };
      deps.store.appendMessages(id, [marker]);
      const step: CallUsage = reply.usage ?? {};
      deps.store.appendTurnUsage(id, { id: marker.id, messageId: marker.id, at: details.at, model: details.model, steps: [step] });
      deps.emit({ type: "learn", event: "record-changed", session: id });
      deps.emit({ type: "learn", event: "compaction-changed", session: id, running: false });
      return "compacted";
    } catch {
      deps.emit({ type: "learn", event: "compaction-changed", session: id, running: false });
      return "failed";
    }
  }

  return {
    isOver: (record) => thresholdFor(record).over,
    isCompacting: (id) => running.has(id),
    compactIfNeeded(id) {
      const existing = running.get(id);
      if (existing) return existing;
      const p = run(id).finally(() => running.delete(id));
      running.set(id, p);
      return p;
    },
    kick(id) {
      const record = deps.store.get(id);
      if (!record || running.has(id) || !thresholdFor(record).over) return;
      void this.compactIfNeeded(id);
    },
    async whenIdle(id) {
      const p = running.get(id);
      if (p) await p.catch(() => undefined);
    },
  };
}

// Learning upgrade: sessions, messages, plan tree and request shapes. The
// source of truth is docs/CONTRACTS.md, section "Learning and knowledge
// (1 November 2026)", and a change is made there first.

import type { Sensitivity } from "../types.ts";
import type { ExtractionRunUsage } from "./knowledge.ts";
import type { ModelRef } from "./models.ts";

/** Session record: thinking levels. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Session record: phase derived from the record, never stored. */
export type Phase = "probe" | "plan" | "teach";

/** Session record: chats/<id>.json. */
export interface SessionRecord {
  /** chat_... */
  id: string;
  /** non empty */
  title: string;
  createdAt: string;
  /** bumped by a message save only, never by a rename, a settings write or a usage write */
  updatedAt: string;
  /** absent means teach */
  kind?: "teach" | "practice";
  /** absent means 1, every write stamps 1 */
  version?: 1;
  messages: NativeMessage[];
  tree?: PlanTree;
  /** usage log of conversation turns */
  turns?: TurnUsage[];
  /** usage log of extraction runs over this session */
  extractions?: ExtractionRunUsage[];
  settings?: { model?: ModelRef; thinkingLevel?: ThinkingLevel };
}

/** Session record: usage of one conversation turn. */
export interface TurnUsage {
  id: string;
  messageId: string;
  at: string;
  /** provider:id */
  model: string;
  steps: CallUsage[];
}

/** Session record: tokens of one model call. inputTokens is fresh input and excludes both cache buckets. */
export interface CallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
}

/** Messages, markers and answer details: the four roles of a stored message. */
export type NativeMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

/** Messages, markers and answer details: a learner message. */
export interface UserMessage {
  role: "user";
  id: string;
  content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  timestamp?: number;
}

/** Messages, markers and answer details: a model message. Provider, model, usage and stopReason are kept as the library writes them. */
export interface AssistantMessage {
  role: "assistant";
  id: string;
  content: (
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  )[];
  timestamp?: number;
  [libraryField: string]: unknown;
}

/** Messages, markers and answer details: the result of a tool call. */
export interface ToolResultMessage {
  role: "toolResult";
  id: string;
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details?: unknown;
  isError: boolean;
  timestamp?: number;
}

/** Messages, markers and answer details: a marker. */
export interface CustomMessage {
  role: "custom";
  id: string;
  customType: CustomType;
  content: string;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

/** Messages, markers and answer details: the nine marker types. */
export type CustomType =
  | "graph-context"
  | "probe-handoff"
  | "subagent-steer"
  | "subagent-abort"
  | "plan-block"
  | "practice-thinking"
  | "practice-next"
  | "problem-dismissed"
  | "compaction";

/** Messages, markers and answer details: details of a graph-context marker, at most 64 propositions. */
export interface GraphContextDetails {
  propositions: { id: string; name: string; statement: string }[];
  chains: { id: string; premises: string[]; conclusion: string }[];
}

/** Messages, markers and answer details: details of a subagent-steer marker. */
export interface SubagentSteerDetails {
  jobId: string;
  kind: string;
  toolCallId: string;
  result: unknown;
}

/** Messages, markers and answer details: details of a subagent-abort marker. */
export interface SubagentAbortDetails {
  jobId: string;
  kind: string;
  toolCallId: string;
  aborted: true;
}

/** Messages, markers and answer details: details of a plan-block marker. */
export interface PlanBlockDetails {
  planCallId: string;
  kind: "full";
  at: string;
  current: string | null;
  nodes: { id: string; title: string; status: NodeStatus }[];
  edges: { from: string; to: string }[];
}

/** Messages, markers and answer details: details of a practice-thinking marker. */
export interface PracticeThinkingDetails {
  problemCallId: string;
  text: string;
}

/** Messages, markers and answer details: details of a compaction marker. */
export interface CompactionDetails {
  firstKeptMessageId: string;
  tokensBefore: number;
  /** provider:id */
  model: string;
  at: string;
}

/** Messages, markers and answer details: the full graded form of a question tool result. */
export interface AnswerDetails {
  kind: "quiz" | "ask" | "explain";
  tool: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
  questionType?: "predict" | "check";
  questionText: string;
  /** display order */
  options?: { label: string; value: string }[];
  /** index is 1 based in display order */
  answers: { label: string; value: string; index: number }[];
  text?: string;
  other?: string;
  dontKnow?: boolean;
  dismissed?: boolean;
  questionRecovery?: boolean;
  /** a legacy note is read as thinking */
  thinking?: string;
  readingThinking?: string;
  /** 0 to 100, absent when dontKnow */
  confidence?: number;
  correct?: boolean;
  correctIndices?: number[];
  committed?: string;
  explanation?: string;
  /** Cortex extension: proposition ids */
  target?: string[];
  answeredAt: string;
}

/** Messages, markers and answer details: the learner's answer as sent. */
export interface AnswerRequest {
  dontKnow?: boolean;
  values?: string[];
  other?: string;
  text?: string;
  thinking?: string;
  readingThinking?: string;
  confidence?: number;
}

/** Plan tree and derived position: a node, with an id of a to z and 0 to 9 in lower case, parts joined by hyphen or underscore. */
export interface PlanNode {
  id: string;
  title: string;
  summary?: string;
}

/** Plan tree and derived position: from is the prerequisite. */
export interface PlanEdge {
  from: string;
  to: string;
}

/** Plan tree and derived position: structure only, starts at version 1, an empty seed is 0. */
export interface PlanTree {
  nodes: PlanNode[];
  edges: PlanEdge[];
  version: number;
}

/** Plan tree and derived position: status is derived and never stored. */
export type NodeStatus = "current" | "visited" | "upcoming";

/** Request and response shapes: body of POST /api/learn/sessions. At most 64 ids. */
export interface CreateSession {
  title?: string;
  kind?: "teach" | "practice";
  graphContext?: { propositions: string[] };
}

/** Request and response shapes: one row of GET /api/learn/sessions. */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  kind: "teach" | "practice";
  messageCount: number;
  phase: Phase;
  pendingQuestion: boolean;
  busy: boolean;
  compacting: boolean;
}

/** Request and response shapes: cost of a session, null when unpriced. */
export interface SessionPricing {
  cost: number | null;
  unpriced: number;
  turnCosts: (number | null)[];
  cacheHitRate: number | null;
}

/** Request and response shapes: extraction coverage of a session. */
export interface CoverageBlock {
  threshold: number;
  running: boolean;
  totalMessages: number;
  coveredCount: number;
  coveredTokens: number;
  uncoveredCount: number;
  uncoveredTokens: number;
  lastFoldedAt: string | null;
}

/** Request and response shapes: GET /api/learn/sessions/:id. */
export interface SessionDetail {
  session: SessionRecord;
  pricing: SessionPricing;
  turnInFlight: boolean;
  turnError: string | null;
  compacting: boolean;
  coverage: CoverageBlock;
  sensitivity: Sensitivity;
}

/** Request and response shapes: the input of POST /api/learn/sessions/:id/input. */
export type InputEvent =
  | { type: "text"; text: string }
  | { type: "answer"; toolCallId: string; answer: AnswerRequest }
  | { type: "continue" }
  | { type: "retry" }
  | { type: "retry-question"; messageId: string; contentIndex: number; toolCallId: string }
  | { type: "thinking"; problemCallId: string; text: string }
  | { type: "next" };

/** Request and response shapes: one row of GET /api/learn/activity. */
export interface ActivityItem {
  kind: "turn" | "job" | "extraction";
  id: string;
  sessionId: string | null;
  title: string;
  phase: string;
  startedAt: string;
}

/** Writer lock: cortex/writer.lock. */
export interface WriterLock {
  pid: number;
  host: string;
  since: string;
}

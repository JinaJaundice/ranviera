// Learning upgrade: turn stream frames and the learning stream message. The
// source of truth is docs/CONTRACTS.md, section "Learning and knowledge
// (1 November 2026)", and a change is made there first.

/** Turn stream: an event of @earendil-works/pi-agent-core 1.4.0 (agent_start, turn_start, message_start, message_update, message_end, tool_execution_start, tool_execution_update, tool_execution_end, turn_end, agent_end). The library is added at merge time, so the shape is open here. */
export interface AgentEvent {
  type:
    | "agent_start"
    | "turn_start"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "turn_end"
    | "agent_end";
  [libraryField: string]: unknown;
}

/** Turn stream: one Server-Sent Events frame of GET /api/learn/sessions/:id/stream. */
export type TurnFrame =
  | AgentEvent
  /** a failure of the loop itself */
  | { type: "error"; errorText: string }
  /** the record is saved and the turn is over */
  | { type: "turn-settled" }
  /** always the last frame */
  | { type: "done" };

/** Turn stream: the facts carried by the learning stream message. */
export type LearnEventName =
  | "turn-started"
  | "turn-settled"
  | "record-changed"
  | "compaction-changed"
  | "sessions-changed"
  | "jobs-changed"
  | "activity-changed"
  | "sources-changed"
  | "graph-changed"
  | "settings-changed"
  | "models-changed";

/** Turn stream: a new member of StreamMessage on GET /api/stream. An event carries the fact and never the data. */
export interface LearnStreamMessage {
  type: "learn";
  event: LearnEventName;
  session?: string;
  root?: string;
  running?: boolean;
  revision?: number;
}

/** Turn stream: the new kinds of EventKind. */
export type LearnEventKind = "learn.turn" | "learn.answer" | "learn.extract";

/** Error envelopes: the codes that the learning routes add to { error }. */
export type LearnErrorCode =
  | "bad_request"
  | "sensitivity_refused"
  | "consent_required"
  | "forbidden_path"
  | "not_found"
  | "turn_running"
  | "extraction_running"
  | "job_running"
  | "busy"
  | "etag_mismatch"
  | "too_large"
  | "unsupported_media_type"
  | "models_not_configured"
  | "provider_key_missing"
  | "claude_code_unavailable"
  | "extraction_busy"
  | "confirm_required"
  | "format_newer"
  | "forbidden_origin"
  | "keys_file_unreadable";

/** Error envelopes: every learning error is JSON with an error sentence and, for most, a code and extra fields. */
export interface LearnErrorBody {
  error: string;
  code?: LearnErrorCode;
  sensitivity?: string;
  providerClass?: string;
  roots?: string[];
  consent?: "claude-code" | "claude-code-background";
  jobs?: string[];
  missing?: string[];
  provider?: string;
  slots?: string[];
  state?: string;
  minimumVersion?: string;
  found?: number;
  supported?: number;
  files?: number;
  tokens?: number;
}

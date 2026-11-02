// The client state of one session, without React. The window is a view over a turn that runs on the server. The model
// holds the saved record (base), the optimistic and live messages (tail) and a little interaction state, and it takes an
// injected fetch so that a bare Node test can drive it. The rules follow the brief on client session state:
//   1. one live connection for each session, the reattach stream, with the post of an input only an acknowledgement
//   2. the saved record wins, and an optimistic entry dies when the record holds a copy of it
//   3. a failure never causes a retry that the learner did not ask for
import type { AnswerRequest, AssistantMessage, CustomMessage, InputEvent, NativeMessage, SessionDetail, ToolResultMessage } from "@shared/learn/sessions";
import { sessionPath } from "../../lib/learn/sessions";
import { pendingQuestionOf, isQuestionTool, kindOfTool, type FormState } from "./questions";

export type Status = "ready" | "submitted" | "streaming" | "error";

export const TURN_POLL_MS = 500;
export const TURN_WAIT_MAX_MS = 30_000;
export const DROPPED_TEXT = "The connection dropped before the turn completed.";
export const STILL_RUNNING_TEXT = "A turn is already running. Try again in a moment.";
export const ADOPT_WINDOWS_MS = [400, 1000, 2000];

export interface Env {
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs: number;
  waitMaxMs: number;
}

/** The default fetch is wrapped so that it keeps its receiver, because the native one throws when it is stored unbound. */
export function defaultEnv(): Env {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    pollMs: TURN_POLL_MS,
    waitMaxMs: TURN_WAIT_MAX_MS,
  };
}

/* The wire ------------------------------------------------------------------------------------------------------ */

/** A failure of the transport while reading, kept apart from a parse failure so that only a dropped connection is recovered. */
export class StreamReadError extends Error {}

/** Splits buffered text into whole frames and the rest. A frame ends at a blank line. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

/** The JSON of a frame, or undefined for a frame with no data line (a comment or a heartbeat). */
export function frameData(frame: string): unknown {
  const lines = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (!lines.length) return undefined;
  return JSON.parse(lines.join("\n"));
}

/** Reads a stream body as frames. The body may be split at any byte. */
export async function* readFrames(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) return;
        throw new StreamReadError(e instanceof Error ? e.message : "The stream could not be read.");
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        const data = frameData(f);
        if (data !== undefined) yield data;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = frameData(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the reader may already be closed
    }
  }
}

/* The record helpers ------------------------------------------------------------------------------------------- */

const isLocal = (id: string) => id.startsWith("c_");
let counter = 0;
export const localId = (): string => `c_${Date.now().toString(36)}${(counter++).toString(36)}`;

const textOf = (m: NativeMessage): string =>
  m.role === "user" ? (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : "";

/** Whether the saved record already holds a copy of an optimistic entry. Only local entries are candidates, and they match by content. */
export function absorbed(entry: NativeMessage, record: readonly NativeMessage[]): boolean {
  if (!isLocal(entry.id)) return false;
  if (entry.role === "user") return record.some((m) => m.role === "user" && !isLocal(m.id) && textOf(m) === textOf(entry));
  if (entry.role === "toolResult") return record.some((m) => m.role === "toolResult" && m.toolCallId === entry.toolCallId);
  if (entry.role === "custom") {
    const key = JSON.stringify(entry.details ?? null);
    return record.some((m) => m.role === "custom" && m.customType === entry.customType && JSON.stringify(m.details ?? null) === key);
  }
  return false;
}

/** A steer line shows until its card lands in the messages. */
export function visibleQueuedSteers(queue: readonly Steer[], messages: readonly NativeMessage[]): Steer[] {
  const ids = new Set(messages.map((m) => m.id));
  return queue.filter((s) => !ids.has(s.id));
}

/** The record ends on answered tool calls and nothing dangles, so the server owes a continuation. */
export function needsContinuation(messages: readonly NativeMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "toolResult") return false;
  const d = last.details as { dismissed?: boolean; questionRecovery?: boolean } | undefined;
  if (d?.dismissed || d?.questionRecovery) return false;
  // a question or a practice problem ends the turn with a bare acknowledgement, and the learner is the next to act
  if ((isQuestionTool(last.toolName) || last.toolName === "problem") && !d) return false;
  return pendingQuestionOf(messages) === null;
}

/* The model ----------------------------------------------------------------------------------------------------- */

export interface Steer {
  id: string;
  text: string;
}

export interface QuestionDraft {
  form?: FormState;
  reading?: string;
}

export interface ViewState {
  status: Status;
  messages: NativeMessage[];
  /** the ids of assistant messages that are still streaming */
  streamingIds: ReadonlySet<string>;
  error: string | null;
  /** the body of the last refusal of an input, for the setup recovery */
  refusal: { status: number; code?: string; error: string } | null;
  steers: Steer[];
  compacting: boolean;
  turnInFlight: boolean;
  hasConfirmed: boolean;
  /** an assistant message ended in an error during this consume, or the saved record ends in one */
  failure: string | null;
  version: number;
}

export class SessionModel {
  readonly id: string;
  private env: Env;
  private base: NativeMessage[] = [];
  private tail: NativeMessage[] = [];
  private drafts = new Map<string, QuestionDraft>();
  private unconfirmed = new Map<string, string>();
  private status: Status = "ready";
  private errorValue: string | null = null;
  private refusal: ViewState["refusal"] = null;
  private blocked = false;
  private streamingId: string | null = null;
  private streamingIds = new Set<string>();
  private liveFailure: string | null = null;
  private steerQueue: Steer[] = [];
  private compacting = false;
  private turnInFlight = false;
  private attached = false;
  private settleAnnounced = false;
  private consumeAbort: AbortController | null = null;
  private latestRequest: AbortController | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private snapshot: ViewState | null = null;
  private disposed = false;

  constructor(id: string, env: Partial<Env> = {}) {
    this.id = id;
    this.env = { ...defaultEnv(), ...env };
  }

  /* subscription */
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): ViewState => {
    if (this.snapshot && this.snapshot.version === this.version) return this.snapshot;
    const messages = this.merged();
    const lastAssistant = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant" && !this.streamingIds.has(m.id));
    const failed = lastAssistant?.stopReason === "error" && messages[messages.length - 1] === lastAssistant;
    const live = this.status === "submitted" || this.status === "streaming";
    this.snapshot = {
      status: this.status,
      messages,
      streamingIds: new Set(this.streamingIds),
      error: this.errorValue,
      refusal: this.refusal,
      steers: visibleQueuedSteers(this.steerQueue, messages),
      compacting: this.compacting,
      turnInFlight: this.turnInFlight,
      hasConfirmed: this.base.some((m) => m.role === "user" || m.role === "assistant"),
      failure: failed && (!live || lastAssistant.id === this.liveFailure) ? String(lastAssistant.errorMessage ?? "The model returned an error.") : null,
      version: this.version,
    };
    return this.snapshot;
  };
  private notify(): void {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private merged(): NativeMessage[] {
    const ids = new Set(this.base.map((m) => m.id));
    return [...this.base, ...this.tail.filter((m) => !ids.has(m.id))];
  }

  /* status */
  private setStatus(next: Status): void {
    const was = this.status;
    this.status = next;
    this.notify();
    if (next === "ready" && was !== "ready" && this.settleAnnounced) {
      this.settleAnnounced = false;
      void this.sync();
    }
  }
  get isBusy(): boolean {
    return this.status === "submitted" || this.status === "streaming" || this.attached || this.turnInFlight;
  }
  get live(): boolean {
    return this.status === "submitted" || this.status === "streaming";
  }
  get currentStatus(): Status {
    return this.status;
  }

  /* drafts */
  saveDraft(key: string, part: QuestionDraft): void {
    const cur = this.drafts.get(key) ?? {};
    this.drafts.set(key, { ...cur, ...part });
  }
  draft(key: string): QuestionDraft | undefined {
    return this.drafts.get(key);
  }
  /** Keeps the draft of the question that is pending and forgets every other one. */
  private forgetResolved(): void {
    const key = pendingQuestionOf(this.merged(), this.streamingIds)?.key ?? null;
    for (const k of [...this.drafts.keys()]) if (k !== key) this.drafts.delete(k);
    for (const [id, k] of [...this.unconfirmed]) if (k !== key) this.unconfirmed.delete(id);
  }
  get pendingKey(): string | null {
    return pendingQuestionOf(this.merged(), this.streamingIds)?.key ?? null;
  }

  /* the record */
  /** The full swap: the record replaces the base and the tail goes. */
  setMessages(messages: NativeMessage[], turnError?: string | null): void {
    this.base = messages;
    this.tail = [];
    this.streamingId = null;
    this.streamingIds.clear();
    if (turnError) {
      this.errorValue = turnError;
      this.blocked = true;
    }
    this.forgetResolved();
    this.notify();
  }

  /** The append only swap. It does nothing when the record lost a message that the base holds, and leaves the full sync as the safety net. */
  adoptRecord(messages: NativeMessage[]): void {
    const ids = new Set(messages.map((m) => m.id));
    if (this.base.some((m) => !ids.has(m.id))) return;
    this.base = messages;
    this.tail = this.tail.filter((m) => !absorbed(m, messages));
    this.forgetResolved();
    this.notify();
  }

  seed(d: SessionDetail): void {
    this.compacting = d.compacting;
    this.turnInFlight = d.turnInFlight;
    this.setMessages(d.session.messages, d.turnError);
  }

  private async detail(signal?: AbortSignal): Promise<SessionDetail | null> {
    try {
      const res = await this.env.fetch(sessionPath.detail(this.id), { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as SessionDetail;
      if (!body || !Array.isArray(body.session?.messages)) return null;
      return body;
    } catch {
      return null;
    }
  }

  /** The full sync from the record, for a turn that settled or a record that changed. */
  async sync(): Promise<SessionDetail | null> {
    const d = await this.detail();
    if (!d || this.disposed) return d;
    this.compacting = d.compacting;
    this.turnInFlight = d.turnInFlight;
    if (this.live) {
      this.adoptRecord(d.session.messages);
    } else {
      this.attached = false;
      this.setMessages(d.session.messages, d.turnError);
      void this.continueIfOwed();
    }
    return d;
  }

  /** Posts a continue only when the record owes one, nothing is blocked and nothing is showing as an error. */
  async continueIfOwed(): Promise<boolean> {
    if (this.status !== "ready" || this.blocked || this.errorValue || this.turnInFlight) return false;
    if (!needsContinuation(this.merged())) return false;
    return this.send({ type: "continue" });
  }

  /* applying events */
  private upsertTail(m: NativeMessage): void {
    if (this.base.some((b) => b.id === m.id)) return;
    const i = this.tail.findIndex((t) => t.id === m.id);
    if (i >= 0) this.tail[i] = m;
    else this.tail.push(m);
  }

  /** Applies one frame with replace semantics. It returns true when the frame did work on the view. */
  applyFrame(ev: Record<string, unknown>): boolean {
    const type = ev.type;
    if (type === "error") {
      this.errorValue = typeof ev.errorText === "string" && ev.errorText ? ev.errorText : "The turn failed.";
      this.blocked = true;
      this.notify();
      return false;
    }
    if (type === "agent_start") {
      this.blocked = false;
      this.errorValue = null;
      this.notify();
      return false;
    }
    if (type === "message_start" || type === "message_update" || type === "message_end") {
      const m = ev.message as NativeMessage | undefined;
      if (!m || typeof m !== "object") return false;
      if (m.role !== "assistant") {
        if (!m.id) return false;
        this.upsertTail(m);
        this.notify();
        return true;
      }
      let id = m.id || this.streamingId;
      if (!id) id = localId();
      if (type === "message_start" || !this.streamingId) this.streamingId = id;
      const entry = { ...m, id } as AssistantMessage;
      this.streamingIds.add(id);
      this.upsertTail(entry);
      if (type === "message_end") {
        this.streamingIds.delete(id);
        this.streamingId = null;
        if (entry.stopReason === "error") {
          this.liveFailure = id;
          this.errorValue = null;
        }
      }
      this.notify();
      return true;
    }
    if (type === "turn_end") {
      const results = Array.isArray(ev.toolResults) ? (ev.toolResults as ToolResultMessage[]) : [];
      let did = false;
      for (const r of results) {
        if (!r || r.role !== "toolResult") continue;
        this.upsertTail({ ...r, id: r.id || localId() });
        did = true;
      }
      if (did) this.notify();
      return did;
    }
    return false;
  }

  /* the stream */
  stop(): void {
    this.consumeAbort?.abort();
    this.consumeAbort = null;
    this.attached = false;
    this.clearTimers();
    if (this.live) this.setStatus("ready");
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }
  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /** The one way to attach to a turn on the server. A fresh mount passes false and replays from a clean tail. */
  async resume(refetchRecordFirst = true, allowRecovery = true): Promise<void> {
    this.consumeAbort?.abort();
    const ctl = new AbortController();
    this.consumeAbort = ctl;
    this.latestRequest = ctl;
    if (!refetchRecordFirst) {
      this.tail = [];
      this.streamingIds.clear();
      this.streamingId = null;
    }
    this.attached = true;
    this.setStatus("submitted");
    try {
      if (refetchRecordFirst) {
        const d = await this.detail(ctl.signal);
        if (ctl.signal.aborted) return;
        if (d) {
          this.compacting = d.compacting;
          this.setMessages(d.session.messages, d.turnError);
        } else {
          this.tail = [];
          this.streamingIds.clear();
        }
      }
      const res = await this.env.fetch(sessionPath.stream(this.id), { signal: ctl.signal });
      if (!res.ok) throw new Error(await errorSentence(res, "The turn could not be followed."));
      await this.consume(res, ctl, allowRecovery);
    } catch (e) {
      if (ctl.signal.aborted) return;
      this.dropUnconfirmed();
      this.errorValue = e instanceof Error && e.message ? e.message : DROPPED_TEXT;
      this.blocked = true;
      this.attached = false;
      this.setStatus("error");
    }
  }

  private async consume(res: Response, ctl: AbortController, allowRecovery: boolean): Promise<void> {
    let complete = false;
    let dropped = false;
    try {
      for await (const raw of readFrames(res.body, ctl.signal)) {
        if (ctl.signal.aborted) return;
        const ev = raw as Record<string, unknown>;
        if (ev.type === "done") {
          complete = true;
          break;
        }
        if (ev.type === "turn-settled") {
          this.settleAnnounced = true;
          continue;
        }
        if (this.applyFrame(ev) && this.status === "submitted") this.setStatus("streaming");
      }
    } catch (e) {
      if (!(e instanceof StreamReadError)) throw e;
      dropped = true;
    }
    const owner = this.consumeAbort === ctl;
    if (!owner || ctl.signal.aborted) return;
    if (!complete || dropped) {
      if (allowRecovery) return this.resume(true, false);
      throw new Error(DROPPED_TEXT);
    }
    this.attached = false;
    this.turnInFlight = false;
    this.streamingIds.clear();
    this.streamingId = null;
    this.setStatus("ready");
    if (!this.settleAnnounced) void this.sync();
  }

  private dropUnconfirmed(): void {
    if (!this.unconfirmed.size) return;
    this.tail = this.tail.filter((m) => !this.unconfirmed.has(m.id));
    this.unconfirmed.clear();
  }

  /* sending */
  private async pollInFlight(signal: AbortSignal): Promise<boolean | null> {
    try {
      const res = await this.env.fetch(sessionPath.jobs(this.id), { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { turnInFlight?: unknown };
      return typeof body.turnInFlight === "boolean" ? body.turnInFlight : null;
    } catch {
      return null;
    }
  }

  /** Posts once. While the answer is 409, waits for the job feed to say that no turn runs and posts the same body again, for up to the wait limit. */
  async postInput(body: string, signal: AbortSignal): Promise<Response> {
    const post = () => this.env.fetch(sessionPath.input(this.id), { method: "POST", headers: { "content-type": "application/json" }, body, signal });
    let waited = 0;
    for (;;) {
      const res = await post();
      if (res.status !== 409) return res;
      try {
        await res.body?.cancel();
      } catch {
        // already read
      }
      for (;;) {
        if (waited >= this.env.waitMaxMs) return res;
        await this.env.sleep(this.env.pollMs, signal);
        if (signal.aborted) return res;
        waited += this.env.pollMs;
        if ((await this.pollInFlight(signal)) === false) break;
      }
    }
  }

  private optimisticAnswer(toolCallId: string, tool: string, answer: AnswerRequest, questionText: string, key: string): ToolResultMessage {
    const id = localId();
    this.unconfirmed.set(id, key);
    return {
      role: "toolResult",
      id,
      toolCallId,
      toolName: tool,
      isError: false,
      content: [{ type: "text", text: "The learner answered." }],
      details: {
        kind: kindOfTool(tool),
        tool,
        questionText,
        answers: [],
        ...(answer.text ? { text: answer.text } : {}),
        ...(answer.other ? { other: answer.other } : {}),
        ...(answer.dontKnow ? { dontKnow: true } : {}),
        ...(answer.thinking ? { thinking: answer.thinking } : {}),
        ...(answer.readingThinking ? { readingThinking: answer.readingThinking } : {}),
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
        answeredAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Sends one input. It returns true only when the server acknowledged the post. False does not prove that the input was
   * not delivered, because a network failure can hide an acceptance, so a caller restores its draft and never retries alone.
   */
  async send(input: InputEvent, opts: { questionKey?: string; opening?: boolean; onAccepted?: () => void } = {}): Promise<boolean> {
    if (this.status !== "ready" && this.status !== "error") return false;
    const pending = pendingQuestionOf(this.merged(), this.streamingIds);
    if (input.type === "answer") {
      if (!pending || pending.toolCallId !== input.toolCallId) return false;
      if (opts.questionKey && opts.questionKey !== pending.key && opts.questionKey !== pending.toolCallId) return false;
    }
    const was = this.status;
    this.consumeAbort?.abort();
    this.latestRequest?.abort();
    const ctl = new AbortController();
    const req = new AbortController();
    this.consumeAbort = ctl;
    this.latestRequest = req;
    this.errorValue = null;
    this.refusal = null;
    this.liveFailure = null;
    this.setStatus("submitted");

    // an answer from the error state first reads the record, because a lost acknowledgement must never send it twice
    if (was === "error" && input.type === "answer") {
      const d = await this.detail(req.signal);
      if (typeof d?.turnInFlight !== "boolean") {
        this.errorValue = "The record could not be checked, so the answer was not sent. Your answer is kept.";
        this.setStatus("error");
        return false;
      }
      this.turnInFlight = d.turnInFlight;
      if (d.turnInFlight) {
        void this.resume(false);
        return false;
      }
      if (pendingQuestionOf(d.session.messages)?.toolCallId !== input.toolCallId) {
        this.setMessages(d.session.messages, d.turnError);
        this.setStatus("ready");
        return false;
      }
    }
    if (input.type !== "continue") this.blocked = false;

    let optimistic: NativeMessage | null = null;
    if (input.type === "text") optimistic = { role: "user", id: localId(), content: input.text, timestamp: Date.now() };
    else if (input.type === "answer" && pending) optimistic = this.optimisticAnswer(input.toolCallId, pending.tool, input.answer, pending.question?.question ?? "", pending.key);
    else if (input.type === "thinking") optimistic = { role: "custom", id: localId(), customType: "practice-thinking", content: input.text, details: { problemCallId: input.problemCallId, text: input.text } };
    else if (input.type === "next") optimistic = { role: "custom", id: localId(), customType: "practice-next", content: "", details: null };
    if (optimistic) this.tail.push(optimistic);
    this.notify();

    let acknowledged = false;
    try {
      const res = await this.postInput(JSON.stringify({ input }), req.signal);
      if (res.status === 409) throw new Error(STILL_RUNNING_TEXT);
      if (!res.ok) {
        const body = await readError(res);
        this.refusal = { status: res.status, code: body.code, error: body.error };
        throw new Error(body.error);
      }
      acknowledged = true;
      opts.onAccepted?.();
      try {
        await res.text();
      } catch {
        // the acknowledgement is short and its body does not matter
      }
      if (this.consumeAbort !== ctl) return true;
      this.windows();
      await this.resume(true, true);
      return true;
    } catch (e) {
      if (!acknowledged && optimistic) {
        const id = optimistic.id;
        this.tail = this.tail.filter((m) => m.id !== id);
        this.unconfirmed.delete(id);
      }
      if (this.latestRequest !== req) return acknowledged;
      this.errorValue = e instanceof Error && e.message ? e.message : "The input could not be sent.";
      this.blocked = true;
      this.setStatus("error");
      return acknowledged;
    }
  }

  /** Three bounded windows after a local turn starts, in which claimed steers appear in the record before the stream produces anything. */
  private windows(): void {
    this.clearTimers();
    for (const ms of ADOPT_WINDOWS_MS) {
      this.timers.push(
        setTimeout(() => {
          if (this.disposed || !this.live) return;
          void this.detail().then((d) => {
            if (d && this.live) this.adoptRecord(d.session.messages);
          });
        }, ms),
      );
    }
  }

  /** A learner message during a running turn. It starts nothing, shows as a quiet line and lands as a card when the agent takes it. */
  async steer(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const entry: Steer = { id: `steer_${localId()}`, text };
    this.steerQueue.push(entry);
    this.notify();
    const drop = () => {
      this.steerQueue = this.steerQueue.filter((s) => s.id !== entry.id);
      this.notify();
    };
    try {
      const res = await this.env.fetch(sessionPath.steer(this.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.id, text }) });
      if (res.ok) return;
      if (res.status === 409) {
        drop();
        await this.send({ type: "text", text });
        return;
      }
      const body = await readError(res);
      drop();
      this.errorValue = body.error;
      this.notify();
    } catch (e) {
      drop();
      this.errorValue = e instanceof Error ? e.message : "The message could not be sent.";
      this.notify();
    }
  }

  /** Dismisses the pending question. It starts no turn, and the optimistic result stays until the record replaces it. */
  async dismissQuestion(opts: { toolCallId: string; questionKey?: string; readingThinking?: string }): Promise<boolean> {
    if (this.status !== "ready") return false;
    const pending = pendingQuestionOf(this.merged(), this.streamingIds);
    if (!pending || pending.toolCallId !== opts.toolCallId) return false;
    if (opts.questionKey && opts.questionKey !== pending.key && opts.questionKey !== pending.toolCallId) return false;
    const r = this.optimisticAnswer(pending.toolCallId, pending.tool, { ...(opts.readingThinking ? { readingThinking: opts.readingThinking } : {}) }, pending.question?.question ?? "", pending.key);
    (r.details as Record<string, unknown>).dismissed = true;
    this.tail.push(r);
    this.notify();
    return this.postSilent({ toolCallId: opts.toolCallId });
  }

  async dismissProblem(problemCallId: string): Promise<boolean> {
    if (this.status !== "ready") return false;
    this.tail.push({ role: "custom", id: localId(), customType: "problem-dismissed", content: "", details: { problemCallId } } as CustomMessage);
    this.notify();
    return this.postSilent({ problemCallId });
  }

  private async postSilent(body: Record<string, string>): Promise<boolean> {
    try {
      const res = await this.env.fetch(sessionPath.dismiss(this.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return true;
      this.errorValue = `The dismissal failed (${res.status}).`;
    } catch {
      this.errorValue = "The dismissal failed.";
    }
    this.notify();
    return false;
  }

  /** Ends the local view of the turn at once, keeps the partial answer and asks the server to abort. A 409 means the turn had already ended. */
  async abort(): Promise<void> {
    this.stop();
    try {
      const res = await this.env.fetch(sessionPath.abort, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "turn", id: this.id }) });
      if (!res.ok && res.status !== 409) this.errorValue = "The turn could not be stopped.";
    } catch {
      this.errorValue = "The turn could not be stopped.";
    }
    this.turnInFlight = false;
    this.notify();
    void this.sync();
  }

  /* learning stream events: notify, then fetch */
  async onEvent(name: "turn-started" | "turn-settled" | "record-changed" | "compaction-changed"): Promise<void> {
    if (this.disposed) return;
    if (name === "turn-started") {
      if (this.live || this.attached) return;
      const d = await this.detail();
      if (d?.turnInFlight && !this.live && !this.attached) {
        this.compacting = d.compacting;
        void this.resume(false);
      }
      return;
    }
    if (name === "turn-settled") {
      if (this.live) {
        this.settleAnnounced = true;
        return;
      }
      if (this.attached && this.status === "error") this.attached = false;
      await this.sync();
      return;
    }
    if (name === "record-changed") {
      if (this.live || this.attached) return;
      await this.sync();
      return;
    }
    const d = await this.detail();
    if (d) {
      this.compacting = d.compacting;
      this.notify();
    }
  }

  /** The first load of a session. A turn in flight is attached to with the clean slate rule. */
  async open(): Promise<SessionDetail | null> {
    const d = await this.detail();
    if (!d) {
      this.errorValue = "The session could not be loaded.";
      this.setStatus("error");
      return null;
    }
    this.seed(d);
    if (d.turnInFlight) void this.resume(false);
    else void this.continueIfOwed();
    return d;
  }
}

async function readError(res: Response): Promise<{ error: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    return { error: typeof body.error === "string" && body.error ? body.error : `The server answered with status ${res.status}.`, code: typeof body.code === "string" ? body.code : undefined };
  } catch {
    return { error: `The server answered with status ${res.status}.` };
  }
}

async function errorSentence(res: Response, fallback: string): Promise<string> {
  return (await readError(res)).error || fallback;
}

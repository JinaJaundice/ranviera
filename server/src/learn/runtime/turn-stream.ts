// The per turn stream of CONTRACTS "Turn stream, stream messages and event
// kinds". The log keeps settled events as they are and only the newest snapshot
// of each in flight slot (one for the message and one for each tool call). A
// subscriber is attached and replayed synchronously, so no event falls between
// the replay and the live frames. Live frames are coalesced to at most one in
// each flush window, with pending updates always written before a boundary.
import type { TurnFrame } from "../../../../shared/learn/index.ts";

export const FLUSH_MS = 100;

export interface FrameSink {
  write(frame: TurnFrame): void;
  end(): void;
}

/** The slot of a frame that only updates in place, or null for a boundary frame. */
function slotOf(frame: TurnFrame): string | null {
  if (frame.type === "message_update") return "message";
  if (frame.type === "tool_execution_update") return `tool:${String(frame.toolCallId)}`;
  return null;
}

/** The slot that a boundary frame closes, so that a later update opens a new entry. */
function closedSlot(frame: TurnFrame): string | null {
  if (frame.type === "message_end" || frame.type === "message_start") return "message";
  if (frame.type === "tool_execution_end") return `tool:${String(frame.toolCallId)}`;
  return null;
}

interface Subscriber {
  sink: FrameSink;
  pending: Map<string, TurnFrame>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TurnStream {
  private entries: { frame: TurnFrame; slot: string | null }[] = [];
  private openSlots = new Map<string, number>();
  private subscribers = new Set<Subscriber>();
  private finished = false;
  private flushMs: number;

  constructor(flushMs = FLUSH_MS) {
    this.flushMs = flushMs;
  }

  /** The frames a late subscriber would receive. */
  get log(): readonly TurnFrame[] {
    return this.entries.map((e) => e.frame);
  }

  get ended(): boolean {
    return this.finished;
  }

  push(frame: TurnFrame): void {
    if (this.finished) return;
    const slot = slotOf(frame);
    if (slot) {
      const at = this.openSlots.get(slot);
      if (at !== undefined) this.entries[at] = { frame, slot };
      else {
        this.openSlots.set(slot, this.entries.length);
        this.entries.push({ frame, slot });
      }
    } else {
      const closed = closedSlot(frame);
      if (closed) this.openSlots.delete(closed);
      this.entries.push({ frame, slot: null });
    }
    for (const sub of [...this.subscribers]) this.deliver(sub, frame, slot);
    if (frame.type === "done") {
      this.finished = true;
      for (const sub of [...this.subscribers]) {
        this.flush(sub);
        sub.sink.end();
      }
      this.subscribers.clear();
    }
  }

  private deliver(sub: Subscriber, frame: TurnFrame, slot: string | null): void {
    if (slot) {
      sub.pending.set(slot, frame);
      if (!sub.timer) sub.timer = setTimeout(() => this.flush(sub), this.flushMs);
      return;
    }
    this.flush(sub);
    this.write(sub, frame);
  }

  private flush(sub: Subscriber): void {
    if (sub.timer) {
      clearTimeout(sub.timer);
      sub.timer = null;
    }
    const frames = [...sub.pending.values()];
    sub.pending.clear();
    for (const f of frames) this.write(sub, f);
  }

  private write(sub: Subscriber, frame: TurnFrame): void {
    try {
      sub.sink.write(frame);
    } catch {
      this.detach(sub);
    }
  }

  private detach(sub: Subscriber): void {
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = null;
    sub.pending.clear();
    this.subscribers.delete(sub);
  }

  /** Attaches a sink, replays the log synchronously and then follows live. Returns the detach function. */
  subscribe(sink: FrameSink): () => void {
    const sub: Subscriber = { sink, pending: new Map(), timer: null };
    if (!this.finished) this.subscribers.add(sub);
    for (const entry of [...this.entries]) this.write(sub, entry.frame);
    if (this.finished) sink.end();
    return () => this.detach(sub);
  }
}

/** The short stream of a session with no running turn: any retained failure, the settled frame and done. */
export function shortStream(failureNotice?: string): TurnStream {
  const stream = new TurnStream();
  if (failureNotice) stream.push({ type: "error", errorText: failureNotice });
  stream.push({ type: "turn-settled" });
  stream.push({ type: "done" });
  return stream;
}

/** One Server-Sent Events frame: data, then a blank line, with no event line. */
export function sseFrame(frame: TurnFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

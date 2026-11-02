// Route 23: steering a running turn. A steer is a learner message sent while a
// turn runs. It goes into the queue of the live agent and is delivered at the
// next safe boundary, which is after a completed assistant message and its tool
// results. The client chooses the identifier, and the same identifier appears
// in the live stream and in the saved record, so that the client can hide the
// queued line once the message lands. A steer never starts or extends a turn.
import type { Agent } from "@earendil-works/pi-agent-core";

export interface Steer {
  id: string;
  text: string;
}

export interface SteerMessage {
  role: "user";
  id: string;
  content: string;
  timestamp: number;
}

export const toSteerMessage = (steer: Steer, now: number): SteerMessage => ({ role: "user", id: steer.id, content: steer.text, timestamp: now });

/** Steers that a run ended without draining, kept in memory for the next run of the session. */
export class SteeringRegistry {
  private parked = new Map<string, Steer[]>();

  /** Queues a steer on a live agent. Returns false when there is no live agent. The call is synchronous. */
  steer(agent: Agent | null | undefined, steer: Steer, now: number): boolean {
    if (!agent) return false;
    agent.steer(toSteerMessage(steer, now) as never);
    return true;
  }

  /** At settlement: whatever is still queued on the agent is kept for the next run. */
  parkUndelivered(sessionId: string, agent: Agent | null | undefined, delivered: ReadonlySet<string>): void {
    if (!agent) return;
    const left: Steer[] = [];
    for (const m of agent.peekQueuedMessages()) {
      const s = m as unknown as { id?: unknown; content?: unknown };
      if (typeof s.id === "string" && typeof s.content === "string" && !delivered.has(s.id)) left.push({ id: s.id, text: s.content });
    }
    agent.clearAllQueues();
    if (left.length) this.parked.set(sessionId, [...(this.parked.get(sessionId) ?? []), ...left]);
  }

  /** The steers of the previous run, for the first boundary of the next one. */
  takeParked(sessionId: string): Steer[] {
    const out = this.parked.get(sessionId) ?? [];
    this.parked.delete(sessionId);
    return out;
  }

  forget(sessionId: string): void {
    this.parked.delete(sessionId);
  }
}

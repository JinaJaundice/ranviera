// Route 24: a silent dismissal. It writes the dismissal result or marker and
// wakes no model. While a turn runs, its messages are not saved yet, so the
// stored record shows no open question and the dismissal cannot be checked. It
// is then parked, one for each session, and applied after the turn's messages
// are saved and before the turn is marked as ended.
import type { SessionStore } from "./store.ts";
import { RuntimeError } from "./errors.ts";
import { planDismissal, type InputContext } from "./inputs.ts";
import type { Emit } from "./deps.ts";

export interface ParkedDismissal {
  toolCallId?: unknown;
  problemCallId?: unknown;
}

export class DismissalPark {
  private parked = new Map<string, ParkedDismissal>();

  /** A later park overwrites an earlier one, because there is one dock and one discard. */
  park(sessionId: string, body: ParkedDismissal): void {
    this.parked.set(sessionId, body);
  }

  take(sessionId: string): ParkedDismissal | null {
    const body = this.parked.get(sessionId) ?? null;
    this.parked.delete(sessionId);
    return body;
  }

  forget(sessionId: string): void {
    this.parked.delete(sessionId);
  }

  /** Applies the parked dismissal to the freshly saved record. A dismissal that targets nothing is dropped. */
  apply(sessionId: string, store: SessionStore, emit: Emit, ctx: InputContext): boolean {
    const body = this.take(sessionId);
    if (!body) return false;
    const record = store.get(sessionId);
    if (!record) return false;
    try {
      const messages = planDismissal(record.messages, body, ctx);
      store.appendMessages(sessionId, messages);
    } catch (e) {
      if (e instanceof RuntimeError && e.status === 400) return false;
      throw e;
    }
    emit({ type: "learn", event: "record-changed", session: sessionId });
    return true;
  }
}

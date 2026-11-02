// Delivery of job results into the conversation. There are two vehicles and one queue for each session.
//
// A live turn: while a turn runs, the marker goes to the steering queue of the live agent, which drains it at the
// next safe boundary. A marker that the run never took is parked by the runtime for the next run, and the entry
// returns to pending when the turn has settled.
//
// An idle wake: when no turn runs and no question waits for an answer, the pump waits a grace period so that a
// client that has just answered can send its own continuation, checks again, and then saves every pending marker
// and starts one turn. A 409 backs off through 500, 1,000, 2,000 and 5,000 ms. Any other failure leaves the
// entries pending and quiet, with no timer, until a learner run or a restart.
//
// Only a marker that is in the saved record acknowledges delivery. The coordination is in one process over JSON
// records. It is not a transactional queue and it does not promise exactly once execution.
import { RuntimeError } from "../runtime/errors.ts";
import { danglingQuestions } from "../runtime/scans.ts";
import type { JobsDeps } from "./types.ts";
import { markerMessage, type SteerBuild } from "./steer.ts";

interface Entry {
  build: SteerBuild;
  jobId: string;
  /** given to the steering queue of a live agent */
  handed: boolean;
}

export const WAKE_GRACE_MS = 750;
export const POLL_MS = 400;
export const BACKOFF_MS = [500, 1000, 2000, 5000];
/** wake attempts that return without saving the markers, before the entries go quiet */
const MAX_BARREN_ATTEMPTS = 5;

type DeliveryDeps = Pick<JobsDeps, "store" | "turns" | "wake" | "now" | "sleep" | "log" | "wakeGraceMs" | "pollMs" | "backoffMs"> & {
  markDelivered: (jobId: string) => void;
};

export class Delivery {
  private readonly entries = new Map<string, Entry[]>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly quiet = new Set<string>();
  private readonly deps: DeliveryDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: DeliveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Queues a marker. The identifier is deterministic, so a second call for the same job adds nothing. */
  queue(sessionId: string, jobId: string, build: SteerBuild): void {
    const list = this.entries.get(sessionId) ?? [];
    if (list.some((e) => e.build.id === build.id)) return;
    list.push({ build, jobId, handed: false });
    this.entries.set(sessionId, list);
    this.quiet.delete(sessionId);
    this.start(sessionId);
  }

  /** The marker identifiers that wait for a session. */
  pending(sessionId: string): string[] {
    return (this.entries.get(sessionId) ?? []).map((e) => e.build.id);
  }

  /** Drops the queued deliveries of a session without starting a turn, for a deleted session. */
  discard(sessionId: string): void {
    this.entries.delete(sessionId);
    this.quiet.delete(sessionId);
  }

  /** A learner run took place, so entries that went quiet may try again. */
  resume(sessionId: string): void {
    this.quiet.delete(sessionId);
    if (this.entries.get(sessionId)?.length) this.start(sessionId);
  }

  isQuiet(sessionId: string): boolean {
    return this.quiet.has(sessionId);
  }

  /** Resolves when the pump loops that run now have ended. For tests and for an orderly stop. */
  async whenIdle(): Promise<void> {
    while (this.loops.size) await Promise.all([...this.loops.values()]);
  }

  private start(sessionId: string): void {
    if (this.loops.has(sessionId)) return;
    const loop = this.pump(sessionId)
      .catch((e) => this.deps.log?.(`Job delivery for ${sessionId} stopped: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.loops.delete(sessionId));
    this.loops.set(sessionId, loop);
  }

  /** Removes the entries whose marker is in the saved record and marks their jobs as delivered. */
  private reconcile(sessionId: string): boolean {
    const list = this.entries.get(sessionId);
    if (!list) return false;
    const record = this.deps.store.get(sessionId);
    if (!record) {
      this.entries.delete(sessionId);
      return false;
    }
    const present = new Set(record.messages.map((m) => m.id));
    const rest: Entry[] = [];
    for (const e of list) {
      if (present.has(e.build.id)) {
        try {
          this.deps.markDelivered(e.jobId);
        } catch (err) {
          // a failed note never replays a saved marker and never changes the outcome of the worker
          this.deps.log?.(`Job ${e.jobId} was delivered, but the note could not be saved: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else rest.push(e);
    }
    if (rest.length) this.entries.set(sessionId, rest);
    else this.entries.delete(sessionId);
    return rest.length > 0;
  }

  private async pump(sessionId: string): Promise<void> {
    const grace = this.deps.wakeGraceMs ?? WAKE_GRACE_MS;
    const poll = this.deps.pollMs ?? POLL_MS;
    const ramp = this.deps.backoffMs ?? BACKOFF_MS;
    let step = 0;
    let barren = 0;
    for (;;) {
      if (!this.reconcile(sessionId)) return;
      const list = this.entries.get(sessionId) ?? [];
      if (this.deps.turns.isRunning(sessionId)) {
        for (const e of list) {
          if (e.handed) continue;
          e.handed = this.deps.turns.steer(sessionId, { id: e.build.id, text: e.build.content });
        }
        await this.sleep(poll);
        continue;
      }
      // the run settled: whatever it never took returns to pending
      for (const e of list) e.handed = false;
      if (this.quiet.has(sessionId)) return;
      const record = this.deps.store.get(sessionId);
      if (record && danglingQuestions(record.messages).length > 0) {
        await this.sleep(poll);
        continue;
      }
      await this.sleep(grace);
      if (this.deps.turns.isRunning(sessionId) || !this.reconcile(sessionId)) continue;
      const waiting = this.entries.get(sessionId) ?? [];
      try {
        await this.deps.wake(sessionId, waiting.map((e) => markerMessage(e.build, this.now())));
      } catch (e) {
        if (e instanceof RuntimeError && e.status === 409) {
          await this.sleep(ramp[Math.min(step, ramp.length - 1)]);
          step += 1;
          continue;
        }
        this.deps.log?.(`Job delivery for ${sessionId} could not start a turn: ${e instanceof Error ? e.message : String(e)}`);
        this.reconcile(sessionId);
        this.quiet.add(sessionId);
        return;
      }
      if (!this.reconcile(sessionId)) return;
      barren += 1;
      if (barren >= MAX_BARREN_ATTEMPTS) {
        this.quiet.add(sessionId);
        return;
      }
      await this.sleep(poll);
    }
  }
}

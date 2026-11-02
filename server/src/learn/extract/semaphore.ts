// A first in first out semaphore that stops waiting when a signal aborts. The pipeline uses one with 3 permits for
// all background model work (docs/CONTRACTS.md, "Limits") and one with a single permit as the audit lock.
//
// A permit that is handed to a waiter stays counted as taken, so it is never counted twice. A waiter that aborts
// leaves the queue, and the permit goes to the next live waiter.

export class AbortedError extends Error {
  constructor(message = "The extraction was stopped.") {
    super(message);
    this.name = "AbortedError";
  }
}

export type Release = () => void;

interface Ticket {
  resolve: (release: Release) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  dead: boolean;
}

export class Semaphore {
  readonly limit: number;
  private taken = 0;
  private readonly queue: Ticket[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("A semaphore needs a limit of at least 1.");
    this.limit = limit;
  }

  /** Permits in use. */
  get active(): number {
    return this.taken;
  }

  /** Callers that wait for a permit. */
  get waiting(): number {
    return this.queue.filter((t) => !t.dead).length;
  }

  private releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.handOff();
    };
  }

  private handOff(): void {
    for (;;) {
      const next = this.queue.shift();
      if (!next) {
        this.taken -= 1;
        return;
      }
      if (next.dead) continue;
      // the permit passes to the waiter and stays counted
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve(this.releaser());
      return;
    }
  }

  /** Waits for a permit. Rejects with AbortedError when the signal aborts first. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (this.taken < this.limit) {
      this.taken += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<Release>((resolve, reject) => {
      const ticket: Ticket = { resolve, reject, signal, dead: false };
      if (signal) {
        ticket.onAbort = () => {
          ticket.dead = true;
          const at = this.queue.indexOf(ticket);
          if (at >= 0) this.queue.splice(at, 1);
          reject(new AbortedError());
        };
        signal.addEventListener("abort", ticket.onAbort, { once: true });
      }
      this.queue.push(ticket);
    });
  }
}

/** The permits for all background model work. */
export const BACKGROUND_PERMITS = 3;

const KEY = Symbol.for("cortex.learn.backgroundSemaphore");

/** The semaphore of this process. The jobs phase takes it from here or from the extract service, so that both share 3 permits. */
export function processSemaphore(): Semaphore {
  const g = globalThis as Record<symbol, unknown>;
  let s = g[KEY] as Semaphore | undefined;
  if (!s) {
    s = new Semaphore(BACKGROUND_PERMITS);
    g[KEY] = s;
  }
  return s;
}

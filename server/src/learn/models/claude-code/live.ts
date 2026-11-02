// Claude Code provider: held processes. A process is kept alive only while tool calls wait for results, because the
// bridge call is held open. It may continue only when the stream owner, the session identifier, the set of call
// identifiers, the history and the whole configuration all match. An idle process is killed after 10 minutes, which
// is shorter than the 30 minutes of the MCP timeout, so that the application times out first. Without a held process
// that qualifies, the caller replays the history into a fresh process.

export const HOLD_IDLE_MS = 10 * 60 * 1000;

export interface HeldHandle {
  /** ends the process and releases its folders and bridge. Safe to call twice. */
  dispose(): void;
  alive(): boolean;
  /** true when the process printed anything while it was held */
  hasPendingOutput(): boolean;
  /** calls back once when the process ends by itself, with the text to report on the continuation */
  onExit(cb: (message: string) => void): void;
}

export interface HoldKey {
  /** the provider instance that started the process */
  owner: string;
  sessionId: string;
  callIds: string[];
  historyHash: string;
  configHash: string;
}

export type TakeResult<H> = { kind: "held"; held: H } | { kind: "failed"; message: string } | null;

export interface LiveOptions {
  idleMs?: number;
}

interface Entry<H> {
  key: HoldKey;
  held: H;
  timer: ReturnType<typeof setTimeout>;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return s.size === a.length && b.every((x) => s.has(x));
}

export class LiveProcesses<H extends HeldHandle = HeldHandle> {
  readonly idleMs: number;
  #entries = new Map<string, Entry<H>>();
  #failures = new Map<string, { callIds: string[]; message: string }>();

  constructor(options: LiveOptions = {}) {
    this.idleMs = options.idleMs ?? HOLD_IDLE_MS;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Holds a process. An earlier process of the same session is ended. */
  hold(key: HoldKey, held: H): void {
    this.#drop(key.sessionId);
    this.#failures.delete(key.sessionId);
    const timer = setTimeout(() => {
      const e = this.#entries.get(key.sessionId);
      if (e && e.held === held) {
        this.#entries.delete(key.sessionId);
        held.dispose();
      }
    }, this.idleMs);
    timer.unref?.();
    this.#entries.set(key.sessionId, { key, held, timer });
    // A process that ends while held leaves its failure for the continuation, so that no silent replay hides it.
    held.onExit((message) => {
      const e = this.#entries.get(key.sessionId);
      if (!e || e.held !== held) return;
      clearTimeout(e.timer);
      this.#entries.delete(key.sessionId);
      this.#failures.set(key.sessionId, { callIds: key.callIds, message });
    });
  }

  /** Takes the process out when every part of the key matches. A process that does not match is ended. */
  take(query: HoldKey): TakeResult<H> {
    const failure = this.#failures.get(query.sessionId);
    if (failure) {
      this.#failures.delete(query.sessionId);
      if (sameSet(failure.callIds, query.callIds)) return { kind: "failed", message: failure.message };
    }
    const e = this.#entries.get(query.sessionId);
    if (!e) return null;
    const k = e.key;
    const match =
      k.owner === query.owner &&
      k.sessionId === query.sessionId &&
      sameSet(k.callIds, query.callIds) &&
      k.historyHash === query.historyHash &&
      k.configHash === query.configHash;
    clearTimeout(e.timer);
    this.#entries.delete(query.sessionId);
    if (!match || !e.held.alive() || e.held.hasPendingOutput()) {
      e.held.dispose();
      return null;
    }
    return { kind: "held", held: e.held };
  }

  #drop(sessionId: string): void {
    const e = this.#entries.get(sessionId);
    if (!e) return;
    clearTimeout(e.timer);
    this.#entries.delete(sessionId);
    e.held.dispose();
  }

  disposeAll(): void {
    for (const id of [...this.#entries.keys()]) this.#drop(id);
    this.#failures.clear();
  }
}

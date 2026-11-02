import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_IDLE_MS, LiveProcesses, type HeldHandle, type HoldKey } from "./live.ts";

class Fake implements HeldHandle {
  disposed = 0;
  isAlive = true;
  pending = false;
  #exit: ((m: string) => void)[] = [];
  dispose(): void {
    this.disposed++;
  }
  alive(): boolean {
    return this.isAlive;
  }
  hasPendingOutput(): boolean {
    return this.pending;
  }
  onExit(cb: (m: string) => void): void {
    this.#exit.push(cb);
  }
  die(message: string): void {
    this.isAlive = false;
    for (const cb of this.#exit) cb(message);
  }
}

const key = (over: Partial<HoldKey> = {}): HoldKey => ({ owner: "o1", sessionId: "chat_1", callIds: ["a", "b"], historyHash: "h", configHash: "c", ...over });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("held processes", () => {
  it("holds for 10 minutes and continues when the answer comes just before", () => {
    expect(HOLD_IDLE_MS).toBe(600_000);
    const live = new LiveProcesses<Fake>();
    const f = new Fake();
    live.hold(key(), f);
    vi.advanceTimersByTime(HOLD_IDLE_MS - 1);
    const r = live.take(key({ callIds: ["b", "a"] }));
    expect(r).toEqual({ kind: "held", held: f });
    expect(f.disposed).toBe(0);
    expect(live.size).toBe(0);
  });

  it("kills the process at 10 minutes and offers nothing, so the caller replays into a fresh process", () => {
    const live = new LiveProcesses<Fake>();
    const f = new Fake();
    live.hold(key(), f);
    vi.advanceTimersByTime(HOLD_IDLE_MS);
    expect(f.disposed).toBe(1);
    expect(live.take(key())).toBeNull();
  });

  it("restarts the clock for a process that is held again", () => {
    const live = new LiveProcesses<Fake>();
    const a = new Fake();
    live.hold(key(), a);
    vi.advanceTimersByTime(HOLD_IDLE_MS - 10);
    const b = new Fake();
    live.hold(key(), b);
    expect(a.disposed).toBe(1);
    vi.advanceTimersByTime(HOLD_IDLE_MS - 10);
    expect(b.disposed).toBe(0);
    vi.advanceTimersByTime(20);
    expect(b.disposed).toBe(1);
  });

  it.each([
    ["owner", { owner: "o2" }],
    ["session", { sessionId: "chat_2" }],
    ["call identifiers", { callIds: ["a"] }],
    ["more call identifiers", { callIds: ["a", "b", "c"] }],
    ["other call identifiers", { callIds: ["a", "z"] }],
    ["history", { historyHash: "other" }],
    ["configuration", { configHash: "other" }],
  ])("does not reuse a process after a change in the %s", (_name, change) => {
    const live = new LiveProcesses<Fake>();
    const f = new Fake();
    live.hold(key(), f);
    const r = live.take(key(change));
    expect(r).toBeNull();
    if (!("sessionId" in change)) expect(f.disposed).toBe(1);
  });

  it("does not reuse a process that printed while it was held or has died", () => {
    const live = new LiveProcesses<Fake>();
    const noisy = new Fake();
    noisy.pending = true;
    live.hold(key(), noisy);
    expect(live.take(key())).toBeNull();
    expect(noisy.disposed).toBe(1);
    const dead = new Fake();
    live.hold(key(), dead);
    dead.isAlive = false;
    expect(live.take(key())).toBeNull();
  });

  it("reports a failure that happened while held on the continuation instead of replaying silently", () => {
    const live = new LiveProcesses<Fake>();
    const f = new Fake();
    live.hold(key(), f);
    f.die("claude CLI exited with code 1 while a tool call was waiting.");
    expect(live.take(key())).toEqual({ kind: "failed", message: "claude CLI exited with code 1 while a tool call was waiting." });
    expect(live.take(key())).toBeNull();
  });

  it("does not report a failure for a different set of calls", () => {
    const live = new LiveProcesses<Fake>();
    const f = new Fake();
    live.hold(key(), f);
    f.die("gone");
    expect(live.take(key({ callIds: ["x"] }))).toBeNull();
  });

  it("disposeAll ends every held process", () => {
    const live = new LiveProcesses<Fake>();
    const a = new Fake();
    const b = new Fake();
    live.hold(key(), a);
    live.hold(key({ sessionId: "chat_2" }), b);
    live.disposeAll();
    expect([a.disposed, b.disposed]).toEqual([1, 1]);
    expect(live.size).toBe(0);
  });
});

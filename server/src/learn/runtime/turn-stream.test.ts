import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnFrame } from "../../../../shared/learn/index.ts";
import { TurnStream, shortStream, sseFrame } from "./turn-stream.ts";

const frame = (f: Record<string, unknown>) => f as unknown as TurnFrame;
const update = (text: string) => frame({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
const types = (frames: TurnFrame[]) => frames.map((f) => f.type);

function sink() {
  const got: TurnFrame[] = [];
  let ended = false;
  return { got, get ended() { return ended; }, sink: { write: (f: TurnFrame) => void got.push(f), end: () => { ended = true; } } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("turn stream", () => {
  it("keeps only the newest snapshot of an in flight slot and replays it (B-7-10)", () => {
    const s = new TurnStream();
    s.push(frame({ type: "agent_start" }));
    s.push(frame({ type: "message_start", message: { role: "assistant" } }));
    for (let i = 0; i < 500; i++) s.push(update("x".repeat(i)));
    s.push(frame({ type: "message_end", message: { role: "assistant" } }));
    expect(s.log).toHaveLength(4);
    expect(types([...s.log])).toEqual(["agent_start", "message_start", "message_update", "message_end"]);
    const last = s.log[2] as unknown as { message: { content: { text: string }[] } };
    expect(last.message.content[0].text.length).toBe(499);
  });

  it("keeps a separate slot for each tool call and for each new message", () => {
    const s = new TurnStream();
    s.push(frame({ type: "message_start" }));
    s.push(update("a"));
    s.push(frame({ type: "message_end" }));
    s.push(frame({ type: "tool_execution_update", toolCallId: "t1" }));
    s.push(frame({ type: "tool_execution_update", toolCallId: "t2" }));
    s.push(frame({ type: "tool_execution_update", toolCallId: "t1" }));
    s.push(frame({ type: "message_start" }));
    s.push(update("b"));
    expect(types([...s.log])).toEqual(["message_start", "message_update", "message_end", "tool_execution_update", "tool_execution_update", "message_start", "message_update"]);
  });

  it("replays synchronously and then follows live without a gap (B-7-09)", () => {
    const s = new TurnStream();
    s.push(frame({ type: "agent_start" }));
    const a = sink();
    s.subscribe(a.sink);
    expect(types(a.got)).toEqual(["agent_start"]);
    s.push(frame({ type: "turn_start" }));
    expect(types(a.got)).toEqual(["agent_start", "turn_start"]);
  });

  it("coalesces updates to one frame in each 100 ms window, newest wins", () => {
    const s = new TurnStream();
    const a = sink();
    s.subscribe(a.sink);
    s.push(frame({ type: "message_start" }));
    for (let i = 1; i <= 20; i++) s.push(update(`v${i}`));
    expect(types(a.got)).toEqual(["message_start"]);
    vi.advanceTimersByTime(99);
    expect(types(a.got)).toEqual(["message_start"]);
    vi.advanceTimersByTime(1);
    expect(types(a.got)).toEqual(["message_start", "message_update"]);
    expect(JSON.stringify(a.got[1])).toContain("v20");
  });

  it("writes pending updates before a boundary event", () => {
    const s = new TurnStream();
    const a = sink();
    s.subscribe(a.sink);
    s.push(frame({ type: "message_start" }));
    s.push(update("partial"));
    s.push(frame({ type: "message_end" }));
    expect(types(a.got)).toEqual(["message_start", "message_update", "message_end"]);
  });

  it("gives a subscriber that attaches after settlement the history and the terminal frames", () => {
    const s = new TurnStream();
    s.push(frame({ type: "agent_start" }));
    s.push(frame({ type: "turn-settled" }));
    s.push(frame({ type: "done" }));
    const a = sink();
    s.subscribe(a.sink);
    expect(types(a.got)).toEqual(["agent_start", "turn-settled", "done"]);
    expect(a.ended).toBe(true);
  });

  it("ends every subscriber on done and ignores later frames", () => {
    const s = new TurnStream();
    const a = sink();
    s.subscribe(a.sink);
    s.push(frame({ type: "done" }));
    s.push(frame({ type: "agent_start" }));
    expect(a.ended).toBe(true);
    expect(types(a.got)).toEqual(["done"]);
  });

  it("detaches one view without touching the others", () => {
    const s = new TurnStream();
    const a = sink();
    const b = sink();
    const detach = s.subscribe(a.sink);
    s.subscribe(b.sink);
    detach();
    s.push(frame({ type: "turn_start" }));
    expect(a.got).toHaveLength(0);
    expect(types(b.got)).toEqual(["turn_start"]);
  });

  it("answers a session with no turn with a short stream (B-7-43)", () => {
    expect(types([...shortStream().log])).toEqual(["turn-settled", "done"]);
    const withNotice = shortStream("It failed.");
    expect(types([...withNotice.log])).toEqual(["error", "turn-settled", "done"]);
    expect(withNotice.log[0]).toMatchObject({ errorText: "It failed." });
  });

  it("writes a frame as data followed by a blank line", () => {
    expect(sseFrame(frame({ type: "done" }))).toBe('data: {"type":"done"}\n\n');
  });
});

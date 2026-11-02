import { describe, expect, it } from "vitest";
import type { AssistantMessage, NativeMessage, SessionDetail } from "@shared/learn/sessions";
import { DROPPED_TEXT, SessionModel, STILL_RUNNING_TEXT, absorbed, frameData, needsContinuation, readFrames, splitFrames, visibleQueuedSteers, type Env } from "./model";

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}

const sse = (frames: object[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

const quiz = (id = "call1"): AssistantMessage => ({
  role: "assistant",
  id: "a1",
  stopReason: "toolUse",
  content: [{ type: "toolCall", id, name: "quiz", arguments: { type: "check", nodeId: "n1", question: "Which is larger?", options: ["one", "two"], correctAnswer: "two", explanation: "Because." } }],
});

function detail(messages: NativeMessage[], over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session: { id: "chat_1", title: "T", createdAt: "", updatedAt: "", messages },
    pricing: { cost: null, unpriced: 0, turnCosts: [], cacheHitRate: null },
    turnInFlight: false,
    turnError: null,
    compacting: false,
    coverage: { totalMessages: 0, coveredCount: 0, uncoveredCount: 0, coveredTokens: 0, uncoveredTokens: 0, running: false, lastFoldedAt: null, threshold: 0 },
    sensitivity: "internal",
    ...over,
  } as SessionDetail;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeEnv(route: (call: Call, n: number) => Response, over: Partial<Env> = {}) {
  const calls: Call[] = [];
  const env: Env = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return route(call, calls.length);
    }) as typeof fetch,
    sleep: async () => undefined,
    pollMs: 500,
    waitMaxMs: 30_000,
    ...over,
  };
  return { env, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (frames: object[]) => new Response(streamOf([sse(frames)]), { status: 200 });

describe("the wire", () => {
  it("survives a body split byte by byte across reads", async () => {
    const text = sse([{ type: "agent_start" }, { type: "done" }]);
    const bytes = [...text].map((c) => c);
    const out: unknown[] = [];
    for await (const f of readFrames(streamOf(bytes))) out.push(f);
    expect(out).toEqual([{ type: "agent_start" }, { type: "done" }]);
  });

  it("ignores a frame without a data line and splits on a blank line", () => {
    expect(splitFrames("data: 1\n\ndata: 2\n\nrest")).toEqual({ frames: ["data: 1", "data: 2"], rest: "rest" });
    expect(frameData(": heartbeat")).toBeUndefined();
    expect(frameData("data: {\"a\":1}")).toEqual({ a: 1 });
  });
});

describe("applying events (B-9 client state)", () => {
  it("replaces the streaming message by slot and never doubles a chunk", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.applyFrame({ type: "message_start", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "He" }] } });
    m.applyFrame({ type: "message_update", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "Hello" }] } });
    m.applyFrame({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] } });
    const s = m.getSnapshot();
    expect(s.messages).toHaveLength(1);
    expect((s.messages[0] as AssistantMessage).content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(s.streamingIds.has("m1")).toBe(true);
    m.applyFrame({ type: "message_end", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "Hello there." }] } });
    expect(m.getSnapshot().streamingIds.size).toBe(0);
  });

  it("upserts a marker by id and drops a frame with no id", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    expect(m.applyFrame({ type: "message_end", message: { role: "user", content: "x" } })).toBe(false);
    expect(m.applyFrame({ type: "message_end", message: { role: "custom", id: "s1", customType: "subagent-steer", content: "a" } })).toBe(true);
    m.applyFrame({ type: "message_end", message: { role: "custom", id: "s1", customType: "subagent-steer", content: "b" } });
    expect(m.getSnapshot().messages).toHaveLength(1);
  });

  it("does not count an error frame or agent_start as view work, and agent_start releases a block", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    expect(m.applyFrame({ type: "error", errorText: "Boom" })).toBe(false);
    expect(m.getSnapshot().error).toBe("Boom");
    expect(m.applyFrame({ type: "agent_start" })).toBe(false);
    expect(m.getSnapshot().error).toBeNull();
  });

  it("appends the tool results of a turn end", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.applyFrame({ type: "turn_end", toolResults: [{ role: "toolResult", id: "r1", toolCallId: "c", toolName: "read", content: [], isError: false }] });
    expect(m.getSnapshot().messages.map((x) => x.id)).toEqual(["r1"]);
  });
});

describe("absorbing optimistic entries", () => {
  it("matches a local user message by content and never a live one", () => {
    const local: NativeMessage = { role: "user", id: "c_1", content: "hello" };
    const saved: NativeMessage = { role: "user", id: "msg_9", content: "hello" };
    expect(absorbed(local, [saved])).toBe(true);
    expect(absorbed({ role: "user", id: "msg_2", content: "hello" }, [saved])).toBe(false);
    expect(absorbed(local, [{ role: "user", id: "msg_9", content: "other" }])).toBe(false);
  });

  it("matches a tool result by call id and a marker by type and details", () => {
    expect(absorbed({ role: "toolResult", id: "c_2", toolCallId: "k", toolName: "quiz", content: [], isError: false }, [{ role: "toolResult", id: "r", toolCallId: "k", toolName: "quiz", content: [], isError: false }])).toBe(true);
    const mark = (id: string, t: string): NativeMessage => ({ role: "custom", id, customType: "practice-thinking", content: "", details: { text: t } });
    expect(absorbed(mark("c_3", "a"), [mark("m", "a")])).toBe(true);
    expect(absorbed(mark("c_3", "a"), [mark("m", "b")])).toBe(false);
  });

  it("adoption keeps the tail when the record lost a message, and drops absorbed entries otherwise", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.setMessages([{ role: "user", id: "msg_1", content: "first" }]);
    m.applyFrame({ type: "message_end", message: { role: "user", id: "c_1", content: "second" } });
    expect(m.getSnapshot().messages.map((x) => x.id)).toEqual(["msg_1", "c_1"]);
    m.adoptRecord([{ role: "user", id: "msg_2", content: "other" }]);
    expect(m.getSnapshot().messages.map((x) => x.id)).toEqual(["msg_1", "c_1"]);
    m.adoptRecord([{ role: "user", id: "msg_1", content: "first" }, { role: "user", id: "msg_3", content: "second" }]);
    expect(m.getSnapshot().messages.map((x) => x.id)).toEqual(["msg_1", "msg_3"]);
  });
});

describe("sending", () => {
  it("posts one input, then attaches with a record fetch first and ends ready", async () => {
    const saved: NativeMessage[] = [{ role: "user", id: "msg_1", content: "Teach me fractions" }, { role: "assistant", id: "a1", content: [{ type: "text", text: "Fractions are parts." }] }];
    const { env, calls } = fakeEnv((c) => {
      if (c.method === "POST") return json({ ok: true });
      if (c.url.endsWith("/stream")) return stream([{ type: "agent_start" }, { type: "message_start", message: saved[1] }, { type: "message_end", message: saved[1] }, { type: "turn-settled" }, { type: "done" }]);
      return json(detail(saved));
    });
    const m = new SessionModel("chat_1", env);
    const ok = await m.send({ type: "text", text: "Teach me fractions" });
    expect(ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.split("/").slice(-1)[0]}`).slice(0, 3)).toEqual(["POST input", "GET chat_1", "GET stream"]);
    expect(calls[0].body).toEqual({ input: { type: "text", text: "Teach me fractions" } });
    await new Promise((r) => setTimeout(r, 5));
    const s = m.getSnapshot();
    expect(s.status).toBe("ready");
    expect(s.messages.map((x) => x.id)).toEqual(["msg_1", "a1"]);
  });

  it("refuses a second send while a turn is live", async () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.applyFrame({ type: "agent_start" });
    (m as unknown as { status: string }).status = "streaming";
    expect(await m.send({ type: "text", text: "x" })).toBe(false);
  });

  it("on 409 waits, polls the job feed and posts the same body again", async () => {
    let posts = 0;
    let polls = 0;
    const { env, calls } = fakeEnv((c) => {
      if (c.method === "POST") return ++posts === 1 ? json({ error: "busy" }, 409) : json({ ok: true });
      if (c.url.includes("/jobs")) return json({ jobs: [], turnInFlight: ++polls < 2 });
      if (c.url.endsWith("/stream")) return stream([{ type: "done" }]);
      return json(detail([]));
    });
    const m = new SessionModel("chat_1", env);
    expect(await m.send({ type: "text", text: "again" })).toBe(true);
    const posted = calls.filter((c) => c.method === "POST");
    expect(posted).toHaveLength(2);
    expect(posted[1].body).toEqual(posted[0].body);
    expect(polls).toBe(2);
  });

  it("gives up after the wait limit with a plain sentence and removes the optimistic message", async () => {
    const { env } = fakeEnv((c) => (c.method === "POST" ? json({ error: "busy" }, 409) : json({ jobs: [], turnInFlight: true })), { waitMaxMs: 1500 });
    const m = new SessionModel("chat_1", env);
    expect(await m.send({ type: "text", text: "x" })).toBe(false);
    const s = m.getSnapshot();
    expect(s.status).toBe("error");
    expect(s.error).toBe(STILL_RUNNING_TEXT);
    expect(s.messages).toHaveLength(0);
  });

  it("keeps the refusal code for the setup recovery", async () => {
    const { env } = fakeEnv(() => json({ error: "Choose your models first.", code: "models_not_configured" }, 503));
    const m = new SessionModel("chat_1", env);
    await m.send({ type: "text", text: "x" });
    expect(m.getSnapshot().refusal).toMatchObject({ status: 503, code: "models_not_configured" });
  });

  it("recovers once from a stream that ends without the completion marker, then reports the drop", async () => {
    let streams = 0;
    const { env } = fakeEnv((c) => {
      if (c.method === "POST") return json({ ok: true });
      if (c.url.endsWith("/stream")) {
        streams++;
        return stream([{ type: "agent_start" }]);
      }
      return json(detail([]));
    });
    const m = new SessionModel("chat_1", env);
    await m.send({ type: "text", text: "x" });
    expect(streams).toBe(2);
    expect(m.getSnapshot().status).toBe("error");
    expect(m.getSnapshot().error).toBe(DROPPED_TEXT);
  });

  it("never posts an answer twice after a lost acknowledgement", async () => {
    const pending = [{ role: "user", id: "msg_1", content: "go" } as NativeMessage, quiz()];
    const { env, calls } = fakeEnv((c) => {
      if (c.method === "POST") return json({ ok: true });
      if (c.url.endsWith("/stream")) return stream([{ type: "done" }]);
      return json(detail(pending, { turnInFlight: true }));
    });
    const m = new SessionModel("chat_1", env);
    m.setMessages(pending);
    (m as unknown as { status: string }).status = "error";
    const sent = await m.send({ type: "answer", toolCallId: "call1", answer: { values: ["two"] } });
    expect(sent).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/input"))).toBe(false);
  });

  it("rejects an answer whose render time key no longer matches the pending question", async () => {
    const { env, calls } = fakeEnv(() => json({ ok: true }));
    const m = new SessionModel("chat_1", env);
    m.setMessages([quiz()]);
    expect(await m.send({ type: "answer", toolCallId: "call1", answer: { values: ["two"] } }, { questionKey: "stale" })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("drafts per question key", () => {
  it("keeps the draft of the pending question and forgets every other one on adoption", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.setMessages([quiz("call1")]);
    m.saveDraft("call1", { reading: "notes" });
    m.saveDraft("old", { reading: "stale" });
    m.adoptRecord([quiz("call1")]);
    expect(m.draft("call1")?.reading).toBe("notes");
    expect(m.draft("old")).toBeUndefined();
  });

  it("merges parts and a different question never inherits a draft", () => {
    const m = new SessionModel("chat_1", fakeEnv(() => json({})).env);
    m.setMessages([quiz("call1")]);
    m.saveDraft("call1", { reading: "r" });
    m.saveDraft("call1", { form: { selected: ["two"], otherSelected: false, otherText: "", dontKnow: false, text: "", thinking: "t", confidenceIdx: 3 } });
    expect(m.draft("call1")).toMatchObject({ reading: "r", form: { thinking: "t" } });
    m.setMessages([quiz("call2")]);
    expect(m.draft("call1")).toBeUndefined();
    expect(m.draft("call2")).toBeUndefined();
  });
});

describe("steers", () => {
  it("shows a quiet line until its card lands", () => {
    const queue = [{ id: "steer_1", text: "slow down" }];
    expect(visibleQueuedSteers(queue, [])).toHaveLength(1);
    expect(visibleQueuedSteers(queue, [{ role: "custom", id: "steer_1", customType: "subagent-steer", content: "" }])).toHaveLength(0);
  });

  it("falls back to a plain send on 409 and drops the line", async () => {
    const { env, calls } = fakeEnv((c) => {
      if (c.url.endsWith("/steer")) return json({ error: "no live turn to steer" }, 409);
      if (c.url.endsWith("/input")) return json({ ok: true });
      if (c.url.endsWith("/stream")) return stream([{ type: "done" }]);
      return json(detail([]));
    });
    const m = new SessionModel("chat_1", env);
    await m.steer("  slow down  ");
    expect(m.getSnapshot().steers).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith("/input") && JSON.stringify(c.body).includes("slow down"))).toBe(true);
  });

  it("ignores empty text", async () => {
    const { env, calls } = fakeEnv(() => json({}));
    await new SessionModel("chat_1", env).steer("   ");
    expect(calls).toHaveLength(0);
  });
});

describe("dismissal and continuation", () => {
  it("dismisses silently with an optimistic result and no turn", async () => {
    const { env, calls } = fakeEnv(() => json({ ok: true }));
    const m = new SessionModel("chat_1", env);
    m.setMessages([quiz()]);
    expect(await m.dismissQuestion({ toolCallId: "call1" })).toBe(true);
    expect(calls[0].url.endsWith("/dismiss")).toBe(true);
    expect(calls[0].body).toEqual({ toolCallId: "call1" });
    expect(m.getSnapshot().messages.at(-1)).toMatchObject({ role: "toolResult", details: { dismissed: true } });
    expect(m.getSnapshot().status).toBe("ready");
  });

  it("owes a continuation only after answered tool calls and never after a dismissal", () => {
    const res = (d: unknown): NativeMessage => ({ role: "toolResult", id: "r", toolCallId: "t", toolName: "read", content: [], isError: false, details: d });
    expect(needsContinuation([res(undefined)])).toBe(true);
    expect(needsContinuation([res({ dismissed: true })])).toBe(false);
    expect(needsContinuation([{ role: "user", id: "u", content: "x" }])).toBe(false);
    expect(needsContinuation([{ role: "toolResult", id: "r", toolCallId: "p", toolName: "problem", content: [], isError: false }])).toBe(false);
    expect(needsContinuation([{ role: "toolResult", id: "r", toolCallId: "q", toolName: "quiz", content: [], isError: false }])).toBe(false);
  });
});

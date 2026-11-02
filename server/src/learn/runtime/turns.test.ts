import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AnswerDetails, TurnFrame } from "../../../../shared/learn/index.ts";
import { RuntimeError } from "./errors.ts";
import { defineTool } from "./tools/define.ts";
import { assistantMsg, call, echoTool, makeEnv, resultMsg, until, userMsg, wait, type Env } from "./support.ts";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

const roles = (env: Env, id: string) => env.service.store.get(id)!.messages.map((m) => m.role);
const send = (env: Env, id: string, text: string) => env.service.input(id, { type: "text", text });

/** Follows the live stream of a running turn and returns everything it carried as one text. */
function follow(env: Env, id: string): () => string {
  const frames: TurnFrame[] = [];
  env.service.turns.attach(id).subscribe({ write: (f) => void frames.push(f), end: () => {} });
  return () => JSON.stringify(frames);
}

/** A question tool that returns the unsaved placeholder, as the method phase does. */
const quizTool = (block?: Promise<void>) =>
  defineTool({
    name: "quiz",
    label: "Quiz",
    description: "Poses a question.",
    parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.Any())), correctAnswer: Type.Optional(Type.String()), type: Type.Optional(Type.String()) }),
    execute: async () => {
      if (block) await block;
      return { content: [{ type: "text", text: "question posed" }], details: null, terminate: true };
    },
  });

const quizArgs = (q: string) => ({ question: q, type: "check", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a" });

describe("turn admission and settlement", () => {
  it("runs a scripted turn, saves the result and announces the end only after the save (B-7-09)", async () => {
    let savedAtSettle = -1;
    const env: Env = makeEnv({
      emit: (m) => {
        env.events.push(m);
        if (m.event === "turn-settled") savedAtSettle = env.service.store.get(m.session!)!.messages.length;
      },
    });
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxText("Hello there.")])]);
    const out = await send(env, s.id, "Teach me about bonds");
    expect(out.started).toBe(true);
    await env.service.turns.whenSettled(s.id);
    const record = env.service.store.get(s.id)!;
    expect(roles(env, s.id)).toEqual(["user", "assistant"]);
    expect(savedAtSettle).toBe(2);
    expect(record.title).toBe("Teach me about bonds");
    expect(record.messages.every((m) => typeof m.id === "string" && m.id.startsWith("msg_"))).toBe(true);
    expect(record.turns).toHaveLength(1);
    expect(record.turns![0].model).toBe(`faux:${env.faux.getModel().id}`);
    expect(record.turns![0].steps[0].outputTokens).toBeGreaterThan(0);
    const names = env.events.filter((e) => e.session === s.id).map((e) => e.event);
    expect(names.indexOf("turn-started")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("turn-started")).toBeLessThan(names.indexOf("turn-settled"));
    expect(env.service.turns.isRunning(s.id)).toBe(false);
  });

  it("writes the input before inference (B-7-04)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    let seen: string[] = [];
    env.faux.setResponses([
      () => {
        seen = roles(env, s.id);
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    await send(env, s.id, "first input");
    await env.service.turns.whenSettled(s.id);
    expect(seen).toEqual(["user"]);
  });

  it("runs a tool and saves the call, the result and the final answer in order", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "pong" }, { id: "call_1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await send(env, s.id, "go");
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const result = env.service.store.get(s.id)!.messages[2] as { toolCallId: string; content: { text: string }[] };
    expect(result.toolCallId).toBe("call_1");
    expect(result.content[0].text).toBe("pong");
    expect(env.service.store.get(s.id)!.turns![0].steps).toHaveLength(2);
  });

  it("answers a second request with 409 turn_running and accepts the next one after settlement (B-7-03)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const g = gate();
    env.faux.setResponses([
      async () => {
        await g.promise;
        return fauxAssistantMessage([fauxText("one")]);
      },
      fauxAssistantMessage([fauxText("two")]),
    ]);
    await send(env, s.id, "first");
    await until(() => env.faux.state.callCount === 1, "the first model call");
    const err = await send(env, s.id, "second").catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.status).toBe(409);
    expect(err.body.code).toBe("turn_running");
    expect(roles(env, s.id)).toEqual(["user"]);
    g.open();
    await env.service.turns.whenSettled(s.id);
    await send(env, s.id, "third");
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("refuses two concurrent requests with one winner", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxText("one")])]);
    const results = await Promise.allSettled([send(env, s.id, "a"), send(env, s.id, "b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    await env.service.turns.whenSettled(s.id);
  });

  it("refuses an unknown session, malformed input and a missing model before anything is written (B-7-02, B-7-07)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    await expect(send(env, "chat_missing_00000000", "x")).rejects.toMatchObject({ status: 404 });
    await expect(env.service.input(s.id, { type: "text", text: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(env.service.input(s.id, { type: "nonsense" } as never)).rejects.toMatchObject({ status: 400 });
    env.state.noStrongSlot = true;
    const err = await send(env, s.id, "hello").catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.body.code).toBe("models_not_configured");
    expect(env.service.store.get(s.id)!.messages).toEqual([]);
    expect(env.service.turns.isRunning(s.id)).toBe(false);
    env.state.noStrongSlot = false;
    env.faux.setResponses([fauxAssistantMessage([fauxText("fine")])]);
    await send(env, s.id, "hello");
    await env.service.turns.whenSettled(s.id);
  });

  it("keeps the partial output when a turn is aborted (B-7-09)", async () => {
    const env = makeEnv({ tokensPerSecond: 30 });
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(400))])]);
    await send(env, s.id, "write a lot");
    await until(() => {
      const last = [...env.service.turns.attach(s.id).log].reverse().find((f) => f.type === "message_update") as unknown as { message: { content: { text?: string }[] } } | undefined;
      return !!last?.message.content[0]?.text && last.message.content[0].text.length > 10;
    }, "streamed text");
    expect(env.service.turns.abort(s.id)).toBe(true);
    await env.service.turns.whenSettled(s.id);
    const record = env.service.store.get(s.id)!;
    const last = record.messages[record.messages.length - 1] as unknown as { role: string; stopReason: string; content: { text?: string }[] };
    expect(last.role).toBe("assistant");
    expect(last.stopReason).toBe("aborted");
    expect(last.content[0].text!.length).toBeGreaterThan(5);
    expect(last.content[0].text!.length).toBeLessThan(2000);
    expect(env.service.turns.abort(s.id)).toBe(false);
  });

  it("stops a tool that is running when the turn is aborted and saves what exists", async () => {
    const env = makeEnv({ toolGraceMs: 20 });
    const stuck = defineTool({
      name: "echo",
      label: "Stuck",
      description: "Never returns.",
      parameters: Type.Object({ text: Type.String() }),
      execute: () => new Promise(() => {}),
    });
    env.state.tools = [stuck];
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("echo", { text: "x" }, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("after")])]);
    await send(env, s.id, "go");
    await until(() => [...env.service.turns.attach(s.id).log].some((f) => f.type === "tool_execution_start"), "tool start");
    env.service.turns.abort(s.id);
    await env.service.turns.whenSettled(s.id);
    const msgs = env.service.store.get(s.id)!.messages;
    expect(msgs[1].role).toBe("assistant");
    expect(msgs.some((m) => m.role === "toolResult")).toBe(true);
  });

  it("does not abort the turn when a view closes (B-7-17)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const g = gate();
    env.faux.setResponses([
      async () => {
        await g.promise;
        return fauxAssistantMessage([fauxText("finished")]);
      },
    ]);
    await send(env, s.id, "go");
    const detach = env.service.turns.attach(s.id).subscribe({ write: () => {}, end: () => {} });
    detach();
    g.open();
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant"]);
    expect((env.service.store.get(s.id)!.messages[1] as unknown as { stopReason: string }).stopReason).toBe("stop");
  });

  it("replays a turn to a view that attaches late and then continues live (B-7-09)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const g = gate();
    env.faux.setResponses([
      async () => {
        await g.promise;
        return fauxAssistantMessage([fauxText("late text")]);
      },
    ]);
    await send(env, s.id, "go");
    await until(() => [...env.service.turns.attach(s.id).log].some((f) => f.type === "message_start" || f.type === "turn_start"), "turn start");
    const frames: TurnFrame[] = [];
    let ended = false;
    env.service.turns.attach(s.id).subscribe({ write: (f) => void frames.push(f), end: () => { ended = true; } });
    const replayed = frames.length;
    expect(replayed).toBeGreaterThan(0);
    expect(frames[0].type).toBe("agent_start");
    g.open();
    await until(() => ended, "the end of the stream");
    expect(frames.length).toBeGreaterThan(replayed);
    const names = frames.map((f) => f.type);
    expect(names.slice(-2)).toEqual(["turn-settled", "done"]);
    expect(names.indexOf("agent_end")).toBeLessThan(names.indexOf("turn-settled"));
  });

  it("serves the short stream when no turn runs", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    expect(env.service.turns.attach(s.id).log.map((f) => f.type)).toEqual(["turn-settled", "done"]);
  });

  it("recovers after a restart: the input is durable and the session reports an unfinished turn (B-7-58)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    // a crash after the write ahead and before any reply
    env.service.store.appendMessages(s.id, [userMsg("msg_crash", "an interrupted question")]);
    const fresh = makeEnv({ dir: env.dir });
    const detail = fresh.service.detail(s.id);
    expect(detail.turnInFlight).toBe(false);
    expect(detail.turnError).toMatch(/did not finish/);
    expect(detail.session.messages).toHaveLength(1);
    expect(fresh.service.turns.attach(s.id).log.map((f) => f.type)).toContain("turn-settled");
    await expect(fresh.service.input(s.id, { type: "continue" })).rejects.toMatchObject({ status: 400 });
    fresh.faux.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
    await fresh.service.input(s.id, { type: "text", text: "carry on" });
    await fresh.service.turns.whenSettled(s.id);
    expect(fresh.service.detail(s.id).turnError).toBeNull();
  });

  it("replaces the writer lock of a process that no longer exists", () => {
    const env = makeEnv();
    const lock = path.join(env.dir, "cortex", "writer.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: "old", since: "2026-01-01T00:00:00Z" }), "utf8");
    const logs: string[] = [];
    const again = makeEnv({ dir: env.dir, log: (l) => logs.push(l) });
    const got = again.service.start();
    expect(got.acquired).toBe(true);
    expect(got.replaced).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid).toBe(process.pid);
    again.service.stop();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("evicts a turn that outlives the liveness guard, silently", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const g = gate();
    env.faux.setResponses([
      async () => {
        await g.promise;
        return fauxAssistantMessage([fauxText("late")]);
      },
    ]);
    await send(env, s.id, "go");
    expect(env.service.turns.isRunning(s.id)).toBe(true);
    env.clock.now += 31 * 60 * 1000;
    expect(env.service.turns.isRunning(s.id)).toBe(false);
    g.open();
    await wait(30);
  });

  it("reports a failed save before done and keeps the accepted input (B-7-44)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const original = env.service.store.appendMessages;
    env.service.store.appendMessages = (id, msgs) => {
      if (msgs.some((m) => m.role === "assistant")) throw new Error("disk full");
      return original(id, msgs);
    };
    env.faux.setResponses([fauxAssistantMessage([fauxText("never saved")])]);
    await send(env, s.id, "hello");
    await env.service.turns.whenSettled(s.id);
    const names = env.service.turns.attach(s.id).log.map((f) => f.type);
    expect(names).toEqual(["error", "turn-settled", "done"]);
    expect(env.service.detail(s.id).turnError).toBe("disk full");
    env.service.store.appendMessages = original;
    expect(roles(env, s.id)).toEqual(["user"]);
    expect(env.service.turns.isRunning(s.id)).toBe(false);
  });
});

describe("failure and retry", () => {
  it("keeps a failed response in the record and retries from the record (B-7-45)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxText("partial")], { stopReason: "error", errorMessage: "provider said no" })]);
    await send(env, s.id, "go");
    await env.service.turns.whenSettled(s.id);
    expect(env.service.detail(s.id).turnError).toBe("provider said no");
    expect(roles(env, s.id)).toEqual(["user", "assistant"]);
    let seen: string[] = [];
    env.faux.setResponses([
      (ctx) => {
        seen = ctx.messages.map((m) => m.role);
        return fauxAssistantMessage([fauxText("second try")]);
      },
    ]);
    await env.service.input(s.id, { type: "retry" });
    await env.service.turns.whenSettled(s.id);
    expect(seen.filter((r) => r === "assistant")).toHaveLength(0);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "assistant"]);
    expect(env.service.detail(s.id).turnError).toBeNull();
  });

  it("refuses a retry when nothing failed", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    await expect(env.service.input(s.id, { type: "retry" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("questions, answers and dismissal", () => {
  it("leaves a question call open in the record and derives the pending state (B-7-12)", async () => {
    const env = makeEnv();
    env.state.tools = [quizTool()];
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("quiz", quizArgs("Which?"), { id: "q1" })], { stopReason: "toolUse" })]);
    await send(env, s.id, "start");
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant"]);
    expect(env.service.list()[0].pendingQuestion).toBe(true);
    // reopening an unanswered question costs no model call
    expect(env.faux.state.callCount).toBe(1);
  });

  it("saves an answer as the call result with the full graded form in details, and continues (B-7-40)", async () => {
    const env = makeEnv();
    env.state.tools = [quizTool()];
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("quiz", quizArgs("Which?"), { id: "q1" })], { stopReason: "toolUse" })]);
    await send(env, s.id, "start");
    await env.service.turns.whenSettled(s.id);
    env.faux.setResponses([fauxAssistantMessage([fauxText("Right.")])]);
    await env.service.input(s.id, { type: "answer", toolCallId: "q1", answer: { values: ["a"], confidence: 90, thinking: "because" } });
    await env.service.turns.whenSettled(s.id);
    const result = env.service.store.get(s.id)!.messages[2] as { toolCallId: string; content: { text: string }[]; details: AnswerDetails };
    expect(result.toolCallId).toBe("q1");
    expect(result.content[0].text).toContain("The learner chose: A");
    expect(result.details).toMatchObject({ kind: "quiz", correct: true, confidence: 90, thinking: "because", correctIndices: [1] });
    expect(roles(env, s.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("defers the wake while a sibling question is open and starts one turn on the last answer (B-7-20)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.service.store.appendMessages(s.id, [
      userMsg("m1", "start"),
      assistantMsg("m2", [call("q1", "quiz", quizArgs("One?")), call("q2", "quiz", quizArgs("Two?"))], { stopReason: "toolUse" }),
    ]);
    const first = await env.service.input(s.id, { type: "answer", toolCallId: "q1", answer: { values: ["b"] } });
    expect(first.started).toBe(false);
    expect(env.faux.state.callCount).toBe(0);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "toolResult"]);
    env.faux.setResponses([
      (ctx) => {
        const order = ctx.messages.map((m) => m.role);
        expect(order.slice(-3)).toEqual(["assistant", "toolResult", "toolResult"]);
        return fauxAssistantMessage([fauxText("both seen")]);
      },
    ]);
    const second = await env.service.input(s.id, { type: "answer", toolCallId: "q2", answer: { dontKnow: true } });
    expect(second.started).toBe(true);
    await env.service.turns.whenSettled(s.id);
    expect(env.faux.state.callCount).toBe(1);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
  });

  it("refuses an answer to a question that is not open", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    await expect(env.service.input(s.id, { type: "answer", toolCallId: "nope", answer: {} })).rejects.toMatchObject({ status: 400 });
  });

  it("dismisses a question silently with no model call (B-7-19)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.service.store.appendMessages(s.id, [userMsg("m1", "go"), assistantMsg("m2", [call("q1", "quiz", quizArgs("One?"))], { stopReason: "toolUse" })]);
    expect(env.service.turns.dismiss(s.id, { toolCallId: "q1" })).toEqual({ parked: false });
    const result = env.service.store.get(s.id)!.messages[2] as { details: AnswerDetails };
    expect(result.details.dismissed).toBe(true);
    expect(env.faux.state.callCount).toBe(0);
    expect(() => env.service.turns.dismiss(s.id, { toolCallId: "q1" })).toThrow(/No open question/);
    await expect(env.service.input(s.id, { type: "continue" })).rejects.toMatchObject({ status: 400 });
  });

  it("parks a dismissal that arrives mid turn and applies it after the save (B-7-51)", async () => {
    const env = makeEnv();
    const g = gate();
    env.state.tools = [quizTool(g.promise)];
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("quiz", quizArgs("One?"), { id: "q1" })], { stopReason: "toolUse" })]);
    await send(env, s.id, "start");
    await until(() => [...env.service.turns.attach(s.id).log].some((f) => f.type === "tool_execution_start"), "tool start");
    // the stored record has no question yet, so the dismissal is parked
    expect(env.service.turns.dismiss(s.id, { toolCallId: "q1" })).toEqual({ parked: true });
    g.open();
    await env.service.turns.whenSettled(s.id);
    const msgs = env.service.store.get(s.id)!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect((msgs[2] as { details: AnswerDetails }).details.dismissed).toBe(true);
  });

  it("drops a parked dismissal that targets nothing (B-7-52)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    const g = gate();
    env.faux.setResponses([
      async () => {
        await g.promise;
        return fauxAssistantMessage([fauxText("plain")]);
      },
    ]);
    await send(env, s.id, "go");
    expect(env.service.turns.dismiss(s.id, { toolCallId: "ghost" }).parked).toBe(true);
    g.open();
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant"]);
  });

  it("dismisses an open problem with a marker, and the next learner message carries a synthesised conclusion", async () => {
    const env = makeEnv();
    const s = env.service.create({ kind: "practice" });
    env.service.store.appendMessages(s.id, [
      userMsg("m1", "practise"),
      assistantMsg("m2", [call("p1", "problem", { statement: "Solve it", mode: "recall", modelSolution: "42" })], { stopReason: "toolUse" }),
      resultMsg("m3", "p1", "problem", "problem posed", { details: { ok: true } }),
    ]);
    expect(env.service.list()[0].pendingQuestion).toBe(true);
    env.service.turns.dismiss(s.id, { problemCallId: "p1" });
    expect(env.service.store.get(s.id)!.messages[3]).toMatchObject({ role: "custom", customType: "problem-dismissed" });
    expect(env.service.list()[0].pendingQuestion).toBe(false);
    let projected: string[] = [];
    env.faux.setResponses([
      (ctx) => {
        projected = ctx.messages.map((m) => (m.role === "assistant" ? `assistant:${(m.content as { type: string; name?: string }[]).map((b) => b.name ?? b.type).join(",")}` : m.role));
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    await send(env, s.id, "next please");
    await env.service.turns.whenSettled(s.id);
    expect(projected).toEqual(expect.arrayContaining(["assistant:conclude"]));
    expect(JSON.stringify(projected)).not.toContain("custom");
  });
});

describe("steering", () => {
  it("steers a running turn at the next boundary and saves the message under the client id (B-7-15)", async () => {
    const env = makeEnv();
    const g = gate();
    env.state.tools = [
      defineTool({
        name: "echo",
        label: "Slow echo",
        description: "Waits.",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_i, p) => {
          await g.promise;
          return { content: [{ type: "text", text: p.text }], details: null };
        },
      }),
    ];
    const s = env.service.create({});
    let nextSaw = "";
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "t" }, { id: "c1" })], { stopReason: "toolUse" }),
      (ctx) => {
        nextSaw = JSON.stringify(ctx.messages);
        return fauxAssistantMessage([fauxText("noted")]);
      },
    ]);
    await send(env, s.id, "go");
    const seen = follow(env, s.id);
    await until(() => [...env.service.turns.attach(s.id).log].some((f) => f.type === "tool_execution_start"), "tool start");
    expect(env.service.turns.steer(s.id, { id: "steer_abc", text: "also consider yields" })).toBe(true);
    g.open();
    await env.service.turns.whenSettled(s.id);
    expect(nextSaw).toContain("also consider yields");
    const msgs = env.service.store.get(s.id)!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
    expect(msgs[3].id).toBe("steer_abc");
    // the live stream carries the same identifier so that the client can hide the queued line
    expect(seen()).toContain("steer_abc");
  });

  it("returns false with no live turn", () => {
    const env = makeEnv();
    const s = env.service.create({});
    expect(env.service.turns.steer(s.id, { id: "steer_x", text: "hello" })).toBe(false);
  });

  it("keeps a steer that a run ended without delivering for the next run", async () => {
    const env = makeEnv({ toolGraceMs: 20 });
    const stuck = defineTool({
      name: "echo",
      label: "Stuck",
      description: "Never returns.",
      parameters: Type.Object({ text: Type.String() }),
      execute: () => new Promise(() => {}),
    });
    env.state.tools = [stuck];
    const s = env.service.create({});
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("echo", { text: "x" }, { id: "c1" })], { stopReason: "toolUse" })]);
    await send(env, s.id, "go");
    await until(() => [...env.service.turns.attach(s.id).log].some((f) => f.type === "tool_execution_start"), "tool start");
    env.service.turns.steer(s.id, { id: "steer_parked", text: "remember the coupon" });
    env.service.turns.abort(s.id);
    await env.service.turns.whenSettled(s.id);
    env.state.tools = [echoTool];
    let saw = "";
    env.faux.setResponses([
      (ctx) => {
        saw = JSON.stringify(ctx.messages);
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    await send(env, s.id, "carry on");
    await env.service.turns.whenSettled(s.id);
    expect(saw).toContain("remember the coupon");
  });
});

describe("call identifiers (B-7-22)", () => {
  it("mints a new identifier for a repeated call id and keeps the call and result joined", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "one" }, { id: "dup" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("echo", { text: "two" }, { id: "dup" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("end")]),
    ]);
    await send(env, s.id, "go");
    const seen = follow(env, s.id);
    await env.service.turns.whenSettled(s.id);
    const msgs = env.service.store.get(s.id)!.messages;
    const calls = msgs.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => (b as { id: string }).id) : []));
    const results = msgs.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId);
    expect(calls).toEqual(["dup", "dup~2"]);
    expect(results).toEqual(["dup", "dup~2"]);
    expect(seen()).toContain("dup~2");
  });

  it("passes unique identifiers through verbatim (B-7-23)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "one" }, { id: "a1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("end")]),
    ]);
    await send(env, s.id, "go");
    await env.service.turns.whenSettled(s.id);
    const msgs = env.service.store.get(s.id)!.messages;
    expect((msgs[2] as { toolCallId: string }).toolCallId).toBe("a1");
  });
});

describe("continuation", () => {
  it("continues a record that ends on answered tool results, and refuses when a question dangles (B-7-38)", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.service.store.appendMessages(s.id, [
      userMsg("m1", "go"),
      assistantMsg("m2", [call("c1", "echo", { text: "x" })], { stopReason: "toolUse" }),
      resultMsg("m3", "c1", "echo", "x"),
    ]);
    env.faux.setResponses([fauxAssistantMessage([fauxText("continued")])]);
    await env.service.input(s.id, { type: "continue" });
    await env.service.turns.whenSettled(s.id);
    expect(roles(env, s.id)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    await expect(env.service.input(s.id, { type: "continue" })).rejects.toMatchObject({ status: 400 });
  });
});

import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { NativeMessage } from "../../../../shared/learn/index.ts";
import {
  COMPACTION_HEADER,
  RESERVE_TOKENS,
  buildSummaryPrompt,
  effectiveThreshold,
  estimateContextTokens,
  estimateMessageTokens,
  findCut,
  serialiseSpan,
} from "./compaction.ts";
import { toLlmMessages } from "./projection.ts";
import { assistantMsg, call, makeEnv, resultMsg, userMsg } from "./support.ts";

const big = (n: number) => "x".repeat(n * 4);

/** A conversation of alternating learner and teacher messages, each of about `tokens` tokens. */
function conversation(pairs: number, tokens = 500): NativeMessage[] {
  const out: NativeMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push(userMsg(`u${i}`, big(tokens)));
    out.push(assistantMsg(`a${i}`, [{ type: "text", text: big(tokens) }]));
  }
  return out;
}

describe("threshold arithmetic (B-7-72)", () => {
  it("takes the setting for a large window and the window rule for a small one", () => {
    expect(effectiveThreshold(150_000, 1_000_000)).toBe(150_000);
    expect(effectiveThreshold(150_000, 100_000)).toBe(100_000 - RESERVE_TOKENS);
    expect(effectiveThreshold(150_000, null)).toBe(150_000);
  });
  it("applies the floor of 32,000 to the setting and never goes below 1", () => {
    expect(effectiveThreshold(1_000, null)).toBe(32_000);
    expect(effectiveThreshold(150_000, 10_000)).toBe(1);
  });
});

describe("context estimate (B-7-59, B-7-60)", () => {
  it("anchors on the newest assistant usage and estimates only what follows", () => {
    const messages = [
      userMsg("u1", big(100)),
      assistantMsg("a1", [{ type: "text", text: "hi" }], { usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 } }),
      userMsg("u2", big(40)),
    ];
    expect(estimateContextTokens(messages, [])).toBe(1550 + 40);
  });
  it("skips aborted responses and responses with all zero usage", () => {
    const messages = [
      assistantMsg("a1", [], { usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } }),
      assistantMsg("a2", [], { stopReason: "aborted", usage: { input: 5000, output: 5000, cacheRead: 0, cacheWrite: 0 } }),
      assistantMsg("a3", [], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ];
    expect(estimateContextTokens(messages, [])).toBe(1000);
  });
  it("refuses an anchor older than the newest compaction marker", () => {
    const messages: NativeMessage[] = [
      assistantMsg("a1", [], { usage: { input: 90_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      { role: "custom", id: "mk", customType: "compaction", content: "S", timestamp: 1, details: { firstKeptMessageId: "a1" } },
    ];
    const projected = [{ role: "user", content: big(10) }];
    expect(estimateContextTokens(messages, projected)).toBe(10);
  });
  it("counts wire text only and an image as 4,800 characters", () => {
    expect(estimateMessageTokens({ role: "assistant", content: [{ type: "text", text: "abcd" }, { type: "thinking", thinking: "abcdefgh" }] })).toBe(3);
    expect(estimateMessageTokens({ role: "user", content: [{ type: "image", data: "zzzz", mimeType: "image/png" }] })).toBe(1200);
  });
});

describe("cut selection (B-7-61)", () => {
  it("keeps about the budget of recent messages and starts the tail on a visible message", () => {
    const messages = conversation(40);
    const cut = findCut(messages)!;
    expect(cut).toBeGreaterThan(0);
    const keptTokens = messages.slice(cut).reduce((n, m) => n + estimateMessageTokens(m), 0);
    expect(keptTokens).toBeGreaterThanOrEqual(20_000);
    expect(keptTokens).toBeLessThan(21_500);
    expect(["user", "assistant"]).toContain(messages[cut].role);
  });
  it("keeps everything when the record is within budget", () => {
    expect(findCut(conversation(10))).toBeNull();
  });
  it("never starts the tail on a tool result and keeps the call that precedes it", () => {
    const messages: NativeMessage[] = [
      ...conversation(30),
      userMsg("ux", "go"),
      assistantMsg("ay", [call("c1", "echo")], { stopReason: "toolUse" }),
      resultMsg("rz", "c1", "echo", big(25_000)),
    ];
    const cut = findCut(messages)!;
    expect(messages[cut].role).not.toBe("toolResult");
    expect(messages[cut].id).toBe("ay");
  });
  it("keeps a pending question call in the tail", () => {
    const messages: NativeMessage[] = [
      ...conversation(30),
      assistantMsg("q", [call("c1", "quiz", { question: "?" })], { stopReason: "toolUse" }),
      userMsg("late", big(25_000)),
    ];
    const cut = findCut(messages)!;
    expect(messages.findIndex((m) => m.id === "q")).toBeGreaterThanOrEqual(cut);
  });
  it("never crosses an earlier compaction and skips when the cut cannot advance", () => {
    const messages = conversation(30);
    const first = findCut(messages)!;
    const withMarker: NativeMessage[] = [
      ...messages,
      { role: "custom", id: "mk", customType: "compaction", content: "S", timestamp: 1, details: { firstKeptMessageId: messages[first].id } },
      ...conversation(2, 100).map((m) => ({ ...m, id: `n_${m.id}` }) as NativeMessage),
    ];
    expect(findCut(withMarker)).toBeNull();
  });
});

describe("summary input (B-7-65)", () => {
  it("labels roles, cuts long tool results and leaves out thinking and plan blocks", () => {
    const span: NativeMessage[] = [
      userMsg("u", "Question text"),
      assistantMsg("a", [{ type: "thinking", thinking: "SECRET THOUGHT" }, { type: "text", text: "Teacher text" }]),
      resultMsg("r", "c1", "echo", "y".repeat(5000)),
      { role: "custom", id: "p", customType: "plan-block", content: "PLANBLOCK", timestamp: 1 },
    ];
    const text = serialiseSpan(span);
    expect(text).toContain("Learner: Question text");
    expect(text).toContain("Teacher: Teacher text");
    expect(text).toContain("Tool result echo");
    expect(text).toContain("[cut]");
    expect(text).not.toContain("SECRET THOUGHT");
    expect(text).not.toContain("PLANBLOCK");
    expect(text.length).toBeLessThan(2400);
  });
  it("asks for the four headed sections in sequence and copies the plan tree unchanged", () => {
    const prompt = buildSummaryPrompt({
      span: "Learner: hi",
      tree: { version: 1, nodes: [{ id: "n-one", title: "One" }, { id: "n-two", title: "Two" }], edges: [{ from: "n-one", to: "n-two" }] },
      statuses: { "n-one": "visited" },
    });
    const order = ["What the learner holds", "How the session progressed", "The plan map", "The current moment"].map((h) => prompt.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain("- n-one: One (visited)");
    expect(prompt).toContain("- n-one to n-two");
  });
});

function overWindow(env: ReturnType<typeof makeEnv>) {
  env.state.contextWindow = 50_000;
  const s = env.service.create({});
  env.service.store.appendMessages(s.id, conversation(35, 500));
  return s;
}

describe("compaction at the edge of the window (B-7-68, B-7-72)", () => {
  it("is over only when the estimate passes the threshold by one token", () => {
    const env = makeEnv();
    env.state.contextWindow = 50_000;
    const threshold = 50_000 - RESERVE_TOKENS;
    const s = env.service.create({});
    const at = env.service.store.appendMessages(s.id, [assistantMsg("a", [], { usage: { input: threshold, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
    expect(env.service.compaction.isOver(at)).toBe(false);
    const s2 = env.service.create({});
    const over = env.service.store.appendMessages(s2.id, [assistantMsg("a", [], { usage: { input: threshold + 1, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
    expect(env.service.compaction.isOver(over)).toBe(true);
  });

  it("does nothing under the threshold", async () => {
    const env = makeEnv();
    const s = env.service.create({});
    env.service.store.appendMessages(s.id, conversation(5));
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("skipped");
    expect(env.summaries).toHaveLength(0);
  });

  it("appends a marker, logs usage and emits both events when over the threshold", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("compacted");
    const record = env.service.store.get(s.id)!;
    const marker = record.messages[record.messages.length - 1] as { customType: string; content: string; details: { firstKeptMessageId: string; tokensBefore: number } };
    expect(marker.customType).toBe("compaction");
    expect(marker.content.startsWith(COMPACTION_HEADER)).toBe(true);
    expect(marker.content).toContain("Summary text.");
    expect(marker.details.tokensBefore).toBeGreaterThan(33_000);
    expect(record.turns!.some((t) => t.id === (marker as unknown as { id: string }).id)).toBe(true);
    expect(record.messages).toHaveLength(71);
    const names = env.events.filter((e) => e.event !== "sessions-changed").map((e) => `${e.event}:${e.running ?? ""}`);
    expect(names).toEqual(["compaction-changed:true", "record-changed:", "compaction-changed:false"]);
    const projected = toLlmMessages(record.messages);
    expect(JSON.stringify(projected).match(/Summary text\./g)).toHaveLength(1);
    expect(projected.length).toBeLessThan(record.messages.length - 20);
    // nothing more to compact straight afterwards
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("skipped");
  });

  it("discards a summary that stopped at the output limit, and an empty one, leaving the history untouched (B-7-71)", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    const before = env.service.store.get(s.id)!.messages.length;
    env.state.summary = { text: "Cut off summary", stopReason: "length" };
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("failed");
    env.state.summary = { text: "   ", stopReason: "stop" };
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("failed");
    expect(env.service.store.get(s.id)!.messages).toHaveLength(before);
    env.state.summary = { text: "Complete summary", stopReason: "stop" };
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("compacted");
  });

  it("leaves the record untouched when the summariser fails and tries again next time (B-7-73)", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    const before = JSON.stringify(env.service.store.get(s.id));
    env.state.summary = new Error("provider down");
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("failed");
    expect(JSON.stringify(env.service.store.get(s.id))).toBe(before);
    expect(env.service.compaction.isCompacting(s.id)).toBe(false);
    env.state.summary = { text: "Recovered.", stopReason: "stop" };
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("compacted");
  });

  it("shares one summary between concurrent callers (B-7-69)", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    const [a, b] = await Promise.all([env.service.compaction.compactIfNeeded(s.id), env.service.compaction.compactIfNeeded(s.id)]);
    expect(a).toBe("compacted");
    expect(b).toBe("compacted");
    expect(env.summaries).toHaveLength(1);
  });

  it("chains a second compaction with the earlier summary carried forward (B-7-70)", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    await env.service.compaction.compactIfNeeded(s.id);
    env.service.store.appendMessages(
      s.id,
      conversation(40, 500).map((m) => ({ ...m, id: `later_${m.id}` }) as NativeMessage),
    );
    env.state.summary = { text: "Second summary.", stopReason: "stop" };
    expect(await env.service.compaction.compactIfNeeded(s.id)).toBe("compacted");
    expect(env.summaries[1].prompt).toContain("Summary text.");
    const record = env.service.store.get(s.id)!;
    const text = JSON.stringify(toLlmMessages(record.messages));
    expect(text).toContain("Second summary.");
    expect(text).not.toContain("Summary text.");
    expect(record.messages.filter((m) => m.role === "custom" && m.customType === "compaction")).toHaveLength(2);
  });

  it("compacts at the start of a turn before the model is called (B-7-68)", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    let sawSummary = false;
    env.faux.setResponses([
      (ctx) => {
        sawSummary = JSON.stringify(ctx.messages).includes("Summary text.");
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
    await env.service.input(s.id, { type: "text", text: "next question" });
    await env.service.turns.whenSettled(s.id);
    expect(env.summaries).toHaveLength(1);
    expect(sawSummary).toBe(true);
  });

  it("marks the session as compacting while a summary runs", async () => {
    const env = makeEnv();
    const s = overWindow(env);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    env.deps.summariser = async () => {
      await hold;
      return { text: "Slow summary.", stopReason: "stop" };
    };
    const slow = makeEnv({ dir: env.dir, summariser: env.deps.summariser });
    slow.state.contextWindow = 50_000;
    const p = slow.service.compaction.compactIfNeeded(s.id);
    expect(slow.service.list()[0].compacting).toBe(true);
    release();
    await p;
    expect(slow.service.list()[0].compacting).toBe(false);
  });
});

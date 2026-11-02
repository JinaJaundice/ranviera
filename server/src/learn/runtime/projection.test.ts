import { describe, expect, it } from "vitest";
import type { CustomMessage, NativeMessage } from "../../../../shared/learn/index.ts";
import { INTERRUPTED_RESULT, activeCompaction, toLlmMessages } from "./projection.ts";
import { assistantMsg, call, resultMsg, userMsg } from "./support.ts";

const marker = (id: string, customType: CustomMessage["customType"], content: string, details?: unknown): NativeMessage => ({
  role: "custom",
  id,
  customType,
  content,
  details,
  timestamp: 1,
});

describe("projection", () => {
  it("strips identifiers and keeps roles in order", () => {
    const out = toLlmMessages([userMsg("msg_1", "hello"), assistantMsg("msg_2", [{ type: "text", text: "hi" }])]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(out)).not.toContain("msg_");
  });

  it("flattens a marker to a user message and drops plan-block and problem-dismissed (B-7-63)", () => {
    const out = toLlmMessages([
      marker("a", "graph-context", "Context text"),
      marker("b", "plan-block", "plan"),
      marker("c", "problem-dismissed", "gone"),
      marker("d", "practice-next", "Next please"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.role === "user")).toBe(true);
    expect(JSON.stringify(out)).toContain("Context text");
    expect(JSON.stringify(out)).not.toContain("plan");
    expect(JSON.stringify(out)).not.toContain("gone");
  });

  it("repairs a call with no result in the projection only (B-7-47)", () => {
    const record = [userMsg("u", "go"), assistantMsg("a", [call("c1", "quiz")])];
    const before = JSON.stringify(record);
    const out = toLlmMessages(record);
    expect(out).toHaveLength(3);
    const repaired = out[2] as { role: string; toolCallId: string; isError: boolean; content: { text: string }[] };
    expect(repaired).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
    expect(repaired.content[0].text).toBe(INTERRUPTED_RESULT);
    expect(JSON.stringify(record)).toBe(before);
  });

  it("keeps a result next to its call and adds results for the other calls", () => {
    const out = toLlmMessages([userMsg("u", "go"), assistantMsg("a", [call("c1", "echo"), call("c2", "echo")]), resultMsg("r1", "c1", "echo")]);
    expect(out.map((m) => (m.role === "toolResult" ? `result:${m.toolCallId}` : m.role))).toEqual(["user", "assistant", "result:c1", "result:c2"]);
  });

  it("gives a failed or aborted generation no invented result and drops it from the model view", () => {
    const out = toLlmMessages([
      userMsg("u", "go"),
      assistantMsg("a", [call("c1", "echo")], { stopReason: "error", errorMessage: "boom" }),
      assistantMsg("b", [call("c2", "echo")], { stopReason: "aborted" }),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("drops a result whose call is not in the projected list", () => {
    const out = toLlmMessages([userMsg("u", "go"), resultMsg("r", "orphan", "echo")]);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("emits the active compaction once as the head and the kept tail after it (B-7-63)", () => {
    const record = [
      userMsg("m1", "old one"),
      assistantMsg("m2", [{ type: "text", text: "old two" }]),
      userMsg("m3", "kept"),
      assistantMsg("m4", [{ type: "text", text: "kept reply" }]),
      marker("mk", "compaction", "SUMMARY", { firstKeptMessageId: "m3", tokensBefore: 1, model: "a:b", at: "x" }),
    ];
    const out = toLlmMessages(record);
    const text = JSON.stringify(out);
    expect(out).toHaveLength(3);
    expect(text.match(/SUMMARY/g)).toHaveLength(1);
    expect(text).not.toContain("old one");
    expect(text).toContain("kept reply");
    expect(record).toHaveLength(5);
  });

  it("lets only the newest marker rule chained compactions (B-7-62)", () => {
    const record = [
      userMsg("m1", "a"),
      userMsg("m2", "b"),
      marker("mk1", "compaction", "FIRST", { firstKeptMessageId: "m2", tokensBefore: 1, model: "a:b", at: "x" }),
      userMsg("m3", "c"),
      marker("mk2", "compaction", "SECOND", { firstKeptMessageId: "m3", tokensBefore: 1, model: "a:b", at: "x" }),
    ];
    const text = JSON.stringify(toLlmMessages(record));
    expect(text).toContain("SECOND");
    expect(text).not.toContain("FIRST");
    expect(activeCompaction(record)?.marker.id).toBe("mk2");
  });

  it("keeps the full history when the cut cannot be resolved, and a malformed marker is not active (B-7-64)", () => {
    const record = [userMsg("m1", "alpha"), userMsg("m2", "beta"), marker("mk", "compaction", "SUMMARY", { firstKeptMessageId: "gone" })];
    const text = JSON.stringify(toLlmMessages(record));
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("SUMMARY");
    expect(activeCompaction([userMsg("m1", "x"), marker("mk", "compaction", "S", { nope: true })])).toBeNull();
  });

  it("never throws on a damaged record", () => {
    const damaged = [null, 5, { role: "assistant" }, { role: "custom", customType: "compaction", details: 3 }] as unknown as NativeMessage[];
    expect(() => toLlmMessages(damaged)).not.toThrow();
  });
});

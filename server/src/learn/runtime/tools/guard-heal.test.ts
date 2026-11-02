import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ProviderClass } from "../../../../../shared/learn/index.ts";
import type { KnowledgeReader, PathPolicy } from "../deps.ts";
import { defineTool } from "./define.ts";
import { graphReaderTools, listSourcesTool } from "./graph-readers.ts";
import { ABORT_GRACE_MS, TOOL_TIMEOUT_MS, guard, guardTool } from "./guard.ts";
import { healArguments, healTool } from "./heal.ts";

describe("tool guard (B-7-76, B-7-77)", () => {
  it("returns the result of a tool that finishes in time", async () => {
    await expect(guard(async () => "done", { toolName: "t" })).resolves.toBe("done");
  });

  it("rejects a run that is already aborted at once, without running the body", async () => {
    const ac = new AbortController();
    ac.abort();
    const body = vi.fn(async () => "x");
    await expect(guard(body, { toolName: "t", signal: ac.signal })).rejects.toThrow("Operation aborted");
    expect(body).not.toHaveBeenCalled();
  });

  it("passes a signal to a cooperative tool, which settles partial output inside the grace", async () => {
    const ac = new AbortController();
    const p = guard(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("partial output"));
        }),
      { toolName: "t", signal: ac.signal },
    );
    ac.abort();
    await expect(p).resolves.toBe("partial output");
  });

  it("rejects a hanging tool after the grace on abort", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const p = guard(() => new Promise<string>(() => {}), { toolName: "t", signal: ac.signal });
      const assertion = expect(p).rejects.toThrow("Operation aborted");
      ac.abort();
      await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS - 1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a hanging tool at the timeout of 30 seconds, naming the tool", async () => {
    vi.useFakeTimers();
    try {
      const p = guard(() => new Promise<string>(() => {}), { toolName: "slowtool" });
      const assertion = expect(p).rejects.toThrow(/slowtool tool timed out after 30 seconds/);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS + ABORT_GRACE_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates the error of the body", async () => {
    await expect(guard(async () => Promise.reject(new Error("boom")), { toolName: "t" })).rejects.toThrow("boom");
  });

  it("wraps a tool so that its body runs under the guard", async () => {
    const tool = defineTool({
      name: "echo",
      label: "Echo",
      description: "d",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_i, p) => ({ content: [{ type: "text", text: p.text }], details: null }),
    });
    const guarded = guardTool(tool);
    const out = await guarded.execute("id", { text: "hi" } as never);
    expect(out.content[0]).toMatchObject({ text: "hi" });
    const ac = new AbortController();
    ac.abort();
    await expect(guarded.execute("id", { text: "hi" } as never, ac.signal)).rejects.toThrow("Operation aborted");
  });
});

const schema = Type.Object({
  mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")]),
  retest: Type.Boolean(),
  count: Type.Integer(),
  rung: Type.Union([Type.Literal("R0"), Type.Literal("R1"), Type.Null()]),
  target: Type.Array(Type.String()),
  label: Type.String(),
  maybe: Type.Optional(Type.Boolean()),
});

describe("argument healing (B-7-78, B-7-81)", () => {
  it("heals a JSON encoded enum member, boolean, number, null and array", () => {
    const healed = healArguments(
      { mode: '"recall"', retest: "true", count: "3", rung: "null", target: '["n_1","n_2"]', label: "x" },
      schema,
    ) as Record<string, unknown>;
    expect(healed).toEqual({ mode: "recall", retest: true, count: 3, rung: null, target: ["n_1", "n_2"], label: "x" });
  });

  it("leaves a plain string property alone, even when it parses as JSON", () => {
    const args = { mode: "recall", retest: false, count: 1, rung: "R0", target: [], label: "123" };
    expect(healArguments(args, schema)).toBe(args);
    const quoted = { ...args, label: '"quoted"' };
    expect((healArguments(quoted, schema) as { label: string }).label).toBe('"quoted"');
  });

  it("leaves a valid member and an unhealable value for validation to reject", () => {
    const bad = { mode: "recall again", retest: "maybe", count: "three", rung: "R9", target: "not an array", label: "x" };
    expect(healArguments(bad, schema)).toBe(bad);
  });

  it("returns the same reference for well formed arguments and is idempotent", () => {
    const good = { mode: "composition", retest: true, count: 2, rung: null, target: ["a"], label: "l" };
    expect(healArguments(good, schema)).toBe(good);
    const once = healArguments({ mode: '"recall"', retest: "false", count: "1", rung: '"R1"', target: "[]", label: "l" }, schema);
    expect(healArguments(once, schema)).toBe(once);
  });

  it("does not accept a parsed value that the schema rejects", () => {
    const args = { mode: '"nonsense"', retest: "true", count: "1", rung: "null", target: "[]", label: "x" };
    const healed = healArguments(args, schema) as Record<string, unknown>;
    expect(healed.mode).toBe('"nonsense"');
    expect(healed.retest).toBe(true);
  });

  it("runs ahead of the own preparation of a tool", () => {
    const tool = healTool(
      defineTool({
        name: "t",
        label: "t",
        description: "d",
        parameters: Type.Object({ flag: Type.Boolean() }),
        prepareArguments: (a) => ({ ...(a as object), seen: true }) as never,
        execute: async () => ({ content: [], details: null }),
      }),
    );
    expect(tool.prepareArguments!({ flag: "true" })).toEqual({ flag: true, seen: true });
  });
});

describe("graph readers (CONTRACTS tool vocabulary)", () => {
  const reader: KnowledgeReader = {
    listSources: (cls: ProviderClass) => [
      { id: "chat_a", label: "Bond maths", kind: "chat", propositionCount: 3, lastAt: "2026-10-01T00:00:00Z" },
      { id: "src_b", label: "notes/yields.md", kind: "notes", propositionCount: 2, lastAt: "2026-10-05T00:00:00Z" },
      ...(cls === "hosted" ? [] : [{ id: "src_c", label: "client.md", kind: "notes" as const, propositionCount: 1, lastAt: null }]),
    ],
    listPropositions: (id) =>
      id === "chat_a"
        ? [
            { id: "n_1", name: "Duration measures price risk", held: "held", support: 2 },
            { id: "n_2", name: "Convexity", held: "unknown", support: 1 },
          ]
        : [],
    getProposition: (id) =>
      id === "n_1" ? { id: "n_1", name: "Duration measures price risk", statement: "Duration is the first order sensitivity of price to yield.", aliases: ["dv01 idea"], sources: [{ id: "chat_a", label: "Bond maths" }] } : null,
    contextFor: () => ({ propositions: [], chains: [] }),
  };
  const policy: PathPolicy = {
    isDenied: () => false,
    allowedRoots: (cls) => (cls === "hosted" ? [] : [{ id: "root_1", label: "Notes", path: "/n", kind: "notes", sensitivity: "internal" }]),
  };
  const run = async (cls: ProviderClass, name: string, params: Record<string, unknown> = {}) => {
    const tool = graphReaderTools({ reader, policy, providerClass: cls }).find((t) => t.name === name)!;
    const out = await tool.execute("id", params as never);
    return { text: (out.content[0] as { text: string }).text, isError: !!out.isError };
  };

  it("lists sessions newest first with their counts", async () => {
    const r = await run("claude-code", "list_sessions");
    const lines = r.text.split("\n");
    expect(lines[0]).toContain("notes/yields.md (src_b)");
    expect(lines[1]).toContain("Bond maths (chat_a) [chat, 3 propositions, last 2026-10-01]");
  });

  it("lists names with the held band and the support, never a statement", async () => {
    const r = await run("claude-code", "list_propositions", { session: "chat_a" });
    expect(r.text).toBe("Duration measures price risk (n_1) [held: held, support: 2]\nConvexity (n_2) [held: unknown, support: 1]");
    expect(r.text).not.toContain("first order");
  });

  it("returns the statement, aliases and sources of one proposition, and teaches on an unknown id", async () => {
    const r = await run("claude-code", "get_proposition", { id: "n_1" });
    expect(r.text).toContain("first order sensitivity");
    expect(r.text).toContain("Aliases: dv01 idea");
    expect(r.text).toContain("Bond maths (chat_a)");
    const none = await run("claude-code", "get_proposition", { id: "n_9" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("list_propositions");
  });

  it("leaves out what the reader leaves out for a hosted model", async () => {
    expect((await run("hosted", "list_sessions")).text).not.toContain("client.md");
  });

  it("lists the allowed roots in both scopes", async () => {
    const tool = listSourcesTool({ policy, providerClass: "local" });
    const out = await tool.execute("id", {} as never);
    expect((out.content[0] as { text: string }).text).toContain("Notes (root_1) [notes] /n");
    const hosted = await listSourcesTool({ policy, providerClass: "hosted" }).execute("id", {} as never);
    expect((hosted.content[0] as { text: string }).text).toContain("No linked source");
  });
});

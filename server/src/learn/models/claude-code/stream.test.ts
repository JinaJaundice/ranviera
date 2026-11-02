import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, type AssistantMessage, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MISMATCH_MESSAGE } from "./bridge.ts";
import { LiveProcesses } from "./live.ts";
import { claudeCodeModels, createClaudeCodeProvider, type ClaudeCodeProvider } from "./provider.ts";
import type { ClaudeStreamDeps, ContextWindowInfo } from "./stream.ts";
import { toClaudeArgs } from "./stream.ts";
import { effortOf } from "./transcript.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-claude.mjs");
const askTool = { name: "ask", description: "Ask the learner a question.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } };
const win = process.platform === "win32";

interface Rig {
  tmp: string;
  logFile: string;
  provider: ClaudeCodeProvider;
  windows: ContextWindowInfo[];
  stderr: string[];
  log: () => Record<string, unknown>[];
  starts: () => Record<string, unknown>[];
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.provider.dispose();
    try {
      fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps the working folder locked for a moment after the kill. The system clears the temporary folder.
    }
  }
});

function rig(scenario: string, extra: Partial<ClaudeStreamDeps> = {}, env: Record<string, string> = {}): Rig {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
  const tmpRoot = path.join(tmp, "work");
  fs.mkdirSync(tmpRoot);
  const logFile = path.join(tmp, "fake.log");
  const windows: ContextWindowInfo[] = [];
  const stderr: string[] = [];
  const provider = createClaudeCodeProvider({
    findExecutable: () => "fake-claude",
    checkVersion: async () => ({ state: "meets-minimum", version: "2.1.300" }),
    launchEnv: () => ({ ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: logFile, FAKE_SAVED_KEY: "saved-by-cortex", FAKE_KEPT_VAR: "kept", ...env }),
    injectedNames: () => ["FAKE_SAVED_KEY"],
    spawnClaude: (_exe, args, options) => spawn(process.execPath, [fixture, ...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    tmpRoot,
    probeTimeoutMs: 1500,
    killGraceMs: 200,
    onContextWindow: (i) => windows.push(i),
    log: (t) => stderr.push(t),
    ...extra,
  });
  const read = (): Record<string, unknown>[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const r: Rig = { tmp, logFile, provider, windows, stderr, log: read, starts: () => read().filter((l) => l.kind === "start") };
  rigs.push(r);
  return r;
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
function ctx(messages: Message[], system = "You teach."): TranscriptContext {
  const sys: Message = { role: "system", content: system, toolsAdded: [askTool as never], timestamp: 0 };
  return { messages: [sys, ...messages] } as unknown as TranscriptContext;
}

const model = claudeCodeModels()[1];

async function collect(r: Rig, context: TranscriptContext, options: Record<string, unknown> = {}): Promise<{ events: AssistantMessageEvent[]; final: AssistantMessage }> {
  const stream = r.provider.streams.streamSimple(model, context, options);
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, final: await stream.result() };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const t = Date.now();
  while (!check()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("model definitions", () => {
  it("lists opus, sonnet and haiku with image input, no price and low as the lowest level", () => {
    const models = claudeCodeModels();
    expect(models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    for (const m of models) {
      expect(m.provider).toBe("claude-code");
      expect(m.input).toEqual(["text", "image"]);
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(m.thinkingLevelMap?.off).toBeNull();
      expect(m.thinkingLevelMap?.minimal).toBeNull();
      expect(m.thinkingLevelMap?.low).toBe("low");
    }
  });

  it("registers in the model library and needs no key", async () => {
    const r = rig("text");
    const models = createModels();
    models.setProvider(r.provider.provider);
    expect(models.getModel("claude-code", "opus")?.id).toBe("opus");
    expect(models.getModel("claude-code", "haiku")?.input).toContain("image");
  });

  it("maps effort: minimal and off to low, undefined to medium, the rest as they are", () => {
    expect(effortOf(undefined)).toBe("medium");
    expect(effortOf("minimal")).toBe("low");
    expect(effortOf("off")).toBe("low");
    for (const l of ["low", "medium", "high", "xhigh", "max"]) expect(effortOf(l)).toBe(l);
  });
});

describe("text, thinking and the launch", () => {
  it("maps a text and thinking stream to events that end with done(stop)", async () => {
    const r = rig("text");
    const { events, final } = await collect(r, ctx([user("Hi")]));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toEqual(["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(final.stopReason).toBe("stop");
    expect(final.content).toEqual([
      { type: "thinking", thinking: "Considering it." },
      { type: "text", text: "Hello world" },
    ]);
    expect(final.usage).toMatchObject({ input: 10, output: 7, cacheRead: 2, cacheWrite: 1, totalTokens: 20 });
    expect(final.usage.cost.total).toBe(0);
    expect(final.provider).toBe("claude-code");
    expect(final.model).toBe("sonnet");
  });

  it("launches with every isolation flag, an empty working folder and a private prompt folder", async () => {
    const r = rig("text");
    await collect(r, ctx([user("Hi")], "Be plain."), { reasoning: "high" });
    const [start] = r.starts();
    const args = start.args as string[];
    const at = (flag: string): string => args[args.indexOf(flag) + 1];
    expect(args).toEqual(expect.arrayContaining(["-p", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(at("--input-format")).toBe("stream-json");
    expect(at("--output-format")).toBe("stream-json");
    expect(at("--model")).toBe("sonnet");
    expect(at("--effort")).toBe("high");
    expect(at("--tools")).toBe("");
    expect(at("--setting-sources")).toBe("user");
    expect(JSON.parse(at("--settings"))).toEqual({ disableAllHooks: true });
    expect(at("--permission-prompts")).toBe("none");
    expect(args).not.toContain("--permission-prompt-tool");
    expect(at("--allowedTools")).toBe("mcp__learn__ask");
    expect(args).not.toContain("--resume");
    expect(start.systemPrompt).toBe("Be plain.");
    expect(start.cwdEntries).toEqual([]);
    const cwd = fs.realpathSync(start.cwd as string);
    const work = fs.realpathSync(path.join(r.tmp, "work"));
    expect(path.dirname(cwd)).toBe(work);
    expect(path.basename(cwd)).toMatch(/^cortex-cc-work-/);
    expect(path.dirname(at("--system-prompt-file"))).not.toBe(cwd);
    expect(path.dirname(at("--mcp-config"))).toBe(path.dirname(at("--system-prompt-file")));
    if (!win) {
      expect(start.promptMode).toBe("600");
      expect(start.mcpMode).toBe("600");
    }
    // both folders are removed when the process closes
    await until(() => fs.readdirSync(path.join(r.tmp, "work")).length === 0);
  });

  it("defaults the effort to medium", async () => {
    const r = rig("text");
    await collect(r, ctx([user("Hi")]));
    const args = r.starts()[0].args as string[];
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });

  it("builds the arguments in the documented set", () => {
    const args = toClaudeArgs({ model: "opus", effort: "low", systemPromptFile: "s.md", mcpConfigFile: "m.json", allowedTools: ["mcp__learn__a", "mcp__learn__b"] });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__learn__a,mcp__learn__b");
  });

  it("gives the child the launch environment without the saved keys and with the MCP timeouts", async () => {
    const r = rig("text");
    await collect(r, ctx([user("Hi")]));
    const env = r.starts()[0].env as Record<string, unknown>;
    expect(env.saved).toBeNull();
    expect(env.kept).toBe("kept");
    expect(env.MCP_TOOL_TIMEOUT).toBe("1800000");
    expect(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("1800000");
  });

  it("sends a single user turn as one user line and a longer history as labelled text with images kept", async () => {
    const r = rig("text");
    await collect(r, ctx([user("Hi")]));
    const history: Message[] = [
      user("First question"),
      { role: "assistant", content: [{ type: "text", text: "An answer" }, { type: "toolCall", id: "t1", name: "ask", arguments: { question: "q" } }], api: "claude-code-cli", provider: "claude-code", model: "sonnet", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "t1", toolName: "ask", content: [{ type: "text", text: "the reply" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: true, timestamp: 3 },
    ];
    await collect(r, ctx(history));
    const users = r.log().filter((l) => l.kind === "user").map((l) => l.text as string);
    expect(users[0]).toBe("Hi");
    expect(users[1]).toContain("[user]\nFirst question");
    expect(users[1]).toContain("[assistant]\nAn answer");
    expect(users[1]).toContain('[tool call ask] {"question":"q"}');
    expect(users[1]).toContain("[tool result ask error]\nthe reply");
    const blocks = r.log().filter((l) => l.kind === "blocks");
    expect(blocks[1].types).toEqual(["text", "image"]);
  });

  it("stores the context window from the probe, and leaves it unknown when the CLI does not answer", async () => {
    const r = rig("text");
    await collect(r, ctx([user("Hi")]), { sessionId: "chat_1" });
    expect(r.windows).toEqual([{ sessionId: "chat_1", model: "sonnet", maxTokens: 200000 }]);
    expect(r.provider.contextWindow("chat_1", "sonnet")).toBe(200000);
    expect(r.provider.contextWindow("chat_1", "opus")).toBeUndefined();
    const quiet = rig("text", { probeTimeoutMs: 150 }, { FAKE_CLAUDE_NO_PROBE: "1" });
    const { final } = await collect(quiet, ctx([user("Hi")]));
    expect(final.stopReason).toBe("stop");
    expect(quiet.windows).toEqual([]);
  });
});

describe("tool calls through the bridge", () => {
  const toolResult = (text: string): Message => ({ role: "toolResult", toolCallId: "toolu_A", toolName: "ask", content: [{ type: "text", text }], isError: false, timestamp: 9 });

  it("ends with done(toolUse), the CLI tool id and the unprefixed name", async () => {
    const r = rig("tool");
    const { events, final } = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    expect(final.stopReason).toBe("toolUse");
    const call = final.content.find((c) => c.type === "toolCall");
    expect(call).toMatchObject({ id: "toolu_A", name: "ask", arguments: { question: "why?" } });
    const types = events.map((e) => e.type);
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("toolcall_end");
    expect(types.at(-1)).toBe("done");
    expect(r.provider.streams.live.size).toBe(1);
  });

  it("holds the call through the rate limit and tool progress reports of the CLI", async () => {
    const r = rig("tool-rate-limit");
    const { final } = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    expect(final.errorMessage).toBeUndefined();
    expect(final.stopReason).toBe("toolUse");
    expect(final.content.find((c) => c.type === "toolCall")).toMatchObject({ id: "toolu_A", name: "ask" });
  });

  it("continues the held process when the answer arrives in time", async () => {
    const r = rig("tool");
    const first = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    const second = await collect(r, ctx([user("Teach me"), first.final, toolResult("because")]), { sessionId: "chat_1" });
    expect(second.final.stopReason).toBe("stop");
    expect(second.final.content.find((c) => c.type === "text")).toMatchObject({ text: "Got: because" });
    expect(r.starts()).toHaveLength(1);
    expect(r.provider.streams.live.size).toBe(0);
  });

  it("starts a fresh process that replays the question when the hold expired", async () => {
    const r = rig("tool", { live: new LiveProcesses({ idleMs: 150 }) });
    const first = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    await new Promise((res) => setTimeout(res, 500));
    expect(r.provider.streams.live.size).toBe(0);
    const second = await collect(r, ctx([user("Teach me"), first.final, toolResult("because")]), { sessionId: "chat_1" });
    expect(second.final.content.find((c) => c.type === "text")).toMatchObject({ text: "Replayed answer" });
    expect(r.starts()).toHaveLength(2);
    const replay = r.log().filter((l) => l.kind === "user").map((l) => l.text as string)[1];
    expect(replay).toContain('[tool call ask] {"question":"why?"}');
    expect(replay).toContain("[tool result ask]\nbecause");
  });

  it("does not reuse the process when the history or the configuration changed", async () => {
    const r = rig("tool");
    const first = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    const second = await collect(r, ctx([user("Teach me again"), first.final, toolResult("because")]), { sessionId: "chat_1" });
    expect(second.final.content.find((c) => c.type === "text")).toMatchObject({ text: "Replayed answer" });
    expect(r.starts()).toHaveLength(2);
    const third = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_2" });
    const fourth = await collect(r, ctx([user("Teach me"), third.final, toolResult("x")], "A different system prompt."), { sessionId: "chat_2" });
    expect(fourth.final.content.find((c) => c.type === "text")).toMatchObject({ text: "Replayed answer" });
  });

  it("keeps no held process for a caller without a session id", async () => {
    const r = rig("tool");
    const { final } = await collect(r, ctx([user("Teach me")]));
    expect(final.stopReason).toBe("toolUse");
    expect(r.provider.streams.live.size).toBe(0);
    await until(() => fs.readdirSync(path.join(r.tmp, "work")).length === 0);
  });

  it("fails closed when the MCP call does not match the streamed intent", async () => {
    const r = rig("tool-mismatch");
    const { final, events } = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe(MISMATCH_MESSAGE);
    expect(events.at(-1)?.type).toBe("error");
    expect(r.provider.streams.live.size).toBe(0);
  });

  it("names the reason when the CLI answers a harness call itself", async () => {
    const r = rig("self-answer");
    const { final } = await collect(r, ctx([user("Teach me")]), { sessionId: "chat_1" });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe("The CLI answered a harness tool call itself before admission: Error calling tool: MCP tool none was not found.");
  });

  it("fails the request on a native tool call outside the bridge prefix", async () => {
    const r = rig("native-tool");
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe("unsupported native tool call");
  });
});

describe("errors", () => {
  it("reports a missing binary", async () => {
    const r = rig("text", { findExecutable: () => null });
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe("claude CLI not found");
    expect(r.starts()).toHaveLength(0);
  });

  it("refuses an old or unchecked CLI before any process starts", async () => {
    const old = rig("text", { checkVersion: async () => ({ state: "update-required", version: "2.1.100" }) });
    const a = await collect(old, ctx([user("Hi")]));
    expect(a.final.errorMessage).toMatch(/2\.1\.100 is older than the minimum 2\.1\.316/);
    const unchecked = rig("text", { checkVersion: async () => ({ state: "version-unchecked", version: null }) });
    const b = await collect(unchecked, ctx([user("Hi")]));
    expect(b.final.errorMessage).toMatch(/could not be checked/);
    expect(old.starts().length + unchecked.starts().length).toBe(0);
  });

  it("reports a signed out CLI", async () => {
    const r = rig("signed-out");
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/not signed in/);
  });

  it("surfaces the errors of a result line", async () => {
    const r = rig("result-error");
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.errorMessage).toBe("first problem second problem");
  });

  it("names the exit code mid stream and keeps stderr out of the message", async () => {
    const r = rig("exit-mid");
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/exited with code 3/);
    expect(final.errorMessage).not.toContain("secret stderr text");
    await until(() => r.stderr.some((t) => t.includes("secret stderr text")));
  });

  it("fails the turn on a malformed JSON event", async () => {
    const r = rig("malformed");
    const { final } = await collect(r, ctx([user("Hi")]));
    expect(final.errorMessage).toMatch(/malformed JSON/);
  });

  it("kills the process and ends with an aborted error", async () => {
    const r = rig("hang");
    const ac = new AbortController();
    const stream = r.provider.streams.streamSimple(model, ctx([user("Hi")]), { signal: ac.signal });
    await until(() => r.log().some((l) => l.kind === "user"));
    ac.abort();
    const final = await stream.result();
    expect(final.stopReason).toBe("aborted");
    await until(() => fs.readdirSync(path.join(r.tmp, "work")).length === 0);
  });

  it("does not start a process for a request that is already aborted", async () => {
    const r = rig("text");
    const ac = new AbortController();
    ac.abort();
    const stream = r.provider.streams.streamSimple(model, ctx([user("Hi")]), { signal: ac.signal });
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(r.starts()).toHaveLength(0);
  });
});

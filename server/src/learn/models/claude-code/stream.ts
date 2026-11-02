// Claude Code provider: one model request. Each request starts one claude process (or continues a held one), maps the
// stream JSON events of the CLI to the assistant message events of pi-ai, and admits tool calls only through the
// bridge. The minimum version and the stream flags are not a stability promise of the CLI, so the flag names sit in
// one table and the stub CLI of the tests documents the event shapes that this code reads.
import { randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type AssistantMessageEventStream,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BRIDGE_PREFIX, ToolBridge, type BridgeResult } from "./bridge.ts";
import { tempRoot } from "../../temp.ts";
import { claudeChildEnv } from "./env.ts";
import { LiveProcesses, type HoldKey } from "./live.ts";
import { ClaudeProcess, defaultSpawnClaude, type ProcEvent, type Rec, type SpawnClaude } from "./process.ts";
import {
  bridgeToolsOf,
  cliBlocks,
  configHash,
  effortOf,
  historyHash,
  historyOf,
  splitTrailingResults,
  systemPromptOf,
  toolsOf,
  userLine,
} from "./transcript.ts";
import { MINIMUM_VERSION, checkClaudeVersion, type VersionResult } from "./version.ts";

export const PROBE_TIMEOUT_MS = 5000;
export const ADMISSION_TIMEOUT_MS = 60_000;
export const KILL_GRACE_MS = 1000;

/** The arguments of the CLI. The CLI reads them in any order, and each flag stays next to its value. */
export function toClaudeArgs(p: { model: string; effort: string; systemPromptFile: string; mcpConfigFile: string; allowedTools: string[] }): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--model", p.model,
    "--effort", p.effort,
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--allowedTools", p.allowedTools.join(","),
    "--permission-prompts", "none",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--setting-sources", "user",
    "--system-prompt-file", p.systemPromptFile,
    "--mcp-config", p.mcpConfigFile,
  ];
}

/** The reason that the CLI gave when it answered a harness call itself, cut to 300 characters, as the tail of the error. */
export function selfAnswerReason(content: unknown): string {
  const parts = Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")) : [typeof content === "string" ? content : ""];
  const said = parts.join(" ").replace(/<\/?tool_use_error>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  return said ? `: ${said}` : ".";
}

export interface ContextWindowInfo {
  sessionId?: string;
  model: string;
  maxTokens: number;
}

export interface ClaudeStreamDeps {
  findExecutable: () => string | null;
  checkVersion?: (exe: string, env: NodeJS.ProcessEnv) => Promise<VersionResult>;
  /** the launch environment. The default is process.env. */
  launchEnv?: () => NodeJS.ProcessEnv;
  /** the names that the Cortex key store injected into the launch environment */
  injectedNames?: () => Iterable<string>;
  spawnClaude?: SpawnClaude;
  live?: LiveProcesses<ClaudeProcess>;
  tmpRoot?: string;
  onContextWindow?: (info: ContextWindowInfo) => void;
  /** receives the stderr tail when a process closes */
  log?: (tail: string) => void;
  admissionTimeoutMs?: number;
  probeTimeoutMs?: number;
  killGraceMs?: number;
}

class Fail extends Error {
  reason: "error" | "aborted";
  constructor(message: string, reason: "error" | "aborted" = "error") {
    super(message);
    this.reason = reason;
  }
}

const rec = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function applyUsage(output: AssistantMessage, u: Rec | undefined): void {
  if (!u) return;
  const set = (key: "input" | "output" | "cacheRead" | "cacheWrite", v: unknown): void => {
    const n = num(v);
    if (n !== undefined) output.usage[key] = n;
  };
  set("input", u.input_tokens);
  set("output", u.output_tokens);
  set("cacheRead", u.cache_read_input_tokens);
  set("cacheWrite", u.cache_creation_input_tokens);
  const x = output.usage;
  x.totalTokens = x.input + x.output + x.cacheRead + x.cacheWrite;
}

/** Strings that a result error may carry for a signed out CLI. */
const SIGNED_OUT = /not logged in|not signed in|authentication_failed|\/login/i;

function resultErrorText(r: Rec): string {
  const text = str(r.result);
  if (text) return text;
  const errors = r.errors;
  if (Array.isArray(errors) && errors.length) return errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(" ");
  return `claude CLI failed (${str(r.subtype) ?? "unknown"})`;
}

function stopReasonOf(reason: string | undefined): "stop" | "length" | "toolUse" | null {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
    case undefined:
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return null;
  }
}

function findMaxTokens(v: unknown, depth = 0): number | undefined {
  const r = rec(v);
  if (!r || depth > 3) return undefined;
  for (const key of ["maxTokens", "max_tokens"]) {
    const n = num(r[key]);
    if (n !== undefined && Number.isInteger(n) && n > 0) return n;
  }
  for (const value of Object.values(r)) {
    const n = findMaxTokens(value, depth + 1);
    if (n !== undefined) return n;
  }
  return undefined;
}

function toBridgeResult(m: Extract<Message, { role: "toolResult" }>): BridgeResult {
  return {
    content: m.content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text } : { type: "image" as const, data: c.data, mimeType: c.mimeType })),
    isError: m.isError,
  };
}

interface BlockState {
  kind: "text" | "thinking" | "tool";
  contentIndex: number;
  buffer: string;
  id?: string;
  name?: string;
}

export interface ClaudeStreams extends ProviderStreams {
  live: LiveProcesses<ClaudeProcess>;
  /** ends every held process */
  dispose(): void;
}

export function createClaudeStreams(deps: ClaudeStreamDeps): ClaudeStreams {
  const live = deps.live ?? new LiveProcesses<ClaudeProcess>();
  const owner = randomUUID();
  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;

  async function run(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let finished = false;
    const end = (event: Parameters<AssistantMessageEventStream["push"]>[0]): void => {
      if (finished) return;
      finished = true;
      stream.push(event);
      stream.end();
    };
    let proc: ClaudeProcess | null = null;
    let abortListener: (() => void) | null = null;
    try {
      if (options?.signal?.aborted) throw new Fail("Request was aborted.", "aborted");
      const messages = context.messages;
      const history = historyOf(messages);
      const systemPrompt = systemPromptOf(messages);
      const tools = toolsOf(messages);
      const bridgeTools = bridgeToolsOf(tools);
      const effort = effortOf(options?.reasoning);
      const sessionId = options?.sessionId && options.sessionId !== "" ? options.sessionId : undefined;
      const env = claudeChildEnv(deps.launchEnv?.() ?? process.env, { injectedNames: deps.injectedNames?.() });
      const cfg = configHash({ model: model.id, effort, systemPrompt, tools: bridgeTools, env });

      const exe = deps.findExecutable();
      if (!exe) throw new Fail("claude CLI not found");

      let fresh = true;
      if (sessionId) {
        const { before, results } = splitTrailingResults(history);
        if (results.length) {
          const taken = live.take({ owner, sessionId, callIds: results.map((r) => r.toolCallId), historyHash: historyHash(before), configHash: cfg });
          if (taken?.kind === "failed") throw new Fail(taken.message);
          if (taken?.kind === "held") {
            try {
              for (const r of results) taken.held.bridge.resolve(r.toolCallId, toBridgeResult(r));
              proc = taken.held;
              fresh = false;
            } catch {
              taken.held.dispose();
            }
          }
        }
      }

      if (fresh) {
        const version = await (deps.checkVersion ?? ((e, v) => checkClaudeVersion(e, { env: v })))(exe, env);
        if (version.state === "update-required") throw new Fail(`Claude Code ${version.version} is older than the minimum ${MINIMUM_VERSION}. Update it and try again.`);
        if (version.state !== "meets-minimum") throw new Fail("The version of Claude Code could not be checked.");
        if (options?.signal?.aborted) throw new Fail("Request was aborted.", "aborted");
      }

      stream.push({ type: "start", partial: output });

      let bridgeRef: ToolBridge | null = null;
      if (fresh) {
        const tmp = deps.tmpRoot ?? tempRoot();
        const workDir = fs.mkdtempSync(path.join(tmp, "cortex-cc-work-"));
        const privDir = fs.mkdtempSync(path.join(tmp, "cortex-cc-priv-"));
        const folders = [workDir, privDir];
        try {
          fs.chmodSync(privDir, 0o700);
          const promptFile = path.join(privDir, "system-prompt.md");
          const mcpFile = path.join(privDir, "mcp.json");
          fs.writeFileSync(promptFile, systemPrompt, { mode: 0o600 });
          const holder: { proc?: ClaudeProcess } = {};
          const bridge = await ToolBridge.start({
            tools: bridgeTools,
            onViolation: () => holder.proc?.push({ kind: "violation" }),
            onChange: () => holder.proc?.push({ kind: "bridge" }),
          });
          bridgeRef = bridge;
          fs.writeFileSync(mcpFile, JSON.stringify(bridge.mcpConfig()), { mode: 0o600 });
          const args = toClaudeArgs({ model: model.id, effort, systemPromptFile: promptFile, mcpConfigFile: mcpFile, allowedTools: bridge.allowedToolNames() });
          let child: ChildProcess;
          try {
            child = spawnClaude(exe, args, { cwd: workDir, env });
          } catch {
            await bridge.close();
            throw new Fail("claude CLI failed to start");
          }
          proc = new ClaudeProcess({ child, bridge, folders, killGraceMs, log: deps.log });
          holder.proc = proc;
        } catch (e) {
          if (!proc) {
            await bridgeRef?.close().catch(() => undefined);
            for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
          }
          throw e;
        }
        await probeContext(proc, model.id, sessionId);
        proc.write(userLine(cliBlocks(messages)));
      }

      const live1 = proc as ClaudeProcess | null;
      if (!live1) throw new Fail("claude CLI failed to start");
      if (options?.signal) {
        const sig = options.signal;
        abortListener = () => live1.push({ kind: "abort" });
        sig.addEventListener("abort", abortListener, { once: true });
        if (sig.aborted) live1.push({ kind: "abort" });
      }

      const outcome = await drive(live1, output, stream, history, cfg, sessionId, (ev) => end(ev));
      if (outcome === "held") proc = null;
    } catch (e) {
      const f = e instanceof Fail ? e : new Fail(e instanceof Error ? e.message : String(e));
      output.stopReason = f.reason;
      output.errorMessage = f.message;
      end({ type: "error", reason: f.reason, error: output });
    } finally {
      if (abortListener && options?.signal) options.signal.removeEventListener("abort", abortListener);
      proc?.dispose();
    }
  }

  /** Sends the two control requests and waits for the context size. A missing answer leaves the window unknown. */
  async function probeContext(proc: ClaudeProcess, modelId: string, sessionId: string | undefined): Promise<void> {
    const id = `ctx_${randomBytes(4).toString("hex")}`;
    proc.write(`${JSON.stringify({ type: "control_request", request_id: `init_${id}`, request: { subtype: "initialize" } })}\n`);
    proc.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail: "summary" } })}\n`);
    const reply = await proc.waitFor((ev) => ev.kind === "json" && ev.value.type === "control_response" && rec(ev.value.response)?.request_id === id, deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    if (reply?.kind !== "json") return;
    const response = rec(reply.value.response);
    if (response?.subtype === "error") return;
    const maxTokens = findMaxTokens(response);
    if (maxTokens !== undefined) deps.onContextWindow?.({ sessionId, model: modelId, maxTokens });
  }

  async function drive(
    proc: ClaudeProcess,
    output: AssistantMessage,
    stream: AssistantMessageEventStream,
    history: ReturnType<typeof historyOf>,
    cfg: string,
    sessionId: string | undefined,
    end: (event: Parameters<AssistantMessageEventStream["push"]>[0]) => void,
  ): Promise<"held" | "done"> {
    const bridge = proc.bridge;
    const blocks = new Map<number, BlockState>();
    const intentIds: string[] = [];
    let outcome: "held" | "done" | null = null;
    let messageOpen = false;
    let messageSeen = false;
    let awaiting = false;
    let admitTimer: ReturnType<typeof setTimeout> | null = null;
    const messageIds = new Set<string>();
    const push = (e: Parameters<AssistantMessageEventStream["push"]>[0]): void => {
      stream.push(e);
    };

    const checkAdmission = (): boolean => {
      if (bridge.failure !== null) throw new Fail(bridge.failure);
      bridge.assertNoOrphans();
      if (bridge.failure !== null) throw new Fail(bridge.failure);
      return bridge.allAdmitted(intentIds);
    };

    const finishToolMessage = (): void => {
      if (admitTimer) clearTimeout(admitTimer);
      proc.drainBridgeSignals();
      output.stopReason = "toolUse";
      end({ type: "done", reason: "toolUse", message: output });
      outcome = "held";
      if (sessionId) {
        const key: HoldKey = { owner, sessionId, callIds: [...intentIds], historyHash: historyHash([...history, output]), configHash: cfg };
        live.hold(key, proc);
      } else {
        proc.dispose();
      }
    };

    const startBlock = (index: number, block: Rec): void => {
      const type = str(block.type);
      if (type === "text") {
        output.content.push({ type: "text", text: "" });
        const contentIndex = output.content.length - 1;
        blocks.set(index, { kind: "text", contentIndex, buffer: "" });
        push({ type: "text_start", contentIndex, partial: output });
      } else if (type === "thinking" || type === "redacted_thinking") {
        output.content.push({ type: "thinking", thinking: "", ...(type === "redacted_thinking" ? { redacted: true } : {}) });
        const contentIndex = output.content.length - 1;
        blocks.set(index, { kind: "thinking", contentIndex, buffer: "" });
        push({ type: "thinking_start", contentIndex, partial: output });
      } else if (type === "tool_use") {
        const id = str(block.id) ?? "";
        const fullName = str(block.name) ?? "";
        if (!fullName.startsWith(BRIDGE_PREFIX)) throw new Fail("unsupported native tool call");
        if (id === "" || intentIds.includes(id)) throw new Fail("A tool call identifier is missing or repeats in the stream.");
        const name = fullName.slice(BRIDGE_PREFIX.length);
        intentIds.push(id);
        const call: ToolCall = { type: "toolCall", id, name, arguments: {} };
        output.content.push(call);
        const contentIndex = output.content.length - 1;
        blocks.set(index, { kind: "tool", contentIndex, buffer: "", id, name });
        push({ type: "toolcall_start", contentIndex, partial: output });
      }
    };

    const deltaBlock = (index: number, delta: Rec): void => {
      const b = blocks.get(index);
      if (!b) return;
      const type = str(delta.type);
      if (b.kind === "text" && type === "text_delta") {
        const d = str(delta.text) ?? "";
        b.buffer += d;
        (output.content[b.contentIndex] as { text: string }).text = b.buffer;
        push({ type: "text_delta", contentIndex: b.contentIndex, delta: d, partial: output });
      } else if (b.kind === "thinking" && type === "thinking_delta") {
        const d = str(delta.thinking) ?? "";
        b.buffer += d;
        (output.content[b.contentIndex] as { thinking: string }).thinking = b.buffer;
        push({ type: "thinking_delta", contentIndex: b.contentIndex, delta: d, partial: output });
      } else if (b.kind === "tool" && type === "input_json_delta") {
        const d = str(delta.partial_json) ?? "";
        b.buffer += d;
        push({ type: "toolcall_delta", contentIndex: b.contentIndex, delta: d, partial: output });
      }
    };

    const stopBlock = (index: number): void => {
      const b = blocks.get(index);
      if (!b) return;
      if (b.kind === "text") push({ type: "text_end", contentIndex: b.contentIndex, content: b.buffer, partial: output });
      else if (b.kind === "thinking") push({ type: "thinking_end", contentIndex: b.contentIndex, content: b.buffer, partial: output });
      else {
        let args: Rec;
        try {
          const parsed: unknown = b.buffer.trim() === "" ? {} : JSON.parse(b.buffer);
          const r = rec(parsed);
          if (!r) throw new Error("not an object");
          args = r;
        } catch {
          throw new Fail("A tool call carried arguments that are not valid JSON.");
        }
        const call = output.content[b.contentIndex] as ToolCall;
        call.arguments = args as ToolCall["arguments"];
        push({ type: "toolcall_end", contentIndex: b.contentIndex, toolCall: call, partial: output });
        bridge.declareIntent({ id: b.id as string, name: b.name as string, arguments: args });
        if (bridge.failure !== null) throw new Fail(bridge.failure);
      }
    };

    const onStreamEvent = (e: Rec): void => {
      const type = str(e.type);
      if (type === "message_start") {
        if (messageSeen) throw new Fail(awaiting || intentIds.length ? "The CLI started a new message without admitting its calls." : "The CLI started a second message in one request.");
        messageSeen = true;
        messageOpen = true;
        const message = rec(e.message);
        const id = str(message?.id);
        if (id) {
          messageIds.add(id);
          output.responseId = id;
        }
        const m = str(message?.model);
        if (m) output.responseModel = m;
        applyUsage(output, rec(message?.usage));
      } else if (type === "content_block_start") {
        startBlock(num(e.index) ?? 0, rec(e.content_block) ?? {});
      } else if (type === "content_block_delta") {
        deltaBlock(num(e.index) ?? 0, rec(e.delta) ?? {});
      } else if (type === "content_block_stop") {
        stopBlock(num(e.index) ?? 0);
      } else if (type === "message_delta") {
        const d = rec(e.delta);
        const reason = str(d?.stop_reason);
        if (reason) output.rawStopReason = reason;
        applyUsage(output, rec(e.usage));
      } else if (type === "message_stop") {
        if (!messageOpen) return;
        messageOpen = false;
        const mapped = stopReasonOf(output.rawStopReason);
        if (mapped === null) throw new Fail(output.rawStopReason === "refusal" ? "The model refused the request." : `Unhandled stop reason ${output.rawStopReason}`);
        if (mapped === "toolUse") {
          if (intentIds.length === 0) throw new Fail("The CLI ended a message with tool use and no tool calls.");
          awaiting = true;
          if (checkAdmission()) {
            finishToolMessage();
            return;
          }
          admitTimer = setTimeout(() => proc.push({ kind: "timeout" }), deps.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS);
          admitTimer.unref?.();
          return;
        }
        if (intentIds.length) throw new Fail("The CLI ended a message with tool calls and a stop reason of end of turn.");
        output.stopReason = mapped;
        end({ type: "done", reason: mapped, message: output });
        outcome = "done";
        proc.dispose();
      }
    };

    // A message that arrives whole, with no partial events, goes through the same handlers.
    const onAssistant = (ev: Rec): void => {
      const message = rec(ev.message);
      const err = str(ev.error);
      if (err) throw new Fail(err === "authentication_failed" ? "Claude Code is not signed in. Sign in with the claude command and try again." : err);
      const id = str(message?.id);
      if (messageSeen || (id && messageIds.has(id))) return;
      const content = message?.content;
      if (!Array.isArray(content)) return;
      onStreamEvent({ type: "message_start", message: { id, model: message?.model, usage: message?.usage } });
      content.forEach((raw, index) => {
        const block = rec(raw);
        if (!block) return;
        onStreamEvent({ type: "content_block_start", index, content_block: { ...block, ...(block.type === "tool_use" ? { input: undefined } : {}) } });
        if (block.type === "text") onStreamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: str(block.text) ?? "" } });
        else if (block.type === "thinking") onStreamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: str(block.thinking) ?? "" } });
        else if (block.type === "tool_use") onStreamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
        onStreamEvent({ type: "content_block_stop", index });
      });
      onStreamEvent({ type: "message_delta", delta: { stop_reason: str(message?.stop_reason) }, usage: message?.usage });
      onStreamEvent({ type: "message_stop" });
    };

    const onUser = (ev: Rec): void => {
      const content = rec(ev.message)?.content;
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        const block = rec(raw);
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && intentIds.includes(block.tool_use_id)) {
          throw new Fail(`The CLI answered a harness tool call itself before admission${selfAnswerReason(block.content)}`);
        }
      }
    };

    try {
      for (;;) {
        const ev: ProcEvent = await proc.next();
        switch (ev.kind) {
          case "json": {
            const type = str(ev.value.type);
            // While calls are held, only a user message, which carries tool results, means that the CLI moved on. A result
            // event ends the turn below. Every other event, such as the rate limit and tool progress reports of Claude
            // Code 2.1.316, changes nothing in the turn and is ignored (2 November 2026).
            if (awaiting && type === "user") {
              onUser(ev.value);
              throw new Fail("The CLI moved on while tool calls were held (event user).");
            }
            if (awaiting && type === "stream_event") {
              const inner = rec(ev.value.event);
              if (str(inner?.type) === "message_start") throw new Fail("The CLI started a new message without admitting its calls.");
              break;
            }
            if (type === "stream_event") onStreamEvent(rec(ev.value.event) ?? {});
            else if (type === "assistant") onAssistant(ev.value);
            else if (type === "user") onUser(ev.value);
            else if (type === "result") {
              if (ev.value.is_error === true) {
                const text = resultErrorText(ev.value);
                throw new Fail(SIGNED_OUT.test(text) ? "Claude Code is not signed in. Sign in with the claude command and try again." : text);
              }
              if (awaiting) throw new Fail("The CLI ended while tool calls were held.");
              throw new Fail("The CLI ended without a finished message.");
            }
            break;
          }
          case "bad":
            throw new Fail("The CLI sent a malformed JSON event.");
          case "spawn-error":
            throw new Fail("claude CLI failed to start");
          case "exit":
            throw new Fail(`claude CLI exited with code ${ev.code ?? "unknown"}.`);
          case "violation":
            throw new Fail(bridge.failure ?? "The MCP call does not match its streamed tool intent.");
          case "abort":
            throw new Fail("Request was aborted.", "aborted");
          case "timeout":
            throw new Fail("The CLI did not make its tool calls through the bridge in time.");
          case "bridge":
            if (awaiting && checkAdmission()) finishToolMessage();
            break;
        }
        if (outcome) return outcome;
      }
    } catch (e) {
      if (admitTimer) clearTimeout(admitTimer);
      proc.dispose();
      throw e;
    }
  }

  const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void run(model, context, options, stream);
    return stream;
  };

  return {
    stream: (model, context, options?: StreamOptions) => streamSimple(model, context, options as SimpleStreamOptions | undefined),
    streamSimple,
    live,
    dispose: () => live.disposeAll(),
  };
}

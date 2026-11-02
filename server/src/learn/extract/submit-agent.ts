// A small agent whose whole deliverable is one validated tool call. The agent loop exists so that the model can
// correct a call that fails validation. A rejected call returns a readable error as the tool result, and the run
// stops after the first clean submit or after the turn limit (docs/CONTRACTS.md, "Limits": 4 turns for the
// extractor and 16 for the auditor).
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CallUsage, ThinkingLevel } from "../../../../shared/learn/sessions.ts";
import { AbortedError } from "./semaphore.ts";
import type { AnyTool } from "./types.ts";

export interface AgentEngine {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  stream: StreamFn;
}

export interface SubmitRun {
  systemPrompt: string;
  /** the first user message */
  prompt: string;
  tools: AnyTool[];
  maxTurns: number;
  /** true once a clean submit has been taken. The run ends after the turn in which it turns true. */
  done: () => boolean;
  /** sent when the model answers in text without calling the tool */
  nudge: string;
  signal?: AbortSignal;
  /** called for each completed model call that reports usage */
  onUsage?: (usage: CallUsage) => void;
}

export interface SubmitOutcome {
  turns: number;
  done: boolean;
}

const count = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);

/** The usage of a completed message in the shape of the session record. A field the provider did not report stays absent. */
export function callUsageOf(usage: unknown): CallUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = count(u.input);
  const output = count(u.output);
  if (input === undefined && output === undefined) return null;
  const out: CallUsage = {};
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  const read = count(u.cacheRead);
  if (read !== undefined) out.cacheReadTokens = read;
  const write = count(u.cacheWrite);
  if (write !== undefined) out.cacheWriteTokens = write;
  const long = count(u.cacheWrite1h);
  if (long !== undefined) out.cacheWrite1hTokens = long;
  const reasoning = count(u.reasoning);
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}

/**
 * Runs the agent. Throws AbortedError when the signal aborts and a plain Error when the provider fails. Returns
 * with done false when the model used all its turns without a clean submit, and the caller decides what that means.
 */
export async function runSubmitAgent(engine: AgentEngine, run: SubmitRun): Promise<SubmitOutcome> {
  let turns = 0;
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: run.systemPrompt,
      model: engine.model,
      thinkingLevel: engine.thinkingLevel ?? "off",
      tools: run.tools,
    },
    streamFn: engine.stream,
    sessionId: randomUUID(),
    toolExecution: "sequential",
    finishTurn: (turn) => {
      turns += 1;
      if (run.done() || turns >= run.maxTurns) return { action: "end" };
      const asked = turn.message.content.some((b) => b.type === "toolCall");
      if (!asked) agent.followUp({ role: "user", content: run.nudge, timestamp: Date.now() });
      return undefined;
    },
  });
  agent.subscribe((event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const m = event.message as { role?: string; stopReason?: string; usage?: unknown };
    if (m.role !== "assistant" || m.stopReason === "aborted") return;
    const usage = callUsageOf(m.usage);
    if (usage) run.onUsage?.(usage);
  });
  const stop = () => agent.abort();
  run.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (run.signal?.aborted) throw new AbortedError();
    await agent.prompt(run.prompt);
    await agent.waitForIdle();
  } finally {
    run.signal?.removeEventListener("abort", stop);
  }
  if (run.signal?.aborted) throw new AbortedError();
  const last = agent.state.messages[agent.state.messages.length - 1] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  if (agent.state.errorMessage || last?.stopReason === "error") {
    throw new Error(agent.state.errorMessage ?? last?.errorMessage ?? "The model call failed.");
  }
  return { turns, done: run.done() };
}

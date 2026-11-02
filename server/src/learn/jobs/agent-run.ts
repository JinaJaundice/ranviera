// A small agent loop for a background worker. The final text of the model is the deliverable. The loop ends when the
// model answers without a tool call, or at the turn limit. One turn before the limit the model is told to write its
// brief now, so that a worker that kept searching still reports what it found.
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { CallUsage } from "../../../../shared/learn/index.ts";
import { AbortedError } from "../extract/semaphore.ts";
import { callUsageOf } from "../extract/submit-agent.ts";
import type { AnyTool } from "../runtime/tools/define.ts";
import type { JobEngine } from "./types.ts";

export interface AgentRunOptions {
  engine: Pick<JobEngine, "model" | "thinkingLevel" | "stream">;
  systemPrompt: string;
  prompt: string;
  tools: AnyTool[];
  maxTurns: number;
  signal: AbortSignal;
  onUsage?: (usage: CallUsage) => void;
  /** called with the agent before the run, so that a tool can queue a message for the next boundary */
  onAgent?: (agent: Agent) => void;
  /** returns a message when the model tries to stop too soon, and the run goes on. It may answer once. */
  beforeStop?: () => string | null;
}

export interface AgentRunOutcome {
  text: string;
  turns: number;
}

const textOf = (message: { content?: unknown }): string =>
  Array.isArray(message.content) ? message.content.map((b: { type?: string; text?: string }) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("") : "";

export async function runWorkerAgent(run: AgentRunOptions): Promise<AgentRunOutcome> {
  let turns = 0;
  let nudged = false;
  const agent: Agent = new Agent({
    initialState: { systemPrompt: run.systemPrompt, model: run.engine.model, thinkingLevel: run.engine.thinkingLevel ?? "off", tools: run.tools },
    streamFn: run.engine.stream,
    sessionId: randomUUID(),
    toolExecution: "sequential",
    finishTurn: (turn) => {
      turns += 1;
      if (turns >= run.maxTurns) return { action: "end" };
      const asked = turn.message.content.some((b) => b.type === "toolCall");
      if (!asked && !nudged) {
        const note = run.beforeStop?.();
        if (note) {
          nudged = true;
          agent.followUp({ role: "user", content: note, timestamp: Date.now() });
        }
      }
      if (asked && turns === run.maxTurns - 1) {
        agent.steer({ role: "user", content: "This is your last turn. Reply now with the final brief and make no further tool calls.", timestamp: Date.now() });
      }
      return undefined;
    },
  });
  run.onAgent?.(agent);
  let lastText = "";
  agent.subscribe((event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const m = event.message as { role?: string; stopReason?: string; usage?: unknown; content?: unknown };
    if (m.role !== "assistant" || m.stopReason === "aborted") return;
    const usage = callUsageOf(m.usage);
    if (usage) run.onUsage?.(usage);
    const text = textOf(m).trim();
    if (text) lastText = text;
  });
  const stop = () => agent.abort();
  run.signal.addEventListener("abort", stop, { once: true });
  try {
    if (run.signal.aborted) throw new AbortedError();
    await agent.prompt(run.prompt);
    await agent.waitForIdle();
  } finally {
    run.signal.removeEventListener("abort", stop);
  }
  if (run.signal.aborted) throw new AbortedError();
  const last = agent.state.messages[agent.state.messages.length - 1] as { stopReason?: string; errorMessage?: string } | undefined;
  if (agent.state.errorMessage || last?.stopReason === "error") throw new Error(agent.state.errorMessage ?? last?.errorMessage ?? "The model call failed.");
  return { text: lastText, turns };
}

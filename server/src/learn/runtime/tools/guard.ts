// The tool guard of CONTRACTS "Tool vocabulary": every tool body races the run's
// abort signal and a timeout of 30 seconds. After either, a cooperative tool
// has 250 ms to return partial output before the guard rejects.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AnyTool } from "./define.ts";

export const TOOL_TIMEOUT_MS = 30_000;
export const ABORT_GRACE_MS = 250;

export interface GuardOptions {
  toolName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
}

/** Runs a tool body under the guard. The body receives a signal that fires on abort and on timeout. */
export function guard<T>(run: (signal: AbortSignal) => Promise<T>, options: GuardOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  const graceMs = options.graceMs ?? ABORT_GRACE_MS;
  if (options.signal?.aborted) return Promise.reject(new Error("Operation aborted"));
  const inner = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const startGrace = (message: string) => {
      inner.abort();
      graceTimer = setTimeout(() => finish(() => reject(new Error(message))), graceMs);
    };
    const onAbort = () => {
      if (!graceTimer) startGrace("Operation aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      if (!graceTimer) startGrace(`The ${options.toolName} tool timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }, timeoutMs);
    let body: Promise<T>;
    try {
      body = run(inner.signal);
    } catch (e) {
      finish(() => reject(e));
      return;
    }
    body.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Wraps a tool so that its body runs under the guard. */
export function guardTool<T extends AnyTool>(tool: T, timing: { timeoutMs?: number; graceMs?: number } = {}): T {
  const execute = tool.execute;
  return {
    ...tool,
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: never): Promise<AgentToolResult<unknown>> =>
      guard((inner) => execute(toolCallId, params, inner, onUpdate), { toolName: tool.name, signal, ...timing }),
  };
}

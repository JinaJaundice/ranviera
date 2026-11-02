// Claude Code provider: one child process and its event queue. The queue takes the lines of stdout, the exit, and the
// signals of the bridge and of an abort, so that one loop reads every cause of change in order. A process that is
// held between requests keeps queueing, and any output while it is held disqualifies it for reuse.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { HeldHandle } from "./live.ts";
import type { ToolBridge } from "./bridge.ts";

export type Rec = Record<string, unknown>;

export type ProcEvent =
  | { kind: "json"; value: Rec }
  | { kind: "bad"; line: string }
  | { kind: "exit"; code: number | null }
  | { kind: "spawn-error"; message: string }
  | { kind: "bridge" }
  | { kind: "violation" }
  | { kind: "abort" }
  | { kind: "timeout" };

export type SpawnClaude = (exe: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export const defaultSpawnClaude: SpawnClaude = (exe, args, options) =>
  spawn(exe, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

const STDERR_TAIL_BYTES = 64 * 1024;

export interface ProcessOptions {
  child: ChildProcess;
  bridge: ToolBridge;
  /** folders to remove when the process closes */
  folders: string[];
  killGraceMs: number;
  /** receives the tail of stderr when the process closes. It is never shown to the person. */
  log?: (tail: string) => void;
}

export class ClaudeProcess implements HeldHandle {
  readonly bridge: ToolBridge;
  readonly child: ChildProcess;
  #queue: ProcEvent[] = [];
  #wake: (() => void) | null = null;
  #buffer = "";
  #stderr = "";
  #exited = false;
  #disposed = false;
  #exitCbs: ((message: string) => void)[] = [];
  #opts: ProcessOptions;
  #cleaned = false;

  constructor(opts: ProcessOptions) {
    this.#opts = opts;
    this.child = opts.child;
    this.bridge = opts.bridge;
    const { child } = opts;
    child.stdout?.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin?.on("error", () => {
      // the process ended before it read its input, and the exit event reports it
    });
    child.on("error", (e) => {
      this.#exited = true;
      this.push({ kind: "spawn-error", message: e.message });
      this.#finish();
    });
    child.on("close", (code) => {
      this.#flushBuffer();
      this.#exited = true;
      this.push({ kind: "exit", code });
      this.#finish();
    });
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  push(ev: ProcEvent): void {
    this.#queue.push(ev);
    const w = this.#wake;
    this.#wake = null;
    w?.();
  }

  #onStdout(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let i: number;
    while ((i = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, i).trim();
      this.#buffer = this.#buffer.slice(i + 1);
      this.#parse(line);
    }
  }

  #flushBuffer(): void {
    const line = this.#buffer.trim();
    this.#buffer = "";
    if (line) this.#parse(line);
  }

  #parse(line: string): void {
    if (!line) return;
    try {
      const v: unknown = JSON.parse(line);
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      this.push({ kind: "json", value: v as Rec });
    } catch {
      this.push({ kind: "bad", line: line.slice(0, 200) });
    }
  }

  #finish(): void {
    this.#opts.log?.(this.#stderr);
    void this.#cleanup();
    if (!this.#disposed) {
      const cbs = this.#exitCbs;
      this.#exitCbs = [];
      const text = `claude CLI exited with code ${this.child.exitCode ?? "unknown"} while a tool call was waiting.`;
      for (const cb of cbs) cb(text);
    }
  }

  async #cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    await this.bridge.close().catch(() => undefined);
    for (const f of this.#opts.folders) {
      try {
        fs.rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // a folder that stays locked is left for the temporary folder clean up of the system
      }
    }
  }

  write(line: string): void {
    if (this.#exited || !this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(line);
  }

  /** Waits for the next event. */
  async next(): Promise<ProcEvent> {
    for (;;) {
      const ev = this.#queue.shift();
      if (ev) return ev;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** Removes the first queued event that matches, or waits for one up to the time limit. Other events stay queued. */
  async waitFor(match: (ev: ProcEvent) => boolean, ms: number): Promise<ProcEvent | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.#queue.findIndex(match);
      if (i >= 0) return this.#queue.splice(i, 1)[0];
      if (this.#exited) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.#wake = null;
          resolve();
        }, left);
        this.#wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** Drops the wake ups of the bridge, which carry no output. */
  drainBridgeSignals(): void {
    this.#queue = this.#queue.filter((e) => e.kind !== "bridge");
  }

  alive(): boolean {
    return !this.#exited && !this.#disposed;
  }

  hasPendingOutput(): boolean {
    return this.#queue.length > 0;
  }

  onExit(cb: (message: string) => void): void {
    this.#exitCbs.push(cb);
  }

  /** Ends the process: stdin closes, then SIGTERM, then SIGKILL after the grace time. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exitCbs = [];
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    if (this.#exited) {
      void this.#cleanup();
      return;
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const t = setTimeout(() => {
      if (!this.#exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, this.#opts.killGraceMs);
    t.unref?.();
    // The bridge closes now. The folders go when the process has closed, because a working folder cannot be removed
    // on Windows while a process runs in it.
    void this.bridge.close().catch(() => undefined);
  }
}

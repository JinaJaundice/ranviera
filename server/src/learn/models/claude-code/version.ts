// Claude Code provider: the version check. It runs claude --version only, with no shell, within 5 seconds and 4,096
// bytes of output, and compares the result with the minimum. The check does not test sign in, quota or model access.
import { spawn } from "node:child_process";
import os from "node:os";
import type { ClaudeCodeStatus } from "../../../../../shared/learn/models.ts";

export const MINIMUM_VERSION = "2.1.316" as const;
export const VERSION_TIMEOUT_MS = 5000;
export const VERSION_MAX_BYTES = 4096;

export type VersionState = ClaudeCodeStatus["state"];

export interface VersionResult {
  state: VersionState;
  version: string | null;
}

type Triple = [number, number, number];

/** Three dotted numbers with an optional suffix, taken from the first match in the output. */
export function parseVersion(output: string): { text: string; parts: Triple } | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { text: `${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

export function compareVersions(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function classifyVersion(output: string): VersionResult {
  const parsed = parseVersion(output);
  if (!parsed) return { state: "version-unchecked", version: null };
  const minimum = parseVersion(MINIMUM_VERSION) as { parts: Triple };
  const state: VersionState = compareVersions(parsed.parts, minimum.parts) >= 0 ? "meets-minimum" : "update-required";
  return { state, version: parsed.text };
}

export interface CheckVersionOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** replaces node:child_process spawn, for tests */
  spawnFn?: typeof spawn;
}

/** Runs the executable directly with --version. A failure of any kind gives version-unchecked. */
export function checkClaudeVersion(exe: string, options: CheckVersionOptions = {}): Promise<VersionResult> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? VERSION_MAX_BYTES;
  const unchecked: VersionResult = { state: "version-unchecked", version: null };
  if (options.signal?.aborted) return Promise.resolve(unchecked);
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let bytes = 0;
    const finish = (r: VersionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = (options.spawnFn ?? spawn)(exe, ["--version"], {
        shell: false,
        windowsHide: true,
        cwd: options.cwd ?? os.tmpdir(),
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(unchecked);
      return;
    }
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const onAbort = (): void => {
      kill();
      finish(unchecked);
    };
    const timer = setTimeout(() => {
      kill();
      finish(unchecked);
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        out += chunk.subarray(0, Math.max(0, chunk.length - (bytes - maxBytes))).toString("utf8");
        kill();
        finish(classifyVersion(out));
        return;
      }
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(unchecked));
    child.on("close", (code) => finish(code === 0 ? classifyVersion(out) : unchecked));
  });
}

export interface StatusOptions extends CheckVersionOptions {
  /** the executable, from findClaudeExecutable */
  exe: string | null;
  enabled: boolean;
  allowBackground: boolean;
}

/** GET /api/learn/claude-code. No probe starts when the executable is missing or the opt in is off. */
export async function claudeCodeStatus(options: StatusOptions): Promise<ClaudeCodeStatus> {
  const base = { minimumVersion: MINIMUM_VERSION, enabled: options.enabled, allowBackground: options.allowBackground };
  if (!options.exe) return { state: "not-found", version: null, ...base };
  if (!options.enabled) return { state: "version-unchecked", version: null, ...base };
  const r = await checkClaudeVersion(options.exe, options);
  return { state: r.state, version: r.version, ...base };
}

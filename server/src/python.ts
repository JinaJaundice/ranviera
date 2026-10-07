// Runs the compiler commands. Every call goes through runPython, which uses kg_cmd when it is set.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";

export interface PythonResult {
  stdout: string;
  stderr: string;
  code: number;
}

export const PYTHON_TIMEOUT_MS = 120_000;

/** The executable and the leading arguments of a compiler call. */
export function compilerCommand(cfg: Config): { cmd: string; prefix: string[] } {
  if (cfg.kg_cmd && cfg.kg_cmd.length > 0) return { cmd: cfg.kg_cmd[0], prefix: cfg.kg_cmd.slice(1) };
  return { cmd: cfg.python_cmd || (process.platform === "win32" ? "python" : "python3"), prefix: [path.join(cfg.repo_root, "cortex.py")] };
}

export function runPython(cfg: Config, args: string[], stdin?: string, timeoutMs = PYTHON_TIMEOUT_MS): Promise<PythonResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const { cmd, prefix } = compilerCommand(cfg);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
    // the compiler reads the same configuration file as the server
    if (cfg.config_file && !env.CORTEX_CONFIG) env.CORTEX_CONFIG = cfg.config_file;
    const cwd = fs.existsSync(cfg.repo_root) ? cfg.repo_root : process.cwd();
    const child = spawn(cmd, [...prefix, ...args], { cwd, windowsHide: true, env });
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      stderr += `The command ran for more than ${timeoutMs / 1000} seconds and was stopped.\n`;
      child.kill();
      finish(124);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      stderr += `${e.message}\n`;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

/** Last non-empty line of the output, for an error message. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

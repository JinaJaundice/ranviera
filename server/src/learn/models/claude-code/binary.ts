// Claude Code provider: finding the claude executable. The order is the explicit path (the setting claude_cmd), then
// the directories on PATH, then the usual places for the platform. The process is started with no shell, so on
// Windows only a directly runnable claude.exe counts and a claude.cmd shim does not. The mission runner reads this
// function at merge, so that both paths share one discovery.
import fs from "node:fs";
import path from "node:path";

export interface FindClaudeOptions {
  /** an explicit path, tried first (cortex.config.json claude_cmd) */
  claudeCmd?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** true when the path is an executable regular file. Tests replace it with a fake file system. */
  isExecutable?: (file: string) => boolean;
}

function realIsExecutable(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The usual places after PATH, in order, for one platform. */
export function knownDirectories(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const dirs: string[] = [];
  const prefix = envValue(env, "npm_config_prefix", win);
  if (win) {
    dirs.push(P.join(home, ".local", "bin"), P.join(home, ".claude", "local"));
    const local = envValue(env, "LOCALAPPDATA", true);
    if (local) dirs.push(P.join(local, "Programs", "claude"), P.join(local, "Programs", "claude-code"));
    const npmRoot = prefix || (envValue(env, "APPDATA", true) ? P.join(envValue(env, "APPDATA", true) as string, "npm") : "");
    if (npmRoot) dirs.push(npmRoot, P.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "bin"));
    return dirs;
  }
  const npmBin = prefix ? P.join(prefix, "bin") : P.join(home, ".npm-global", "bin");
  if (platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", P.join(home, ".local", "bin"), P.join(home, ".claude", "local"), npmBin);
    return dirs;
  }
  dirs.push(P.join(home, ".local", "bin"), npmBin);
  return dirs;
}

/** The path of the claude executable, or null when every location misses. */
export function findClaudeExecutable(options: FindClaudeOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const home = options.homedir ?? (win ? envValue(env, "USERPROFILE", true) : env.HOME) ?? "";
  const isExecutable = options.isExecutable ?? realIsExecutable(platform);
  const names = win ? ["claude.exe"] : ["claude"];

  const explicit = options.claudeCmd?.trim();
  if (explicit) {
    const acceptable = !win || explicit.toLowerCase().endsWith(".exe");
    if (acceptable && isExecutable(explicit)) return explicit;
  }

  const pathValue = envValue(env, "PATH", win) ?? "";
  for (const raw of pathValue.split(win ? ";" : ":")) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry) continue;
    const dir = P.isAbsolute(entry) ? entry : P.resolve(entry);
    for (const name of names) {
      const candidate = P.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  for (const dir of knownDirectories(platform, home, env)) {
    for (const name of names) {
      const candidate = P.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

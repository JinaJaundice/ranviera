// The first run: the consent record, the hooks, the state of the person's own Claude Code and the access token.
import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ClaudeState, HookEntry, HooksState, SetupFile, SetupState } from "../../shared/types.ts";
import { productOf, versionOf, type Config } from "./config.ts";
import { cleanEnv, findClaude } from "./missions.ts";
import { lastLine, runPython } from "./python.ts";
import { HttpError, norm, readJsonFile } from "./util.ts";

// ---------------------------------------------------------------- files

/** Writes a JSON file through a temporary file in the same folder, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

const setupPath = (cfg: Config) => path.join(cfg.data_dir, "setup.json");

export function readSetup(cfg: Config): SetupFile {
  const raw = readJsonFile<Partial<SetupFile>>(setupPath(cfg)) ?? {};
  const t = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    v: 1,
    accepted_at: t(raw.accepted_at),
    read_consent_at: t(raw.read_consent_at),
    hooks_installed_at: t(raw.hooks_installed_at),
    missions_consent_at: t(raw.missions_consent_at),
    version: versionOf(cfg),
  };
}

export function updateSetup(cfg: Config, patch: Partial<SetupFile>): SetupFile {
  const next = { ...readSetup(cfg), ...patch, v: 1 as const, version: versionOf(cfg) };
  writeJsonAtomic(setupPath(cfg), next);
  return next;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The memory folders: the folder named, or with "auto" every <claude_home>/projects/<name>/memory folder that holds a MEMORY.md. */
export function memoryDirs(cfg: Config): string[] {
  if (cfg.memory_dir !== "auto") return isDir(cfg.memory_dir) ? [cfg.memory_dir] : [];
  const root = path.join(cfg.claude_home, "projects");
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(root, n, "memory").replace(/\\/g, "/"))
    .filter((d) => fs.existsSync(path.join(d, "MEMORY.md")))
    .sort();
}

export function setupState(cfg: Config, graph?: { built: string; nodes: number; edges: number } | null): SetupState {
  const built = graph === undefined ? readJsonFile<{ built?: string; nodes?: unknown[]; edges?: unknown[] }>(path.join(cfg.data_dir, "graph.json")) : null;
  const g = graph ?? (built?.built ? { built: built.built, nodes: built.nodes?.length ?? 0, edges: built.edges?.length ?? 0 } : null);
  return {
    ...readSetup(cfg),
    product: productOf(cfg),
    claude_home: cfg.claude_home,
    claude_home_found: isDir(cfg.claude_home),
    projects_root: cfg.projects_root,
    memory_dirs: memoryDirs(cfg),
    graph_built: g?.built ?? null,
    counts: g ? { nodes: g.nodes, edges: g.edges } : null,
    demo: cfg.oversight_demo === true,
  };
}

/** Records the folder of projects in the configuration file, keeping every other key. */
export function writeProjectsRoot(cfg: Config, projectsRoot: string | null): void {
  const file = cfg.config_file;
  if (!file) throw new HttpError(500, "The configuration file is not known.");
  const current = readJsonFile<Record<string, unknown>>(file) ?? {};
  current.projects_root = projectsRoot;
  writeJsonAtomic(file, current);
  cfg.projects_root = projectsRoot;
}

export function checkProjectsRoot(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "The projects folder must be a path, or null for none.");
  const p = norm(value.trim());
  if (!isDir(p)) throw new HttpError(400, "The projects folder does not exist. Check the path and try again.");
  return p;
}

// ---------------------------------------------------------------- hooks

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function hookCommand(cfg: Config, verb: "preview" | "install" | "uninstall"): Promise<Record<string, unknown>> {
  const r = await runPython(cfg, ["hooks", verb, "--json"]);
  if (r.code !== 0) throw new HttpError(500, lastLine(r.stderr) || lastLine(r.stdout) || `The hooks ${verb} command failed.`);
  const j = parseJson(r.stdout);
  if (!j) throw new HttpError(500, `The hooks ${verb} command did not return JSON.`);
  return j;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

export async function hooksState(cfg: Config): Promise<HooksState> {
  const j = await hookCommand(cfg, "preview");
  const entries = Array.isArray(j.entries) ? (j.entries as HookEntry[]) : [];
  return {
    installed: j.installed === true,
    settings_path: str(j.settings_path, path.join(cfg.claude_home, "settings.json").replace(/\\/g, "/")),
    entries,
    backup_dir: str(j.backup_dir, path.join(cfg.data_dir, "backups").replace(/\\/g, "/")),
  };
}

export async function installHooks(cfg: Config): Promise<{ installed: true; backup: string | null }> {
  const j = await hookCommand(cfg, "install");
  updateSetup(cfg, { hooks_installed_at: new Date().toISOString() });
  return { installed: true, backup: typeof j.backup === "string" ? j.backup : null };
}

export async function uninstallHooks(cfg: Config): Promise<{ installed: false; removed: number; backup: string | null }> {
  const j = await hookCommand(cfg, "uninstall");
  updateSetup(cfg, { hooks_installed_at: null });
  const removed = typeof j.removed === "number" ? j.removed : Array.isArray(j.removed) ? j.removed.length : 0;
  return { installed: false, removed, backup: typeof j.backup === "string" ? j.backup : null };
}

// ---------------------------------------------------------------- the claude command

export type ClaudeRunner = (args: string[]) => Promise<{ stdout: string; code: number } | null>;

/** Runs the claude command with a clean environment. It returns null when the command is not installed. */
export const defaultClaudeRunner: ClaudeRunner = (args) => {
  const exe = findClaude();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 20000, windowsHide: true, encoding: "utf8", env: cleanEnv() }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ stdout: String(stdout ?? ""), code });
    });
  });
};

/**
 * The state of the person's own Claude Code. Only three fields of `claude auth status` are read: loggedIn,
 * authMethod and subscriptionType. The output is never stored or logged, and nothing else in it is copied.
 */
export async function claudeState(run: ClaudeRunner = defaultClaudeRunner): Promise<ClaudeState> {
  const checked = new Date().toISOString();
  const v = await run(["--version"]);
  if (!v) return { installed: false, version: null, signed_in: false, auth_method: null, plan: null, checked };
  const a = await run(["auth", "status"]);
  let signed = false;
  let method: string | null = null;
  let plan: string | null = null;
  const j = a ? parseJson(a.stdout) : null;
  if (j) {
    signed = j.loggedIn === true;
    method = typeof j.authMethod === "string" ? j.authMethod : null;
    plan = typeof j.subscriptionType === "string" ? j.subscriptionType : null;
  }
  const m = /\d+\.\d+\.\d+\S*/.exec(v.stdout);
  return { installed: true, version: m ? m[0] : v.stdout.trim().slice(0, 40) || null, signed_in: signed, auth_method: method, plan, checked };
}

export interface LoginResult {
  started: boolean;
  terminal: string | null;
  message: string;
}

export type LoginLauncher = (exe: string) => LoginResult;

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detach(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Opens a terminal window that runs `claude auth login`. The output of the command is not read. */
export const defaultLoginLauncher: LoginLauncher = (exe) => {
  const sent = (terminal: string): LoginResult => ({ started: true, terminal, message: "A terminal window has opened. Finish signing in there, then return to this window." });
  if (process.platform === "win32") {
    const wt = onPath("wt");
    if (wt && detach(wt, ["new-tab", "--title", "Claude sign-in", exe, "auth", "login"])) return sent("Windows Terminal");
    if (detach("cmd.exe", ["/c", "start", "Claude sign-in", "cmd.exe", "/k", exe, "auth", "login"])) return sent("Command Prompt");
  } else if (process.platform === "darwin") {
    const quoted = exe.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "Terminal" to do script "\\"${quoted}\\" auth login"`;
    if (detach("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'])) return sent("Terminal");
  } else {
    const options: [string, string[]][] = [
      ["x-terminal-emulator", ["-e", exe, "auth", "login"]],
      ["gnome-terminal", ["--", exe, "auth", "login"]],
      ["konsole", ["-e", exe, "auth", "login"]],
      ["xterm", ["-e", exe, "auth", "login"]],
    ];
    for (const [name, args] of options) {
      const found = onPath(name);
      if (found && detach(found, args)) return sent(name);
    }
  }
  return { started: false, terminal: null, message: "No terminal window could be opened. Open a terminal yourself and run: claude auth login" };
};

// ---------------------------------------------------------------- the access token

const digest = (s: string) => createHash("sha256").update(s).digest();

function sameToken(given: string | undefined, token: string): boolean {
  return typeof given === "string" && timingSafeEqual(digest(given), digest(token));
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** True when no token is set, or the request carries it in the cookie or the x-cortex-token header. */
export function tokenOk(cfg: Config, req: IncomingMessage): boolean {
  if (!cfg.token) return true;
  const header = req.headers["x-cortex-token"];
  return sameToken(Array.isArray(header) ? header[0] : header, cfg.token) || sameToken(cookieValue(req.headers.cookie, "cortex_token"), cfg.token);
}

/** GET /auth?t=<token> sets the cookie and redirects to the app. Returns false when the request is not for /auth. */
export function handleAuth(cfg: Config, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/auth") return false;
  const plain = (status: number, text: string) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  };
  if (!cfg.token) return plain(404, "That page does not exist."), true;
  if (req.method !== "GET") return plain(405, "This route accepts GET only."), true;
  if (!sameToken(url.searchParams.get("t") ?? undefined, cfg.token)) return plain(401, "The access token is not valid."), true;
  res.writeHead(302, {
    "Set-Cookie": `cortex_token=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/`,
    Location: "/?shell=desktop",
    "Cache-Control": "no-store",
  });
  res.end();
  return true;
}

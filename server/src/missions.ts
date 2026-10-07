import { loadConfig } from "./config.ts";
// Missions: each step runs the claude command and its stream is parsed into lines.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Mission, MissionLine, MissionState, Plan, StreamMessage } from "../../shared/types.ts";
import type { Config } from "./config.ts";
import { makeEvent, type EventHub } from "./events.ts";
import { NOT_BUILT, type GraphStore } from "./graph.ts";
import { plan as makePlan } from "./plan.ts";
import { ensureDir, readJsonFile } from "./util.ts";

export const NOT_SIGNED_IN = "The claude command is not signed in. Run claude auth login in a terminal, then start the mission again.";
export const NOT_INSTALLED = "The claude command was not found. Install Claude Code, then start the mission again.";

export const DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "PowerShell(git push:*)",
  "PowerShell(git commit:*)",
  "Bash(gh:*)",
  "PowerShell(gh:*)",
  "Artifact",
  "SendUserFile",
  "mcp__claude-in-chrome__computer",
];

/** The commands a mission may run through Bash or PowerShell: reading, listing, and the type checks and tests. */
export const SHELL_ALLOWED = [
  "git status:*", "git diff:*", "git log:*", "git show:*", "git branch --show-current", "ls:*", "dir:*", "cat:*", "head:*", "tail:*", "wc:*", "grep:*", "rg:*", "pwd",
  "Get-ChildItem:*", "Get-Content:*", "Select-String:*",
  "npx tsc:*", "npx vitest:*", "npx eslint:*", "npm test", "npm run test", "npm run check", "npm run lint",
  "python -m pytest:*", "python -m mypy:*", "python -m ruff check:*",
];
/** The built-in tools a mission falls back to when an agent file has no tools line. */
export const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
const KNOWN_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "PowerShell", "WebFetch", "WebSearch", "NotebookEdit"]);

/** The tools in the tools line of ~/.claude/agents/<name>.md, limited to the built-in tools that a mission may use. */
export function agentTools(claudeHome: string, agent: string): string[] {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) return DEFAULT_TOOLS;
  let text: string;
  try {
    text = fs.readFileSync(path.join(claudeHome, "agents", `${agent}.md`), "utf8");
  } catch {
    return DEFAULT_TOOLS;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = front ? /^tools:\s*(.+)$/m.exec(front[1]) : null;
  if (!line) return DEFAULT_TOOLS;
  const tools = line[1].split(",").map((t) => t.trim()).filter((t) => KNOWN_TOOLS.has(t));
  return tools.length ? tools : DEFAULT_TOOLS;
}

const MAX_LINES = 3000;

// ---------------------------------------------------------------- the claude command

export function findClaude(): string | null {
  const win = process.platform === "win32";
  const name = win ? "claude.exe" : "claude";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  const home = process.env.USERPROFILE ?? os.homedir();
  const fallback = path.join(home, ".local", "bin", name);
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * The environment for a claude child process. When Cortex is started from inside a Claude Code session (for
 * example from the desktop app's preview), it inherits that session's variables: its session ids, a messaging
 * socket, a local API address and its credentials. A mission must be its own session with the claude command's own
 * sign-in, so those variables are removed. Variables set in ~/.claude/settings.json "env" are applied again by the
 * child itself. ANTHROPIC_API_KEY is removed too unless missions_use_api_key is true in cortex.config.json, because
 * a headless run that sees the key may charge it in place of the claude.ai plan the claude command is signed in to
 * (a PowerShell session showed the key set on 6 October 2026).
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env, keepApiKey = loadConfig().missions_use_api_key ?? false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|AI_AGENT|BAGGAGE|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)$/i.test(k)) continue;
    if (!keepApiKey && k.toUpperCase() === "ANTHROPIC_API_KEY") continue;
    env[k] = v;
  }
  return env;
}

function run(exe: string, args: string[], timeout = 20000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, encoding: "utf8", env: cleanEnv() }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout ?? ""), code });
    });
  });
}

export interface ClaudeStatus {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
}

let cached: { at: number; value: ClaudeStatus } | null = null;

export async function claudeStatus(force = false): Promise<ClaudeStatus> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.value;
  const exe = findClaude();
  let value: ClaudeStatus = { installed: false, logged_in: false, version: null };
  if (exe) {
    const [v, a] = await Promise.all([run(exe, ["--version"]), run(exe, ["auth", "status"])]);
    const logged = (() => {
      try {
        return JSON.parse(a.stdout).loggedIn === true;
      } catch {
        return false;
      }
    })();
    const m = /\d+\.\d+\.\d+\S*/.exec(v.stdout);
    value = { installed: true, logged_in: logged, version: m ? m[0] : v.stdout.trim() || null };
  }
  cached = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- the stream parser

export interface ParsedLine {
  lines: MissionLine[];
  files: string[];
  text?: string;
  result?: { cost_usd: number | null; is_error: boolean };
}

function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

function short(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function describeTool(name: string, input: Record<string, unknown>): { text: string; path?: string; writes: boolean } {
  const file = typeof input.file_path === "string" ? fwd(input.file_path) : typeof input.path === "string" ? fwd(input.path) : undefined;
  switch (name) {
    case "Read":
      return { text: `Read ${file ?? ""}`.trim(), path: file, writes: false };
    case "Write":
      return { text: `Wrote ${file ?? ""}`.trim(), path: file, writes: true };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { text: `Edited ${file ?? ""}`.trim(), path: file, writes: true };
    case "Bash":
    case "PowerShell":
      return { text: `Ran ${short(String(input.command ?? ""))}`, writes: false };
    case "Glob":
    case "Grep":
      return { text: `Searched for ${short(String(input.pattern ?? ""))}`, writes: false };
    default:
      return { text: `Used ${name}`, path: file, writes: false };
  }
}

/** Turns one line of the claude stream-json output into mission lines. */
export function parseStreamLine(raw: string, now: () => string = () => new Date().toISOString()): ParsedLine {
  const out: ParsedLine = { lines: [], files: [] };
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return out;
    o = v as Record<string, unknown>;
  } catch {
    return out;
  }
  const ts = now();
  if (o.type === "system" && o.subtype === "init") {
    const model = typeof o.model === "string" ? o.model : "unknown";
    out.lines.push({ ts, kind: "system", text: `Session started on model ${model}` });
  } else if (o.type === "assistant") {
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.lines.push({ ts, kind: "text", text: b.text });
          out.text = b.text;
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const d = describeTool(b.name, (b.input as Record<string, unknown>) ?? {});
          const line: MissionLine = { ts, kind: "tool", text: d.text, tool: b.name };
          if (d.path) line.path = d.path;
          out.lines.push(line);
          if (d.writes && d.path && !out.files.includes(d.path)) out.files.push(d.path);
        }
      }
    }
  } else if (o.type === "result") {
    const isError = o.is_error === true;
    const cost = typeof o.total_cost_usd === "number" ? o.total_cost_usd : typeof o.cost_usd === "number" ? o.cost_usd : null;
    const text = typeof o.result === "string" && o.result ? o.result : isError ? "The step ended with an error." : "The step finished.";
    out.lines.push({ ts, kind: isError ? "error" : "result", text });
    out.result = { cost_usd: cost, is_error: isError };
  }
  return out;
}

// ---------------------------------------------------------------- the context pack

export function contextPack(plan: Plan): string {
  const parts = ["Cortex prepared this context from the knowledge graph."];
  if (plan.load.length) {
    parts.push("Read these files first:");
    for (const l of plan.load) parts.push(`- ${l.path} (${l.reason})`);
  }
  if (plan.gates.length) {
    parts.push("Run these gates before you finish:");
    for (const g of plan.gates) parts.push(`- ${g.command}`);
  }
  if (plan.cautions.length) {
    parts.push("Cautions:");
    for (const c of plan.cautions) parts.push(`- ${c}`);
  }
  return parts.join("\n");
}

export function stepArgs(agent: string, sessionId: string, pack: string, tools: string[] = DEFAULT_TOOLS): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--effort",
    "medium",
    "--permission-mode",
    "acceptEdits",
    "--session-id",
    sessionId,
    "--append-system-prompt",
    pack,
  ];
  if (agent !== "main") args.push("--agent", agent);
  // --tools removes every built-in tool that is not listed. --allowedTools pre-approves the read-only tools and the
  // shell commands above, and a headless run refuses any other shell command. No MCP server is loaded, and the
  // deny list stays as a backstop that keeps the push and publish refusals.
  const allowed = [...tools.filter((t) => t !== "Bash" && t !== "PowerShell")];
  for (const shell of ["Bash", "PowerShell"]) if (tools.includes(shell)) for (const c of SHELL_ALLOWED) allowed.push(`${shell}(${c})`);
  args.push("--tools", tools.join(","), "--allowedTools", ...allowed, "--strict-mcp-config", "--disallowedTools", ...DISALLOWED_TOOLS);
  return args;
}

export function stepPrompt(mission: Mission, i: number, previousText: string): string {
  if (i === 0) return mission.prompt;
  const prev = mission.steps[i - 1];
  const files = prev.files.join(", ") || "none recorded";
  if (mission.steps[i].agent === "checker") {
    return `Check the work of the previous step before it is handed over. Files written: ${files}. Summary: ${previousText.slice(0, 1500)}.`;
  }
  return `${mission.prompt}\n\nThe previous step wrote these files: ${files}. Summary: ${previousText.slice(0, 1500)}.`;
}

// ---------------------------------------------------------------- the manager

function missionId(): string {
  const d = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `m-${d.slice(0, 8)}-${d.slice(8, 14)}-${randomBytes(2).toString("hex")}`;
}

export class MissionManager {
  private cfg: Config;
  private graph: GraphStore;
  private events: EventHub;
  private broadcast: (m: StreamMessage) => void;
  private missions = new Map<string, Mission>();
  private procs = new Map<string, ChildProcess>();
  private stopped = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(cfg: Config, graph: GraphStore, events: EventHub, broadcast: (m: StreamMessage) => void) {
    this.cfg = cfg;
    this.graph = graph;
    this.events = events;
    this.broadcast = broadcast;
  }

  private dir(): string {
    return path.join(this.cfg.data_dir, "missions");
  }

  /** Loads the saved missions and marks any that were running when the server stopped as failed. */
  recover(): void {
    ensureDir(this.dir());
    for (const f of fs.readdirSync(this.dir())) {
      if (!f.endsWith(".json")) continue;
      const m = readJsonFile<Mission>(path.join(this.dir(), f));
      if (!m || typeof m.id !== "string") continue;
      if (m.state === "running" || m.state === "checking") {
        const ts = new Date().toISOString();
        m.state = "failed";
        for (const s of m.steps) if (s.state === "running" || s.state === "checking") s.state = "failed";
        m.lines.push({ ts, kind: "error", text: "The server restarted while this mission was running, so the mission was marked failed." });
        this.persistNow(m);
      }
      this.missions.set(m.id, m);
    }
  }

  runningCount(): number {
    let n = 0;
    for (const m of this.missions.values()) if (m.state === "running" || m.state === "checking") n += 1;
    return n;
  }

  list(): Mission[] {
    return [...this.missions.values()].sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  get(id: string): Mission | undefined {
    return this.missions.get(id);
  }

  start(prompt: string, plan?: Plan): Mission {
    let p = plan;
    if (!p) {
      if (!this.graph.view || !this.graph.index) throw new Error(NOT_BUILT);
      p = makePlan(prompt, this.graph.view, this.graph.index);
    }
    const m: Mission = {
      id: missionId(),
      prompt,
      created: new Date().toISOString(),
      state: "planned",
      plan: p,
      step: 0,
      steps: p.steps.map((s) => ({
        agent: s.agent,
        purpose: s.purpose,
        state: "planned" as MissionState,
        session_id: null,
        started: null,
        ended: null,
        cost_usd: null,
        files: [],
      })),
      lines: [],
    };
    this.missions.set(m.id, m);
    this.persistNow(m);
    this.broadcast({ type: "mission", id: m.id, state: m.state, step: 0 });
    void this.execute(m).catch((e: unknown) => this.fail(m, e instanceof Error ? e.message : String(e)));
    return m;
  }

  stop(id: string): boolean {
    const m = this.missions.get(id);
    if (!m || (m.state !== "running" && m.state !== "checking" && m.state !== "planned")) return false;
    this.stopped.add(id);
    const proc = this.procs.get(id);
    if (proc?.pid) killTree(proc.pid);
    return true;
  }

  // ----- internals

  private line(m: Mission, l: MissionLine): void {
    m.lines.push(l);
    if (m.lines.length > MAX_LINES) m.lines.splice(0, m.lines.length - MAX_LINES);
    this.broadcast({ type: "mission", id: m.id, state: m.state, step: m.step, line: l });
    this.persistLater(m);
  }

  private setState(m: Mission, state: MissionState): void {
    m.state = state;
    this.broadcast({ type: "mission", id: m.id, state, step: m.step });
    this.persistLater(m);
  }

  private fail(m: Mission, text: string): void {
    this.line(m, { ts: new Date().toISOString(), kind: "error", text });
    const s = m.steps[m.step];
    if (s && (s.state === "running" || s.state === "checking" || s.state === "planned")) s.state = "failed";
    this.setState(m, "failed");
    this.persistNow(m);
    this.missionEvent(m, "mission.end", "end", `Mission failed: ${text}`.slice(0, 120));
  }

  private persistLater(m: Mission): void {
    if (this.timers.has(m.id)) return;
    const t = setTimeout(() => {
      this.timers.delete(m.id);
      this.persistNow(m);
    }, 500);
    t.unref();
    this.timers.set(m.id, t);
  }

  private persistNow(m: Mission): void {
    const t = this.timers.get(m.id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(m.id);
    }
    try {
      ensureDir(this.dir());
      const file = path.join(this.dir(), `${m.id}.json`);
      fs.writeFileSync(file + ".tmp", JSON.stringify(m, null, 2), "utf8");
      fs.renameSync(file + ".tmp", file);
    } catch {
      // a failed save is retried on the next batch of lines
    }
  }

  private missionEvent(m: Mission, kind: "mission.start" | "mission.step" | "mission.end", key: string, label: string, agent?: string, meta: Record<string, unknown> = {}): void {
    try {
      const nodes = (m.plan.task_types ?? []).map((t) => t.id);
      if (agent && agent !== "main") nodes.push(`agent:${agent}`);
      this.events.append(makeEvent({ session: `mission:${m.id}`, source: "orchestrator", kind, nodes, weight: 0.7, label: label.slice(0, 120), key: `${m.id}:${key}`, meta: { mission: m.id, ...meta } }));
    } catch {
      // an event that cannot be written does not stop the mission
    }
  }

  private async execute(m: Mission): Promise<void> {
    const status = await claudeStatus(true);
    if (!status.installed) return this.fail(m, NOT_INSTALLED);
    if (!status.logged_in) return this.fail(m, NOT_SIGNED_IN);
    if (this.stopped.has(m.id)) return this.end(m, "stopped");
    this.setState(m, "running");
    this.missionEvent(m, "mission.start", "start", `Mission started: ${short(m.prompt, 80)}`, m.steps[0]?.agent);
    let previousText = "";
    for (let i = 0; i < m.steps.length; i++) {
      if (this.stopped.has(m.id)) return this.end(m, "stopped");
      m.step = i;
      const s = m.steps[i];
      const checking = s.agent === "checker";
      s.state = checking ? "checking" : "running";
      s.started = new Date().toISOString();
      s.session_id = randomUUID();
      this.setState(m, checking ? "checking" : "running");
      this.missionEvent(m, "mission.step", `step${i}`, `Step ${i + 1}: ${s.purpose}`, s.agent, { step: i, agent: s.agent });
      const outcome = await this.runStep(m, i, stepPrompt(m, i, previousText));
      s.ended = new Date().toISOString();
      previousText = outcome.text;
      if (this.stopped.has(m.id)) {
        s.state = "stopped";
        return this.end(m, "stopped");
      }
      if (!outcome.ok) {
        s.state = "failed";
        this.persistNow(m);
        this.setState(m, "failed");
        this.missionEvent(m, "mission.end", "end", "Mission failed", s.agent);
        return;
      }
      s.state = "done";
    }
    this.end(m, "done");
  }

  private end(m: Mission, state: "done" | "stopped"): void {
    if (state === "stopped") {
      this.line(m, { ts: new Date().toISOString(), kind: "system", text: "The mission was stopped." });
      for (const s of m.steps) if (s.state === "running" || s.state === "checking") s.state = "stopped";
    }
    this.setState(m, state);
    this.persistNow(m);
    this.missionEvent(m, "mission.end", "end", state === "done" ? "Mission finished" : "Mission stopped");
  }

  private runStep(m: Mission, i: number, prompt: string): Promise<{ ok: boolean; text: string }> {
    const s = m.steps[i];
    return new Promise((resolve) => {
      const exe = findClaude();
      if (!exe) {
        this.line(m, { ts: new Date().toISOString(), kind: "error", text: NOT_INSTALLED });
        return resolve({ ok: false, text: "" });
      }
      const args = stepArgs(s.agent, s.session_id ?? randomUUID(), contextPack(m.plan), agentTools(this.cfg.claude_home, s.agent));
      const child = spawn(exe, args, { cwd: this.cfg.projects_root ?? os.homedir(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
      this.procs.set(m.id, child);
      const raw = fs.createWriteStream(path.join(this.dir(), `${m.id}.stream.jsonl`), { flags: "a" });
      let buffer = "";
      let errBuffer = "";
      let lastText = "";
      let finished: { ok: boolean } | null = null;
      const handle = (line: string) => {
        if (!line.trim()) return;
        const p = parseStreamLine(line);
        for (const l of p.lines) this.line(m, l);
        for (const f of p.files) if (!s.files.includes(f)) s.files.push(f);
        if (p.text) lastText = p.text;
        if (p.result) {
          s.cost_usd = (s.cost_usd ?? 0) + (p.result.cost_usd ?? 0);
          finished = { ok: !p.result.is_error };
        }
      };
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        raw.write(d);
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        errBuffer += d;
        let nl: number;
        while ((nl = errBuffer.indexOf("\n")) >= 0) {
          const t = errBuffer.slice(0, nl).trim();
          errBuffer = errBuffer.slice(nl + 1);
          if (t) this.line(m, { ts: new Date().toISOString(), kind: "error", text: t });
        }
      });
      child.on("error", (e) => this.line(m, { ts: new Date().toISOString(), kind: "error", text: `The claude command could not start: ${e.message}` }));
      child.on("close", (code) => {
        if (buffer.trim()) handle(buffer);
        if (errBuffer.trim()) this.line(m, { ts: new Date().toISOString(), kind: "error", text: errBuffer.trim() });
        raw.end();
        this.procs.delete(m.id);
        let ok = finished?.ok ?? false;
        if (!finished && !this.stopped.has(m.id)) {
          this.line(m, { ts: new Date().toISOString(), kind: "error", text: `The claude command ended without a result (exit code ${code ?? "unknown"}).` });
          ok = false;
        }
        this.persistNow(m);
        resolve({ ok, text: lastText });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
}

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // the process has already ended
    }
  }
}

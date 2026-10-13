// The HTTP API. Every route in the Server API table of docs/CONTRACTS.md.
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { HealthFile, LexiconConcept, LexiconScheme, Plan, Sensitivity, ServerStatus } from "../../shared/types.ts";
import { DEFAULT_BRAIN_DOMAINS, type BrainDomains } from "../../shared/brain.ts";
import { ontologyDir, productOf, versionOf, type Config } from "./config.ts";
import { makeEvent, type EventHub } from "./events.ts";
import { NOT_BUILT, REBUILD_HINT, parseSensitivity, type GraphStore } from "./graph.ts";
import { claudeStatus, findClaude, type MissionManager } from "./missions.ts";
import { handleOversight } from "./oversight.ts";
import { plan as makePlan } from "./plan.ts";
import { lastLine, runPython } from "./python.ts";
import { registerDays } from "./register.ts";
import { loadSavedQueries } from "./sparql.ts";
import {
  checkProjectsRoot, claudeState, defaultLoginLauncher, hooksState, installHooks, readSetup, setupState, uninstallHooks, updateSetup,
  writeProjectsRoot, type ClaudeRunner, type LoginLauncher,
} from "./setup.ts";
import type { StreamHub } from "./stream.ts";
import { HttpError, isUnder, readJsonBody, readJsonFile, sendJson } from "./util.ts";

export interface Context {
  cfg: Config;
  graph: GraphStore;
  events: EventHub;
  missions: MissionManager;
  stream: StreamHub;
  /** the runner of the claude command, and the launcher of its sign-in window, so that tests can replace them */
  claude?: ClaudeRunner;
  login?: LoginLauncher;
}

/** ServerStatus with the field that shared/types.ts does not hold yet (see the change request for ServerStatus.brain_domains). */
export type StatusWithDomains = ServerStatus & { brain_domains?: BrainDomains; reasoning?: { engine: string | null; facts: number; built: string } };

export async function buildStatus(ctx: Context): Promise<StatusWithDomains> {
  const f = ctx.graph.view?.file;
  const reasoning = ctx.graph.inferred.summary();
  return {
    built: f?.built ?? null,
    nodes: f?.nodes.length ?? 0,
    edges: f?.edges.length ?? 0,
    events_today: ctx.events.countToday(),
    events_today_by_kind: ctx.events.countTodayByKind(),
    claude: await claudeStatus(),
    missions_running: ctx.missions.runningCount(),
    data_dir: ctx.cfg.data_dir,
    product: productOf(ctx.cfg),
    version: versionOf(ctx.cfg),
    brain_domains: ctx.cfg.brain_domains ?? DEFAULT_BRAIN_DOMAINS,
    ...(reasoning ? { reasoning } : {}),
  };
}

function readVocab(dir: string): { id: string; label: string; description: string; concepts: LexiconConcept[] }[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const j = readJsonFile<{ scheme?: { id?: string; label?: string; description?: string }; concepts?: LexiconConcept[] }>(path.join(dir, f));
    if (!j?.scheme?.id) continue;
    out.push({ id: j.scheme.id, label: j.scheme.label ?? j.scheme.id, description: j.scheme.description ?? "", concepts: Array.isArray(j.concepts) ? j.concepts : [] });
  }
  return out;
}

export function readLexicon(cfg: Config): { schemes: LexiconScheme[] } {
  const merged = new Map<string, LexiconScheme>();
  const onto = ontologyDir(cfg);
  const profile = cfg.profile_dir ?? path.join(cfg.data_dir, "profile");
  // The starting vocabulary only seeds a new profile. Once the profile holds its own, the profile alone decides, as in
  // kg/cortex_kg/config.py vocab_files.
  const profileVocab = path.join(profile, "vocab");
  const hasProfileVocab = fs.existsSync(profileVocab) && fs.readdirSync(profileVocab).some((f) => f.endsWith(".json"));
  const first = hasProfileVocab ? profileVocab : path.join(onto, "defaults", "vocab");
  for (const dir of [first, path.join(cfg.data_dir, "overlay", "vocab")]) {
    for (const s of readVocab(dir)) {
      const have = merged.get(s.id);
      if (!have) {
        merged.set(s.id, s);
        continue;
      }
      const byId = new Map(have.concepts.map((c) => [c.id, c]));
      for (const c of s.concepts) byId.set(c.id, c);
      have.concepts = [...byId.values()];
    }
  }
  return { schemes: [...merged.values()] };
}

function parseDate(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "The date must be in ISO 8601 form, for example 2026-10-05T09:00:00Z.");
  return d;
}

function requireGraph(ctx: Context) {
  if (!ctx.graph.view) throw new HttpError(503, NOT_BUILT);
  return ctx.graph.view;
}

function openFile(file: string): void {
  if (process.platform === "win32") spawn("explorer.exe", [file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else if (process.platform === "darwin") spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
}

/** Only these document and image types are opened. A list of banned types always misses a launchable one. */
export const OPEN_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".md", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg"]);

const isStr = (v: unknown): v is string => typeof v === "string";
const isList = (v: unknown): v is unknown[] => Array.isArray(v);

export function checkPlanShape(p: Plan, ctx?: Context): void {
  const bad = (what: string): never => {
    throw new HttpError(400, `The plan is not valid: ${what}.`);
  };
  const o = p as unknown as Record<string, unknown>;
  for (const k of ["task_types", "steps", "load", "gates", "cautions"]) if (!isList(o[k])) bad(`${k} must be a list`);
  for (const t of p.task_types) if (!t || typeof t !== "object" || !isStr((t as { id?: unknown }).id)) bad("each task type needs an id");
  for (const s of p.steps) if (!s || typeof s !== "object" || !isStr(s.agent) || !isStr(s.purpose)) bad("each step needs an agent and a purpose");
  for (const c of p.cautions) if (!isStr(c)) bad("each caution must be text");
  if (!ctx) return;
  // a step names an agent that Cortex knows, so that a caller cannot pass an option to the claude command
  const known = ctx.graph.index?.agents;
  for (const s of p.steps) {
    if (s.agent !== "main" && (!/^[a-z][a-z0-9-]*$/.test(s.agent) || (known && !(s.agent in known)))) bad(`${JSON.stringify(s.agent).slice(0, 40)} is not an agent that Cortex knows`);
  }
  for (const l of p.load) {
    if (!l || !isStr(l.path) || !(ctx.cfg.projects_root && isUnder(l.path, ctx.cfg.projects_root)) && !isUnder(l.path, ctx.cfg.claude_home)) bad("each file to load must be under the projects folder or the Claude home folder");
  }
  for (const g of p.gates) if (!g || !isStr(g.command)) bad("each gate needs a command");
}

function needMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new HttpError(405, `This route accepts ${method} only.`);
}

async function afterBuild(ctx: Context): Promise<void> {
  ctx.graph.reload(true);
}

export async function handleApi(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "");
    const q = url.searchParams;

    if (p === "/api/stream") {
      needMethod(req, "GET");
      await ctx.stream.add(req, res);
      return;
    }
    if (p === "/api/status") {
      needMethod(req, "GET");
      return sendJson(res, 200, await buildStatus(ctx));
    }
    if (p === "/api/setup") {
      needMethod(req, "GET");
      return sendJson(res, 200, setupState(ctx.cfg));
    }
    if (p === "/api/setup/accept") {
      needMethod(req, "POST");
      updateSetup(ctx.cfg, { accepted_at: new Date().toISOString() });
      return sendJson(res, 200, setupState(ctx.cfg));
    }
    if (p === "/api/setup/missions-consent") {
      needMethod(req, "POST");
      updateSetup(ctx.cfg, { missions_consent_at: new Date().toISOString() });
      return sendJson(res, 200, setupState(ctx.cfg));
    }
    if (p === "/api/setup/read") {
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      const root = "projects_root" in body ? checkProjectsRoot(body.projects_root) : undefined;
      updateSetup(ctx.cfg, { read_consent_at: new Date().toISOString() });
      if (root !== undefined) writeProjectsRoot(ctx.cfg, root);
      const b = await runPython(ctx.cfg, ["build"]);
      if (b.code !== 0) throw new HttpError(500, lastLine(b.stderr) || lastLine(b.stdout) || "The build failed.");
      const r = await runPython(ctx.cfg, ["reason"]);
      await afterBuild(ctx);
      if (r.code !== 0) throw new HttpError(500, lastLine(r.stderr) || lastLine(r.stdout) || "The graph was built but the reasoning failed.");
      return sendJson(res, 200, setupState(ctx.cfg));
    }
    if (p === "/api/hooks") {
      needMethod(req, "GET");
      return sendJson(res, 200, await hooksState(ctx.cfg));
    }
    if (p === "/api/hooks/install") {
      needMethod(req, "POST");
      return sendJson(res, 200, await installHooks(ctx.cfg));
    }
    if (p === "/api/hooks/uninstall") {
      needMethod(req, "POST");
      return sendJson(res, 200, await uninstallHooks(ctx.cfg));
    }
    if (p === "/api/claude") {
      needMethod(req, "GET");
      return sendJson(res, 200, await claudeState(ctx.claude));
    }
    if (p === "/api/claude/login") {
      needMethod(req, "POST");
      const exe = findClaude();
      if (!exe && !ctx.login) throw new HttpError(409, "The claude command is not installed. Install Claude Code, then try again.");
      return sendJson(res, 200, (ctx.login ?? defaultLoginLauncher)(exe ?? "claude"));
    }
    if (p.startsWith("/api/oversight/")) {
      return sendJson(res, 200, await handleOversight(ctx, req, p, q));
    }
    if (p === "/api/graph") {
      needMethod(req, "GET");
      requireGraph(ctx);
      const max = parseSensitivity(q.get("max"));
      return sendJson(res, 200, ctx.graph.getGraph(max as Sensitivity));
    }
    if (p.startsWith("/api/node/")) {
      needMethod(req, "GET");
      requireGraph(ctx);
      let id: string;
      try {
        id = decodeURIComponent(p.slice("/api/node/".length));
      } catch {
        throw new HttpError(400, "The node id is not valid.");
      }
      const found = ctx.graph.getNode(id);
      if (!found) throw new HttpError(404, `There is no node with the id ${id}.`);
      return sendJson(res, 200, { ...found, events: ctx.events.forNode(id, 50) });
    }
    if (p === "/api/health") {
      needMethod(req, "GET");
      const h = readJsonFile<HealthFile>(path.join(ctx.cfg.data_dir, "health.json"));
      if (!h) throw new HttpError(503, `The health report has not been written. ${REBUILD_HINT}`);
      // health.json describes the graph it checked, so a different build time means it is out of date
      const held = ctx.graph.built;
      const stale = Boolean(held && h.graph_built && h.graph_built !== held);
      return sendJson(res, 200, stale ? { ...h, stale: true } : h);
    }
    if (p === "/api/lexicon") {
      needMethod(req, "GET");
      return sendJson(res, 200, readLexicon(ctx.cfg));
    }
    if (p === "/api/lexicon/check") {
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      if (typeof body.text !== "string") throw new HttpError(400, "The body must hold a text field.");
      const r = await runPython(ctx.cfg, ["lexicon-check"], body.text);
      if (r.code !== 0) throw new HttpError(500, lastLine(r.stderr) || "The lexicon check failed.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new HttpError(500, "The lexicon check did not return JSON.");
      }
      return sendJson(res, 200, Array.isArray(parsed) ? { hits: parsed } : parsed);
    }
    if (p === "/api/lexicon/ratify") {
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      const concept = body.concept;
      if (typeof concept !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(concept)) throw new HttpError(400, "The body must hold a concept id such as term:example.");
      const r = await runPython(ctx.cfg, ["ratify", concept]);
      if (r.code !== 0) throw new HttpError(500, lastLine(r.stderr) || lastLine(r.stdout) || "The ratification failed.");
      const b = await runPython(ctx.cfg, ["build"]);
      if (b.code !== 0) throw new HttpError(500, lastLine(b.stderr) || "The concept was ratified but the rebuild failed.");
      await afterBuild(ctx);
      return sendJson(res, 200, { ok: true, concept, stats: ctx.graph.view?.file.stats ?? null });
    }
    if (p === "/api/activity") {
      needMethod(req, "GET");
      const since = parseDate(q.get("since"));
      const until = parseDate(q.get("until"));
      if (q.get("with_activation") === "1") return sendJson(res, 200, { items: ctx.events.withActivation(since, until, 2000) });
      return sendJson(res, 200, { events: ctx.events.recent(since, until, 500) });
    }
    if (p === "/api/register") {
      needMethod(req, "GET");
      return sendJson(res, 200, registerDays(ctx.cfg, Number(q.get("days") ?? 30)));
    }
    if (p === "/api/sparql") {
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      if (typeof body.query !== "string") throw new HttpError(400, "The body must hold a query field.");
      return sendJson(res, 200, await ctx.graph.sparql.query(body.query));
    }
    if (p === "/api/queries") {
      needMethod(req, "GET");
      return sendJson(res, 200, { queries: loadSavedQueries(path.join(ontologyDir(ctx.cfg), "queries")) });
    }
    if (p === "/api/inferred") {
      needMethod(req, "GET");
      return sendJson(res, 200, ctx.graph.inferred.query(q.get("node") || null, q.get("kind") || null));
    }
    if (p === "/api/open") {
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "The body must hold a path field.");
      const file = path.resolve(body.path);
      let real = file;
      try {
        real = fs.realpathSync(file);
      } catch {
        throw new HttpError(404, "That file does not exist.");
      }
      if (![ctx.cfg.projects_root, ctx.cfg.claude_home].some((r) => r && isUnder(real, r))) {
        throw new HttpError(403, "Only files under the projects folder or the Claude home folder can be opened.");
      }
      if (!OPEN_EXT.has(path.extname(real).toLowerCase())) throw new HttpError(403, "Only documents, text files and images can be opened from Cortex.");
      openFile(real);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/compile") {
      needMethod(req, "POST");
      const b = await runPython(ctx.cfg, ["build"]);
      if (b.code !== 0) throw new HttpError(500, lastLine(b.stderr) || lastLine(b.stdout) || "The build failed.");
      const c = await runPython(ctx.cfg, ["check"]);
      await afterBuild(ctx);
      try {
        ctx.events.append(makeEvent({ session: "cortex", source: "cortex", kind: "compile", nodes: [], weight: 0.3, label: "Graph rebuilt", key: `compile:${Date.now()}` }));
      } catch {
        // the rebuild stands even if the event cannot be written
      }
      const v = ctx.graph.view?.file;
      return sendJson(res, 200, { ok: c.code === 0, built: v?.built ?? null, stats: v?.stats ?? null, health: v?.health ?? null, check: c.code === 0 ? null : lastLine(c.stderr) || lastLine(c.stdout) });
    }
    if (p === "/api/plan") {
      needMethod(req, "POST");
      const view = requireGraph(ctx);
      const body = await readJsonBody(req);
      if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "The body must hold a prompt.");
      if (!ctx.graph.index) throw new HttpError(503, NOT_BUILT);
      return sendJson(res, 200, makePlan(body.prompt, view, ctx.graph.index));
    }
    if (p === "/api/missions") {
      if (req.method === "GET") {
        return sendJson(res, 200, { missions: ctx.missions.list().map((m) => ({ ...m, lines: m.lines.slice(-20) })) });
      }
      needMethod(req, "POST");
      const body = await readJsonBody(req);
      if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "The body must hold a prompt.");
      if (body.prompt.length > 20000) throw new HttpError(400, "The prompt is longer than 20,000 characters.");
      // a mission runs the person's own Claude Code, so it needs their agreement and a signed-in command, and these come before any check of the graph
      if (!readSetup(ctx.cfg).missions_consent_at) throw new HttpError(403, "Missions are switched off until you agree to them in the set-up window.");
      if (!(await claudeState(ctx.claude)).signed_in) throw new HttpError(403, "Claude Code is not signed in. Sign in from the set-up window, then start the mission again.");
      const given = body.plan && typeof body.plan === "object" ? (body.plan as Plan) : undefined;
      if (given) checkPlanShape(given, ctx);
      if (!given) requireGraph(ctx);
      const m = ctx.missions.start(body.prompt, given);
      return sendJson(res, 200, { id: m.id });
    }
    const one = /^\/api\/missions\/([^/]+)(\/stop)?$/.exec(p);
    if (one) {
      let mid: string;
      try {
        mid = decodeURIComponent(one[1]);
      } catch {
        throw new HttpError(400, "The mission id is not valid.");
      }
      const m = ctx.missions.get(mid);
      if (!m) throw new HttpError(404, "There is no mission with that id.");
      if (one[2]) {
        needMethod(req, "POST");
        if (!ctx.missions.stop(m.id)) throw new HttpError(409, "The mission is not running.");
        return sendJson(res, 200, { ok: true });
      }
      needMethod(req, "GET");
      return sendJson(res, 200, m);
    }
    throw new HttpError(404, "There is no such route.");
  } catch (e) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    return sendJson(res, 500, { error: e instanceof Error && e.message ? e.message : "The server could not complete the request." });
  }
}

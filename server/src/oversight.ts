// The oversight routes of docs/CONTRACTS.md, "Oversight routes". A read calls the matching compiler command. A write checks the
// role rules of "Identity and roles", calls the command with the actor of the configuration, then runs build and check and returns
// the updated object. The actor never comes from the body of a request.
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  InstructionDetail,
  InstructionSummary,
  MappingRecord,
  OversightRole,
  OversightStatus,
  PackResult,
  PeopleFile,
  SampleRecord,
} from "../../shared/types.ts";
import type { Context } from "./api.ts";
import type { Config } from "./config.ts";
import { lastLine, runPython } from "./python.ts";
import { HttpError, readJsonBody, readJsonFile } from "./util.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCOPE = /^(alert|run|agent|period):[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const STATUSES = ["proposed", "ratified", "rejected", "superseded"];
const OUTCOMES = ["close", "escalate", "request-information"];
const MAX_TEXT = 200_000;

/** The actions that the people file governs: the role each needs, and what the sentences call them. */
interface Rule {
  role: OversightRole;
  /** the person must differ from the maker of the record */
  differ: string | null;
  doing: string;
}
const RULES = {
  draft: { role: "maker", differ: null, doing: "drafting an instruction" },
  ratify: { role: "checker", differ: "The maker of a mapping may not ratify it.", doing: "ratifying a mapping" },
  reject: { role: "checker", differ: "The maker of a mapping may not reject it.", doing: "rejecting a mapping" },
  reassign: { role: "checker", differ: null, doing: "reassigning a mapping" },
  approve: { role: "approver", differ: "The maker of an instruction version may not approve it.", doing: "approving an instruction version" },
  draw: { role: "reviewer", differ: null, doing: "drawing a sample" },
  verdict: { role: "reviewer", differ: null, doing: "recording a verdict on a sample" },
} satisfies Record<string, Rule>;
type Action = keyof typeof RULES;

export function readPeople(cfg: Config): PeopleFile | null {
  if (!cfg.oversight_people) return null;
  const f = readJsonFile<PeopleFile>(cfg.oversight_people);
  return f && f.v === 1 && Array.isArray(f.people) ? f : null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** The person who acts. Only where oversight_demo is true may the header x-ranviera-actor select a person of the people file. */
export function actorOf(cfg: Config, req: IncomingMessage, people: PeopleFile | null): string | null {
  const header = req.headers["x-ranviera-actor"];
  const asked = typeof header === "string" ? header.trim() : "";
  if (cfg.oversight_demo && asked && people?.people.some((p) => same(p.id, asked))) return asked;
  return cfg.oversight_actor ? cfg.oversight_actor.trim() : null;
}

/** Checks the role rules and returns the id of the person as the people file holds it. Python checks again. */
function allow(ctx: Context, req: IncomingMessage, action: Action, maker?: string | null): string {
  const rule: Rule = RULES[action];
  const people = readPeople(ctx.cfg);
  if (!ctx.cfg.oversight_people || !people) throw new HttpError(403, "No people file is configured, so no write is allowed.");
  const asked = req.headers["x-ranviera-actor"];
  // in demonstration mode an unknown name in the header is refused and never falls back to the configured person
  if (ctx.cfg.oversight_demo && typeof asked === "string" && asked.trim() && !people.people.some((p) => same(p.id, asked))) {
    throw new HttpError(403, `${asked.trim().slice(0, 60)} is not in the people file, so ${rule.doing} is refused.`);
  }
  const actor = actorOf(ctx.cfg, req, people);
  if (!actor) throw new HttpError(403, "No person is set as the actor of this installation, so no write is allowed.");
  const who = people.people.find((p) => same(p.id, actor));
  if (!who) throw new HttpError(403, `${actor} is not in the people file, so ${rule.doing} is refused.`);
  if (!who.roles.includes(rule.role)) throw new HttpError(403, `${who.name} does not hold the role ${rule.role}, which ${rule.doing} needs.`);
  if (rule.differ && maker && same(who.id, maker)) throw new HttpError(403, rule.differ);
  return who.id;
}

/** The text of a refusal that Python printed, as JSON on stdout or as the last line of stderr. */
function failure(out: { stdout: string; stderr: string }, fallback: string): string {
  try {
    const j = JSON.parse(out.stdout) as { error?: unknown };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    // the output was not JSON
  }
  return lastLine(out.stderr) || lastLine(out.stdout) || fallback;
}

/** `tolerate1` accepts exit code 1, which a view command returns when its report holds findings, as long as the output is the report. */
async function py<T>(ctx: Context, args: string[], what: string, tolerate1 = false): Promise<T> {
  const r = await runPython(ctx.cfg, args);
  const report = tolerate1 && r.code === 1 && !/^\s*\{\s*"error"/.test(r.stdout);
  if (r.code !== 0 && !report) {
    const msg = failure(r, `${what} failed.`);
    if (r.code === 2) throw new HttpError(/^No .+ match|not found|^There is no/i.test(msg) ? 404 : 400, msg);
    throw new HttpError(500, msg);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new HttpError(500, `${what} did not return JSON.`);
  }
}

/** Build and check, as /api/compile does, so that the graph holds the change. */
async function rebuild(ctx: Context): Promise<void> {
  const b = await runPython(ctx.cfg, ["build"]);
  if (b.code !== 0) throw new HttpError(500, `The change was saved but the rebuild failed. ${failure(b, "The build failed.")}`);
  await runPython(ctx.cfg, ["check"]);
  ctx.graph.reload(true);
}

function idPart(raw: string, what: string): string {
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, `The ${what} is not valid.`);
  }
  if (!ID.test(v) || v.length > 200) throw new HttpError(400, `The ${what} is not valid.`);
  return v;
}

function optId(v: string | null, what: string): string | null {
  if (v === null || v === "") return null;
  if (!ID.test(v) || v.length > 200) throw new HttpError(400, `The ${what} is not valid.`);
  return v;
}

function needMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new HttpError(405, `This route accepts ${method} only.`);
}

const hasFile = (dir: string, ext: string): boolean => {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(ext));
  } catch {
    return false;
  }
};

/** True when the data folder holds a run, a mapping or an instruction store. */
export function oversightAvailable(cfg: Config): boolean {
  const profile = cfg.profile_dir ?? path.join(cfg.data_dir, "profile");
  return hasFile(path.join(cfg.data_dir, "runs"), ".json") || hasFile(path.join(profile, "mappings"), ".json") || hasFile(path.join(profile, "instructions"), ".json");
}

export function oversightStatus(ctx: Context, req: IncomingMessage): OversightStatus {
  const people = readPeople(ctx.cfg);
  return { available: oversightAvailable(ctx.cfg), actor: actorOf(ctx.cfg, req, people), demo: Boolean(ctx.cfg.oversight_demo), people: people?.people ?? [] };
}

async function listMappings(ctx: Context, extra: string[] = []): Promise<MappingRecord[]> {
  return py<MappingRecord[]>(ctx, ["mappings", "list", "--json", ...extra], "The mapping list");
}

async function oneMapping(ctx: Context, id: string): Promise<MappingRecord> {
  const found = (await listMappings(ctx)).find((m) => m.id === id);
  if (!found) throw new HttpError(404, `There is no mapping with the id ${id}.`);
  return found;
}

const detail = (ctx: Context, id: string) => py<InstructionDetail>(ctx, ["oversight", "instruction", id, "--json"], "The instruction view");

const optionalText = (v: unknown, what: string, max = 2000): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `The ${what} must be text.`);
  if (v.length > max) throw new HttpError(400, `The ${what} is longer than ${max} characters.`);
  return v;
};

/** Handles one /api/oversight route and returns the JSON body. HttpError carries the status. */
export async function handleOversight(ctx: Context, req: IncomingMessage, p: string, q: URLSearchParams): Promise<unknown> {
  const rest = p.slice("/api/oversight".length);

  if (rest === "/status") {
    needMethod(req, "GET");
    return oversightStatus(ctx, req);
  }
  if (rest === "/runs") {
    needMethod(req, "GET");
    const args = ["oversight", "runs", "--json"];
    const agent = optId(q.get("agent"), "agent id");
    if (agent) args.push(`--agent=${agent}`);
    const outcome = q.get("outcome");
    if (outcome) {
      if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `The outcome must be one of ${OUTCOMES.join(", ")}.`);
      args.push(`--outcome=${outcome}`);
    }
    return py(ctx, args, "The run list");
  }
  const trace = /^\/trace\/([^/]+)$/.exec(rest);
  if (trace) {
    needMethod(req, "GET");
    return py(ctx, ["oversight", "trace", idPart(trace[1], "run id"), "--json"], "The decision trace", true);
  }
  if (rest === "/coverage") {
    needMethod(req, "GET");
    const agent = optId(q.get("agent"), "agent id");
    return py(ctx, ["oversight", "coverage", "--json", ...(agent ? [`--agent=${agent}`] : [])], "The coverage matrix", true);
  }
  if (rest === "/mappings") {
    needMethod(req, "GET");
    const extra: string[] = [];
    const status = q.get("status");
    if (status) {
      if (!STATUSES.includes(status)) throw new HttpError(400, `The status must be one of ${STATUSES.join(", ")}.`);
      extra.push(`--status=${status}`);
    }
    const owner = optionalText(q.get("owner"), "owner", 200);
    if (owner) extra.push(`--owner=${owner}`);
    if (q.get("stale") === "1") extra.push("--stale");
    return listMappings(ctx, extra);
  }
  const mapAct = /^\/mappings\/([^/]+)\/(ratify|reject|reassign)$/.exec(rest);
  if (mapAct) {
    needMethod(req, "POST");
    const id = idPart(mapAct[1], "mapping id");
    const action = mapAct[2] as "ratify" | "reject" | "reassign";
    const mapping = await oneMapping(ctx, id);
    const actor = allow(ctx, req, action, mapping.maker);
    const body = await readJsonBody(req);
    const args = ["mappings", action, id, `--by=${actor}`, "--json"];
    if (action === "ratify") {
      const note = optionalText(body.note, "note");
      if (note) args.push(`--note=${note}`);
    } else if (action === "reject") {
      const reason = optionalText(body.reason, "reason");
      if (!reason || !reason.trim()) throw new HttpError(400, "A rejection needs a reason.");
      args.push(`--reason=${reason}`);
    } else {
      const owner = optionalText(body.owner, "owner", 200);
      if (!owner || !owner.trim()) throw new HttpError(400, "A reassignment needs the new owner.");
      args.push(`--owner=${owner}`);
    }
    await py(ctx, args, `The ${action} command`);
    await rebuild(ctx);
    return oneMapping(ctx, id);
  }
  if (rest === "/instructions") {
    needMethod(req, "GET");
    const agent = optId(q.get("agent"), "agent id");
    return py<InstructionSummary[]>(ctx, ["oversight", "instructions", "--json", ...(agent ? [`--agent=${agent}`] : [])], "The instruction list");
  }
  const instr = /^\/instructions\/([^/]+)(\/draft)?$/.exec(rest);
  if (instr) {
    const id = idPart(instr[1], "instruction id");
    if (!instr[2]) {
      needMethod(req, "GET");
      return detail(ctx, id);
    }
    needMethod(req, "POST");
    const actor = allow(ctx, req, "draft");
    const body = await readJsonBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "The body must hold the text of the draft.");
    if (body.text.length > MAX_TEXT) throw new HttpError(400, `The text is longer than ${MAX_TEXT} characters.`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ranviera-draft-"));
    try {
      const file = path.join(dir, "draft.md");
      fs.writeFileSync(file, body.text, "utf8");
      await py(ctx, ["instructions", "draft", id, `--text-file=${file}`, `--by=${actor}`, "--json"], "The draft command");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await rebuild(ctx);
    return detail(ctx, id);
  }
  const approve = /^\/versions\/([^/]+)\/approve$/.exec(rest);
  if (approve) {
    needMethod(req, "POST");
    const vid = idPart(approve[1], "version id");
    const iid = /^(.+)-v\d+$/.exec(vid)?.[1];
    if (!iid) throw new HttpError(400, "The version id must end in -v and a number.");
    const before = await detail(ctx, iid);
    const v = before.versions.find((x) => x.id === vid);
    if (!v) throw new HttpError(404, `There is no instruction version with the id ${vid}.`);
    const actor = allow(ctx, req, "approve", v.maker);
    await py(ctx, ["instructions", "approve", vid, `--by=${actor}`, "--json"], "The approval command");
    await rebuild(ctx);
    return detail(ctx, iid);
  }
  if (rest === "/monitoring") {
    needMethod(req, "GET");
    const args = ["monitor", "--json"];
    const agent = optId(q.get("agent"), "agent id");
    if (agent) args.push(`--agent=${agent}`);
    for (const [k, flag] of [["from", "--from"], ["to", "--to"]] as const) {
      const v = q.get(k);
      if (!v) continue;
      if (!DATE.test(v)) throw new HttpError(400, `The ${k} date must be written YYYY-MM-DD.`);
      args.push(`${flag}=${v}`);
    }
    return py(ctx, args, "The monitoring report", true);
  }
  if (rest === "/samples") {
    needMethod(req, "POST");
    const actor = allow(ctx, req, "draw");
    const body = await readJsonBody(req);
    const agent = typeof body.agent === "string" && ID.test(body.agent) ? body.agent : null;
    if (!agent) throw new HttpError(400, "The body must hold the id of an agent.");
    const size = body.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 1000) throw new HttpError(400, "The sample size must be a whole number from 1 to 1,000.");
    const args = ["sample", "draw", `--agent=${agent}`, `--size=${size}`, `--by=${actor}`, "--json"];
    if (body.seed !== undefined && body.seed !== null) {
      if (typeof body.seed !== "number" || !Number.isInteger(body.seed)) throw new HttpError(400, "The seed must be a whole number.");
      args.push(`--seed=${body.seed}`);
    }
    if (body.risk_weighted === true) args.push("--risk-weighted");
    return py<SampleRecord>(ctx, args, "The sample draw");
  }
  const verdict = /^\/samples\/([^/]+)\/verdict$/.exec(rest);
  if (verdict) {
    needMethod(req, "POST");
    const sid = idPart(verdict[1], "sample id");
    const actor = allow(ctx, req, "verdict");
    const body = await readJsonBody(req);
    const run = typeof body.run === "string" && ID.test(body.run) ? body.run : null;
    if (!run) throw new HttpError(400, "The body must hold the id of a run.");
    if (body.verdict !== "agree" && body.verdict !== "disagree") throw new HttpError(400, "The verdict must be agree or disagree.");
    const reason = optionalText(body.reason, "reason");
    const args = ["sample", "verdict", sid, run, `--verdict=${body.verdict}`, `--by=${actor}`, "--json"];
    if (reason) args.push(`--reason=${reason}`);
    return py<SampleRecord>(ctx, args, "The verdict");
  }
  if (rest === "/pack-file") {
    needMethod(req, "GET");
    const folder = q.get("folder") ?? "";
    const file = q.get("file") ?? "";
    if (!/^pack-[A-Za-z0-9._-]{1,150}$/.test(folder) || folder.includes("..")) throw new HttpError(400, "The pack folder name is not valid.");
    if (!["pack.html", "pack.json", "manifest.json"].includes(file)) throw new HttpError(400, "The file must be pack.html, pack.json or manifest.json.");
    let text: string;
    try {
      text = fs.readFileSync(path.join(ctx.cfg.data_dir, "packs", folder, file), "utf8");
    } catch {
      throw new HttpError(404, `There is no ${file} in the pack ${folder}.`);
    }
    return { file, text };
  }
  if (rest === "/pack") {
    needMethod(req, "POST");
    const body = await readJsonBody(req);
    if (typeof body.scope !== "string" || !SCOPE.test(body.scope) || body.scope.length > 200) {
      throw new HttpError(400, "The scope must be alert:ID, run:ID, agent:ID or period:FROM..TO.");
    }
    return py<PackResult>(ctx, ["pack", "export", `--scope=${body.scope}`, "--json"], "The evidence pack export", true);
  }
  throw new HttpError(404, "There is no such route.");
}

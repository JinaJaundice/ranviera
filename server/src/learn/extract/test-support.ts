// Helpers for the tests of the extraction pipeline. A scripted model stands in for every provider, and every file
// goes to a temporary folder. No test calls a network model or writes to the real data folder.
import fs from "node:fs";
import type { AssistantMessage, Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach } from "vitest";
import type { LearnSettings, ProviderClass } from "../../../../shared/learn/models.ts";
import type { SourceRoot } from "../../../../shared/learn/sources.ts";
import { createKnowledge, type Knowledge } from "../knowledge/index.ts";
import type { LearnError } from "../models/errors.ts";
import { createSources, type SourcesService } from "../sources/index.ts";
import { tmpDir, write } from "../sources/testkit.ts";
import type { ExtractModels } from "./engines.ts";
import { ExtractService, type ExtractFire, type SessionSource } from "./pipeline.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgentEngine } from "./submit-agent.ts";

export { write };

const made: string[] = [];

/** Removes the temporary folders after each test. Call once at the top of a test file. */
export function cleanupEnvs(): void {
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
}

export interface Call {
  role: "extractor" | "auditor";
  /** the first user message */
  user: string;
  system: string;
  /** the number of the call among all calls, from 1 */
  n: number;
  /** the number of model turns already taken in this run, from 0 */
  turn: number;
  signal?: AbortSignal;
  /** the text of the newest tool result in the conversation, or an empty string */
  result: string;
}

export type Reply = { tool: string; args: unknown } | { text: string };
export type Handler = (call: Call) => Reply | Promise<Reply>;

const userText = (context: TranscriptContext): string => {
  const first = context.messages.find((m) => m.role === "user");
  if (!first) return "";
  const c = first.content;
  return typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "")).join("");
};

const lastResult = (context: TranscriptContext): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role === "toolResult") return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  return "";
};

/** An engine whose model answers from the handler. The calls are recorded. */
export function scriptedEngine(handler: Handler): { engine: AgentEngine; calls: Call[] } {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", reasoning: false }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: Call[] = [];
  const factory = async (context: TranscriptContext, options?: { signal?: AbortSignal }): Promise<AssistantMessage> => {
    const lead = context.messages.find((m) => m.role === "system");
    const names = lead && lead.role === "system" ? (lead.toolsAdded ?? []).map((t) => t.name) : [];
    const call: Call = {
      role: names.includes("submit_findings") ? "extractor" : "auditor",
      user: userText(context),
      system: lead && lead.role === "system" ? (typeof lead.content === "string" ? lead.content : lead.content.map((b) => b.text).join("")) : "",
      n: calls.length + 1,
      turn: context.messages.filter((m) => m.role === "assistant").length,
      signal: options?.signal,
      result: lastResult(context),
    };
    calls.push(call);
    const reply = await handler(call);
    return "tool" in reply ? fauxAssistantMessage(fauxToolCall(reply.tool, reply.args as never)) : fauxAssistantMessage(fauxText(reply.text));
  };
  faux.setResponses(Array.from({ length: 4000 }, () => factory as never));
  const engine: AgentEngine = {
    model: faux.getModel() as Model<Api>,
    stream: (m, context, options) => models.streamSimple(m, context, options),
  };
  return { engine, calls };
}

/** Resolves when the signal aborts, so a scripted model can hang until a run is stopped. */
export function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const extractorReply = (propositions: unknown[], chains: unknown[] = []): Reply => ({ tool: "submit_findings", args: { propositions, chains } });
export const auditorReply = (links: { id: string; linkTo: string }[] = []): Reply => ({ tool: "submit_review", args: { links } });

/** The candidates the auditor was shown in its first message: the last line of the message is a JSON object. */
export function shownCandidates(call: Call): { candidates: Record<string, { name: string; statement: string }>; findings: { id: string; candidates: string[] }[] } {
  const line = call.user.trim().split("\n").pop() as string;
  return JSON.parse(line);
}

/** An auditor that links each proposition to the first candidate with the same name. */
export const linkFirst = (call: Call): Reply => {
  const shown = shownCandidates(call);
  const mine = JSON.parse(call.user.split(/\r?\n/).find((l) => l.startsWith('{"propositions"')) as string) as { propositions: { id: string; name: string }[] };
  const links: { id: string; linkTo: string }[] = [];
  for (const f of shown.findings) {
    const name = mine.propositions.find((p) => p.id === f.id)?.name;
    const hit = f.candidates.find((c) => shown.candidates[c].name === name);
    if (hit) links.push({ id: f.id, linkTo: hit });
  }
  return auditorReply(links);
};

export interface EnvOptions {
  handler: Handler;
  graph?: LearnSettings["graph"];
  cls?: ProviderClass;
  preflight?: LearnError | null;
  semaphore?: Semaphore;
  fileLimit?: number;
  sensitivity?: SourceRoot["sensitivity"];
  kind?: "notes" | "claude-transcripts";
}

export interface Env {
  dir: string;
  learnDir: string;
  notes: string;
  claudeHome: string;
  sources: SourcesService;
  knowledge: Knowledge;
  svc: ExtractService;
  calls: Call[];
  events: string[];
  fires: ExtractFire[];
  root: SourceRoot;
  models: ExtractModels;
  sessionSource: { current: SessionSource | null };
}

/** A learning folder with one linked root, a knowledge service, a sources service and the pipeline over a scripted model. */
export function setupEnv(o: EnvOptions): Env {
  const dir = tmpDir("cortex-extract-");
  made.push(dir);
  const learnDir = `${dir}/data/learn`;
  const claudeHome = `${dir}/claude`;
  const notes = o.kind === "claude-transcripts" ? `${claudeHome}/projects/proj` : `${dir}/notes`;
  fs.mkdirSync(notes, { recursive: true });
  const events: string[] = [];
  const fires: ExtractFire[] = [];
  const running = { svc: null as ExtractService | null };
  const registered = (): boolean => running.svc?.registered() ?? false;
  const sources = createSources({ learnDir, dataDir: `${dir}/data`, claudeHome, projectsRoot: null, extractionRunning: registered, deleteKnowledge: () => undefined });
  const knowledge = createKnowledge({ learnDir, pid: 4242, host: "test-host", isAlive: () => false, extractionRegistered: registered });
  const { engine, calls } = scriptedEngine(o.handler);
  const models: ExtractModels = {
    settings: () => ({ version: 1, ...(o.graph ? { graph: o.graph } : {}) }),
    preflight: async () => o.preflight ?? null,
    engine: () => ({ engine, ref: { provider: "faux", id: "m1" } }),
    providerClassOf: () => o.cls ?? "claude-code",
    price: () => undefined,
  };
  const svc = new ExtractService({
    knowledge,
    sources,
    models,
    emit: (event, extra) => void events.push(extra?.revision !== undefined ? `${event}` : event),
    fire: (e) => void fires.push(e),
    semaphore: o.semaphore ?? new Semaphore(3),
    fileLimit: o.fileLimit,
  });
  running.svc = svc;
  const root = sources.add({ kind: o.kind ?? "notes", path: notes, label: "Notes", sensitivity: o.sensitivity ?? "internal" } as never);
  const sessionSource: Env["sessionSource"] = { current: null };
  return { dir, learnDir, notes, claudeHome, sources, knowledge, svc, calls, events, fires, root, models, sessionSource };
}

/** Scans the root and returns the source id of a path. */
export async function scanned(env: Env, rel: string): Promise<string> {
  await env.sources.scan(env.root.id);
  const f = env.sources.files(env.root.id).find((r) => r.path === rel);
  if (!f) throw new Error(`No file record for ${rel}.`);
  return f.sourceId;
}

export const lines = (file: string): unknown[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

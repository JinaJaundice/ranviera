// Helpers for the tests of the jobs phase: a scripted model, fake turns and wake, a real session store in a temporary
// folder, and a local web server. No test calls a network model, a real provider or the internet.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage, type Api, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LearnStreamMessage, NativeMessage } from "../../../../shared/learn/index.ts";
import { Semaphore } from "../extract/semaphore.ts";
import { createSessionStore, type SessionStore } from "../runtime/store.ts";
import type { Steer } from "../runtime/steering.ts";
import { createJobs, type JobsService } from "./service.ts";
import type { JobEngine, JobKeys, JobModels, JobsDeps, WakeFn } from "./types.ts";

const made: string[] = [];
const servers: http.Server[] = [];

export function tmp(prefix = "learn-jobs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes temporary folders and stops local servers after each test. Call once at the top of a test file. */
export function cleanup(): void {
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())).catch(() => undefined);
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
}

export type Reply =
  | { text: string }
  | { tool: string; args: unknown }
  | { tools: { tool: string; args: unknown }[] };

export interface ScriptCall {
  n: number;
  messages: TranscriptContext["messages"];
  signal?: AbortSignal;
}

export type Script = (call: ScriptCall) => Reply | Promise<Reply>;

/** A model that answers from the script. The calls are recorded. */
export function scripted(script: Script): { engine: JobEngine; calls: ScriptCall[] } {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", reasoning: false }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: ScriptCall[] = [];
  const factory = async (context: TranscriptContext, options?: { signal?: AbortSignal }): Promise<AssistantMessage> => {
    const call: ScriptCall = { n: calls.length + 1, messages: context.messages, signal: options?.signal };
    calls.push(call);
    const reply = await script(call);
    if ("text" in reply) return fauxAssistantMessage(fauxText(reply.text));
    if ("tools" in reply) return fauxAssistantMessage(reply.tools.map((t) => fauxToolCall(t.tool, t.args as never)));
    return fauxAssistantMessage(fauxToolCall(reply.tool, reply.args as never));
  };
  faux.setResponses(Array.from({ length: 400 }, () => factory as never));
  const engine: JobEngine = {
    model: faux.getModel() as Model<Api>,
    stream: (m, context, options) => models.streamSimple(m, context, options),
    ref: { provider: "faux", id: "m1" },
    providerClass: "claude-code",
    imageInput: true,
  };
  return { engine, calls };
}

/** Resolves when the signal aborts, so that a scripted model can hang until a job is stopped. */
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

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(check: () => boolean, label = "condition", timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await wait(4);
  }
}

/** The turn service as the jobs phase sees it. */
export class FakeTurns {
  running = false;
  accept = true;
  steers: Steer[] = [];
  /** called when a steer is accepted, for a test that lets the run save the message */
  onSteer?: (steer: Steer) => void;
  isRunning = (): boolean => this.running;
  steer = (_sessionId: string, steer: Steer): boolean => {
    if (!this.running || !this.accept) return false;
    this.steers.push(steer);
    this.onSteer?.(steer);
    return true;
  };
}

export interface JobsEnv {
  dir: string;
  store: SessionStore;
  sessionId: string;
  turns: FakeTurns;
  jobs: JobsService;
  events: LearnStreamMessage[];
  sleeps: number[];
  wakes: { sessionId: string; ids: string[] }[];
  clock: { now: number };
  deps: JobsDeps;
  engineFor: { current: JobModels["engine"] };
}

export function makeEnv(opts: { script?: Script; keys?: Record<string, string>; deps?: Partial<JobsDeps>; wake?: (env: JobsEnv) => WakeFn; dir?: string; semaphore?: Semaphore } = {}): JobsEnv & { calls: ScriptCall[] } {
  const dir = opts.dir ?? tmp();
  const store = createSessionStore({ learnDir: dir });
  const existing = store.list()[0];
  const sessionId = existing?.id ?? store.create({ title: "A lesson" }).id;
  const turns = new FakeTurns();
  const events: LearnStreamMessage[] = [];
  const sleeps: number[] = [];
  const wakes: JobsEnv["wakes"] = [];
  const clock = { now: Date.now() };
  const { engine, calls } = scripted(opts.script ?? (() => ({ text: "A brief." })));
  const engineFor = { current: (async () => engine) as JobModels["engine"] };
  const keyMap = opts.keys ?? {};
  const keys: JobKeys = { effective: (name) => (keyMap[name] ? { value: keyMap[name] } : null) };
  const env = { dir, store, sessionId, turns, events, sleeps, wakes, clock, engineFor } as JobsEnv & { calls: ScriptCall[] };
  const defaultWake: WakeFn = (sid, markers) => {
    wakes.push({ sessionId: sid, ids: markers.map((m) => m.id) });
    store.appendMessages(sid, markers as NativeMessage[]);
  };
  const deps: JobsDeps = {
    learnDir: dir,
    store,
    turns,
    wake: (sid, markers) => (opts.wake ? opts.wake(env)(sid, markers) : defaultWake(sid, markers)),
    models: { engine: (role, sid) => engineFor.current(role, sid) },
    keys,
    policy: { isDenied: () => false, allowedRoots: () => [] },
    emit: (m) => events.push(m),
    semaphore: opts.semaphore ?? new Semaphore(3),
    homeDir: dir,
    tempDir: path.join(dir, "tmp"),
    allowPrivateHosts: true,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await wait(1);
    },
    wakeGraceMs: 750,
    pollMs: 400,
    ...opts.deps,
  };
  env.deps = deps;
  env.jobs = createJobs(deps);
  env.calls = calls;
  return env;
}

/** A saved assistant message that calls a tool, so that a session has the call that a job answers. */
export function toolCallMessage(id: string, callId: string, name: string, args: Record<string, unknown>): NativeMessage {
  return { role: "assistant", id, content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1, stopReason: "toolUse" } as NativeMessage;
}

export interface Stub {
  base: string;
  hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
}

/** A local web server. The handler answers each request. */
export async function stubServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Stub> {
  const hits: Stub["hits"] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      hits.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

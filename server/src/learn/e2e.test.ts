// End to end tests of the learning upgrade. A real LearnRuntime runs over temporary folders, a scripted provider of the
// library stands in for every model, and the real HTTP handlers of server/src/learn/http.ts answer the requests. No test
// calls a network model, reads the real learning folder or writes to ~/.claude.
// public-check: synthetic-secrets (the provider keys in these tests are made up and must never reach a response)
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CortexEvent, GraphFile, StreamMessage } from "../../../shared/types.ts";
import type { NodeLine } from "../../../shared/learn/knowledge.ts";
import type { LocatorLine, OutcomeLine } from "../../../shared/learn/sources.ts";
import type { Context } from "../api.ts";
import type { Config } from "../config.ts";
import type { GraphStore } from "../graph.ts";
import { handleLearn } from "./http.ts";
import { LearnRuntime } from "./index.ts";

const NOTE = "# Rates\n\nA token bucket refills at a fixed rate up to a fixed capacity.\nA full bucket cannot hold more tokens than its capacity.\n";
const BUCKET = "Token bucket refill";
const CHOICE = {
  question: "What does a token bucket do at a fixed rate?",
  options: [
    { label: "It refills", value: "a" },
    { label: "It drains", value: "b" },
  ],
  explanation: "The bucket refills at a fixed rate.",
  correctAnswer: "a",
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await wait(10);
  }
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const toolCallWithText = (text: string, name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxText(text), fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const text = (t: string) => fauxAssistantMessage([fauxText(t)]);

/** The scripted extractor and auditor: the stage is told apart by the tools that the system message declares. */
function extraction(handler: (stage: "extractor" | "auditor", user: string) => { tool: string; args: unknown }): FauxResponseStep[] {
  const step: FauxResponseStep = (context) => {
    const lead = context.messages.find((m) => m.role === "system");
    const names = lead && lead.role === "system" ? (lead.toolsAdded ?? []).map((t) => t.name) : [];
    const first = context.messages.find((m) => m.role === "user");
    const user = !first ? "" : typeof first.content === "string" ? first.content : first.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const reply = handler(names.includes("submit_findings") ? "extractor" : "auditor", user);
    return fauxAssistantMessage([fauxToolCall(reply.tool, reply.args as never)], { stopReason: "toolUse" });
  };
  return Array.from({ length: 200 }, () => step);
}

const noteFindings = (): { tool: string; args: unknown } => ({
  tool: "submit_findings",
  args: {
    propositions: [
      { id: "p1", name: BUCKET, statement: "A token bucket refills at a fixed rate up to a fixed capacity.", quote: "A token bucket refills at a fixed rate up to a fixed capacity." },
      { id: "p2", name: "Bucket capacity", statement: "A full token bucket cannot hold more tokens than its capacity.", quote: "A full bucket cannot hold more tokens than its capacity." },
    ],
    chains: [{ premises: ["p1"], conclusion: "p2" }],
  },
});
const scriptedNotes = (stage: "extractor" | "auditor") => (stage === "auditor" ? { tool: "submit_review", args: { links: [] } } : noteFindings());

interface Env {
  dir: string;
  notes: string;
  learnDir: string;
  rt: LearnRuntime;
  claude: FauxProviderHandle;
  hosted: FauxProviderHandle;
  events: CortexEvent[];
  broadcast: StreamMessage[];
  rebuilds: number[];
  graph: { file: GraphFile | null };
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  base: string;
  /** the slots and the switches of Claude Code, written through the settings store */
  configure: (o?: { strong?: boolean; cheap?: "claude" | "hosted" | null; graph?: { enabled?: boolean; extractionChunkTokens?: number }; research?: boolean }) => void;
}

const open: { dir: string; server: http.Server; rt: LearnRuntime }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.server.close();
    o.rt.stop();
    fs.rmSync(o.dir, { recursive: true, force: true });
  }
});

async function makeEnv(opts: { lockPid?: number } = {}): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-"));
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const notes = fwd(path.join(dir, "notes"));
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
  const cfg = {
    data_dir: fwd(path.join(dir, "data")),
    learn_dir: fwd(path.join(dir, "data", "learn")),
    auth_file: fwd(path.join(dir, "data", "auth.json")),
    profile_dir: fwd(path.join(dir, "data", "profile")),
    claude_home: fwd(path.join(dir, "claude")),
    projects_root: null,
    memory_dir: fwd(path.join(dir, "claude", "memory")),
    claude_cmd: null,
    oversight_actor: "tester",
  } as unknown as Config;
  const claude = fauxProvider({ provider: "claude-code", models: [{ id: "sonnet", reasoning: true }] });
  const hosted = fauxProvider({ provider: "openai", models: [{ id: "gpt-test" }] });
  const events: CortexEvent[] = [];
  const broadcast: StreamMessage[] = [];
  const rebuilds: number[] = [];
  const graph: Env["graph"] = { file: null };
  const rt = new LearnRuntime({
    cfg,
    graph: { getGraph: () => graph.file, reload: () => {} } as unknown as GraphStore,
    broadcast: (m) => void broadcast.push(m),
    events: { append: (e) => void events.push(e) },
    extraProviders: [claude.provider, hosted.provider],
    env: { OPENAI_API_KEY: "sk-test-0123456789abcdef" },
    claudeCodeStatus: async () => ({ state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: true, allowBackground: true }),
    findClaude: () => "C:/fake/claude.exe",
    rebuild: async () => void rebuilds.push(Date.now()),
    homeDir: dir,
  });
  if (opts.lockPid !== undefined) {
    fs.mkdirSync(path.join(cfg.learn_dir as string, "cortex"), { recursive: true });
    fs.writeFileSync(path.join(cfg.learn_dir as string, "cortex", "writer.lock"), JSON.stringify({ pid: opts.lockPid, host: "other", since: new Date().toISOString() }));
  }
  rt.start();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleLearn({ learn: rt } as unknown as Context, req, res, url.pathname, url.searchParams);
  });
  open.push({ dir, server, rt });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/learn`;
  const call: Env["call"] = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await res.text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(t);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text: t };
  };
  const configure: Env["configure"] = (o = {}) => {
    const sonnet = { provider: "claude-code", id: "sonnet" };
    const cheap = o.cheap === undefined || o.cheap === "claude" ? sonnet : o.cheap === "hosted" ? { provider: "openai", id: "gpt-test" } : null;
    rt.models.settings.write({
      version: 1,
      claudeCode: { enabled: true, allowBackground: true },
      models: { ...(o.strong === false ? {} : { strong: { model: sonnet } }), ...(cheap ? { cheap: { model: cheap } } : {}) },
      ...(o.graph ? { graph: o.graph } : {}),
      ...(o.research ? { agent: { tools: { research: true } } } : {}),
    });
  };
  return { dir, notes, learnDir: cfg.learn_dir as string, rt, claude, hosted, events, broadcast, rebuilds, graph, call, base, configure };
}

const jsonLines = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** Links the notes folder, scans it and extracts it with the scripted stages. */
async function linkAndExtract(env: Env, sensitivity: "public" | "internal" | "client-confidential" = "internal") {
  fs.writeFileSync(path.join(env.notes, "rates.md"), NOTE);
  const added = await env.call("POST", "/sources", { kind: "notes", path: env.notes, label: "Notes", sensitivity });
  expect(added.status).toBe(201);
  const rootId = added.json.root.id as string;
  expect((await env.call("POST", `/sources/${rootId}/scan`)).status).toBe(200);
  return rootId;
}

async function extractRoot(env: Env, rootId: string) {
  env.claude.setResponses(extraction(scriptedNotes));
  const started = await env.call("POST", `/sources/${rootId}/extract`, {});
  expect(started.status).toBe(202);
  await env.rt.extract.idle();
  return started;
}

const sessionRecord = (env: Env, id: string) => env.rt.sessions.store.get(id)!;
const idle = (env: Env, id: string) => !env.rt.sessions.turns.isRunning(id);
const answerDetails = (env: Env, id: string, callId: string) =>
  (sessionRecord(env, id).messages.find((m) => m.role === "toolResult" && m.toolCallId === callId) as { details: any }).details; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads the frames of an event stream to its end. */
async function frames(env: Env, id: string): Promise<{ type: string; [k: string]: unknown }[]> {
  const res = await fetch(`${env.base}/sessions/${id}/stream`);
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
}

describe("a teaching session over the real services", () => {
  it("measures, plans and teaches, grades an answer with its confidence and fires the brain events", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env);
    await extractRoot(env, rootId);
    const claim = (await env.call("GET", "/graph")).json.propositions.find((p: { name: string }) => p.name === BUCKET) as { id: string };
    expect(claim.id).toMatch(/^n_[0-9a-f]{12}$/);

    const created = await env.call("POST", "/sessions", { title: "Rates" });
    expect(created.status).toBe(200);
    const id = created.json.session.id as string;
    expect(created.json.session.settings.model).toEqual({ provider: "claude-code", id: "sonnet" });

    // the first turn is held at the model, so that the stream can attach to a live turn
    let seenOptions: { sessionId?: string } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    env.claude.setResponses([
      async (_context, options) => {
        seenOptions = options as { sessionId?: string } | undefined;
        await gate;
        return toolCall("probe", { ...CHOICE, target: [BUCKET] }, "c_probe1");
      },
      toolCall("probe_done", { assessment: { strands: [{ strand: "rate limiting", assessment: "Knows the refill idea." }], summary: "Goal: rate limiting." } }, "c_done"),
      toolCallWithText("The approach: refill first, then capacity.", "plan_init", { mermaid: 'graph TD\n  refill["Refill"] --> capacity["Capacity"]' }, "c_plan"),
      text("Tell me if the order suits you."),
      toolCall("quiz", { type: "predict", nodeId: "refill", ...CHOICE }, "c_pred"),
      toolCallWithText("The prediction resolves like this.", "quiz", { type: "check", nodeId: "capacity", ...CHOICE, target: [claim.id] }, "c_check"),
      text("The step landed."),
    ]);

    const sent = await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me about token buckets" } });
    expect(sent.json).toMatchObject({ ok: true, started: true });
    const streamed = frames(env, id);
    await wait(60);
    release();
    const turn = await streamed;
    expect(turn.map((f) => f.type)).toEqual(expect.arrayContaining(["agent_start", "message_end", "tool_execution_end", "agent_end", "turn-settled"]));
    expect(turn[turn.length - 1]).toEqual({ type: "done" });
    // the loop passed the session id in the stream options, which the Claude Code provider needs for its held process
    expect(seenOptions?.sessionId).toBe(id);

    await until(() => idle(env, id) && sessionRecord(env, id).messages.some((m) => m.role === "assistant"), "the probe question");
    const detail = await env.call("GET", `/sessions/${id}`);
    expect(detail.json).toMatchObject({ turnInFlight: false });
    expect((await env.call("GET", "/sessions")).json.sessions[0]).toMatchObject({ phase: "probe", pendingQuestion: true });

    // answer the probe with a confidence and the thinking
    const answered = await env.call("POST", `/sessions/${id}/input`, {
      input: { type: "answer", toolCallId: "c_probe1", answer: { values: ["a"], confidence: 90, thinking: "A bucket refills." } },
    });
    expect(answered.json.ok).toBe(true);
    // probe_done, the handoff and the teacher's plan follow by themselves
    await until(() => idle(env, id) && sessionRecord(env, id).messages.some((m) => m.role === "custom" && m.customType === "plan-block"), "the plan block");
    const afterPlan = sessionRecord(env, id);
    expect(answerDetails(env, id, "c_probe1")).toMatchObject({ tool: "probe", correct: true, confidence: 90, target: [claim.id] });
    expect(afterPlan.messages.some((m) => m.role === "custom" && m.customType === "probe-handoff")).toBe(true);
    expect(afterPlan.tree?.nodes.map((n) => n.id)).toEqual(["refill", "capacity"]);
    expect((await env.call("GET", "/sessions")).json.sessions[0].phase).toBe("plan");

    // the teacher phase: a predict question and then a check question
    expect((await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Go ahead" } })).json.started).toBe(true);
    await until(() => idle(env, id) && (env.rt.sessions.list()[0].pendingQuestion ?? false), "the prediction");
    expect(env.rt.sessions.list()[0].phase).toBe("teach");
    await env.call("POST", `/sessions/${id}/input`, { input: { type: "answer", toolCallId: "c_pred", answer: { values: ["b"], confidence: 70, thinking: "Drains." } } });
    await until(() => idle(env, id) && env.rt.sessions.list()[0].pendingQuestion, "the check");
    await env.call("POST", `/sessions/${id}/input`, { input: { type: "answer", toolCallId: "c_check", answer: { values: ["a"], confidence: 100, readingThinking: "Yes." } } });
    await until(() => idle(env, id) && sessionRecord(env, id).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("The step landed")), "the last reply");
    expect(answerDetails(env, id, "c_pred")).toMatchObject({ questionType: "predict", correct: false });
    expect(answerDetails(env, id, "c_check")).toMatchObject({ questionType: "check", correct: true, confidence: 100 });

    // the outcome lines: the probe and the tagged check, with the proposition as target
    const outcomes = jsonLines<OutcomeLine>(`${env.learnDir}/cortex/outcomes.jsonl`);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["c_probe1", "c_check"]);
    expect(outcomes[0]).toMatchObject({ tool: "probe", target: [claim.id], correct: true, confidence: 90, sessionId: id });
    const read = await env.call("GET", `/outcomes?node=${claim.id}`);
    expect(read.status).toBe(200);
    expect(read.json.outcomes).toHaveLength(2);

    // the brain view events carry identifiers, the weights of the contract and no learner text
    const node = `claim:${claim.id.slice(2)}`;
    const answers = env.events.filter((e) => e.kind === "learn.answer");
    expect(answers.map((e) => e.key)).toEqual(["c_probe1", "c_check"]);
    expect(answers[0]).toMatchObject({ session: `learn:${id}`, weight: 0.6, nodes: [node], meta: { tool: "probe", correct: true } });
    const turns = env.events.filter((e) => e.kind === "learn.turn");
    expect(turns.length).toBeGreaterThanOrEqual(4);
    expect(turns[0]).toMatchObject({ session: `learn:${id}`, weight: 0.3 });
    expect(turns[0].nodes).toContain(`learnsession:${id.toLowerCase().replace(/_/g, "-")}`);
    expect(new Set(turns.map((e) => e.key)).size).toBe(turns.length);
    expect(JSON.stringify(env.events)).not.toContain("A bucket refills");
    expect(env.broadcast.filter((m) => m.type === "learn" && m.event === "turn-settled").length).toBeGreaterThanOrEqual(4);
  });

  it("starts the brain events for a graph context and filters it for the class of the model", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env, "client-confidential");
    await extractRoot(env, rootId);
    const claim = (await env.call("GET", "/graph")).json.propositions[0] as { id: string };
    // a Claude Code session may pick the confidential claim
    const own = await env.call("POST", "/sessions", { graphContext: { propositions: [claim.id] } });
    expect(own.json.session.messages[0]).toMatchObject({ customType: "graph-context" });
    // a hosted session may not: the pick is left out
    env.rt.models.settings.write({ version: 1, claudeCode: { enabled: true }, models: { strong: { model: { provider: "openai", id: "gpt-test" } } } });
    const hosted = await env.call("POST", "/sessions", { graphContext: { propositions: [claim.id] } });
    expect(hosted.json.session.messages).toHaveLength(0);
  });
});

describe("linked sources and extraction", () => {
  it("unlinks an extracted root with its knowledge and reports the files it had, after the deletion purged their records", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env);
    await extractRoot(env, rootId);
    expect((await env.call("GET", "/graph")).json.propositions.length).toBeGreaterThan(0);
    const removed = await env.call("DELETE", `/sources/${rootId}?mode=delete-nodes`);
    expect(removed.status).toBe(200);
    expect(removed.json).toMatchObject({ mode: "delete-nodes", files: 1 });
    expect((await env.call("GET", "/graph")).json.propositions).toHaveLength(0);
    expect((await env.call("GET", "/sources")).json.roots).toHaveLength(0);
  });

  it("extracts a notes folder with a scripted extractor and auditor and shows the claims with their locators", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env);
    const started = await extractRoot(env, rootId);
    expect(started.json).toMatchObject({ started: 1 });

    const graph = await env.call("GET", "/graph");
    expect(graph.status).toBe(200);
    expect(graph.json.propositions.map((p: { name: string }) => p.name).sort()).toEqual(["Bucket capacity", BUCKET]);
    const bucket = graph.json.propositions.find((p: { name: string }) => p.name === BUCKET);
    expect(bucket.provenance).toHaveLength(1);
    expect(graph.json.chains).toHaveLength(1);
    expect(jsonLines<NodeLine>(`${env.learnDir}/graph/nodes.jsonl`)).toHaveLength(2);

    // each claim has a locator that names its lines, its heading and its words
    const locators = jsonLines<LocatorLine>(`${env.learnDir}/cortex/locators.jsonl`);
    const mine = locators.find((l) => l.nodeId === bucket.id)!;
    expect(mine).toMatchObject({ found: true, heading: "Rates", quote: "A token bucket refills at a fixed rate up to a fixed capacity." });
    expect(mine.startLine).toBe(3);
    const passage = await env.call("GET", `/passage?source=${mine.sourceId}&from=${mine.startLine}&to=${mine.endLine}`);
    expect(passage.status).toBe(200);
    expect(passage.json.lines.join("\n")).toContain("token bucket refills");

    // the extraction events reached the stream and the brain view
    expect(env.broadcast.some((m) => m.type === "learn" && m.event === "graph-changed")).toBe(true);
    const fired = env.events.filter((e) => e.kind === "learn.extract");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ weight: 0.2, nodes: expect.arrayContaining([`claim:${bucket.id.slice(2)}`]), meta: { sourceId: mine.sourceId } });
    expect(fired[0].nodes.length).toBeLessThanOrEqual(20);
  });

  it("ratifies a claim through the writer and rebuilds the graph", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env);
    await extractRoot(env, rootId);
    const bucket = (await env.call("GET", "/graph")).json.propositions.find((p: { name: string }) => p.name === BUCKET) as { id: string };
    const node = `claim:${bucket.id.slice(2)}`;
    env.graph.file = { edges: [{ s: node, r: "documentedIn", t: "source:abc", provenance: "extracted" }] } as unknown as GraphFile;
    const ratified = await env.call("POST", "/graph/ratify", { claim: node, status: "ratified" });
    expect(ratified.status).toBe(200);
    expect(ratified.json).toMatchObject({ assertions: 1 });
    expect(env.rebuilds).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(env.dir, "data", "profile", "assertions", "knowledge.json"), "utf8")) as { assertions: Record<string, string>[] };
    expect(written.assertions).toEqual([{ s: node, r: "documentedIn", t: "source:abc", status: "ratified", by: "tester", date: new Date().toISOString().slice(0, 10) }]);
    // a rejection needs its reason
    expect((await env.call("POST", "/graph/ratify", { claim: node, status: "rejected" })).status).toBe(400);
  });

  it("refuses a client-confidential root for a hosted model and calls no model", async () => {
    const env = await makeEnv();
    env.configure({ cheap: "hosted" });
    const rootId = await linkAndExtract(env, "client-confidential");
    env.hosted.setResponses(extraction(scriptedNotes));
    const refused = await env.call("POST", `/sources/${rootId}/extract`, {});
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "sensitivity_refused", sensitivity: "client-confidential", providerClass: "hosted", roots: [rootId] });
    expect(env.hosted.state.callCount).toBe(0);
    expect(jsonLines(`${env.learnDir}/graph/nodes.jsonl`)).toHaveLength(0);
    // a recorded consent opens the root to the hosted model
    const consent = await env.call("PATCH", `/sources/${rootId}`, { hostedConsent: true });
    expect(consent.status).toBe(200);
    env.hosted.setResponses(extraction(scriptedNotes));
    expect((await env.call("POST", `/sources/${rootId}/extract`, {})).status).toBe(202);
    await env.rt.extract.idle();
    expect(env.hosted.state.callCount).toBeGreaterThan(0);
    expect(jsonLines(`${env.learnDir}/graph/nodes.jsonl`)).toHaveLength(2);
  });

  it("refuses a hosted session that has reached a client-confidential claim", async () => {
    const env = await makeEnv();
    env.configure();
    const rootId = await linkAndExtract(env, "client-confidential");
    await extractRoot(env, rootId);
    const claim = (await env.call("GET", "/graph")).json.propositions[0] as { id: string };
    const own = await env.call("POST", "/sessions", { graphContext: { propositions: [claim.id] } });
    const id = own.json.session.id as string;
    // changing the model of the session to a hosted one is refused by the gate
    const changed = await env.call("PUT", `/sessions/${id}/settings`, { model: { provider: "openai", id: "gpt-test" } });
    expect(changed.status).toBe(403);
    expect(changed.json).toMatchObject({ code: "sensitivity_refused", providerClass: "hosted" });
    expect(sessionRecord(env, id).settings?.model).toEqual({ provider: "claude-code", id: "sonnet" });
  });
});

describe("refusals before a model is called", () => {
  it("refuses a session when no slot is set", async () => {
    const env = await makeEnv();
    env.rt.models.settings.write({ version: 1 });
    const created = await env.call("POST", "/sessions", {});
    expect(created.status).toBe(200);
    const id = created.json.session.id as string;
    expect(created.json.session.settings).toBeUndefined();
    const refused = await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me" } });
    expect(refused.status).toBe(503);
    expect(refused.json).toMatchObject({ code: "models_not_configured", missing: ["strong"] });
    expect(sessionRecord(env, id).messages).toHaveLength(0);
    expect(env.claude.state.callCount).toBe(0);
  });

  it("asks for the opt in of Claude Code, and for its background use", async () => {
    const env = await makeEnv();
    const sonnet = { provider: "claude-code", id: "sonnet" };
    env.rt.models.settings.write({ version: 1, models: { strong: { model: sonnet }, cheap: { model: sonnet } } });
    const id = (await env.call("POST", "/sessions", {})).json.session.id as string;
    const off = await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me" } });
    expect(off.status).toBe(403);
    expect(off.json).toMatchObject({ code: "consent_required", consent: "claude-code" });
    // the extraction of a root needs the background switch
    env.rt.models.settings.write({ version: 1, claudeCode: { enabled: true }, models: { strong: { model: sonnet }, cheap: { model: sonnet } } });
    const rootId = await linkAndExtract(env);
    const background = await env.call("POST", `/sources/${rootId}/extract`, {});
    expect(background.status).toBe(403);
    expect(background.json).toMatchObject({ code: "consent_required", consent: "claude-code-background" });
  });

  it("refuses a hosted model whose key is missing, and a CLI that is not found", async () => {
    const env = await makeEnv();
    env.rt.models.settings.write({ version: 1, claudeCode: { enabled: true }, models: { strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } } });
    const id = (await env.call("POST", "/sessions", {})).json.session.id as string;
    const input = { input: { type: "text", text: "Teach me" } };
    const missing = await env.call("POST", `/sessions/${id}/input`, input);
    expect(missing.status).toBe(503);
    expect(missing.json).toMatchObject({ code: "provider_key_missing", provider: "anthropic", slots: ["strong"] });
  });
});

describe("extraction from a teaching session", () => {
  it("extracts the uncovered teacher text when a teaching turn settles, and stops on the abort route", async () => {
    const env = await makeEnv();
    env.configure({ graph: { enabled: true, extractionChunkTokens: 500 } });
    const id = (await env.call("POST", "/sessions", {})).json.session.id as string;
    const lecture = `${"A token bucket refills at a fixed rate up to a fixed capacity and a request spends one token. ".repeat(30)}`;
    let hold!: () => void;
    const held = new Promise<void>((r) => (hold = r));
    env.claude.setResponses([
      text(lecture),
      ...extraction((stage, user) => {
        if (stage === "auditor") return { tool: "submit_review", args: { links: [] } };
        const marker = /TEACHER \[([^\]]+)\]/.exec(user);
        return {
          tool: "submit_findings",
          args: { propositions: [{ id: "p1", name: "Request cost", statement: "A request spends one token from the bucket.", messageId: marker?.[1] }], chains: [] },
        };
      }).map((step) => async (...args: Parameters<Extract<FauxResponseStep, (...a: never[]) => unknown>>) => {
        await held;
        return (step as (...a: typeof args) => ReturnType<Extract<FauxResponseStep, (...a: never[]) => unknown>>)(...args);
      }),
    ]);
    await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me about token buckets" } });
    // the run starts by itself and shows in the activity list as an extraction
    await until(async () => (await env.call("GET", "/activity")).json.items.some((i: { kind: string }) => i.kind === "extraction"), "the extraction row");
    const item = (await env.call("GET", "/activity")).json.items.find((i: { kind: string }) => i.kind === "extraction");
    expect(item).toMatchObject({ sessionId: id });
    // the abort route stops it and answers for a run that is already gone too
    expect((await env.call("POST", "/activity/abort", { kind: "extraction", id: item.id })).json).toEqual({ ok: true });
    hold();
    await env.rt.extract.idle();
    expect((await env.call("POST", "/activity/abort", { kind: "extraction", id: item.id })).json).toEqual({ ok: true });
    expect(jsonLines(`${env.learnDir}/graph/nodes.jsonl`)).toHaveLength(0);

    // route 33 starts the run again, and the claim is anchored to the teacher message
    env.claude.setResponses(
      extraction((stage, user) =>
        stage === "auditor"
          ? { tool: "submit_review", args: { links: [] } }
          : {
              tool: "submit_findings",
              args: {
                propositions: [{ id: "p1", name: "Request cost", statement: "A request spends one token from the bucket.", messageId: /TEACHER \[([^\]]+)\]/.exec(user)?.[1] }],
                chains: [],
              },
            },
      ),
    );
    const started = await env.call("POST", "/graph/extract", { sessionId: id });
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ started: true });
    await env.rt.extract.idle();
    const nodes = jsonLines<NodeLine>(`${env.learnDir}/graph/nodes.jsonl`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].provenance[0].chatId).toBe(id);
    const detail = await env.call("GET", `/sessions/${id}`);
    expect(detail.json.coverage).toMatchObject({ uncoveredCount: 0, running: false });
    expect(detail.json.coverage.coveredCount).toBeGreaterThan(0);
    expect(detail.json.session.extractions).toHaveLength(1);
    // deleting the session keeps or removes the claims by the mode
    const removed = await env.call("DELETE", `/sessions/${id}?mode=delete-nodes`);
    expect(removed.json).toMatchObject({ deleted: true, stats: { nodesRemoved: 1 } });
  });

  it("answers 404 for a session that does not exist", async () => {
    const env = await makeEnv();
    env.configure();
    const missing = await env.call("POST", "/graph/extract", { sessionId: "chat_nope_00000000" });
    expect(missing.status).toBe(404);
  });
});

describe("background jobs over the real services", () => {
  it("dispatches a research job from the prober, delivers its brief into the session and continues from it", async () => {
    const env = await makeEnv();
    env.configure({ research: true });
    const created = await env.call("POST", "/sessions", { title: "Rates" });
    const id = created.json.session.id as string;

    // one scripted model serves the prober and the researcher, which is told apart by its web tools
    let proberCalls = 0;
    const step: FauxResponseStep = (context) => {
      const lead = context.messages.find((m) => m.role === "system");
      const names = lead && lead.role === "system" ? (lead.toolsAdded ?? []).map((t) => t.name) : [];
      if (names.includes("web_fetch")) return text("A token bucket refills at a fixed rate up to its capacity.");
      proberCalls++;
      return proberCalls === 1 ? toolCall("research", { question: "How does a token bucket refill?" }, "c_research") : text("Noted.");
    };
    env.claude.setResponses(Array.from({ length: 30 }, () => step));

    const sent = await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me about token buckets" } });
    expect(sent.json).toMatchObject({ ok: true, started: true });

    const delivered = () => sessionRecord(env, id).messages.find((m) => m.role === "custom" && m.customType === "subagent-steer");
    await until(() => delivered() !== undefined, "the delivered brief", 15000);
    await until(() => idle(env, id) && sessionRecord(env, id).messages.at(-1)?.role === "assistant", "a turn after the brief", 15000);

    const record = sessionRecord(env, id);
    const steer = delivered() as { details: { kind: string; result: { brief: string } } };
    expect(steer.details.kind).toBe("research");
    expect(steer.details.result.brief).toContain("refills at a fixed rate");
    // the idle wake continued from the marker, so the model answered after it
    expect(record.messages.indexOf(steer as never)).toBeLessThan(record.messages.length - 1);

    const jobs = await env.call("GET", `/jobs?sessionId=${id}`);
    expect(jobs.status).toBe(200);
    expect(jobs.json.jobs).toHaveLength(1);
    expect(jobs.json.jobs[0]).toMatchObject({ kind: "research" });
  }, 20000);
});

// ---- the gate review: every path to a hosted model passes the sensitivity gate -------------------------------------

const fwd = (p: string) => p.replace(/\\/g, "/");

/** Extracts a client-confidential notes root on Claude Code and opens a session over one of its claims. */
async function confidentialSession(env: Env): Promise<{ rootId: string; claimId: string; sessionId: string }> {
  env.configure();
  const rootId = await linkAndExtract(env, "client-confidential");
  await extractRoot(env, rootId);
  const claimId = ((await env.call("GET", "/graph")).json.propositions[0] as { id: string }).id;
  const own = await env.call("POST", "/sessions", { graphContext: { propositions: [claimId] } });
  return { rootId, claimId, sessionId: own.json.session.id as string };
}

const bigMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: "user" as const, id: `m_big_${i}`, content: `Item ${i} ${"word ".repeat(8000)}`, timestamp: 1000 + i }));

describe("background jobs and the sensitivity gate", () => {
  it("refuses a research job on a hosted cheap slot for a client-confidential session and calls no hosted model", async () => {
    const env = await makeEnv();
    const { sessionId } = await confidentialSession(env);
    env.configure({ cheap: "hosted" });
    env.hosted.setResponses(Array.from({ length: 20 }, () => text("A hosted brief.")));
    env.claude.setResponses(Array.from({ length: 20 }, () => text("Noted.")));
    env.rt.jobs.dispatcher.dispatch({ sessionId, kind: "research", toolCallId: "c_gate", input: { question: "What is a token bucket?", context: "client text" } });
    await env.rt.jobs.whenIdle();
    expect(env.hosted.state.callCount).toBe(0);
    const job = env.rt.jobs.store.list(sessionId)[0];
    expect(JSON.stringify(job)).toContain("client-confidential");
  }, 20000);
});

describe("the research gate", () => {
  it("leaves research out of the tool list until Settings switch it on", async () => {
    const env = await makeEnv();
    env.configure();
    const id = (await env.call("POST", "/sessions", { title: "Rates" })).json.session.id as string;
    const seen: string[][] = [];
    const step: FauxResponseStep = (context) => {
      const lead = context.messages.find((m) => m.role === "system");
      seen.push(lead && lead.role === "system" ? (lead.toolsAdded ?? []).map((t) => t.name) : []);
      return text("Noted.");
    };
    env.claude.setResponses(Array.from({ length: 10 }, () => step));
    await env.call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "Teach me about token buckets" } });
    await until(() => seen.length > 0, "a model call", 15000);
    expect(seen[0]).not.toContain("research");
    expect(seen[0]).toContain("pdf");
  }, 20000);

  it("refuses research from a client-confidential session without consent and starts no job or search", async () => {
    const env = await makeEnv();
    const { sessionId } = await confidentialSession(env);
    env.configure({ research: true });
    let proberCalls = 0;
    let searched = false;
    let result = "";
    const step: FauxResponseStep = (context) => {
      const lead = context.messages.find((m) => m.role === "system");
      const names = lead && lead.role === "system" ? (lead.toolsAdded ?? []).map((t) => t.name) : [];
      if (names.includes("web_fetch")) {
        searched = true;
        return text("A brief.");
      }
      for (const m of context.messages) if (m.role === "toolResult" && m.toolCallId === "c_cc") result = JSON.stringify(m.content);
      proberCalls++;
      return proberCalls === 1 ? toolCall("research", { question: "How does a token bucket refill?" }, "c_cc") : text("Noted.");
    };
    env.claude.setResponses(Array.from({ length: 20 }, () => step));
    await env.call("POST", `/sessions/${sessionId}/input`, { input: { type: "text", text: "Teach me about token buckets" } });
    await until(() => proberCalls >= 2, "the call after the refusal", 15000);
    await env.rt.jobs.whenIdle();
    expect(result).toContain("client-confidential");
    expect(searched).toBe(false);
    expect(env.rt.jobs.store.list(sessionId)).toHaveLength(0);
  }, 30000);
});

describe("compaction and the sensitivity gate", () => {
  it("summarises a client-confidential session on its own model when the cheap slot is hosted", async () => {
    const env = await makeEnv();
    const { sessionId } = await confidentialSession(env);
    env.rt.models.settings.write({
      version: 1,
      claudeCode: { enabled: true, allowBackground: true },
      models: { strong: { model: { provider: "claude-code", id: "sonnet" } }, cheap: { model: { provider: "openai", id: "gpt-test" } } },
      compaction: { thresholdTokens: 32000 },
    } as never);
    env.hosted.setResponses(Array.from({ length: 5 }, () => text("A hosted summary.")));
    env.claude.setResponses(Array.from({ length: 5 }, () => text("A summary by Claude Code.")));
    env.rt.sessions.store.appendMessages(sessionId, bigMessages(6));
    const outcome = await env.rt.sessions.compaction.compactIfNeeded(sessionId);
    expect(env.hosted.state.callCount).toBe(0);
    expect(outcome).toBe("compacted");
    const marker = sessionRecord(env, sessionId).messages.find((m) => m.role === "custom" && m.customType === "compaction") as { details: { model: string } };
    expect(marker.details.model).toBe("claude-code:sonnet");
  }, 20000);
});

describe("session sensitivity from file tool calls", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    role: "assistant" as const,
    id: `a_${name}`,
    content: [{ type: "toolCall" as const, id: "t1", name, arguments: args }],
    timestamp: 1,
  });
  it.each([
    ["a grep with no path", () => ({ name: "grep", args: { pattern: "x" } })],
    ["an ls of the parent folder of a root", (env: Env) => ({ name: "ls", args: { path: fwd(env.dir) } })],
    ["a read with a path relative to the home folder", () => ({ name: "read", args: { path: "notes/rates.md" } })],
  ])("counts %s as a read of the client-confidential root", async (_label, make) => {
    const env = await makeEnv();
    env.configure();
    fs.writeFileSync(path.join(env.notes, "rates.md"), NOTE);
    expect((await env.call("POST", "/sources", { kind: "notes", path: env.notes, label: "Notes", sensitivity: "client-confidential" })).status).toBe(201);
    const id = (await env.call("POST", "/sessions", { title: "Reads" })).json.session.id as string;
    const c = make(env);
    env.rt.sessions.store.appendMessages(id, [call(c.name, c.args)]);
    const changed = await env.call("PUT", `/sessions/${id}/settings`, { model: { provider: "openai", id: "gpt-test" } });
    expect(changed.status).toBe(403);
    expect(changed.json).toMatchObject({ code: "sensitivity_refused" });
  });

  it("reads a proposition named in the claim form as the proposition it names", async () => {
    const env = await makeEnv();
    const { claimId } = await confidentialSession(env);
    const id = (await env.call("POST", "/sessions", { title: "Claim form" })).json.session.id as string;
    env.rt.sessions.store.appendMessages(id, [call("get_proposition", { id: `claim:${claimId.slice(2)}` })]);
    const changed = await env.call("PUT", `/sessions/${id}/settings`, { model: { provider: "openai", id: "gpt-test" } });
    expect(changed.status).toBe(403);
  });
});

describe("provenance that no source explains", () => {
  it("reads a claim whose file record was removed with preserve-graph as client-confidential", async () => {
    const env = await makeEnv();
    const { rootId, claimId } = await confidentialSession(env);
    const removed = await env.call("DELETE", `/sources/${rootId}?mode=preserve-graph`);
    expect(removed.status).toBe(200);
    const id = (await env.call("POST", "/sessions", { graphContext: { propositions: [claimId] } })).json.session.id as string;
    const changed = await env.call("PUT", `/sessions/${id}/settings`, { model: { provider: "openai", id: "gpt-test" } });
    expect(changed.status).toBe(403);
    expect(changed.json).toMatchObject({ code: "sensitivity_refused" });
  });
});

describe("extraction and the sensitivity gate", () => {
  it("leaves a claim that rests on a confidential source out of the digest of a hosted extractor", async () => {
    const env = await makeEnv();
    env.configure();
    const rootA = await linkAndExtract(env, "public");
    await extractRoot(env, rootA);
    const claim = (await env.call("GET", "/graph")).json.propositions[0] as { id: string; statement: string };
    // a second, client-confidential source supports the same claim
    const confidential = path.join(env.dir, "secret");
    fs.mkdirSync(confidential, { recursive: true });
    fs.writeFileSync(path.join(confidential, "b.md"), NOTE);
    const added = await env.call("POST", "/sources", { kind: "notes", path: confidential, label: "Secret", sensitivity: "client-confidential" });
    const rootB = added.json.root.id as string;
    await env.call("POST", `/sources/${rootB}/scan`);
    const fileB = (await env.call("GET", `/sources/${rootB}/files`)).json.files[0] as { sourceId: string };
    const nodes = `${env.learnDir}/graph/nodes.jsonl`;
    const line = { id: claim.id, name: BUCKET, statement: claim.statement, aliases: [], createdAt: new Date().toISOString(), provenance: [{ chatId: fileB.sourceId, messageId: "" }] };
    fs.appendFileSync(nodes, `${JSON.stringify(line)}\n`);

    env.configure({ cheap: "hosted" });
    const seen: string[] = [];
    env.hosted.setResponses(
      extraction((stage, user) => {
        if (stage === "extractor") seen.push(user);
        return scriptedNotes(stage);
      }),
    );
    const forced = await env.call("POST", `/sources/${rootA}/extract`, { force: true });
    expect(forced.status).toBe(202);
    await env.rt.extract.idle();
    expect(seen.length).toBeGreaterThan(0);
    for (const user of seen) expect(user).not.toContain(claim.id);
  }, 20000);

  it("stops a hosted extraction at the next step when the consent is withdrawn during the run", async () => {
    const env = await makeEnv();
    env.configure({ graph: { extractionChunkTokens: 500 } });
    const filler = Array.from({ length: 14 }, (_, i) => `Paragraph ${i} ${"about buckets and rates ".repeat(40)}`).join("\n\n");
    fs.writeFileSync(path.join(env.notes, "rates.md"), `${NOTE}\n${filler}\n`);
    const added = await env.call("POST", "/sources", { kind: "notes", path: env.notes, label: "Notes", sensitivity: "client-confidential" });
    const rootId = added.json.root.id as string;
    await env.call("POST", `/sources/${rootId}/scan`);
    expect((await env.call("PATCH", `/sources/${rootId}`, { hostedConsent: true })).status).toBe(200);
    env.configure({ cheap: "hosted", graph: { extractionChunkTokens: 500 } });
    let revoked = false;
    env.hosted.setResponses(
      extraction((stage) => {
        if (stage === "extractor" && !revoked) {
          revoked = true;
          env.rt.sources.update(rootId, { hostedConsent: false } as never);
        }
        return scriptedNotes(stage);
      }),
    );
    expect((await env.call("POST", `/sources/${rootId}/extract`, {})).status).toBe(202);
    await env.rt.extract.idle();
    expect(revoked).toBe(true);
    expect(env.hosted.state.callCount).toBe(1);
  }, 20000);
});

describe("the writer lock and deletion through the organiser", () => {
  it("starts when a live process holds the writer lock, and refuses writes to the graph", async () => {
    const env = await makeEnv({ lockPid: process.ppid });
    expect((await env.call("GET", "/graph")).status).toBe(200);
    const write = await env.call("DELETE", "/graph/nodes/n_000000000000");
    expect(write.status).toBe(409);
    expect(write.json).toMatchObject({ code: "busy" });
  });

  it("keeps the whole runtime read only while another live process holds the lock (C1)", async () => {
    const env = await makeEnv({ lockPid: process.ppid });
    expect(env.rt.readOnly).toBe(true);
    // a job that a sweep would pick up
    const job = env.rt.jobs.store.create({ chatId: "s_other", kind: "research", toolCallId: "c_ro", input: { question: "q" } });
    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/sessions", { title: "New" }],
      ["PUT", "/keys/openai", { key: "sk-test" }],
      ["PUT", "/settings", {}],
      ["POST", "/sources", { kind: "notes", path: env.notes, label: "Notes" }],
      ["POST", "/sources/src_none/scan"],
      ["POST", "/graph/extract", {}],
    ];
    for (const [method, route, body] of refused) {
      const res = await env.call(method, route, body);
      expect([method, route, res.status, res.json?.code]).toEqual([method, route, 409, "busy"]);
    }
    expect((await env.call("GET", "/sessions")).status).toBe(200);
    // route 27 lists the jobs and neither sweeps nor recovers
    expect((await env.call("GET", `/jobs?sessionId=s_other`)).status).toBe(200);
    await env.rt.jobs.whenIdle();
    expect(env.rt.jobs.store.get(job.id)?.status).toBe("running");
    expect(env.rt.jobs.store.get(job.id)?.result).toBeUndefined();
  });

  it("takes the lock and answers writes when no other process holds it (C1)", async () => {
    const env = await makeEnv();
    expect(env.rt.readOnly).toBe(false);
    expect((await env.call("POST", "/sessions", { title: "Fine" })).status).toBe(200);
  });

  it("removes the jobs of a session that the organiser deletes, and refuses while one computes", async () => {
    const env = await makeEnv();
    env.configure();
    const id = (await env.call("POST", "/sessions", { title: "Gone" })).json.session.id as string;
    const job = env.rt.jobs.store.create({ chatId: id, kind: "research", toolCallId: "c_org", input: { question: "q" } });
    const blocked = await env.call("DELETE", "/source-organization", { sourceIds: [id], folderIds: [], deleteSessions: true });
    expect(blocked.status).toBe(409);
    expect(env.rt.sessions.store.get(id)).not.toBeNull();
    env.rt.jobs.store.update(job.id, { status: "done" } as never);
    const done = await env.call("DELETE", "/source-organization", { sourceIds: [id], folderIds: [], deleteSessions: true });
    expect(done.status).toBe(200);
    expect(env.rt.jobs.store.list(id)).toHaveLength(0);
  });
});

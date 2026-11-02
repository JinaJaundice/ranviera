import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { handleSessions } from "./http.ts";
import { defineTool } from "./tools/define.ts";
import { assistantMsg, call, makeEnv, until, userMsg, wait, type Env } from "./support.ts";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(env: Env) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleSessions(env.service, req, res, url.pathname, url.searchParams).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("unhandled");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/learn`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { base, call };
}

describe("session routes", () => {
  it("creates, lists, reads and renames a session (routes 16 to 19)", async () => {
    const env = makeEnv();
    const { call } = await serve(env);
    const created = await call("POST", "/sessions", { title: "Bond maths" });
    expect(created.status).toBe(200);
    const id = created.json.session.id as string;
    expect(created.json.session.settings.model.provider).toBe("faux");
    const list = await call("GET", "/sessions");
    expect(list.json.sessions.map((s: { id: string }) => s.id)).toEqual([id]);
    expect(list.json.sessions[0]).toMatchObject({ title: "Bond maths", kind: "teach", phase: "probe", pendingQuestion: false, busy: false, compacting: false, messageCount: 0 });
    const detail = await call("GET", `/sessions/${id}`);
    expect(detail.json).toMatchObject({ turnInFlight: false, turnError: null, compacting: false, sensitivity: "public" });
    expect(detail.json.coverage.threshold).toBe(4096);
    expect(detail.json.pricing).toMatchObject({ cost: null });
    const before = detail.json.session.updatedAt;
    await wait(5);
    const renamed = await call("PUT", `/sessions/${id}`, { title: "Renamed" });
    expect(renamed.json.session.title).toBe("Renamed");
    expect(renamed.json.session.updatedAt).toBe(before);
    expect((await call("PUT", `/sessions/${id}`, { title: 5 })).status).toBe(400);
    expect((await call("GET", "/sessions/chat_nope_00000000")).json).toMatchObject({ code: "not_found" });
  });

  it("answers the envelopes for a wrong method, a wrong media type and a bad body", async () => {
    const env = makeEnv();
    const { call } = await serve(env);
    const id = (await call("POST", "/sessions", {})).json.session.id as string;
    const wrong = await call("PATCH", `/sessions/${id}`, {});
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toContain("GET");
    expect((await call("POST", `/sessions/${id}/input`, "not json", { "content-type": "text/plain" })).json).toMatchObject({ code: "unsupported_media_type" });
    expect((await call("POST", `/sessions/${id}/input`, "{ broken")).status).toBe(400);
    expect((await call("POST", `/sessions/${id}/input`, {})).json).toMatchObject({ code: "bad_request" });
    expect((await call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "" } })).json).toMatchObject({ code: "bad_request" });
    expect((await call("POST", "/sessions/chat_nope_00000000/input", { input: { type: "text", text: "x" } })).status).toBe(404);
    expect((await call("GET", "/nothing-here")).text).toBe("unhandled");
  });

  it("admits an input and refuses a second with 409, and streams the turn (routes 21 and 22)", async () => {
    const env = makeEnv();
    const { call, base } = await serve(env);
    const id = (await call("POST", "/sessions", {})).json.session.id as string;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    env.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText("Streamed reply.")]);
      },
    ]);
    const first = await call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "go" } });
    expect(first.json).toEqual({ ok: true, started: true });
    const second = await call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "again" } });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("turn_running");
    expect((await call("GET", `/sessions/${id}`)).json.turnInFlight).toBe(true);
    const res = await fetch(`${base}/sessions/${id}/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    open();
    const body = await res.text();
    const frames = body.split("\n\n").filter(Boolean).map((chunk) => {
      expect(chunk.startsWith("data: ")).toBe(true);
      expect(chunk).not.toContain("event:");
      return JSON.parse(chunk.slice(6)) as { type: string };
    });
    const types = frames.map((f) => f.type);
    expect(types[0]).toBe("agent_start");
    expect(types.slice(-2)).toEqual(["turn-settled", "done"]);
    expect(types).toContain("message_end");
    expect(JSON.stringify(frames)).toContain("Streamed reply.");
    await env.service.turns.whenSettled(id);
    const short = await (await fetch(`${base}/sessions/${id}/stream`)).text();
    expect(short.split("\n\n").filter(Boolean).map((c) => JSON.parse(c.slice(6)).type)).toEqual(["turn-settled", "done"]);
    expect((await call("GET", "/sessions/chat_nope_00000000/stream")).status).toBe(404);
  });

  it("keeps the turn running when the stream connection closes", async () => {
    const env = makeEnv();
    const { call, base } = await serve(env);
    const id = (await call("POST", "/sessions", {})).json.session.id as string;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    env.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText("Finished anyway.")]);
      },
    ]);
    await call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "go" } });
    const ac = new AbortController();
    const res = await fetch(`${base}/sessions/${id}/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await wait(20);
    expect(env.service.turns.isRunning(id)).toBe(true);
    open();
    await env.service.turns.whenSettled(id);
    expect(env.service.store.get(id)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("steers a live turn and answers 404, 400 and 409 otherwise (route 23, B-7-21)", async () => {
    const env = makeEnv();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    env.state.tools = [
      defineTool({
        name: "echo",
        label: "Slow",
        description: "Waits.",
        parameters: Type.Object({ text: Type.String() }),
        execute: async () => {
          await gate;
          return { content: [{ type: "text", text: "done" }], details: null };
        },
      }),
    ];
    const { call } = await serve(env);
    const id = (await call("POST", "/sessions", {})).json.session.id as string;
    expect((await call("POST", "/sessions/chat_nope_00000000/steer", { id: "steer_1", text: "x" })).status).toBe(404);
    expect((await call("POST", `/sessions/${id}/steer`, { id: "steer_1" })).status).toBe(400);
    expect((await call("POST", `/sessions/${id}/steer`, { id: "bad id", text: "x" })).status).toBe(400);
    expect((await call("POST", `/sessions/${id}/steer`, { id: "steer_1", text: "x" })).status).toBe(409);
    env.faux.setResponses([fauxAssistantMessage([fauxToolCall("echo", { text: "t" }, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
    await call("POST", `/sessions/${id}/input`, { input: { type: "text", text: "go" } });
    await until(() => [...env.service.turns.attach(id).log].some((f) => f.type === "tool_execution_start"), "tool start");
    const steer = await call("POST", `/sessions/${id}/steer`, { id: "steer_1", text: "mind the coupon" });
    expect(steer.status).toBe(200);
    release();
    await env.service.turns.whenSettled(id);
    expect(env.service.store.get(id)!.messages.some((m) => m.id === "steer_1")).toBe(true);
  });

  it("dismisses silently, parks mid turn with 202 and refuses a dismissal that targets nothing (route 24)", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", {})).json.session.id as string;
    expect((await req("POST", `/sessions/${id}/dismiss`, { toolCallId: "q1" })).json.code).toBe("bad_request");
    expect((await req("POST", `/sessions/${id}/dismiss`, {})).status).toBe(400);
    env.service.store.appendMessages(id, [userMsg("m1", "go"), assistantMsg("m2", [call("q1", "quiz", { question: "?" })], { stopReason: "toolUse" })]);
    const ok = await req("POST", `/sessions/${id}/dismiss`, { toolCallId: "q1" });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, parked: false });
    expect(env.faux.state.callCount).toBe(0);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    env.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText("x")]);
      },
    ]);
    await req("POST", `/sessions/${id}/input`, { input: { type: "text", text: "next" } });
    const parked = await req("POST", `/sessions/${id}/dismiss`, { toolCallId: "ghost" });
    expect(parked.status).toBe(202);
    expect(parked.json.parked).toBe(true);
    open();
    await env.service.turns.whenSettled(id);
  });

  it("replaces the settings of a session without bumping updatedAt (route 25)", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", {})).json.session.id as string;
    const before = env.service.store.get(id)!.updatedAt;
    const put = await req("PUT", `/sessions/${id}/settings`, { model: { provider: "faux", id: "other" }, thinkingLevel: "high" });
    expect(put.json.session.settings).toEqual({ model: { provider: "faux", id: "other" }, thinkingLevel: "high" });
    expect(put.json.session.updatedAt).toBe(before);
    expect((await req("PUT", `/sessions/${id}/settings`, { thinkingLevel: "loud" })).status).toBe(400);
    expect((await req("PUT", `/sessions/${id}/settings`, { model: { provider: "faux" } })).status).toBe(400);
    const cleared = await req("PUT", `/sessions/${id}/settings`, {});
    expect(cleared.json.session.settings).toBeUndefined();
  });

  it("exports Markdown as an attachment named from the title (route 26, B-7-86)", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    expect((await req("GET", "/sessions/chat_nope_00000000/markdown")).status).toBe(404);
    const id = (await req("POST", "/sessions", { title: "Bond duration" })).json.session.id as string;
    env.service.store.appendMessages(id, [userMsg("msg_1", "What is it?"), assistantMsg("msg_2", [{ type: "text", text: "A sensitivity." }])]);
    const res = await req("GET", `/sessions/${id}/markdown`);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="bond-duration.md"');
    expect(res.text).toContain("### Learner\n\nWhat is it?");
    expect(res.text).not.toContain("msg_");
    const empty = (await req("POST", "/sessions", {})).json.session.id as string;
    expect((await req("GET", `/sessions/${empty}/markdown`)).text).toBe("# Untitled session\n");
  });
});

describe("deletion (route 20)", () => {
  it("has no default mode and refuses an unknown one", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", {})).json.session.id as string;
    expect((await req("DELETE", `/sessions/${id}`)).json.code).toBe("bad_request");
    expect((await req("DELETE", `/sessions/${id}?mode=everything`)).status).toBe(400);
    expect(env.service.store.get(id)).not.toBeNull();
    expect(env.deletions).toEqual([]);
  });

  it("preserves the graph or deletes nodes, calls the knowledge deletion first and archives the file last", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const a = (await req("POST", "/sessions", {})).json.session.id as string;
    const b = (await req("POST", "/sessions", {})).json.session.id as string;
    const order: string[] = [];
    env.deps.deletion.deleteSession = (id, mode) => {
      order.push(`graph:${mode}:${env.service.store.get(id) ? "file present" : "file gone"}`);
      return { nodesRemoved: 3, chainsRemoved: 1, coverageRemoved: 2, checkpointsRemoved: 0 };
    };
    const one = await req("DELETE", `/sessions/${a}?mode=preserve-graph`);
    expect(one.json).toMatchObject({ deleted: true, stats: { nodesRemoved: 3 } });
    const two = await req("DELETE", `/sessions/${b}?mode=delete-nodes`);
    expect(two.status).toBe(200);
    expect(order).toEqual(["graph:preserve-graph:file present", "graph:delete-nodes:file present"]);
    expect((await req("GET", `/sessions/${a}`)).status).toBe(404);
    expect((await req("DELETE", `/sessions/${a}?mode=preserve-graph`)).status).toBe(404);
    expect(env.events.some((e) => e.event === "sessions-changed")).toBe(true);
  });

  it("refuses with 409 while a turn runs and with job_running while a job computes", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", {})).json.session.id as string;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    env.faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText("x")]);
      },
    ]);
    await req("POST", `/sessions/${id}/input`, { input: { type: "text", text: "go" } });
    const busy = await req("DELETE", `/sessions/${id}?mode=delete-nodes`);
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe("turn_running");
    open();
    await env.service.turns.whenSettled(id);
    env.deps.activity!.computingJobs = () => ["job_1"];
    const job = await req("DELETE", `/sessions/${id}?mode=delete-nodes`);
    expect(job.status).toBe(409);
    expect(job.json).toMatchObject({ code: "job_running", jobs: ["job_1"] });
    expect(env.deletions).toEqual([]);
    expect(env.service.store.get(id)).not.toBeNull();
  });

  it("aborts a running extraction and waits, then answers 503 extraction_busy when it does not stop", async () => {
    const env = makeEnv();
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", {})).json.session.id as string;
    env.extraction.running = true;
    const stops = await req("DELETE", `/sessions/${id}?mode=preserve-graph`);
    expect(stops.status).toBe(200);
    const id2 = (await req("POST", "/sessions", {})).json.session.id as string;
    env.extraction.running = true;
    env.deps.deletion.abortExtraction = () => {};
    const stuck = await req("DELETE", `/sessions/${id2}?mode=preserve-graph`);
    expect(stuck.status).toBe(503);
    expect(stuck.json.code).toBe("extraction_busy");
    expect(env.service.store.get(id2)).not.toBeNull();
  });
});

describe("activity routes (28 and 29)", () => {
  it("lists a running turn and aborts it, and refuses to abort what is not running", async () => {
    const env = makeEnv({ tokensPerSecond: 30 });
    env.deps.activity!.jobs = () => [{ kind: "job", id: "job_1", sessionId: null, title: "Research", phase: "running", startedAt: "2026-11-01T00:00:00.000Z" }];
    const { call: req } = await serve(env);
    const id = (await req("POST", "/sessions", { title: "Live one" })).json.session.id as string;
    expect((await req("GET", "/activity")).json.items.map((i: { kind: string }) => i.kind)).toEqual(["job"]);
    env.faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(300))])]);
    await req("POST", `/sessions/${id}/input`, { input: { type: "text", text: "go" } });
    const items = (await req("GET", "/activity")).json.items as { kind: string; id: string; title: string; phase: string }[];
    const turn = items.find((i) => i.kind === "turn")!;
    expect(turn).toMatchObject({ id, title: "Live one", phase: "probe" });
    expect((await req("POST", "/activity/abort", { kind: "turn", id })).status).toBe(200);
    await env.service.turns.whenSettled(id);
    expect((await req("POST", "/activity/abort", { kind: "turn", id })).status).toBe(409);
    expect((await req("POST", "/activity/abort", { kind: "other", id })).status).toBe(400);
    expect((await req("POST", "/activity/abort", { kind: "turn", id: "../x" })).status).toBe(400);
    expect((await req("POST", "/activity/abort", { kind: "extraction", id: "src_1:part#2" })).status).toBe(200);
    expect((await req("POST", "/activity/abort", { kind: "job", id: "job_9" })).status).toBe(404);
    expect((await req("GET", "/activity")).json.items.map((i: { kind: string }) => i.kind)).toEqual(["job"]);
  });

  it("aborts a job through the injected provider", async () => {
    const env = makeEnv();
    env.deps.activity!.abortJob = (id) => (id === "job_run" ? "ok" : "not_running");
    const { call: req } = await serve(env);
    expect((await req("POST", "/activity/abort", { kind: "job", id: "job_run" })).status).toBe(200);
    expect((await req("POST", "/activity/abort", { kind: "job", id: "job_idle" })).status).toBe(409);
  });
});

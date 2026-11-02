// Tests of the jobs service: the store, the markers, dispatch, the two workers, delivery, abort, recovery and the route.
// A scripted model stands in for every provider, and every file lives in a temporary folder.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { LearnStreamMessage, NativeMessage } from "../../../../shared/learn/index.ts";
import { Semaphore, processSemaphore } from "../extract/semaphore.ts";
import { RuntimeError } from "../runtime/errors.ts";
import { makePdf, proseLines } from "../sources/testkit.ts";
import { handleJobs } from "./http.ts";
import { createWake } from "./index.ts";
import { buildSteer, failureResult, isFailureResult, markerMessage, sourcesOf, steerIdOf, UsageFolder } from "./steer.ts";
import { createJobStore } from "./store.ts";
import { pdfTools } from "./tools/pdf-tools.ts";
import { cleanup, deferred, makeEnv, stubServer, tmp, toolCallMessage, until, untilAborted, wait, type JobsEnv } from "./test-support.ts";

cleanup();

const QUESTION = "What did the supervisor set as the reserve ratio?";

type Env = ReturnType<typeof makeEnv>;

function dispatchResearch(env: Env, callId = "call_1", input: Record<string, unknown> = { question: QUESTION }) {
  return env.jobs.dispatcher.dispatch({ kind: "research", sessionId: env.sessionId, toolCallId: callId, input }) as { jobId: string };
}

function markers(env: JobsEnv): NativeMessage[] {
  return (env.store.get(env.sessionId)?.messages ?? []).filter((m) => m.role === "custom" && (m.customType === "subagent-steer" || m.customType === "subagent-abort"));
}

/** A job that finished and waits for delivery. */
function seedDone(env: Env, over: { toolCallId?: string; brief?: string } = {}): string {
  const job = env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: over.toolCallId ?? `call_${Math.random().toString(36).slice(2, 8)}`, input: { question: QUESTION } });
  env.jobs.store.update(job.id, { status: "done", activity: "finished", result: { brief: over.brief ?? "The ratio is 4 percent.", sources: [] }, delivery: { kind: "result", status: "pending" } });
  return job.id;
}

const deliveryOf = (env: JobsEnv, id: string) => env.jobs.store.get(id)?.delivery?.status;

describe("job store", () => {
  it("round trips create, get, update and list, and announces every write but no read", () => {
    const dir = tmp();
    const events: LearnStreamMessage[] = [];
    let t = 1_000;
    const store = createJobStore({ learnDir: dir, emit: (m) => events.push(m), now: () => (t += 1000) });
    const a = store.create({ chatId: "chat_a", kind: "research", toolCallId: "c1", input: { question: "q" } });
    expect(a.id).toMatch(/^job_[0-9a-z]+[0-9a-f]{8}$/);
    expect(events).toEqual([{ type: "learn", event: "jobs-changed", session: "chat_a" }]);
    store.get(a.id);
    store.list();
    store.findByCall("chat_a", "c1");
    expect(events).toHaveLength(1);
    const b = store.update(a.id, { activity: "searching" });
    expect(b).toMatchObject({ activity: "searching", status: "running", input: { question: "q" } });
    expect(b!.updatedAt > a.updatedAt).toBe(true);
    const fixed = store.update(a.id, { updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(fixed!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(events).toHaveLength(3);
    store.create({ chatId: "chat_b", kind: "pdf", toolCallId: "c2", input: { path: "x.pdf", question: "q" } });
    expect(store.list("chat_a")).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
    expect(store.findByCall("chat_b", "c2")?.kind).toBe("pdf");
    expect(store.update("job_missing", { activity: "x" })).toBeNull();
  });

  it("reads a corrupt file as absent and moves the files of a session to the archive", () => {
    const dir = tmp();
    const store = createJobStore({ learnDir: dir, emit: () => undefined });
    const a = store.create({ chatId: "chat_a", kind: "research", toolCallId: "c1", input: {} });
    fs.writeFileSync(path.join(dir, "jobs", "job_bad.json"), "{ not json");
    expect(store.get("job_bad")).toBeNull();
    expect(store.list().map((j) => j.id)).toEqual([a.id]);
    expect(store.removeForChat("chat_a")).toBe(1);
    expect(store.get(a.id)).toBeNull();
    expect(fs.readdirSync(path.join(dir, "archive")).length).toBe(1);
  });
});

describe("markers and failure shapes", () => {
  const base = { id: "job_x", chatId: "chat_a", toolCallId: "call_1", createdAt: "t", updatedAt: "t", activity: "finished" } as const;

  it("builds a steer with the brief for the model and the result in the details", () => {
    const job = { ...base, kind: "research", input: { question: QUESTION }, status: "done", result: { brief: "Four percent.", sources: [{ title: "Rule", url: "https://example.org/r" }] } } as const;
    const s = buildSteer(job as never, "result");
    expect(s.id).toBe("steer_job_x");
    expect(s.id).toBe(steerIdOf("job_x"));
    expect(s.customType).toBe("subagent-steer");
    expect(s.content).toContain("Four percent.");
    expect(s.content).toContain("https://example.org/r");
    expect(s.details).toMatchObject({ jobId: "job_x", kind: "research", toolCallId: "call_1", result: { brief: "Four percent." } });
    expect(markerMessage(s, 5)).toMatchObject({ role: "custom", id: "steer_job_x", customType: "subagent-steer", display: true });
  });

  it("tells the teacher that no result is coming after an abort, and how to recover after a failure", () => {
    const aborted = buildSteer({ ...base, kind: "research", input: { question: QUESTION }, status: "error", error: "Aborted by learner" } as never, "abort");
    expect(aborted.customType).toBe("subagent-abort");
    expect(aborted.content).toContain("No result is coming");
    expect(aborted.details).toMatchObject({ aborted: true, jobId: "job_x" });
    const failed = buildSteer({ ...base, kind: "research", input: { question: QUESTION }, status: "error", error: "x", result: failureResult("research", {}, "The search failed.") } as never, "result");
    expect(failed.content).toContain("did not produce a result");
    expect(failed.content).toContain("unchecked");
    const pdf = buildSteer({ ...base, kind: "pdf", input: { path: "a.pdf", question: "q" }, status: "error", result: failureResult("pdf", { path: "a.pdf", question: "q" }, "The file is not a PDF.") } as never, "result");
    expect(pdf.content).toContain("did not produce a result");
    expect(pdf.content).toContain("different file");
  });

  it("carries page citations in a PDF steer", () => {
    const job = { ...base, kind: "pdf", input: { path: "a.pdf", question: "q" }, status: "done", result: { path: "a.pdf", question: "q", brief: "See (p. 2).", pagesRead: [2], pagesConsulted: [2, 5] } };
    const s = buildSteer(job as never, "result");
    expect(s.content).toContain("Pages read: 2. Pages consulted: 2, 5.");
  });

  it("sums usage for each model call and leaves fields that no call reported undefined", () => {
    const f = new UsageFolder("faux:m1");
    f.add({ inputTokens: 10, outputTokens: 4 });
    const total = f.add({ inputTokens: 5, cacheReadTokens: 7 });
    expect(total).toMatchObject({ model: "faux:m1", inputTokens: 15, outputTokens: 4, cacheReadTokens: 7, steps: 2 });
    expect(total.reasoningTokens).toBeUndefined();
    expect(total.calls).toHaveLength(2);
    expect(total.lastStep).toEqual({ inputTokens: 5, cacheReadTokens: 7 });
  });

  it("detects the failure shapes and picks sources from links first and fetched pages second", () => {
    expect(isFailureResult("research", { brief: "", sources: [] })).toBe(true);
    expect(isFailureResult("research", failureResult("research", {}, "x"))).toBe(true);
    expect(isFailureResult("pdf", failureResult("pdf", {}, "x"))).toBe(true);
    expect(isFailureResult("research", { brief: "A real brief.", sources: [] })).toBe(false);
    expect(sourcesOf("See [Rule](https://example.org/r) and [Again](https://example.org/r).", ["https://other.org/x"])).toEqual([{ title: "Rule", url: "https://example.org/r" }]);
    expect(sourcesOf("No links.", ["https://other.org/x"])).toEqual([{ title: "other.org", url: "https://other.org/x" }]);
    expect(sourcesOf(Array.from({ length: 14 }, (_, i) => `[s${i}](https://e.org/${i})`).join(" "), [])).toHaveLength(10);
  });
});

describe("dispatch", () => {
  it("answers at once with an acknowledgement while the worker runs in the background", async () => {
    const gate = deferred();
    const env = makeEnv({
      script: async () => {
        await gate.promise;
        return { text: "The ratio is 4 percent." };
      },
    });
    const ack = dispatchResearch(env);
    expect(ack.jobId).toMatch(/^job_/);
    const saved = env.jobs.store.get(ack.jobId)!;
    expect(saved).toMatchObject({ status: "running", kind: "research", chatId: env.sessionId, toolCallId: "call_1", input: { question: QUESTION } });
    await until(() => env.calls.length === 1, "the model call");
    expect(env.jobs.store.get(ack.jobId)?.status).toBe("running");
    gate.resolve();
    await env.jobs.whenIdle();
    expect(env.jobs.store.get(ack.jobId)).toMatchObject({ status: "done", activity: "finished", result: { brief: "The ratio is 4 percent." } });
  });

  it("reuses the job for the same session and tool call and starts one worker", async () => {
    const env = makeEnv({ script: () => ({ text: "A brief." }) });
    const a = dispatchResearch(env, "call_7");
    const b = dispatchResearch(env, "call_7");
    expect(b.jobId).toBe(a.jobId);
    const c = dispatchResearch(env, "call_8");
    expect(c.jobId).not.toBe(a.jobId);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(2);
    expect(env.jobs.store.list(env.sessionId)).toHaveLength(2);
  });

  it("starts a new job when a provider reuses the tool call identifier for another question or another kind", async () => {
    const env = makeEnv({ script: () => ({ text: "A brief." }) });
    const a = dispatchResearch(env, "call_0");
    const b = dispatchResearch(env, "call_0", { question: "Which firms were named in the notice?" });
    const c = env.jobs.dispatcher.dispatch({ kind: "pdf", sessionId: env.sessionId, toolCallId: "call_0", input: { path: "x.pdf", question: QUESTION } }) as { jobId: string };
    expect(new Set([a.jobId, b.jobId, c.jobId]).size).toBe(3);
    expect(dispatchResearch(env, "call_0").jobId).toBe(a.jobId);
    await env.jobs.whenIdle();
  });

  it("refuses the reserved kinds and an unknown session", () => {
    const env = makeEnv();
    expect(() => env.jobs.dispatcher.dispatch({ kind: "demo" as never, sessionId: env.sessionId, toolCallId: "c", input: {} })).toThrow(/not available/);
    expect(() => env.jobs.dispatcher.dispatch({ kind: "research", sessionId: "chat_unknown", toolCallId: "c", input: {} })).toThrow(/does not exist/);
  });
});

describe("the researcher", () => {
  it("refuses to fetch an address that neither the question nor an earlier search named", async () => {
    let hits = 0;
    const stub = await stubServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>Not to be read.</p></body></html>");
    });
    let toolText = "";
    const env = makeEnv({
      script: ({ n, messages }) => {
        if (n === 1) return { tool: "web_fetch", args: { url: `${stub.base}/secret` } };
        const last = [...(messages ?? [])].reverse().find((m) => m.role === "toolResult") as { content?: { type: string; text?: string }[] } | undefined;
        toolText = (last?.content ?? []).map((c) => c.text ?? "").join(" ");
        return { text: "No page could be read." };
      },
    });
    dispatchResearch(env);
    await env.jobs.whenIdle();
    expect(hits).toBe(0);
    expect(toolText.length).toBeGreaterThan(0);
  });

  it("fetches a page without any search key, completes with sources, and the marker reaches the session", async () => {
    const stub = await stubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><article><h1>Rules</h1>${"<p>The supervisor set the reserve ratio at four percent of deposits for all banks that hold them.</p>".repeat(6)}</article></body></html>`);
    });
    let seen = "";
    const env = makeEnv({
      script: ({ n }) => {
        if (n === 1) return { tool: "web_fetch", args: { url: `${stub.base}/rules` } };
        seen = env.jobs.store.list(env.sessionId)[0].activity;
        return { text: `Summary: four percent.\n\nSources kept: [The rules](${stub.base}/rules)` };
      },
    });
    // the question names the page, which is what lets web_fetch open it
    const { jobId } = dispatchResearch(env, "call_1", { question: `${QUESTION} The rules are at ${stub.base}/rules` });
    await env.jobs.whenIdle();
    const job = env.jobs.store.get(jobId)!;
    expect(job.status).toBe("done");
    expect((job.result as { sources: unknown[] }).sources).toEqual([{ title: "The rules", url: `${stub.base}/rules` }]);
    expect(seen).toContain("127.0.0.1");
    expect(job.usage?.model).toBe("faux:m1");
    expect(env.events.some((e) => e.event === "activity-changed")).toBe(true);
    expect(env.events.filter((e) => e.event === "jobs-changed").every((e) => e.session === env.sessionId)).toBe(true);
    const [marker] = markers(env);
    expect(marker).toMatchObject({ id: `steer_${jobId}`, customType: "subagent-steer" });
    expect((marker as { content: string }).content).toContain("four percent");
    expect(deliveryOf(env, jobId)).toBe("delivered");
  });

  it("states that search is unavailable in the instructions when no key exists", async () => {
    const env = makeEnv({ script: () => ({ text: "No search was possible." }) });
    dispatchResearch(env);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(1);
  });

  it("still steers when the worker fails, so that the teacher learns the outcome", async () => {
    const env = makeEnv({
      script: () => {
        throw new Error("the provider fell over");
      },
    });
    const { jobId } = dispatchResearch(env);
    await env.jobs.whenIdle();
    const job = env.jobs.store.get(jobId)!;
    expect(job.status).toBe("error");
    expect(job.result?.brief.startsWith("Research failed:")).toBe(true);
    expect((job.result as { sources: unknown[] }).sources).toEqual([]);
    expect((markers(env)[0] as { content: string }).content).toContain("did not produce a result");
  });

  it("records an honest failure for a blank question without any model call", async () => {
    const env = makeEnv();
    const { jobId } = dispatchResearch(env, "call_1", { question: "   " });
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(0);
    expect(env.jobs.store.get(jobId)).toMatchObject({ status: "error" });
    expect(markers(env)).toHaveLength(1);
  });

  it("reads the input from the transcript when the saved input is absent", async () => {
    const env = makeEnv({ script: () => ({ text: "Found it." }) });
    env.store.appendMessages(env.sessionId, [toolCallMessage("msg_1", "call_9", "research", { question: "Question from the transcript" })]);
    const job = env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: "call_9", input: {} });
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    const first = env.calls[0].messages.find((m) => m.role === "user")!;
    expect(JSON.stringify(first.content)).toContain("Question from the transcript");
    expect(env.jobs.store.get(job.id)?.status).toBe("done");
  });

  it("lands as an error with the refusal wording when no engine can be resolved", async () => {
    const env = makeEnv();
    env.engineFor.current = async () => ({ refused: "No model is set for this task. Choose one in Settings." });
    const { jobId } = dispatchResearch(env);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(0);
    expect(env.jobs.store.get(jobId)).toMatchObject({ status: "error", error: "No model is set for this task. Choose one in Settings." });
    expect((markers(env)[0] as { content: string }).content).toContain("Choose one in Settings");
  });
});

describe("the PDF reader", () => {
  function pdfFile(env: JobsEnv): string {
    const file = path.join(env.dir, "report.pdf");
    fs.writeFileSync(file, makePdf([proseLines(["The reserve ratio was set at four percent."], { title: "Findings" }), { image: true }, proseLines(["Annex with further figures."])]));
    return file;
  }
  const dispatchPdf = (env: Env, file: string, callId = "call_p") => env.jobs.dispatcher.dispatch({ kind: "pdf", sessionId: env.sessionId, toolCallId: callId, input: { path: file, question: "What is the ratio?" } }) as { jobId: string };

  it("triages, extracts and returns a cited brief whose pages consulted track the pages read", async () => {
    const env = makeEnv({
      script: ({ n }) => {
        if (n === 1) return { tool: "pdf_info", args: { path: "report.pdf" } };
        if (n === 2) return { tool: "pdf_extract", args: { path: "report.pdf", pages: "1" } };
        return { text: "The ratio is four percent (p. 1).\n\nPages consulted: 1" };
      },
    });
    const { jobId } = dispatchPdf(env, pdfFile(env));
    await env.jobs.whenIdle();
    const job = env.jobs.store.get(jobId)!;
    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({ pagesRead: [1], pagesConsulted: [1], question: "What is the ratio?" });
    expect((markers(env)[0] as { content: string }).content).toContain("Pages read: 1");
  });

  it("fails an unreadable source before any model call and still steers", async () => {
    const env = makeEnv();
    const { jobId } = dispatchPdf(env, path.join(env.dir, "missing.pdf"));
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(0);
    const job = env.jobs.store.get(jobId)!;
    expect(job.status).toBe("error");
    expect(job.result?.brief.startsWith("PDF reading failed:")).toBe(true);
    expect(markers(env)).toHaveLength(1);
  });

  it("bounces a brief with no page consulted after one reminder", async () => {
    const env = makeEnv({ script: () => ({ text: "I know the answer without the file." }) });
    const { jobId } = dispatchPdf(env, pdfFile(env));
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(2);
    expect(JSON.stringify(env.calls[1].messages)).toContain("not read any page");
    const job = env.jobs.store.get(jobId)!;
    expect(job.status).toBe("error");
    expect(job.result?.brief).toContain("without reading any page");
  });

  it("sends rendered pages in one user message after the tool results and counts them as read", async () => {
    const env = makeEnv({
      script: ({ n }) => {
        if (n === 1) {
          return {
            tools: [
              { tool: "pdf_render", args: { path: "report.pdf", pages: "1", dpi: 72 } },
              { tool: "pdf_render", args: { path: "report.pdf", pages: "3", dpi: 72 } },
            ],
          };
        }
        return { text: "Both pages show the ratio (p. 1, p. 3)." };
      },
    });
    const { jobId } = dispatchPdf(env, pdfFile(env));
    await env.jobs.whenIdle();
    const second = env.calls[1].messages;
    const roles = second.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["toolResult", "toolResult", "user"]);
    const images = (second[second.length - 1].content as { type: string }[]).filter((p) => p.type === "image");
    expect(images).toHaveLength(2);
    expect(env.jobs.store.get(jobId)?.result).toMatchObject({ pagesRead: [1, 3] });
  });

  it("degrades to an error note for a model that takes no images, while text tools still work", async () => {
    const env = makeEnv();
    const file = pdfFile(env);
    let queued = 0;
    const base = { resolve: () => ({ ok: true as const, abs: file }), read: () => undefined, consulted: () => undefined, activity: () => undefined };
    const noImages = pdfTools({ ...base, render: { imageInput: false, queue: () => void queued++ } });
    const render = noImages.find((t) => t.name === "pdf_render")!;
    const r = await render.execute("c1", { path: "x.pdf", pages: "1" });
    expect(JSON.stringify(r.content)).toContain("takes no images");
    expect(queued).toBe(0);
    const extract = noImages.find((t) => t.name === "pdf_extract")!;
    expect(JSON.stringify((await extract.execute("c2", { path: "x.pdf", pages: "1" })).content)).toContain("reserve ratio");
  });
});

describe("delivery", () => {
  it("hands the marker to the live run through the steering queue, with no wake", async () => {
    const env = makeEnv();
    env.turns.running = true;
    // the run takes the steer, saves it as a message and ends
    env.turns.onSteer = (s) => {
      env.store.appendMessages(env.sessionId, [{ role: "user", id: s.id, content: s.text, timestamp: 1 }]);
      env.turns.running = false;
    };
    const id = seedDone(env);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.turns.steers.map((s) => s.id)).toEqual([`steer_${id}`]);
    expect(env.wakes).toHaveLength(0);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("returns a marker that the run never took to pending and delivers it by an idle wake", async () => {
    const env = makeEnv();
    env.turns.running = true;
    env.turns.onSteer = () => void setTimeout(() => (env.turns.running = false), 15);
    const id = seedDone(env);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.turns.steers).toHaveLength(1);
    expect(env.wakes).toEqual([{ sessionId: env.sessionId, ids: [`steer_${id}`] }]);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("wakes an idle session after a grace of 750 ms with every pending marker in one turn", async () => {
    const env = makeEnv();
    const a = seedDone(env);
    const b = seedDone(env);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.sleeps).toContain(750);
    expect(env.wakes).toHaveLength(1);
    expect(env.wakes[0].ids.sort()).toEqual([`steer_${a}`, `steer_${b}`].sort());
    expect(markers(env)).toHaveLength(2);
    expect(deliveryOf(env, a)).toBe("delivered");
    expect(deliveryOf(env, b)).toBe("delivered");
  });

  it("backs off through 500, 1,000, 2,000 and 5,000 ms after a 409 and then stays at 5,000", async () => {
    let refuse = 5;
    const env = makeEnv({
      wake: (e) => (sid, ms) => {
        if (refuse-- > 0) throw new RuntimeError(409, "A turn is already running for this session.", "turn_running");
        e.wakes.push({ sessionId: sid, ids: ms.map((m) => m.id) });
        e.store.appendMessages(sid, ms);
      },
    });
    const id = seedDone(env);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.sleeps.filter((ms) => ms >= 500 && ms !== 750)).toEqual([500, 1000, 2000, 5000, 5000]);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("is idempotent when the marker is already in the transcript", async () => {
    const env = makeEnv();
    const id = seedDone(env);
    env.store.appendMessages(env.sessionId, [markerMessage(buildSteer(env.jobs.store.get(id)!, "result"), 1)]);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.wakes).toHaveLength(0);
    expect(markers(env)).toHaveLength(1);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("waits while a question is open and fires once it is answered", async () => {
    const env = makeEnv();
    env.store.appendMessages(env.sessionId, [toolCallMessage("msg_q", "call_q", "quiz", {})]);
    const id = seedDone(env);
    env.jobs.sweep(true);
    await wait(60);
    expect(env.wakes).toHaveLength(0);
    expect(deliveryOf(env, id)).toBe("pending");
    env.store.appendMessages(env.sessionId, [{ role: "toolResult", id: "msg_r", toolCallId: "call_q", toolName: "quiz", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 }]);
    await env.jobs.whenIdle();
    expect(env.wakes).toHaveLength(1);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("keeps a failed start quiet across sweeps and lets a learner run revive it", async () => {
    let fail = true;
    let attempts = 0;
    const env = makeEnv({
      wake: (e) => (sid, ms) => {
        attempts++;
        if (fail) throw new RuntimeError(503, "No model is set for this task.", "models_not_configured");
        e.wakes.push({ sessionId: sid, ids: ms.map((m) => m.id) });
        e.store.appendMessages(sid, ms);
      },
    });
    const id = seedDone(env);
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(attempts).toBe(1);
    expect(deliveryOf(env, id)).toBe("pending");
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(attempts).toBe(1);
    fail = false;
    env.jobs.onSettled(env.sessionId);
    await env.jobs.whenIdle();
    expect(attempts).toBe(2);
    expect(deliveryOf(env, id)).toBe("delivered");
  });

  it("recovers a lost wake after a restart without waiting for a poll", async () => {
    // the wake returns but never saves the markers, which is a wake that was lost
    const first = makeEnv({ wake: () => () => undefined });
    const id = seedDone(first);
    first.jobs.sweep(true);
    await first.jobs.whenIdle();
    expect(deliveryOf(first, id)).toBe("pending");
    expect(markers(first)).toHaveLength(0);
    const second = makeEnv({ dir: first.dir });
    expect(second.sessionId).toBe(first.sessionId);
    second.jobs.start();
    await second.jobs.whenIdle();
    expect(second.wakes).toHaveLength(1);
    expect(deliveryOf(second, id)).toBe("delivered");
    expect(markers(second)).toHaveLength(1);
  });

  it("discards the pending deliveries of a deleted session without starting a turn", async () => {
    const env = makeEnv();
    env.turns.running = true;
    const id = seedDone(env);
    env.jobs.sweep(true);
    await wait(20);
    env.jobs.activity.removeJobs(env.sessionId);
    env.turns.running = false;
    await env.jobs.whenIdle();
    expect(env.wakes).toHaveLength(0);
    expect(env.jobs.store.get(id)).toBeNull();
  });

  it("builds the default wake so that a marker saved by an earlier attempt is not saved twice", async () => {
    const env = makeEnv();
    const submitted: unknown[] = [];
    const wake = createWake(env.store, { isRunning: () => false, submit: async (_id, input) => (submitted.push(input), { started: true }) });
    const marker = markerMessage({ id: "steer_job_z", customType: "subagent-steer", content: "text", details: {} }, 1);
    await wake(env.sessionId, [marker]);
    await wake(env.sessionId, [marker]);
    expect(markers(env)).toHaveLength(1);
    expect(submitted).toEqual([{ type: "continue" }, { type: "continue" }]);
    const busy = createWake(env.store, { isRunning: () => true, submit: async () => ({ started: true }) });
    await expect(busy(env.sessionId, [marker])).rejects.toMatchObject({ status: 409 });
  });
});

describe("abort", () => {
  it("stops the loop with Aborted by learner, keeps the usage so far and tells the agent that no result is coming", async () => {
    const env = makeEnv({ script: ({ n, signal }) => (n === 1 ? { tool: "web_fetch", args: { url: "http://127.0.0.1:1/x" } } : untilAborted(signal).then(() => ({ text: "never" }))) });
    const { jobId } = dispatchResearch(env);
    await until(() => env.calls.length === 2, "the second model call");
    expect(env.jobs.activity.computingJobs(env.sessionId)).toEqual([jobId]);
    expect(env.jobs.activity.jobs()).toHaveLength(1);
    expect(env.jobs.activity.jobs()[0]).toMatchObject({ kind: "job", id: jobId, sessionId: env.sessionId, title: "A lesson" });
    expect(env.jobs.abort(jobId)).toBe("ok");
    await env.jobs.whenIdle();
    const job = env.jobs.store.get(jobId)!;
    expect(job).toMatchObject({ status: "error", error: "Aborted by learner", activity: "aborted" });
    expect(job.usage?.model).toBe("faux:m1");
    const [marker] = markers(env);
    expect(marker).toMatchObject({ customType: "subagent-abort", id: `steer_${jobId}` });
    expect((marker as { content: string }).content).toContain("No result is coming");
    expect(deliveryOf(env, jobId)).toBe("delivered");
    expect(env.jobs.activity.jobs()).toHaveLength(0);
  });

  it("reports not found and not running, and refuses to abort a finished worker with a queued result", async () => {
    const env = makeEnv();
    expect(env.jobs.abort("job_unknown")).toBe("not_found");
    env.turns.running = true;
    const id = seedDone(env);
    env.jobs.sweep(true);
    expect(env.jobs.abort(id)).toBe("not_running");
    env.turns.running = false;
    await env.jobs.whenIdle();
    expect(env.jobs.abort(id)).toBe("not_running");
  });
});

describe("recovery and the sweep", () => {
  it("leaves a running job with a live loop alone and re-spawns an orphan without a registration", async () => {
    const env = makeEnv({ script: ({ signal }) => untilAborted(signal).then(() => ({ text: "x" })) });
    const live = dispatchResearch(env, "call_live");
    await until(() => env.calls.length === 1, "the live worker");
    const orphan = env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: "call_orphan", input: { question: QUESTION } });
    env.jobs.sweep(true);
    await until(() => env.calls.length === 2, "the re-spawned worker");
    expect(env.calls).toHaveLength(2);
    expect(env.jobs.store.get(live.jobId)?.status).toBe("running");
    expect(env.jobs.store.get(orphan.id)?.status).toBe("running");
    env.jobs.stop();
    await env.jobs.whenIdle();
  });

  it("re-delivers an orphan that has a stored result without running the model", async () => {
    const env = makeEnv();
    const job = env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: "call_s", input: { question: QUESTION } });
    env.jobs.store.update(job.id, { result: { brief: "A stored brief.", sources: [] } });
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(0);
    expect(env.jobs.store.get(job.id)).toMatchObject({ status: "done" });
    expect((markers(env)[0] as { content: string }).content).toContain("A stored brief.");
  });

  it("runs the sweep at most once in 30 seconds when a list is read", async () => {
    const env = makeEnv({ script: () => ({ text: "A brief." }) });
    env.jobs.list(env.sessionId);
    env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: "call_a", input: { question: QUESTION } });
    env.jobs.list(env.sessionId);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(0);
    env.clock.now += 31_000;
    env.jobs.list(env.sessionId);
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(1);
  });

  it("never replays a legacy finished record that has no delivery note", async () => {
    const env = makeEnv();
    const job = env.jobs.store.create({ chatId: env.sessionId, kind: "research", toolCallId: "call_l", input: { question: QUESTION } });
    env.jobs.store.update(job.id, { status: "done", result: { brief: "Old.", sources: [] } });
    env.jobs.sweep(true);
    await env.jobs.whenIdle();
    expect(markers(env)).toHaveLength(0);
    expect(env.calls).toHaveLength(0);
  });
});

describe("shared permits", () => {
  it("makes a worker wait for one of the background model permits", async () => {
    const gate = new Semaphore(1);
    const held = await gate.acquire();
    const env = makeEnv({ semaphore: gate, script: () => ({ text: "A brief." }) });
    const { jobId } = dispatchResearch(env);
    await wait(40);
    expect(env.calls).toHaveLength(0);
    expect(env.jobs.store.get(jobId)?.status).toBe("running");
    held();
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(1);
    expect(gate.active).toBe(0);
  });

  it("uses the process semaphore of the extraction pipeline when none is injected", async () => {
    const shared = processSemaphore();
    const held = await Promise.all([shared.acquire(), shared.acquire(), shared.acquire()]);
    const env = makeEnv({ deps: { semaphore: undefined }, script: () => ({ text: "A brief." }) });
    dispatchResearch(env);
    await wait(40);
    expect(env.calls).toHaveLength(0);
    held.forEach((release) => release());
    await env.jobs.whenIdle();
    expect(env.calls).toHaveLength(1);
    expect(shared.active).toBe(0);
  });
});

describe("route 27", () => {
  async function serve(env: JobsEnv) {
    const server = http.createServer((req, res) => {
      void handleJobs(env.jobs, req, res, new URL(req.url ?? "/", "http://x").pathname).then((handled) => {
        if (!handled) res.writeHead(404).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("lists the jobs of a session with the turn flag, rejects a bad query and other methods", async () => {
    const env = makeEnv();
    const id = seedDone(env);
    env.turns.running = true;
    const s = await serve(env);
    try {
      const ok = await fetch(`${s.base}/api/learn/jobs?sessionId=${env.sessionId}`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { jobs: { id: string }[]; turnInFlight: boolean };
      expect(body.jobs.map((j) => j.id)).toEqual([id]);
      expect(body.turnInFlight).toBe(true);
      expect((await fetch(`${s.base}/api/learn/jobs`)).status).toBe(400);
      expect((await fetch(`${s.base}/api/learn/jobs?sessionId=a%2Fb`)).status).toBe(400);
      const post = await fetch(`${s.base}/api/learn/jobs?sessionId=${env.sessionId}`, { method: "POST" });
      expect(post.status).toBe(405);
      expect((await fetch(`${s.base}/api/learn/other`)).status).toBe(404);
    } finally {
      env.turns.running = false;
      env.jobs.stop();
      await env.jobs.whenIdle();
      await s.close();
    }
  });
});

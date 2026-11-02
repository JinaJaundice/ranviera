// The jobs service: dispatch, the workers, abort, recovery after a restart, the stale job sweep and the activity
// feed. A dispatch saves the job and its input, answers at once and starts the worker in the background. The worker
// takes one of the three permits for background model work, which the extraction pipeline shares. When the worker
// ends, the job record is saved with its result and the delivery of the marker begins. A failure still reports, so
// that the session learns the outcome and is not left waiting.
import fs from "node:fs";
import type { ActivityItem, JobKind, JobRecord, JobsResponse, PdfResult, ResearchResult } from "../../../../shared/learn/index.ts";
import { AbortedError, processSemaphore } from "../extract/semaphore.ts";
import type { JobDispatcher } from "../method/deps.ts";
import type { ActivityProviders } from "../runtime/deps.ts";
import { RuntimeError, badRequest, notFound } from "../runtime/errors.ts";
import { isSafeId } from "../runtime/ids.ts";
import { Delivery } from "./delivery.ts";
import { buildSteer, failureResult, isFailureResult, UsageFolder } from "./steer.ts";
import { createJobStore, type JobStore } from "./store.ts";
import type { JobEngine, JobRole, JobsDeps } from "./types.ts";
import { makeJobDir, preparePdf, runPdfReader, runResearcher } from "./workers.ts";

export const SWEEP_INTERVAL_MS = 30_000;

export interface JobsService {
  readonly store: JobStore;
  readonly dispatcher: JobDispatcher;
  /** the members of ActivityProviders that belong to jobs */
  readonly activity: Required<Pick<ActivityProviders, "jobs" | "computingJobs" | "removeJobs" | "abortJob">>;
  /** Route 27. Runs the stale job sweep, at most once in 30 seconds. */
  list(sessionId: string): JobsResponse;
  abort(id: string): "ok" | "not_found" | "not_running";
  /** The sweep: restores pending deliveries and re-starts orphans. The throttle applies unless forced. */
  sweep(force?: boolean): void;
  /** Restores pending deliveries when the process starts, with no poll. */
  start(): void;
  stop(): void;
  /** The composition root calls this when a turn settles, so that quiet deliveries may try again. */
  onSettled(sessionId: string): void;
  /** Resolves when the workers and the delivery loops that run now have ended. */
  whenIdle(): Promise<void>;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function createJobs(deps: JobsDeps): JobsService {
  const now = deps.now ?? Date.now;
  const interval = deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const store = createJobStore({ learnDir: deps.learnDir, emit: deps.emit, now });
  const semaphore = deps.semaphore ?? processSemaphore();
  const live = new Map<string, AbortController>();
  const workers = new Set<Promise<void>>();
  let lastSweep = -Infinity;
  let stopped = false;

  const announceActivity = () => deps.emit({ type: "learn", event: "activity-changed" });

  const delivery = new Delivery({
    store: deps.store,
    turns: deps.turns,
    wake: deps.wake,
    now: deps.now,
    sleep: deps.sleep,
    log: deps.log,
    wakeGraceMs: deps.wakeGraceMs,
    pollMs: deps.pollMs,
    backoffMs: deps.backoffMs,
    markDelivered(jobId) {
      const job = store.get(jobId);
      if (job?.delivery && job.delivery.status !== "delivered") store.update(jobId, { delivery: { kind: job.delivery.kind, status: "delivered" } });
    },
  });

  /** The input of a job: the saved one, else the arguments of the tool call in the transcript. */
  function inputOf(job: JobRecord): Record<string, unknown> {
    const wanted = job.kind === "research" ? ["question"] : ["path", "question"];
    if (wanted.every((k) => typeof job.input?.[k] === "string")) return job.input;
    const record = deps.store.get(job.chatId);
    for (const m of record?.messages ?? []) {
      if (m.role !== "assistant") continue;
      for (const block of m.content) {
        if (block.type === "toolCall" && block.id === job.toolCallId) return { ...block.arguments };
      }
    }
    return job.input ?? {};
  }

  function enqueueResult(job: JobRecord): void {
    if (!job.delivery) return;
    delivery.queue(job.chatId, job.id, buildSteer(job, job.delivery.kind));
  }

  /** Saves the outcome of a worker and starts the delivery. Does nothing when the job was aborted meanwhile. */
  function finish(id: string, outcome: { result?: ResearchResult | PdfResult; error?: string }): void {
    const job = store.get(id);
    if (!job || job.status !== "running") return;
    const input = inputOf(job);
    const failed = outcome.error !== undefined || isFailureResult(job.kind, outcome.result);
    const result = outcome.error !== undefined ? failureResult(job.kind, input, outcome.error) : (outcome.result ?? failureResult(job.kind, input, "The job returned nothing."));
    const saved = store.update(id, {
      status: failed ? "error" : "done",
      activity: failed ? "failed" : "finished",
      result,
      ...(failed ? { error: outcome.error ?? result.brief } : {}),
      delivery: { kind: "result", status: "pending" },
    });
    announceActivity();
    if (saved) enqueueResult(saved);
  }

  async function execute(job: JobRecord, controller: AbortController): Promise<void> {
    const input = inputOf(job);
    const role: JobRole = job.kind === "research" ? "researcher" : "pdfReader";
    const question = text(input.question).trim();
    if (!question) return finish(job.id, { error: job.kind === "research" ? "The research question is missing or blank, so no search was made." : "The question about the PDF is missing or blank, so the file was not read." });
    if (job.kind === "pdf" && !text(input.path).trim()) return finish(job.id, { error: "The path of the PDF is missing, so the file was not read." });
    const picked = await deps.models.engine(role, job.chatId);
    if ("refused" in picked) return finish(job.id, { error: picked.refused });
    const engine: JobEngine = picked;
    // a file that cannot be read fails here, before any model call
    let abs = "";
    if (job.kind === "pdf") {
      const prepared = await preparePdf(deps, engine, text(input.path));
      if ("failure" in prepared) return finish(job.id, { error: prepared.failure });
      abs = prepared.abs;
    }
    const release = await semaphore.acquire(controller.signal);
    const jobDir = makeJobDir(deps, job.id);
    const folder = new UsageFolder(`${engine.ref.provider}:${engine.ref.id}`);
    const ctx = {
      deps,
      engine,
      signal: controller.signal,
      onUsage: (call: Parameters<UsageFolder["add"]>[0]) => {
        store.update(job.id, { usage: folder.add(call) });
      },
      activity: (line: string) => {
        if (store.get(job.id)?.status === "running") store.update(job.id, { activity: line });
      },
    };
    try {
      store.update(job.id, { activity: job.kind === "research" ? "researching" : "reading the PDF" });
      const result =
        job.kind === "research"
          ? await runResearcher(ctx, { question, ...(text(input.context) ? { context: text(input.context) } : {}) }, jobDir)
          : await runPdfReader(ctx, { path: text(input.path), question }, abs);
      finish(job.id, { result });
    } finally {
      release();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /** Runs a job. A job that is not running, or that already has a worker, is left alone. */
  function runJob(id: string): void {
    const job = store.get(id);
    if (!job || job.status !== "running" || live.has(id) || stopped) return;
    const controller = new AbortController();
    live.set(id, controller);
    const done = (async () => {
      try {
        await execute(job, controller);
      } catch (e) {
        // an abort was recorded by abort(), and anything else still reports to the session
        if (!(e instanceof AbortedError) && !controller.signal.aborted) {
          finish(id, { error: e instanceof Error && e.message ? e.message : "The job failed." });
        }
      } finally {
        live.delete(id);
      }
    })();
    workers.add(done);
    void done.finally(() => workers.delete(done));
  }

  function abort(id: string): "ok" | "not_found" | "not_running" {
    const job = store.get(id);
    if (!job) return "not_found";
    // a finished worker with a queued result belongs to the session and cannot be aborted
    if (job.status !== "running") return "not_running";
    live.get(id)?.abort();
    const saved = store.update(id, { activity: "aborted", delivery: { status: "pending", kind: "abort" }, error: "Aborted by learner", status: "error" });
    announceActivity();
    if (saved) enqueueResult(saved);
    return "ok";
  }

  /** Brings the jobs back to a consistent state. A job that has a live worker is never touched. */
  function recover(): void {
    if (deps.readOnly?.()) return;
    for (const job of store.list()) {
      if (live.has(job.id)) continue;
      if (job.status === "running") {
        if (job.result) finish(job.id, { result: job.result });
        else runJob(job.id);
        continue;
      }
      if (job.delivery?.status === "pending") {
        if (delivery.isQuiet(job.chatId) && delivery.pending(job.chatId).includes(`steer_${job.id}`)) continue;
        if (!deps.store.get(job.chatId)) continue;
        enqueueResult(job);
      }
    }
  }

  function sweep(force = false): void {
    if (deps.readOnly?.()) return;
    if (!force && now() - lastSweep < interval) return;
    lastSweep = now();
    recover();
  }

  const dispatcher: JobDispatcher = {
    dispatch(request) {
      const kind = request.kind as JobKind | string;
      if (kind !== "research" && kind !== "pdf") throw new RuntimeError(400, "That kind of job is not available in this build.", "bad_request");
      if (!isSafeId(request.sessionId) || !deps.store.get(request.sessionId)) throw notFound("That session does not exist.");
      if (!request.toolCallId) throw badRequest("A job needs the identifier of the tool call.");
      // A provider may reuse an identifier from one response to the next, so a repeat is the same job only when the
      // kind and the input agree as well. A replayed call carries all three.
      const wanted = JSON.stringify(request.input ?? {});
      const existing = store
        .list(request.sessionId)
        .filter((j) => j.toolCallId === request.toolCallId && j.kind === kind && JSON.stringify(j.input) === wanted)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (existing) return { jobId: existing.id };
      const job = store.create({ chatId: request.sessionId, kind, toolCallId: request.toolCallId, input: { ...request.input } });
      announceActivity();
      // the worker starts after this call has returned its acknowledgement
      queueMicrotask(() => runJob(job.id));
      return { jobId: job.id };
    },
  };

  return {
    store,
    dispatcher,
    activity: {
      jobs(): ActivityItem[] {
        return store
          .list()
          .filter((j) => j.status === "running")
          .map((j) => ({
            kind: "job" as const,
            id: j.id,
            sessionId: j.chatId,
            title: deps.store.get(j.chatId)?.title ?? j.chatId,
            phase: `${j.kind}: ${j.activity}`,
            startedAt: j.createdAt,
          }))
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      },
      computingJobs: (sessionId) => store.list(sessionId).filter((j) => j.status === "running").map((j) => j.id),
      removeJobs(sessionId) {
        delivery.discard(sessionId);
        store.removeForChat(sessionId);
        announceActivity();
      },
      abortJob: abort,
    },
    list(sessionId) {
      if (!isSafeId(sessionId)) throw badRequest("The query needs a sessionId that uses letters, digits, underscores and hyphens only.");
      sweep();
      return { jobs: store.list(sessionId), turnInFlight: deps.turns.isRunning(sessionId) };
    },
    abort,
    sweep,
    start() {
      stopped = false;
      lastSweep = now();
      recover();
    },
    stop() {
      stopped = true;
      for (const c of live.values()) c.abort();
    },
    onSettled(sessionId) {
      delivery.resume(sessionId);
    },
    async whenIdle() {
      for (;;) {
        await Promise.all([...workers]);
        await delivery.whenIdle();
        if (!workers.size) return;
      }
    },
  };
}

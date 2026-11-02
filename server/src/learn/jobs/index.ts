// Background jobs: the researcher on the cheap slot and the PDF reader on the vision slot. Phase 10 owns this folder.
// The composition root (server/src/learn/index.ts) is wired by the integration builder, and it uses these exports:
//
//   const jobs = createJobs({ learnDir, store, turns, wake: createWake(store, turns), models: createJobModels(models),
//                             keys: models.keys, policy, emit, ... });
//   method deps:   { jobs: jobs.dispatcher }
//   runtime deps:  { activity: jobs.activity, onSettled: (id) => jobs.onSettled(id) }
//   router:        handleJobs(jobs, req, res, path)   (route 27)
//   start / stop:  jobs.start() and jobs.stop()
import type { SessionStore } from "../runtime/store.ts";
import type { TurnService } from "../runtime/turns.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { WakeFn } from "./types.ts";

export { createJobs, SWEEP_INTERVAL_MS, type JobsService } from "./service.ts";
export { handleJobs } from "./http.ts";
export { createJobModels, type SessionGate } from "./models.ts";
export { createJobStore, newJobId, type JobStore } from "./store.ts";
export { buildSteer, steerIdOf, markerMessage, failureResult, isFailureResult, RESEARCH_FAILURE, PDF_FAILURE } from "./steer.ts";
export { Delivery, WAKE_GRACE_MS, POLL_MS, BACKOFF_MS } from "./delivery.ts";
export type { JobEngine, JobKeys, JobModels, JobRefusal, JobRole, JobsDeps, WakeFn } from "./types.ts";

/**
 * The idle wake of the runtime: saves the markers and starts one turn that continues from them. It answers 409 when a
 * turn is running, before it saves anything. The turn starts only if scans.needsContinuation treats a trailing
 * subagent-steer or subagent-abort marker as a place to continue (see docs/learning/jobs.md, "Contract changes proposed").
 */
export function createWake(store: Pick<SessionStore, "appendMessages" | "get">, turns: Pick<TurnService, "isRunning" | "submit">): WakeFn {
  return async (sessionId, markers) => {
    if (turns.isRunning(sessionId)) throw new RuntimeError(409, "A turn is already running for this session.", "turn_running");
    // a marker that an earlier attempt saved is not saved twice
    const have = new Set((store.get(sessionId)?.messages ?? []).map((m) => m.id));
    const fresh = markers.filter((m) => !have.has(m.id));
    if (fresh.length) store.appendMessages(sessionId, fresh);
    await turns.submit(sessionId, { type: "continue" });
  };
}

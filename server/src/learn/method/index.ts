// The learning method. Phase 8 owns this folder. The merge builds the method
// service from MethodDeps, passes `runtimeHooks()` to the runtime service
// (composer, grader and the two callbacks) and calls handleMethod from
// server/src/learn/http.ts for routes 13 to 15 and 39.
export { createMethodService, type MethodService } from "./service.ts";
export { handleMethod } from "./http.ts";
export { createPromptStore, normaliseKey, type PromptStore } from "./prompt-store.ts";
export { createComposer, endsRun, roleFor } from "./roles.ts";
export { parsePlan, describeProblems } from "./mermaid.ts";
export { createPlanTree, derivePosition, planBlockDetails, taggedNodeIds } from "./plan-tree.ts";
export { phaseOf, phaseSpans, hasProbeDone } from "./phases.ts";
export { gradeAnswer, seededShuffle, displayOptions, toClientQuestion, needsReveal, CONFIDENCE_STOPS, DEFAULT_CONFIDENCE, clampConfidence } from "./questions.ts";
export { readOutcomes, syncOutcomes, outcomeLinesOf, outcomeId } from "./outcomes.ts";
export { computeMetrics, heldBand, calibrationOf } from "./metrics.ts";
export type { JobDispatcher, LearnEvents, MethodDeps, MethodSettings, TargetResolver } from "./deps.ts";

// The adapters: the real implementations of the interfaces that the runtime and the method take as injected
// dependencies (server/src/learn/runtime/deps.ts, server/src/learn/method/deps.ts). Only server/src/learn/index.ts
// builds them.
export { createBrainEvents, claimNodeId, sessionNodeId, type BrainEvents, type EventSink } from "./brain.ts";
export { toRuntimeError, converting } from "./errors.ts";
export { createExtractionActivity, createSessionSource } from "./extraction.ts";
export { createKnowledgeDeletion, createKnowledgeReader, createTargetResolver } from "./knowledge.ts";
export { createModelResolver, createSummariser, type ResolverDeps } from "./models.ts";
export { createPathPolicy } from "./policy.ts";
export { createSessionSensitivity, type SessionGate, type SessionSensitivity } from "./sensitivity.ts";

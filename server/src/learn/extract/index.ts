// The extraction pipeline as a service: a factory over explicit dependencies that reads no global configuration.
// Claude wires it into server/src/learn/index.ts, and server/src/learn/http.ts routes 31, 32, 33 and 45 to it.
export { createExtractModels, type ExtractModels, type StageEngine, type StageRole } from "./engines.ts";
export { handleExtract } from "./http.ts";
export { ExtractService, FILES_IN_FLIGHT, FIRE_LIMIT, type ExtractDeps, type ExtractFire, type FileResult, type SessionSource } from "./pipeline.ts";
export { AbortedError, BACKGROUND_PERMITS, Semaphore, processSemaphore } from "./semaphore.ts";

import { ExtractService, type ExtractDeps } from "./pipeline.ts";

export function createExtract(deps: ExtractDeps): ExtractService {
  return new ExtractService(deps);
}

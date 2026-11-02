// PathPolicy over the sources service: its deny list, and the linked roots that the gate allows for a provider class.
import type { PathPolicy } from "../runtime/deps.ts";
import { rootAllowedFor } from "../models/gate.ts";
import type { SourcesService } from "../sources/index.ts";

export function createPathPolicy(sources: SourcesService): PathPolicy {
  return {
    isDenied: (absPath) => sources.env.deny.isDenied(absPath),
    allowedRoots: (providerClass) =>
      sources
        .list()
        .filter((r) => r.enabled && rootAllowedFor(r, providerClass))
        .map((r) => ({ id: r.id, label: r.label, path: r.path, kind: r.kind, sensitivity: r.sensitivity })),
  };
}

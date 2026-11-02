// Routes 28 and 29: every running turn, job and extraction, and the abort of one
// of them. Turns come from the runtime. Jobs and extractions come from injected
// providers, because their phases own them.
import type { ActivityItem } from "../../../../shared/learn/index.ts";
import type { ActivityProviders } from "./deps.ts";
import { RuntimeError, badRequest, notFound } from "./errors.ts";
import { phaseOf } from "./scans.ts";
import type { SessionStore } from "./store.ts";
import type { TurnService } from "./turns.ts";

/** An identifier of a turn, job or extraction. It may hold a colon and the hash of a source part. */
const SAFE_ACTIVITY_ID = /^[A-Za-z0-9_:#.-]+$/;

export interface Activity {
  list(): ActivityItem[];
  abort(body: { kind?: unknown; id?: unknown }): { ok: true };
}

export function createActivity(deps: { turns: TurnService; store: SessionStore; providers?: ActivityProviders }): Activity {
  return {
    list() {
      const items: ActivityItem[] = [];
      for (const t of deps.turns.running()) {
        const record = deps.store.get(t.sessionId);
        items.push({
          kind: "turn",
          id: t.sessionId,
          sessionId: t.sessionId,
          title: record?.title ?? t.sessionId,
          phase: record ? (record.kind === "practice" ? "practice" : phaseOf(record.messages)) : "teach",
          startedAt: new Date(t.startedAt).toISOString(),
        });
      }
      items.push(...(deps.providers?.jobs?.() ?? []), ...(deps.providers?.extractions?.() ?? []));
      return items.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    abort(body) {
      const kind = body.kind;
      const id = body.id;
      if (kind !== "turn" && kind !== "job" && kind !== "extraction") throw badRequest("The kind must be turn, job or extraction.");
      if (typeof id !== "string" || !SAFE_ACTIVITY_ID.test(id)) throw badRequest("The identifier is not valid.");
      if (kind === "turn") {
        if (!deps.turns.abort(id)) throw new RuntimeError(409, "No turn is running for that session.");
        return { ok: true };
      }
      if (kind === "job") {
        const outcome = deps.providers?.abortJob?.(id) ?? "not_found";
        if (outcome === "not_found") throw notFound("That job does not exist.");
        if (outcome === "not_running") throw new RuntimeError(409, "That job is not running.");
        return { ok: true };
      }
      // aborting an extraction is idempotent
      deps.providers?.abortExtraction?.(id);
      return { ok: true };
    },
  };
}

// The connection of the extraction service to the runtime: the activity items of its runs, the text of a session that
// route 33 extracts, and the start of an extraction when a teaching turn settles.
import type { ActivityItem } from "../../../../shared/learn/index.ts";
import type { ExtractService, SessionSource } from "../extract/index.ts";
import type { UsageRow } from "../extract/usage.ts";
import { sessionView } from "../knowledge/coverage.ts";
import type { ActivityProviders } from "../runtime/deps.ts";
import type { SessionStore } from "../runtime/store.ts";
import type { SessionSensitivity } from "./sensitivity.ts";

/** The extraction runs as rows of the activity dock, and the abort of one run by its run, session or source identifier. */
export function createExtractionActivity(extract: ExtractService): Pick<ActivityProviders, "extractions" | "abortExtraction"> {
  return {
    extractions: (): ActivityItem[] =>
      extract.runs().map((r) => ({ kind: "extraction", id: r.id, sessionId: r.sessionId, title: r.title, phase: r.phase, startedAt: r.startedAt })),
    abortExtraction: (id) => {
      if (extract.abort({ runId: id }) > 0) return;
      if (extract.abort({ sessionId: id }) > 0) return;
      extract.abort({ sourceId: id });
    },
  };
}

/** The extractable view of each learning session: the teacher prose, the title and the derived sensitivity. */
export function createSessionSource(store: Pick<SessionStore, "get" | "list" | "appendExtractionUsage">, sensitivity: SessionSensitivity): SessionSource {
  return {
    get(id) {
      const record = store.get(id);
      if (!record) return null;
      return { title: record.title, sensitivity: sensitivity.of(record).sensitivity, view: sessionView(record.messages) };
    },
    appendUsage(id, usage) {
      if (store.get(id)) store.appendExtractionUsage(id, usage);
    },
    usage(): UsageRow[] {
      const rows: UsageRow[] = [];
      for (const record of store.list()) for (const usage of record.extractions ?? []) rows.push({ id: `${record.id}:${usage.startedAt}`, title: record.title, usage });
      return rows;
    },
  };
}

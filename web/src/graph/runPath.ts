// The entry of a recorded agent run into the brain (docs/BRAIN.md, "Agent runs: the entry from the Oversight window").
// The Graph window calls this when it opens with params.trace, which holds the run id and never the case reference.
import { api } from "../lib/api";
import { bus } from "../lib/bus";
import { getState } from "../lib/store";
import { agentPath } from "./brain/path";
import type { TracePath } from "./brain/types";

/** The graph id of the alert or case that a run names, where the graph on screen holds one. */
export function caseNodeOf(ref: string, ids: Iterable<string>): string | null {
  const wanted = ref.toLowerCase();
  for (const id of ids) {
    const low = id.toLowerCase();
    if (low === wanted || low.endsWith(`:${wanted}`) || low.endsWith(`/${wanted}`)) return id;
  }
  return null;
}

/** Fetch the trace of a run and build its path against the graph on screen. */
export async function runPath(run: string): Promise<TracePath> {
  const trace = await api.oversightTrace(run);
  const byId = getState().byId;
  return agentPath(trace, (id) => byId.has(id), (ref) => caseNodeOf(ref, byId.keys()));
}

/** Show a recorded run as the path of the thought trail. */
export async function openRunPath(run: string): Promise<void> {
  const path = await runPath(run);
  bus.emit("path-open", { path });
}

// Typed calls to routes 30 to 32, 34 to 37 and 50 of docs/CONTRACTS.md ("Routes"), used by the Knowledge layer.
import type { DeletionStats, ExtractionRun, GraphCosts, GraphSnapshot, RatifyClaim, RenderSettings } from "@shared/learn/knowledge";
import type { LocatorLine } from "@shared/learn/sources";
import type { Sensitivity } from "@shared/types";
import { learnRequest } from "./http";

export type Positions = Record<string, { x: number; y: number }>;

export const learnKnowledge = {
  graph: (max?: Sensitivity) => learnRequest<GraphSnapshot>("GET", `graph${max ? `?max=${max}` : ""}`),
  status: async () => (await learnRequest<{ runs: ExtractionRun[] }>("GET", "graph/status")).runs,
  costs: () => learnRequest<GraphCosts>("GET", "graph/costs"),
  commitPositions: async (positions: Positions) => (await learnRequest<{ positions: Positions }>("PUT", "graph/positions", { positions })).positions,
  renderSettings: () => learnRequest<RenderSettings | null>("GET", "graph/render-settings"),
  saveRenderSettings: (settings: RenderSettings) => learnRequest<RenderSettings>("PUT", "graph/render-settings", settings),
  deleteNode: (id: string) => learnRequest<DeletionStats>("DELETE", `graph/nodes/${encodeURIComponent(id)}`),
  /** Proposed route 51: the passages of one proposition. A build without it answers 404 and the card shows the sources only. */
  locators: async (node: string) => (await learnRequest<{ locators: LocatorLine[] }>("GET", `locators?node=${encodeURIComponent(node)}`)).locators,
  ratify: (claim: RatifyClaim) => learnRequest<{ assertions: number; graphRevision: number }>("POST", "graph/ratify", claim),
};

/** A proposition id n_<hex> names the claim claim:<hex> in the main graph (docs/ONTOLOGY.md). */
export function claimOf(propositionId: string): string {
  return `claim:${propositionId.replace(/^n_/, "")}`;
}

/** The pill of the toolbar: the cost of the last runs, or the words for no price. */
export function costWords(c: GraphCosts | null): string {
  if (!c) return "Cost not read";
  if (c.cost === null) return c.runs.length ? "Not priced" : "No runs yet";
  const text = c.cost > 0 && c.cost < 0.01 ? "Under $0.01" : `$${c.cost.toFixed(2)}`;
  return c.unpriced ? `${text}, ${c.unpriced} not priced` : text;
}

export function statusWords(runs: ExtractionRun[] | null): string {
  if (!runs) return "Status not read";
  if (!runs.length) return "No extraction running";
  if (runs.length > 1) return `${runs.length} extractions running`;
  const phase = { queued: "Queued", extracting: "Reading", waiting: "Waiting", auditing: "Checking", merging: "Adding to the graph" }[runs[0].phase];
  return `${phase}: ${runs[0].title}`;
}

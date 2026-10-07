// The pure parts of the region legend: the contents of each region, the count of nodes and the hottest nodes.
import { REGIONS, type RegionId } from "@shared/brain";
import type { GraphNode } from "@shared/types";
import { regionOfNode } from "../../graph/brain/trail";

/** What Cortex places in each region, in the words of the table in docs/BRAIN.md. */
export const REGION_CONTENTS: Record<RegionId, string> = {
  prefrontal: "Instruction, map, rule and reference files, skills, sections, rules and decisions",
  language: "Concepts, the output style and instructions about writing",
  occipital: "Templates and instructions about decks, charts and design",
  motor: "Tools and launch configurations",
  parietal: "Projects, apps, deliverables, open items, organisations and people",
  memory: "Memory files, record stores and history files",
  basal: "Gates, fault checks and findings",
  thalamus: "Task types and routes",
  cerebellum: "Agents",
  brainstem: "Hooks and scheduled tasks",
};

/** The nodes of each region, counted by the same rule as the scene. */
export function countByRegion(nodes: GraphNode[]): Record<RegionId, number> {
  const out = Object.fromEntries(REGIONS.map((r) => [r.id, 0])) as Record<RegionId, number>;
  for (const n of nodes) out[regionOfNode(n)] += 1;
  return out;
}

/** The hottest nodes of a region: by heat, then by uses and then by label, so that the order is stable. */
export function hottest(nodes: GraphNode[], region: RegionId, limit = 10): GraphNode[] {
  return nodes
    .filter((n) => regionOfNode(n) === region)
    .sort((a, b) => (b.metrics.heat ?? 0) - (a.metrics.heat ?? 0) || b.metrics.uses - a.metrics.uses || a.label.localeCompare(b.label))
    .slice(0, limit);
}

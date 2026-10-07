// The level of detail of the labels over the brain canvas (docs/BRAIN.md, "Visibility and navigation"). Far away, each
// region carries one caption with the name of its category. Close to a region, or once it is focused, the captions give
// way to the labels of its clusters, the largest first. Pure, and tested in lod.test.ts.

/** The camera distance to a region, in scene units, below which its clusters are labelled. */
export const CLOSE_DISTANCE = 200;
export const MAX_CLUSTER_LABELS = 18;
/** over a focus the labels are fewer, so that the neurons of the region stay in view */
export const MAX_FOCUS_CLUSTER_LABELS = 12;

export type LabelLevel = "regions" | "clusters";

/** The level for one region: clusters when the region is focused or the camera is close to it. */
export function labelLevel(distance: number, focused: boolean): LabelLevel {
  return focused || distance < CLOSE_DISTANCE ? "clusters" : "regions";
}

/** A region shows its caption at the far level, and a focused region keeps its caption beside its cluster labels. */
export function showCaption(level: LabelLevel, focused: boolean): boolean {
  return level === "regions" || focused;
}

export interface ClusterLabel {
  key: string;
  count: number;
}

/** The clusters to label: the largest first, ties broken by key so that the choice is stable, at most `max`. */
export function pickClusters<T extends ClusterLabel>(clusters: T[], max = MAX_CLUSTER_LABELS): T[] {
  return clusters
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, max);
}

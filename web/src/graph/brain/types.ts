// Shapes shared by the parts of the brain scene. docs/BRAIN.md is the specification.
import type { Activation } from "@shared/types";
import type { RegionId } from "@shared/brain";
import type { EngineView } from "../engine";

/** One step of the thought trail: one event of the stream, with the nodes it lit (docs/BRAIN.md, "The thought trail"). */
export interface TrailStep {
  n: number;
  kind: string;
  sentence: string;
  /** "recorded" is a step built from a recorded agent run (docs/CONTRACTS.md, "The traced path") */
  mode: "observed" | "predicted" | "recorded";
  ts: string;
  /** the order is the order in which the line visits the nodes of hop 0 */
  activation: Activation[];
  /** a run step only: "recorded", "loaded" or "stated by the agent, cause unverified" */
  label?: string;
  /** the findings shown on this step */
  markers?: PathMarker[];
  /** the ids of nodes of the step that the graph on screen does not hold */
  absent?: string[];
  /** a run step that follows a chain: the hops of the chain, lettered a, b, c, in order (docs/BRAIN.md, "The hops of a chain") */
  hops?: PathHop[];
}

/** One hop of the chain of a cited instruction: a clause, a control, an obligation or a provision, with the status of the link that reaches it. */
export interface PathHop {
  letter: string;
  /** the graph id of the node, or null where the link is missing */
  node: string | null;
  kind: "clause" | "control" | "obligation" | "provision" | "item";
  /** the node named in plain words, for example "FCP 8.2 Comparison of identifiers" (empty where the link is missing) */
  name: string;
  status: "ratified" | "proposed" | "stated" | "missing";
  /** the hop lies on the main line, and otherwise its node is a branch of the step */
  main: boolean;
}

/** A finding shown on the path. The title is the plain title of the finding and never its code. */
export interface PathMarker {
  severity: "violation" | "warning" | "info";
  title: string;
  node: string | null;
}

/** One ordered path through the brain: a prompt (live, replay or plan) or a recorded agent run. */
export interface TracePath {
  /** "live-<n>" for a prompt, "plan-<prompt_hash>", "run-<run>" */
  id: string;
  source: "live" | "replay" | "plan" | "run";
  /** the run reference of a recorded agent run */
  run: string | null;
  steps: TrailStep[];
}

/** One entry of brain-regions.json: a region and a hemisphere, with the range of its points in brain-points.bin. */
export interface RegionEntry {
  id: RegionId | "shell";
  hemisphere: "L" | "R";
  triangles: number;
  centroid: [number, number, number] | null;
  labelAnchor: [number, number, number] | null;
  pointOffset: number;
  pointCount: number;
  byteOffset: number;
}

export interface BrainManifest {
  version: number;
  citation: string;
  coordinates: { span: number };
  points: { count: number; stride: number };
  regions: RegionEntry[];
}

export interface BrainView extends EngineView {
  hiddenRegions: RegionId[];
  /** the opacity of the brain silhouette, from 0 (hidden) to 1 (solid) */
  surface?: number;
}

export interface BrainHooks {
  onSelect: (id: string | null) => void;
  /** a region caption was clicked, so that a window can list the hottest nodes of the region */
  onRegion?: (id: RegionId) => void;
}

/** The methods that the canvas calls on an engine. The force engine of engine.ts and BrainEngine both have them. */
export interface CanvasEngine {
  setData(graph: import("@shared/types").GraphFile, view: BrainView): void;
  fire(activation: Activation[], preview: boolean): void;
  setSelected(id: string | null): void;
  setHighlight(ids: string[]): void;
  focus(id: string): void;
  setAmbient(on: boolean): void;
  refreshTheme(): void;
  setSizeBy(sizeBy: "heat" | "degree"): void;
  setMoreLabels(on: boolean): void;
  measureFps(ms: number): Promise<number>;
  dispose(): void;
}

/** A command of the control group and of the keys of the brain view: zoom, reset and the four preset views. */
export type BrainCommand = "zoom-in" | "zoom-out" | "reset" | "view-left" | "view-right" | "view-top" | "view-front";

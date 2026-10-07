// Shapes shared by the parts of the brain scene. docs/BRAIN.md is the specification.
import type { Activation } from "@shared/types";
import type { RegionId } from "@shared/brain";
import type { EngineView } from "../engine";

/** One step of the thought trail: one event of the stream, with the nodes it lit (docs/BRAIN.md, "The thought trail"). */
export interface TrailStep {
  n: number;
  kind: string;
  sentence: string;
  mode: "observed" | "predicted";
  ts: string;
  activation: Activation[];
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

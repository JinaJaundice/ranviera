// The render settings of routes 35 and 36 as the window uses them. The server sanitises every value again on write, so the
// ladders here only decide which stops a slider offers. A ladder has eleven stops and the default sits at stop five.
import type { RenderSettings } from "@shared/learn/knowledge";

export const LADDERS = {
  nodeSize: [0.25, 0.4, 0.6, 0.9, 1.3, 2, 2.6, 3.5, 5, 8, 12],
  edgeWidth: [0.1, 0.15, 0.3, 0.5, 0.7, 1, 1.3, 1.8, 2.5, 4, 6],
  arrowLength: [0.25, 0.35, 0.55, 0.85, 1.3, 2, 2.8, 4, 5.5, 8, 12],
  labelSize: [0.5, 0.7, 1, 1.4, 2, 3, 4.5, 6, 9, 12, 16],
  clusterLabelSize: [7, 8, 9, 11, 12, 14, 16, 19, 22, 25, 28],
  labelZoom: [0.125, 0.15, 0.2, 0.28, 0.4, 0.5, 0.7, 1, 1.4, 2, 3],
  dilation: [4, 6, 8, 12, 16, 20, 28, 36, 55, 80, 120],
  edgeAlpha: [0.025, 0.04, 0.06, 0.09, 0.14, 0.2, 0.28, 0.4, 0.55, 0.8, 1],
} as const;

export type LadderName = keyof typeof LADDERS;
export type LadderKey = "nodeSize" | "edgeWidth" | "arrowLength" | "labelSize" | "clusterLabelSize" | "labelZoom";

export function defaultSettings(): RenderSettings {
  return {
    sizeUnits: "world",
    nodeSize: 2,
    edgeWidth: 1,
    arrowLength: 2,
    labelZoom: 0.5,
    labelSize: 3,
    clusterLabels: true,
    clusterLabelSize: 14,
    regions: { dilation: 20, blur: 40, bitmap: 256, edgeAlpha: 0.2, enabled: true },
    physics: { chargeStrength: -240, linkStrength: 1, linkDistance: 40, gravity: 0.12, clusterPull: 0.15, velocityDecay: 0.4, depthMode: "off", depthStrength: 0.8, depthSpacing: 60, depthBaseRadius: 220 },
  };
}

/** The stop nearest to a value. A tie goes to the lower stop. */
export function stopOf(value: number, ladder: readonly number[]): number {
  return ladder.reduce((nearest, stop, index) => (Math.abs(stop - value) < Math.abs(ladder[nearest] - value) ? index : nearest), 0);
}

/** A slider position from 0 to 100 in steps of ten, and back. Every position gives a clean number. */
export function positionOf(value: number, ladder: readonly number[]): number {
  return stopOf(value, ladder) * 10;
}

export function valueAt(position: number, ladder: readonly number[]): number {
  const i = Math.min(ladder.length - 1, Math.max(0, Math.round(position / 10)));
  return ladder[i];
}

/** Returns new settings with one ladder value changed. */
export function withLadder(s: RenderSettings, key: LadderKey, position: number): RenderSettings {
  return { ...s, [key]: valueAt(position, LADDERS[key]) };
}

export function withRegion(s: RenderSettings, patch: Partial<RenderSettings["regions"]>): RenderSettings {
  return { ...s, regions: { ...s.regions, ...patch } };
}

/** The label gate is a camera ratio, where smaller means more zoomed in, and the window shows it as a multiple of the default. */
export function gateWords(gate: number): string {
  return `${Number((gate / 0.5).toFixed(2))} times`;
}

/** The settings of the server, or the defaults where it has none yet or a field is missing. */
export function readSettings(raw: RenderSettings | null | undefined): RenderSettings {
  const d = defaultSettings();
  if (!raw) return d;
  return { ...d, ...raw, regions: { ...d.regions, ...raw.regions }, physics: { ...d.physics, ...raw.physics } };
}

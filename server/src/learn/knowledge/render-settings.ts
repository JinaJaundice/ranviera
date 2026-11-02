// Render settings of the knowledge graph: ladders of eleven stops, ranges and
// the sanitiser. It never throws. docs/CONTRACTS.md, "Positions and render
// settings".

import type { RenderSettings } from "../../../../shared/learn/knowledge.ts";

export const LADDERS = {
  nodeSize: [0.25, 0.4, 0.6, 0.9, 1.3, 2, 2.6, 3.5, 5, 8, 12],
  arrowLength: [0.25, 0.35, 0.55, 0.85, 1.3, 2, 2.8, 4, 5.5, 8, 12],
  edgeWidth: [0.1, 0.15, 0.3, 0.5, 0.7, 1, 1.3, 1.8, 2.5, 4, 6],
  labelSize: [0.5, 0.7, 1, 1.4, 2, 3, 4.5, 6, 9, 12, 16],
  clusterLabelSize: [7, 8, 9, 11, 12, 14, 16, 19, 22, 25, 28],
  labelZoom: [0.125, 0.15, 0.2, 0.28, 0.4, 0.5, 0.7, 1, 1.4, 2, 3],
  dilation: [4, 6, 8, 12, 16, 20, 28, 36, 55, 80, 120],
  blur: [10, 14, 18, 24, 32, 40, 52, 64, 80, 100, 120],
  edgeAlpha: [0.025, 0.04, 0.06, 0.09, 0.14, 0.2, 0.28, 0.4, 0.55, 0.8, 1],
} as const;

export const BITMAPS = [128, 192, 256, 384, 512] as const;

export const PHYSICS_RANGES = {
  chargeStrength: [-480, -120],
  linkStrength: [0.25, 4],
  linkDistance: [10, 160],
  gravity: [0.03, 0.48],
  clusterPull: [0.0225, 1],
  velocityDecay: [0.18, 0.9],
  depthStrength: [0.2, 3.2],
  depthSpacing: [15, 240],
  depthBaseRadius: [55, 880],
} as const;

export function defaultRenderSettings(): RenderSettings {
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
    physics: {
      chargeStrength: -240,
      linkStrength: 1,
      linkDistance: 40,
      gravity: 0.12,
      clusterPull: 0.15,
      velocityDecay: 0.4,
      depthMode: "off",
      depthStrength: 0.8,
      depthSpacing: 60,
      depthBaseRadius: 220,
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Snaps to the nearest stop. A tie resolves to the lower stop. A value that is not a number gives the default. */
export function snap(v: unknown, ladder: readonly number[], fallback: number): number {
  if (!finite(v)) return fallback;
  let best = ladder[0];
  for (const stop of ladder) {
    const d = Math.abs(stop - v);
    const bd = Math.abs(best - v);
    if (d < bd || (d === bd && stop < best)) best = stop;
  }
  return best;
}

function clamp(v: unknown, range: readonly [number, number], fallback: number): number {
  if (!finite(v)) return fallback;
  return Math.min(range[1], Math.max(range[0], v));
}

/**
 * Sanitises an incoming record, on read and again on write. A file without
 * sizeUnits "world" is legacy, so nodeSize, arrowLength, labelSize and
 * regions.dilation reset to their defaults and the rest is kept.
 */
export function sanitizeRenderSettings(input: unknown): RenderSettings {
  const d = defaultRenderSettings();
  if (!isObject(input)) return d;
  const legacy = input.sizeUnits !== "world";
  const regionsIn = isObject(input.regions) ? input.regions : {};
  const physicsIn = isObject(input.physics) ? input.physics : {};
  const p = d.physics;
  const depthMode = physicsIn.depthMode === "vertical" || physicsIn.depthMode === "radial" ? physicsIn.depthMode : "off";
  const clusterPull =
    physicsIn.clusterPull === 0 ? 0 : clamp(physicsIn.clusterPull, PHYSICS_RANGES.clusterPull, p.clusterPull);
  return {
    sizeUnits: "world",
    nodeSize: legacy ? d.nodeSize : snap(input.nodeSize, LADDERS.nodeSize, d.nodeSize),
    edgeWidth: snap(input.edgeWidth, LADDERS.edgeWidth, d.edgeWidth),
    arrowLength: legacy ? d.arrowLength : snap(input.arrowLength, LADDERS.arrowLength, d.arrowLength),
    labelZoom: snap(input.labelZoom, LADDERS.labelZoom, d.labelZoom),
    labelSize: legacy ? d.labelSize : snap(input.labelSize, LADDERS.labelSize, d.labelSize),
    clusterLabels: typeof input.clusterLabels === "boolean" ? input.clusterLabels : d.clusterLabels,
    clusterLabelSize: snap(input.clusterLabelSize, LADDERS.clusterLabelSize, d.clusterLabelSize),
    regions: {
      dilation: legacy ? d.regions.dilation : snap(regionsIn.dilation, LADDERS.dilation, d.regions.dilation),
      blur: snap(regionsIn.blur, LADDERS.blur, d.regions.blur),
      bitmap: snap(regionsIn.bitmap, BITMAPS, d.regions.bitmap) as RenderSettings["regions"]["bitmap"],
      edgeAlpha: snap(regionsIn.edgeAlpha, LADDERS.edgeAlpha, d.regions.edgeAlpha),
      // only an explicit false turns the regions off
      enabled: regionsIn.enabled !== false,
    },
    physics: {
      chargeStrength: clamp(physicsIn.chargeStrength, PHYSICS_RANGES.chargeStrength, p.chargeStrength),
      linkStrength: clamp(physicsIn.linkStrength, PHYSICS_RANGES.linkStrength, p.linkStrength),
      linkDistance: clamp(physicsIn.linkDistance, PHYSICS_RANGES.linkDistance, p.linkDistance),
      gravity: clamp(physicsIn.gravity, PHYSICS_RANGES.gravity, p.gravity),
      clusterPull,
      velocityDecay: clamp(physicsIn.velocityDecay, PHYSICS_RANGES.velocityDecay, p.velocityDecay),
      depthMode,
      depthStrength: clamp(physicsIn.depthStrength, PHYSICS_RANGES.depthStrength, p.depthStrength),
      depthSpacing: clamp(physicsIn.depthSpacing, PHYSICS_RANGES.depthSpacing, p.depthSpacing),
      depthBaseRadius: clamp(physicsIn.depthBaseRadius, PHYSICS_RANGES.depthBaseRadius, p.depthBaseRadius),
    },
  };
}

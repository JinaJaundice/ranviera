// Colour and brightness for the graph canvas. The functions here are pure, so that they can be tested without a
// browser. The canvas reads the live token values and passes them in.
import type { Family } from "@shared/types";
import { REGION_IDS, type RegionId } from "@shared/brain";

export type Rgb = [number, number, number];

export const FAMILIES: Family[] = ["instruction", "machinery", "record", "work", "world", "language"];

export const FAMILY_TOKEN: Record<Family, string> = {
  instruction: "--color-fam-instruction",
  machinery: "--color-fam-machinery",
  record: "--color-fam-record",
  work: "--color-fam-work",
  world: "--color-fam-world",
  language: "--color-fam-language",
};

export const REGION_TOKEN = Object.fromEntries(REGION_IDS.map((id) => [id, `--color-region-${id}`])) as Record<RegionId, string>;
export const NEURON_TOKEN = Object.fromEntries(REGION_IDS.map((id) => [id, `--color-neuron-${id}`])) as Record<RegionId, string>;

/** The plain words shown beside each colour in the legend. */
export const FAMILY_WORDS: Record<Family, { name: string; hint: string }> = {
  instruction: { name: "Instructions", hint: "rules, files, skills and task types" },
  machinery: { name: "Machinery", hint: "agents, hooks, tools and gates" },
  record: { name: "Records", hint: "memory files, backlog and decisions" },
  work: { name: "Work", hint: "projects, apps and deliverables" },
  world: { name: "World", hint: "clients, people and instruments" },
  language: { name: "Language", hint: "vocabulary schemes and terms" },
};

export interface Palette {
  families: Record<Family, Rgb>;
  /** the colour of each brain region (docs/BRAIN.md) */
  regions: Record<RegionId, Rgb>;
  /** the brighter, more saturated colour of the neurons of each region, with clear contrast against the background of the theme */
  neurons: Record<RegionId, Rgb>;
  void: Rgb;
  ruleStrong: Rgb;
  signal: Rgb;
  ink: Rgb;
  dark: boolean;
}

/** Parse "#rgb", "#rrggbb" or "rgb(r, g, b)" into channels from 0 to 1. Anything else gives mid grey. */
export function parseCssColor(css: string): Rgb {
  const s = css.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.length === 4 ? s.slice(1).replace(/./g, (c) => c + c) : s.slice(1, 7);
    if (/^[0-9a-f]{6}$/.test(h)) {
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
    }
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return [0.5, 0.5, 0.5];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Build a palette from a token reader, eg token from lib/theme.ts. */
export function readPalette(read: (name: string) => string, dark: boolean): Palette {
  const families = {} as Record<Family, Rgb>;
  for (const f of FAMILIES) families[f] = parseCssColor(read(FAMILY_TOKEN[f]));
  const regions = {} as Record<RegionId, Rgb>;
  const neurons = {} as Record<RegionId, Rgb>;
  for (const id of REGION_IDS) {
    regions[id] = parseCssColor(read(REGION_TOKEN[id]));
    // a theme that does not define a neuron token falls back to its region colour
    neurons[id] = read(NEURON_TOKEN[id]).trim() ? parseCssColor(read(NEURON_TOKEN[id])) : regions[id];
  }
  return {
    families,
    regions,
    neurons,
    void: parseCssColor(read("--color-void")),
    ruleStrong: parseCssColor(read("--color-rule-strong")),
    signal: parseCssColor(read("--color-signal")),
    ink: parseCssColor(read("--color-ink")),
    dark,
  };
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Heat from 0 to 1. A node never used has a null base level and no heat. */
export function heatOf(baseLevel: number | null): number {
  return baseLevel === null || Number.isNaN(baseLevel) ? 0 : sigmoid(baseLevel);
}

/** The resting brightness of a node, as a share of its family colour. */
export function restingBrightness(heat: number): number {
  return 0.35 + 0.55 * Math.min(1, Math.max(0, heat));
}

/** Move a family colour towards the void colour. A level above 1 gives a value above the colour, for the bloom. */
export function shade(fam: Rgb, bg: Rgb, level: number): Rgb {
  return [bg[0] + (fam[0] - bg[0]) * level, bg[1] + (fam[1] - bg[1]) * level, bg[2] + (fam[2] - bg[2]) * level];
}

/** The heat of a node: the compiler's ranked heat when present, else the sigmoid of the base level. */
export function heatOfNode(node: { metrics: { base_level: number | null; heat?: number } }): number {
  const h = node.metrics.heat;
  return typeof h === "number" && Number.isFinite(h) ? Math.min(1, Math.max(0, h)) : heatOf(node.metrics.base_level);
}

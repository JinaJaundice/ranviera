// The derived metrics held and calibration, computed from the outcomes of one
// proposition. The numbers are Cortex proposals of CONTRACTS "Derived metrics"
// and change only through that file. The metrics are never written to a ledger
// and never count as graph truth.
import type { KnowledgeMetrics, OutcomeLine } from "../../../../shared/learn/index.ts";

export const HELD_MIN_OUTCOMES = 2;
export const HELD_RECENT_MISS_WINDOW = 3;
export const CALIBRATION_MIN_ANSWERS = 5;
export const CALIBRATION_BAND = 0.15;
/** Absorbs the rounding of a gap that lies exactly on the band, such as 0.85 less 1. */
const EPSILON = 1e-9;

const LOW_RUNGS = new Set<OutcomeLine["rung"]>([null, "R0", "R1"]);

const byTime = (lines: OutcomeLine[]): OutcomeLine[] =>
  lines.map((line, index) => ({ line, index })).sort((a, b) => a.line.at.localeCompare(b.line.at) || a.index - b.index).map((x) => x.line);

export function heldBand(outcomes: OutcomeLine[]): KnowledgeMetrics["held"] {
  if (outcomes.length === 0) return "unknown";
  const ordered = byTime(outcomes);
  const newest = ordered.slice(-HELD_MIN_OUTCOMES);
  const strong = ordered.length >= HELD_MIN_OUTCOMES && newest.every((o) => o.correct === true && LOW_RUNGS.has(o.rung));
  const structural = ordered.slice(-HELD_RECENT_MISS_WINDOW).some((o) => o.missClass === "structural");
  return strong && !structural ? "held" : "shaky";
}

export function calibrationOf(outcomes: OutcomeLine[]): KnowledgeMetrics["calibration"] {
  const rated = outcomes.filter((o) => o.source === "choice" && typeof o.confidence === "number");
  if (rated.length < CALIBRATION_MIN_ANSWERS) return null;
  const meanConfidence = rated.reduce((sum, o) => sum + (o.confidence as number), 0) / rated.length / 100;
  const accuracy = rated.filter((o) => o.correct === true).length / rated.length;
  const gap = meanConfidence - accuracy;
  const band = Math.abs(gap) <= CALIBRATION_BAND + EPSILON ? "calibrated" : gap > 0 ? "overconfident" : "underconfident";
  return { n: rated.length, meanConfidence, accuracy, gap, band };
}

/** The metrics of one proposition. `support` is the number of distinct sources and sessions, which the knowledge core supplies. */
export function computeMetrics(outcomes: OutcomeLine[], support: number): KnowledgeMetrics {
  const ordered = byTime(outcomes);
  return {
    support,
    held: heldBand(ordered),
    lastTested: ordered.length ? ordered[ordered.length - 1].at : null,
    calibration: calibrationOf(ordered),
  };
}

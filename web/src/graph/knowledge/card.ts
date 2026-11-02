// Pure helpers of the node card: where it sits, and the words for the derived fields of a claim.
import type { GraphSnapshot, KnowledgeMetrics, PropositionView } from "@shared/learn/knowledge";
import type { LocatorLine } from "@shared/learn/sources";
import type { Pt } from "./geometry";

export const CARD_WIDTH = 320;

export interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** The room that a card needs to show without scrolling, in pixels. */
export const CARD_ROOM = 360;

/**
 * The card hangs below the claim, and above it when there is too little room below and more room above. It is kept inside the
 * canvas at the sides and its height is limited to the room it has. `top` is set for a card below and `bottom` for a card above.
 */
export function cardPosition(anchor: Pt, area: { w: number; h: number }, width = CARD_WIDTH, gap = 14): CardPosition {
  const left = Math.min(Math.max(8, anchor.x - width / 2), Math.max(8, area.w - width - 8));
  const below = area.h - anchor.y - gap - 8;
  const above = anchor.y - gap - 8;
  if (below < CARD_ROOM && above > below) return { left, bottom: Math.max(8, area.h - anchor.y + gap), maxHeight: Math.max(120, above) };
  return { left, top: Math.max(8, anchor.y + gap), maxHeight: Math.max(120, below) };
}

export const HELD_WORDS: Record<KnowledgeMetrics["held"], { word: string; tone: "pass" | "hold" | "idle" }> = {
  held: { word: "Held", tone: "pass" },
  shaky: { word: "Shaky", tone: "hold" },
  unknown: { word: "Not yet tested", tone: "idle" },
};

export const BAND_WORDS: Record<NonNullable<KnowledgeMetrics["calibration"]>["band"], string> = {
  calibrated: "Calibrated",
  overconfident: "Overconfident",
  underconfident: "Underconfident",
};

export function percent(v: number): string {
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

/** One plain sentence for the calibration of a claim, or the words for none. */
export function calibrationWords(c: KnowledgeMetrics["calibration"]): string {
  if (!c) return "Not yet measured";
  const answers = `${c.n} ${c.n === 1 ? "answer" : "answers"}`;
  return `${BAND_WORDS[c.band]}. Over ${answers}, the mean confidence was ${percent(c.meanConfidence)} and the accuracy was ${percent(c.accuracy)}.`;
}

export function supportWords(n: number): string {
  return n === 0 ? "No source recorded" : n === 1 ? "1 source or session" : `${n} sources and sessions`;
}

/** The label of a locator button: lines, then the page or heading where it is known. */
export function locatorWords(l: LocatorLine | undefined): string | null {
  if (!l || !l.found || l.startLine === null) return null;
  const lines = l.endLine !== null && l.endLine !== l.startLine ? `Lines ${l.startLine} to ${l.endLine}` : `Line ${l.startLine}`;
  return l.page !== null ? `${lines}, page ${l.page}` : lines;
}

/** The locator of a proposition in one source: the newest line for it. */
export function locatorFor(locators: LocatorLine[], nodeId: string, sourceId: string): LocatorLine | undefined {
  let best: LocatorLine | undefined;
  for (const l of locators) {
    if (l.nodeId === nodeId && l.sourceId === sourceId && (!best || l.at >= best.at)) best = l;
  }
  return best;
}

/** The range that the passage view should open for a locator, a few lines wider each side so that the quote has context. */
export function passageRange(l: LocatorLine | undefined, context = 3): { from: number; to?: number } {
  if (!l || !l.found || l.startLine === null) return { from: 1 };
  return { from: Math.max(1, l.startLine - context), to: (l.endLine ?? l.startLine) + context };
}

export interface SourceRef {
  id: string;
  label: string;
  kind: "session" | "file";
}

/** The sources and sessions in the provenance of a claim, each once, in the order they were recorded. */
export function sourcesOf(p: PropositionView, snap: Pick<GraphSnapshot, "sessions" | "fileSources">): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const point of p.provenance) {
    if (seen.has(point.chatId)) continue;
    seen.add(point.chatId);
    const session = snap.sessions[point.chatId];
    const file = snap.fileSources[point.chatId];
    if (session) out.push({ id: point.chatId, label: session, kind: "session" });
    else if (file) out.push({ id: point.chatId, label: file, kind: "file" });
  }
  return out;
}

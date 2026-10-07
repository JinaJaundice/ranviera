import { MODAL_WORDS } from "../../components/InlineMd";
// Pure helpers for the Graph window: the properties shown for a node, its relations grouped by label, the weekly
// strip of its use, and the clock of the replay. Tested in inspect.test.ts.
import type { GraphEdge, GraphNode, Provenance, RelationDef } from "@shared/types";

export interface PropRow {
  label: string;
  value: string;
}

function text(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function pick(props: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = text(props[k]);
    if (v) return v;
  }
  return "";
}

/** The class-specific properties of a node as label and value rows. Empty values are left out. */
export function propRows(node: GraphNode): PropRow[] {
  const p = node.props ?? {};
  const rows: PropRow[] = [];
  const add = (label: string, value: string, fallback = "") => {
    const v = value || fallback;
    if (v) rows.push({ label, value: v });
  };
  switch (node.type) {
    case "Rule":
      add("Rule text", pick(p, ["text"]));
      add("Modal verb", MODAL_WORDS[pick(p, ["modal"])] ?? pick(p, ["modal"]), "Statement");
      add("Date given", node.date ?? pick(p, ["givenOn", "given_on"]), "Undated");
      add("Section", pick(p, ["section", "heading"]));
      break;
    case "Agent":
      add("Model", pick(p, ["model"]));
      add("Effort", pick(p, ["effort"]));
      add("Tools", pick(p, ["tools"]));
      break;
    case "Hook":
      add("Event", pick(p, ["event"]));
      add("Matcher", pick(p, ["matcher"]), "Any");
      add("Command", pick(p, ["command"]));
      break;
    case "Concept":
      add("Preferred form", pick(p, ["prefLabel"]), node.label);
      add("Accepted forms", pick(p, ["altLabels"]));
      add("Forms to avoid", pick(p, ["hiddenLabels"]));
      add("Definition", pick(p, ["definition"]), node.summary ?? "");
      break;
    default: {
      for (const [k, v] of Object.entries(p)) {
        if (rows.length >= 6) break;
        const t = text(v);
        if (t && t.length <= 200) rows.push({ label: k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase()), value: t });
      }
    }
  }
  return rows;
}

export interface RelGroup {
  key: string;
  label: string;
  ids: string[];
  /** where each related node's edge comes from; absent for graphs built before provenance was recorded */
  prov: Record<string, Provenance | undefined>;
}

/** Provenance in plain words, for the Inspector. */
export const PROVENANCE_WORDS: Record<Provenance, string> = {
  stated: "stated in a file",
  computed: "computed from text",
  ratified: "reviewed",
  proposed: "not yet reviewed",
  inferred: "derived by a rule",
};

// When two edges join the same pair under one label, the better established source is shown.
const PROVENANCE_RANK: Provenance[] = ["stated", "ratified", "computed", "inferred", "proposed"];

function better(a: Provenance | undefined, b: Provenance | undefined): Provenance | undefined {
  if (!a) return b;
  if (!b) return a;
  return PROVENANCE_RANK.indexOf(a) <= PROVENANCE_RANK.indexOf(b) ? a : b;
}

/** The relations of a node grouped by label: the label for an outgoing edge and the inverse label for an incoming one. */
export function groupRelations(id: string, edges: GraphEdge[], relations: RelationDef[]): RelGroup[] {
  const defs = new Map(relations.map((r) => [r.id, r]));
  const groups = new Map<string, RelGroup>();
  const add = (label: string, other: string, prov: Provenance | undefined) => {
    let g = groups.get(label);
    if (!g) {
      g = { key: label, label, ids: [], prov: {} };
      groups.set(label, g);
    }
    if (!g.ids.includes(other)) g.ids.push(other);
    g.prov[other] = better(g.prov[other], prov);
  };
  for (const e of edges) {
    const def = defs.get(e.r);
    if (e.s === id) add(def?.label ?? e.r, e.t, e.provenance);
    if (e.t === id) add(def?.inverse_label ?? `${e.r} (incoming)`, e.s, e.provenance);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label));
}

const WEEK_MS = 7 * 86_400_000;

function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday is 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Events per week for the last `weeks` weeks, oldest first, the last entry being the week of `now`. */
export function weekBuckets(events: { ts: string }[], now: number, weeks = 12): number[] {
  const out = new Array<number>(weeks).fill(0);
  const current = weekStart(now);
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const back = Math.round((current - weekStart(t)) / WEEK_MS);
    if (back >= 0 && back < weeks) out[weeks - 1 - back] += 1;
  }
  return out;
}

// -------------------------------------------------------------------- replay

export const DAY_REAL_MS = 4000;
const DAY_MS = 86_400_000;

/** The time inside the replay, given the time the replay has run. One day takes 4 seconds. */
export function virtualAt(startMs: number, elapsedMs: number): number {
  return startMs + elapsedMs * (DAY_MS / DAY_REAL_MS);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as "Mon 28 Sep 2026", in UTC, so that it does not depend on the locale of the machine. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The index of the first event not yet due, given events sorted by time, a start index and the replay clock. */
export function advance<T extends { ts: string }>(items: { event: T }[], from: number, nowMs: number): number {
  let i = from;
  while (i < items.length && Date.parse(items[i].event.ts) <= nowMs) i += 1;
  return i;
}

// Usage of extraction runs: the tally of a live run, the idempotent append to a source record and the cost summary of
// route 32 (docs/CONTRACTS.md, "Sessions" and "Routes").
import type { ExtractionRunUsage, GraphCosts, SourceRecord } from "../../../../shared/learn/knowledge.ts";
import type { CallUsage } from "../../../../shared/learn/sessions.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { callCost, type PriceLookup } from "../models/pricing.ts";
import type { MergeStats } from "./merge-run.ts";
import type { StageTally } from "./types.ts";

/** The calls of a run, by stage. The tally is live, so an abort or a failure still holds the spend so far. */
export class RunTally {
  extractor: StageTally | null = null;
  auditor: StageTally | null = null;

  stage(role: "extractor" | "auditor", model: string): (usage: CallUsage) => void {
    const tally: StageTally = (this[role] ??= { model, steps: [] });
    return (usage) => tally.steps.push(usage);
  }

  /** The usage record of the run. A stage with no call is left out. */
  record(startedAt: number, at: string, durationMs: number, stats?: MergeStats): ExtractionRunUsage {
    const stages: ExtractionRunUsage["stages"] = {};
    if (this.extractor && this.extractor.steps.length > 0) stages.extractor = { model: this.extractor.model, steps: [...this.extractor.steps] };
    if (this.auditor && this.auditor.steps.length > 0) stages.auditor = { model: this.auditor.model, steps: [...this.auditor.steps] };
    return { startedAt, at, durationMs, ...(stats ? { stats } : {}), stages };
  }
}

/** Appends a usage record to a source record in graph/sources.json. A repeat of the same startedAt and an unknown source change nothing. */
export function appendSourceUsage(knowledge: Knowledge, sourceId: string, usage: ExtractionRunUsage): boolean {
  const store = knowledge.store;
  const file = store.graphFile("sources.json");
  const all = store.readJson<Record<string, SourceRecord>>(file);
  const record = all && typeof all === "object" && !Array.isArray(all) ? all[sourceId] : undefined;
  if (!all || !record) return false;
  const held = record.extractions ?? [];
  if (held.some((u) => u.startedAt === usage.startedAt)) return false;
  all[sourceId] = { ...record, extractions: [...held, usage] };
  store.writeGraphJson("sources.json", all);
  return true;
}

/** The cost of a run in dollars, zero when it made no call, and null when any call cannot be priced. */
export function runCost(usage: ExtractionRunUsage, lookup: PriceLookup): number | null {
  let sum = 0;
  for (const stage of [usage.stages.extractor, usage.stages.auditor]) {
    if (!stage) continue;
    const sep = stage.model.indexOf(":");
    const model = sep > 0 ? lookup(stage.model.slice(0, sep), stage.model.slice(sep + 1)) : undefined;
    for (const step of stage.steps) {
      const c = callCost(model, step);
      if (c === null) return null;
      sum += c;
    }
  }
  return sum;
}

export interface UsageRow {
  id: string;
  title: string;
  usage: ExtractionRunUsage;
}

const MAX_RUNS = 10;

/**
 * The summary of route 32. The total adds the runs that can be priced. A history in which no run can be priced shows no
 * total, because an unknown cost is not zero. The ten newest runs are listed, newest first.
 */
export function foldCosts(rows: UsageRow[], lookup: PriceLookup): GraphCosts {
  const costed = rows.map((r) => ({ r, cost: runCost(r.usage, lookup) }));
  const priced = costed.filter((c) => c.cost !== null);
  const unpriced = costed.length - priced.length;
  const total = priced.reduce((n, c) => n + (c.cost as number), 0);
  const newest = [...costed].sort((a, b) => b.r.usage.startedAt - a.r.usage.startedAt).slice(0, MAX_RUNS);
  return {
    cost: costed.length > 0 && priced.length === 0 ? null : total,
    unpriced,
    runs: newest.map(({ r, cost }) => ({
      id: r.id,
      title: r.title,
      at: r.usage.at,
      cost,
      ...(r.usage.stats ? { stats: { nodes: r.usage.stats.nodes, chains: r.usage.stats.chains } } : {}),
    })),
  };
}

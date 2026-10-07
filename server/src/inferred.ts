// The facts that the rules derived, read from inferred.json in the data folder.
import path from "node:path";
import type { InferredFact, InferredFile, InferredRule } from "../../shared/types.ts";
import { readJsonFile } from "./util.ts";

export const MAX_FACTS = 500;

/** An argument as the rules wrote it, without the quotes or angle brackets of the Nemo form. */
const bare = (a: string): string => a.replace(/^["<]+|[">]+$/g, "");

export function filterFacts(facts: InferredFact[], node: string | null, kind: string | null, limit = MAX_FACTS): InferredFact[] {
  const out: InferredFact[] = [];
  for (const f of facts) {
    if (kind && f.kind !== kind) continue;
    if (node && !f.args.some((a) => bare(a) === node)) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

export class InferredStore {
  file: InferredFile | null = null;
  private dir: string;

  constructor(dataDir: string) {
    this.dir = dataDir;
  }

  reload(): void {
    const f = readJsonFile<InferredFile>(path.join(this.dir, "inferred.json"));
    this.file = f && Array.isArray(f.facts) && Array.isArray(f.rules) ? f : null;
  }

  query(node: string | null, kind: string | null): { rules: InferredRule[]; facts: InferredFact[] } {
    const f = this.file;
    if (!f) return { rules: [], facts: [] };
    return { rules: f.rules, facts: filterFacts(f.facts, node, kind) };
  }

  /** The summary that /api/status reports, or null when inferred.json does not exist. */
  summary(): { engine: string | null; facts: number; built: string } | null {
    const f = this.file;
    if (!f) return null;
    return { engine: f.engine ? `${f.engine.name} ${f.engine.version}` : null, facts: f.facts.length, built: f.built };
  }
}

// Scoring of the extraction evaluation set (kg/tests/fixtures/extraction_eval). A person runs the set against a
// configured model with scripts/learn/eval-extraction.mjs. This module holds only the scoring, so tests can check it
// without a model.
import fs from "node:fs";
import path from "node:path";

export interface ExpectedClaim {
  id: string;
  text: string;
  /** words that a matching proposition must contain, in any case */
  mustInclude: string[];
}

export interface EvalExpected {
  version: 1;
  /** phrases that mark a statement about the note and not about the world */
  notClaims: string[];
  files: Record<string, { claims: ExpectedClaim[] }>;
}

export interface Produced {
  file: string;
  statement: string;
  aliases?: string[];
}

export interface FileScore {
  expected: number;
  matched: string[];
  missed: string[];
  produced: number;
  matchingProduced: number;
}

export interface EvalScore {
  recall: number;
  precision: number;
  expected: number;
  produced: number;
  matchingProduced: number;
  /** produced statements that talk about the note itself */
  aboutTheNote: number;
  files: Record<string, FileScore>;
}

export function loadExpected(dir: string): EvalExpected {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
  const v = raw as Partial<EvalExpected>;
  if (!v || v.version !== 1 || !v.files || !Array.isArray(v.notClaims)) throw new Error("expected.json is not an evaluation file of version 1.");
  return v as EvalExpected;
}

const texts = (p: Produced): string => [p.statement, ...(p.aliases ?? [])].join(" ").toLowerCase();
const contains = (text: string, claim: ExpectedClaim): boolean => claim.mustInclude.every((w) => text.includes(w.toLowerCase()));

/** Recall counts expected claims that some proposition of the same file matches. Precision counts propositions that match some expected claim of their file. */
export function scoreExtraction(expected: EvalExpected, produced: Produced[]): EvalScore {
  const files: Record<string, FileScore> = {};
  let expectedTotal = 0;
  let matchedTotal = 0;
  let matchingProduced = 0;
  for (const [file, spec] of Object.entries(expected.files)) {
    const mine = produced.filter((p) => p.file === file);
    const matched = spec.claims.filter((c) => mine.some((p) => contains(texts(p), c)));
    const good = mine.filter((p) => spec.claims.some((c) => contains(texts(p), c)));
    files[file] = {
      expected: spec.claims.length,
      matched: matched.map((c) => c.id),
      missed: spec.claims.filter((c) => !matched.includes(c)).map((c) => c.id),
      produced: mine.length,
      matchingProduced: good.length,
    };
    expectedTotal += spec.claims.length;
    matchedTotal += matched.length;
    matchingProduced += good.length;
  }
  const about = produced.filter((p) => expected.notClaims.some((n) => p.statement.toLowerCase().includes(n.toLowerCase()))).length;
  return {
    recall: expectedTotal === 0 ? 0 : matchedTotal / expectedTotal,
    precision: produced.length === 0 ? 0 : matchingProduced / produced.length,
    expected: expectedTotal,
    produced: produced.length,
    matchingProduced,
    aboutTheNote: about,
    files,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** A short report in plain sentences. */
export function formatReport(score: EvalScore): string {
  const out = [
    `Recall ${pct(score.recall)}: ${Math.round(score.recall * score.expected)} of ${score.expected} expected claims were found.`,
    `Precision ${pct(score.precision)}: ${score.matchingProduced} of ${score.produced} propositions match an expected claim.`,
    `Statements about the note itself: ${score.aboutTheNote}.`,
  ];
  for (const [file, f] of Object.entries(score.files)) {
    out.push(`${file}: found ${f.matched.length} of ${f.expected}${f.missed.length ? `, missed ${f.missed.join(", ")}` : ""}, produced ${f.produced}.`);
  }
  return out.join("\n");
}

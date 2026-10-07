import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InferredFact, InferredFile } from "../../shared/types.ts";
import { filterFacts, InferredStore, MAX_FACTS } from "./inferred.ts";

const fact = (kind: string, rule: string, ...args: string[]): InferredFact => ({ key: `${kind}(${args.join(",")})`, rule, kind, args, proof: null });

const FILE: InferredFile = {
  v: 1,
  built: "2026-10-06T09:00:00Z",
  engine: { name: "nemo", version: "0.10.1" },
  rules: [
    { id: "R04", kind: "violation", message: "Two active rules conflict.", text: "violation(...)" },
    { id: "R05", kind: "inference", message: "A rule applies to a task type.", text: "inferred(...)" },
  ],
  facts: [fact("violation", "R04", "R04", "rule:visuals-012"), fact("inference", "R05", "rule:decks-011", "appliesToTask", "task:deck"), fact("warning", "R09", "R09", '"rule:decks-011"')],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function dataDir(file?: unknown): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-inf-"));
  dirs.push(d);
  if (file !== undefined) fs.writeFileSync(path.join(d, "inferred.json"), typeof file === "string" ? file : JSON.stringify(file));
  return d;
}

describe("filtering facts", () => {
  it("returns every fact when no filter is given", () => {
    expect(filterFacts(FILE.facts, null, null)).toHaveLength(3);
  });

  it("filters by a node among the arguments, ignoring quotes around the argument", () => {
    expect(filterFacts(FILE.facts, "rule:decks-011", null).map((f) => f.rule)).toEqual(["R05", "R09"]);
    expect(filterFacts(FILE.facts, "rule:visuals-012", null).map((f) => f.rule)).toEqual(["R04"]);
    expect(filterFacts(FILE.facts, "rule:none", null)).toEqual([]);
  });

  it("filters by kind and by node and kind together", () => {
    expect(filterFacts(FILE.facts, null, "violation")).toHaveLength(1);
    expect(filterFacts(FILE.facts, "rule:decks-011", "warning").map((f) => f.rule)).toEqual(["R09"]);
    expect(filterFacts(FILE.facts, "rule:decks-011", "violation")).toEqual([]);
  });

  it("returns at most 500 facts", () => {
    const many = Array.from({ length: MAX_FACTS + 1 }, (_, i) => fact("inference", "R05", `rule:r${i}`));
    expect(filterFacts(many, null, null)).toHaveLength(500);
    expect(filterFacts(many.slice(0, 500), null, null)).toHaveLength(500);
  });
});

describe("the inferred store", () => {
  it("serves rules and facts, and reports its summary", () => {
    const s = new InferredStore(dataDir(FILE));
    s.reload();
    const r = s.query("rule:decks-011", null);
    expect(r.rules).toHaveLength(2);
    expect(r.facts).toHaveLength(2);
    expect(s.summary()).toEqual({ engine: "nemo 0.10.1", facts: 3, built: "2026-10-06T09:00:00Z" });
  });

  it("returns empty lists and no summary when inferred.json is missing or not valid", () => {
    const missing = new InferredStore(dataDir());
    missing.reload();
    expect(missing.query(null, null)).toEqual({ rules: [], facts: [] });
    expect(missing.summary()).toBeNull();
    const bad = new InferredStore(dataDir("{not json"));
    bad.reload();
    expect(bad.summary()).toBeNull();
  });

  it("reports a null engine as null and picks up a rewritten file on reload", () => {
    const d = dataDir({ ...FILE, engine: null, facts: [] });
    const s = new InferredStore(d);
    s.reload();
    expect(s.summary()).toEqual({ engine: null, facts: 0, built: FILE.built });
    fs.writeFileSync(path.join(d, "inferred.json"), JSON.stringify(FILE));
    s.reload();
    expect(s.summary()?.facts).toBe(3);
  });
});

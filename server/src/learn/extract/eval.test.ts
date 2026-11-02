import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NodeLine } from "../../../../shared/learn/knowledge.ts";
import { formatReport, loadExpected, scoreExtraction, type Produced } from "./eval.ts";
import { auditorReply, cleanupEnvs, extractorReply, lines, setupEnv, write } from "./test-support.ts";

cleanupEnvs();

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../kg/tests/fixtures/extraction_eval");
const expected = loadExpected(DIR);

describe("the evaluation set", () => {
  it("holds a note for each entry, and every required word occurs in its note", () => {
    for (const [file, spec] of Object.entries(expected.files)) {
      const note = fs.readFileSync(path.join(DIR, file), "utf8").toLowerCase();
      expect(spec.claims.length).toBeGreaterThanOrEqual(4);
      for (const c of spec.claims) for (const w of c.mustInclude) expect(note, `${file} ${c.id} ${w}`).toContain(w.toLowerCase());
    }
  });

  it("scores recall and precision, and counts statements about the note", () => {
    const own: Produced[] = Object.entries(expected.files).flatMap(([file, s]) => s.claims.map((c) => ({ file, statement: c.text })));
    expect(scoreExtraction(expected, own)).toMatchObject({ recall: 1, precision: 1, aboutTheNote: 0 });
    const half = own.filter((_, i) => i % 2 === 0);
    const noisy = [...half, { file: "chunking.md", statement: "The note explains how chunks are cut." }, { file: "chunking.md", statement: "Something unrelated is true." }];
    const s = scoreExtraction(expected, noisy);
    expect(s.recall).toBeCloseTo(half.length / own.length);
    expect(s.precision).toBeCloseTo(half.length / noisy.length);
    expect(s.aboutTheNote).toBe(1);
    expect(scoreExtraction(expected, [])).toMatchObject({ recall: 0, precision: 0 });
    expect(formatReport(s)).toContain("Recall");
  });
});

describe("the pipeline over the evaluation set with a scripted model", () => {
  it("finds every expected claim in the four notes", async () => {
    const claims = (note: string) => expected.files[note].claims;
    const e = setupEnv({
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        const file = /File: Notes\/([\w-]+\.md)/.exec(c.user)![1];
        return extractorReply(claims(file).map((k, i) => ({ id: `p${i + 1}`, name: k.id, statement: k.text, quote: k.text.split(" ").slice(0, 3).join(" ") })));
      },
    });
    for (const file of Object.keys(expected.files)) write(e.notes, file, fs.readFileSync(path.join(DIR, file), "utf8"));
    await e.sources.scan(e.root.id);
    for (const f of e.sources.files(e.root.id)) expect((await e.svc.fileResult(f.sourceId)).outcome).toBe("completed");
    const nodes = lines(`${e.learnDir}/graph/nodes.jsonl`) as NodeLine[];
    const byId = new Map(e.sources.files(e.root.id).map((f) => [f.sourceId, f.path]));
    const produced = nodes.map((n) => ({ file: byId.get(n.provenance[0].chatId)!, statement: n.statement }));
    expect(scoreExtraction(expected, produced)).toMatchObject({ recall: 1, precision: 1 });
    expect(nodes.length).toBe(Object.values(expected.files).reduce((n, f) => n + f.claims.length, 0));
  });
});

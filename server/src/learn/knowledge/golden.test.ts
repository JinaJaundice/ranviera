// Golden fixtures of kg/tests/fixtures/knowledge/. The Python harvester and the
// skill test their parity against the same files.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoverageLine } from "../../../../shared/learn/knowledge.ts";
import type { SessionRecord } from "../../../../shared/learn/sessions.ts";
import { batches, coverageBlock, sessionView, uncoveredMessages } from "./coverage.ts";
import { FIXTURES, fixtureCopy, fixtureJson, open, read, cleanupTempDirs } from "./test-support.ts";
import { isChainLine } from "./ledger.ts";
import { sanitizeRenderSettings } from "./render-settings.ts";
import { redundantKeys } from "./simplify.ts";

cleanupTempDirs();

function snapshotWithoutRevision(dir: string) {
  const { revision, ...rest } = open(dir).snapshot();
  expect(revision).toBeGreaterThanOrEqual(0);
  return rest;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f).replace(/\\/g, "/")] = fs.readFileSync(f, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("golden: merge-paraphrase", () => {
  it("B-2-04 B-2-05 B-2-09 B-2-10 B-2-11 B-2-18 B-2-19 B-2-35 merges to the expected snapshot", () => {
    const dir = fixtureCopy("merge-paraphrase");
    expect(snapshotWithoutRevision(dir)).toEqual(fixtureJson("merge-paraphrase", "expected.json"));
  });

  it("B-2-37 reads never write", () => {
    const dir = fixtureCopy("merge-paraphrase");
    const before = tree(dir);
    open(dir).snapshot();
    open(dir).directory();
    open(dir).readRenderSettings();
    expect(tree(dir)).toEqual(before);
  });
});

describe("golden: shared-node-deletion", () => {
  for (const mode of ["delete-nodes", "preserve-graph"] as const) {
    it(`B-2-12 B-2-13 B-2-15 ${mode} gives the expected files and archive, and a second run finds nothing`, () => {
      const dir = fixtureCopy("shared-node-deletion");
      const k = open(dir);
      const first = k.deleteSources(["chat_a0000001"], mode);
      const second = k.deleteSources(["chat_a0000001"], mode);
      expect({ first, second }).toEqual(fixtureJson("shared-node-deletion", `expected-${mode}/stats.json`));
      const expectedDir = path.join(FIXTURES, "shared-node-deletion", `expected-${mode}`);
      const got = tree(dir);
      for (const [file, text] of Object.entries(tree(expectedDir))) {
        if (file === "stats.json") continue;
        const target = file.startsWith("archive/") ? `archive/2026-11-01/${file.slice(8)}` : `graph/${file}`;
        expect(got[target], target).toBe(text);
      }
    });
  }

  it("B-2-13 preserve-graph leaves the node and argument ledgers byte for byte", () => {
    const dir = fixtureCopy("shared-node-deletion");
    const before = [read(dir, "graph/nodes.jsonl"), read(dir, "graph/chains.jsonl")];
    open(dir).deleteSources(["chat_a0000001"], "preserve-graph");
    expect([read(dir, "graph/nodes.jsonl"), read(dir, "graph/chains.jsonl")]).toEqual(before);
  });
});

describe("golden: simplification", () => {
  it("names the redundant arguments by key", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "simplification/graph/chains.jsonl"), "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l)).filter(isChainLine);
    expect({ dropped: [...redundantKeys(lines)].sort() }).toEqual(fixtureJson("simplification", "expected.json"));
  });

  it("rewrites the ledger without them and archives every line first", () => {
    const dir = fixtureCopy("simplification");
    const k = open(dir);
    expect(k.simplify()).toBe(2);
    const kept = read(dir, "graph/chains.jsonl").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(kept).toEqual(["arg_200000000001", "arg_200000000002", "arg_200000000004", "arg_200000000006"]);
    const archived = read(dir, "archive/2026-11-01/chains.jsonl").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(archived).toEqual(["arg_200000000003", "arg_200000000005", "arg_200000000007"]);
    expect(k.simplify()).toBe(0);
  });
});

describe("golden: torn-append", () => {
  it("B-2-08 skips a torn line, a bad line and a wrong shape without repairing them", () => {
    const dir = fixtureCopy("torn-append");
    const before = read(dir, "graph/nodes.jsonl");
    const snap = open(dir).snapshot();
    const expected = fixtureJson<{ nodes: string[]; chains: string[] }>("torn-append", "expected.json");
    expect(snap.propositions.map((p) => p.id)).toEqual(expected.nodes);
    expect(snap.chains.map((c) => c.id)).toEqual(expected.chains);
    expect(read(dir, "graph/nodes.jsonl")).toBe(before);
  });

  it("closes the torn line before an append, so that the new line stays whole", () => {
    const dir = fixtureCopy("torn-append");
    const k = open(dir);
    k.appendNodes([{ id: "n_300000000005", name: "New", statement: "A line added after the tear.", aliases: [], createdAt: "2026-10-09T10:00:00.000Z", provenance: [] }]);
    expect(k.snapshot().propositions.map((p) => p.id)).toEqual(["n_300000000001", "n_300000000002", "n_300000000005"]);
  });
});

describe("golden: format-newer", () => {
  it("B-2-29 B-2-30 refuses every read and write of a newer stamp", () => {
    const dir = fixtureCopy("format-newer");
    const expected = fixtureJson<{ status: number; code: string; found: number; supported: number }>("format-newer", "expected.json");
    const k = open(dir);
    const refusal = { status: expected.status, code: expected.code, extra: { found: expected.found, supported: expected.supported } };
    for (const call of [() => k.snapshot(), () => k.directory(), () => k.readRenderSettings(), () => k.settle(), () => k.simplify()]) {
      expect(call).toThrowError(expect.objectContaining(refusal));
    }
    expect(() => k.snapshot()).toThrowError(/format 2/);
    expect(() => k.writeRenderSettings({})).toThrowError(/format 2/);
    expect(read(dir, "graph/format.json")).toContain("2");
  });
});

describe("golden: fingerprint-reopen", () => {
  const id = "chat_f0000000001";
  it("B-2-17 an edited message reopens that message only", () => {
    const dir = fixtureCopy("fingerprint-reopen");
    const rec = JSON.parse(read(dir, `chats/${id}.json`)) as SessionRecord;
    const view = sessionView(rec.messages);
    const cov = open(dir).readCoverage(id);
    const expected = fixtureJson<{ view: unknown[]; uncovered: string[]; block: unknown }>("fingerprint-reopen", "expected.json");
    expect(view.map((m) => ({ messageId: m.messageId, fp: m.fp, tokens: m.tokens }))).toEqual(expected.view);
    expect(uncoveredMessages(view, cov).map((m) => m.messageId)).toEqual(expected.uncovered);
    expect(coverageBlock(view, cov, { running: false, threshold: 4096 })).toEqual(expected.block);
  });

  it("a failed send_to_user call and a message with no prose are neither covered nor uncovered", () => {
    const dir = fixtureCopy("fingerprint-reopen");
    const rec = JSON.parse(read(dir, `chats/${id}.json`)) as SessionRecord;
    const view = sessionView(rec.messages);
    expect(view.filter((m) => m.tokens === 0).map((m) => m.messageId)).toEqual(["msg_m4", "msg_m5"]);
  });

  it("batches the uncovered text without splitting a message", () => {
    const dir = fixtureCopy("fingerprint-reopen");
    const rec = JSON.parse(read(dir, `chats/${id}.json`)) as SessionRecord;
    const view = sessionView(rec.messages);
    const none: Pick<CoverageLine, "fp">[] = [];
    const all = uncoveredMessages(view, none);
    expect(batches(all, 18).map((b) => b.map((m) => m.messageId))).toEqual([["msg_m1"], ["msg_m2", "msg_m3"]]);
    expect(batches(all, 5).map((b) => b.map((m) => m.messageId))).toEqual([["msg_m1"], ["msg_m2"], ["msg_m3"]]);
    expect(batches(all, 0)).toEqual([]);
  });
});

describe("golden: render-settings", () => {
  it("snaps to the ladders, resets the sizes of a legacy file and clamps the physics", () => {
    expect(sanitizeRenderSettings(fixtureJson("render-settings", "legacy.json"))).toEqual(fixtureJson("render-settings", "expected-legacy.json"));
    expect(sanitizeRenderSettings(fixtureJson("render-settings", "current.json"))).toEqual(fixtureJson("render-settings", "expected-current.json"));
  });
});

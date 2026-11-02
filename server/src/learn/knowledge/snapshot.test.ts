import { describe, expect, it } from "vitest";
import type { OutcomeLine } from "../../../../shared/learn/sources.ts";
import { computeMetrics, groupOutcomes } from "./snapshot.ts";
import { chain, lines, node, open, prov, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

let counter = 0;
function outcome(over: Partial<OutcomeLine>): OutcomeLine {
  counter += 1;
  return {
    id: `out_${String(counter).padStart(12, "0")}`,
    at: `2026-10-${String(counter % 28 + 1).padStart(2, "0")}T10:00:00.000Z`,
    sessionId: "chat_a",
    messageId: "msg_1",
    toolCallId: "tc",
    tool: "quiz",
    source: "choice",
    planNode: null,
    target: ["n_1"],
    correct: true,
    confidence: 70,
    rung: null,
    missClass: null,
    thinkingChars: 10,
    ...over,
  };
}

describe("metrics", () => {
  it("support counts the distinct sources and sessions", () => {
    expect(computeMetrics([{ chatId: "a" }, { chatId: "a" }, { chatId: "b" }], []).support).toBe(2);
  });

  it("held is unknown with no outcome", () => {
    expect(computeMetrics([], [])).toEqual({ support: 0, held: "unknown", lastTested: null, calibration: null });
  });

  it("held needs two outcomes, the newest two correct with a gentle rung, and no structural miss in the newest three", () => {
    const ok = (at: string, extra: Partial<OutcomeLine> = {}) => outcome({ at, correct: true, ...extra });
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z")]).held).toBe("shaky");
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z"), ok("2026-10-02T00:00:00Z")]).held).toBe("held");
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z"), ok("2026-10-02T00:00:00Z", { rung: "R2" })]).held).toBe("shaky");
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z", { rung: "R1" }), ok("2026-10-02T00:00:00Z", { rung: "R0" })]).held).toBe("held");
    expect(computeMetrics([], [outcome({ at: "2026-10-01T00:00:00Z", correct: false, missClass: "structural" }), ok("2026-10-02T00:00:00Z"), ok("2026-10-03T00:00:00Z")]).held).toBe("shaky");
    expect(computeMetrics([], [outcome({ at: "2026-10-01T00:00:00Z", correct: false, missClass: "structural" }), ok("2026-10-02T00:00:00Z"), ok("2026-10-03T00:00:00Z"), ok("2026-10-04T00:00:00Z")]).held).toBe("held");
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z"), outcome({ at: "2026-10-02T00:00:00Z", correct: null })]).held).toBe("shaky");
    expect(computeMetrics([], [ok("2026-10-01T00:00:00Z"), ok("2026-10-05T00:00:00Z")]).lastTested).toBe("2026-10-05T00:00:00Z");
  });

  it("calibration waits for 5 answers with a confidence and then names the band", () => {
    const answers = (n: number, confidence: number, correctOf: (i: number) => boolean) =>
      Array.from({ length: n }, (_, i) => outcome({ at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`, confidence, correct: correctOf(i) }));
    expect(computeMetrics([], answers(4, 90, () => false)).calibration).toBeNull();
    const over = computeMetrics([], answers(5, 90, (i) => i < 2)).calibration;
    expect(over).toMatchObject({ n: 5, band: "overconfident" });
    expect(over?.meanConfidence).toBeCloseTo(0.9);
    expect(over?.accuracy).toBeCloseTo(0.4);
    expect(over?.gap).toBeCloseTo(0.5);
    expect(computeMetrics([], answers(5, 30, () => true)).calibration?.band).toBe("underconfident");
    expect(computeMetrics([], answers(5, 70, (i) => i < 4)).calibration?.band).toBe("calibrated");
    const practice = answers(6, 70, () => true).map((o) => ({ ...o, source: "practice" as const, confidence: null }));
    expect(computeMetrics([], practice).calibration).toBeNull();
  });

  it("groups outcomes by target and orders them by time", () => {
    const a = outcome({ at: "2026-10-03T00:00:00Z", target: ["n_1", "n_2"] });
    const b = outcome({ at: "2026-10-01T00:00:00Z", target: ["n_1"] });
    const grouped = groupOutcomes([a, b]);
    expect(grouped.get("n_1")).toEqual([b, a]);
    expect(grouped.get("n_2")).toEqual([a]);
  });
});

describe("snapshot", () => {
  function setup() {
    const dir = tempDir();
    write(dir, "graph/nodes.jsonl", lines([
      node("n_pub", "Public fact", "A public fact.", [prov("src_pub000000001")]),
      node("n_int", "Internal fact", "An internal fact.", [prov("chat_a0000001", "msg_1")]),
      node("n_sec", "Secret fact", "A confidential fact.", [prov("src_sec000000001")]),
      node("n_mix", "Mixed fact", "Stated by two sources.", [prov("src_pub000000001"), prov("src_sec000000001")]),
    ]));
    write(dir, "graph/chains.jsonl", lines([
      chain("arg_1", ["n_pub", "n_int"], "n_mix", [prov("chat_a0000001")]),
      chain("arg_2", ["n_pub"], "n_sec", [prov("src_pub000000001")]),
      chain("arg_3", ["n_pub"], "n_int", [prov("src_sec000000001")]),
    ]));
    write(dir, "graph/sources.json", JSON.stringify({
      src_pub000000001: { id: "src_pub000000001", filePath: "Open/Public.md", importedAt: "2026-10-01T00:00:00Z" },
      src_sec000000001: { id: "src_sec000000001", filePath: "Client/Secret.md", importedAt: "2026-10-01T00:00:00Z" },
    }));
    write(dir, "graph/positions.json", JSON.stringify({ positions: { n_pub: { x: 1, y: 1 }, n_sec: { x: 2, y: 2 }, n_int: { x: 3, y: 3 }, arg_1: { x: 4, y: 4 } }, updatedAt: "x" }));
    write(dir, "chats/chat_a0000001.json", JSON.stringify({ id: "chat_a0000001", title: "Chat", createdAt: "2026-10-01T00:00:00Z" }));
    write(dir, "cortex/sources.json", JSON.stringify({ version: 1, roots: {
      root_00000001: { id: "root_00000001", sensitivity: "public" },
      root_00000002: { id: "root_00000002", sensitivity: "client-confidential" },
    } }));
    write(dir, "cortex/files.jsonl", lines([
      { sourceId: "src_pub000000001", rootId: "root_00000001" },
      { sourceId: "src_sec000000001", rootId: "root_00000002" },
    ]));
    return dir;
  }

  it("takes the highest sensitivity of the sources of a proposition", () => {
    const snap = open(setup()).snapshot();
    const by = Object.fromEntries(snap.propositions.map((p) => [p.id, p.sensitivity]));
    expect(by).toEqual({ n_pub: "public", n_int: "internal", n_sec: "client-confidential", n_mix: "client-confidential" });
  });

  it("filters by the maximum sensitivity and drops the chains that name a dropped proposition", () => {
    const k = open(setup());
    const internal = k.snapshot("internal");
    expect(internal.propositions.map((p) => p.id)).toEqual(["n_pub", "n_int"]);
    expect(internal.chains.map((c) => c.id)).toEqual([]);
    expect(Object.keys(internal.fileSources)).toEqual(["src_pub000000001"]);
    expect(internal.nodeSessions).toEqual({ n_pub: ["src_pub000000001"], n_int: ["chat_a0000001"] });
    expect(Object.keys(internal.positions ?? {}).sort()).toEqual(["n_int", "n_pub"]);
    const open2 = k.snapshot("public");
    expect(open2.propositions.map((p) => p.id)).toEqual(["n_pub"]);
    expect(open2.sessions).toEqual({});
    const all = k.snapshot();
    expect(all.chains.map((c) => c.id)).toEqual(["arg_1", "arg_2", "arg_3"]);
    expect(all.propositions.find((p) => p.id === "n_mix")?.metrics.support).toBe(2);
  });

  it("reads outcomes when the file is present and leaves held unknown when it is not", () => {
    const dir = setup();
    expect(open(dir).snapshot().propositions[0].metrics.held).toBe("unknown");
    write(dir, "cortex/outcomes.jsonl", lines([outcome({ target: ["n_pub"], at: "2026-10-01T00:00:00Z" }), outcome({ target: ["n_pub"], at: "2026-10-02T00:00:00Z" })]));
    const held = open(dir).snapshot().propositions.find((p) => p.id === "n_pub");
    expect(held?.metrics).toMatchObject({ held: "held", lastTested: "2026-10-02T00:00:00Z" });
  });

  it("omits positions when the file is empty and gives a zero revision for an empty folder", () => {
    const dir = tempDir();
    const snap = open(dir).snapshot();
    expect(snap.positions).toBeUndefined();
    expect(snap.revision).toBe(0);
    expect(snap.nodes).toEqual([]);
  });
});

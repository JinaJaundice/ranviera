import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnswerDetails, NativeMessage, OutcomeLine } from "../../../../shared/learn/index.ts";
import { assistantMsg, call, resultMsg, userMsg } from "../runtime/support.ts";
import { handleMethod } from "./http.ts";
import { calibrationOf, computeMetrics, heldBand } from "./metrics.ts";
import { appendOutcomes, outcomeId, outcomeLinesOf, outcomesPath, readOutcomes, syncOutcomes } from "./outcomes.ts";
import { makeMethodEnv, newRecord, nameResolver, tmpDir } from "./support.ts";

const line = (n: number, extra: Partial<OutcomeLine> = {}): OutcomeLine => ({
  id: `out_${String(n).padStart(12, "0")}`,
  at: `2026-11-01T10:${String(n).padStart(2, "0")}:00.000Z`,
  sessionId: "chat_x",
  messageId: `msg_${n}`,
  toolCallId: `call_${n}`,
  tool: "quiz",
  source: "choice",
  planNode: null,
  target: ["n_a"],
  correct: true,
  confidence: 90,
  rung: null,
  missClass: null,
  thinkingChars: 0,
  ...extra,
});

const details = (extra: Partial<AnswerDetails> = {}): AnswerDetails => ({ kind: "quiz", tool: "quiz", questionText: "Q", answers: [], answeredAt: "2026-11-01T10:00:00.000Z", ...extra });

describe("the held band (CONTRACTS Derived metrics)", () => {
  it("is unknown with no outcome, shaky with one, and held after two clean correct answers", () => {
    expect(heldBand([])).toBe("unknown");
    expect(heldBand([line(1)])).toBe("shaky");
    expect(heldBand([line(1), line(2)])).toBe("held");
  });

  it("needs the newest two to be correct and ignores older misses", () => {
    expect(heldBand([line(1, { correct: false }), line(2), line(3)])).toBe("held");
    expect(heldBand([line(1), line(2), line(3, { correct: false })])).toBe("shaky");
    expect(heldBand([line(1), line(2, { correct: null })])).toBe("shaky");
  });

  it("needs a rung of null, R0 or R1 on each of the newest two", () => {
    expect(heldBand([line(1), line(2, { source: "practice", tool: "problem", rung: "R1" })])).toBe("held");
    expect(heldBand([line(1), line(2, { source: "practice", tool: "problem", rung: "R0" })])).toBe("held");
    expect(heldBand([line(1), line(2, { source: "practice", tool: "problem", rung: "R3" })])).toBe("shaky");
  });

  it("is shaky when any of the newest three has the miss class structural", () => {
    expect(heldBand([line(1, { missClass: "structural", correct: false }), line(2), line(3)])).toBe("shaky");
    expect(heldBand([line(1, { missClass: "structural", correct: false }), line(2), line(3), line(4)])).toBe("held");
  });

  it("orders by time and not by position in the file", () => {
    expect(heldBand([line(3), line(1, { correct: false }), line(2)])).toBe("held");
    expect(heldBand([line(1), line(2), line(3, { correct: false })].reverse())).toBe("shaky");
  });
});

describe("calibration", () => {
  it("is null below 5 rated answers and counts choice answers with a confidence only", () => {
    expect(calibrationOf([line(1), line(2), line(3), line(4)])).toBeNull();
    expect(calibrationOf([line(1), line(2), line(3), line(4), line(5, { confidence: null })])).toBeNull();
    expect(calibrationOf([line(1), line(2), line(3), line(4), line(5, { source: "practice", tool: "problem" })])).toBeNull();
  });

  it("reads the bands from the gap with the limit at 0.15", () => {
    const five = (correct: boolean[], confidence: number) => correct.map((c, i) => line(i + 1, { correct: c, confidence }));
    expect(calibrationOf(five([true, true, true, true, false], 90))).toMatchObject({ n: 5, band: "calibrated" });
    expect(calibrationOf(five([true, false, false, true, false], 90))).toMatchObject({ band: "overconfident" });
    expect(calibrationOf(five([true, true, true, true, true], 30))).toMatchObject({ band: "underconfident" });
    const exact = calibrationOf(five([true, true, true, true, true], 85))!;
    expect(exact.gap).toBeCloseTo(-0.15);
    expect(exact.band).toBe("calibrated");
    expect(calibrationOf(five([true, true, true, true, true], 84))!.band).toBe("underconfident");
  });

  it("bundles support, the held band, the time of the newest outcome and the calibration", () => {
    const m = computeMetrics([line(2), line(1)], 3);
    expect(m).toEqual({ support: 3, held: "held", lastTested: line(2).at, calibration: null });
    expect(computeMetrics([], 1)).toEqual({ support: 1, held: "unknown", lastTested: null, calibration: null });
  });
});

describe("the outcome lines of a record", () => {
  const choiceRecord = (d: AnswerDetails, args: Record<string, unknown> = {}): NativeMessage[] => [
    userMsg("u1", "go"),
    assistantMsg("a1", [call("q1", "quiz", { type: "check", nodeId: "n1", question: "Q", target: ["n_a"], ...args })], { stopReason: "toolUse" }),
    resultMsg("r1", "q1", "quiz", "answered", { details: d, timestamp: Date.UTC(2026, 10, 1, 10, 0, 0) }),
  ];
  const lines = (messages: NativeMessage[], resolver = undefined as ReturnType<typeof nameResolver> | undefined) => outcomeLinesOf(newRecord(messages), resolver, () => 0);

  it("writes one line for a graded choice answer with a target, exactly in the shape of the contract", () => {
    const [l] = lines(choiceRecord(details({ correct: true, confidence: 70, thinking: "abc", target: ["n_a"] })));
    expect(l).toEqual({
      id: outcomeId("chat_test", "q1"),
      at: "2026-11-01T10:00:00.000Z",
      sessionId: "chat_test",
      messageId: "r1",
      toolCallId: "q1",
      tool: "quiz",
      source: "choice",
      planNode: "n1",
      target: ["n_a"],
      correct: true,
      confidence: 70,
      rung: null,
      missClass: null,
      thinkingChars: 3,
    });
    expect(l.id).toMatch(/^out_[0-9a-f]{12}$/);
  });

  it("writes no line without a target, for a dismissal, for free recall or for an open question", () => {
    expect(lines(choiceRecord(details({ correct: true }), { target: undefined }))).toEqual([]);
    expect(lines(choiceRecord(details({ dismissed: true, answers: [] })))).toEqual([]);
    const explain = choiceRecord(details({ kind: "explain", tool: "explain" }));
    explain[1] = assistantMsg("a1", [call("q1", "explain", { type: "check", nodeId: "n1", question: "Q", target: ["n_a"] })], { stopReason: "toolUse" });
    explain[2] = resultMsg("r1", "q1", "explain", "answered", { details: details({ kind: "explain", tool: "explain" }) });
    expect(lines(explain)).toEqual([]);
    const ask = choiceRecord(details({ kind: "ask", tool: "ask_user_question" }));
    ask[1] = assistantMsg("a1", [call("q1", "ask_user_question", { question: "Q", target: ["n_a"] })], { stopReason: "toolUse" });
    ask[2] = resultMsg("r1", "q1", "ask_user_question", "answered", { details: details({ kind: "ask", tool: "ask_user_question" }) });
    expect(lines(ask)).toEqual([]);
  });

  it("writes correct null and no confidence for the not known option", () => {
    const [l] = lines(choiceRecord(details({ dontKnow: true, confidence: 90 })));
    expect(l).toMatchObject({ correct: null, confidence: null });
  });

  it("resolves a target that the call carries as a name", () => {
    const [l] = lines(choiceRecord(details({ correct: false }), { target: ["common denominator"] }), nameResolver({ n_zzz: "Common denominator" }));
    expect(l.target).toEqual(["n_zzz"]);
    expect(l.correct).toBe(false);
  });

  const practice = (conclude: Record<string, unknown>, outcome: string, target: unknown = ["n_a"]): NativeMessage[] => [
    userMsg("u1", "go"),
    assistantMsg("a1", [call("p1", "problem", { statement: "S", mode: "recall", modelSolution: "M", ...(target ? { target } : {}) })], { stopReason: "toolUse" }),
    resultMsg("r1", "p1", "problem", "posed", { details: { ok: true } }),
    { role: "custom", id: "t1", customType: "practice-thinking", content: "x", details: { problemCallId: "p1", text: "four" } } as NativeMessage,
    { role: "custom", id: "t2", customType: "practice-thinking", content: "x", details: { problemCallId: "p1", text: "eleven char" } } as NativeMessage,
    assistantMsg("a2", [call("c1", "conclude", conclude)], { stopReason: "toolUse" }),
    resultMsg("r2", "c1", "conclude", "closed", { details: { ok: true, outcome, problemCallId: "p1" }, timestamp: Date.UTC(2026, 10, 1, 11) }),
  ];

  it("writes a practice line for each conclude with the target of the problem, the rung, the miss class and the retest flag", () => {
    const [l] = lines(practice({ outcome: "movedOn", verdict: "v", rung: "R3", missClass: "structural", retest: true }, "movedOn"));
    expect(l).toEqual({
      id: outcomeId("chat_test", "c1"),
      at: "2026-11-01T11:00:00.000Z",
      sessionId: "chat_test",
      messageId: "r2",
      toolCallId: "c1",
      tool: "problem",
      source: "practice",
      planNode: null,
      target: ["n_a"],
      correct: false,
      confidence: null,
      outcome: "movedOn",
      rung: "R3",
      missClass: "structural",
      retest: true,
      thinkingChars: "four".length + "eleven char".length,
    });
    expect(lines(practice({ outcome: "solved", verdict: "v", rung: null, missClass: null, retest: false }, "solved"))[0]).toMatchObject({ correct: true, rung: null, missClass: null });
    expect("retest" in lines(practice({ outcome: "solved", verdict: "v" }, "solved"))[0]).toBe(false);
  });

  it("writes no line for a problem without a target, and null correct for a dismissal", () => {
    expect(lines(practice({ outcome: "solved", verdict: "v" }, "solved", null))).toEqual([]);
    const dismissed = practice({ outcome: "dismissed", verdict: "v", rung: null, missClass: null, retest: false }, "dismissed");
    expect(lines(dismissed)[0]).toMatchObject({ outcome: "dismissed", correct: null });
  });

  it("writes no line for a refused conclude", () => {
    const msgs = practice({ outcome: "solved", verdict: "v" }, "solved");
    msgs[msgs.length - 1] = resultMsg("r2", "c1", "conclude", "refused", { isError: true });
    expect(lines(msgs)).toEqual([]);
  });
});

describe("the outcomes ledger file", () => {
  it("appends under cortex/outcomes.jsonl, once for each identifier, and fires the event once", () => {
    const dir = tmpDir("outcomes-");
    const seen: string[] = [];
    const record = newRecord([
      userMsg("u1", "go"),
      assistantMsg("a1", [call("q1", "quiz", { type: "check", nodeId: "n1", question: "Q", target: ["n_a"] })], { stopReason: "toolUse" }),
      resultMsg("r1", "q1", "quiz", "answered", { details: details({ correct: true, confidence: 90 }) }),
    ]);
    const deps = { events: { answer: (e: { key: string }) => void seen.push(e.key) }, now: () => 0 };
    expect(syncOutcomes(dir, record, deps)).toHaveLength(1);
    expect(syncOutcomes(dir, record, deps)).toHaveLength(0);
    expect(seen).toEqual(["q1"]);
    const file = fs.readFileSync(outcomesPath(dir), "utf8");
    expect(file.trim().split("\n")).toHaveLength(1);
    expect(file.endsWith("\n")).toBe(true);
    expect(outcomesPath(dir)).toBe(path.join(dir, "cortex", "outcomes.jsonl"));
  });

  it("reads strictly, skipping a bad line, and closes a torn last line before the next append", () => {
    const dir = tmpDir("outcomes-");
    fs.mkdirSync(path.join(dir, "cortex"));
    fs.writeFileSync(outcomesPath(dir), `${JSON.stringify(line(1))}\nnot json\n{"id":"x"}\n${JSON.stringify(line(2))}\n{"torn":`);
    expect(readOutcomes(dir).map((l) => l.id)).toEqual([line(1).id, line(2).id]);
    expect(appendOutcomes(dir, [line(3)])).toHaveLength(1);
    expect(readOutcomes(dir).map((l) => l.id)).toEqual([line(1).id, line(2).id, line(3).id]);
    expect(appendOutcomes(dir, [line(3), line(1)])).toEqual([]);
    expect(readOutcomes(tmpDir("empty-"))).toEqual([]);
  });
});

describe("route 39", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("returns the outcomes of a proposition with its metrics, and refuses a missing or unknown node", async () => {
    const env = makeMethodEnv({ names: { n_a: "Common denominator" } });
    appendOutcomes(env.dir, [line(1), line(2), line(3, { target: ["n_other"] })]);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleMethod(env.method, req, res, url.pathname, url.searchParams);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/learn`;
    const get = async (p: string) => {
      const res = await fetch(base + p);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const ok = await get("/outcomes?node=n_a");
    expect(ok.status).toBe(200);
    expect((ok.json.outcomes as OutcomeLine[]).map((o) => o.id)).toEqual([line(1).id, line(2).id]);
    expect(ok.json.metrics).toEqual({ support: 2, held: "held", lastTested: line(2).at, calibration: null });
    // a proposition that the graph does not hold but that has outcomes is still answered
    expect(((await get("/outcomes?node=n_other")).json.metrics as { held: string }).held).toBe("shaky");
    expect((await get("/outcomes")).status).toBe(400);
    expect((await get("/outcomes?node=..%2Fx")).status).toBe(400);
    const missing = await get("/outcomes?node=n_nothing");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: "not_found" });
    const post = await fetch(`${base}/outcomes?node=n_a`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});

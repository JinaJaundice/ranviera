import { describe, expect, it } from "vitest";
import type { LearnSettings } from "@shared/learn/models";
import { NUMBER_FIELDS, graphOn, parseNumber, readNumber, toolOn, withGraph, withNumber, withTool } from "./fields";

const field = (key: string) => NUMBER_FIELDS.find((f) => f.key === key)!;

describe("the learning switches", () => {
  it("reads a number with its floor and ceiling, and an empty value clears the choice", () => {
    expect(parseNumber("150,000", field("compaction"))).toEqual({ ok: true, value: 150000 });
    expect(parseNumber("", field("compaction"))).toEqual({ ok: true, value: undefined });
    expect(parseNumber("31999", field("compaction"))).toMatchObject({ ok: false });
    expect(parseNumber("32000", field("compaction"))).toEqual({ ok: true, value: 32000 });
    expect(parseNumber("499", field("chunk"))).toMatchObject({ ok: false, error: expect.stringContaining("500") });
    expect(parseNumber("12.5", field("files"))).toMatchObject({ ok: false });
    expect(parseNumber("1001", field("files"))).toMatchObject({ ok: false });
    expect(parseNumber("abc", field("interval"))).toMatchObject({ ok: false });
  });

  it("writes a number into its own section and removes an empty section", () => {
    let s: LearnSettings = { version: 1 };
    s = withNumber(s, "interval", 120);
    s = withNumber(s, "files", 20);
    expect(s.scan).toEqual({ intervalSeconds: 120, maxFilesPerPass: 20 });
    expect(readNumber(s, "interval")).toBe(120);
    s = withNumber(withNumber(s, "interval", undefined), "files", undefined);
    expect(s.scan).toBeUndefined();
    expect("scan" in s).toBe(false);
    expect(withNumber({ version: 1, graph: { enabled: false } }, "chunk", undefined).graph).toEqual({ enabled: false });
  });

  it("treats the PDF tool as on and research and free recall as off until chosen", () => {
    const s: LearnSettings = { version: 1 };
    expect(toolOn(s, "research")).toBe(false);
    expect(toolOn(s, "pdf")).toBe(true);
    expect(toolOn(s, "explain")).toBe(false);
    expect(toolOn(withTool(s, "research", true), "research")).toBe(true);
    expect(toolOn(withTool(s, "explain", true), "explain")).toBe(true);
    expect(withTool({ version: 1, agent: { prompts: { "a.md": true } } }, "pdf", false).agent?.prompts).toEqual({ "a.md": true });
  });

  it("extraction is on until switched off", () => {
    expect(graphOn({ version: 1 })).toBe(true);
    expect(graphOn(withGraph({ version: 1 }, false))).toBe(false);
    expect(withGraph({ version: 1, graph: { extractionChunkTokens: 900 } }, true).graph).toEqual({ extractionChunkTokens: 900, enabled: true });
  });
});

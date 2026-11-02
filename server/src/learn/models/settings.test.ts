import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearnSettings } from "../../../../shared/learn/models.ts";
import { createSettingsStore, sanitiseSettings, stampClaudeCode } from "./settings.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-settings-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const FULL: LearnSettings = {
  version: 1,
  claudeCode: { enabled: true, enabledAt: "2026-11-01T10:00:00.000Z", allowBackground: false },
  models: {
    strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high", cacheRetention: "short" },
    cheap: { model: { provider: "openai", id: "gpt-5-mini" } },
  },
  agent: {
    models: { extractor: { model: { provider: "groq", id: "llama" }, thinkingLevel: "low" } },
    tools: { research: false, explain: true },
    prompts: { "teacher/20-teaching.md": true },
  },
  compaction: { thresholdTokens: 120_000 },
  graph: { enabled: false, extractionChunkTokens: 2048 },
  scan: { intervalSeconds: 600, maxFilesPerPass: 20 },
};

describe("settings sanitiser", () => {
  // B-1-73
  it("round trips a valid record field for field", () => {
    expect(sanitiseSettings(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });

  // B-1-73
  it("drops wrongly typed fields and clamps numbers", () => {
    const out = sanitiseSettings({
      claudeCode: { enabled: "yes", allowBackground: true, enabledAt: "not a date" },
      models: { strong: { model: { provider: "", id: "x" }, thinkingLevel: "turbo", cacheRetention: "forever" }, cheap: { thinkingLevel: "low" } },
      compaction: { thresholdTokens: 10 },
      graph: { extractionChunkTokens: 3, enabled: 1 },
      scan: { intervalSeconds: 1, maxFilesPerPass: 99999 },
    });
    expect(out.claudeCode).toEqual({ allowBackground: true });
    expect(out.models).toEqual({ cheap: { thinkingLevel: "low" } });
    expect(out.compaction).toEqual({ thresholdTokens: 32_000 });
    expect(out.graph).toEqual({ extractionChunkTokens: 500 });
    expect(out.scan).toEqual({ intervalSeconds: 30, maxFilesPerPass: 1000 });
  });

  // B-1-74
  it("reads null and non objects as the empty record and never throws", () => {
    for (const v of [null, undefined, 3, "x", [1], true]) expect(sanitiseSettings(v)).toEqual({ version: 1 });
    expect(() => sanitiseSettings({ get models(): never { throw new Error("boom"); } })).not.toThrow();
  });

  // B-1-74
  it("keeps unknown keys at the top and inside known sections", () => {
    const out = sanitiseSettings({ future: { a: 1 }, compaction: { thresholdTokens: 50_000, newer: "x" }, models: { strong: { model: { provider: "a", id: "b" }, flavour: 2 }, extra: { z: 1 } } }) as unknown as Record<string, unknown>;
    expect(out.future).toEqual({ a: 1 });
    expect(out.compaction).toEqual({ thresholdTokens: 50_000, newer: "x" });
    expect((out.models as Record<string, unknown>).extra).toEqual({ z: 1 });
    expect(((out.models as Record<string, Record<string, unknown>>).strong).flavour).toBe(2);
  });

  // B-1-75
  it("drops unknown roles and tools, and keeps only boolean prompt switches", () => {
    const out = sanitiseSettings({ agent: { models: { wizard: { model: { provider: "a", id: "b" } } }, tools: { research: true, magic: true, pdf: "no" }, prompts: { "shared/10-voice.md": true, "shared/20.md": "on", __proto__: true } } });
    expect(out.agent).toEqual({ tools: { research: true }, prompts: { "shared/10-voice.md": true } });
  });

  it("keeps the custom endpoint only with a valid URL, binding id and pins for listed models", () => {
    const bindingId = "a".repeat(32);
    const out = sanitiseSettings({
      customProvider: {
        credentialBindingId: bindingId,
        authMode: "apiKey",
        baseUrl: "http://localhost:11434/v1///",
        models: [{ id: "llama", image: true, context: 4096.4 }, { id: "llama" }, { id: "  " }],
        manualModels: ["typed", "typed"],
        overrides: { llama: { context: 100, maxTokens: 0, reasoning: true }, gone: { context: 5 }, typed: { maxTokens: 2.5 } },
        localConfirmedAt: "2026-11-01T09:00:00.000Z",
      },
    });
    expect(out.customProvider).toEqual({
      credentialBindingId: bindingId,
      authMode: "apiKey",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "llama", image: true, context: 4096 }],
      manualModels: ["typed"],
      overrides: { llama: { context: 100, reasoning: true } },
      localConfirmedAt: "2026-11-01T09:00:00.000Z",
    });
    expect(sanitiseSettings({ customProvider: { baseUrl: "ftp://x", credentialBindingId: "short" } }).customProvider).toBeUndefined();
    expect(sanitiseSettings({ customProvider: { baseUrl: "https://user:pw@host/v1" } }).customProvider).toBeUndefined();
  });
});

describe("settings store", () => {
  // B-1-76
  it("reads the empty record at first boot, round trips through the sanitiser and treats a corrupt file as first boot", () => {
    const file = path.join(dir, "learn", "settings.json");
    const store = createSettingsStore({ file });
    expect(store.read()).toEqual({ version: 1 });
    store.write(FULL);
    expect(store.read()).toEqual(FULL);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^\{\n\t"version": 1/);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
    fs.writeFileSync(file, "{ broken");
    expect(store.read()).toEqual({ version: 1 });
  });

  it("applies a change to the current record and writes the sanitised result", () => {
    const store = createSettingsStore({ file: path.join(dir, "settings.json") });
    store.write(FULL);
    const next = store.update((s) => ({ ...s, compaction: { thresholdTokens: 5 } }));
    expect(next.compaction).toEqual({ thresholdTokens: 32_000 });
    expect(store.read().models).toEqual(FULL.models);
  });
});

describe("Claude Code switch times", () => {
  const NOW = "2026-11-01T12:00:00.000Z";
  it("records the time when a switch turns on, keeps it while it stays on and drops it when it turns off", () => {
    const off: LearnSettings = { version: 1 };
    const on = stampClaudeCode(off, { version: 1, claudeCode: { enabled: true, allowBackground: true } }, NOW);
    expect(on.claudeCode).toEqual({ enabled: true, enabledAt: NOW, allowBackground: true, allowBackgroundAt: NOW });
    const later = stampClaudeCode(on, { version: 1, claudeCode: { enabled: true, allowBackground: false } }, "2026-11-02T00:00:00.000Z");
    expect(later.claudeCode).toEqual({ enabled: true, enabledAt: NOW, allowBackground: false });
    expect(stampClaudeCode(later, { version: 1, claudeCode: { enabled: false } }, NOW).claudeCode).toEqual({ enabled: false });
    expect(stampClaudeCode(later, { version: 1 }, NOW).claudeCode).toBeUndefined();
  });
});

// public-check: synthetic-secrets (the provider key in these tests is made up and must never reach a response)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCodeStatus, LearnSettings } from "../../../../shared/learn/models.ts";
import { createModelsService, type ModelsService } from "./index.ts";
import { DEFAULT_THINKING_ORDER, defaultLevel, resolveConversation, resolveLevel, resolveRole, resolveRolePins, resolveSlot, resolveSlots, validateModelsSection } from "./slots.ts";

const KEY = "sk-test-0123456789abcdef";
let dir: string;
let env: NodeJS.ProcessEnv;

function service(extra?: { status?: ClaudeCodeStatus }): ModelsService {
  const faux = fauxProvider({ provider: "claude-code", models: [{ id: "opus", reasoning: true, input: ["text", "image"] }, { id: "sonnet", reasoning: true, input: ["text", "image"] }, { id: "haiku", reasoning: true, input: ["text", "image"] }] });
  return createModelsService({
    authFile: path.join(dir, "auth.json"),
    learnDir: path.join(dir, "learn"),
    env,
    extraProviders: [faux.provider],
    claudeCodeStatus: async () => extra?.status ?? { state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: false, allowBackground: false },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-models-"));
  env = {};
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("model catalogue", () => {
  // B-1-49 and B-1-53
  it("lists only the providers that have a key, sorted, and reads key presence fresh", async () => {
    const svc = service();
    expect((await svc.catalog()).models).toEqual([]);
    svc.keys.save("OPENROUTER_API_KEY", KEY);
    svc.keys.save("ANTHROPIC_API_KEY", KEY);
    const cat = await svc.catalog();
    const providers = [...new Set(cat.models.map((m) => m.provider))];
    expect(providers).toEqual(["anthropic", "openrouter"]);
    const sorted = [...cat.models].sort((a, b) => (a.provider === b.provider ? (a.id < b.id ? -1 : 1) : a.provider < b.provider ? -1 : 1));
    expect(cat.models.map((m) => `${m.provider}:${m.id}`)).toEqual(sorted.map((m) => `${m.provider}:${m.id}`));
    expect(cat.providers.find((p) => p.id === "openrouter")).toEqual({ id: "openrouter", envVar: "OPENROUTER_API_KEY", keyPresent: true });
    expect(cat.providers.find((p) => p.id === "openai")?.keyPresent).toBe(false);
    svc.keys.remove("OPENROUTER_API_KEY");
    expect((await svc.catalog()).providers.find((p) => p.id === "openrouter")?.keyPresent).toBe(false);
  });

  it("gives each entry its levels, modalities, window and a price in dollars per million tokens", async () => {
    const svc = service();
    svc.keys.save("ANTHROPIC_API_KEY", KEY);
    const entry = (await svc.catalog()).models.find((m) => m.reasoning);
    expect(entry).toBeDefined();
    expect(entry?.supportedLevels.length).toBeGreaterThan(1);
    expect(entry?.cost).toMatchObject({ input: expect.any(Number), output: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number) });
    expect(entry?.contextWindow).toBeGreaterThan(0);
    expect(entry?.input).toContain("text");
  });

  // B-1-58, B-1-59, B-1-60
  it("lists the Claude Code aliases only when the person switched the provider on and the CLI exists, unpriced and with no window", async () => {
    const svc = service();
    expect((await svc.catalog()).models.filter((m) => m.provider === "claude-code")).toEqual([]);
    svc.settings.write({ version: 1, claudeCode: { enabled: true } });
    const cc = (await svc.catalog()).models.filter((m) => m.provider === "claude-code");
    expect(cc.map((m) => m.id)).toEqual(["haiku", "opus", "sonnet"]);
    for (const m of cc) expect(m).toMatchObject({ cost: null, contextWindow: null, maxTokens: null });
    const missing = service({ status: { state: "not-found", version: null, minimumVersion: "2.1.316", enabled: true, allowBackground: false } });
    missing.settings.write({ version: 1, claudeCode: { enabled: true } });
    expect((await missing.catalog()).models.filter((m) => m.provider === "claude-code")).toEqual([]);
  });

  // B-1-50, B-1-51, B-1-52
  it("returns the strong slot as the default, the slots as null where empty and role pins from override then slot", async () => {
    const svc = service();
    expect(await svc.catalog()).toMatchObject({ defaults: null, slots: { strong: null, cheap: null, vision: null }, rolePins: { researcher: null, extractor: null, auditor: null, pdfReader: null } });
    svc.settings.write({
      version: 1,
      models: { strong: { model: { provider: "anthropic", id: "a" } }, cheap: { model: { provider: "openai", id: "b" } }, vision: { thinkingLevel: "low" } },
      agent: { models: { extractor: { model: { provider: "groq", id: "c" } } } },
    });
    const cat = await svc.catalog();
    expect(cat.defaults).toEqual({ provider: "anthropic", id: "a" });
    expect(cat.slots).toEqual({ strong: { provider: "anthropic", id: "a" }, cheap: { provider: "openai", id: "b" }, vision: null });
    expect(cat.rolePins).toEqual({ researcher: { provider: "openai", id: "b" }, extractor: { provider: "groq", id: "c" }, auditor: { provider: "openai", id: "b" }, pdfReader: null });
  });
});

describe("resolution", () => {
  const settings: LearnSettings = {
    version: 1,
    models: {
      strong: { model: { provider: "anthropic", id: "s" }, thinkingLevel: "high", cacheRetention: "long" },
      cheap: { model: { provider: "openai", id: "c" }, thinkingLevel: "low", cacheRetention: "short" },
      vision: { thinkingLevel: "medium" },
    },
    agent: { models: { auditor: { thinkingLevel: "minimal" }, pdfReader: { model: { provider: "google", id: "v" } } } },
  };

  // B-1-78
  it("lets a role override beat the slot and resolves each field on its own", () => {
    expect(resolveRole(settings, "researcher")).toEqual({ model: { provider: "openai", id: "c" }, thinkingLevel: "low", cacheRetention: "short" });
    expect(resolveRole(settings, "auditor")).toEqual({ model: { provider: "openai", id: "c" }, thinkingLevel: "minimal", cacheRetention: "short" });
    expect(resolveRole(settings, "pdfReader")).toEqual({ model: { provider: "google", id: "v" }, thinkingLevel: "medium" });
    expect(resolveRolePins(settings).extractor).toEqual({ provider: "openai", id: "c" });
  });

  it("treats a slot with a level and no model as inert", () => {
    expect(resolveSlot(settings, "vision")).toBeNull();
    expect(resolveSlots(settings).vision).toBeNull();
    expect(resolveRole({ version: 1, models: { vision: { thinkingLevel: "low" } } }, "pdfReader")).toBeNull();
  });

  // B-1-80
  it("resolves a conversation from the session, then the strong slot, then nothing", () => {
    expect(resolveConversation(settings, { model: { provider: "x", id: "y" } })).toEqual({ model: { provider: "x", id: "y" }, thinkingLevel: "high", cacheRetention: "long" });
    expect(resolveConversation(settings, { thinkingLevel: "off" })).toEqual({ model: { provider: "anthropic", id: "s" }, thinkingLevel: "off", cacheRetention: "long" });
    expect(resolveConversation(settings)).toEqual({ model: { provider: "anthropic", id: "s" }, thinkingLevel: "high", cacheRetention: "long" });
    expect(resolveConversation({ version: 1 })).toBeNull();
  });
});

describe("thinking levels", () => {
  async function pair() {
    const svc = service();
    svc.keys.save("ANTHROPIC_API_KEY", KEY);
    svc.keys.save("OPENROUTER_API_KEY", KEY);
    const reasoning = svc.registry.models.getModels("anthropic").find((m) => m.reasoning);
    const plain = svc.registry.models.getModels("openrouter").find((m) => !m.reasoning);
    if (!reasoning || !plain) throw new Error("the catalogue lacks a reasoning model or a plain model, so the fixture needs a new choice");
    return { svc, reasoning, plain };
  }

  // B-1-57 and B-1-69
  it("takes the first supported level of the default order, and off for a model that does not reason", async () => {
    const { reasoning, plain } = await pair();
    const supported = new Set(resolveLevel(reasoning, "medium") && DEFAULT_THINKING_ORDER);
    expect(supported.size).toBeGreaterThan(0);
    expect(defaultLevel(reasoning)).toBe("medium");
    expect(defaultLevel(plain)).toBe("off");
    expect(resolveLevel(plain)).toBe("off");
  });

  // B-1-55 and B-1-70
  it("clamps a level that the model does not support instead of failing", async () => {
    const { reasoning, plain } = await pair();
    expect(resolveLevel(plain, "high")).toBe("off");
    expect(resolveLevel(reasoning, "off")).not.toBe("high");
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(resolveLevel(reasoning, "max"));
  });
});

describe("models section write", () => {
  async function ready() {
    const svc = service();
    svc.keys.save("ANTHROPIC_API_KEY", KEY);
    const reasoning = svc.registry.models.getModels("anthropic").find((m) => m.reasoning && !m.thinkingLevelMap?.max);
    const imaging = svc.registry.models.getModels("anthropic").find((m) => m.input.includes("image"));
    const textOnly = svc.registry.models.getModels("openrouter").find((m) => !m.input.includes("image"));
    if (!reasoning || !imaging || !textOnly) throw new Error("the catalogue lacks a needed model, so the fixture needs a new choice");
    return { svc, reasoning, imaging, textOnly };
  }

  // B-1-54 and B-1-81
  it("accepts a known model, clamps its level and stores the clamped value", async () => {
    const { svc, reasoning } = await ready();
    const out = validateModelsSection({ strong: { model: { provider: "anthropic", id: reasoning.id }, thinkingLevel: "max", cacheRetention: "long" } }, undefined, svc.registry);
    expect(out.strong?.model).toEqual({ provider: "anthropic", id: reasoning.id });
    expect(out.strong?.thinkingLevel).not.toBe("max");
    expect(out.strong?.cacheRetention).toBe("long");
  });

  it("accepts an empty write as a clear", async () => {
    const { svc } = await ready();
    expect(validateModelsSection({}, { strong: { model: { provider: "a", id: "b" } } }, svc.registry)).toEqual({});
  });

  // B-1-54, B-1-67, B-1-81
  it("rejects an unknown slot with the supported list, an unknown model and a bad level", async () => {
    const { svc } = await ready();
    expect(() => validateModelsSection({ fast: { model: { provider: "a", id: "b" } } }, undefined, svc.registry)).toThrow(/strong, cheap, vision/);
    expect(() => validateModelsSection({ strong: { model: { provider: "anthropic", id: "no-such-model" } } }, undefined, svc.registry)).toThrow(/not in the catalogue/);
    expect(() => validateModelsSection({ strong: { model: { provider: "nobody", id: "x" } } }, undefined, svc.registry)).toThrow(/not in the catalogue/);
    expect(() => validateModelsSection({ strong: {} }, undefined, svc.registry)).toThrow(/needs a model/);
    expect(() => validateModelsSection("x", undefined, svc.registry)).toThrow(/must be an object/);
    const m = svc.registry.models.getModels("anthropic")[0];
    expect(() => validateModelsSection({ strong: { model: { provider: "anthropic", id: m.id }, thinkingLevel: "turbo" } }, undefined, svc.registry)).toThrow(/thinking level/);
    expect(() => validateModelsSection({ strong: { model: { provider: "anthropic", id: m.id }, cacheRetention: "forever" } }, undefined, svc.registry)).toThrow(/cache retention/);
  });

  // B-1-68
  it("keeps a slot whose provider lost its key, because an unchanged slot skips the catalogue check", async () => {
    const { svc } = await ready();
    const stale = { provider: "gone-provider", id: "old-model" };
    const out = validateModelsSection({ strong: { model: stale, thinkingLevel: "high" }, cheap: { model: { provider: "anthropic", id: svc.registry.models.getModels("anthropic")[0].id } } }, { strong: { model: stale } }, svc.registry);
    expect(out.strong).toEqual({ model: stale, thinkingLevel: "high" });
  });

  it("holds the vision slot to a model that accepts images", async () => {
    const { svc, textOnly, imaging } = await ready();
    svc.keys.save("OPENROUTER_API_KEY", KEY);
    expect(() => validateModelsSection({ vision: { model: { provider: "openrouter", id: textOnly.id } } }, undefined, svc.registry)).toThrow(/accepts images/);
    expect(validateModelsSection({ vision: { model: { provider: "anthropic", id: imaging.id } } }, undefined, svc.registry).vision?.model?.id).toBe(imaging.id);
  });
});

describe("refusals", () => {
  // B-1-34 and B-1-37
  it("answers models_not_configured with the missing slots, before any key check", async () => {
    const svc = service();
    const refusal = await svc.checkSlots(["strong", "cheap"]);
    expect(refusal?.status).toBe(503);
    expect(refusal?.body()).toMatchObject({ code: "models_not_configured", missing: ["strong", "cheap"] });
    svc.settings.write({ version: 1, models: { strong: { model: { provider: "anthropic", id: "x" } } } });
    expect((await svc.checkSlots(["strong", "cheap"]))?.body()).toMatchObject({ code: "models_not_configured", missing: ["cheap"] });
  });

  // B-1-37, B-1-32
  it("answers provider_key_missing with the provider and slots, and never falls back to another provider", async () => {
    const svc = service();
    svc.settings.write({ version: 1, models: { strong: { model: { provider: "anthropic", id: "x" } }, cheap: { model: { provider: "anthropic", id: "y" } }, vision: { model: { provider: "openai", id: "z" } } } });
    svc.keys.save("OPENAI_API_KEY", KEY);
    const refusal = await svc.checkSlots(["strong", "cheap", "vision"]);
    expect(refusal?.status).toBe(503);
    expect(refusal?.body()).toMatchObject({ code: "provider_key_missing", provider: "anthropic", slots: ["strong", "cheap"] });
    svc.keys.save("ANTHROPIC_API_KEY", KEY);
    expect(await svc.checkSlots(["strong", "cheap", "vision"])).toBeNull();
  });

  // B-1-60
  it("counts the Claude Code provider as keyed only when it is switched on and the CLI exists", async () => {
    const svc = service();
    svc.settings.write({ version: 1, models: { strong: { model: { provider: "claude-code", id: "sonnet" } } } });
    expect((await svc.checkSlots(["strong"]))?.body()).toMatchObject({ code: "provider_key_missing", provider: "claude-code" });
    svc.settings.update((s) => ({ ...s, claudeCode: { enabled: true } }));
    expect(await svc.checkSlots(["strong"])).toBeNull();
  });

  it("reports the CLI state without a probe while the switch is off, and with the status once it is on", async () => {
    const svc = service();
    expect(await svc.claudeCodeStatus()).toEqual({ state: "version-unchecked", version: null, minimumVersion: "2.1.316", enabled: false, allowBackground: false });
    svc.settings.write({ version: 1, claudeCode: { enabled: true, allowBackground: true } });
    expect(await svc.claudeCodeStatus()).toEqual({ state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: true, allowBackground: true });
  });
});

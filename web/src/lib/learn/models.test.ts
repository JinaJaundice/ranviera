import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthKeyStatus, ModelCatalogEntry, ModelCatalogResponse } from "@shared/learn/models";
import { overridesFromPins, pinFrom } from "../../apps/settings/models/pins";
import {
  LearnApiError,
  defaultLevelFor,
  formatPrice,
  formatTokens,
  keyLine,
  keyStateWord,
  learnModels,
  modelValue,
  modelsForSlot,
  nearestLevel,
  noticeFor,
  parseModelValue,
  setupGap,
  slotState,
} from "./models";

const entry = (over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id: "m",
  name: "M",
  provider: "p",
  reasoning: false,
  input: ["text"],
  supportedLevels: ["off"],
  cost: null,
  contextWindow: null,
  maxTokens: null,
  ...over,
});
const catalog = (over: Partial<ModelCatalogResponse> = {}): ModelCatalogResponse => ({
  models: [],
  defaults: null,
  rolePins: {},
  slots: { strong: null, cheap: null, vision: null },
  providers: [],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("model values", () => {
  it("splits at the first colon, because an id may hold colons and a provider id does not", () => {
    expect(parseModelValue("openrouter:meta/llama:free")).toEqual({ provider: "openrouter", id: "meta/llama:free" });
    expect(modelValue({ provider: "a", id: "b:c" })).toBe("a:b:c");
    expect(parseModelValue("nocolon")).toBeNull();
    expect(parseModelValue(":x")).toBeNull();
    expect(parseModelValue("x:")).toBeNull();
  });
});

describe("slots", () => {
  it("lists only models that accept images for the vision slot", () => {
    const c = catalog({ models: [entry({ id: "a" }), entry({ id: "b", input: ["text", "image"] })] });
    expect(modelsForSlot(c, "strong").map((m) => m.id)).toEqual(["a", "b"]);
    expect(modelsForSlot(c, "vision").map((m) => m.id)).toEqual(["b"]);
  });

  it("reads a slot as Needed, Key missing, Ready or Not listed", () => {
    const ref = { provider: "p", id: "m" };
    expect(slotState(catalog(), "strong").kind).toBe("needed");
    expect(slotState(catalog({ slots: { strong: ref, cheap: null, vision: null } }), "strong").kind).toBe("key-missing");
    expect(slotState(catalog({ slots: { strong: ref, cheap: null, vision: null }, providers: [{ id: "p", envVar: "P_KEY", keyPresent: false }] }), "strong").kind).toBe("key-missing");
    expect(slotState(catalog({ slots: { strong: ref, cheap: null, vision: null }, providers: [{ id: "p", envVar: "P_KEY", keyPresent: true }] }), "strong").kind).toBe("unlisted");
    expect(slotState(catalog({ slots: { strong: ref, cheap: null, vision: null }, models: [entry()], providers: [{ id: "p", envVar: "P_KEY", keyPresent: true }] }), "strong").kind).toBe("ready");
  });

  it("asks for keys first and then for models, and reports no gap once the three slots are set", () => {
    expect(setupGap(catalog())).toBe("keys");
    const ref = { provider: "p", id: "m" };
    const keyed = catalog({ providers: [{ id: "p", envVar: "K", keyPresent: true }], models: [entry()] });
    expect(setupGap(keyed)).toBe("models");
    expect(setupGap({ ...keyed, slots: { strong: ref, cheap: ref, vision: null } })).toBe("models");
    expect(setupGap({ ...keyed, slots: { strong: ref, cheap: ref, vision: ref } })).toBeNull();
  });
});

describe("thinking levels", () => {
  it("keeps a supported level, or takes the nearest one with a tie going to the lower level", () => {
    expect(nearestLevel(["low", "high"], "high")).toBe("high");
    expect(nearestLevel(["low", "high"], "medium")).toBe("low");
    expect(nearestLevel(["low", "medium"], "max")).toBe("medium");
    expect(nearestLevel(["off"], "high")).toBe("off");
    expect(nearestLevel([], "high")).toBe("high");
  });

  it("takes the first supported level of the default order, or off", () => {
    expect(defaultLevelFor(["off", "low", "high"])).toBe("low");
    expect(defaultLevelFor(["off", "minimal", "xhigh"])).toBe("minimal");
    expect(defaultLevelFor(["off"])).toBe("off");
  });
});

describe("key lines", () => {
  const status = (over: Partial<AuthKeyStatus> = {}): AuthKeyStatus => ({ id: "K", info: null, present: true, masked: "4f2a", length: 64, source: "file", shadowedByEnv: false, ...over });
  it("shows the last four characters and the length, and never more", () => {
    expect(keyLine(status())).toBe("Ends in 4f2a, 64 characters");
    expect(keyLine(status({ masked: null, length: 6 }))).toBe("Saved, 6 characters");
    expect(keyLine(status({ present: false, masked: null, length: null, source: "none" }))).toBe("No key");
  });
  it("says in words where the key comes from", () => {
    expect(keyStateWord(status())).toBe("Connected");
    expect(keyStateWord(status({ source: "env" }))).toBe("Set by an environment variable");
    expect(keyStateWord(status({ present: false }))).toBe("No key");
  });
});

describe("formatting", () => {
  it("writes sizes as 8k or 1.2M and says Not reported for an unknown size", () => {
    expect(formatTokens(8000)).toBe("8k");
    expect(formatTokens(8192)).toBe("8.2k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(null)).toBe("Not reported");
    expect(formatPrice(null)).toBe("Not priced");
    expect(formatPrice({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBe("$3 in, $15 out per million tokens");
  });
});

describe("notices", () => {
  it("shows the refusals about models and keys in the informational tone and a failure in the error tone", () => {
    expect(noticeFor(new LearnApiError(503, { error: "No model is chosen.", code: "models_not_configured", missing: ["strong"] }))).toEqual({ text: "No model is chosen.", tone: "info" });
    expect(noticeFor(new LearnApiError(503, { error: "No key.", code: "provider_key_missing" })).tone).toBe("info");
    expect(noticeFor(new LearnApiError(503, { error: "Not found.", code: "claude_code_unavailable" })).tone).toBe("info");
    expect(noticeFor(new LearnApiError(400, { error: "Bad paste.", code: "bad_request" }))).toEqual({ text: "Bad paste.", tone: "error" });
    expect(noticeFor(new LearnApiError(500, {})).text).toMatch(/status 500/);
    expect(noticeFor(new Error("offline"))).toEqual({ text: "offline", tone: "error" });
  });
});

describe("pins", () => {
  it("builds overrides from whole numbers and a three state reasoning choice", () => {
    expect(overridesFromPins({ a: { context: "4096", maxTokens: "", reasoning: "yes" }, b: { context: "", maxTokens: "", reasoning: "" }, c: { context: "", maxTokens: "256", reasoning: "no" } })).toEqual({
      overrides: { a: { context: 4096, reasoning: true }, c: { maxTokens: 256, reasoning: false } },
    });
  });
  it("names the first bad field", () => {
    expect(overridesFromPins({ a: { context: "1.5", maxTokens: "", reasoning: "" } })).toEqual({ error: "The context size of a must be a whole number of 1 or more." });
    expect(overridesFromPins({ a: { context: "", maxTokens: "0", reasoning: "" } })).toEqual({ error: "The output size of a must be a whole number of 1 or more." });
    expect(overridesFromPins({ a: { context: "-3", maxTokens: "", reasoning: "" } })).toHaveProperty("error");
  });
  it("round trips through the form fields", () => {
    expect(pinFrom({ context: 100, reasoning: false })).toEqual({ context: "100", maxTokens: "", reasoning: "no" });
    expect(pinFrom(undefined)).toEqual({ context: "", maxTokens: "", reasoning: "" });
  });
});

describe("client calls", () => {
  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it("sends the key as a JSON body to the key route and returns the status", async () => {
    const fetchMock = vi.fn(async () => reply({ id: "K", present: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await learnModels.saveKey("OPENAI_API_KEY", "sk-0123456789ab")).toEqual({ id: "K", present: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/learn/keys/OPENAI_API_KEY", expect.objectContaining({ method: "PUT", body: JSON.stringify({ value: "sk-0123456789ab" }) }));
  });

  it("reads the ETag of the custom endpoint and sends it as If-Match", async () => {
    const fetchMock = vi.fn(async () => reply({ baseUrl: null }, 200, { etag: '"abc"' }));
    vi.stubGlobal("fetch", fetchMock);
    const read = await learnModels.custom();
    expect(read.etag).toBe('"abc"');
    await learnModels.connectCustom({ baseUrl: "http://localhost:1/v1", authMode: "keyless" }, read.etag);
    const init = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ "if-match": '"abc"', "content-type": "application/json" });
  });

  it("raises the envelope of the server as an error with its code and extra fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "No model is chosen for strong.", code: "models_not_configured", missing: ["strong"] }, 503)));
    const err = await learnModels.catalog().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LearnApiError);
    expect(err).toMatchObject({ status: 503, code: "models_not_configured", message: "No model is chosen for strong.", body: { missing: ["strong"] } });
  });

  it("copes with a reply that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(learnModels.keys()).rejects.toMatchObject({ status: 502, message: "The server answered with status 502." });
  });
});

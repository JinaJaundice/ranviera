// public-check: synthetic-secrets (the endpoint keys in these tests are made up and must never reach a response)
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCustomService, discoverModels } from "./custom.ts";
import { buildCustomModels, customUsable, normaliseBaseUrl, parseBinding, parseModelList, splitModelIds } from "./endpoint.ts";
import { createModelsService, type ModelsService } from "./index.ts";
import { BINDING_ENTRY, createKeysStore } from "./keys.ts";
import { createSettingsStore } from "./settings.ts";

let dir: string;
let env: NodeJS.ProcessEnv;
let calls: { url: string; auth: string | undefined }[];
let reply: (url: string) => Response;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
  return reply(url);
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function service(): ModelsService {
  return createModelsService({ authFile: path.join(dir, "auth.json"), learnDir: path.join(dir, "learn"), env, fetch: fakeFetch, now: () => new Date("2026-11-01T12:00:00.000Z") });
}
const connect = (svc: ModelsService, body: Record<string, unknown>) => svc.custom.connect(body, svc.custom.etag());

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-custom-"));
  env = {};
  calls = [];
  reply = () => json({ data: [{ id: "llama" }, { id: "vision", architecture: { input_modalities: ["text", "image"] }, context_length: 32000 }] });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("base URL and model ids", () => {
  // B-1-135
  it("drops trailing slashes, keeps the path and refuses other schemes and forbidden parts", () => {
    expect(normaliseBaseUrl("http://localhost:11434/v1///")).toBe("http://localhost:11434/v1");
    expect(normaliseBaseUrl("  https://llm.example.com/api/v1  ")).toBe("https://llm.example.com/api/v1");
    for (const bad of ["ftp://x/v1", "file:///etc", "javascript:alert(1)", "https://u:p@host/v1", "https://host/v1?x=1", "https://host/v1#frag", "not a url", "", 7]) {
      expect(normaliseBaseUrl(bad)).toBeNull();
    }
  });

  // B-1-138
  it("splits typed ids on commas and white space, trims and drops repeats", () => {
    expect(splitModelIds(" a, b\nc  a ,, d ")).toEqual(["a", "b", "c", "d"]);
    expect(splitModelIds(["x y", "x"])).toEqual(["x", "y"]);
  });
});

describe("discovery parser", () => {
  // B-1-140
  it("accepts a bare array, data and models, and rows that are objects or bare strings", () => {
    expect(parseModelList([{ id: "b" }, "a"]).map((m) => m.id)).toEqual(["a", "b"]);
    expect(parseModelList({ data: [{ id: "x" }] }).map((m) => m.id)).toEqual(["x"]);
    expect(parseModelList({ models: ["y", { id: "z" }, { name: "no id" }, 5] }).map((m) => m.id)).toEqual(["y", "z"]);
    expect(() => parseModelList({ other: [] })).toThrow(/not a list of models/);
    expect(() => parseModelList("text")).toThrow(/not a list/);
  });

  // B-1-139, B-1-140
  it("reads image, reasoning and sizes from explicit fields only and never from the name", () => {
    const [vision, think, plain, named] = parseModelList([
      { id: "vision", architecture: { input_modalities: ["text", "image"] }, n_ctx: 16000, max_output_tokens: 2048 },
      { id: "think", supported_parameters: ["temperature", "reasoning_effort"], capabilities: { vision: true } },
      { id: "plain", modalities: ["text"], reasoning: false, context_length: -5, max_context: 1.5 },
      { id: "gpt-vision-reasoning-pro" },
    ]).sort((a, b) => ["vision", "think", "plain", "gpt-vision-reasoning-pro"].indexOf(a.id) - ["vision", "think", "plain", "gpt-vision-reasoning-pro"].indexOf(b.id));
    expect(vision).toEqual({ id: "vision", image: true, context: 16000, maxTokens: 2048 });
    expect(think).toEqual({ id: "think", image: true, reasoning: true });
    expect(plain).toEqual({ id: "plain", reasoning: false });
    expect(named).toEqual({ id: "gpt-vision-reasoning-pro" });
  });

  it("takes the first positive integer among the context fields in the order of the contract", () => {
    const [m] = parseModelList([{ id: "m", context_window: 8000, max_input_tokens: 64000, n_ctx: 1 }]);
    expect(m.context).toBe(64000);
  });

  it("refuses a list over 10,000 models", () => {
    expect(() => parseModelList(Array.from({ length: 10_001 }, (_, i) => `m${i}`))).toThrow(/more than 10000/);
    expect(parseModelList(Array.from({ length: 10_000 }, (_, i) => `m${i}`))).toHaveLength(10_000);
  });
});

describe("discovery over a real socket", () => {
  let server: http.Server;
  let base: string;
  let handler: http.RequestListener;
  beforeEach(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("sends the key as a bearer token only when one is given", async () => {
    const seen: (string | undefined)[] = [];
    handler = (req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(["m"]));
    };
    await discoverModels(base, undefined, fetch);
    await discoverModels(base, "secret-key-value", fetch);
    expect(seen).toEqual([undefined, "Bearer secret-key-value"]);
  });

  // B-1-144
  it("refuses a redirect and an auth failure outright", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/models" });
      res.end();
    };
    await expect(discoverModels(base, undefined, fetch)).rejects.toMatchObject({ fatal: true, message: expect.stringMatching(/redirect/) });
    handler = (_req, res) => {
      res.writeHead(401);
      res.end();
    };
    await expect(discoverModels(base, "k", fetch)).rejects.toMatchObject({ fatal: true, message: expect.stringMatching(/refused the key/) });
    handler = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    await expect(discoverModels(base, "k", fetch)).rejects.toMatchObject({ fatal: false });
  });

  // B-1-144, and the limit is measured on the bytes read, not on a declared length
  it("stops reading a reply that passes 8 MiB, with no content length declared", async () => {
    let sent = 0;
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      const write = () => {
        while (sent < 20 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", write);
        }
        res.end();
      };
      write();
    };
    await expect(discoverModels(base, undefined, fetch)).rejects.toMatchObject({ fatal: true, message: expect.stringMatching(/8 MiB/) });
    expect(sent).toBeLessThan(20 * 1024 * 1024);
  });
});

describe("connect", () => {
  // B-1-149, B-1-150
  it("connects a keyless endpoint, never forwards a stored key, and reads the model list", async () => {
    const svc = service();
    env.CUSTOM_OPENAI_API_KEY = "env-key-should-never-leave";
    const state = await connect(svc, { baseUrl: "http://localhost:11434/v1/", authMode: "keyless" });
    expect(calls).toEqual([{ url: "http://localhost:11434/v1/models", auth: undefined }]);
    expect(state).toMatchObject({ baseUrl: "http://localhost:11434/v1", authMode: "keyless", localConfirmedAt: null });
    expect(state.models.map((m) => m.id)).toEqual(["llama", "vision"]);
    expect(state.models[1]).toEqual({ id: "vision", image: true, context: 32000 });
  });

  it("writes the key and its binding in the keys file, and the state never shows the key", async () => {
    const svc = service();
    const state = await connect(svc, { baseUrl: "https://llm.example.com/v1", authMode: "apiKey", apiKey: "  my-endpoint-key-12345  " });
    expect(calls[0].auth).toBe("Bearer my-endpoint-key-12345");
    const file = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(file.CUSTOM_OPENAI_API_KEY).toBe("my-endpoint-key-12345");
    expect(file[BINDING_ENTRY]).toMatchObject({ version: 1, baseUrl: "https://llm.example.com/v1", authMode: "apiKey", fileKeyBaseUrl: "https://llm.example.com/v1" });
    expect(file[BINDING_ENTRY].id).toMatch(/^[0-9a-f]{32}$/);
    expect(svc.settings.read().customProvider?.credentialBindingId).toBe(file[BINDING_ENTRY].id);
    expect(state).toMatchObject({ keyPresent: true, keySource: "file", keyReuseRequired: false });
    expect(JSON.stringify(state)).not.toContain("my-endpoint-key");
    expect(JSON.stringify(svc.settings.read())).not.toContain("my-endpoint-key");
  });

  // B-1-142
  it("does not send a stored key to a new address without a new key or the reuse flag", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://one.example.com/v1", authMode: "apiKey", apiKey: "first-key-0123456789" });
    calls = [];
    await expect(connect(svc, { baseUrl: "https://two.example.com/v1", authMode: "apiKey" })).rejects.toThrow(/Enter a key/);
    expect(calls).toEqual([]);
    const reused = await connect(svc, { baseUrl: "https://two.example.com/v1", authMode: "apiKey", reuseKey: true });
    expect(calls[0]).toEqual({ url: "https://two.example.com/v1/models", auth: "Bearer first-key-0123456789" });
    expect(reused.baseUrl).toBe("https://two.example.com/v1");
    calls = [];
    await connect(svc, { baseUrl: "https://three.example.com/v1", authMode: "apiKey", apiKey: "third-key-0123456789" });
    expect(calls[0].auth).toBe("Bearer third-key-0123456789");
  });

  it("keeps using the stored key at the same address with no new paste", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://one.example.com/v1", authMode: "apiKey", apiKey: "first-key-0123456789" });
    calls = [];
    await connect(svc, { baseUrl: "https://one.example.com/v1/", authMode: "apiKey", manualModels: ["extra"] });
    expect(calls[0].auth).toBe("Bearer first-key-0123456789");
    expect(svc.custom.state().manualModels).toEqual(["extra"]);
  });

  // B-1-142
  it("needs explicit consent before a key from the environment is used, and refuses a typed key while the environment owns it", async () => {
    const svc = service();
    env.CUSTOM_OPENAI_API_KEY = "env-owned-key-0123456789";
    await expect(connect(svc, { baseUrl: "https://one.example.com/v1", authMode: "apiKey" })).rejects.toThrow(/Enter a key/);
    await expect(connect(svc, { baseUrl: "https://one.example.com/v1", authMode: "apiKey", apiKey: "typed-key-0123456789" })).rejects.toThrow(/environment variable/);
    expect(calls).toEqual([]);
    const state = await connect(svc, { baseUrl: "https://one.example.com/v1", authMode: "apiKey", reuseKey: true });
    expect(calls[0].auth).toBe("Bearer env-owned-key-0123456789");
    expect(state.keySource).toBe("env");
    expect(fs.existsSync(path.join(dir, "auth.json")) && JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).CUSTOM_OPENAI_API_KEY).toBeFalsy();
  });

  // B-1-143
  it("refuses forbidden URL parts and a bad body before any probe", async () => {
    const svc = service();
    await expect(connect(svc, { baseUrl: "https://u:p@host/v1", authMode: "keyless" })).rejects.toThrow(/base URL/);
    await expect(connect(svc, { baseUrl: "https://host/v1?key=1", authMode: "keyless" })).rejects.toThrow(/base URL/);
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "maybe" })).rejects.toThrow(/keyless or apiKey/);
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "keyless", manualModels: "a" })).rejects.toThrow(/list of text/);
    expect(calls).toEqual([]);
  });

  // B-1-149
  it("fails on an auth failure or a redirect, falls back to typed ids on other failures and says what to do when there are none", async () => {
    const svc = service();
    reply = () => json({}, 401);
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "apiKey", apiKey: "key-0123456789ab", manualModels: ["typed"] })).rejects.toThrow(/refused the key/);
    reply = () => new Response(null, { status: 302, headers: { location: "https://elsewhere/" } });
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "keyless", manualModels: ["typed"] })).rejects.toThrow(/redirect/);
    reply = () => json({}, 500);
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "keyless" })).rejects.toThrow(/Add the model ids by hand/);
    const state = await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless", manualModels: ["typed-a", "typed-b"] });
    expect(state.models.map((m) => m.id)).toEqual(["typed-a", "typed-b"]);
    expect(state.manualModels).toEqual(["typed-a", "typed-b"]);
    expect(state.models.some((m) => m.image || m.reasoning)).toBe(false);
  });

  // B-1-149
  it("keeps the earlier snapshot at the same address when a later probe fails", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless" });
    reply = () => json({}, 503);
    const state = await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless", manualModels: ["fresh"] });
    expect(state.models.map((m) => m.id)).toEqual(["fresh", "llama", "vision"]);
    await expect(connect(svc, { baseUrl: "https://other.example/v1", authMode: "keyless" })).rejects.toThrow(/Add the model ids by hand/);
  });

  // B-1-138
  it("lets the metadata that discovery found win over a typed id", async () => {
    const svc = service();
    const state = await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless", manualModels: ["vision", "extra"] });
    expect(state.models.find((m) => m.id === "vision")).toEqual({ id: "vision", image: true, context: 32000 });
    expect(state.models.find((m) => m.id === "extra")).toEqual({ id: "extra" });
  });

  it("records the time of the local statement, keeps it at the same address and clears it for a new one", async () => {
    const svc = service();
    const first = await connect(svc, { baseUrl: "http://192.168.1.20:8000/v1", authMode: "keyless", localConfirmed: true });
    expect(first.localConfirmedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(svc.providerClassOf({ provider: "custom", id: "llama" })).toBe("local");
    const again = await connect(svc, { baseUrl: "http://192.168.1.20:8000/v1", authMode: "keyless" });
    expect(again.localConfirmedAt).toBe("2026-11-01T12:00:00.000Z");
    const moved = await connect(svc, { baseUrl: "https://llm.example.com/v1", authMode: "keyless" });
    expect(moved.localConfirmedAt).toBeNull();
    expect(svc.providerClassOf({ provider: "custom", id: "llama" })).toBe("hosted");
    const revoked = await connect(svc, { baseUrl: "http://localhost:1234/v1", authMode: "keyless", localConfirmed: false });
    expect(revoked.localConfirmedAt).toBeNull();
    expect(svc.providerClassOf({ provider: "custom", id: "llama" })).toBe("local");
  });
});

describe("entity tag", () => {
  it("needs If-Match and answers 409 etag_mismatch when it is stale", async () => {
    const svc = service();
    await expect(svc.custom.connect({ baseUrl: "https://host/v1", authMode: "keyless" }, undefined)).rejects.toMatchObject({ status: 400 });
    const stale = svc.custom.etag();
    await svc.custom.connect({ baseUrl: "https://host/v1", authMode: "keyless" }, stale);
    expect(svc.custom.etag()).not.toBe(stale);
    await expect(svc.custom.connect({ baseUrl: "https://host/v1", authMode: "keyless" }, stale)).rejects.toMatchObject({ status: 409, code: "etag_mismatch" });
    await expect(svc.custom.pins({ overrides: {} }, stale)).rejects.toMatchObject({ status: 409 });
    await expect(svc.custom.disconnect(stale)).rejects.toMatchObject({ status: 409 });
  });

  it("changes when a key appears or goes, and holds no key material", async () => {
    const svc = service();
    const a = svc.custom.etag();
    env.CUSTOM_OPENAI_API_KEY = "some-key-0123456789";
    expect(svc.custom.etag()).not.toBe(a);
    expect(svc.custom.etag()).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("answers 409 when the endpoint changes while the probe runs", async () => {
    const svc = service();
    reply = () => {
      svc.keys.mutate((e) => {
        e.CUSTOM_OPENAI_API_KEY = "someone-else-0123456789";
      });
      return json(["m"]);
    };
    await expect(connect(svc, { baseUrl: "https://host/v1", authMode: "keyless" })).rejects.toMatchObject({ status: 409, code: "etag_mismatch" });
    expect(svc.settings.read().customProvider).toBeUndefined();
  });
});

describe("pins", () => {
  // B-1-137
  it("saves whole counts of 1 or more and a three state reasoning pin, and prunes ids that are not listed", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless" });
    calls = [];
    const state = await svc.custom.pins({ overrides: { llama: { context: 4096, maxTokens: 512, reasoning: true }, vision: { reasoning: false }, ghost: { context: 9 } } }, svc.custom.etag());
    expect(state.overrides).toEqual({ llama: { context: 4096, maxTokens: 512, reasoning: true }, vision: { reasoning: false } });
    expect(calls).toEqual([]); // pins never contact the server
    await expect(svc.custom.pins({ overrides: { llama: { context: 1.5 } } }, svc.custom.etag())).rejects.toThrow(/whole number/);
    await expect(svc.custom.pins({ overrides: { llama: { maxTokens: 0 } } }, svc.custom.etag())).rejects.toThrow(/whole number/);
    await expect(svc.custom.pins({ overrides: { llama: { reasoning: "yes" } } }, svc.custom.etag())).rejects.toThrow(/true or false/);
    await expect(svc.custom.pins({}, svc.custom.etag())).rejects.toThrow(/overrides/);
  });

  it("refuses pins while no endpoint is connected", async () => {
    const svc = service();
    await expect(svc.custom.pins({ overrides: {} }, svc.custom.etag())).rejects.toThrow(/No endpoint is connected/);
  });

  // B-1-139
  it("lets a pin beat the endpoint, which beats the compiled default of 8192 and 4096", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://host/v1", authMode: "keyless" });
    await svc.custom.pins({ overrides: { vision: { context: 1000, reasoning: true } } }, svc.custom.etag());
    const models = buildCustomModels(svc.settings.read().customProvider ?? {});
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId.llama).toMatchObject({ contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"] });
    expect(byId.vision).toMatchObject({ contextWindow: 1000, maxTokens: 4096, reasoning: true, input: ["text", "image"] });
  });
});

describe("registration and the binding", () => {
  // B-1-146
  it("registers the endpoint as provider custom, lists it unpriced and sees a key change on the next read", async () => {
    const svc = service();
    expect((await svc.catalog()).providers.some((p) => p.id === "custom")).toBe(false);
    await connect(svc, { baseUrl: "https://host/v1", authMode: "apiKey", apiKey: "endpoint-key-0123456789" });
    const cat = await svc.catalog();
    expect(cat.providers.find((p) => p.id === "custom")).toEqual({ id: "custom", envVar: "CUSTOM_OPENAI_API_KEY", keyPresent: true });
    const llama = cat.models.find((m) => m.provider === "custom" && m.id === "llama");
    expect(llama).toMatchObject({ cost: null, contextWindow: 8192, maxTokens: 4096, supportedLevels: ["off"] });
    const auth = await svc.registry.models.getAuth("custom");
    expect(auth?.auth.apiKey).toBe("endpoint-key-0123456789");
    svc.keys.mutate((e) => {
      e.CUSTOM_OPENAI_API_KEY = "rotated-key-0123456789";
    });
    expect((await svc.registry.models.getAuth("custom"))?.auth.apiKey).toBe("rotated-key-0123456789");
  });

  it("resolves a keyless endpoint with a placeholder and no stored key", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "http://localhost:11434/v1", authMode: "keyless" });
    expect((await svc.catalog()).providers.find((p) => p.id === "custom")?.keyPresent).toBe(true);
    expect((await svc.registry.models.getAuth("custom"))?.auth.apiKey).toBe("keyless");
  });

  // B-1-148
  it("stays closed when the settings and the binding disagree, for example after a half committed change", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://host/v1", authMode: "apiKey", apiKey: "endpoint-key-0123456789" });
    expect(svc.registry.customRegistered()).toBe(true);
    svc.settings.update((s) => ({ ...s, customProvider: { ...(s.customProvider ?? {}), baseUrl: "https://attacker.example/v1" } }));
    expect(svc.registry.customRegistered()).toBe(false);
    expect(await svc.registry.models.getAuth("custom")).toBeUndefined();
    expect((await svc.catalog()).models.some((m) => m.provider === "custom")).toBe(false);
    // a settings record with no binding id, as a development copy would have, also stays closed
    expect(customUsable({ baseUrl: "https://host/v1", authMode: "apiKey" }, parseBinding({ version: 1, id: "x", baseUrl: "https://host/v1", authMode: "apiKey" }))).toBe(false);
  });

  // B-1-145
  it("restores the previous key and binding when the settings write fails", async () => {
    const keys = createKeysStore({ authFile: path.join(dir, "auth.json"), env });
    const real = createSettingsStore({ file: path.join(dir, "learn", "settings.json") });
    let failNext = false;
    const settings = {
      ...real,
      update: (change: Parameters<typeof real.update>[0]) => {
        if (failNext) throw new Error("disk full");
        return real.update(change);
      },
    };
    const custom = createCustomService({ keys, settings, fetch: fakeFetch });
    await custom.connect({ baseUrl: "https://one.example.com/v1", authMode: "apiKey", apiKey: "first-key-0123456789" }, custom.etag());
    const before = fs.readFileSync(path.join(dir, "auth.json"), "utf8");
    failNext = true;
    await expect(custom.connect({ baseUrl: "https://two.example.com/v1", authMode: "apiKey", apiKey: "second-key-0123456789" }, custom.etag())).rejects.toThrow("disk full");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"))).toEqual(JSON.parse(before));
    expect(real.read().customProvider?.baseUrl).toBe("https://one.example.com/v1");
  });

  it("disconnects with a disabled binding, so a stray environment key cannot revive the endpoint", async () => {
    const svc = service();
    await connect(svc, { baseUrl: "https://host/v1", authMode: "apiKey", apiKey: "endpoint-key-0123456789" });
    const state = await svc.custom.disconnect(svc.custom.etag());
    expect(state).toMatchObject({ baseUrl: null, authMode: null, models: [], keyReuseRequired: true });
    expect(parseBinding(svc.keys.rawEntry(BINDING_ENTRY))).toMatchObject({ authMode: "disabled" });
    expect(svc.registry.customRegistered()).toBe(false);
    env.CUSTOM_OPENAI_API_KEY = "stray-env-key-0123456789";
    expect(svc.registry.customRegistered()).toBe(false);
    expect((await svc.catalog()).providers.some((p) => p.id === "custom")).toBe(false);
  });

  it("serialises two connects so that their file writes never interleave", async () => {
    const svc = service();
    const tag = svc.custom.etag();
    const results = await Promise.allSettled([
      svc.custom.connect({ baseUrl: "https://a.example.com/v1", authMode: "keyless" }, tag),
      svc.custom.connect({ baseUrl: "https://b.example.com/v1", authMode: "keyless" }, tag),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(svc.custom.state().baseUrl).toBe("https://a.example.com/v1");
  });
});

describe("a key over plain http", () => {
  const remote = "http://203.0.113.5:8000/v1";

  it("is refused for a host that is not loopback unless the person confirmed it, and nothing is sent", async () => {
    const svc = service();
    await expect(connect(svc, { baseUrl: remote, authMode: "apiKey", apiKey: "my-endpoint-key-12345" })).rejects.toThrow(/http/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("is allowed after localConfirmed, for loopback, and for https", async () => {
    const svc = service();
    await connect(svc, { baseUrl: remote, authMode: "apiKey", apiKey: "my-endpoint-key-12345", localConfirmed: true });
    expect(calls[0].auth).toBe("Bearer my-endpoint-key-12345");
    await connect(svc, { baseUrl: "http://localhost:1234/v1", authMode: "apiKey", apiKey: "my-endpoint-key-12345" });
  });

  it("keeps a stored key unusable at call time when the endpoint is plain http, remote and not confirmed", () => {
    const binding = parseBinding({ version: 1, id: "x", baseUrl: remote, authMode: "apiKey" });
    expect(customUsable({ baseUrl: remote, authMode: "apiKey", credentialBindingId: "x" }, binding)).toBe(false);
    expect(customUsable({ baseUrl: remote, authMode: "apiKey", credentialBindingId: "x", localConfirmedAt: "2026-11-01T12:00:00.000Z" }, binding)).toBe(true);
  });
});

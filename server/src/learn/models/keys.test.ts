// public-check: synthetic-secrets (the provider keys in these tests are made up and must never reach a response)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BINDING_ENTRY,
  PROVIDER_KEY_TABLE,
  createKeysStore,
  isWritableKeyName,
  keyInfo,
  keyShapeError,
  providerEnvVars,
  writableKeyNames,
} from "./keys.ts";

let dir: string;
let file: string;
const GOOD = "sk-or-v1-0123456789abcdef";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-keys-"));
  file = path.join(dir, "auth.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("provider table", () => {
  // B-1-07 and B-1-08: the table equals the library's own table, and a Pi upgrade that adds or renames a provider fails here
  it("equals the table that pi-ai 1.4.0 defines for its key based providers", async () => {
    // each provider is asked to resolve a key from an empty environment that records the names it reads
    const derived = new Map<string, string>();
    for (const provider of builtinProviders()) {
      const asked: string[] = [];
      const ctx = {
        env: async (name: string) => {
          asked.push(name);
          return undefined;
        },
        fileExists: async () => false,
      };
      await provider.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal });
      // a pasted key sits in a variable that ends in _API_KEY, or in HF_TOKEN. Bedrock, Copilot and Codex read other credentials
      const envVar = asked.find((n) => /_API_KEY$|^HF_TOKEN$/.test(n));
      if (envVar) derived.set(provider.id, envVar);
    }
    const ours = new Map(PROVIDER_KEY_TABLE.map((r) => [r.id, r.envVar]));
    expect([...ours.entries()].sort()).toEqual([...derived.entries()].sort());
    expect(providerEnvVars()).toHaveLength(35);
    expect(new Set(PROVIDER_KEY_TABLE.map((r) => r.id)).size).toBe(PROVIDER_KEY_TABLE.length);
  });

  it("names 35 provider variables and the two search keys as writable, and no other name", () => {
    expect(writableKeyNames()).toHaveLength(37);
    expect(isWritableKeyName("OPENROUTER_API_KEY")).toBe(true);
    expect(isWritableKeyName("TAVILY_API_KEY")).toBe(true);
    expect(isWritableKeyName("CUSTOM_OPENAI_API_KEY")).toBe(false);
    expect(isWritableKeyName(BINDING_ENTRY)).toBe(false);
    expect(isWritableKeyName("PATH")).toBe(false);
    expect(keyInfo("OPENROUTER_API_KEY")?.label).toBe("OpenRouter");
    expect(keyInfo("PATH")).toBeNull();
  });
});

describe("shape rules", () => {
  it("trims, then holds a provider key to 12 characters with no white space", () => {
    expect(keyShapeError("OPENAI_API_KEY", `  ${GOOD}  `)).toBeNull();
    expect(keyShapeError("OPENAI_API_KEY", "short")).toMatch(/12 characters/);
    expect(keyShapeError("OPENAI_API_KEY", "has a space inside it")).toMatch(/space/);
    expect(keyShapeError("OPENAI_API_KEY", 42)).toMatch(/text/);
  });

  it("holds a Tavily key to the tvly- prefix and 20 characters, and a Brave key to 20", () => {
    expect(keyShapeError("TAVILY_API_KEY", "tvly-0123456789abcdefgh")).toBeNull();
    expect(keyShapeError("TAVILY_API_KEY", "0123456789abcdefghij0123")).toMatch(/tvly-/);
    expect(keyShapeError("TAVILY_API_KEY", "tvly-short")).toMatch(/20 characters/);
    expect(keyShapeError("BRAVE_API_KEY", "x".repeat(19))).toMatch(/20 characters/);
    expect(keyShapeError("BRAVE_API_KEY", "x".repeat(20))).toBeNull();
  });
});

describe("keys store", () => {
  it("reads a missing or corrupt file as no keys and never throws", () => {
    const env: NodeJS.ProcessEnv = {};
    const store = createKeysStore({ authFile: file, env });
    expect(store.list()).toEqual([]);
    fs.writeFileSync(file, "{ not json");
    expect(store.list()).toEqual([]);
    fs.writeFileSync(file, "[1,2]");
    expect(store.statusOf("OPENAI_API_KEY").present).toBe(false);
  });

  it("writes with mode 0600 through a temporary file and leaves no temporary file", () => {
    const store = createKeysStore({ authFile: file, env: {} });
    store.save("OPENROUTER_API_KEY", GOOD);
    store.save("OPENAI_API_KEY", GOOD);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ OPENROUTER_API_KEY: GOOD, OPENAI_API_KEY: GOOD });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((n) => n !== "auth.json.bak")).toEqual(["auth.json"]);
  });

  it("keeps unknown entries as they are on a write and shows them as generic rows", () => {
    fs.writeFileSync(file, JSON.stringify({ MY_OTHER_TOKEN: "abcdefghijklmnopqrst", note: { keep: true } }));
    const env: NodeJS.ProcessEnv = {};
    const store = createKeysStore({ authFile: file, env });
    store.save("OPENAI_API_KEY", GOOD);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ MY_OTHER_TOKEN: "abcdefghijklmnopqrst", note: { keep: true }, OPENAI_API_KEY: GOOD });
    const ids = store.list().map((r) => r.id);
    expect(ids).toContain("MY_OTHER_TOKEN");
    expect(store.statusOf("MY_OTHER_TOKEN").info).toBeNull();
    expect(env.MY_OTHER_TOKEN).toBe("abcdefghijklmnopqrst");
  });

  it("never places a dangerous name from a hand edited file in the environment", () => {
    fs.writeFileSync(file, JSON.stringify({ NODE_OPTIONS: "--require evil.js", PATH: "/tmp/evil", LD_PRELOAD: "evil.so" }));
    const env: NodeJS.ProcessEnv = {};
    createKeysStore({ authFile: file, env });
    expect(env).toEqual({});
  });

  it("applies a saved key at once and a hand edit on the next read", () => {
    const env: NodeJS.ProcessEnv = {};
    const store = createKeysStore({ authFile: file, env });
    store.save("OPENROUTER_API_KEY", GOOD);
    expect(env.OPENROUTER_API_KEY).toBe(GOOD);
    expect(store.providerKeyPresent("openrouter")).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ OPENROUTER_API_KEY: "another-value-12345" }));
    expect(store.effective("OPENROUTER_API_KEY")?.value).toBe("another-value-12345");
    expect(env.OPENROUTER_API_KEY).toBe("another-value-12345");
    fs.writeFileSync(file, "{}");
    expect(store.providerKeyPresent("openrouter")).toBe(false);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("lets a real environment variable win, reports the shadow and never overwrites it", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "env-value-0123456789" };
    const store = createKeysStore({ authFile: file, env });
    const saved = store.save("OPENAI_API_KEY", GOOD);
    expect(env.OPENAI_API_KEY).toBe("env-value-0123456789");
    expect(saved).toMatchObject({ source: "env", shadowedByEnv: true, present: true, length: 20, masked: "6789" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).OPENAI_API_KEY).toBe(GOOD);
  });

  it("does not report a shadow when the file and the environment hold the same value", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: GOOD };
    const store = createKeysStore({ authFile: file, env });
    expect(store.save("OPENAI_API_KEY", GOOD).shadowedByEnv).toBe(false);
  });

  it("removes only its own environment copy on delete, and removing an absent key is quiet", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "env-value-0123456789" };
    const store = createKeysStore({ authFile: file, env });
    store.save("OPENAI_API_KEY", GOOD);
    store.save("GROQ_API_KEY", GOOD);
    expect(env.GROQ_API_KEY).toBe(GOOD);
    store.remove("GROQ_API_KEY");
    store.remove("OPENAI_API_KEY");
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("env-value-0123456789");
    expect(store.remove("GROQ_API_KEY")).toMatchObject({ present: false, source: "none" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("is idempotent when the store is created again, so deleted variables do not return", () => {
    const env: NodeJS.ProcessEnv = {};
    const first = createKeysStore({ authFile: file, env });
    first.save("GROQ_API_KEY", GOOD);
    first.remove("GROQ_API_KEY");
    createKeysStore({ authFile: file, env });
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it("refuses a bad shape or an unknown name and stores and reflects nothing", () => {
    const env: NodeJS.ProcessEnv = {};
    const store = createKeysStore({ authFile: file, env });
    expect(() => store.save("OPENAI_API_KEY", "short")).toThrow(/12 characters/);
    expect(() => store.save("OPENAI_API_KEY", "one two three four five six")).toThrow(/space/);
    expect(() => store.save("SOMETHING_ELSE", GOOD)).toThrow(/not a key/);
    expect(() => store.save("CUSTOM_OPENAI_API_KEY", GOOD)).toThrow(/not a key/);
    expect(() => store.save(BINDING_ENTRY, GOOD)).toThrow(/not a key/);
    expect(fs.existsSync(file)).toBe(false);
    expect(env).toEqual({});
  });

  it("shows the last four characters and the length and never a short key in full", () => {
    fs.writeFileSync(file, JSON.stringify({ GROQ_API_KEY: "abcdefghijkl", MY_SHORT: "tiny" }));
    const store = createKeysStore({ authFile: file, env: {} });
    expect(store.statusOf("GROQ_API_KEY")).toMatchObject({ masked: "ijkl", length: 12 });
    expect(store.statusOf("MY_SHORT").masked).toBeNull();
    expect(JSON.stringify(store.list())).not.toContain("abcdefgh");
  });

  it("lists no row for a provider with no key and never lists the custom key or the binding", () => {
    fs.writeFileSync(file, JSON.stringify({ [BINDING_ENTRY]: { version: 1, id: "x", authMode: "keyless" }, CUSTOM_OPENAI_API_KEY: "abcdefghijklmnop" }));
    const store = createKeysStore({ authFile: file, env: {} });
    expect(store.list()).toEqual([]);
  });

  it("ignores real environment keys under LEARN_IGNORE_ENV_KEYS and reads only the file", () => {
    fs.writeFileSync(file, JSON.stringify({ GROQ_API_KEY: GOOD }));
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "env-value-0123456789", LEARN_IGNORE_ENV_KEYS: "1", UNRELATED: "keep" };
    const store = createKeysStore({ authFile: file, env });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.UNRELATED).toBe("keep");
    expect(store.list().map((r) => [r.id, r.source])).toEqual([["GROQ_API_KEY", "file"]]);
    store.save("OPENAI_API_KEY", GOOD);
    expect(env.OPENAI_API_KEY).toBe(GOOD);
  });

  it("hands a child process an environment without the names that only the store injected", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/x", OPENAI_API_KEY: "env-value-0123456789" };
    const store = createKeysStore({ authFile: file, env });
    store.save("GROQ_API_KEY", GOOD);
    store.save("OPENAI_API_KEY", GOOD);
    expect(store.injectedNames()).toEqual(["GROQ_API_KEY"]);
    expect(store.scrubbed()).toEqual({ HOME: "/home/x", OPENAI_API_KEY: "env-value-0123456789" });
  });

  it("writes the key table and a binding entry in one write through mutate", () => {
    const store = createKeysStore({ authFile: file, env: {} });
    store.mutate((e) => {
      e.CUSTOM_OPENAI_API_KEY = "abcdefghijklmnop";
      e[BINDING_ENTRY] = { version: 1, id: "a".repeat(32), authMode: "apiKey" };
    });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["CUSTOM_OPENAI_API_KEY", BINDING_ENTRY].sort());
  });
});

describe("an unreadable keys file", () => {
  const other = "sk-or-v1-aaaaaaaaaaaaaaaa";

  it("refuses save, remove and mutate, and leaves the file as it was", () => {
    const store = createKeysStore({ authFile: file, env: {} });
    store.save("OPENAI_API_KEY", GOOD);
    store.save("ANTHROPIC_API_KEY", other);
    const broken = `${fs.readFileSync(file, "utf8").trimEnd().slice(0, -1)},}`;
    fs.writeFileSync(file, broken);
    expect(() => store.save("GROQ_API_KEY", "gsk_cccccccccccccccc")).toThrow(/auth\.json/);
    expect(() => store.remove("OPENAI_API_KEY")).toThrow(/auth\.json/);
    expect(() => store.mutate((e) => (e.x = 1))).toThrow(/auth\.json/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).not.toBe(broken);
  });

  it("refuses when the file is a JSON array, and still lets reads report no keys", () => {
    fs.writeFileSync(file, "[1]");
    const store = createKeysStore({ authFile: file, env: {} });
    expect(store.list()).toEqual([]);
    expect(() => store.save("OPENAI_API_KEY", GOOD)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("[1]");
  });

  it("treats a missing file as empty and writes it", () => {
    const store = createKeysStore({ authFile: file, env: {} });
    store.save("OPENAI_API_KEY", GOOD);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ OPENAI_API_KEY: GOOD });
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("keeps the previous file as auth.json.bak before each replacement", () => {
    const store = createKeysStore({ authFile: file, env: {} });
    store.save("OPENAI_API_KEY", GOOD);
    store.save("ANTHROPIC_API_KEY", other);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ OPENAI_API_KEY: GOOD });
    store.remove("OPENAI_API_KEY");
    expect(Object.keys(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });
});

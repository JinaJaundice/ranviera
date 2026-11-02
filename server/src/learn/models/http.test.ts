// public-check: synthetic-secrets (the provider keys in these tests are made up and must never reach a response)
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearnEventName } from "../../../../shared/learn/events.ts";
import { handleModels } from "./http.ts";
import { createModelsService, type ModelsService } from "./index.ts";

const KEY = "sk-test-0123456789abcdef";
let dir: string;
let svc: ModelsService;
let server: http.Server;
let base: string;
let events: LearnEventName[];
let stub: (url: string) => Response;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-http-"));
  events = [];
  stub = () => new Response(JSON.stringify({ data: [{ id: "llama" }] }), { status: 200 });
  const faux = fauxProvider({ provider: "claude-code", models: [{ id: "sonnet", reasoning: true }] });
  svc = createModelsService({
    authFile: path.join(dir, "auth.json"),
    learnDir: path.join(dir, "learn"),
    env: {},
    extraProviders: [faux.provider],
    claudeCodeStatus: async () => ({ state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: false, allowBackground: false }),
    fetch: (async (input: Parameters<typeof fetch>[0]) => stub(String(input))) as typeof fetch,
    emit: (e) => events.push(e),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    handleModels(svc, req, res, url.pathname, url.searchParams).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not mine" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/learn/${p}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

describe("routes 1 and 2: catalogue and keys", () => {
  it("serves the catalogue with no-store and lists keys masked", async () => {
    let r = await call("GET", "models");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toMatchObject({ models: [], defaults: null, slots: { strong: null, cheap: null, vision: null } });
    r = await call("PUT", "keys/OPENROUTER_API_KEY", { value: KEY });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: "OPENROUTER_API_KEY", present: true, masked: "cdef", length: KEY.length, source: "file", shadowedByEnv: false });
    r = await call("GET", "keys");
    expect(r.json.keys).toHaveLength(1);
    expect(r.json.providers).toHaveLength(39);
    expect(r.json.providers[0]).toEqual({ id: "ant-ling", envVar: "ANT_LING_API_KEY", label: "Ant Ling" });
    expect(JSON.stringify(r.json)).not.toContain(KEY);
    expect((await call("GET", "models")).json.models.some((m: { provider: string }) => m.provider === "openrouter")).toBe(true);
    expect(events).toContain("models-changed");
  });
});

describe("routes 3 and 4: save and remove a key", () => {
  it("answers 400 for a bad paste, 404 for an unknown name and the custom key, and stores nothing", async () => {
    expect((await call("PUT", "keys/OPENAI_API_KEY", { value: "short" })).status).toBe(400);
    expect((await call("PUT", "keys/OPENAI_API_KEY", { value: "has space in it ok" })).status).toBe(400);
    expect((await call("PUT", "keys/PATH", { value: KEY })).json).toMatchObject({ code: "not_found" });
    expect((await call("PUT", "keys/CUSTOM_OPENAI_API_KEY", { value: KEY })).status).toBe(404);
    expect((await call("PUT", "keys/__cortex_custom_provider_binding", { value: KEY })).status).toBe(404);
    expect((await call("DELETE", "keys/CUSTOM_OPENAI_API_KEY")).status).toBe(404);
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("removes a key and treats a second removal as a quiet success", async () => {
    await call("PUT", "keys/GROQ_API_KEY", { value: KEY });
    expect((await call("DELETE", "keys/GROQ_API_KEY")).json).toMatchObject({ present: false, source: "none" });
    expect((await call("DELETE", "keys/GROQ_API_KEY")).status).toBe(200);
  });

  it("answers 415 for a body that is not JSON and 405 for another method", async () => {
    const res = await fetch(`${base}/api/learn/keys/GROQ_API_KEY`, { method: "PUT", headers: { "content-type": "text/plain" }, body: KEY });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { code: string }).code).toBe("unsupported_media_type");
    const post = await call("POST", "keys/GROQ_API_KEY", {});
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("PUT, DELETE");
    expect((await call("POST", "models", {})).status).toBe(405);
  });

  it("answers 400 for a body that is not an object", async () => {
    expect((await call("PUT", "keys/GROQ_API_KEY", "[1]")).status).toBe(400);
    expect((await call("PUT", "keys/GROQ_API_KEY", "not json")).json.code).toBe("bad_request");
  });
});

describe("route 5: Claude Code status", () => {
  it("probes only after the switch is on", async () => {
    expect((await call("GET", "claude-code")).json).toEqual({ state: "version-unchecked", version: null, minimumVersion: "2.1.316", enabled: false, allowBackground: false });
    await call("PUT", "settings", { claudeCode: { enabled: true, allowBackground: true } });
    expect((await call("GET", "claude-code")).json).toEqual({ state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: true, allowBackground: true });
  });
});

describe("routes 6 to 9: the custom endpoint", () => {
  it("reads the state with an ETag and connects, pins and disconnects with If-Match", async () => {
    const get = await call("GET", "custom-provider");
    const tag = get.headers.get("etag") ?? "";
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(get.json).toMatchObject({ baseUrl: null, authMode: null, models: [], keyPresent: false });
    const h = { "if-match": tag, origin: base };
    const connected = await call("POST", "custom-provider", { baseUrl: "http://localhost:11434/v1", authMode: "keyless" }, h);
    expect(connected.status).toBe(200);
    expect(connected.json.models).toEqual([{ id: "llama" }]);
    const tag2 = connected.headers.get("etag") ?? "";
    expect(tag2).not.toBe(tag);
    expect((await call("POST", "custom-provider", { baseUrl: "http://localhost:11434/v1", authMode: "keyless" }, h)).json).toMatchObject({ code: "etag_mismatch" });
    const pinned = await call("PATCH", "custom-provider", { overrides: { llama: { context: 2048 } } }, { "if-match": tag2, origin: base });
    expect(pinned.json.overrides).toEqual({ llama: { context: 2048 } });
    const gone = await call("DELETE", "custom-provider", undefined, { "if-match": pinned.headers.get("etag") ?? "", origin: base });
    expect(gone.json).toMatchObject({ baseUrl: null, models: [] });
  });

  // B-1-143
  it("refuses a cross origin, an opaque origin and a cross site request, and a body that is not JSON or is over 64 KiB", async () => {
    const tag = (await call("GET", "custom-provider")).headers.get("etag") ?? "";
    const body = { baseUrl: "http://localhost:1/v1", authMode: "keyless" };
    for (const origin of ["https://evil.example", "null"]) {
      const r = await call("POST", "custom-provider", body, { "if-match": tag, origin });
      expect(r.status).toBe(403);
    }
    expect((await call("POST", "custom-provider", body, { "if-match": tag, origin: base, "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await fetch(`${base}/api/learn/custom-provider`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "if-match": tag, origin: base }, body: "baseUrl=x" });
    expect(form.status).toBe(415);
    const big = await call("POST", "custom-provider", { baseUrl: "http://localhost:1/v1", authMode: "keyless", pad: "x".repeat(70 * 1024) }, { "if-match": tag, origin: base });
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("too_large");
    expect(svc.settings.read().customProvider).toBeUndefined();
  });

  it("never returns the key", async () => {
    const tag = (await call("GET", "custom-provider")).headers.get("etag") ?? "";
    const r = await call("POST", "custom-provider", { baseUrl: "https://host/v1", authMode: "apiKey", apiKey: "endpoint-key-0123456789" }, { "if-match": tag, origin: base });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("endpoint-key");
    expect(JSON.stringify((await call("GET", "keys")).json)).not.toContain("endpoint-key");
    expect(JSON.stringify((await call("GET", "settings")).json)).not.toContain("endpoint-key");
  });
});

describe("routes 10 to 12: settings", () => {
  it("returns the empty record, replaces it through the sanitiser and records the Claude Code times", async () => {
    expect((await call("GET", "settings")).json).toEqual({ version: 1 });
    const r = await call("PUT", "settings", { compaction: { thresholdTokens: 10 }, claudeCode: { enabled: true }, future: { keep: true } });
    expect(r.json).toEqual({ version: 1, compaction: { thresholdTokens: 32000 }, claudeCode: { enabled: true, enabledAt: "2026-11-01T12:00:00.000Z" }, future: { keep: true } });
    const off = await call("PUT", "settings", { claudeCode: { enabled: false } });
    expect(off.json).toEqual({ version: 1, claudeCode: { enabled: false } });
    expect(events).toContain("settings-changed");
  });

  it("leaves the custom endpoint to its own routes", async () => {
    const tag = (await call("GET", "custom-provider")).headers.get("etag") ?? "";
    await call("POST", "custom-provider", { baseUrl: "http://localhost:11434/v1", authMode: "keyless" }, { "if-match": tag, origin: base });
    const r = await call("PUT", "settings", { customProvider: { baseUrl: "https://attacker.example/v1" } });
    expect(r.json.customProvider.baseUrl).toBe("http://localhost:11434/v1");
    const cleared = await call("PUT", "settings", {});
    expect(cleared.json.customProvider.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("validates the models section against the catalogue, clamps the level and returns the section", async () => {
    await call("PUT", "keys/ANTHROPIC_API_KEY", { value: KEY });
    const model = svc.registry.models.getModels("anthropic").find((m) => m.reasoning);
    if (!model) throw new Error("no reasoning model in the catalogue");
    const ok = await call("PUT", "settings/models", { strong: { model: { provider: "anthropic", id: model.id }, thinkingLevel: "max" } });
    expect(ok.status).toBe(200);
    expect(ok.json.strong.model).toEqual({ provider: "anthropic", id: model.id });
    expect((await call("GET", "settings")).json.models.strong.model.id).toBe(model.id);
    expect((await call("GET", "models")).json.slots.strong).toEqual({ provider: "anthropic", id: model.id });
    const bad = await call("PUT", "settings/models", { strong: { model: { provider: "anthropic", id: "nope" } } });
    expect(bad.status).toBe(400);
    expect((await call("GET", "settings")).json.models.strong.model.id).toBe(model.id);
    expect((await call("PUT", "settings/models", { medium: {} })).json.error).toMatch(/strong, cheap, vision/);
    const cleared = await call("PUT", "settings/models", {});
    expect(cleared.json).toEqual({});
    expect((await call("GET", "settings")).json.models).toBeUndefined();
  });

  it("answers 405 for another method", async () => {
    expect((await call("DELETE", "settings")).status).toBe(405);
    expect((await call("GET", "settings/models")).status).toBe(405);
  });
});

describe("routing", () => {
  it("returns false for a path that is not a model layer route", async () => {
    const r = await call("GET", "sessions");
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not mine");
    expect((await call("GET", "keys/GROQ_API_KEY/extra")).status).toBe(404);
  });
});

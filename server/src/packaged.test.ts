// The packaged-app rules: the start condition, the configuration file, the version, brain_domains, the weights order and the missions order.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BRAIN_DOMAINS } from "../../shared/brain.ts";
import { loadParams } from "./activation.ts";
import { configPath, loadConfig, readVersion, REPO_ROOT, type Config } from "./config.ts";
import { NOT_BUILT } from "./graph.ts";
import { createApp, shouldStart, type App } from "./main.ts";

const here = path.resolve(import.meta.dirname, "main.ts");
const url = pathToFileURL(here).href; // correct on Windows and on the Linux CI runner

describe("the start condition", () => {
  it("starts as the main module, in a utility process and not when imported only", () => {
    expect(shouldStart(here, url, undefined)).toBe(true);
    expect(shouldStart("C:/elsewhere/other.mjs", url, { postMessage() {} })).toBe(true);
    expect(shouldStart("C:/elsewhere/other.mjs", url, undefined)).toBe(false);
    expect(shouldStart(undefined, url, undefined)).toBe(false);
  });
});

describe("the configuration file", () => {
  it("reads no file beside the bundle when the app is packaged and CORTEX_CONFIG is empty", () => {
    expect(configPath({ CORTEX_STATIC: "C:/app/web" })).toBe("");
    expect(configPath({ CORTEX_ONTOLOGY: "C:/app/ontology" })).toBe("");
    const cfg = loadConfig({ CORTEX_STATIC: "C:/app/web" });
    expect(cfg.config_file).toBeUndefined();
    expect(cfg.product).toBe("ranviera");
  });

  it("uses CORTEX_CONFIG when it is set, and the repository file in development", () => {
    expect(configPath({ CORTEX_STATIC: "C:/app/web", CORTEX_CONFIG: "C:/x/c.json" })).toBe(path.resolve("C:/x/c.json"));
    expect(configPath({})).toBe(path.join(REPO_ROOT, "cortex.config.json"));
  });
});

describe("the version", () => {
  it("takes CORTEX_VERSION, then the build constant, then package.json", () => {
    expect(readVersion({ CORTEX_VERSION: "2.0.0" }, "1.5.0")).toBe("2.0.0");
    expect(readVersion({}, "1.5.0")).toBe("1.5.0");
    expect(readVersion({}, undefined)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("never reports 0.0.0 in a packaged build", () => {
    // the bundle sits beside no package.json in the packaged app, so the loader falls back
    expect(readVersion({ CORTEX_STATIC: "C:/app/web" }, "1.5.0")).toBe("1.5.0");
    expect(readVersion({ CORTEX_ONTOLOGY: "C:/app/ontology" }, undefined)).not.toBe("0.0.0");
  });
});

describe("brain_domains", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bd-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("defaults to the lists of docs/BRAIN.md", () => {
    const file = path.join(dir, "a.json");
    fs.writeFileSync(file, "{}");
    expect(loadConfig({ CORTEX_CONFIG: file }).brain_domains).toEqual(DEFAULT_BRAIN_DOMAINS);
  });

  it("takes a custom list, and keeps the default for a list that is missing or empty", () => {
    const file = path.join(dir, "b.json");
    fs.writeFileSync(file, JSON.stringify({ brain_domains: { writing: ["Essay", "memo"], visual: [] } }));
    const d = loadConfig({ CORTEX_CONFIG: file }).brain_domains;
    expect(d?.writing).toEqual(["essay", "memo"]);
    expect(d?.visual).toEqual(DEFAULT_BRAIN_DOMAINS.visual);
  });
});

describe("the weights order", () => {
  it("reads the defaults, then the profile, then the overlay, and the root file only without defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-w-"));
    try {
      const w = (d: string, a: object) => {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "weights.json"), JSON.stringify({ activation: a }));
      };
      const onto = path.join(root, "onto");
      const profile = path.join(root, "profile");
      const data = path.join(root, "data");
      w(onto, { decay: 0.1, max_hops: 9 });
      expect(loadParams(onto).decay).toBe(0.1);
      w(path.join(onto, "defaults"), { decay: 0.5 });
      expect(loadParams(onto)).toMatchObject({ decay: 0.5, max_hops: 2 });
      w(profile, { decay: 0.7 });
      expect(loadParams(onto, profile).decay).toBe(0.7);
      w(path.join(data, "overlay"), { decay: 0.9 });
      expect(loadParams(onto, profile, data).decay).toBe(0.9);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/missions and /api/status", () => {
  let app: App;
  let root = "";
  let base = "";
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-m-"));
    const cfg: Config = {
      claude_home: path.join(root, "claude"),
      projects_root: null,
      memory_dir: path.join(root, "memory"),
      data_dir: path.join(root, "data"),
      port: 0,
      python_cmd: "python",
      include_sensitivity: ["public"],
      log_prompt_snippets: false,
      repo_root: REPO_ROOT,
      brain_domains: { writing: ["essay"], visual: ["map"] },
    };
    fs.mkdirSync(cfg.data_dir);
    app = await createApp(cfg, false);
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
    cfg.port = (app.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${cfg.port}`;
    app.ctx.claude = () => Promise.resolve(null);
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("answers 403 without consent when there is no built graph", async () => {
    const r = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "do it" }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/switched off/);
  });

  it("answers 403 for a person who is not signed in, and the not-built message only after both", async () => {
    fs.writeFileSync(path.join(root, "data", "setup.json"), JSON.stringify({ missions_consent_at: "2026-10-06T10:00:00Z" }));
    const r = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "do it" }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/not signed in/);
    app.ctx.claude = (args) => Promise.resolve({ stdout: args[0] === "auth" ? JSON.stringify({ loggedIn: true }) : "2.0.0", code: 0 });
    const g = await fetch(`${base}/api/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "do it" }) });
    expect(g.status).toBe(503);
    expect(((await g.json()) as { error: string }).error).toBe(NOT_BUILT);
    expect(NOT_BUILT).not.toMatch(/python|cortex\.py/);
  });

  it("carries brain_domains in /api/status", async () => {
    const s = (await (await fetch(`${base}/api/status`)).json()) as { brain_domains?: unknown };
    expect(s.brain_domains).toEqual({ writing: ["essay"], visual: ["map"] });
  });
});

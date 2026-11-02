// The configuration keys of the learning upgrade (docs/CONTRACTS.md, "Configuration keys", 1 November 2026).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("the learning configuration keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-learn-cfg-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: unknown): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("places the learning folder and the keys file in the data folder by default and turns learning on", () => {
    const file = write("a.json", { data_dir: path.join(dir, "data") });
    const cfg = loadConfig({ CORTEX_CONFIG: file });
    expect(cfg.learn_dir).toBe(path.join(dir, "data", "learn").replace(/\\/g, "/"));
    expect(cfg.auth_file).toBe(path.join(dir, "data", "auth.json").replace(/\\/g, "/"));
    expect(cfg.learn_enabled).toBe(true);
    expect(cfg.claude_cmd).toBeNull();
  });

  it("reads each key from the file, and an environment variable overrides the file", () => {
    const file = write("b.json", {
      data_dir: path.join(dir, "data"),
      learn_dir: path.join(dir, "lh"),
      auth_file: path.join(dir, "keys.json"),
      learn_enabled: false,
      claude_cmd: "C:/tools/claude.exe",
    });
    const fromFile = loadConfig({ CORTEX_CONFIG: file });
    expect(fromFile.learn_dir).toBe(path.join(dir, "lh").replace(/\\/g, "/"));
    expect(fromFile.auth_file).toBe(path.join(dir, "keys.json").replace(/\\/g, "/"));
    expect(fromFile.learn_enabled).toBe(false);
    expect(fromFile.claude_cmd).toBe("C:/tools/claude.exe");
    const fromEnv = loadConfig({
      CORTEX_CONFIG: file,
      CORTEX_LEARN_DIR: path.join(dir, "env-learn"),
      CORTEX_AUTH_FILE: path.join(dir, "env-auth.json"),
      CORTEX_LEARN_ENABLED: "1",
      CORTEX_CLAUDE_CMD: "/opt/homebrew/bin/claude",
    });
    expect(fromEnv.learn_dir).toBe(path.join(dir, "env-learn").replace(/\\/g, "/"));
    expect(fromEnv.auth_file).toBe(path.join(dir, "env-auth.json").replace(/\\/g, "/"));
    expect(fromEnv.learn_enabled).toBe(true);
    expect(fromEnv.claude_cmd).toBe("/opt/homebrew/bin/claude");
  });
});

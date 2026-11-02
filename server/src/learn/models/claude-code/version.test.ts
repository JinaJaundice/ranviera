import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkClaudeVersion, claudeCodeStatus, classifyVersion, MINIMUM_VERSION } from "./version.ts";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-version.mjs");

/** Runs the version stub through node. The version module still runs its own arguments with no shell. */
const viaNode = ((_exe: string, args: string[], options: object) => spawn(process.execPath, [script, ...args], options)) as unknown as typeof spawn;
const withMode = (mode: string) => ({ spawnFn: viaNode, env: { ...process.env, FAKE_VERSION_MODE: mode } });

describe("version states", () => {
  it("names the minimum version", () => {
    expect(MINIMUM_VERSION).toBe("2.1.316");
  });

  it("classifies the output", () => {
    expect(classifyVersion("2.1.316 (Claude Code)")).toEqual({ state: "meets-minimum", version: "2.1.316" });
    expect(classifyVersion("2.2.0")).toEqual({ state: "meets-minimum", version: "2.2.0" });
    expect(classifyVersion("3.0.0-beta.1")).toEqual({ state: "meets-minimum", version: "3.0.0" });
    expect(classifyVersion("2.1.258")).toEqual({ state: "update-required", version: "2.1.258" });
    expect(classifyVersion("1.99.999")).toEqual({ state: "update-required", version: "1.99.999" });
    expect(classifyVersion("no version here")).toEqual({ state: "version-unchecked", version: null });
  });

  it("reads a current version from a real child process", async () => {
    expect(await checkClaudeVersion("claude", withMode("2.1.320 (Claude Code)"))).toEqual({ state: "meets-minimum", version: "2.1.320" });
    expect(await checkClaudeVersion("claude", withMode("2.1.100 (Claude Code)"))).toEqual({ state: "update-required", version: "2.1.100" });
  });

  it("gives version-unchecked for garbage, a failing exit, a missing binary and a stuck process", async () => {
    expect((await checkClaudeVersion("claude", withMode("garbage"))).state).toBe("version-unchecked");
    expect((await checkClaudeVersion("claude", withMode("fail"))).state).toBe("version-unchecked");
    expect((await checkClaudeVersion("C:/no/such/claude.exe")).state).toBe("version-unchecked");
    const started = Date.now();
    expect((await checkClaudeVersion("claude", { ...withMode("hang"), timeoutMs: 300 })).state).toBe("version-unchecked");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("bounds the output and kills a process that floods it", async () => {
    const r = await checkClaudeVersion("claude", { ...withMode("flood"), maxBytes: 64 });
    expect(r.state).toBe("version-unchecked");
  });

  it("does not start a process after an abort", async () => {
    const ac = new AbortController();
    ac.abort();
    let started = false;
    const spy = ((...a: Parameters<typeof spawn>) => ((started = true), spawn(...a))) as unknown as typeof spawn;
    expect((await checkClaudeVersion("claude", { spawnFn: spy, signal: ac.signal })).state).toBe("version-unchecked");
    expect(started).toBe(false);
  });
});

describe("claudeCodeStatus", () => {
  it("reports not-found with no probe when the executable is missing", async () => {
    const s = await claudeCodeStatus({ exe: null, enabled: true, allowBackground: false });
    expect(s).toEqual({ state: "not-found", version: null, minimumVersion: "2.1.316", enabled: true, allowBackground: false });
  });

  it("starts no probe while the opt in is off", async () => {
    let started = false;
    const spy = ((...a: Parameters<typeof spawn>) => ((started = true), spawn(...a))) as unknown as typeof spawn;
    const s = await claudeCodeStatus({ exe: "claude", enabled: false, allowBackground: false, spawnFn: spy });
    expect(started).toBe(false);
    expect(s.state).toBe("version-unchecked");
  });

  it("probes when enabled and found", async () => {
    const s = await claudeCodeStatus({ exe: "claude", enabled: true, allowBackground: true, ...withMode("2.1.316") });
    expect(s).toMatchObject({ state: "meets-minimum", version: "2.1.316", enabled: true, allowBackground: true });
  });
});

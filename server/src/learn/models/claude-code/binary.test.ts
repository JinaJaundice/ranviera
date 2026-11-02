import path from "node:path";
import { describe, expect, it } from "vitest";
import { findClaudeExecutable } from "./binary.ts";

/** A fake file system: the listed paths are executable regular files. */
function fake(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe("findClaudeExecutable", () => {
  it("takes the explicit path before anything else", () => {
    const exe = findClaudeExecutable({
      claudeCmd: "/custom/claude",
      platform: "linux",
      homedir: "/home/a",
      env: { PATH: "/bin" },
      isExecutable: fake(["/custom/claude", "/bin/claude"]),
    });
    expect(exe).toBe("/custom/claude");
  });

  it("falls through when the explicit path is not executable", () => {
    const exe = findClaudeExecutable({ claudeCmd: "/missing", platform: "linux", homedir: "/home/a", env: { PATH: "/bin" }, isExecutable: fake(["/bin/claude"]) });
    expect(exe).toBe("/bin/claude");
  });

  it("searches PATH in order before the known places", () => {
    const exe = findClaudeExecutable({
      platform: "linux",
      homedir: "/home/a",
      env: { PATH: "/one:/two" },
      isExecutable: fake(["/two/claude", "/home/a/.local/bin/claude"]),
    });
    expect(exe).toBe("/two/claude");
  });

  it("uses the macOS places in order: homebrew, usr/local, local bin, claude local, npm global", () => {
    const all = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/Users/a/.local/bin/claude", "/Users/a/.claude/local/claude", "/Users/a/.npm-global/bin/claude"];
    const options = { platform: "darwin" as const, homedir: "/Users/a", env: { PATH: "/usr/bin" } };
    const seen: string[] = [];
    let remaining = [...all];
    while (remaining.length) {
      const found = findClaudeExecutable({ ...options, isExecutable: fake(remaining) });
      seen.push(found as string);
      remaining = remaining.filter((p) => p !== found);
    }
    expect(seen).toEqual(all);
  });

  it("follows npm_config_prefix for the npm global folder on macOS and Linux", () => {
    expect(findClaudeExecutable({ platform: "darwin", homedir: "/Users/a", env: { npm_config_prefix: "/opt/npm" }, isExecutable: fake(["/opt/npm/bin/claude"]) })).toBe("/opt/npm/bin/claude");
    expect(findClaudeExecutable({ platform: "linux", homedir: "/home/a", env: { npm_config_prefix: "/opt/npm" }, isExecutable: fake(["/opt/npm/bin/claude"]) })).toBe("/opt/npm/bin/claude");
  });

  it("uses the local bin and then the npm global folder on Linux", () => {
    const options = { platform: "linux" as const, homedir: "/home/a", env: {} };
    expect(findClaudeExecutable({ ...options, isExecutable: fake(["/home/a/.local/bin/claude", "/home/a/.npm-global/bin/claude"]) })).toBe("/home/a/.local/bin/claude");
    expect(findClaudeExecutable({ ...options, isExecutable: fake(["/home/a/.npm-global/bin/claude"]) })).toBe("/home/a/.npm-global/bin/claude");
    expect(findClaudeExecutable({ ...options, isExecutable: fake(["/opt/homebrew/bin/claude"]) })).toBeNull();
  });

  it("accepts only claude.exe on Windows and ignores a claude.cmd shim", () => {
    const options = { platform: "win32" as const, homedir: "C:\\Users\\a", env: { Path: "C:\\bin", APPDATA: "C:\\Users\\a\\AppData\\Roaming" } };
    expect(findClaudeExecutable({ ...options, isExecutable: fake(["C:\\bin\\claude.cmd", "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"]) })).toBeNull();
    expect(findClaudeExecutable({ ...options, isExecutable: fake(["C:\\bin\\claude.cmd", "C:\\bin\\claude.exe"]) })).toBe("C:\\bin\\claude.exe");
    expect(findClaudeExecutable({ ...options, claudeCmd: "C:\\x\\claude.cmd", isExecutable: fake(["C:\\x\\claude.cmd"]) })).toBeNull();
  });

  it("finds claude.exe under the local folders and the npm global folder on Windows", () => {
    const base = { platform: "win32" as const, homedir: "C:\\Users\\a", env: { PATH: "C:\\Windows", APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } };
    expect(findClaudeExecutable({ ...base, isExecutable: fake(["C:\\Users\\a\\.local\\bin\\claude.exe", "C:\\Users\\a\\.claude\\local\\claude.exe"]) })).toBe("C:\\Users\\a\\.local\\bin\\claude.exe");
    expect(findClaudeExecutable({ ...base, isExecutable: fake(["C:\\Users\\a\\.claude\\local\\claude.exe"]) })).toBe("C:\\Users\\a\\.claude\\local\\claude.exe");
    expect(findClaudeExecutable({ ...base, isExecutable: fake(["C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"]) })).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
    expect(findClaudeExecutable({ ...base, env: { ...base.env, npm_config_prefix: "D:\\npm" }, isExecutable: fake(["D:\\npm\\claude.exe"]) })).toBe("D:\\npm\\claude.exe");
  });

  it("turns a relative PATH entry into an absolute one", () => {
    const seen: string[] = [];
    findClaudeExecutable({ platform: "win32", homedir: "C:\\Users\\a", env: { PATH: "tools;C:\\abs" }, isExecutable: (p) => (seen.push(p), false) });
    // the entry is resolved against the working folder of the test, which has no drive letter on a Linux or macOS runner
    expect(path.win32.isAbsolute(seen[0])).toBe(true);
    expect(seen[0]).toMatch(/\\tools\\claude\.exe$/);
    expect(seen[1]).toBe("C:\\abs\\claude.exe");
  });

  it("returns null when every location misses", () => {
    expect(findClaudeExecutable({ platform: "darwin", homedir: "/Users/a", env: { PATH: "/usr/bin" }, isExecutable: fake([]) })).toBeNull();
  });
});

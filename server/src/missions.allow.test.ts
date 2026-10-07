// The tool allow list of a mission step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS, DISALLOWED_TOOLS, SHELL_ALLOWED, agentTools, stepArgs } from "./missions.ts";

describe("the tool allow list", () => {
  it("limits the tools, allows only read-only shell commands and keeps the push refusals", () => {
    const a = stepArgs("scout", "id-3", "pack", ["Read", "Grep", "Bash"]);
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Bash");
    expect(a).toContain("--strict-mcp-config");
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--strict-mcp-config"));
    expect(allowed).toEqual(["Read", "Grep", ...SHELL_ALLOWED.map((c) => `Bash(${c})`)]);
    expect(allowed.some((t) => t === "Bash" || /git (push|commit)|\bgh\b/.test(t))).toBe(false);
    expect(a.slice(a.indexOf("--disallowedTools") + 1)).toEqual(DISALLOWED_TOOLS);
  });

  it("reads the tools line of the agent file and falls back to a short default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agents-"));
    fs.mkdirSync(path.join(home, "agents"));
    fs.writeFileSync(path.join(home, "agents", "scout.md"), "---\nname: scout\ntools: Read, Grep, Glob, Bash, mcp__x__y\nmodel: sonnet\n---\nBody\n");
    fs.writeFileSync(path.join(home, "agents", "plain.md"), "---\nname: plain\n---\nBody\n");
    try {
      expect(agentTools(home, "scout")).toEqual(["Read", "Grep", "Glob", "Bash"]);
      expect(agentTools(home, "plain")).toEqual(DEFAULT_TOOLS);
      expect(agentTools(home, "missing")).toEqual(DEFAULT_TOOLS);
      expect(agentTools(home, "../scout")).toEqual(DEFAULT_TOOLS);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

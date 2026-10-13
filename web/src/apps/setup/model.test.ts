import { describe, expect, it } from "vitest";
import type { ClaudeState, HookEntry, SetupState } from "@shared/types";
import { claudeSummary, describeHook, hooksJson, missionsAllowed, needsFirstRun, pollActive, startStep } from "./model";

const setup = (over: Partial<SetupState> = {}): SetupState => ({
  v: 1,
  accepted_at: null,
  read_consent_at: null,
  hooks_installed_at: null,
  missions_consent_at: null,
  version: "0.1.0",
  product: "ranviera",
  demo: false,
  claude_home: "C:/Users/a/.claude",
  claude_home_found: true,
  projects_root: null,
  memory_dirs: [],
  graph_built: null,
  counts: null,
  ...over,
});

const claude = (over: Partial<ClaudeState> = {}): ClaudeState => ({
  installed: true,
  version: "2.1.0",
  signed_in: true,
  auth_method: "claude.ai",
  plan: "Pro",
  checked: "2026-10-06T10:00:00Z",
  ...over,
});

describe("first run", () => {
  it("shows until the welcome step is agreed", () => {
    expect(needsFirstRun(null)).toBe(false);
    expect(needsFirstRun(setup())).toBe(true);
    expect(needsFirstRun(setup({ accepted_at: "2026-10-06T09:00:00Z" }))).toBe(false);
  });
  it("starts at the first step that has not been agreed", () => {
    expect(startStep(setup())).toBe(0);
    expect(startStep(setup({ accepted_at: "x" }))).toBe(1);
    expect(startStep(setup({ accepted_at: "x", read_consent_at: "y" }))).toBe(2);
  });
});

describe("hooks", () => {
  const entries: HookEntry[] = [
    { event: "PostToolUse", matcher: "Read|Edit", command: "runner hook PostToolUse", async: true },
    { event: "Stop", command: "runner hook Stop" },
  ];
  it("writes the entries in the shape of settings.json", () => {
    const json = JSON.parse(hooksJson(entries)) as { hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; async?: boolean }[] }[]> };
    expect(json.hooks.PostToolUse[0].matcher).toBe("Read|Edit");
    expect(json.hooks.PostToolUse[0].hooks[0]).toEqual({ type: "command", command: "runner hook PostToolUse", async: true });
    expect(json.hooks.Stop[0].matcher).toBeUndefined();
  });
  it("describes an entry in one sentence", () => {
    expect(describeHook(entries[0])).toBe("Records a step after Claude Code uses a tool for Read|Edit.");
    expect(describeHook({ event: "Other", command: "x" })).toBe("Records a step on the Other event.");
  });
});

describe("Claude Code state", () => {
  it("reports each state in words", () => {
    expect(claudeSummary(null).tone).toBe("hold");
    expect(claudeSummary(claude({ installed: false })).label).toBe("Claude Code not installed");
    expect(claudeSummary(claude({ signed_in: false })).label).toBe("Claude Code sign-in needed");
    expect(claudeSummary(claude()).detail).toBe("Claude Code 2.1.0 is signed in (claude.ai, Pro).");
  });
  it("allows agent runs only when signed in and agreed", () => {
    expect(missionsAllowed(setup(), claude()).allowed).toBe(false);
    expect(missionsAllowed(setup({ missions_consent_at: "x" }), claude({ signed_in: false })).allowed).toBe(false);
    expect(missionsAllowed(setup({ missions_consent_at: "x" }), claude()).allowed).toBe(true);
  });
  it("stops checking the sign-in after 5 minutes", () => {
    expect(pollActive(null, 1000)).toBe(false);
    expect(pollActive(0, 299_999)).toBe(true);
    expect(pollActive(0, 300_000)).toBe(false);
  });
});

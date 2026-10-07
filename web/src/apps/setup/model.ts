// Pure helpers for the first run, Settings and the top bar, kept apart from React so that they can be tested.
import type { ClaudeState, HookEntry, SetupState } from "@shared/types";

export type StepId = "welcome" | "read" | "hooks" | "claude" | "done";

export const STEPS: { id: StepId; title: string; optional: boolean }[] = [
  { id: "welcome", title: "Welcome", optional: false },
  { id: "read", title: "Read your set-up", optional: false },
  { id: "hooks", title: "See Claude Code at work", optional: true },
  { id: "claude", title: "Connect Claude Code", optional: true },
  { id: "done", title: "Done", optional: false },
];

/** The first run is shown until the person has agreed to the welcome step. */
export function needsFirstRun(setup: SetupState | null): boolean {
  return setup !== null && setup.accepted_at === null;
}

/** The step a first run starts at, given what the person has already agreed to. */
export function startStep(setup: SetupState | null): number {
  if (!setup || setup.accepted_at === null) return 0;
  return setup.read_consent_at === null ? 1 : 2;
}

/** The exact text of the entries that the installer adds, in the shape of settings.json. */
export function hooksJson(entries: HookEntry[]): string {
  const hooks: Record<string, unknown[]> = {};
  for (const e of entries) {
    const command: Record<string, unknown> = { type: "command", command: e.command };
    if (e.async) command.async = true;
    const group: Record<string, unknown> = { hooks: [command] };
    if (e.matcher) group.matcher = e.matcher;
    (hooks[e.event] ??= []).push(group);
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** One plain sentence about one hook entry. */
export function describeHook(e: HookEntry): string {
  const when: Record<string, string> = {
    SessionStart: "when a Claude Code session starts",
    SessionEnd: "when a session ends",
    UserPromptSubmit: "when you send a prompt",
    PreToolUse: "before Claude Code uses a tool",
    PostToolUse: "after Claude Code uses a tool",
    Stop: "when Claude Code finishes a reply",
    SubagentStart: "when a sub-agent starts",
    SubagentStop: "when a sub-agent finishes",
    InstructionsLoaded: "when Claude Code loads an instruction file",
    Notification: "when Claude Code sends a notification",
    PreCompact: "before Claude Code compacts the conversation",
  };
  const phrase = when[e.event] ?? `on the ${e.event} event`;
  const scope = e.matcher && e.matcher !== "*" ? ` for ${e.matcher}` : "";
  return `Records a step ${phrase}${scope}.`;
}

export type ClaudeTone = "pass" | "hold" | "block";

export function claudeSummary(c: ClaudeState | null): { tone: ClaudeTone; label: string; detail: string } {
  if (!c) return { tone: "hold", label: "Claude Code not checked", detail: "The state of Claude Code has not been read yet." };
  if (!c.installed) return { tone: "block", label: "Claude Code not installed", detail: "Claude Code was not found on this computer." };
  const version = c.version ? ` ${c.version}` : "";
  if (!c.signed_in) return { tone: "hold", label: "Claude Code sign-in needed", detail: `Claude Code${version} is installed and not signed in.` };
  const how = [c.auth_method, c.plan].filter(Boolean).join(", ");
  return { tone: "pass", label: "Claude Code signed in", detail: `Claude Code${version} is signed in${how ? ` (${how})` : ""}.` };
}

/** Agent runs are allowed when Claude Code is signed in and the person has agreed to the statement. */
export function missionsAllowed(setup: SetupState | null, claude: ClaudeState | null): { allowed: boolean; reason: string } {
  if (!claude?.signed_in) return { allowed: false, reason: "Claude Code is not signed in." };
  if (!setup?.missions_consent_at) return { allowed: false, reason: "You have not yet agreed that runs use your own plan." };
  return { allowed: true, reason: "" };
}

export const POLL_MS = 3000;
export const POLL_LIMIT_MS = 5 * 60 * 1000;

/** Whether the sign-in check should still run, given when it started. */
export function pollActive(startedAt: number | null, now: number): boolean {
  return startedAt !== null && now - startedAt < POLL_LIMIT_MS;
}

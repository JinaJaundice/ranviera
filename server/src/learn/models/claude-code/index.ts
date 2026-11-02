// Claude Code provider: the public surface. Claude wires these into server/src/learn/http.ts, server/src/api.ts and
// server/src/main.ts at merge. The mission runner reads findClaudeExecutable.
export { findClaudeExecutable, knownDirectories, type FindClaudeOptions } from "./binary.ts";
export { claudeChildEnv, cleanChildEnv, MCP_TIMEOUT_MS } from "./env.ts";
export { checkClaudeVersion, claudeCodeStatus, classifyVersion, MINIMUM_VERSION, parseVersion } from "./version.ts";
export { BRIDGE_PREFIX, ToolBridge } from "./bridge.ts";
export { HOLD_IDLE_MS, LiveProcesses } from "./live.ts";
export { createClaudeStreams, toClaudeArgs, type ClaudeStreamDeps } from "./stream.ts";
export { CLAUDE_CODE_ALIASES, CLAUDE_CODE_PROVIDER_ID, claudeCodeModels, createClaudeCodeProvider, type ClaudeCodeProvider } from "./provider.ts";

// Claude Code provider: the environment of the child process. The child receives the launch environment minus every
// name that the Cortex key store injected, so that a saved key never reaches the command line tool. The names come in
// as a parameter, because this module reads no global configuration.

/** 30 minutes in milliseconds. The application times out first, because a held process is killed after 10 minutes. */
export const MCP_TIMEOUT_MS = 30 * 60 * 1000;

export interface ChildEnvOptions {
  /** the names that only the key store injected (the launch environment did not hold them) */
  injectedNames?: Iterable<string>;
  platform?: NodeJS.Platform;
}

/** A Cortex variable that carries a secret, such as the per-launch server token. The child never receives it. */
const CORTEX_SECRET = /^CORTEX_.*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** The launch environment without the injected names and without the Cortex secrets. Windows compares names without regard to case. */
export function cleanChildEnv(launchEnv: NodeJS.ProcessEnv, options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const win = (options.platform ?? process.platform) === "win32";
  const fold = (name: string): string => (win ? name.toUpperCase() : name);
  const blocked = new Set<string>();
  for (const name of options.injectedNames ?? []) blocked.add(fold(name));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(launchEnv)) {
    if (value === undefined) continue;
    if (blocked.has(fold(name)) || CORTEX_SECRET.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** The cleaned environment with the two MCP timeouts, which override any shorter value that was inherited. */
export function claudeChildEnv(launchEnv: NodeJS.ProcessEnv, options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const env = cleanChildEnv(launchEnv, options);
  env.MCP_TOOL_TIMEOUT = String(MCP_TIMEOUT_MS);
  env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(MCP_TIMEOUT_MS);
  return env;
}

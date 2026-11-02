// Claude Code provider: the pi-ai provider with id claude-code and the models opus, sonnet and haiku. The models take
// image input, have no price and have low as the lowest thinking level, because the CLI cannot turn thinking off. The
// window and output limits below are placeholders that the library requires and that nothing shows. The catalogue
// reports the window as unknown until the context probe replies.
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { createClaudeStreams, type ClaudeStreamDeps, type ClaudeStreams, type ContextWindowInfo } from "./stream.ts";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_API = "claude-code-cli";
export const CLAUDE_CODE_ALIASES = ["opus", "sonnet", "haiku"] as const;

const PLACEHOLDER_WINDOW = 1_000_000;
const PLACEHOLDER_OUTPUT = 128_000;

export function claudeCodeModels(): Model<typeof CLAUDE_CODE_API>[] {
  return CLAUDE_CODE_ALIASES.map((alias) => ({
    id: alias,
    name: `Claude ${alias[0].toUpperCase()}${alias.slice(1)} (Claude Code)`,
    api: CLAUDE_CODE_API,
    provider: CLAUDE_CODE_PROVIDER_ID,
    baseUrl: "",
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: PLACEHOLDER_WINDOW,
    maxTokens: PLACEHOLDER_OUTPUT,
  }));
}

export interface ClaudeCodeProvider {
  provider: Provider<typeof CLAUDE_CODE_API>;
  streams: ClaudeStreams;
  /** the window that the context probe reported for a session and model, or undefined while unknown */
  contextWindow(sessionId: string | undefined, model: string): number | undefined;
  dispose(): void;
}

/** Builds the provider. Every dependency is explicit, and nothing here reads global configuration. */
export function createClaudeCodeProvider(deps: ClaudeStreamDeps): ClaudeCodeProvider {
  const windows = new Map<string, number>();
  const keyOf = (sessionId: string | undefined, model: string): string => `${sessionId ?? ""}\u0000${model}`;
  const onContextWindow = (info: ContextWindowInfo): void => {
    windows.set(keyOf(info.sessionId, info.model), info.maxTokens);
    deps.onContextWindow?.(info);
  };
  const streams = createClaudeStreams({ ...deps, onContextWindow });
  const provider = createProvider<typeof CLAUDE_CODE_API>({
    id: CLAUDE_CODE_PROVIDER_ID,
    name: "Claude Code",
    // The CLI signs in for itself. No key is stored, and the provider never promises a billing route.
    auth: { apiKey: { name: "Claude Code", resolve: async () => ({ auth: {} }) } },
    models: claudeCodeModels(),
    api: streams,
  });
  return {
    provider,
    streams,
    contextWindow: (sessionId, model) => windows.get(keyOf(sessionId, model)),
    dispose: () => streams.dispose(),
  };
}

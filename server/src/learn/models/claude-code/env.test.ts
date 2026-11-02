// public-check: synthetic-secrets (the saved keys in these tests are made up and must never reach the CLI)
import { describe, expect, it } from "vitest";
import { claudeChildEnv, cleanChildEnv, MCP_TIMEOUT_MS } from "./env.ts";

describe("child environment", () => {
  const launch = { HOME: "/home/a", PATH: "/bin", OPENROUTER_API_KEY: "sk-saved-by-cortex", ANTHROPIC_API_KEY: "real-env-key", TAVILY_API_KEY: "tvly-saved-key-123456789" };

  it("removes every name that the key store injected and keeps the rest", () => {
    const env = cleanChildEnv(launch, { injectedNames: ["OPENROUTER_API_KEY", "TAVILY_API_KEY"], platform: "linux" });
    expect(env).toEqual({ HOME: "/home/a", PATH: "/bin", ANTHROPIC_API_KEY: "real-env-key" });
  });

  it("keeps the existing authentication of the CLI that came from the launch environment", () => {
    expect(cleanChildEnv(launch, { injectedNames: [], platform: "linux" }).ANTHROPIC_API_KEY).toBe("real-env-key");
  });

  it("compares names without regard to case on Windows only", () => {
    expect(cleanChildEnv({ Openrouter_Api_Key: "x", A: "1" }, { injectedNames: ["OPENROUTER_API_KEY"], platform: "win32" })).toEqual({ A: "1" });
    expect(cleanChildEnv({ Openrouter_Api_Key: "x" }, { injectedNames: ["OPENROUTER_API_KEY"], platform: "linux" })).toEqual({ Openrouter_Api_Key: "x" });
  });

  it("does not change the launch environment", () => {
    const copy = { ...launch };
    cleanChildEnv(launch, { injectedNames: ["OPENROUTER_API_KEY"] });
    expect(launch).toEqual(copy);
  });

  it("sets both MCP timeouts to 30 minutes over a shorter inherited value", () => {
    const env = claudeChildEnv({ ...launch, MCP_TOOL_TIMEOUT: "1000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "5" }, { platform: "linux" });
    expect(MCP_TIMEOUT_MS).toBe(1_800_000);
    expect(env.MCP_TOOL_TIMEOUT).toBe("1800000");
    expect(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("1800000");
  });
});

describe("child environment secrets", () => {
  it("removes CORTEX_TOKEN and any other CORTEX_ variable that carries a secret", () => {
    const launch = { PATH: "/bin", CORTEX_TOKEN: "tok", CORTEX_API_SECRET: "s", CORTEX_ADMIN_PASSWORD: "p", CORTEX_KEY: "k", CORTEX_PORT: "5173", cortex_token: "low" };
    for (const platform of ["linux", "win32"] as const) {
      const env = claudeChildEnv(launch, { platform });
      expect(env.CORTEX_TOKEN).toBeUndefined();
      expect(env.CORTEX_API_SECRET).toBeUndefined();
      expect(env.CORTEX_ADMIN_PASSWORD).toBeUndefined();
      expect(env.CORTEX_KEY).toBeUndefined();
      expect(env.PATH).toBe("/bin");
      expect(env.CORTEX_PORT).toBe("5173");
    }
    expect(claudeChildEnv(launch, { platform: "win32" }).cortex_token).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { enforceGate, gateDecision, maxSensitivity, providerClass, rootAllowedFor, sensitivityRefusal } from "./gate.ts";

const custom = (baseUrl: string, localConfirmedAt?: string) => ({ baseUrl, authMode: "keyless" as const, localConfirmedAt: localConfirmedAt ?? null });

describe("provider class", () => {
  it("names the Claude Code provider claude-code and every key based provider hosted", () => {
    expect(providerClass({ provider: "claude-code", id: "sonnet" })).toBe("claude-code");
    expect(providerClass({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBe("hosted");
    expect(providerClass({ provider: "openrouter", id: "x" })).toBe("hosted");
  });

  it("names a custom endpoint local on a loopback host, and hosted elsewhere unless the person confirmed it", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1", "http://ollama.localhost/v1"]) {
      expect(providerClass({ provider: "custom", id: "m" }, custom(url))).toBe("local");
    }
    expect(providerClass({ provider: "custom", id: "m" }, custom("https://llm.example.com/v1"))).toBe("hosted");
    expect(providerClass({ provider: "custom", id: "m" }, custom("http://192.168.1.20:8000/v1", "2026-11-01T09:00:00.000Z"))).toBe("local");
    expect(providerClass({ provider: "custom", id: "m" })).toBe("hosted");
    // a look alike host is not loopback
    expect(providerClass({ provider: "custom", id: "m" }, custom("http://localhost.evil.example/v1"))).toBe("hosted");
  });
});

describe("gate decision", () => {
  const roots = [
    { id: "root_a", sensitivity: "public" as const },
    { id: "root_b", sensitivity: "internal" as const },
    { id: "root_c", sensitivity: "client-confidential" as const },
    { id: "root_d", sensitivity: "client-confidential" as const, hostedConsentAt: "2026-11-01T08:00:00.000Z" },
  ];

  it("allows public and internal text to every class", () => {
    for (const cls of ["claude-code", "local", "hosted"] as const) expect(gateDecision(cls, roots.slice(0, 2))).toEqual({ allowed: true });
  });

  it("allows client-confidential text to claude-code and local models", () => {
    expect(gateDecision("claude-code", roots)).toEqual({ allowed: true });
    expect(gateDecision("local", roots)).toEqual({ allowed: true });
  });

  it("refuses client-confidential text to a hosted model unless the root records consent, and names the roots", () => {
    expect(gateDecision("hosted", [roots[3]])).toEqual({ allowed: true });
    const refused = gateDecision("hosted", roots);
    expect(refused).toEqual({ allowed: false, sensitivity: "client-confidential", providerClass: "hosted", roots: ["root_c"] });
    expect(rootAllowedFor(roots[2], "hosted")).toBe(false);
    expect(rootAllowedFor(roots[2], "local")).toBe(true);
  });

  it("builds the 403 envelope with the extra fields", () => {
    const refused = gateDecision("hosted", roots);
    if (refused.allowed) throw new Error("expected a refusal");
    const err = sensitivityRefusal(refused);
    expect(err.status).toBe(403);
    expect(err.body()).toMatchObject({ code: "sensitivity_refused", sensitivity: "client-confidential", providerClass: "hosted", roots: ["root_c"] });
    expect(() => enforceGate({ provider: "openai", id: "x" }, roots)).toThrow(/client-confidential/);
    expect(() => enforceGate({ provider: "claude-code", id: "sonnet" }, roots)).not.toThrow();
  });

  it("takes the highest sensitivity of a list", () => {
    expect(maxSensitivity([])).toBe("public");
    expect(maxSensitivity(["public", "internal"])).toBe("internal");
    expect(maxSensitivity(["internal", "client-confidential", "public"])).toBe("client-confidential");
  });
});

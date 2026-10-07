import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISALLOWED_TOOLS, contextPack, parseStreamLine, stepArgs } from "./missions.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "stream-not-signed-in.jsonl");

describe("stream parser", () => {
  it("ends the recorded not-signed-in stream with an error result", () => {
    const parsed = fs.readFileSync(fixture, "utf8").split("\n").filter(Boolean).map((l) => parseStreamLine(l));
    const results = parsed.filter((p) => p.result);
    expect(results).toHaveLength(1);
    expect(results[0].result?.is_error).toBe(true);
    expect(results[0].result?.cost_usd).toBe(0);
    expect(results[0].lines[0].kind).toBe("error");
    expect(results[0].lines[0].text).toContain("Not logged in");
    expect(parsed.some((p) => p.lines.some((l) => l.kind === "system"))).toBe(true);
  });

  it("records the file of a Write tool call", () => {
    const stream = [
      { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
      { type: "assistant", message: { content: [{ type: "text", text: "Writing the file." }, { type: "tool_use", name: "Write", input: { file_path: "C:\\p\\out.md", content: "x" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "C:/p/in.md" } }, { type: "tool_use", name: "PowerShell", input: { command: "python tool.py" } }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done", total_cost_usd: 0.0123 },
    ].map((o) => parseStreamLine(JSON.stringify(o)));
    expect(stream[0].lines[0]).toMatchObject({ kind: "system" });
    expect(stream[0].lines[0].text).toContain("claude-sonnet-5-5");
    expect(stream[1].files).toEqual(["C:/p/out.md"]);
    expect(stream[1].lines.map((l) => l.kind)).toEqual(["text", "tool"]);
    expect(stream[1].lines[1]).toMatchObject({ tool: "Write", path: "C:/p/out.md", text: "Wrote C:/p/out.md" });
    expect(stream[1].text).toBe("Writing the file.");
    expect(stream[2].files).toEqual([]);
    expect(stream[2].lines[0].text).toBe("Read C:/p/in.md");
    expect(stream[2].lines[1].text).toBe("Ran python tool.py");
    expect(stream[3].result).toEqual({ cost_usd: 0.0123, is_error: false });
  });

  it("ignores lines that are not JSON", () => {
    expect(parseStreamLine("not json").lines).toEqual([]);
  });
});

describe("step arguments", () => {
  it("omits --agent for main and refuses pushing and sending", () => {
    const a = stepArgs("main", "id-1", "pack");
    expect(a).not.toContain("--agent");
    expect(a.slice(a.indexOf("--disallowedTools") + 1)).toEqual(DISALLOWED_TOOLS);
    expect(stepArgs("writer", "id-2", "pack")).toContain("--agent");
  });

  it("writes the context pack as plain text", () => {
    const pack = contextPack({
      prompt_hash: "h", task_types: [], entities: [], fire: [],
      load: [{ path: "C:/r/decks.md", node: "rulefile:decks", reason: "Read first for Deck or slide" }],
      steps: [], gates: [{ node: "gate:x", command: "npm test" }], cautions: ["Be careful."],
    });
    expect(pack.startsWith("Cortex prepared this context from the knowledge graph.")).toBe(true);
    expect(pack).toContain("C:/r/decks.md (Read first for Deck or slide)");
    expect(pack).toContain("npm test");
  });
});

describe("cleanEnv and the API key", () => {
  it("removes the API key by default and keeps it when the configuration allows it", async () => {
    const { cleanEnv } = await import("./missions.ts");
    const base = { PATH: "x", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_SESSION_ID: "s" } as NodeJS.ProcessEnv;
    expect(cleanEnv(base, false)).toEqual({ PATH: "x" });
    expect(cleanEnv(base, true)).toEqual({ PATH: "x", ANTHROPIC_API_KEY: "k" });
  });
});

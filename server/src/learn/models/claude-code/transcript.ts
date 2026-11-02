// Claude Code provider: the request as the CLI needs it. The application transcript is the authority and a Claude
// Code session is disposable, so a fresh process receives the history as labelled text blocks (never --resume).
// This module also derives the system prompt and the tool list from the system messages of the transcript, and the
// fingerprints that decide whether a held process may continue.
import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { BridgeTool } from "./bridge.ts";

export type CliBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** All system content in order, then the live sections that carry text. */
export function systemPromptOf(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    parts.push(typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("\n"));
  }
  for (const m of messages) {
    if (m.role !== "system" || !m.sections) continue;
    for (const v of Object.values(m.sections)) if (typeof v === "string" && v !== "") parts.push(v);
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/** The tools added minus the tools removed, in the order that the system messages declare them. */
export function toolsOf(messages: Message[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const m of messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
    for (const r of m.toolsRemoved ?? []) tools.delete(r.name);
  }
  return [...tools.values()];
}

export function bridgeToolsOf(tools: Tool[]): BridgeTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as unknown as Record<string, unknown> }));
}

function imageBlock(c: ImageContent): CliBlock {
  return { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } };
}

function textOf(parts: (TextContent | ImageContent)[]): string {
  return parts.filter((p): p is TextContent => p.type === "text").map((p) => p.text).join("\n");
}

/** The non system messages. */
export function historyOf(messages: Message[]): Exclude<Message, { role: "system" }>[] {
  return messages.filter((m): m is Exclude<Message, { role: "system" }> => m.role !== "system");
}

/** The content blocks of the one user line. A single user turn goes through as it is, and anything longer is replayed. */
export function cliBlocks(messages: Message[]): CliBlock[] {
  const history = historyOf(messages);
  const blocks: CliBlock[] = [];
  const text: string[] = [];
  const flush = (): void => {
    if (text.length) blocks.push({ type: "text", text: text.join("\n\n") });
    text.length = 0;
  };
  const only = history.length === 1 && history[0].role === "user" ? history[0] : null;
  if (only) {
    if (typeof only.content === "string") return [{ type: "text", text: only.content }];
    for (const c of only.content) {
      if (c.type === "text") text.push(c.text);
      else {
        flush();
        blocks.push(imageBlock(c));
      }
    }
    flush();
    return blocks;
  }
  for (const m of history) {
    if (m.role === "user") {
      if (typeof m.content === "string") text.push(`[user]
${m.content}`);
      else {
        let labelled = false;
        for (const c of m.content) {
          if (c.type === "text") {
            text.push(labelled ? c.text : `[user]
${c.text}`);
            labelled = true;
          } else {
            if (!labelled) text.push("[user]");
            labelled = true;
            flush();
            blocks.push(imageBlock(c));
          }
        }
      }
    } else if (m.role === "assistant") {
      const bits: string[] = [];
      for (const c of m.content) {
        if (c.type === "text" && c.text) bits.push(`[assistant]\n${c.text}`);
        else if (c.type === "toolCall") bits.push(`[tool call ${c.name}] ${JSON.stringify(c.arguments)}`);
      }
      text.push(...bits);
    } else {
      const t = textOf(m.content);
      text.push(`[tool result ${m.toolName}${m.isError ? " error" : ""}]${t ? `
${t}` : ""}`);
      for (const c of m.content) {
        if (c.type === "image") {
          flush();
          blocks.push(imageBlock(c));
        }
      }
    }
  }
  flush();
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

/** The stream JSON input line, a user message with a content array. */
export function userLine(blocks: CliBlock[]): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: blocks } })}\n`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function plainOf(m: Exclude<Message, { role: "system" }>): unknown {
  if (m.role === "user") {
    const c = m.content;
    return { r: "u", c: typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : `img:${hash(p.data)}`)) };
  }
  if (m.role === "assistant") {
    return {
      r: "a",
      c: m.content
        .filter((p): p is TextContent | ToolCall => p.type !== "thinking")
        .map((p) => (p.type === "text" ? p.text : { id: p.id, n: p.name })),
    };
  }
  return { r: "t", id: m.toolCallId, e: m.isError, c: m.content.map((p) => (p.type === "text" ? p.text : `img:${hash(p.data)}`)) };
}

/** A fingerprint of the history that ignores timestamps, usage and thinking. */
export function historyHash(history: Exclude<Message, { role: "system" }>[]): string {
  return hash(history.map(plainOf));
}

export interface TrailingResults {
  /** the history before the results */
  before: Exclude<Message, { role: "system" }>[];
  results: Extract<Message, { role: "toolResult" }>[];
}

/** Splits the history at its trailing run of tool results. */
export function splitTrailingResults(history: Exclude<Message, { role: "system" }>[]): TrailingResults {
  let i = history.length;
  while (i > 0 && history[i - 1].role === "toolResult") i--;
  return { before: history.slice(0, i), results: history.slice(i) as Extract<Message, { role: "toolResult" }>[] };
}

/** Maps the effort of the CLI from the thinking level. Minimal and off map to low, and an unset level to medium. */
export function effortOf(level: string | undefined): string {
  if (level === undefined) return "medium";
  if (level === "off" || level === "minimal") return "low";
  return level;
}

export function configHash(parts: { model: string; effort: string; systemPrompt: string; tools: BridgeTool[]; env: NodeJS.ProcessEnv }): string {
  const env = Object.entries(parts.env).sort(([a], [b]) => (a < b ? -1 : 1));
  return hash({ m: parts.model, e: parts.effort, s: parts.systemPrompt, t: parts.tools, v: env });
}

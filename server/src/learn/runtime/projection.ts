// The projection of a stored record into the messages that the model sees.
// This is the only place where model facing decisions live, and it never
// throws. The record is never changed: a failed response, an orphan result or a
// call with no result is repaired here and stays as it was on disk.
import type { Message } from "@earendil-works/pi-ai";
import type { CompactionDetails, CustomMessage, NativeMessage } from "../../../../shared/learn/index.ts";

export const INTERRUPTED_RESULT = "This tool call was interrupted before it returned a result.";

/** The newest compaction marker whose kept message resolves above the start of the record, with that index. */
export function activeCompaction(messages: NativeMessage[]): { marker: CustomMessage; keptIndex: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "custom" || m.customType !== "compaction") continue;
    const d = m.details as Partial<CompactionDetails> | undefined;
    if (!d || typeof d.firstKeptMessageId !== "string") return null;
    const keptIndex = messages.findIndex((x) => x.id === d.firstKeptMessageId);
    // only the newest marker rules, and an unresolved cut keeps the full history
    return keptIndex > 0 ? { marker: m, keptIndex } : null;
  }
  return null;
}

/** A copy of a stored message with the record identifier removed, because the model never sees identifiers. */
function withoutId(m: NativeMessage): Message {
  const copy: Record<string, unknown> = { ...m };
  delete copy.id;
  return copy as unknown as Message;
}

function flatten(messages: NativeMessage[], from: number): Message[] {
  const out: Message[] = [];
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: m.content as never, timestamp: m.timestamp ?? 0 });
        break;
      case "assistant": {
        if (m.stopReason === "error" || m.stopReason === "aborted") break;
        out.push(withoutId(m));
        break;
      }
      case "toolResult": {
        out.push({ ...withoutId(m), timestamp: m.timestamp ?? 0 } as Message);
        break;
      }
      case "custom":
        if (m.customType === "plan-block" || m.customType === "problem-dismissed" || m.customType === "compaction") break;
        out.push({ role: "user", content: m.content, timestamp: m.timestamp ?? 0 });
        break;
    }
  }
  return out;
}

/** Drops results with no call before them and adds an interrupted result for each call with no result. */
function repair(list: Message[]): Message[] {
  const seenCalls = new Set<string>();
  const kept: Message[] = [];
  for (const m of list) {
    if (m.role === "toolResult" && !seenCalls.has(m.toolCallId)) continue;
    if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") seenCalls.add(b.id);
    kept.push(m);
  }
  const answered = new Set<string>();
  for (const m of kept) if (m.role === "toolResult") answered.add(m.toolCallId);
  const out: Message[] = [];
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i];
    out.push(m);
    if (m.role !== "assistant") continue;
    // the results that already follow stay adjacent to their call
    let j = i + 1;
    while (j < kept.length && kept[j].role === "toolResult") out.push(kept[j++]);
    i = j - 1;
    for (const b of m.content) {
      if (b.type === "toolCall" && !answered.has(b.id)) {
        out.push({
          role: "toolResult",
          toolCallId: b.id,
          toolName: b.name,
          content: [{ type: "text", text: INTERRUPTED_RESULT }],
          isError: true,
          timestamp: m.timestamp,
        });
      }
    }
  }
  return out;
}

export function toLlmMessages(messages: NativeMessage[]): Message[] {
  try {
    const active = activeCompaction(messages);
    const head: Message[] = active
      ? [{ role: "user", content: active.marker.content, timestamp: active.marker.timestamp ?? 0 }]
      : [];
    return repair([...head, ...flatten(messages, active ? active.keptIndex : 0)]);
  } catch {
    return [];
  }
}

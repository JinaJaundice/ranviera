// Some providers reuse tool call identifiers from one response to the next,
// which corrupts the join of a call and its result. The uniquifier re-mints a
// colliding identifier once, as <original>~<n>, at the wire boundary. The
// stream, the record and the next request then agree, and history is not
// rewritten. It is seeded with every call and result identifier of the record.
import type { NativeMessage } from "../../../../shared/learn/index.ts";

export interface CallIdUniquifier {
  /** Starts the next assistant message. */
  beginAssistant(): void;
  /** The identifier to use on the wire and in the record for a provider identifier of the current assistant message. */
  map(id: string): string;
  /** Rewrites the call identifiers of an assistant message and the identifier of a result, for the current message. */
  remap<T extends { role: string }>(message: T): T;
}

export function seedIds(messages: NativeMessage[]): Set<string> {
  const used = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") used.add(m.toolCallId);
    else if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") used.add(b.id);
  }
  return used;
}

export function createCallIdUniquifier(used: Set<string>): CallIdUniquifier {
  let current = new Map<string, string>();
  const claim = (original: string): string => {
    if (!used.has(original)) {
      used.add(original);
      return original;
    }
    for (let n = 2; ; n++) {
      const candidate = `${original}~${n}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
  const map = (id: string): string => {
    const known = current.get(id);
    if (known !== undefined) return known;
    const minted = claim(id);
    current.set(id, minted);
    return minted;
  };
  return {
    beginAssistant() {
      current = new Map();
    },
    map,
    remap(message) {
      const m = message as unknown as { role: string; content?: unknown; toolCallId?: string };
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const content = m.content.map((b) => {
          const block = b as { type?: string; id?: string };
          return block && block.type === "toolCall" && typeof block.id === "string" ? { ...block, id: map(block.id) } : b;
        });
        return { ...message, content } as unknown as typeof message;
      }
      if (m.role === "toolResult" && typeof m.toolCallId === "string") return { ...message, toolCallId: map(m.toolCallId) } as unknown as typeof message;
      return message;
    },
  };
}


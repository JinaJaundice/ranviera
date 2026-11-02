// Mechanical repair of tool arguments from weak models. A value that arrives as one JSON encoded string where the
// schema wants an array is parsed. Anything else is left for validation to reject with a message that names the
// valid values (docs/CONTRACTS.md, "Tool vocabulary").

/** Parses a string that holds a JSON array. Returns the original value when it is not one. */
export function healArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** Heals the named properties of an argument object. Other properties and non objects pass through. */
export function healProperties(args: unknown, arrays: readonly string[]): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of arrays) if (key in out) out[key] = healArray(out[key]);
  return out;
}

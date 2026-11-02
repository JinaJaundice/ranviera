// Healing of tool arguments before validation. A weak model often sends a JSON
// encoded string where the schema wants an enum member, a boolean, a number,
// null or an array. Each top level string is parsed, and the parsed value
// replaces it only when the schema accepts that value and does not accept the
// raw string. Anything else is left for validation to reject with its message.
import type { AnyTool } from "./define.ts";

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);

/** A shallow check of a value against a JSON schema node. Unknown shapes are not accepted. */
function accepts(schema: unknown, value: unknown): boolean {
  if (!isObject(schema)) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((s) => accepts(s, value));
  if (Array.isArray(schema.oneOf)) return schema.oneOf.some((s) => accepts(s, value));
  if ("const" in schema) return schema.const === value;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  const type = schema.type;
  const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : [];
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "null":
        return value === null;
      case "array":
        return Array.isArray(value);
      case "object":
        return isObject(value);
      default:
        return false;
    }
  });
}

/** Returns the same reference when nothing needed healing, so that the heal is idempotent. */
export function healArguments(args: unknown, schema: unknown): unknown {
  if (!isObject(args) || !isObject(schema) || !isObject(schema.properties)) return args;
  const properties = schema.properties as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !(key in properties)) continue;
    const node = properties[key];
    if (accepts(node, value)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (parsed === value || !accepts(node, parsed)) continue;
    out ??= { ...args };
    out[key] = parsed;
  }
  return out ?? args;
}

/** Adds the heal to a tool, ahead of any argument preparation the tool already has. */
export function healTool<T extends AnyTool>(tool: T): T {
  const own = tool.prepareArguments;
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const healed = healArguments(args, tool.parameters);
      return (own ? own(healed) : healed) as never;
    },
  };
}

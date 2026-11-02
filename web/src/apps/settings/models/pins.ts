// The pins of the custom endpoint as the form holds them (text) and as the server takes them (numbers).
import type { CustomProviderState } from "@shared/learn/models";

export type Overrides = NonNullable<CustomProviderState["overrides"]>;
export type Pin = { context: string; maxTokens: string; reasoning: "" | "yes" | "no" };

export const pinFrom = (o: Overrides[string] | undefined): Pin => ({
  context: o?.context ? String(o.context) : "",
  maxTokens: o?.maxTokens ? String(o.maxTokens) : "",
  reasoning: o?.reasoning === true ? "yes" : o?.reasoning === false ? "no" : "",
});

/** Turns the pin fields into the overrides that the server accepts, or returns the sentence that names the first bad field. */
export function overridesFromPins(pins: Record<string, Pin>): { overrides: Overrides } | { error: string } {
  const overrides: Overrides = {};
  for (const [id, pin] of Object.entries(pins)) {
    const entry: Overrides[string] = {};
    for (const [field, text, label] of [["context", pin.context, "context size"], ["maxTokens", pin.maxTokens, "output size"]] as const) {
      const t = text.trim();
      if (!t) continue;
      if (!/^[1-9][0-9]*$/.test(t)) return { error: `The ${label} of ${id} must be a whole number of 1 or more.` };
      entry[field] = Number(t);
    }
    if (pin.reasoning) entry.reasoning = pin.reasoning === "yes";
    if (Object.keys(entry).length > 0) overrides[id] = entry;
  }
  return { overrides };
}

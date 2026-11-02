// Typed calls to routes 1 to 12 of docs/CONTRACTS.md ("Routes") and the pure helpers that
// the Models and keys section uses. The model layer is served by server/src/learn/models/.
import type {
  AuthKeyStatus,
  ClaudeCodeStatus,
  CustomProviderConnect,
  CustomProviderState,
  LearnSettings,
  ModelCatalogEntry,
  ModelCatalogResponse,
  ModelRef,
  ModelSlot,
  ModelSlotName,
} from "@shared/learn/models";
import type { ThinkingLevel } from "@shared/learn/sessions";

/** A failed call, with the envelope of the server: its sentence, its code and its extra fields. */
export class LearnApiError extends Error {
  status: number;
  code: string | undefined;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" && body.error ? body.error : `The server answered with status ${status}.`);
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : undefined;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; etag: string | null }> {
  const res = await fetch(`/api/learn/${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new LearnApiError(res.status, parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
  return { data: parsed as T, etag: res.headers.get("etag") };
}

export interface KeysResponse {
  keys: AuthKeyStatus[];
  providers: { id: string; envVar: string; label: string }[];
}

export interface CustomRead {
  state: CustomProviderState;
  etag: string;
}

export const learnModels = {
  catalog: async () => (await request<ModelCatalogResponse>("GET", "models")).data,
  keys: async () => (await request<KeysResponse>("GET", "keys")).data,
  saveKey: async (id: string, value: string) => (await request<AuthKeyStatus>("PUT", `keys/${encodeURIComponent(id)}`, { value })).data,
  removeKey: async (id: string) => (await request<AuthKeyStatus>("DELETE", `keys/${encodeURIComponent(id)}`)).data,
  claudeCode: async () => (await request<ClaudeCodeStatus>("GET", "claude-code")).data,
  custom: async (): Promise<CustomRead> => {
    const r = await request<CustomProviderState>("GET", "custom-provider");
    return { state: r.data, etag: r.etag ?? "" };
  },
  connectCustom: async (body: CustomProviderConnect, etag: string): Promise<CustomRead> => {
    const r = await request<CustomProviderState>("POST", "custom-provider", body, { "if-match": etag });
    return { state: r.data, etag: r.etag ?? "" };
  },
  pinCustom: async (overrides: NonNullable<CustomProviderState["overrides"]>, etag: string): Promise<CustomRead> => {
    const r = await request<CustomProviderState>("PATCH", "custom-provider", { overrides }, { "if-match": etag });
    return { state: r.data, etag: r.etag ?? "" };
  },
  disconnectCustom: async (etag: string): Promise<CustomRead> => {
    const r = await request<CustomProviderState>("DELETE", "custom-provider", undefined, { "if-match": etag });
    return { state: r.data, etag: r.etag ?? "" };
  },
  settings: async () => (await request<LearnSettings>("GET", "settings")).data,
  saveSettings: async (settings: LearnSettings) => (await request<LearnSettings>("PUT", "settings", settings)).data,
  saveModels: async (models: Partial<Record<ModelSlotName, ModelSlot>>) => (await request<Partial<Record<ModelSlotName, ModelSlot>>>("PUT", "settings/models", models)).data,
};

export const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

/** The three slots under the names of their jobs, as the Cortex kit sets them out. */
export const SLOT_TEXT: Record<ModelSlotName, { label: string; hint: string }> = {
  strong: { label: "Main model", hint: "Measures what you know, plans the route and teaches." },
  cheap: { label: "Helper model", hint: "Reads sources for the graph, checks links and runs research." },
  vision: { label: "Image model", hint: "Reads PDF pages and images. Only models that accept images are listed." },
};

export const THINKING_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const LEVEL_TEXT: Record<ThinkingLevel, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

/** The value of a model menu: the provider, a colon and the id. A model id may hold colons, a provider id does not. */
export const modelValue = (ref: ModelRef): string => `${ref.provider}:${ref.id}`;

export function parseModelValue(value: string): ModelRef | null {
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

export const modelKey = (m: Pick<ModelCatalogEntry, "provider" | "id">): string => `${m.provider}:${m.id}`;

/** The models that a slot may offer. The vision slot lists only models that accept images. */
export function modelsForSlot(catalog: ModelCatalogResponse, slot: ModelSlotName): ModelCatalogEntry[] {
  return catalog.models.filter((m) => slot !== "vision" || m.input.includes("image"));
}

/** The entry that a model reference names, or undefined when its provider has no key now. */
export function findEntry(catalog: ModelCatalogResponse, ref: ModelRef | undefined | null): ModelCatalogEntry | undefined {
  return ref ? catalog.models.find((m) => m.provider === ref.provider && m.id === ref.id) : undefined;
}

/** The nearest level that the model supports, with a tie going to the lower level. A swap never fails, and the server clamps again. */
export function nearestLevel(supported: ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (supported.length === 0 || supported.includes(level)) return level;
  const at = THINKING_ORDER.indexOf(level);
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of supported) {
    const d = Math.abs(THINKING_ORDER.indexOf(s) - at);
    if (d < bestDistance || (d === bestDistance && THINKING_ORDER.indexOf(s) < THINKING_ORDER.indexOf(best))) {
      best = s;
      bestDistance = d;
    }
  }
  return best;
}

/** The default order for an unset level: the first supported level of medium, low, high, minimal, xhigh and max, or off. */
export function defaultLevelFor(supported: ThinkingLevel[]): ThinkingLevel {
  return (["medium", "low", "high", "minimal", "xhigh", "max"] as ThinkingLevel[]).find((l) => supported.includes(l)) ?? "off";
}

export type SlotState = { kind: "needed" } | { kind: "key-missing"; provider: string } | { kind: "ready"; entry: ModelCatalogEntry } | { kind: "unlisted"; ref: ModelRef };

/** A slot with no model is Needed. A model whose provider has no key shows as Key missing, and the menu lists live models only. */
export function slotState(catalog: ModelCatalogResponse, slot: ModelSlotName): SlotState {
  const ref = catalog.slots[slot];
  if (!ref) return { kind: "needed" };
  const entry = findEntry(catalog, ref);
  if (entry) return { kind: "ready", entry };
  const provider = catalog.providers.find((p) => p.id === ref.provider);
  if (!provider || !provider.keyPresent) return { kind: "key-missing", provider: ref.provider };
  return { kind: "unlisted", ref };
}

/** "Ends in 4f2a, 64 characters", or a sentence for a key that is too short to show any part of. */
export function keyLine(status: AuthKeyStatus): string {
  if (!status.present) return "No key";
  const size = status.length === null ? "" : `${status.length} characters`;
  if (status.masked) return size ? `Ends in ${status.masked}, ${size}` : `Ends in ${status.masked}`;
  return size ? `Saved, ${size}` : "Saved";
}

export function keyStateWord(status: AuthKeyStatus): string {
  if (!status.present) return "No key";
  if (status.source === "env") return "Set by an environment variable";
  return "Connected";
}

/** The sentence under a failed save or a refused action. A refusal about models or keys is informational. */
export function noticeFor(err: unknown): { text: string; tone: "info" | "error" } {
  if (err instanceof LearnApiError) {
    const informational = err.code === "models_not_configured" || err.code === "provider_key_missing" || err.code === "claude_code_unavailable";
    return { text: err.message, tone: informational ? "info" : "error" };
  }
  return { text: err instanceof Error && err.message ? err.message : "The request could not be completed.", tone: "error" };
}

/** Whether every slot that a session needs holds a model. All three are required before a session starts. */
export function setupGap(catalog: ModelCatalogResponse): "keys" | "models" | null {
  if (catalog.models.length === 0 && !catalog.providers.some((p) => p.keyPresent)) return "keys";
  return SLOT_ORDER.some((s) => !catalog.slots[s]) ? "models" : null;
}

/** Context sizes show as 8k or 1.2M. A missing size says so in words. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Not reported";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(n);
}

/** Dollars per million tokens, or a plain word for a model that has no price. */
export function formatPrice(cost: ModelCatalogEntry["cost"]): string {
  if (!cost) return "Not priced";
  return `$${cost.input} in, $${cost.output} out per million tokens`;
}

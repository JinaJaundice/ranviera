// Pure parts of the custom OpenAI compatible endpoint: the base URL rule, model id
// splitting, the discovery parser, the credential binding check and the mapping of
// stored settings to library models. See docs/CONTRACTS.md, "Model layer" and
// "Keys file".
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CustomProviderBinding, CustomProviderSettings } from "../../../../shared/learn/models.ts";

export const CUSTOM_PROVIDER_ID = "custom";
export const DEFAULT_CONTEXT = 8192;
export const DEFAULT_MAX_TOKENS = 4096;
export const DISCOVERY_TIMEOUT_MS = 15_000;
export const DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;
export const DISCOVERY_MAX_MODELS = 10_000;

type CustomModel = NonNullable<CustomProviderSettings["models"]>[number];

// The fields in which model servers report the context size, most trusted first. The first field found is used.
const CONTEXT_SIZE_FIELDS = [
  "max_input_tokens",
  "context_length",
  "context_window",
  "max_context",
  // names from llama.cpp and from Hugging Face model configurations
  "n_ctx",
  "max_seq_len",
  "max_position_embeddings",
];

/** Returns the base URL without trailing slashes, or null when it breaks the rule. */
export function normaliseBaseUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || text.includes("#") || text.includes("?")) return null;
  if (!url.hostname) return null;
  return text.replace(/\/+$/, "");
}

/** Loopback hosts of the local class: localhost, 127.0.0.1, [::1] and a name that ends in .localhost. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

export function isLoopbackUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** True when a key sent to this address would cross the network unencrypted: plain http to a host that is not loopback. */
export function keyNeedsConfirmation(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Splits typed model ids on commas and white space, trims, drops empties and repeats. */
export function splitModelIds(input: string | string[] | undefined): string[] {
  const parts = (Array.isArray(input) ? input.join(",") : (input ?? "")).split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const id = p.trim();
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** True when the binding authorises the stored endpoint: same id, same URL and same mode. */
export function customUsable(custom: CustomProviderSettings | undefined, binding: CustomProviderBinding | null): boolean {
  if (!custom?.baseUrl || !custom.authMode || !custom.credentialBindingId || !binding) return false;
  if (custom.authMode === "apiKey" && keyNeedsConfirmation(custom.baseUrl) && !custom.localConfirmedAt) return false;
  if (binding.version !== 1 || binding.authMode === "disabled") return false;
  return binding.id === custom.credentialBindingId && binding.baseUrl === custom.baseUrl && binding.authMode === custom.authMode;
}

/** Parses the binding entry of the keys file, which may be an object or a JSON string. */
export function parseBinding(raw: unknown): CustomProviderBinding | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.id !== "string" || !v.id) return null;
  if (v.authMode !== "apiKey" && v.authMode !== "keyless" && v.authMode !== "disabled") return null;
  const out: CustomProviderBinding = { version: 1, id: v.id, authMode: v.authMode };
  if (typeof v.baseUrl === "string") out.baseUrl = v.baseUrl;
  if (typeof v.fileKeyBaseUrl === "string") out.fileKeyBaseUrl = v.fileKeyBaseUrl;
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function wordsIn(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((v) => wordsIn(v, pattern));
  if (isObj(value)) return Object.entries(value).some(([k, v]) => (v === true && pattern.test(k)) || (typeof v === "string" && pattern.test(v)) || (Array.isArray(v) && wordsIn(v, pattern)));
  return false;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Reads image support, reasoning support and sizes from the explicit fields of one listing row. Nothing is guessed from the name. */
export function modelFromRow(row: unknown): CustomModel | null {
  if (typeof row === "string") {
    const id = row.trim();
    return id ? { id } : null;
  }
  if (!isObj(row) || typeof row.id !== "string" || !row.id.trim()) return null;
  const out: CustomModel = { id: row.id.trim() };
  const arch = isObj(row.architecture) ? row.architecture : {};
  const imageFields = [row.capabilities, row.supported_modalities, row.modalities, arch.input_modalities, row.input_modalities];
  if (imageFields.some((f) => wordsIn(f, /image|vision/i))) out.image = true;
  const flags = [row.reasoning, row.supports_reasoning, row.thinking];
  const tokenFields = [row.supported_parameters, row.capabilities, row.tags, arch.output_modalities];
  if (flags.some((f) => f === true) || tokenFields.some((f) => wordsIn(f, /reasoning|thinking/i))) out.reasoning = true;
  else if (flags.some((f) => f === false)) out.reasoning = false;
  for (const key of CONTEXT_SIZE_FIELDS) {
    const n = positiveInt(row[key]);
    if (n) {
      out.context = n;
      break;
    }
  }
  const maxOut = positiveInt(row.max_output_tokens);
  if (maxOut) out.maxTokens = maxOut;
  return out;
}

/** Accepts a bare array, { data } or { models }. Throws a plain sentence when the shape is wrong or the list is too long. */
export function parseModelList(json: unknown): CustomModel[] {
  const rows = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.data) ? json.data : isObj(json) && Array.isArray(json.models) ? json.models : null;
  if (!rows) throw new Error("The endpoint answered, but its reply is not a list of models.");
  if (rows.length > DISCOVERY_MAX_MODELS) throw new Error(`The endpoint lists more than ${DISCOVERY_MAX_MODELS} models, which is over the limit.`);
  const byId = new Map<string, CustomModel>();
  for (const row of rows) {
    const m = modelFromRow(row);
    if (m && !byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Library models for a stored endpoint. A pin beats discovery, which beats the compiled default. Cost is a placeholder and the catalogue reports it as unknown. */
export function buildCustomModels(custom: CustomProviderSettings): Model<Api>[] {
  const baseUrl = custom.baseUrl ?? "";
  const ids = new Map<string, CustomModel>();
  for (const m of custom.models ?? []) ids.set(m.id, m);
  for (const id of custom.manualModels ?? []) if (!ids.has(id)) ids.set(id, { id });
  return [...ids.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => {
      const pin = custom.overrides?.[m.id];
      return {
        id: m.id,
        name: m.id,
        api: "openai-completions",
        provider: CUSTOM_PROVIDER_ID,
        baseUrl,
        reasoning: pin?.reasoning ?? m.reasoning ?? false,
        input: m.image ? ["text", "image"] : ["text"],
        cost: { cacheWrite: 0, cacheRead: 0, output: 0, input: 0 },
        contextWindow: pin?.context ?? m.context ?? DEFAULT_CONTEXT,
        maxTokens: pin?.maxTokens ?? m.maxTokens ?? DEFAULT_MAX_TOKENS,
      } as Model<Api>;
    });
}

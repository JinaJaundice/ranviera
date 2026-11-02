// The keys file <data_dir>/auth.json. The source of truth is docs/CONTRACTS.md,
// section "Learning and knowledge (1 November 2026)" ("Keys file").
//
// The file is one flat JSON object from an environment variable name to a value. It
// is read again on every access, written through a temporary file with mode 0600,
// and reflected into the process environment so that the model library finds a
// saved key at once. A real environment variable always wins over the file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthKeyStatus } from "../../../../shared/learn/models.ts";
import { LearnError, badRequest, notFound } from "./errors.ts";

export const BINDING_ENTRY = "__cortex_custom_provider_binding";
export const CUSTOM_KEY_NAME = "CUSTOM_OPENAI_API_KEY";
export const TAVILY_KEY_NAME = "TAVILY_API_KEY";
export const BRAVE_KEY_NAME = "BRAVE_API_KEY";
export const IGNORE_ENV_SWITCH = "LEARN_IGNORE_ENV_KEYS";

export interface ProviderKeyRow {
  /** the provider id of the model library */
  id: string;
  envVar: string;
  label: string;
}

/**
 * The key based providers of @earendil-works/pi-ai 1.4.0 with the variable that each one
 * reads. Anthropic lists only its API key variable, because the library also reads two
 * token variables that a person does not paste here. GitHub Copilot, Amazon Bedrock and
 * OpenAI Codex sign in in other ways and are absent. The test keys.table.test.ts derives
 * this table from the library again and fails when the two differ.
 */
export const PROVIDER_KEY_TABLE: readonly ProviderKeyRow[] = [
  { id: "ant-ling", envVar: "ANT_LING_API_KEY", label: "Ant Ling" },
  { id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  { id: "azure", envVar: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI" },
  { id: "baseten", envVar: "BASETEN_API_KEY", label: "Baseten" },
  { id: "cerebras", envVar: "CEREBRAS_API_KEY", label: "Cerebras" },
  { id: "cloudflare-ai-gateway", envVar: "CLOUDFLARE_API_KEY", label: "Cloudflare AI Gateway" },
  { id: "cloudflare-workers-ai", envVar: "CLOUDFLARE_API_KEY", label: "Cloudflare Workers AI" },
  { id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { id: "fireworks", envVar: "FIREWORKS_API_KEY", label: "Fireworks" },
  { id: "google", envVar: "GEMINI_API_KEY", label: "Google Gemini" },
  { id: "google-vertex", envVar: "GOOGLE_CLOUD_API_KEY", label: "Google Vertex AI" },
  { id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
  { id: "huggingface", envVar: "HF_TOKEN", label: "Hugging Face" },
  { id: "kimi-coding", envVar: "KIMI_API_KEY", label: "Kimi Coding" },
  { id: "meta", envVar: "META_API_KEY", label: "Meta" },
  { id: "minimax", envVar: "MINIMAX_API_KEY", label: "MiniMax" },
  { id: "minimax-cn", envVar: "MINIMAX_CN_API_KEY", label: "MiniMax China" },
  { id: "mistral", envVar: "MISTRAL_API_KEY", label: "Mistral" },
  { id: "moonshotai", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI" },
  { id: "moonshotai-cn", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI China" },
  { id: "nvidia", envVar: "NVIDIA_API_KEY", label: "NVIDIA" },
  { id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
  { id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode" },
  { id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" },
  { id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
  { id: "qwen-token-plan", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen token plan" },
  { id: "qwen-token-plan-cn", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY", label: "Qwen token plan China" },
  { id: "qwen-token-plan-individual", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen token plan individual" },
  { id: "radius", envVar: "RADIUS_API_KEY", label: "Radius" },
  { id: "together", envVar: "TOGETHER_API_KEY", label: "Together" },
  { id: "typesafe", envVar: "TYPESAFE_API_KEY", label: "Typesafe" },
  { id: "vercel-ai-gateway", envVar: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway" },
  { id: "xai", envVar: "XAI_API_KEY", label: "xAI" },
  { id: "xiaomi", envVar: "XIAOMI_API_KEY", label: "Xiaomi" },
  { id: "xiaomi-token-plan-ams", envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", label: "Xiaomi token plan Amsterdam" },
  { id: "xiaomi-token-plan-cn", envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY", label: "Xiaomi token plan China" },
  { id: "xiaomi-token-plan-sgp", envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", label: "Xiaomi token plan Singapore" },
  { id: "zai", envVar: "ZAI_API_KEY", label: "Z.ai" },
  { id: "zai-coding-cn", envVar: "ZAI_CODING_CN_API_KEY", label: "Z.ai Coding China" },
];

/** Where a person can create a key, for the providers whose address is well known. Others have none. */
const DOCS_URL: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  GEMINI_API_KEY: "https://aistudio.google.com/apikey",
  OPENROUTER_API_KEY: "https://openrouter.ai/keys",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  GROQ_API_KEY: "https://console.groq.com/keys",
  DEEPSEEK_API_KEY: "https://platform.deepseek.com/api_keys",
  XAI_API_KEY: "https://console.x.ai",
  TOGETHER_API_KEY: "https://api.together.ai/settings/api-keys",
  FIREWORKS_API_KEY: "https://fireworks.ai/account/api-keys",
  CEREBRAS_API_KEY: "https://cloud.cerebras.ai",
  HF_TOKEN: "https://huggingface.co/settings/tokens",
  TAVILY_API_KEY: "https://app.tavily.com",
  BRAVE_API_KEY: "https://brave.com/search/api/",
};

/** The distinct provider variable names of the table, in table order. */
export function providerEnvVars(): string[] {
  return [...new Set(PROVIDER_KEY_TABLE.map((r) => r.envVar))];
}

const SERVICE_INFO: Record<string, { label: string; description: string }> = {
  [TAVILY_KEY_NAME]: { label: "Tavily web search", description: "Lets the research agent search the web. Without it the agent cannot search." },
  [BRAVE_KEY_NAME]: { label: "Brave web search", description: "Lets the research agent search the web through Brave. Tavily and Brave are never swapped for each other." },
};

/** Label, description and address for a writable name, or null for any other name. */
export function keyInfo(name: string): AuthKeyStatus["info"] {
  const service = SERVICE_INFO[name];
  if (service) return { ...service, docsUrl: DOCS_URL[name] ?? "" };
  const rows = PROVIDER_KEY_TABLE.filter((r) => r.envVar === name);
  if (rows.length === 0) return null;
  const label = rows.map((r) => r.label).join(" and ");
  return { label, description: `The key for ${label}. The models of the provider appear in the pickers once the key is saved.`, docsUrl: DOCS_URL[name] ?? "" };
}

/** Names that the keys route may write. The custom endpoint key and the binding entry are not among them. */
export function writableKeyNames(): string[] {
  return [...providerEnvVars(), TAVILY_KEY_NAME, BRAVE_KEY_NAME];
}

export function isWritableKeyName(name: string): boolean {
  return writableKeyNames().includes(name);
}

/** Every name that the store manages, including the custom endpoint key. */
export function managedKeyNames(): string[] {
  return [...writableKeyNames(), CUSTOM_KEY_NAME];
}

/** The shape rule of the contract. Returns a sentence when the value is refused, or null when it passes. */
export function keyShapeError(name: string, raw: unknown): string | null {
  if (typeof raw !== "string") return "The key must be text.";
  const value = raw.trim();
  if (/\s/.test(value)) return "The key contains a space or a line break. Paste the key again without them.";
  if (name === TAVILY_KEY_NAME) {
    if (!value.startsWith("tvly-") || value.length < 20) return "A Tavily key starts with tvly- and has at least 20 characters. The paste may be cut short.";
    return null;
  }
  if (name === BRAVE_KEY_NAME) {
    if (value.length < 20) return "A Brave key has at least 20 characters. The paste may be cut short.";
    return null;
  }
  if (value.length < 12) return "A provider key has at least 12 characters. The paste may be cut short.";
  return null;
}

// Names that a hand edited file must never place in the process environment.
const NEVER_REFLECT = /^(PATH|PATHEXT|HOME|USERPROFILE|COMSPEC|SYSTEMROOT|NODE_.*|NPM_.*|LD_.*|DYLD_.*|PYTHON.*)$/i;

export interface KeysStoreOptions {
  /** the keys file, normally <data_dir>/auth.json */
  authFile: string;
  /** the environment that the store reads and fills. It defaults to process.env */
  env?: NodeJS.ProcessEnv;
  /** removes every managed variable from the environment when the store is created. It defaults to the switch LEARN_IGNORE_ENV_KEYS=1 */
  ignoreEnvKeys?: boolean;
}

export interface KeysStore {
  readonly authFile: string;
  /** Status of one writable name, which may be absent. */
  statusOf(name: string): AuthKeyStatus;
  /** The rows that are present, writable names first, then unknown entries of the file. */
  list(): AuthKeyStatus[];
  providers(): { id: string; envVar: string; label: string }[];
  /** Saves a key after the shape check. Throws 404 for an unknown name and 400 for a bad shape. */
  save(name: string, value: unknown): AuthKeyStatus;
  /** Removes a key. Removing an absent key is not an error. */
  remove(name: string): AuthKeyStatus;
  /** The value that a request would use, with its origin. The environment wins. Never send this to a client. */
  effective(name: string): { value: string; source: "env" | "file" } | null;
  /** The value in the file, whatever the environment holds. */
  fileValue(name: string): string | null;
  /** True when the name is set in the real launch environment and not by this store. */
  isRealEnv(name: string): boolean;
  /** True when the provider of the library has a key at this moment. Null for a provider that is not in the table. */
  providerKeyPresent(providerId: string): boolean | null;
  /** Reads the raw file, applies the change and writes it once, atomically. */
  mutate(change: (entries: Record<string, unknown>) => void): void;
  /** The raw entry of the file, for the reserved binding entry. */
  rawEntry(name: string): unknown;
  /** The names that only this store placed in the environment. */
  injectedNames(): string[];
  /** A copy of an environment without the names that only this store placed in it. A child process takes this copy. */
  scrubbed(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

function isEntries(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function lastFour(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}

export function createKeysStore(options: KeysStoreOptions): KeysStore {
  const authFile = options.authFile;
  const env = options.env ?? process.env;
  const injected = new Map<string, string>();

  /** For reads: a missing, unreadable or corrupt file reads as no keys. */
  function readEntries(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(authFile, "utf8"));
      if (isEntries(parsed)) return parsed;
    } catch {
      // the file reads as no keys
    }
    return {};
  }

  /** For writes: only a missing file reads as empty. A file that exists but cannot be read or parsed refuses the write. */
  function readForWrite(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(authFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw unreadable("The file could not be read");
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEntries(parsed)) return parsed;
    } catch {
      // reported below
    }
    throw unreadable("The file is not a JSON object");
  }

  function unreadable(reason: string): LearnError {
    return new LearnError(409, "keys_file_unreadable", `${reason}, so this app keeps it as it is and saves nothing. Fix or move ${path.basename(authFile)} in the data folder, then try again.`);
  }

  function writeEntries(entries: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    try {
      fs.copyFileSync(authFile, `${authFile}.bak`); // the previous file stays beside the new one
      try {
        fs.chmodSync(`${authFile}.bak`, 0o600);
      } catch {
        // some file systems have no modes
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw unreadable("A copy of the file could not be made");
    }
    const tmp = `${authFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, "\t")}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        // some file systems have no modes
      }
      fs.renameSync(tmp, authFile);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // the temporary file is already gone
      }
      throw e;
    }
  }

  const stringEntry = (entries: Record<string, unknown>, name: string): string | null => {
    const v = entries[name];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  /** Brings the environment in line with the file. Only names that this store placed there are ever removed. */
  function sync(entries: Record<string, unknown>): void {
    for (const [name, value] of [...injected]) {
      if (env[name] !== value) {
        injected.delete(name); // someone else set the variable, so it is real environment now
        continue;
      }
      const file = stringEntry(entries, name);
      if (file === null) {
        delete env[name];
        injected.delete(name);
      } else if (file !== value) {
        env[name] = file;
        injected.set(name, file);
      }
    }
    for (const name of Object.keys(entries)) {
      if (name === BINDING_ENTRY || NEVER_REFLECT.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const file = stringEntry(entries, name);
      if (file === null || injected.has(name)) continue;
      if (env[name] === undefined || env[name] === "") {
        env[name] = file;
        injected.set(name, file);
      }
    }
  }

  const isRealEnv = (name: string) => !!env[name] && !injected.has(name);

  if (options.ignoreEnvKeys ?? env[IGNORE_ENV_SWITCH] === "1") {
    for (const name of managedKeyNames()) delete env[name];
  }
  sync(readEntries());

  function statusFrom(entries: Record<string, unknown>, name: string): AuthKeyStatus {
    const file = stringEntry(entries, name);
    const real = isRealEnv(name) ? (env[name] as string) : null;
    const effective = real ?? file;
    return {
      id: name,
      info: isWritableKeyName(name) ? keyInfo(name) : null,
      present: effective !== null,
      masked: effective ? lastFour(effective) : null,
      length: effective ? effective.length : null,
      source: real ? "env" : file ? "file" : "none",
      shadowedByEnv: real !== null && file !== null && real !== file,
    };
  }

  function fresh(): Record<string, unknown> {
    const entries = readEntries();
    sync(entries);
    return entries;
  }

  const store: KeysStore = {
    authFile,
    statusOf(name) {
      return statusFrom(fresh(), name);
    },
    list() {
      const entries = fresh();
      const names = writableKeyNames();
      const unknown = Object.keys(entries).filter((n) => n !== BINDING_ENTRY && n !== CUSTOM_KEY_NAME && !names.includes(n) && stringEntry(entries, n) !== null);
      return [...names, ...unknown].map((n) => statusFrom(entries, n)).filter((s) => s.present);
    },
    providers() {
      return PROVIDER_KEY_TABLE.map(({ id, envVar, label }) => ({ id, envVar, label }));
    },
    save(name, value) {
      if (!isWritableKeyName(name)) throw notFound(`The name ${name} is not a key that this app can store.`);
      const problem = keyShapeError(name, value);
      if (problem) throw badRequest(problem);
      const entries = readForWrite();
      entries[name] = (value as string).trim();
      writeEntries(entries);
      sync(entries);
      return statusFrom(entries, name);
    },
    remove(name) {
      if (!isWritableKeyName(name)) throw notFound(`The name ${name} is not a key that this app can store.`);
      const entries = readForWrite();
      if (name in entries) {
        delete entries[name];
        writeEntries(entries);
      }
      sync(entries);
      return statusFrom(entries, name);
    },
    effective(name) {
      const entries = fresh();
      if (isRealEnv(name)) return { value: env[name] as string, source: "env" };
      const file = stringEntry(entries, name);
      return file ? { value: file, source: "file" } : null;
    },
    fileValue(name) {
      return stringEntry(readEntries(), name);
    },
    isRealEnv(name) {
      fresh();
      return isRealEnv(name);
    },
    providerKeyPresent(providerId) {
      const rows = PROVIDER_KEY_TABLE.filter((r) => r.id === providerId);
      if (rows.length === 0) return null;
      return rows.some((r) => store.effective(r.envVar) !== null);
    },
    mutate(change) {
      const entries = readForWrite();
      change(entries);
      writeEntries(entries);
      sync(entries);
    },
    rawEntry(name) {
      return readEntries()[name];
    },
    injectedNames() {
      fresh();
      return [...injected.keys()];
    },
    scrubbed(base = env) {
      const names = new Set(store.injectedNames());
      const copy: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(base)) if (!names.has(k)) copy[k] = v;
      return copy;
    },
  };
  return store;
}

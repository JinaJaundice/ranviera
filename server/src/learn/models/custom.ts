// The custom OpenAI compatible endpoint: connect, discovery, pins, the entity tag and
// the credential binding. The source of truth is docs/CONTRACTS.md, "Model layer",
// "Keys file" and "Routes".
//
// A key is bound to the base URL that it was entered for. A change of URL needs a new
// key or an explicit request to reuse the old one. The key and its binding are written
// in one atomic file write, and the settings are written second, so that a failure
// between the two leaves the endpoint disabled and never points an old key at a new URL.
import { createHmac, randomBytes } from "node:crypto";
import type { CustomProviderConnect, CustomProviderSettings, CustomProviderState } from "../../../../shared/learn/models.ts";
import {
  DISCOVERY_MAX_BYTES,
  DISCOVERY_TIMEOUT_MS,
  customUsable,
  keyNeedsConfirmation,
  normaliseBaseUrl,
  parseBinding,
  parseModelList,
  splitModelIds,
} from "./endpoint.ts";
import { LearnError, badRequest } from "./errors.ts";
import { BINDING_ENTRY, CUSTOM_KEY_NAME, type KeysStore } from "./keys.ts";
import { sanitiseOverrides, type SettingsStore } from "./settings.ts";

type ModelRow = NonNullable<CustomProviderSettings["models"]>[number];

export interface CustomServiceOptions {
  keys: KeysStore;
  settings: SettingsStore;
  /** the network call, for tests. It defaults to fetch */
  fetch?: typeof fetch;
  now?: () => Date;
  /** called after a change that the model catalogue must reflect */
  onChange?: () => void;
}

export interface CustomService {
  state(): CustomProviderState;
  /** The entity tag of the current state. It covers no key material. */
  etag(): string;
  connect(body: unknown, ifMatch: string | undefined): Promise<CustomProviderState>;
  pins(body: unknown, ifMatch: string | undefined): Promise<CustomProviderState>;
  disconnect(ifMatch: string | undefined): Promise<CustomProviderState>;
}

class DiscoveryFailure extends Error {
  fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

/** Reads at most limit bytes of the body, cancelling the stream when the running total passes it. */
async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new DiscoveryFailure("The endpoint reply is larger than 8 MiB, which is over the limit.", true);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET <baseUrl>/models. Redirects are refused. A key is sent only when one is given. */
export async function discoverModels(baseUrl: string, key: string | undefined, doFetch: typeof fetch): Promise<ModelRow[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/models`, { headers, redirect: "manual", signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  } catch (e) {
    throw new DiscoveryFailure(`The endpoint could not be reached. ${e instanceof Error ? e.message : ""}`.trim(), false);
  }
  if (res.status >= 300 && res.status < 400) throw new DiscoveryFailure("The endpoint answered with a redirect. This app does not follow redirects, so use the address that the server answers on.", true);
  if (res.status === 401 || res.status === 403) throw new DiscoveryFailure("The endpoint refused the key. Check the key and try again.", true);
  if (!res.ok) throw new DiscoveryFailure(`The endpoint answered with status ${res.status}.`, false);
  const bodyText = await readLimited(res, DISCOVERY_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new DiscoveryFailure("The endpoint answered, but its reply is not valid JSON.", false);
  }
  try {
    return parseModelList(json);
  } catch (e) {
    const message = e instanceof Error ? e.message : "The model list could not be read.";
    throw new DiscoveryFailure(message, message.includes("more than"));
  }
}

const sameModels = (a: ModelRow[] | undefined) => (a ?? []).slice().sort((x, y) => (x.id < y.id ? -1 : 1));

export function createCustomService(options: CustomServiceOptions): CustomService {
  const { keys, settings } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const secret = randomBytes(32);
  let queue: Promise<unknown> = Promise.resolve();

  /** Mutations run one after another, so two requests never interleave their file writes. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const binding = () => parseBinding(keys.rawEntry(BINDING_ENTRY));
  const stored = () => settings.read().customProvider;

  function etag(): string {
    const custom = stored() ?? null;
    const keyReadable = keys.effective(CUSTOM_KEY_NAME) !== null;
    const mac = createHmac("sha256", secret).update(JSON.stringify([custom, binding(), keyReadable])).digest("hex");
    return `"${mac.slice(0, 32)}"`;
  }

  function state(): CustomProviderState {
    const custom = stored();
    const bound = binding();
    const effective = keys.effective(CUSTOM_KEY_NAME);
    const usableApiKey = customUsable(custom, bound) && custom?.authMode === "apiKey";
    return {
      baseUrl: custom?.baseUrl ?? null,
      authMode: custom?.authMode ?? null,
      models: custom?.models ?? [],
      overrides: custom?.overrides ?? {},
      manualModels: custom?.manualModels ?? [],
      keyPresent: effective !== null,
      keySource: effective?.source ?? "none",
      keyReuseRequired: effective !== null && !usableApiKey,
      localConfirmedAt: custom?.localConfirmedAt ?? null,
    };
  }

  function requireMatch(ifMatch: string | undefined): void {
    if (!ifMatch) throw badRequest("The If-Match header is required. Read the endpoint state first and send its tag.");
    if (ifMatch !== etag()) throw new LearnError(409, "etag_mismatch", "The endpoint was changed elsewhere. Read it again and repeat the change.");
  }

  function parseConnect(body: unknown): CustomProviderConnect & { baseUrl: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("The body must be an object.");
    const b = body as Record<string, unknown>;
    const baseUrl = normaliseBaseUrl(b.baseUrl);
    if (!baseUrl) throw badRequest("The base URL must start with http:// or https:// and must hold no user name, password, query or fragment.");
    if (b.authMode !== "keyless" && b.authMode !== "apiKey") throw badRequest("The authentication mode must be keyless or apiKey.");
    if (b.apiKey !== undefined && typeof b.apiKey !== "string") throw badRequest("The key must be text.");
    if (b.reuseKey !== undefined && typeof b.reuseKey !== "boolean") throw badRequest("The reuse flag must be true or false.");
    if (b.localConfirmed !== undefined && typeof b.localConfirmed !== "boolean") throw badRequest("The local flag must be true or false.");
    let manualModels: string[] | undefined;
    if (b.manualModels !== undefined) {
      if (!Array.isArray(b.manualModels) || !b.manualModels.every((m) => typeof m === "string")) throw badRequest("The typed model ids must be a list of text.");
      manualModels = splitModelIds(b.manualModels as string[]);
    }
    return {
      baseUrl,
      authMode: b.authMode,
      apiKey: typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined,
      reuseKey: b.reuseKey === true,
      manualModels,
      localConfirmed: b.localConfirmed as boolean | undefined,
    };
  }

  /** Chooses the key for the probe and the file, and refuses any silent reuse. */
  function chooseKey(req: CustomProviderConnect & { baseUrl: string }): { probe: string | undefined; store: string | undefined } {
    if (req.authMode === "keyless") return { probe: undefined, store: undefined };
    const envOwned = keys.isRealEnv(CUSTOM_KEY_NAME);
    const envValue = envOwned ? keys.effective(CUSTOM_KEY_NAME)?.value : undefined;
    const fileValue = keys.fileValue(CUSTOM_KEY_NAME) ?? undefined;
    if (req.apiKey) {
      if (envOwned) throw badRequest(`The key is set by the environment variable ${CUSTOM_KEY_NAME}, which wins over the keys file. Remove the variable or leave the key field empty.`);
      if (/\s/.test(req.apiKey)) throw badRequest("The key contains a space or a line break. Paste the key again without them.");
      return { probe: req.apiKey, store: req.apiKey };
    }
    if (req.reuseKey) {
      const existing = envValue ?? fileValue;
      if (!existing) throw badRequest("No stored key exists to reuse. Enter a key.");
      return { probe: existing, store: undefined };
    }
    // the same address, still bound to the stored file key: the key stays in use with no new paste
    const current = stored();
    if (fileValue && !envOwned && customUsable(current, binding()) && current?.authMode === "apiKey" && current.baseUrl === req.baseUrl) return { probe: fileValue, store: undefined };
    throw badRequest("Enter a key for this address, or choose to reuse the stored key. A key is never sent to a new address without your say.");
  }

  async function connectNow(body: unknown, ifMatch: string | undefined): Promise<CustomProviderState> {
    requireMatch(ifMatch);
    const tag = etag();
    const req = parseConnect(body);
    const previous = stored();
    const sameUrl = previous?.baseUrl === req.baseUrl;
    const confirmed = req.localConfirmed === true || (req.localConfirmed === undefined && sameUrl && !!previous?.localConfirmedAt);
    if (req.authMode === "apiKey" && keyNeedsConfirmation(req.baseUrl) && !confirmed) {
      throw badRequest("A key would cross the network unencrypted, because the address starts with http:// and is not on this computer. Use an https:// address, or confirm that the server is on your own machine or network.");
    }
    const key = chooseKey(req);
    const typed = req.manualModels ?? (sameUrl ? previous?.manualModels ?? [] : []);

    let discovered: ModelRow[] | null = null;
    let failure: DiscoveryFailure | null = null;
    try {
      discovered = await discoverModels(req.baseUrl, key.probe, doFetch);
    } catch (e) {
      if (!(e instanceof DiscoveryFailure)) throw e;
      if (e.fatal) throw badRequest(e.message);
      failure = e;
    }
    let models: ModelRow[];
    if (discovered) {
      models = discovered;
    } else {
      const kept = sameUrl ? previous?.models ?? [] : [];
      if (typed.length === 0 && kept.length === 0) throw badRequest(`${failure?.message ?? "The endpoint did not list its models."} Add the model ids by hand and connect again.`);
      models = kept;
    }
    // typed ids join the list, and the metadata that discovery found wins over a typed id
    const have = new Set(models.map((m) => m.id));
    models = [...models, ...typed.filter((id) => !have.has(id)).map((id) => ({ id }))];
    models = sameModels(models);

    // the endpoint may have changed while the probe ran
    if (tag !== etag()) throw new LearnError(409, "etag_mismatch", "The endpoint was changed elsewhere while it was being checked. Read it again and repeat the change.");

    const bound = binding();
    const keepId = sameUrl && customUsable(previous, bound) && previous?.authMode === req.authMode;
    const id = keepId && previous?.credentialBindingId ? previous.credentialBindingId : randomBytes(16).toString("hex");
    const fileKeyBaseUrl = key.store ? req.baseUrl : bound?.fileKeyBaseUrl;
    const nextBinding = { version: 1 as const, id, baseUrl: req.baseUrl, authMode: req.authMode, ...(fileKeyBaseUrl ? { fileKeyBaseUrl } : {}) };

    let localConfirmedAt: string | null = null;
    if (req.localConfirmed === true) localConfirmedAt = sameUrl && previous?.localConfirmedAt ? previous.localConfirmedAt : now().toISOString();
    else if (req.localConfirmed === undefined && sameUrl) localConfirmedAt = previous?.localConfirmedAt ?? null;

    const modelIds = new Set([...models.map((m) => m.id), ...typed]);
    const next: CustomProviderSettings = {
      credentialBindingId: id,
      authMode: req.authMode,
      baseUrl: req.baseUrl,
      models,
      overrides: sameUrl ? sanitiseOverrides(previous?.overrides, modelIds) : {},
      manualModels: typed,
      localConfirmedAt,
    };

    // one atomic write holds the key and its binding, then the settings follow
    const before = { key: keys.rawEntry(CUSTOM_KEY_NAME), binding: keys.rawEntry(BINDING_ENTRY) };
    keys.mutate((entries) => {
      if (key.store) entries[CUSTOM_KEY_NAME] = key.store;
      entries[BINDING_ENTRY] = nextBinding;
    });
    try {
      settings.update((s) => ({ ...s, customProvider: next }));
    } catch (e) {
      keys.mutate((entries) => {
        if (before.key === undefined) delete entries[CUSTOM_KEY_NAME];
        else entries[CUSTOM_KEY_NAME] = before.key;
        if (before.binding === undefined) delete entries[BINDING_ENTRY];
        else entries[BINDING_ENTRY] = before.binding;
      });
      throw e;
    }
    options.onChange?.();
    return state();
  }

  async function pinsNow(body: unknown, ifMatch: string | undefined): Promise<CustomProviderState> {
    requireMatch(ifMatch);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).overrides !== "object" || (body as Record<string, unknown>).overrides === null) {
      throw badRequest("The body must hold an overrides object.");
    }
    const current = stored();
    if (!current?.baseUrl) throw badRequest("No endpoint is connected, so there is nothing to pin.");
    const raw = (body as { overrides: Record<string, unknown> }).overrides;
    for (const [model, pin] of Object.entries(raw)) {
      if (!pin || typeof pin !== "object") throw badRequest(`The pin for ${model} must be an object.`);
      const p = pin as Record<string, unknown>;
      for (const f of ["context", "maxTokens"]) {
        if (p[f] !== undefined && !(typeof p[f] === "number" && Number.isInteger(p[f]) && (p[f] as number) >= 1)) throw badRequest(`The ${f} pin for ${model} must be a whole number of 1 or more.`);
      }
      if (p.reasoning !== undefined && typeof p.reasoning !== "boolean") throw badRequest(`The reasoning pin for ${model} must be true or false.`);
    }
    const ids = new Set([...(current.models ?? []).map((m) => m.id), ...(current.manualModels ?? [])]);
    const overrides = sanitiseOverrides(raw, ids);
    settings.update((s) => ({ ...s, customProvider: { ...(s.customProvider ?? current), overrides } }));
    options.onChange?.();
    return state();
  }

  async function disconnectNow(ifMatch: string | undefined): Promise<CustomProviderState> {
    requireMatch(ifMatch);
    const bound = binding();
    const before = keys.rawEntry(BINDING_ENTRY);
    // a disabled binding keeps a stray environment key from reviving the endpoint
    keys.mutate((entries) => {
      entries[BINDING_ENTRY] = { version: 1, id: randomBytes(16).toString("hex"), authMode: "disabled", ...(bound?.fileKeyBaseUrl ? { fileKeyBaseUrl: bound.fileKeyBaseUrl } : {}) };
    });
    try {
      settings.update((s) => {
        const next = { ...s };
        delete next.customProvider;
        return next;
      });
    } catch (e) {
      keys.mutate((entries) => {
        if (before === undefined) delete entries[BINDING_ENTRY];
        else entries[BINDING_ENTRY] = before;
      });
      throw e;
    }
    options.onChange?.();
    return state();
  }

  return {
    state,
    etag,
    connect: (body, ifMatch) => serial(() => connectNow(body, ifMatch)),
    pins: (body, ifMatch) => serial(() => pinsNow(body, ifMatch)),
    disconnect: (ifMatch) => serial(() => disconnectNow(ifMatch)),
  };
}

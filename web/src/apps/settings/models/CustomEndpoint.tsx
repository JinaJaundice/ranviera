import { useState } from "react";
import type { CustomProviderState } from "@shared/learn/models";
import { Button } from "../../../components/Button";
import { Chip } from "../../../components/Chip";
import { Segmented } from "../../../components/Segmented";
import { StatusDot } from "../../../components/StatusDot";
import { LearnApiError, formatTokens, learnModels, noticeFor } from "../../../lib/learn/models";
import { FIELD, SELECT } from "./fields";
import { Notice, Switch } from "./parts";
import { overridesFromPins, pinFrom, type Pin } from "./pins";
import { applyCustom, reloadCatalogue, useModelsStore } from "./state";

function Pins({ state, etag }: { state: CustomProviderState; etag: string }) {
  const [pins, setPins] = useState<Record<string, Pin>>(() => Object.fromEntries(state.models.map((m) => [m.id, pinFrom(state.overrides[m.id])])));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const update = (id: string, patch: Partial<Pin>) => setPins((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const save = async () => {
    const built = overridesFromPins(pins);
    if ("error" in built) return setNotice({ text: built.error, tone: "error" });
    setBusy(true);
    try {
      applyCustom(await learnModels.pinCustom(built.overrides, etag));
      await reloadCatalogue();
    } catch (e) {
      setNotice(noticeFor(e));
      setBusy(false);
    }
  };
  if (state.models.length === 0) return <p className="mt-2 text-small text-ink-faint">The endpoint lists no models. Type model ids above and connect again.</p>;
  return (
    <div className="mt-3 min-w-0">
      <h4 className="text-body font-medium text-ink">Models of the endpoint</h4>
      <p className="mb-1 text-small text-ink-faint">A pin beats what the endpoint reports. Without either, the context is 8,192 tokens and the output is 4,096 tokens.</p>
      <ul className="min-w-0">
        {state.models.map((m) => (
          <li key={m.id} className="grid min-w-0 grid-cols-1 gap-1.5 border-b border-rule py-1.5 last:border-b-0 @md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="min-w-0 truncate font-mono text-small text-ink">{m.id}</div>
              <div className="mt-0.5 flex flex-wrap gap-1.5 text-small text-ink-soft">
                <Chip>{m.image ? "Accepts images" : "Text only"}</Chip>
                <Chip>{m.reasoning === undefined ? "Reasoning not reported" : m.reasoning ? "Reasons" : "No reasoning"}</Chip>
                <Chip>Context {formatTokens(m.context)}</Chip>
                <Chip>Output {formatTokens(m.maxTokens)}</Chip>
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <input aria-label={`Context size pin for ${m.id}`} inputMode="numeric" placeholder="Context" className={`${FIELD} w-24 font-mono`} value={pins[m.id]?.context ?? ""} onChange={(e) => update(m.id, { context: e.target.value })} />
              <input aria-label={`Output size pin for ${m.id}`} inputMode="numeric" placeholder="Output" className={`${FIELD} w-24 font-mono`} value={pins[m.id]?.maxTokens ?? ""} onChange={(e) => update(m.id, { maxTokens: e.target.value })} />
              <select aria-label={`Reasoning pin for ${m.id}`} className={`${SELECT} w-36`} value={pins[m.id]?.reasoning ?? ""} onChange={(e) => update(m.id, { reasoning: e.target.value as Pin["reasoning"] })}>
                <option value="">Reasoning as reported</option>
                <option value="yes">Reasons</option>
                <option value="no">Does not reason</option>
              </select>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving" : "Save pins"}
        </Button>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
    </div>
  );
}

function CustomForm({ state, etag }: { state: CustomProviderState; etag: string }) {
  const connected = state.baseUrl !== null;
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? "");
  const [authMode, setAuthMode] = useState<"keyless" | "apiKey">(state.authMode ?? "keyless");
  const [apiKey, setApiKey] = useState("");
  const [reuseKey, setReuseKey] = useState(false);
  const [local, setLocal] = useState(state.localConfirmedAt !== null);
  const [manual, setManual] = useState(state.manualModels.join(", "));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);

  const fail = async (e: unknown) => {
    setNotice(noticeFor(e));
    if (e instanceof LearnApiError && e.code === "etag_mismatch") applyCustom(await learnModels.custom());
    setBusy(false);
  };
  const connect = async () => {
    setBusy(true);
    try {
      const body = { baseUrl, authMode, ...(authMode === "apiKey" && apiKey ? { apiKey } : {}), ...(authMode === "apiKey" && reuseKey ? { reuseKey: true } : {}), manualModels: manual.split(/[\s,]+/).filter(Boolean), localConfirmed: local };
      applyCustom(await learnModels.connectCustom(body, etag));
      await reloadCatalogue();
    } catch (e) {
      await fail(e);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      applyCustom(await learnModels.disconnectCustom(etag));
      await reloadCatalogue();
    } catch (e) {
      await fail(e);
    }
  };
  const keyHint = state.keySource === "env" ? "A key is set by CUSTOM_OPENAI_API_KEY in the environment." : state.keyPresent ? "A key is stored. It is bound to the address it was saved for." : "No key is stored.";

  return (
    <form
      className="min-w-0"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      {connected ? (
        <p role="status" className="mb-2 flex min-w-0 items-center gap-2 text-body text-ink">
          <StatusDot tone="pass" />
          <span className="min-w-0 break-words">Connected to {state.baseUrl}. The endpoint counts as {state.localConfirmedAt || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.localhost)(:|\/|$)/i.test(state.baseUrl ?? "") ? "local" : "hosted"}.</span>
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-ink-soft">Base URL, for example http://localhost:11434/v1</span>
          <input className={`${FIELD} w-full`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" spellCheck={false} />
        </label>
        <Segmented
          label="Authentication"
          value={authMode}
          onChange={setAuthMode}
          options={[
            { value: "keyless", label: "Keyless" },
            { value: "apiKey", label: "API key" },
          ]}
        />
        {authMode === "apiKey" ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <input type="password" autoComplete="off" spellCheck={false} aria-label="Endpoint key" placeholder={state.keyPresent ? "Paste a new key, or reuse the stored key" : "Paste key"} className={`${FIELD} w-full font-mono`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <p className="text-small text-ink-faint">{keyHint}</p>
            {state.keyPresent && state.keyReuseRequired ? <Switch checked={reuseKey} onChange={setReuseKey} label="Reuse the stored key for this address" /> : null}
          </div>
        ) : null}
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-ink-soft">Model ids to add by hand, separated by commas or spaces</span>
          <input className={`${FIELD} w-full font-mono`} value={manual} onChange={(e) => setManual(e.target.value)} spellCheck={false} />
        </label>
        <Switch checked={local} onChange={setLocal} label="This endpoint runs on my own machine or network" />
        <p className="pl-6 text-small text-ink-faint">A local endpoint may receive client-confidential material. Say so only when no one outside your own network can read what it receives.</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !baseUrl.trim()}>
          {busy ? "Connecting" : connected ? "Connect again" : "Connect"}
        </Button>
        {connected ? (
          <Button onClick={() => void disconnect()} disabled={busy}>
            Disconnect
          </Button>
        ) : null}
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
      {connected ? <Pins state={state} etag={etag} /> : null}
    </form>
  );
}

/** The custom OpenAI compatible endpoint: connect, discovery, pins and disconnect. */
export function CustomEndpoint() {
  const custom = useModelsStore((s) => s.custom);
  if (!custom) return null;
  // the form restarts from the server state each time its tag changes
  return <CustomForm key={custom.etag} state={custom.state} etag={custom.etag} />;
}

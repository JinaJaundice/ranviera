import { useState } from "react";
import type { ModelCatalogEntry, ModelCatalogResponse, ModelSlot, ModelSlotName } from "@shared/learn/models";
import type { ThinkingLevel } from "@shared/learn/sessions";
import { StatusDot } from "../../../components/StatusDot";
import {
  LEVEL_TEXT,
  SLOT_ORDER,
  SLOT_TEXT,
  THINKING_ORDER,
  defaultLevelFor,
  findEntry,
  learnModels,
  modelValue,
  modelsForSlot,
  nearestLevel,
  noticeFor,
  parseModelValue,
  slotState,
  type SlotState,
} from "../../../lib/learn/models";
import { SELECT } from "./fields";
import { Notice, SettingRow } from "./parts";
import { applySettings, reloadCatalogue, useModelsStore } from "./state";

const CACHE_CHOICES: { value: "" | "none" | "short" | "long"; label: string }[] = [
  { value: "", label: "Library default" },
  { value: "none", label: "No caching" },
  { value: "short", label: "Short retention" },
  { value: "long", label: "Long retention" },
];

function stateWord(s: SlotState): { tone: "pass" | "hold"; word: string } {
  if (s.kind === "ready") return { tone: "pass", word: "Ready" };
  if (s.kind === "needed") return { tone: "hold", word: "Needed" };
  if (s.kind === "key-missing") return { tone: "hold", word: "Key missing" };
  return { tone: "hold", word: "Not listed" };
}

function groupByProvider(models: ModelCatalogEntry[]): [string, ModelCatalogEntry[]][] {
  const map = new Map<string, ModelCatalogEntry[]>();
  for (const m of models) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
  return [...map.entries()];
}

function SlotRow({ slot, catalog, section }: { slot: ModelSlotName; catalog: ModelCatalogResponse; section: Partial<Record<ModelSlotName, ModelSlot>> }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const settings = useModelsStore((s) => s.settings);
  const current = section[slot];
  const state = slotState(catalog, slot);
  const entry = findEntry(catalog, current?.model);
  const levels: ThinkingLevel[] = entry ? entry.supportedLevels : [...THINKING_ORDER];
  const level = current?.thinkingLevel ?? (entry ? defaultLevelFor(entry.supportedLevels) : "off");
  const options = modelsForSlot(catalog, slot);
  const word = stateWord(state);

  const save = async (next: ModelSlot | null) => {
    if (!settings) return;
    const models: Partial<Record<ModelSlotName, ModelSlot>> = {};
    for (const name of SLOT_ORDER) {
      const slotValue = name === slot ? next : section[name];
      if (slotValue?.model) models[name] = slotValue;
    }
    setBusy(true);
    try {
      const saved = await learnModels.saveModels(models);
      const nextSettings = { ...settings };
      if (Object.keys(saved).length > 0) nextSettings.models = saved;
      else delete nextSettings.models;
      applySettings(nextSettings);
      await reloadCatalogue();
      setNotice(null);
    } catch (e) {
      setNotice(noticeFor(e));
    } finally {
      setBusy(false);
    }
  };

  const onModel = (value: string) => {
    const ref = parseModelValue(value);
    if (!ref) return void save(null);
    const picked = findEntry(catalog, ref);
    const wanted = current?.thinkingLevel;
    const thinkingLevel = picked ? (wanted ? nearestLevel(picked.supportedLevels, wanted) : defaultLevelFor(picked.supportedLevels)) : wanted;
    void save({ ...current, model: ref, ...(thinkingLevel ? { thinkingLevel } : {}) });
  };

  const stale = current?.model && !entry ? current.model : null;
  const selectId = `slot-${slot}`;

  return (
    <SettingRow label={SLOT_TEXT[slot].label} hint={SLOT_TEXT[slot].hint}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          id={selectId}
          aria-label={`${SLOT_TEXT[slot].label}, model`}
          className={`${SELECT} w-64 max-w-full`}
          disabled={busy}
          value={current?.model ? modelValue(current.model) : ""}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="">Choose a model</option>
          {stale ? <option value={modelValue(stale)}>{`${stale.id} (key missing)`}</option> : null}
          {groupByProvider(options).map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((m) => (
                <option key={m.id} value={modelValue(m)}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          aria-label={`${SLOT_TEXT[slot].label}, thinking level`}
          className={`${SELECT} w-32`}
          disabled={busy || !current?.model}
          value={level}
          onChange={(e) => current?.model && void save({ ...current, thinkingLevel: e.target.value as ThinkingLevel })}
        >
          {levels.map((l) => (
            <option key={l} value={l}>
              {LEVEL_TEXT[l]}
            </option>
          ))}
        </select>
        <select
          aria-label={`${SLOT_TEXT[slot].label}, prompt cache`}
          className={`${SELECT} w-40`}
          disabled={busy || !current?.model}
          value={current?.cacheRetention ?? ""}
          onChange={(e) => {
            if (!current?.model) return;
            const next = { ...current };
            if (e.target.value) next.cacheRetention = e.target.value as "none" | "short" | "long";
            else delete next.cacheRetention;
            void save(next);
          }}
        >
          {CACHE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-1.5 text-small text-ink-soft">
          <StatusDot tone={word.tone} />
          {word.word}
        </span>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
    </SettingRow>
  );
}

/** The three slots with a model menu, a thinking level and a cache choice for each. */
export function SlotPickers() {
  const catalog = useModelsStore((s) => s.catalog);
  const settings = useModelsStore((s) => s.settings);
  if (!catalog) return null;
  const section = settings?.models ?? {};
  return (
    <div className="divide-y divide-rule">
      {SLOT_ORDER.map((slot) => (
        <SlotRow key={slot} slot={slot} catalog={catalog} section={section} />
      ))}
    </div>
  );
}

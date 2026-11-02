// Typed calls to routes 13 to 15 (prompt fragments and their overrides) and the pure helpers that the Learning section of
// Settings uses. An override needs both its file and its switch in settings agent.prompts["<key>.md"], so saving a text
// writes the file first and then sets the switch, and removing it clears both.
import type { LearnSettings, PromptEntry, PromptList } from "@shared/learn/models";
import { learnRequest } from "./http";
import { learnModels } from "./models";

const path = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export const learnPrompts = {
  list: () => learnRequest<PromptList>("GET", "prompts"),
  write: (key: string, text: string) => learnRequest<{ ok: true; ignored?: boolean }>("PUT", `prompts/${path(key)}`, { text }),
  remove: (key: string) => learnRequest<{ ok: true; deleted?: boolean; switchCleared?: boolean; ignored?: boolean }>("DELETE", `prompts/${path(key)}`),
};

export const switchKey = (key: string) => `${key}.md`;

/** The settings record with one prompt switch turned on or off. Off removes the key, and the other switches are kept. */
export function withPromptSwitch(settings: LearnSettings, key: string, on: boolean): LearnSettings {
  const prompts = { ...(settings.agent?.prompts ?? {}) };
  if (on) prompts[switchKey(key)] = true;
  else delete prompts[switchKey(key)];
  return { ...settings, agent: { ...settings.agent, prompts } };
}

export interface PromptSections {
  teacher: PromptEntry[];
  prober: PromptEntry[];
  practice: PromptEntry[];
  /** shared fragments and the base, once each, in the order of assembly */
  shared: PromptEntry[];
}

/** Splits the three lists into the agent sections and one Shared section that holds each shared key once. */
export function sectionedPrompts(list: PromptList): PromptSections {
  const seen = new Set<string>();
  const shared: PromptEntry[] = [];
  for (const entry of [...list.teacher, ...list.prober, ...list.practice]) {
    if (!entry.shared || seen.has(entry.key)) continue;
    seen.add(entry.key);
    shared.push(entry);
  }
  const own = (entries: PromptEntry[]) => entries.filter((e) => !e.shared);
  return { teacher: own(list.teacher), prober: own(list.prober), practice: own(list.practice), shared };
}

/** Saves an override text and puts it to work: the file first, then the switch. */
export async function saveOverride(key: string, text: string): Promise<LearnSettings> {
  await learnPrompts.write(key, text);
  return learnModels.saveSettings(withPromptSwitch(await learnModels.settings(), key, true));
}

/** Removes an override. The server clears the switch with the file, and the record is read again so the window agrees. */
export async function removeOverride(key: string): Promise<LearnSettings> {
  await learnPrompts.remove(key);
  const settings = await learnModels.settings();
  return settings.agent?.prompts?.[switchKey(key)] ? learnModels.saveSettings(withPromptSwitch(settings, key, false)) : settings;
}

/** Turns an override on or off without touching its text. */
export async function setOverrideOn(key: string, on: boolean): Promise<LearnSettings> {
  return learnModels.saveSettings(withPromptSwitch(await learnModels.settings(), key, on));
}

export const AGENT_WORDS: Record<keyof Omit<PromptSections, "shared">, string> = { teacher: "Teaching agent", prober: "Probing agent", practice: "Practice agent" };

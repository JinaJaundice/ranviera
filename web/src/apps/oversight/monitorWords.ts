// Wording for the Monitoring and Instructions sections: drift entries, agreement and mapping names without internal identifiers.
import { longDate, plural } from "./model";
import { modelName, modelShort } from "./wording";

/** An identifier of the graph such as instr:alert-triage-compare-names-v2 in words, using the label of the node where it is known. */
export function plainIds(text: string, labelOf: (id: string) => string | undefined): string {
  return text.replace(/\b(instr|model|dagent|run|map|typology|evid|obligation):[A-Za-z0-9._#-]+?(?=[.,;)\s]|$)/g, (id) => {
    const found = labelOf(id);
    if (found) return found;
    if (id.startsWith("model:")) return modelName(id);
    return id.replace(/^[a-z]+:/, "").replace(/[-_]+/g, " ");
  });
}

/** A drift entry of the monitoring report in plain words. */
export function driftText(detail: string, since: string, labelOf: (id: string) => string | undefined): string {
  const m = /override rate changed from (\d+) to (\d+) in thousandths of reviewed decisions \((\d+) and (\d+) reviews\)/.exec(detail);
  if (m) {
    return `The override rate was ${m[1]} in every 1,000 reviewed decisions before ${longDate(since)} (${plural(Number(m[3]), "review")}) and ${m[2]} in every 1,000 after it (${plural(Number(m[4]), "review")}). The bank set no threshold for the change.`;
  }
  return plainIds(detail, labelOf).replace(/ in thousandths/g, " in 1,000");
}

export const DRIFT_KIND: Record<string, string> = { instruction: "Instructions", model: "Model version", snapshot: "Retrieval data", override: "Override rate" };

/** How many sampled runs agreed with the agent, in words. */
export function agreementWords(a: { sampled: number; agree: number }): string {
  return a.sampled === 0 ? "No runs sampled" : `${a.agree} of ${plural(a.sampled, "sampled run")} agreed (${Math.round((a.agree / a.sampled) * 100)}%)`;
}

/** The count of overridden decisions behind an override rate. */
export function overrideCounts(perMille: number | null, reviewed: number): string | null {
  if (perMille === null || reviewed === 0) return null;
  return `${plural(Math.round((perMille * reviewed) / 1000), "override")} in ${plural(reviewed, "reviewed decision")}`;
}

/** The period of a monitoring report in words. */
export function periodText(from: string | null, to: string | null): string {
  if (!from && !to) return "The figures cover every decision recorded.";
  return `The figures cover decisions ${from ? `from ${longDate(from)}` : "from the first recorded"}${to ? ` to ${longDate(to)}` : " to the last recorded"}.`;
}

/** A mapping identifier such as map:20260922-005 in words. */
export function mappingName(id: string): string {
  const m = /^map:(\d{4})(\d{2})(\d{2})-(\d+)$/.exec(id);
  return m ? `Mapping ${Number(m[4])} of ${longDate(`${m[1]}-${m[2]}-${m[3]}`)}` : id;
}

const ID_WORDS = (id: string): string => id.replace(/^[a-z]+:/, "").replace(/[-_]+/g, " ");

/** A drift entry as a sentence and, for a change of instruction versions, a list of the versions that replaced earlier ones. */
export function driftView(detail: string, since: string, labelOf: (id: string) => string | undefined): { text: string; items: string[] } {
  const instr = /^The instruction versions in context changed: (.+)\.$/.exec(detail);
  if (instr) {
    const added: string[] = [];
    const removed: string[] = [];
    const rehashed: string[] = [];
    for (const part of instr[1].split("; ")) {
      const list = (prefix: string) => part.slice(prefix.length).split(", ");
      if (part.startsWith("added ")) added.push(...list("added "));
      else if (part.startsWith("removed ")) removed.push(...list("removed "));
      else if (part.startsWith("the hash changed for ")) rehashed.push(...list("the hash changed for "));
    }
    if (added.length + removed.length + rehashed.length > 0) {
      const name = (id: string) => labelOf(id) ?? ID_WORDS(id);
      const base = (id: string) => id.replace(/-v\d+$/, "");
      const items = added.map((a) => {
        const old = removed.find((r) => base(r) === base(a));
        return old ? `${name(old)} was replaced by ${name(a)}` : `${name(a)} was added`;
      });
      const only = removed.filter((r) => !added.some((a) => base(a) === base(r))).map((r) => `${name(r)} was removed`);
      const text = rehashed.map((r) => `The text of ${name(r)} changed`);
      const count = added.length + only.length + rehashed.length;
      return { text: `From ${longDate(since)}, ${plural(count, "instruction version")} in the context of the agent changed.`, items: [...items, ...only, ...text] };
    }
  }
  const model = /^The model version changed from (model:\S+) to (model:\S+)\.$/.exec(detail);
  if (model) {
    const num = (id: string) => Number(/-(\d+)-\d{4}-\d{2}$/.exec(id)?.[1] ?? NaN);
    const family = (id: string) => /^model:([a-z]+-[a-z]+)-\d+-/.exec(id)?.[1];
    const back = num(model[2]) < num(model[1]);
    const from = modelShort(labelOf(model[1]) ?? model[1]);
    const to = family(model[1]) && family(model[1]) === family(model[2]) ? `version ${num(model[2])}` : modelShort(labelOf(model[2]) ?? model[2]);
    return { text: `The model changed from ${from} to ${to} on ${longDate(since)}.${back ? " This returns the agent to an earlier model version." : ""}`, items: [] };
  }
  return { text: driftText(detail, since, labelOf), items: [] };
}

/** Why an override rate rests on a small base, or null where the base is large enough to read. */
export function smallBaseNote(perMille: number | null, reviewed: number): string | null {
  if (perMille === null || reviewed === 0 || reviewed >= 100) return null;
  return `The rate rests on ${plural(reviewed, "reviewed decision")}, so one more override would move it by about ${Math.round(1000 / reviewed)} in every 1,000. Read the rate with care.`;
}

/** The first letter in capitals. */
export const upperFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

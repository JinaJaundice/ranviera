// The extractor stage. A small agent on the cheap slot reads one chunk or one batch of messages and finishes with one
// validated call of submit_findings. A call that breaks a rule returns to the model as a readable error, and the
// model may correct it within four turns (docs/CONTRACTS.md, "Tool vocabulary" and "Limits").
import { Type } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../../../shared/learn/sessions.ts";
import type { LedgerChain, MergedNode } from "../knowledge/ledger.ts";
import { healArray, healProperties } from "./heal.ts";
import { extractorPrompt } from "./prompts/index.ts";
import { runSubmitAgent, type AgentEngine } from "./submit-agent.ts";
import { EXTRACTOR_TURNS, type AnyTool, type Finding, type FindingChain, type Findings, type SourceShape } from "./types.ts";

const PROPOSITION = Type.Object({
  id: Type.String({ description: "A short local label such as p1, used only inside this call." }),
  name: Type.String({ description: "A glossary style label of a few words." }),
  statement: Type.String({ description: "One true idea that stands alone." }),
  aliases: Type.Optional(Type.Array(Type.String(), { description: "Other wordings of the idea, copied from the source." })),
  quote: Type.Optional(Type.String({ description: "A passage copied word for word from the source, at most 280 characters." })),
  messageId: Type.Optional(Type.String({ description: "For a transcript or a session, the id in square brackets of the supporting message." })),
});

const CHAIN = Type.Object({
  premises: Type.Array(Type.String(), { minItems: 1, description: "Proposition ids that are used together." }),
  conclusion: Type.String({ description: "The proposition id that follows." }),
});

const PARAMETERS = Type.Object({
  propositions: Type.Array(PROPOSITION, { description: "Every proposition of the passage. An empty list when there is none." }),
  chains: Type.Array(CHAIN, { description: "Every argument. An empty list when there is none." }),
});

export interface SubmitContext {
  shape: SourceShape;
  /** the message ids of the current passage, required for a transcript or a session */
  anchors?: ReadonlySet<string>;
  /** ids of propositions that are already in the graph */
  existingIds: ReadonlySet<string>;
}

export type FindingsCheck = { ok: true; findings: Findings } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const MAX_ERRORS = 8;
const MAX_LISTED_IDS = 12;

/** Checks a submission against the rules of the contracts. The rules run in code and are returned to the model in words. */
export function checkFindings(raw: unknown, ctx: SubmitContext): FindingsCheck {
  const errors: string[] = [];
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };
  if (!isRecord(raw) || !Array.isArray(raw.propositions) || !Array.isArray(raw.chains)) {
    return { ok: false, errors: ["The call needs both fields, propositions and chains. Use an empty list for a field that has no entries."] };
  }
  const anchored = ctx.shape !== "notes";
  const propositions: Finding[] = [];
  raw.propositions.forEach((item, i) => {
    const at = `Proposition ${i + 1}`;
    if (!isRecord(item)) return fail(`${at} must be an object with id, name and statement.`);
    const id = text(item.id);
    const name = text(item.name);
    const statement = text(item.statement);
    if (!id) return fail(`${at} has no id. Give it a short local label such as p1.`);
    if (!name) return fail(`${at} (${id}) has no name.`);
    if (!statement) return fail(`${at} (${id}) has no statement.`);
    const aliases = healArray(item.aliases ?? []);
    if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === "string")) return fail(`The aliases of ${id} must be a list of texts.`);
    const found: Finding = { id, name, statement, aliases: aliases.map((a: string) => a.trim()).filter((a: string) => a !== "") };
    const quote = text(item.quote);
    if (quote) found.quote = quote;
    if (anchored) {
      const messageId = text(item.messageId);
      if (!messageId) return fail(`The proposition ${id} needs a messageId, which is the id in square brackets of the message that supports it.`);
      if (!ctx.anchors?.has(messageId)) {
        const valid = [...(ctx.anchors ?? [])].slice(0, MAX_LISTED_IDS).join(", ");
        return fail(`The messageId ${messageId} of ${id} is not in this passage. Use one of: ${valid}.`);
      }
      found.messageId = messageId;
    }
    propositions.push(found);
  });
  const local = new Set(propositions.map((p) => p.id));
  const known = (id: string) => local.has(id) || ctx.existingIds.has(id);
  const chains: FindingChain[] = [];
  raw.chains.forEach((item, i) => {
    const at = `Chain ${i + 1}`;
    if (!isRecord(item)) return fail(`${at} must be an object with premises and conclusion.`);
    const premises = healArray(item.premises);
    const conclusion = text(item.conclusion);
    if (!Array.isArray(premises) || premises.length === 0 || !premises.every((p) => typeof p === "string" && p.trim() !== "")) {
      return fail(`${at} needs a list of at least one premise id.`);
    }
    if (!conclusion) return fail(`${at} has no conclusion.`);
    const ids: string[] = premises.map((p: string) => p.trim());
    for (const id of [...ids, conclusion]) {
      if (!known(id)) return fail(`${at} names ${id}, which is neither a proposition of this call nor a proposition that is already in the graph.`);
    }
    if (ids.includes(conclusion)) return fail(`${at} has its conclusion ${conclusion} among its premises.`);
    chains.push({ premises: ids, conclusion });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, findings: { propositions, chains } };
}

/** Heals the encodings that weak models produce before the schema is checked. */
export function healSubmission(args: unknown): unknown {
  const healed = healProperties(args, ["propositions", "chains"]);
  if (!isRecord(healed)) return healed;
  const out: Record<string, unknown> = { ...healed };
  if (Array.isArray(out.propositions)) out.propositions = out.propositions.map((p) => healProperties(p, ["aliases"]));
  if (Array.isArray(out.chains)) out.chains = out.chains.map((c) => healProperties(c, ["premises"]));
  return out;
}

export interface ExtractorRun {
  engine: AgentEngine;
  ctx: SubmitContext;
  /** the earlier work of the same source, or an empty string */
  digest: string;
  /** what the model reads: the labelled chunk or the labelled messages */
  view: string;
  signal?: AbortSignal;
  onUsage?: (usage: CallUsage) => void;
}

export interface ExtractorOutcome {
  findings: Findings | null;
  turns: number;
  /** the last rule violation, for the report of a chunk that did not finish */
  lastError: string | null;
}

/** One line for each proposition of the source and one for each argument, with identifiers in full. Empty when the source owns nothing. */
export function buildDigest(sourceId: string, nodes: MergedNode[], chains: LedgerChain[]): string {
  const own = nodes.filter((n) => n.provenance.some((p) => p.chatId === sourceId));
  if (own.length === 0) return "";
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  const label = (id: string) => `${id} (${name.get(id) ?? id})`;
  const lines = ["Record of earlier work on this source. Copy these ids exactly when a new idea builds on one of them.", "", "Propositions:"];
  for (const n of own) lines.push(`- ${n.id} | ${n.name} | ${n.statement}`);
  const ownChains = chains.filter((c) => c.provenance.some((p) => p.chatId === sourceId));
  if (ownChains.length > 0) {
    lines.push("", "Arguments:");
    for (const c of ownChains) lines.push(`- ${c.premises.map(label).join(" + ")} => ${label(c.conclusion)}`);
  }
  return lines.join("\n");
}

/** Runs the extractor on one passage. The result is null when the model used its turns without a clean submission. */
export async function runExtractor(run: ExtractorRun): Promise<ExtractorOutcome> {
  let findings: Findings | null = null;
  let lastError: string | null = null;
  const tool: AnyTool = {
    name: "submit_findings",
    label: "Submit findings",
    description: "Submits the propositions and the arguments of the passage. Call it once with both fields complete.",
    parameters: PARAMETERS,
    prepareArguments: (args) => healSubmission(args) as never,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const checked = checkFindings(params, run.ctx);
      if (!checked.ok) {
        lastError = checked.errors.join(" ");
        throw new Error(`The submission was not accepted and nothing was recorded. ${lastError} Correct these points and call submit_findings again with the complete answer.`);
      }
      findings = checked.findings;
      const n = checked.findings.propositions.length;
      const m = checked.findings.chains.length;
      return { content: [{ type: "text", text: `Recorded ${n} ${n === 1 ? "proposition" : "propositions"} and ${m} ${m === 1 ? "argument" : "arguments"}.` }], details: undefined };
    },
  };
  const prompt = run.digest ? `${run.digest}\n\n---\n\n${run.view}` : run.view;
  const outcome = await runSubmitAgent(run.engine, {
    systemPrompt: extractorPrompt(run.ctx.shape),
    prompt,
    tools: [tool],
    maxTurns: EXTRACTOR_TURNS,
    done: () => findings !== null,
    nudge: "Finish by calling submit_findings with both fields. Do not answer in prose.",
    signal: run.signal,
    onUsage: run.onUsage,
  });
  return { findings, turns: outcome.turns, lastError };
}

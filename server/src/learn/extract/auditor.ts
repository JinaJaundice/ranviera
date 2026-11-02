// The auditor stage. A small agent on the cheap slot decides which new propositions repeat a proposition that the
// graph already holds. It sees the new propositions and ranked candidates, and it never sees the source text or the
// arguments. Its only output is identity links (docs/LEARNING.md, "The extraction pipeline").
import { Type } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../../../shared/learn/sessions.ts";
import { CandidateIndex, CursorBook, type Candidate, type CandidatePage } from "../knowledge/candidates.ts";
import { KnowledgeError } from "../knowledge/errors.ts";
import type { MergedNode } from "../knowledge/ledger.ts";
import { healArray, healProperties } from "./heal.ts";
import { auditorPrompt } from "./prompts/index.ts";
import { runSubmitAgent, type AgentEngine } from "./submit-agent.ts";
import { AUDITOR_TURNS, type AnyTool, type Finding } from "./types.ts";

const FIND = Type.Object({
  propositions: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ description: "The id of a new proposition." }),
        hints: Type.Optional(Type.Array(Type.String(), { description: "Extra words that may appear in a matching proposition." })),
      }),
      { description: "New propositions to search for. Do not combine with a cursor." },
    ),
  ),
  cursor: Type.Optional(Type.String({ description: "A cursor from an earlier answer, which continues the same search." })),
});

const REVIEW = Type.Object({
  links: Type.Array(
    Type.Object({
      id: Type.String({ description: "The id of a new proposition." }),
      linkTo: Type.String({ description: "The id of the existing proposition that it repeats." }),
    }),
    { description: "One entry for each new proposition that repeats an existing one. An empty list when none does." },
  ),
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface FindingResult {
  id: string;
  candidates: string[];
  offset: number;
  total: number;
  hasMore: boolean;
  cursor: string | null;
  note?: string;
}

/** The candidates of a call, with each body listed once even when several propositions share it. */
function render(rows: { id: string; page: CandidatePage; cursor: string | null }[]): string {
  const bodies: Record<string, { name: string; statement: string; matchedAliases: string[]; sources: string[] }> = {};
  const findings: FindingResult[] = rows.map(({ id, page, cursor }) => {
    for (const c of page.candidates as Candidate[]) {
      bodies[c.id] ??= { name: c.name, statement: c.statement, matchedAliases: c.matchedAliases, sources: c.sessions };
    }
    const row: FindingResult = {
      id,
      candidates: page.candidates.map((c) => c.id),
      offset: page.offset,
      total: page.total,
      hasMore: page.hasMore,
      cursor,
    };
    if (page.total === 0) row.note = "No existing proposition shares a word with this one.";
    else if (page.candidates.length === 0) row.note = "There are no more candidates for this search.";
    return row;
  });
  return JSON.stringify({ candidates: bodies, findings });
}

export interface AuditorRun {
  engine: AgentEngine;
  findings: Finding[];
  /** the propositions that the model is allowed to see and to link to */
  nodes: MergedNode[];
  signal?: AbortSignal;
  onUsage?: (usage: CallUsage) => void;
}

export interface AuditorOutcome {
  /** local finding id to the id of the existing proposition that it repeats */
  links: Map<string, string>;
  /** false when the stage had nothing to compare and made no model call */
  ran: boolean;
  /** true when the model submitted a review */
  done: boolean;
}

/** Runs the auditor. With no findings or an empty graph there is nothing to compare, so no model call is made. */
export async function runAuditor(run: AuditorRun): Promise<AuditorOutcome> {
  const links = new Map<string, string>();
  if (run.findings.length === 0 || run.nodes.length === 0) return { links, ran: false, done: true };

  const index = new CandidateIndex(run.nodes);
  const book = new CursorBook(index);
  const byId = new Map<string, Finding>();
  for (const f of run.findings) if (!byId.has(f.id)) byId.set(f.id, f);
  const allowed = new Set(run.nodes.map((n) => n.id));
  const cursorOwner = new Map<string, string>();
  const state = { submitted: false };

  const search = (f: Finding, hints?: string[]) => {
    const { page, nextCursor } = book.first({ name: f.name, statement: f.statement, aliases: f.aliases, hints });
    if (nextCursor) cursorOwner.set(nextCursor, f.id);
    return { id: f.id, page, cursor: nextCursor };
  };

  const find: AnyTool = {
    name: "find_candidates",
    label: "Find candidates",
    description:
      "Lists existing propositions that may repeat the new ones, five for each page. Give proposition ids with optional hint phrases, or a cursor from an earlier answer, and never both.",
    parameters: FIND,
    prepareArguments: (args) => {
      const healed = healProperties(args, ["propositions"]);
      if (isRecord(healed) && Array.isArray(healed.propositions)) {
        return { ...healed, propositions: healed.propositions.map((p) => healProperties(p, ["hints"])) } as never;
      }
      return healed as never;
    },
    executionMode: "sequential",
    execute: async (_id, params) => {
      const p = params as { propositions?: { id: string; hints?: string[] }[]; cursor?: string };
      const hasList = p.propositions !== undefined;
      const hasCursor = p.cursor !== undefined && p.cursor !== "";
      if (hasList === hasCursor) throw new Error("Give either propositions or a cursor, and not both.");
      if (hasCursor) {
        let result: { page: CandidatePage; nextCursor: string | null };
        try {
          result = book.next(p.cursor as string);
        } catch (e) {
          if (e instanceof KnowledgeError) throw new Error(e.message, { cause: e });
          throw e;
        }
        const owner = cursorOwner.get(p.cursor as string) ?? "";
        if (result.nextCursor) cursorOwner.set(result.nextCursor, owner);
        return { content: [{ type: "text", text: render([{ id: owner, page: result.page, cursor: result.nextCursor }]) }], details: undefined };
      }
      const list = p.propositions ?? [];
      if (list.length === 0) throw new Error("The list of propositions is empty. Name at least one new proposition.");
      const seen = new Set<string>();
      for (const item of list) {
        if (!byId.has(item.id)) throw new Error(`The id ${item.id} is not a new proposition. The new propositions are ${[...byId.keys()].join(", ")}.`);
        if (seen.has(item.id)) throw new Error(`The id ${item.id} appears more than once in the list.`);
        seen.add(item.id);
        if (item.hints !== undefined && (!Array.isArray(item.hints) || !item.hints.every((h) => typeof h === "string"))) {
          throw new Error(`The hints of ${item.id} must be a list of texts.`);
        }
      }
      const rows = list.map((item) => search(byId.get(item.id) as Finding, item.hints));
      return { content: [{ type: "text", text: render(rows) }], details: undefined };
    },
  };

  const review: AnyTool = {
    name: "submit_review",
    label: "Submit review",
    description: "Submits the identity links. Call it once. A new proposition that has no link is added to the graph as new.",
    parameters: REVIEW,
    prepareArguments: (args) => healProperties(args, ["links"]) as never,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const raw = healArray((params as { links?: unknown }).links);
      if (!Array.isArray(raw)) throw new Error("The field links must be a list. Use an empty list when no proposition matches.");
      const next = new Map<string, string>();
      const problems: string[] = [];
      for (const item of raw) {
        const id = isRecord(item) && typeof item.id === "string" ? item.id.trim() : "";
        const to = isRecord(item) && typeof item.linkTo === "string" ? item.linkTo.trim() : "";
        if (!byId.has(id)) problems.push(`The id ${id || "(empty)"} is not a new proposition.`);
        else if (!allowed.has(to)) problems.push(`The proposition ${to || "(empty)"} that ${id} links to was not offered. Link only to ids from the candidates.`);
        else if (!next.has(id)) next.set(id, to);
      }
      if (problems.length > 0) throw new Error(`The review was not accepted. ${problems.slice(0, 8).join(" ")} Correct these links and call submit_review again.`);
      for (const [k, v] of next) links.set(k, v);
      state.submitted = true;
      return { content: [{ type: "text", text: `Recorded ${next.size} ${next.size === 1 ? "link" : "links"}.` }], details: undefined };
    },
  };

  const first = run.findings.filter((f, i) => run.findings.findIndex((g) => g.id === f.id) === i).map((f) => search(f));
  const prompt = [
    "New propositions, with the first page of existing candidates for each.",
    "",
    JSON.stringify({
      propositions: [...byId.values()].map((f) => ({ id: f.id, name: f.name, statement: f.statement, aliases: f.aliases })),
    }),
    "",
    render(first),
  ].join("\n");
  await runSubmitAgent(run.engine, {
    systemPrompt: auditorPrompt(),
    prompt,
    tools: [find, review],
    maxTurns: AUDITOR_TURNS,
    done: () => state.submitted,
    nudge: "Finish by calling submit_review with your links. Do not answer in prose.",
    signal: run.signal,
    onUsage: run.onUsage,
  });
  return { links, ran: true, done: state.submitted };
}

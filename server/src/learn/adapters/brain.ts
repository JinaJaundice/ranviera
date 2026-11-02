// The learning events of the brain view: learn.turn, learn.answer and learn.extract as CortexEvents, with the weights
// and node rules of docs/CONTRACTS.md ("Turn stream, stream messages and event kinds"). A node id is the graph id that
// kg/cortex_kg/harvest/knowledge.py gives: claim:<hex> for a proposition n_<hex>, and learnsession:<slug> for a session,
// where the slug is the session id in lower case with each underscore replaced by a hyphen. An event holds identifiers
// only and never the text of a learner.
import type { CortexEvent } from "../../../../shared/types.ts";
import type { SessionRecord } from "../../../../shared/learn/index.ts";
import { makeEvent } from "../../events.ts";
import type { ExtractFire } from "../extract/index.ts";
import type { LearnEvents } from "../method/deps.ts";

/** Where the events go. The event hub satisfies it. */
export interface EventSink {
  append(event: CortexEvent): void;
}

export const TURN_WEIGHT = 0.3;
export const ANSWER_WEIGHT = 0.6;
export const EXTRACT_WEIGHT = 0.2;
export const EXTRACT_NODE_LIMIT = 20;

export const claimNodeId = (learnId: string): string | null => (/^n_[0-9a-f]+$/.test(learnId) ? `claim:${learnId.slice(2)}` : null);
export const sessionNodeId = (sessionId: string): string => `learnsession:${sessionId.toLowerCase().replace(/_/g, "-")}`;

const unique = (ids: (string | null)[]): string[] => [...new Set(ids.filter((x): x is string => x !== null))];

/** The propositions of the graph context marker of a session. */
function contextClaims(record: SessionRecord): string[] {
  const out: (string | null)[] = [];
  for (const m of record.messages) {
    if (m.role !== "custom" || m.customType !== "graph-context") continue;
    const list = (m.details as { propositions?: { id?: unknown }[] } | undefined)?.propositions;
    for (const p of Array.isArray(list) ? list : []) if (typeof p?.id === "string") out.push(claimNodeId(p.id));
  }
  return unique(out);
}

export interface BrainEvents {
  /** After a turn settles. */
  turn(record: SessionRecord): void;
  answer: LearnEvents["answer"];
  extract(fire: ExtractFire): void;
}

export function createBrainEvents(sink: EventSink | undefined, log: (line: string) => void = () => {}): BrainEvents {
  const send = (event: CortexEvent): void => {
    if (!sink) return;
    try {
      sink.append(event);
    } catch (e) {
      log(`A learning event could not be written: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    turn(record) {
      const turns = record.turns?.length ?? 0;
      send(
        makeEvent({
          session: `learn:${record.id}`,
          source: "cortex",
          kind: "learn.turn",
          nodes: [sessionNodeId(record.id), ...contextClaims(record)],
          weight: TURN_WEIGHT,
          label: "Learning turn",
          key: `turn:${record.id}:${turns}:${record.messages.length}`,
          meta: { turns, messages: record.messages.length },
        }),
      );
    },
    answer(e) {
      send(
        makeEvent({
          session: `learn:${e.session}`,
          source: "cortex",
          kind: "learn.answer",
          nodes: unique(e.target.map(claimNodeId)),
          weight: ANSWER_WEIGHT,
          label: "Answer graded",
          key: e.key,
          meta: { tool: e.tool, correct: e.correct },
        }),
      );
    },
    extract(fire) {
      send(
        makeEvent({
          session: `learn:${fire.sourceId}`,
          source: "cortex",
          kind: "learn.extract",
          nodes: unique(fire.nodeIds.map(claimNodeId)).slice(0, EXTRACT_NODE_LIMIT),
          weight: EXTRACT_WEIGHT,
          label: "Knowledge extracted",
          key: fire.key,
          meta: { sourceId: fire.sourceId },
        }),
      );
    },
  };
}

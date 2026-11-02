// The KnowledgeReader, the TargetResolver and the KnowledgeDeletion of the runtime and the method, over the knowledge
// service and the extraction service. A hosted model sees a proposition only when none of its sources is a
// client-confidential root without a recorded consent (docs/CONTRACTS.md, "Sensitivity gate and model policy").
import type { CoverageBlock, ProviderClass, SessionRecord } from "../../../../shared/learn/index.ts";
import type { GraphSnapshot, PropositionView } from "../../../../shared/learn/knowledge.ts";
import type { LearnSettings } from "../../../../shared/learn/models.ts";
import type { Sensitivity } from "../../../../shared/learn/sources.ts";
import { chunkBudget } from "../extract/chunk.ts";
import { coverageBlock, sessionView } from "../knowledge/coverage.ts";
import type { Knowledge } from "../knowledge/index.ts";
import type { KnowledgeDeletion, KnowledgeReader } from "../runtime/deps.ts";
import type { TargetResolver } from "../method/deps.ts";
import type { ExtractService } from "../extract/index.ts";
import type { SourcesService } from "../sources/index.ts";
import type { SessionSensitivity } from "./sensitivity.ts";

export interface ReaderDeps {
  knowledge: Knowledge;
  sources: SourcesService;
  settings: () => LearnSettings;
  sessionSensitivity: SessionSensitivity;
  /** the session of an identifier, or nothing */
  session?: (id: string) => SessionRecord | null | undefined;
  /** true while an extraction of the session is registered */
  extracting: (sessionId: string) => boolean;
}

const EMPTY: Pick<GraphSnapshot, "propositions" | "chains" | "sessions" | "fileSources"> = { propositions: [], chains: [], sessions: {}, fileSources: {} };

/** A proposition id as the graph context may name it: the learning id or the graph node id. */
export function learnId(raw: string): string {
  return raw.startsWith("claim:") ? `n_${raw.slice("claim:".length)}` : raw;
}

export function createKnowledgeReader(deps: ReaderDeps): KnowledgeReader & { visible(p: PropositionView, cls: ProviderClass): boolean } {
  const snapshot = (): typeof EMPTY => {
    try {
      return deps.knowledge.snapshot();
    } catch {
      // an unreadable or newer folder shows nothing and leaves the refusal to the routes of the knowledge area
      return EMPTY;
    }
  };

  function visible(p: PropositionView, cls: ProviderClass): boolean {
    if (cls !== "hosted") return true;
    for (const point of p.provenance) {
      const hit = deps.sources.file(point.chatId);
      if (hit) {
        if (hit.root.sensitivity === "client-confidential" && !hit.root.hostedConsentAt) return false;
        continue;
      }
      // a session takes the sensitivity of its own record, and an identifier that is neither fails closed
      const origin = deps.session?.(point.chatId);
      if (!origin) return false;
      const gate = deps.sessionSensitivity.of(origin);
      if (gate.sensitivity === "client-confidential" && !gate.consented) return false;
    }
    return true;
  }

  const labelOf = (snap: typeof EMPTY, id: string): string => snap.sessions[id] ?? snap.fileSources[id] ?? id;

  return {
    visible,
    listSources(cls) {
      const snap = snapshot();
      const counts = new Map<string, { n: number; last: string | null }>();
      for (const p of snap.propositions) {
        if (!visible(p, cls)) continue;
        for (const id of new Set(p.provenance.map((x) => x.chatId))) {
          const cur = counts.get(id) ?? { n: 0, last: null };
          cur.n += 1;
          if (!cur.last || p.createdAt > cur.last) cur.last = p.createdAt;
          counts.set(id, cur);
        }
      }
      const out = [];
      for (const [id, label] of Object.entries(snap.sessions)) out.push({ id, label, kind: "chat" as const, propositionCount: counts.get(id)?.n ?? 0, lastAt: counts.get(id)?.last ?? null });
      for (const [id, label] of Object.entries(snap.fileSources)) {
        const hit = deps.sources.file(id);
        if (cls === "hosted" && hit && hit.root.sensitivity === "client-confidential" && !hit.root.hostedConsentAt) continue;
        out.push({ id, label, kind: "notes" as const, propositionCount: counts.get(id)?.n ?? 0, lastAt: counts.get(id)?.last ?? null });
      }
      return out;
    },
    listPropositions(sourceOrSessionId, cls) {
      return snapshot()
        .propositions.filter((p) => visible(p, cls) && p.provenance.some((x) => x.chatId === sourceOrSessionId))
        .map((p) => ({ id: p.id, name: p.name, held: p.metrics.held, support: p.metrics.support }));
    },
    getProposition(id, cls) {
      const snap = snapshot();
      const p = snap.propositions.find((x) => x.id === learnId(id));
      if (!p || !visible(p, cls)) return null;
      const seen = [...new Set(p.provenance.map((x) => x.chatId))];
      return { id: p.id, name: p.name, statement: p.statement, aliases: p.aliases, sources: seen.map((s) => ({ id: s, label: labelOf(snap, s) })) };
    },
    contextFor(ids, cls) {
      const snap = snapshot();
      const wanted = new Set(ids.map(learnId));
      const picked = snap.propositions.filter((p) => wanted.has(p.id) && visible(p, cls));
      const inside = new Set(picked.map((p) => p.id));
      const chains = snap.chains.filter((c) => inside.has(c.conclusion) && c.premises.every((x) => inside.has(x)));
      return {
        propositions: picked.map((p) => ({ id: p.id, name: p.name, statement: p.statement })),
        chains: chains.map((c) => ({ id: c.id, premises: c.premises, conclusion: c.conclusion })),
      };
    },
    coverageOf(session: SessionRecord): CoverageBlock {
      const lines = deps.knowledge.readCoverage(session.id);
      return coverageBlock(sessionView(session.messages), lines, { running: deps.extracting(session.id), threshold: chunkBudget(deps.settings()) });
    },
    sensitivityOf(session: SessionRecord): Sensitivity {
      return deps.sessionSensitivity.of(session).sensitivity;
    },
  };
}

/** Turns a name or an identifier that a model wrote into the identifier of a proposition. A name must match exactly one proposition. */
export function createTargetResolver(reader: ReturnType<typeof createKnowledgeReader>, knowledge: Knowledge): TargetResolver {
  return {
    resolve(raw, cls) {
      const text = raw.trim();
      if (!text) return null;
      let propositions: PropositionView[];
      try {
        propositions = knowledge.snapshot().propositions.filter((p) => reader.visible(p, cls));
      } catch {
        return null;
      }
      const byId = propositions.find((p) => p.id === learnId(text));
      if (byId) return byId.id;
      const lower = text.toLowerCase();
      const named = propositions.filter((p) => p.name.toLowerCase() === lower || p.aliases.some((a) => a.toLowerCase() === lower));
      return named.length === 1 ? named[0].id : null;
    },
  };
}

export function createKnowledgeDeletion(knowledge: Knowledge, extract: ExtractService): KnowledgeDeletion {
  const running = (id: string) => extract.runs().some((r) => r.sessionId === id);
  return {
    extractionRunning: running,
    abortExtraction: (id) => void extract.abort({ sessionId: id }),
    deleteSession: (id, mode) => knowledge.deleteSources([id], mode),
  };
}

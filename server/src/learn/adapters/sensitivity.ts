// The sensitivity of a session, derived from its record and never stored (docs/CONTRACTS.md, "Sensitivity gate and
// model policy"): the highest sensitivity of the propositions in its graph context marker, of the propositions that
// get_proposition read and of the roots that its file tool calls named.
import os from "node:os";
import path from "node:path";
import type { SessionRecord } from "../../../../shared/learn/index.ts";
import type { Sensitivity, SourceRoot } from "../../../../shared/learn/sources.ts";
import { isUnder } from "../../util.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { higherSensitivity, rootAllowedFor, type GateRoot } from "../models/gate.ts";
import type { SourcesService } from "../sources/index.ts";
import { learnId } from "./knowledge.ts";

const FILE_TOOLS = new Set(["read", "ls", "find", "grep"]);

export interface SessionGate {
  sensitivity: Sensitivity;
  /** true when every client-confidential contributor has a recorded consent for a hosted provider */
  consented: boolean;
}

export interface SensitivityDeps {
  knowledge: Knowledge;
  sources: SourcesService;
  now?: () => Date;
  /** The folder that a file tool reaches for an empty or relative path. It defaults to the home folder. */
  homeDir?: string;
  /** The session of an identifier, or nothing. A provenance identifier that is neither a file nor a session reads as client-confidential. */
  session?: (id: string) => SessionRecord | null | undefined;
}

export interface SessionSensitivity {
  of(session: SessionRecord): SessionGate;
  /** The input of the gate for a session. */
  gateRoots(session: SessionRecord): GateRoot[];
}

function contextIds(session: SessionRecord): { propositions: Set<string>; paths: string[] } {
  const propositions = new Set<string>();
  const paths: string[] = [];
  for (const m of session.messages) {
    if (m.role === "custom" && m.customType === "graph-context") {
      const list = (m.details as { propositions?: { id?: unknown }[] } | undefined)?.propositions;
      for (const p of Array.isArray(list) ? list : []) if (typeof p?.id === "string") propositions.add(p.id);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "toolCall") continue;
        const args = b.arguments as Record<string, unknown>;
        if (b.name === "get_proposition" && typeof args.id === "string") propositions.add(learnId(args.id.trim()));
        // a call with no path reads the home folder, so it is kept as an empty path
        else if (FILE_TOOLS.has(b.name)) paths.push(typeof args.path === "string" ? args.path : "");
      }
    }
  }
  return { propositions, paths };
}

export function createSessionSensitivity(deps: SensitivityDeps): SessionSensitivity {
  /**
   * The enabled roots that a file tool call may have read. The path is resolved as the file tool resolves it for a
   * model of Claude Code or a local model: an empty path is the home folder and a relative path starts there. A root
   * counts when the path lies inside it or when the root lies inside the path, because a listing of a parent folder
   * names what the root holds.
   */
  const rootsOfPath = (raw: string): SourceRoot[] => {
    const home = deps.homeDir ?? os.homedir();
    const text = raw.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(text)) return [];
    const expanded = text === "~" ? home : text.startsWith("~/") || text.startsWith("~\\") ? path.join(home, text.slice(2)) : text;
    const absolute = text !== "" && path.isAbsolute(expanded);
    const roots = deps.sources.list().filter((r) => r.enabled);
    const candidates = [text === "" ? home : absolute ? path.resolve(expanded) : path.resolve(home, expanded)];
    // A hosted model resolves an empty or relative path against the one root that the gate allows it, as the file tool
    // does. The record does not keep the class of the model that made the call, so both resolutions count.
    const hosted = roots.filter((r) => rootAllowedFor(r, "hosted"));
    if (hosted.length === 1 && !absolute && !text.startsWith("~")) candidates.push(text === "" ? path.resolve(hosted[0].path) : path.resolve(hosted[0].path, expanded));
    return roots.filter((r) => candidates.some((c) => isUnder(c, r.path) || isUnder(r.path, c)));
  };

  function of(session: SessionRecord, visiting: Set<string> = new Set()): SessionGate {
    visiting.add(session.id);
    const { propositions, paths } = contextIds(session);
    let level: Sensitivity = "public";
    let consented = true;
    const take = (root: Pick<SourceRoot, "sensitivity" | "hostedConsentAt">) => {
      level = higherSensitivity(level, root.sensitivity);
      if (root.sensitivity === "client-confidential" && !root.hostedConsentAt) consented = false;
    };
    for (const p of paths) for (const r of rootsOfPath(p)) take(r);
    if (propositions.size > 0) {
      let snapshot: ReturnType<Knowledge["snapshot"]> | null;
      try {
        snapshot = deps.knowledge.snapshot();
      } catch {
        snapshot = null;
      }
      for (const view of snapshot?.propositions ?? []) {
        if (!propositions.has(view.id)) continue;
        level = higherSensitivity(level, view.sensitivity);
        for (const point of view.provenance) {
          const hit = deps.sources.file(point.chatId);
          if (hit) {
            if (hit.root.sensitivity === "client-confidential" && !hit.root.hostedConsentAt) consented = false;
            continue;
          }
          const origin = deps.session?.(point.chatId);
          if (origin) {
            // a session that read confidential text passes it on to the claims that it taught
            if (visiting.has(origin.id)) continue;
            const inner = of(origin, visiting);
            level = higherSensitivity(level, inner.sensitivity);
            if (!inner.consented) consented = false;
            continue;
          }
          // no file record and no session: the source has gone, so its sensitivity is unknown and fails closed
          level = higherSensitivity(level, "client-confidential");
          consented = false;
        }
      }
    }
    return { sensitivity: level, consented };
  }

  return {
    of: (session) => of(session),
    gateRoots(session) {
      const gate = of(session);
      return [{ id: session.id, sensitivity: gate.sensitivity, hostedConsentAt: gate.consented ? (deps.now ?? (() => new Date()))().toISOString() : null }];
    },
  };
}

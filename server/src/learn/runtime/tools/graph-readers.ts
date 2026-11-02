// The reader tools list_sources, list_sessions, list_propositions and
// get_proposition. They read through the injected KnowledgeReader, which leaves
// out whatever the model class may not see. Names, bands and counts only, with
// the statement given by get_proposition for one proposition.
import { Type } from "typebox";
import { defineTool, type AnyTool } from "./define.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ProviderClass } from "../../../../../shared/learn/index.ts";
import type { KnowledgeReader, PathPolicy } from "../deps.ts";
import { TEXT_LABEL, wrapUntrusted } from "../../untrusted.ts";

const text = (t: string, isError = false): AgentToolResult<null> => ({ content: [{ type: "text", text: t }], details: null, ...(isError ? { isError: true } : {}) });

export interface GraphReaderDeps {
  reader: KnowledgeReader;
  policy: PathPolicy;
  providerClass: ProviderClass;
}

/** list_sources: the linked roots that the gate allows, for both scopes. */
export function listSourcesTool(deps: Pick<GraphReaderDeps, "policy" | "providerClass">): AnyTool {
  return defineTool({
    name: "list_sources",
    label: "List linked sources",
    description: "Lists the linked source folders that this session may read, with their path and kind.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const roots = deps.policy.allowedRoots(deps.providerClass);
        if (roots.length === 0) return text("No linked source is available to this session.");
        return text(roots.map((r) => `${r.label} (${r.id}) [${r.kind}] ${r.path}`).join("\n"));
      } catch (e) {
        return text(e instanceof Error ? e.message : "The sources could not be listed.", true);
      }
    },
  });
}

/** list_sessions, list_propositions and get_proposition. */
export function graphReaderTools(deps: GraphReaderDeps): AnyTool[] {
  const listSessions = defineTool({
    name: "list_sessions",
    label: "List sessions and sources",
    description: "Lists every session and file that has contributed propositions to the graph, newest first, with the number of propositions.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const rows = [...deps.reader.listSources(deps.providerClass)].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
        if (rows.length === 0) return text("The graph holds no propositions yet.");
        return text(rows.map((r) => `${r.label} (${r.id}) [${r.kind}, ${r.propositionCount} propositions${r.lastAt ? `, last ${r.lastAt.slice(0, 10)}` : ""}]`).join("\n"));
      } catch (e) {
        return text(e instanceof Error ? e.message : "The sessions could not be listed.", true);
      }
    },
  });
  const listPropositions = defineTool({
    name: "list_propositions",
    label: "List propositions of a session",
    description: "Lists the proposition names of one session or source, each with its held band and its support. It never returns statements. Use get_proposition for one statement.",
    parameters: Type.Object({ session: Type.String({ minLength: 1 }) }),
    execute: async (_id: string, params: { session: string }) => {
      try {
        const rows = deps.reader.listPropositions(params.session, deps.providerClass);
        if (rows.length === 0) return text("That session or source holds no propositions that this session may see. Use list_sessions for the valid identifiers.");
        return text(rows.map((p) => `${p.name} (${p.id}) [held: ${p.held}, support: ${p.support}]`).join("\n"));
      } catch (e) {
        return text(e instanceof Error ? e.message : "The propositions could not be listed.", true);
      }
    },
  });
  const getProposition = defineTool({
    name: "get_proposition",
    label: "Read one proposition",
    description: "Returns the statement, the aliases and the sources of one proposition.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_id: string, params: { id: string }) => {
      try {
        const p = deps.reader.getProposition(params.id, deps.providerClass);
        if (!p) return text(`No proposition has the identifier ${params.id}. Use list_propositions for the valid identifiers.`, true);
        const lines = [p.statement];
        if (p.aliases.length) lines.push(`Aliases: ${p.aliases.join(", ")}`);
        const sources = p.sources.length ? `\nSources: ${p.sources.map((s) => `${s.label} (${s.id})`).join(", ")}` : "";
        return text(`${p.name} (${p.id})\n${wrapUntrusted(lines.join("\n"), TEXT_LABEL)}${sources}`);
      } catch (e) {
        return text(e instanceof Error ? e.message : "The proposition could not be read.", true);
      }
    },
  });
  return [listSessions, listPropositions, getProposition];
}

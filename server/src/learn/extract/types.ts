// Shapes shared by the stages of the extraction pipeline. The stages are the extractor, the auditor and the merge
// (docs/LEARNING.md, "The extraction pipeline").
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CallUsage } from "../../../../shared/learn/sessions.ts";

/** How the text of a source is framed and anchored. Notes and files anchor to the file, the others to a message id. */
export type SourceShape = "notes" | "transcript" | "session";

/** A proposition as the extractor submits it. The id is local to one submission. */
export interface Finding {
  id: string;
  name: string;
  statement: string;
  aliases: string[];
  /** a passage copied word for word from the chunk, at most 280 characters */
  quote?: string;
  /** the message that supports the proposition, for transcripts and sessions only */
  messageId?: string;
}

/** An argument as the extractor submits it. Each endpoint is a local id or an existing proposition id. */
export interface FindingChain {
  premises: string[];
  conclusion: string;
}

export interface Findings {
  propositions: Finding[];
  chains: FindingChain[];
}

/** The usage of one stage of a run, in the shape of the usage records. */
export interface StageTally {
  model: string;
  steps: CallUsage[];
}

/** A tool of any parameter shape. The tools of the stages check their own arguments. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = AgentTool<any>;

/** The longest quote that a locator keeps. */
export const QUOTE_LIMIT = 280;

/** The turns that the stages are given. */
export const EXTRACTOR_TURNS = 4;
export const AUDITOR_TURNS = 16;

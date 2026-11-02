// Learning upgrade: background jobs. The source of truth is
// docs/CONTRACTS.md, section "Learning and knowledge (1 November 2026)", and a
// change is made there first.

import type { CallUsage } from "./sessions.ts";

/** Jobs: the kinds of job. "demo" and "visual" are reserved for a later wave and a dispatch of either is refused. */
export type JobKind = "research" | "pdf";

/** Jobs: jobs/<id>.json. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  chatId: string;
  toolCallId: string;
  /** saved before the worker starts */
  input: Record<string, unknown>;
  /** absent on a legacy record */
  delivery?: { kind: "result" | "abort"; status: "pending" | "delivered" };
  status: "running" | "done" | "error";
  /** the latest line, for example a quoted query or a host name */
  activity: string;
  createdAt: string;
  updatedAt: string;
  result?: ResearchResult | PdfResult;
  error?: string;
  usage?: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite1hTokens?: number;
    reasoningTokens?: number;
    steps?: number;
    lastStep?: CallUsage;
    calls?: CallUsage[];
  };
}

/** Jobs: result of research, at most 10 sources. */
export interface ResearchResult {
  brief: string;
  sources: { title: string; url: string }[];
}

/** Jobs: result of the PDF reader. */
export interface PdfResult {
  path: string;
  question: string;
  brief: string;
  pagesRead: number[];
  pagesConsulted: number[];
}

/** Jobs: input of a research job. */
export interface ResearchInput {
  question: string;
  context?: string;
}

/** Jobs: input of a pdf job. */
export interface PdfInput {
  path: string;
  question: string;
}

/** Routes: GET /api/learn/jobs?sessionId=<id>. */
export interface JobsResponse {
  jobs: JobRecord[];
  turnInFlight: boolean;
}

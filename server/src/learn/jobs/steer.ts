// The messages by which a job reports to the session, the shapes of a failure, and the fold of model usage into a
// job record. A marker has a deterministic identifier, so delivery can be repeated without a second copy.
import type { CallUsage, JobKind, JobRecord, NativeMessage, PdfResult, ResearchResult } from "../../../../shared/learn/index.ts";

export const RESEARCH_FAILURE = "Research failed:";
export const PDF_FAILURE = "PDF reading failed:";
const MAX_SOURCES = 10;

/** The identifier of the marker of a job. */
export const steerIdOf = (jobId: string): string => `steer_${jobId}`;

export interface SteerBuild {
  id: string;
  customType: "subagent-steer" | "subagent-abort";
  /** the text that the model reads */
  content: string;
  details: Record<string, unknown>;
}

const failureResearch = (reason: string): ResearchResult => ({ brief: `${RESEARCH_FAILURE} ${reason}`, sources: [] });
const failurePdf = (input: { path?: unknown; question?: unknown }, reason: string): PdfResult => ({
  path: typeof input.path === "string" ? input.path : "",
  question: typeof input.question === "string" ? input.question : "",
  brief: `${PDF_FAILURE} ${reason}`,
  pagesRead: [],
  pagesConsulted: [],
});

/** The result that a job without a usable result reports, so that the session still learns the outcome. */
export function failureResult(kind: JobKind, input: Record<string, unknown>, reason: string): ResearchResult | PdfResult {
  return kind === "research" ? failureResearch(reason) : failurePdf(input, reason);
}

/** True for an empty result or one whose brief starts with a failure phrase. */
export function isFailureResult(kind: JobKind, result: ResearchResult | PdfResult | undefined): boolean {
  if (!result) return true;
  const brief = result.brief.trim();
  if (!brief) return true;
  return brief.startsWith(kind === "research" ? RESEARCH_FAILURE : PDF_FAILURE);
}

const numbers = (list: number[]) => (list.length ? list.join(", ") : "none");

function describe(job: JobRecord): string {
  if (job.kind === "research") return `research on "${String(job.input.question ?? "").slice(0, 160)}"`;
  return `reading of the PDF ${String(job.input.path ?? "")} for "${String(job.input.question ?? "").slice(0, 160)}"`;
}

export function buildSteer(job: JobRecord, delivery: "result" | "abort"): SteerBuild {
  const id = steerIdOf(job.id);
  const base = { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId };
  if (delivery === "abort") {
    return {
      id,
      customType: "subagent-abort",
      content: `The learner stopped background job ${job.id}, the ${describe(job)}. No result is coming. Carry on without it, and tell the learner that the point is unchecked if it matters.`,
      details: { ...base, aborted: true },
    };
  }
  const result = job.result;
  const failed = job.status === "error" || isFailureResult(job.kind, result);
  if (failed) {
    const why = result?.brief?.trim() || job.error || "The job returned nothing.";
    const how =
      job.kind === "research"
        ? "Say so to the learner. Then answer from what you know, with the claim marked as unchecked, or ask whether to try again with a narrower question."
        : "Say so to the learner. Then ask for a different file or a page range, or carry on without the document and mark the point as unchecked.";
    return {
      id,
      customType: "subagent-steer",
      content: `Background job ${job.id}, the ${describe(job)}, did not produce a result. ${why}\n${how}`,
      details: { ...base, result: result ?? failureResult(job.kind, job.input, job.error ?? "The job returned nothing.") },
    };
  }
  if (job.kind === "research") {
    const r = result as ResearchResult;
    const list = r.sources.length ? `\n\nSources:\n${r.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n")}` : "";
    return {
      id,
      customType: "subagent-steer",
      content: `Background job ${job.id} finished the ${describe(job)}. Use the brief below and name its sources where you rely on them.\n\n${r.brief.trim()}${list}`,
      details: { ...base, result: r },
    };
  }
  const r = result as PdfResult;
  return {
    id,
    customType: "subagent-steer",
    content: `Background job ${job.id} finished the ${describe(job)}. Use the brief below and cite the pages.\n\n${r.brief.trim()}\n\nPages read: ${numbers(r.pagesRead)}. Pages consulted: ${numbers(r.pagesConsulted)}.`,
    details: { ...base, result: r },
  };
}

export function markerMessage(build: SteerBuild, now: number): NativeMessage {
  return { role: "custom", id: build.id, customType: build.customType, content: build.content, display: true, details: build.details, timestamp: now };
}

/** The sources of a research brief: markdown links first, then the pages that were fetched. At most 10. */
export function sourcesOf(brief: string, fetched: string[]): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  const add = (title: string, url: string) => {
    const clean = url.replace(/[).,;]+$/, "");
    if (seen.has(clean) || out.length >= MAX_SOURCES) return;
    seen.add(clean);
    out.push({ title: title.trim() || hostOf(clean), url: clean });
  };
  for (const m of brief.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) add(m[1], m[2]);
  if (!out.length) for (const url of fetched) add(hostOf(url), url);
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A running total of the model calls of one job, in the shape of the job record. */
export class UsageFolder {
  private readonly total: NonNullable<JobRecord["usage"]>;
  constructor(model: string) {
    this.total = { model, steps: 0, calls: [] };
  }
  add(call: CallUsage): NonNullable<JobRecord["usage"]> {
    const t = this.total;
    const sum = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cacheWrite1hTokens" | "reasoningTokens") => {
      const v = call[key];
      if (typeof v === "number") t[key] = (t[key] ?? 0) + v;
    };
    sum("inputTokens");
    sum("outputTokens");
    sum("cacheReadTokens");
    sum("cacheWriteTokens");
    sum("cacheWrite1hTokens");
    sum("reasoningTokens");
    t.steps = (t.steps ?? 0) + 1;
    t.lastStep = call;
    t.calls = [...(t.calls ?? []), call];
    return this.snapshot();
  }
  snapshot(): NonNullable<JobRecord["usage"]> {
    return { ...this.total, calls: [...(this.total.calls ?? [])] };
  }
}

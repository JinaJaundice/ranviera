// The two workers. The researcher runs on the cheap slot with the web tools and the PDF text tools. The PDF reader runs
// on the vision slot with the four PDF tools. Each returns the result of a job, and a thrown error means that the
// worker could not run at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { CallUsage, PdfResult, ResearchResult } from "../../../../shared/learn/index.ts";
import { resolveToolPath } from "../runtime/tools/files.ts";
import { runWorkerAgent } from "./agent-run.ts";
import { PDF_READER_TURNS, NO_PAGE_NUDGE, RESEARCHER_TURNS, pdfReaderPrompt, pdfTask, researcherPrompt, researcherTask } from "./prompts.ts";
import { PdfFault, withPdf } from "./pdf/ops.ts";
import { PDF_FAILURE, RESEARCH_FAILURE, sourcesOf } from "./steer.ts";
import { pdfTools, type ImagePart } from "./tools/pdf-tools.ts";
import { insideJobDir, webTools } from "./tools/web-tools.ts";
import { resolveSearchProvider } from "./web/search.ts";
import type { JobEngine, JobsDeps } from "./types.ts";

export interface WorkerContext {
  deps: JobsDeps;
  engine: JobEngine;
  signal: AbortSignal;
  onUsage: (usage: CallUsage) => void;
  activity: (line: string) => void;
}

/** A folder for the downloads of one job, removed when the worker ends. */
export function makeJobDir(deps: JobsDeps, jobId: string): string {
  const base = deps.tempDir ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `cortex-${jobId}-`));
}

export async function runResearcher(ctx: WorkerContext, input: { question: string; context?: string }, jobDir: string): Promise<ResearchResult> {
  const { deps } = ctx;
  const fetched: string[] = [];
  const searchOn = resolveSearchProvider(deps.keys, deps.searchPin?.()) !== null;
  const tools = [
    ...webTools({
      keys: deps.keys,
      pin: deps.searchPin,
      fetch: deps.fetch,
      allowPrivateHosts: deps.allowPrivateHosts,
      endpoints: deps.searchEndpoints,
      jobDir,
      signal: ctx.signal,
      activity: ctx.activity,
      fetched: (url) => fetched.push(url),
      // web_fetch accepts only addresses that the question, its context or an earlier search of this job named
      seedText: researcherTask(input),
    }),
    ...pdfTools({ resolve: insideJobDir(jobDir), read: () => undefined, consulted: () => undefined, activity: ctx.activity, signal: ctx.signal }),
  ];
  const out = await runWorkerAgent({
    engine: ctx.engine,
    systemPrompt: researcherPrompt(searchOn),
    prompt: researcherTask(input),
    tools,
    maxTurns: RESEARCHER_TURNS,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
  });
  const brief = out.text.trim();
  if (!brief) return { brief: `${RESEARCH_FAILURE} the worker ended without a brief.`, sources: [] };
  return { brief, sources: sourcesOf(brief, fetched) };
}

/** Resolves the path of a PDF by the rules of the gate and checks that the file opens, before any model call. */
export async function preparePdf(deps: JobsDeps, engine: JobEngine, raw: string): Promise<{ abs: string } | { failure: string }> {
  const resolved = resolveToolPath(raw, { providerClass: engine.providerClass, policy: deps.policy, homeDir: deps.homeDir });
  if (!resolved.ok) return { failure: resolved.message };
  try {
    await withPdf(resolved.abs, async (doc) => doc.numPages);
  } catch (e) {
    return { failure: e instanceof PdfFault ? e.message : "The PDF could not be read." };
  }
  return { abs: resolved.abs };
}

export async function runPdfReader(ctx: WorkerContext, input: { path: string; question: string }, abs: string): Promise<PdfResult> {
  const { engine } = ctx;
  const read = new Set<number>();
  const consulted = new Set<number>();
  let agent: Agent | null = null;
  let batch: { role: "user"; content: ImagePart[]; timestamp: number } | null = null;
  const tools = pdfTools({
    resolve: () => ({ ok: true, abs }),
    read: (pages) => pages.forEach((p) => read.add(p)),
    consulted: (pages) => pages.forEach((p) => consulted.add(p)),
    activity: ctx.activity,
    signal: ctx.signal,
    render: {
      imageInput: engine.imageInput,
      imageLimits: engine.imageLimits,
      // the images of all render calls of one turn travel in one user message after the tool results
      queue: (parts) => {
        if (!agent) return;
        if (!batch) {
          batch = { role: "user", content: [], timestamp: Date.now() };
          agent.steer(batch as never);
        }
        batch.content.push(...parts);
      },
    },
  });
  const wrapped = engine.imageInput ? tools : tools.filter((t) => t.name !== "pdf_render");
  const out = await runWorkerAgent({
    engine,
    systemPrompt: pdfReaderPrompt(engine.imageInput),
    prompt: pdfTask({ path: path.basename(abs), question: input.question }),
    tools: wrapped,
    maxTurns: PDF_READER_TURNS,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
    onAgent: (a) => {
      agent = a;
      a.subscribe((event: AgentEvent) => {
        if (event.type === "turn_end") batch = null;
      });
    },
    beforeStop: () => (read.size === 0 ? NO_PAGE_NUDGE : null),
  });
  const pagesRead = [...read].sort((a, b) => a - b);
  const pagesConsulted = [...new Set([...read, ...consulted])].sort((a, b) => a - b);
  const brief = out.text.trim();
  const base = { path: input.path, question: input.question };
  if (!brief) return { ...base, brief: `${PDF_FAILURE} the worker ended without a brief.`, pagesRead, pagesConsulted };
  // a brief with no page consulted is not delivered as an answer
  if (pagesConsulted.length === 0) return { ...base, brief: `${PDF_FAILURE} the worker answered without reading any page of the file.`, pagesRead, pagesConsulted };
  return { ...base, brief, pagesRead, pagesConsulted };
}

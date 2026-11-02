// The web tools of the researcher: web_search, web_fetch and web_fetch_pdf. A tool never throws into the loop. A
// refusal or a failure comes back as a sentence, and a missing search key is stated plainly so that the brief says so.
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type AnyTool } from "../../runtime/tools/define.ts";
import type { JobKeys } from "../types.ts";
import { PdfFault, triage } from "../pdf/ops.ts";
import { downloadPdf, webFetch } from "../web/fetch.ts";
import { urlKey, urlsIn, wrapUntrusted } from "../web/untrusted.ts";
import { formatHits, NO_SEARCH_TEXT, resolveSearchProvider, searchWeb, SEARCH_DEFAULT_COUNT, SEARCH_MAX_COUNT, type SearchPin } from "../web/search.ts";

export interface WebToolsContext {
  keys: JobKeys;
  pin?: () => SearchPin | undefined;
  fetch?: typeof fetch;
  allowPrivateHosts?: boolean;
  /** the host names are resolved by this function in place of DNS, for tests */
  resolveHost?: (host: string) => Promise<string[]>;
  /** the question and the context of the job: addresses written in it may be fetched */
  seedText?: string;
  endpoints?: { tavily?: string; brave?: string };
  /** the folder that holds the downloads of this job */
  jobDir: string;
  signal?: AbortSignal;
  activity(line: string): void;
  /** called with each address that was fetched, for the fallback list of sources */
  fetched(url: string): void;
}

const text = (t: string, isError = false): AgentToolResult<null> => ({ content: [{ type: "text", text: t }], details: null, ...(isError ? { isError: true } : {}) });

const hostOf = (raw: string): string => {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw.slice(0, 60);
  }
};

const NOT_OFFERED = "That address did not appear in the question, its context or an earlier search result of this job, so it is not fetched. Search for it, or use an address that the question supplies.";

export function webTools(ctx: WebToolsContext): AnyTool[] {
  // web_fetch takes only addresses that the person's question or a search of this job named, so that a page cannot
  // send the researcher to an address of its own choosing
  const allowed = new Set<string>();
  for (const u of urlsIn(ctx.seedText ?? "")) {
    const k = urlKey(u);
    if (k) allowed.add(k);
  }
  const offered = (raw: string): boolean => {
    const k = urlKey(raw);
    // an address that is not http or https is left to the fetcher, which refuses it with its own sentence
    return k === null || allowed.has(k);
  };
  return [
    defineTool({
      name: "web_search",
      label: "Search the web",
      description: `Searches the web and returns titles, addresses and short snippets. The count defaults to ${SEARCH_DEFAULT_COUNT} and is at most ${SEARCH_MAX_COUNT}.`,
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), count: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_COUNT })) }),
      execute: async (_id: string, p: { query: string; count?: number }) => {
        try {
          // the provider is resolved afresh, so a key saved in Settings applies to the next call
          const provider = resolveSearchProvider(ctx.keys, ctx.pin?.());
          if (!provider) return text(NO_SEARCH_TEXT, true);
          ctx.activity(`Searching "${p.query.slice(0, 80)}"`);
          const hits = await searchWeb(provider, p.query, p.count ?? SEARCH_DEFAULT_COUNT, { fetch: ctx.fetch, endpoints: ctx.endpoints, signal: ctx.signal });
          for (const h of hits) {
            const k = urlKey(h.url);
            if (k) allowed.add(k);
          }
          return text(wrapUntrusted(formatHits(p.query, hits), "search results"));
        } catch (e) {
          return text(`The search failed: ${e instanceof Error && e.message ? e.message : "no reason was given."}`, true);
        }
      },
    }),
    defineTool({
      name: "web_fetch",
      label: "Fetch a page",
      description: "Fetches one http or https address and returns its readable text as Markdown, headed by a line with the final address and the HTTP status. A PDF address is not read here.",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
      execute: async (_id: string, p: { url: string }) => {
        if (!offered(p.url)) return text(NOT_OFFERED, true);
        ctx.activity(`Reading ${hostOf(p.url)}`);
        const out = await webFetch(p.url, { fetch: ctx.fetch, allowPrivateHosts: ctx.allowPrivateHosts, resolveHost: ctx.resolveHost, signal: ctx.signal });
        if (!out.startsWith("Source: ")) return text(out);
        ctx.fetched(p.url);
        const at = out.indexOf("\n");
        return text(at < 0 ? out : `${out.slice(0, at)}\n${wrapUntrusted(out.slice(at + 1), "page text")}`);
      },
    }),
    defineTool({
      name: "web_fetch_pdf",
      label: "Download a PDF",
      description: "Downloads a PDF from an http or https address into the folder of this job. Returns the local path, the page count, the size class and the pages that hold images or dense maths. Read it afterwards with pdf_info, pdf_extract and pdf_search.",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
      execute: async (_id: string, p: { url: string }) => {
        if (!offered(p.url)) return text(NOT_OFFERED, true);
        ctx.activity(`Downloading a PDF from ${hostOf(p.url)}`);
        const got = await downloadPdf(p.url, ctx.jobDir, { fetch: ctx.fetch, allowPrivateHosts: ctx.allowPrivateHosts, resolveHost: ctx.resolveHost, signal: ctx.signal });
        if (!got.ok) return text(got.message, true);
        try {
          const s = await triage(got.file);
          ctx.fetched(p.url);
          return text(
            [
              `Saved to ${got.file} (${got.bytes} bytes).`,
              `${s.pages} pages (${s.sizeClass}), a mean of ${s.meanChars} characters of text for each page.`,
              s.flagged.length ? `Pages with images or dense maths: ${s.flagged.join(", ")}.` : "No page holds images or dense maths.",
            ].join("\n"),
          );
        } catch (e) {
          fs.rmSync(got.file, { force: true });
          return text(e instanceof PdfFault ? `${e.message} The download was removed.` : "The download could not be read as a PDF and was removed.", true);
        }
      },
    }),
  ];
}

/** Keeps a path argument of the researcher inside the folder of its job. */
export function insideJobDir(jobDir: string) {
  const root = path.resolve(jobDir);
  return (raw: string): { ok: true; abs: string } | { ok: false; message: string } => {
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, message: "That path is outside the folder of this job. Use a path that web_fetch_pdf returned." };
    return { ok: true, abs };
  };
}

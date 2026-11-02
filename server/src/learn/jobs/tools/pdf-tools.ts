// The PDF tools of the researcher and the PDF reader: pdf_info, pdf_extract and pdf_search for both, and pdf_render for
// the reader only, because the cheap slot of the researcher takes no images. A path is resolved by the caller, which
// keeps the researcher inside the folder of its job and keeps the reader inside the paths that the gate allows.
import path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type AnyTool } from "../../runtime/tools/define.ts";
import { processImage, type ResizeOptions } from "../../images/index.ts";
import { EXTRACT_MAX_CHARS, PdfFault, RENDER_DEFAULT_DPI, RENDER_MAX_PAGES, SEARCH_MAX_CONTEXT, SEARCH_MAX_HITS, extractPages, infoText, parsePageSpec, renderPages, searchPdf, triage } from "../pdf/ops.ts";

export type ImagePart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PdfToolsContext {
  resolve(raw: string): { ok: true; abs: string } | { ok: false; message: string };
  /** pages whose content reached the model in full */
  read(pages: number[]): void;
  /** pages that the model saw in part, for example through a search hit */
  consulted(pages: number[]): void;
  activity(line: string): void;
  signal?: AbortSignal;
  /** present only for the reader */
  render?: {
    imageInput: boolean;
    imageLimits?: ResizeOptions;
    /** queues a user message of images that follows the tool results */
    queue(parts: ImagePart[]): void;
  };
}

const text = (t: string, isError = false): AgentToolResult<null> => ({ content: [{ type: "text", text: t }], details: null, ...(isError ? { isError: true } : {}) });

async function guarded(step: () => Promise<AgentToolResult<null>>): Promise<AgentToolResult<null>> {
  try {
    return await step();
  } catch (e) {
    if (e instanceof PdfFault) return text(e.message, true);
    return text(`The PDF step failed${e instanceof Error && e.message ? `: ${e.message}` : "."}`, true);
  }
}

export function pdfTools(ctx: PdfToolsContext): AnyTool[] {
  const name = (abs: string) => path.basename(abs);
  const tools: AnyTool[] = [
    defineTool({
      name: "pdf_info",
      label: "PDF overview",
      description: "Gives the page count, the size class and, for each page, the characters of text, the images and the maths density. Use it first to decide which pages to read.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
      execute: async (_id: string, p: { path: string }) =>
        guarded(async () => {
          const r = ctx.resolve(p.path);
          if (!r.ok) return text(r.message, true);
          ctx.activity(`Checking ${name(r.abs)}`);
          return text(infoText(name(r.abs), await triage(r.abs)));
        }),
    }),
    defineTool({
      name: "pdf_extract",
      label: "PDF text",
      description: `Returns the text of chosen pages with a page marker before each. Give pages as "all", one number, a range such as 1-5, or a list such as 1,3,7. Output stops at ${EXTRACT_MAX_CHARS.toLocaleString("en-GB")} characters.`,
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), pages: Type.String({ minLength: 1 }) }),
      execute: async (_id: string, p: { path: string; pages: string }) =>
        guarded(async () => {
          const r = ctx.resolve(p.path);
          if (!r.ok) return text(r.message, true);
          ctx.activity(`Reading pages ${p.pages} of ${name(r.abs)}`);
          const out = await extractPages(r.abs, p.pages);
          if ("error" in out) return text(out.error, true);
          ctx.read(out.pages);
          return text(out.text);
        }),
    }),
    defineTool({
      name: "pdf_search",
      label: "PDF search",
      description: `Finds a word or phrase on any page, ignoring case. Returns at most ${SEARCH_MAX_HITS} hits with 0 to ${SEARCH_MAX_CONTEXT} lines of context on each side.`,
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), query: Type.String({ minLength: 1 }), context: Type.Optional(Type.Integer({ minimum: 0, maximum: SEARCH_MAX_CONTEXT })) }),
      execute: async (_id: string, p: { path: string; query: string; context?: number }) =>
        guarded(async () => {
          const r = ctx.resolve(p.path);
          if (!r.ok) return text(r.message, true);
          ctx.activity(`Searching ${name(r.abs)} for "${p.query.slice(0, 60)}"`);
          const out = await searchPdf(r.abs, p.query, p.context ?? 2);
          if ("error" in out) return text(out.error, true);
          ctx.consulted(out.pages);
          return text(out.text);
        }),
    }),
  ];
  const render = ctx.render;
  if (render) {
    tools.push(
      defineTool({
        name: "pdf_render",
        label: "PDF page images",
        description: `Renders up to ${RENDER_MAX_PAGES} pages to images that you can look at, for figures, tables and scanned text. The images follow in the next message. The resolution is 72 to 300 dpi and the default is ${RENDER_DEFAULT_DPI}.`,
        parameters: Type.Object({ path: Type.String({ minLength: 1 }), pages: Type.String({ minLength: 1 }), dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300 })) }),
        execute: async (_id: string, p: { path: string; pages: string; dpi?: number }) =>
          guarded(async () => {
            if (!render.imageInput) return text("This model takes no images, so pages cannot be rendered. Use pdf_extract and pdf_search for the text.", true);
            const r = ctx.resolve(p.path);
            if (!r.ok) return text(r.message, true);
            const dpi = p.dpi ?? RENDER_DEFAULT_DPI;
            const probe = await triage(r.abs).catch(() => null);
            if (!probe) return text("The PDF could not be opened for rendering.", true);
            const wanted = parsePageSpec(p.pages, probe.pages);
            if ("error" in wanted) return text(wanted.error, true);
            const chosen = wanted.pages.slice(0, RENDER_MAX_PAGES);
            if (!chosen.length) return text(`No page of that selection exists. The document has ${probe.pages} pages.`, true);
            ctx.activity(`Rendering pages ${chosen.join(", ")} of ${name(r.abs)}`);
            const out = await renderPages(r.abs, chosen, dpi);
            if ("error" in out) return text(out.error, true);
            const parts: ImagePart[] = [];
            const shown: number[] = [];
            for (const page of out.rendered) {
              const processed = await processImage(page.png, "image/png", { resize: render.imageLimits });
              if (processed.ok) {
                shown.push(page.page);
                parts.push({ type: "text", text: [`Page ${page.page}`, ...processed.hints].join("\n") }, { type: "image", data: processed.data, mimeType: processed.mimeType });
              } else parts.push({ type: "text", text: `Page ${page.page}\n${processed.message}` });
            }
            for (const n of out.skipped) parts.push({ type: "text", text: `Page ${n} could not be rendered.` });
            if (parts.length) render.queue([{ type: "text", text: `The rendered pages, in order (${chosen.map((n) => `p${n}`).join(", ")}):` }, ...parts]);
            ctx.read(shown);
            const note = wanted.pages.length > RENDER_MAX_PAGES ? ` Only the first ${RENDER_MAX_PAGES} pages were rendered.` : "";
            return text(`Rendered ${shown.length} of ${chosen.length} page${chosen.length === 1 ? "" : "s"} at ${dpi} dpi. The images follow in the next message.${note}`, shown.length === 0);
          }),
      }),
    );
  }
  return tools;
}

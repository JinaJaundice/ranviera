// The routes of the sources area (docs/CONTRACTS.md, "Routes"): 38 passage, 40 list, 41 add, 42 change, 43 unlink, 44 scan and 46 files.
// Route 45 (extract) belongs to the extraction phase, so this handler leaves it alone and returns false.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "../../util.ts";
import { SourceError, badRequest, notFound } from "./errors.ts";
import type { SourcesService } from "./index.ts";

const CODES: Record<number, string> = { 400: "bad_request", 404: "not_found", 413: "too_large", 415: "unsupported_media_type" };

/** Answers an error with the envelope of the contracts: `{ error, code?, ...extra }`. */
export function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof SourceError) return sendJson(res, e.status, { error: e.message, code: e.code, ...e.extra });
  if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(CODES[e.status] ? { code: CODES[e.status] } : {}) });
  sendJson(res, 500, { error: e instanceof Error && e.message ? e.message : "The request failed." });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  sendJson(res, 405, { error: `This route accepts ${allow} only.` });
}

function wholeNumber(v: string | null, name: string): number | null {
  if (v === null) return null;
  if (!/^\d{1,9}$/.test(v)) throw badRequest(`The parameter ${name} must be a whole number.`);
  return Number(v);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  const hasBody = req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0";
  if ((hasBody || req.headers["transfer-encoding"]) && !type.toLowerCase().includes("application/json")) {
    throw new SourceError(415, "unsupported_media_type", "The body must be JSON with the content type application/json.");
  }
  return readJsonBody(req);
}

/** Handles a request for the sources routes. Returns true when it answered and false when the path is not one of its routes. */
export async function handleSources(service: SourcesService, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const p = path.replace(/^\/api\/learn(?=\/)/, "");
  const method = req.method ?? "GET";
  try {
    if (p === "/passage") {
      if (method !== "GET") return methodNotAllowed(res, "GET"), true;
      const source = query.get("source");
      if (!source) throw badRequest("The parameter source is required.");
      const from = wholeNumber(query.get("from"), "from") ?? 1;
      const to = wholeNumber(query.get("to"), "to") ?? from + 199;
      sendJson(res, 200, await service.passage(source, from, to));
      return true;
    }
    if (p === "/sources") {
      if (method === "GET") sendJson(res, 200, { roots: service.list() });
      else if (method === "POST") sendJson(res, 201, { root: service.add((await body(req)) as never) });
      else methodNotAllowed(res, "GET, POST");
      return true;
    }
    const m = /^\/sources\/([^/]+)(?:\/([^/]+))?$/.exec(p);
    if (!m) return false;
    const [, rootId, action] = m;
    if (action === "extract") return false;
    if (action !== undefined && action !== "scan" && action !== "files") return false;
    if (!/^root_[0-9a-f]{8}$/.test(rootId)) throw notFound("No linked source has that id.");
    if (action === "scan") {
      if (method !== "POST") return methodNotAllowed(res, "POST"), true;
      sendJson(res, 200, await service.scan(rootId));
    } else if (action === "files") {
      if (method !== "GET") return methodNotAllowed(res, "GET"), true;
      sendJson(res, 200, { files: service.files(rootId) });
    } else if (method === "PATCH") {
      sendJson(res, 200, { root: service.update(rootId, (await body(req)) as never) });
    } else if (method === "DELETE") {
      const mode = query.get("mode");
      if (mode !== "preserve-graph" && mode !== "delete-nodes") throw badRequest("The parameter mode must be preserve-graph or delete-nodes. There is no default.");
      sendJson(res, 200, await service.remove(rootId, mode));
    } else {
      methodNotAllowed(res, "PATCH, DELETE");
    }
    return true;
  } catch (e) {
    sendError(res, e);
    return true;
  }
}

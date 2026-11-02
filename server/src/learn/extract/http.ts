// Routes 31, 32, 33 and 45 of docs/CONTRACTS.md ("Routes"). The handler returns true when it answered and false when the
// path is not one of its routes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "../../util.ts";
import { KnowledgeError } from "../knowledge/errors.ts";
import { LearnError } from "../models/errors.ts";
import type { ExtractService } from "./pipeline.ts";

function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof LearnError) return sendJson(res, e.status, e.body());
  if (e instanceof KnowledgeError) return sendJson(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra });
  if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
  sendJson(res, 500, { error: e instanceof Error && e.message ? e.message : "The request failed." });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  sendJson(res, 405, { error: `This route accepts ${allow} only.` });
}

/** A body must be JSON when there is one. An empty body reads as an empty object. */
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  const has = (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") || req.headers["transfer-encoding"] !== undefined;
  if (has && !type.toLowerCase().includes("application/json")) {
    throw new LearnError(415, "unsupported_media_type", "The body must be JSON with the content type application/json.");
  }
  return has ? readJsonBody(req) : {};
}

export async function handleExtract(service: ExtractService, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const p = path.replace(/^\/api\/learn(?=\/)/, "");
  const method = req.method ?? "GET";
  try {
    if (p === "/graph/status") {
      if (method !== "GET") return methodNotAllowed(res, "GET"), true;
      sendJson(res, 200, { runs: service.runs() });
      return true;
    }
    if (p === "/graph/costs") {
      if (method !== "GET") return methodNotAllowed(res, "GET"), true;
      sendJson(res, 200, service.costs());
      return true;
    }
    if (p === "/graph/extract") {
      if (method !== "POST") return methodNotAllowed(res, "POST"), true;
      const b = await body(req);
      if (typeof b.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(b.sessionId)) {
        throw new LearnError(400, "bad_request", "The body must hold a sessionId that uses letters, digits, underscores and hyphens only.");
      }
      sendJson(res, 202, await service.extractSession(b.sessionId));
      return true;
    }
    const m = /^\/sources\/([^/]+)\/extract$/.exec(p);
    if (m) {
      if (method !== "POST") return methodNotAllowed(res, "POST"), true;
      if (!/^root_[0-9a-f]{8}$/.test(m[1])) throw new LearnError(404, "not_found", "No linked source has that id.");
      sendJson(res, 202, await service.extractRoot(m[1], await body(req)));
      return true;
    }
    return false;
  } catch (e) {
    sendError(res, e);
    return true;
  }
}

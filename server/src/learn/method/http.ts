// Routes 13 to 15 and 39 of CONTRACTS "Routes". The handler returns true when it
// handled the route and false when the path is not one of these, so that
// server/src/learn/http.ts can try the next phase. Errors use the envelopes of
// "Error envelopes".
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../../util.ts";
import { RuntimeError, badRequest, sendRuntimeError } from "../runtime/errors.ts";
import { MAX_OVERRIDE_CHARS } from "./prompt-store.ts";
import type { MethodService } from "./service.ts";

const PREFIX = "/api/learn";
const BODY_LIMIT = MAX_OVERRIDE_CHARS * 4 + 1024;

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  const raw = await readBody(req, BODY_LIMIT);
  if (!raw.trim()) return {};
  if (!type.toLowerCase().includes("json")) throw new RuntimeError(415, "The request body must be JSON.", "unsupported_media_type");
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw badRequest("The request body must be a JSON object.");
}

const methodNotAllowed = (res: ServerResponse, allow: string[]) => {
  res.setHeader("Allow", allow.join(", "));
  sendJson(res, 405, { error: `That route accepts ${allow.join(" or ")} only.` });
};

/** Handles one request for the prompt and outcome routes. */
export async function handleMethod(service: MethodService, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const rel = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
  const method = req.method ?? "GET";
  try {
    if (rel === "/prompts" || rel === "/prompts/") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, service.prompts.list());
      return true;
    }
    if (rel.startsWith("/prompts/")) {
      // the key is a path of one or two segments, for example teacher/20-teaching
      const key = rel
        .slice("/prompts/".length)
        .split("/")
        .map((piece) => decodeURIComponent(piece))
        .join("/");
      if (method === "PUT") {
        const body = await jsonBody(req);
        if (typeof body.text !== "string") throw badRequest("The body must be an object with a string text.");
        if (body.text.length > MAX_OVERRIDE_CHARS) throw new RuntimeError(413, `An override may hold at most ${MAX_OVERRIDE_CHARS} characters.`, "too_large");
        const out = service.prompts.write(key, body.text);
        sendJson(res, 200, out.written ? { ok: true, key: out.key, text: body.text } : { ok: true, ignored: true });
        return true;
      }
      if (method === "DELETE") {
        const out = service.prompts.remove(key);
        sendJson(res, 200, out.deleted ? { ok: true, deleted: true, switchCleared: out.switchCleared } : { ok: true, ignored: true });
        return true;
      }
      return methodNotAllowed(res, ["PUT", "DELETE"]), true;
    }
    if (rel === "/outcomes") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      const node = query.get("node");
      if (!node || !/^[A-Za-z0-9_-]+$/.test(node)) throw badRequest("The node parameter must be a proposition identifier.");
      const out = service.outcomesFor(node);
      if (!out) throw new RuntimeError(404, "That proposition does not exist.", "not_found");
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, out);
      return true;
    }
    return false;
  } catch (e) {
    sendRuntimeError(res, e);
    return true;
  }
}

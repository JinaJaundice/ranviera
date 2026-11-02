// Routes 16 to 26, 28 and 29 of CONTRACTS "Routes". The handler returns true
// when it handled the route and false when the path is not one of these, so
// that server/src/learn/http.ts can try the next phase. Errors use the
// envelopes of "Error envelopes".
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InputEvent } from "../../../../shared/learn/index.ts";
import { readBody, sendJson } from "../../util.ts";
import { RuntimeError, badRequest, sendRuntimeError } from "./errors.ts";
import type { SessionService } from "./service.ts";
import { sseFrame } from "./turn-stream.ts";

const PREFIX = "/api/learn";

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  if (!type.toLowerCase().includes("json")) {
    throw new RuntimeError(415, "The request body must be JSON.", "unsupported_media_type");
  }
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

/** Handles one request for the session routes. */
export async function handleSessions(
  service: SessionService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  const rel = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
  const method = req.method ?? "GET";
  try {
    if (rel === "/activity") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      sendJson(res, 200, { items: service.activity.list() });
      return true;
    }
    if (rel === "/activity/abort") {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]), true;
      sendJson(res, 200, service.activity.abort(await jsonBody(req)));
      return true;
    }
    if (rel === "/sessions" || rel === "/sessions/") {
      if (method === "GET") {
        sendJson(res, 200, { sessions: service.list() });
      } else if (method === "POST") {
        sendJson(res, 200, { session: service.create(await jsonBody(req)) });
      } else methodNotAllowed(res, ["GET", "POST"]);
      return true;
    }
    const m = /^\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(rel);
    if (!m) return false;
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (!action) {
      if (method === "GET") sendJson(res, 200, service.detail(id));
      else if (method === "PUT") {
        const body = await jsonBody(req);
        sendJson(res, 200, { session: service.rename(id, body.title) });
      } else if (method === "DELETE") {
        sendJson(res, 200, await service.remove(id, query.get("mode")));
      } else methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
      return true;
    }
    switch (action) {
      case "input": {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]), true;
        const body = await jsonBody(req);
        const input = body.input as InputEvent | undefined;
        if (!input || typeof input !== "object") throw badRequest("The body must hold an input object.");
        sendJson(res, 200, { ok: true, ...(await service.input(id, input)) });
        return true;
      }
      case "stream": {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
        if (!service.store.get(id)) {
          sendJson(res, 404, { error: "That session does not exist.", code: "not_found" });
          return true;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        const stream = service.turns.attach(id);
        // the view detaches when the connection closes, and the turn goes on
        const detach = stream.subscribe({
          write: (frame) => {
            res.write(sseFrame(frame));
          },
          end: () => {
            res.end();
          },
        });
        res.on("close", detach);
        return true;
      }
      case "steer": {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]), true;
        if (!service.store.get(id)) throw new RuntimeError(404, "That session does not exist.", "not_found");
        const body = await jsonBody(req);
        const steerId = body.id;
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (typeof steerId !== "string" || !/^[A-Za-z0-9_-]+$/.test(steerId) || !text) throw badRequest("A steer needs an identifier and text.");
        if (!service.turns.steer(id, { id: steerId, text })) {
          sendJson(res, 409, { error: "No turn is running, so the message cannot be steered. Send it as a normal message." });
          return true;
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
      case "dismiss": {
        if (method !== "POST") return methodNotAllowed(res, ["POST"]), true;
        const body = await jsonBody(req);
        if (typeof body.toolCallId !== "string" && typeof body.problemCallId !== "string") throw badRequest("Give a toolCallId or a problemCallId.");
        const { parked } = service.turns.dismiss(id, { toolCallId: body.toolCallId, problemCallId: body.problemCallId });
        sendJson(res, parked ? 202 : 200, { ok: true, parked });
        return true;
      }
      case "settings": {
        if (method !== "PUT") return methodNotAllowed(res, ["PUT"]), true;
        sendJson(res, 200, { session: service.setSettings(id, await jsonBody(req)) });
        return true;
      }
      case "markdown": {
        if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
        const out = service.markdown(id);
        const body = Buffer.from(out.body, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${out.fileName}"`,
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(body);
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    sendRuntimeError(res, e);
    return true;
  }
}

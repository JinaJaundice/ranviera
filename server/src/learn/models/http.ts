// Routes 1 to 12 of docs/CONTRACTS.md ("Routes"): models, keys, Claude Code status,
// the custom endpoint and settings. handleModels returns true when it handled the
// route. Claude adds one call to it in server/src/learn/http.ts at merge.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LearnSettings } from "../../../../shared/learn/models.ts";
import { HttpError, originAllowed, readBody, sendJson } from "../../util.ts";
import { LearnError, badRequest, errorEnvelope } from "./errors.ts";
import type { ModelsService } from "./index.ts";
import { sanitiseSettings, stampClaudeCode } from "./settings.ts";
import { validateModelsSection } from "./slots.ts";

const BODY_LIMIT = 64 * 1024;
const PREFIX = "/api/learn/";

function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  res.setHeader("Allow", allow.join(", "));
  sendJson(res, 405, { error: `This route accepts ${allow.join(" and ")} only.` });
}

/** Reads a JSON object of at most 64 KiB. A body that is not JSON answers 415. */
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new LearnError(415, "unsupported_media_type", "The request body must be sent as application/json.");
  let text: string;
  try {
    text = await readBody(req, BODY_LIMIT);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw new LearnError(413, "too_large", "The request body is larger than 64 KiB.");
    throw e;
  }
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw badRequest("The request body must be a JSON object.");
}

/** A mutation of the custom endpoint must come from the server's own origin. */
function checkOrigin(req: IncomingMessage): void {
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  if (site === "cross-site" || !originAllowed(typeof origin === "string" ? origin : undefined, req.headers.host)) {
    throw new LearnError(403, "forbidden_origin", "The request did not come from this application, so the endpoint was not changed.");
  }
}

const ifMatch = (req: IncomingMessage) => (typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined);

// the query is part of the shared handler signature, and no route of the model layer reads it
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function handleModels(service: ModelsService, req: IncomingMessage, res: ServerResponse, path: string, _query: URLSearchParams): Promise<boolean> {
  if (!path.startsWith(PREFIX)) return false;
  const rest = path.slice(PREFIX.length).replace(/\/+$/, "");
  const parts = rest.split("/");
  const head = parts[0];
  const handled = ["models", "keys", "claude-code", "custom-provider", "settings"].includes(head);
  if (!handled) return false;
  const method = req.method ?? "GET";
  try {
    if (head === "models" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      sendJson(res, 200, await service.catalog());
      return true;
    }

    if (head === "keys" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      sendJson(res, 200, { keys: service.keys.list(), providers: service.keys.providers() });
      return true;
    }
    if (head === "keys" && parts.length === 2) {
      const id = decodeURIComponent(parts[1]);
      if (method === "PUT") {
        const body = await jsonBody(req);
        const status = service.keys.save(id, body.value);
        service.emit("models-changed");
        sendJson(res, 200, status);
        return true;
      }
      if (method === "DELETE") {
        const status = service.keys.remove(id);
        service.emit("models-changed");
        sendJson(res, 200, status);
        return true;
      }
      return methodNotAllowed(res, ["PUT", "DELETE"]), true;
    }

    if (head === "claude-code" && parts.length === 1) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]), true;
      sendJson(res, 200, await service.claudeCodeStatus());
      return true;
    }

    if (head === "custom-provider" && parts.length === 1) {
      if (method === "GET") {
        res.setHeader("ETag", service.custom.etag());
        sendJson(res, 200, service.custom.state());
        return true;
      }
      if (method === "POST" || method === "PATCH" || method === "DELETE") {
        checkOrigin(req);
        const state =
          method === "DELETE"
            ? await service.custom.disconnect(ifMatch(req))
            : method === "POST"
              ? await service.custom.connect(await jsonBody(req), ifMatch(req))
              : await service.custom.pins(await jsonBody(req), ifMatch(req));
        res.setHeader("ETag", service.custom.etag());
        sendJson(res, 200, state);
        return true;
      }
      return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]), true;
    }

    if (head === "settings" && parts.length === 1) {
      if (method === "GET") {
        sendJson(res, 200, service.settings.read());
        return true;
      }
      if (method === "PUT") {
        const body = await jsonBody(req);
        const current = service.settings.read();
        const next = sanitiseSettings(body);
        // the custom endpoint is written only by its own routes, because its binding lives in the keys file
        const merged: LearnSettings = { ...next };
        if (current.customProvider) merged.customProvider = current.customProvider;
        else delete merged.customProvider;
        const written = service.settings.write(stampClaudeCode(current, merged, service.now().toISOString()));
        service.emit("settings-changed");
        service.emit("models-changed");
        sendJson(res, 200, written);
        return true;
      }
      return methodNotAllowed(res, ["GET", "PUT"]), true;
    }
    if (head === "settings" && parts.length === 2 && parts[1] === "models") {
      if (method !== "PUT") return methodNotAllowed(res, ["PUT"]), true;
      const body = await jsonBody(req);
      const current = service.settings.read();
      service.registry.sync();
      const section = validateModelsSection(body, current.models, service.registry);
      const next = { ...current };
      if (Object.keys(section).length > 0) next.models = section;
      else delete next.models;
      const written = service.settings.write(next);
      service.emit("settings-changed");
      service.emit("models-changed");
      sendJson(res, 200, written.models ?? {});
      return true;
    }
    return false;
  } catch (e) {
    const { status, body } = errorEnvelope(e);
    sendJson(res, status, body);
    return true;
  }
}

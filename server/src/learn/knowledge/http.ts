// HTTP handler of the knowledge core: routes 30, 34, 35, 36, 37, 47, 48, 49,
// 50 and 51 of docs/CONTRACTS.md ("Routes"). It returns true when it handled the route.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocatorLine } from "../../../../shared/learn/sources.ts";
import { HttpError, sendJson } from "../../util.ts";
import type { Knowledge } from "./index.ts";
import { KnowledgeError, badRequest, checkId, notFound } from "./errors.ts";
import { isSensitivity } from "./ledger.ts";
import { parseSelection } from "./deletion.ts";
import { isLocator } from "../extract/merge-run.ts";
import { ORGANIZATION_BODY_LIMIT, parseAction } from "./organization.ts";
import { parseRatify } from "./ratify.ts";

const DEFAULT_BODY_LIMIT = 1024 * 1024;

/** Reads a body, measured on the bytes actually read. The stream stops once the total passes the limit. */
function readBounded(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        // later chunks are read and dropped, so that the answer can reach the client
        reject(new KnowledgeError(413, "too_large", `The request body is larger than ${Math.round(limit / 1024)} KiB.`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

async function readBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  const text = await readBounded(req, limit);
  if (!text.trim()) return {};
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().includes("json")) {
    throw new KnowledgeError(415, "unsupported_media_type", "The request body must be JSON.");
  }
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw badRequest("The request body must be a JSON object.");
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  sendJson(res, 405, { error: `This route accepts ${allowed.join(" and ")} only.` });
}

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof KnowledgeError) {
    sendJson(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra });
  } else if (e instanceof HttpError) {
    sendJson(res, e.status, { error: e.message });
  } else {
    sendJson(res, 500, { error: e instanceof Error ? e.message : "The request failed." });
  }
}

export async function handleKnowledge(
  service: Knowledge,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  const p = path.replace(/\/+$/, "");
  const method = req.method ?? "GET";
  const node = /^\/api\/learn\/graph\/nodes\/([^/]+)$/.exec(p);
  const known = [
    "/api/learn/graph",
    "/api/learn/graph/positions",
    "/api/learn/graph/render-settings",
    "/api/learn/graph/ratify",
    "/api/learn/source-organization",
    "/api/learn/locators",
  ];
  if (!known.includes(p) && !node) return false;
  const refuse = (allowed: string[]): boolean => {
    methodNotAllowed(res, allowed);
    return true;
  };
  try {
    if (p === "/api/learn/graph") {
      if (method !== "GET") return refuse(["GET"]);
      const max = query.get("max");
      if (max !== null && !isSensitivity(max)) throw badRequest("The max parameter must be public, internal or client-confidential.");
      sendJson(res, 200, service.snapshot(max ?? undefined));
    } else if (p === "/api/learn/graph/positions") {
      if (method !== "PUT") return refuse(["PUT"]);
      const body = await readBody(req);
      sendJson(res, 200, { positions: service.commitPositions(body.positions) });
    } else if (p === "/api/learn/graph/render-settings") {
      if (method === "GET") sendJson(res, 200, service.readRenderSettings());
      else if (method === "PUT") sendJson(res, 200, service.writeRenderSettings(await readBody(req)));
      else return refuse(["GET", "PUT"]);
    } else if (node) {
      if (method !== "DELETE") return refuse(["DELETE"]);
      let id: string;
      try {
        id = checkId(decodeURIComponent(node[1]), "identifier");
      } catch (e) {
        if (e instanceof KnowledgeError) throw e;
        throw badRequest("The identifier is not valid.");
      }
      const done = service.deleteNode(id);
      if (!done) throw notFound("No proposition or argument has that identifier.");
      sendJson(res, 200, done);
    } else if (p === "/api/learn/locators") {
      if (method !== "GET") return refuse(["GET"]);
      const id = checkId(query.get("node"), "node");
      service.store.assertReadable();
      // the newest line for each pair of node and source, as the card keeps it
      const newest = new Map<string, LocatorLine>();
      for (const l of service.store.readLedger<LocatorLine>(service.store.cortexFile("locators.jsonl"), isLocator)) {
        if (l.nodeId !== id) continue;
        const prior = newest.get(l.sourceId);
        if (!prior || l.at >= prior.at) newest.set(l.sourceId, l);
      }
      sendJson(res, 200, { locators: [...newest.values()] });
    } else if (p === "/api/learn/graph/ratify") {
      if (method !== "POST") return refuse(["POST"]);
      sendJson(res, 200, await service.ratify(parseRatify(await readBody(req))));
    } else {
      if (method === "GET") sendJson(res, 200, service.directory());
      else if (method === "POST") {
        const done = service.organize(parseAction(await readBody(req, ORGANIZATION_BODY_LIMIT)));
        sendJson(res, 200, done);
      } else if (method === "DELETE") {
        const done = service.deleteBySelection(parseSelection(await readBody(req, ORGANIZATION_BODY_LIMIT)));
        sendJson(res, 200, { directory: done.directory, graphRevision: done.graphRevision });
      } else return refuse(["GET", "POST", "DELETE"]);
    }
  } catch (e) {
    fail(res, e);
  }
  return true;
}


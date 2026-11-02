// Router for /api/learn/*. The source of truth is docs/CONTRACTS.md, section
// "Learning and knowledge (1 November 2026)" ("Routes"). Each phase answers its
// routes in its own handler module, for example models/http.ts, and this file
// only hands the request to each handler in turn. server/src/api.ts holds the one
// branch for the prefix.
//
// Route (number, method and path): phase
//   1 GET /api/learn/models: 1
//   2 GET /api/learn/keys: 1
//   3 PUT /api/learn/keys/:id: 1
//   4 DELETE /api/learn/keys/:id: 1
//   5 GET /api/learn/claude-code: 1
//   6 GET /api/learn/custom-provider: 1
//   7 POST /api/learn/custom-provider: 1
//   8 PATCH /api/learn/custom-provider: 1
//   9 DELETE /api/learn/custom-provider: 1
//  10 GET /api/learn/settings: 1
//  11 PUT /api/learn/settings: 1
//  12 PUT /api/learn/settings/models: 1
//  13 GET /api/learn/prompts: 8
//  14 PUT /api/learn/prompts/<key>: 8
//  15 DELETE /api/learn/prompts/<key>: 8
//  16 GET /api/learn/sessions: 7
//  17 POST /api/learn/sessions: 7
//  18 GET /api/learn/sessions/:id: 7
//  19 PUT /api/learn/sessions/:id: 7
//  20 DELETE /api/learn/sessions/:id?mode=<mode>: 7
//  21 POST /api/learn/sessions/:id/input: 7
//  22 GET /api/learn/sessions/:id/stream: 7
//  23 POST /api/learn/sessions/:id/steer: 7
//  24 POST /api/learn/sessions/:id/dismiss: 7
//  25 PUT /api/learn/sessions/:id/settings: 7
//  26 GET /api/learn/sessions/:id/markdown: 7
//  27 GET /api/learn/jobs?sessionId=<id>: 10
//  28 GET /api/learn/activity: 7
//  29 POST /api/learn/activity/abort: 7
//  30 GET /api/learn/graph?max=<sensitivity>: 2
//  31 GET /api/learn/graph/status: 5
//  32 GET /api/learn/graph/costs: 5
//  33 POST /api/learn/graph/extract: 5
//  34 PUT /api/learn/graph/positions: 2
//  35 GET /api/learn/graph/render-settings: 2
//  36 PUT /api/learn/graph/render-settings: 2
//  37 DELETE /api/learn/graph/nodes/:id: 2
//  38 GET /api/learn/passage?source=<id>&from=<n>&to=<n>: 4
//  39 GET /api/learn/outcomes?node=<id>: 8
//  40 GET /api/learn/sources: 4
//  41 POST /api/learn/sources: 4
//  42 PATCH /api/learn/sources/:rootId: 4
//  43 DELETE /api/learn/sources/:rootId?mode=<mode>: 4
//  44 POST /api/learn/sources/:rootId/scan: 4
//  45 POST /api/learn/sources/:rootId/extract: 5
//  46 GET /api/learn/sources/:rootId/files: 4
//  47 GET /api/learn/source-organization: 2
//  48 POST /api/learn/source-organization: 2
//  49 DELETE /api/learn/source-organization: 2
//  50 POST /api/learn/graph/ratify: 2
//  51 GET /api/learn/locators?node=<id>: 2

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "../api.ts";
import { sendJson } from "../util.ts";
import { handleExtract } from "./extract/http.ts";
import { handleJobs } from "./jobs/index.ts";
import { handleKnowledge } from "./knowledge/http.ts";
import { handleMethod } from "./method/index.ts";
import { handleModels } from "./models/http.ts";
import { handleSessions } from "./runtime/index.ts";
import { handleSources } from "./sources/http.ts";

/**
 * Handles one request under /api/learn/. Each phase's handler answers the routes it owns and returns false for the
 * others, so the order below decides nothing but speed. A path that no handler takes answers 404.
 */
export async function handleLearn(ctx: Context, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const learn = ctx.learn;
  if (!learn) {
    sendJson(res, 404, { error: "Learning is switched off in this installation.", code: "not_found" });
    return;
  }
  if (learn.readOnly && (req.method ?? "GET") !== "GET") {
    sendJson(res, 409, { error: "Another process of this app is writing the learning folder. This one is read only until it ends.", code: "busy" });
    return;
  }
  if (await handleModels(learn.models, req, res, path, query)) return;
  if (await handleExtract(learn.extract, req, res, path)) return;
  if (await handleSources(learn.sources, req, res, path, query)) return;
  if (await handleJobs(learn.jobs, req, res, path)) return;
  if (await handleKnowledge(learn.knowledge, req, res, path, query)) return;
  if (await handleSessions(learn.sessions, req, res, path, query)) return;
  if (await handleMethod(learn.method, req, res, path, query)) return;
  sendJson(res, 404, { error: `The learning route ${path} is not available in this build.`, code: "not_found" });
}

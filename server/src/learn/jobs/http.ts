// Route 27 of docs/CONTRACTS.md ("Routes"): GET /api/learn/jobs?sessionId=<id>. The answer is the jobs of the session
// and whether a turn is in flight, and the read runs the stale job sweep. The handler returns true when it answered
// and false when the path is not its route.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../util.ts";
import { sendRuntimeError } from "../runtime/errors.ts";
import type { JobsService } from "./service.ts";

export async function handleJobs(service: JobsService, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path.replace(/^\/api\/learn(?=\/)/, "") !== "/jobs") return false;
  try {
    if ((req.method ?? "GET") !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "This route accepts GET only." });
      return true;
    }
    const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
    sendJson(res, 200, service.list(sessionId));
  } catch (e) {
    sendRuntimeError(res, e);
  }
  return true;
}

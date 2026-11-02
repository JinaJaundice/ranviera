// Errors of the learning runtime. A RuntimeError carries the status and the
// envelope of CONTRACTS.md ("Error envelopes"), so that a handler can answer
// with it unchanged.
import type { ServerResponse } from "node:http";
import type { LearnErrorBody, LearnErrorCode } from "../../../../shared/learn/index.ts";
import { HttpError, sendJson } from "../../util.ts";

export class RuntimeError extends Error {
  status: number;
  body: LearnErrorBody;
  constructor(status: number, message: string, code?: LearnErrorCode, extra: Partial<LearnErrorBody> = {}) {
    super(message);
    this.status = status;
    this.body = { error: message, ...(code ? { code } : {}), ...extra };
  }
}

export const badRequest = (message: string) => new RuntimeError(400, message, "bad_request");
export const notFound = (message: string) => new RuntimeError(404, message, "not_found");
export const turnRunning = () =>
  new RuntimeError(409, "A turn is already running for this session. Wait for it to finish or stop it first.", "turn_running");

/** Answers a request with the envelope of an error, whatever its kind. */
export function sendRuntimeError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof RuntimeError) return sendJson(res, err.status, err.body);
  if (err instanceof HttpError) {
    const code: LearnErrorCode | undefined = err.status === 413 ? "too_large" : err.status === 400 ? "bad_request" : undefined;
    return sendJson(res, err.status, { error: err.message, ...(code ? { code } : {}) });
  }
  sendJson(res, 500, { error: err instanceof Error && err.message ? err.message : "The request could not be completed." });
}

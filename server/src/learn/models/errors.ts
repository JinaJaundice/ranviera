// Error envelopes of the model layer. The source of truth is docs/CONTRACTS.md,
// section "Learning and knowledge (1 November 2026)" ("Error envelopes").
import { HttpError } from "../../util.ts";

/** An HTTP failure that carries a machine readable code and extra fields for the envelope. */
export class LearnError extends HttpError {
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(status, message);
    this.code = code;
    this.extra = extra;
  }
  /** The JSON body: the sentence, the code and the extra fields. */
  body(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

export const badRequest = (message: string) => new LearnError(400, "bad_request", message);
export const notFound = (message: string) => new LearnError(404, "not_found", message);

/** Turns any thrown value into a status and a JSON body. */
export function errorEnvelope(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof LearnError) return { status: e.status, body: e.body() };
  if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
  const message = e instanceof Error && e.message ? e.message : "The request could not be completed.";
  return { status: 500, body: { error: message } };
}

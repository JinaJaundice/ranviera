// Errors of the sources area. They carry the machine readable code of the error envelopes in docs/CONTRACTS.md ("Error envelopes").
import { HttpError } from "../../util.ts";

export class SourceError extends HttpError {
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(status, message);
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message: string) => new SourceError(400, "bad_request", message);
export const notFound = (message: string) => new SourceError(404, "not_found", message);
export const tooLarge = (message: string) => new SourceError(413, "too_large", message);

/** The refusal of a path on the deny list. The text never says which rule applied. */
export const forbiddenPath = () => new SourceError(403, "forbidden_path", "That path is not available to this app.");

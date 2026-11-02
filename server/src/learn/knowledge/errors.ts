// Errors of the knowledge core. The status and code follow the error
// envelopes of docs/CONTRACTS.md ("Error envelopes").

export class KnowledgeError extends Error {
  status: number;
  code: string | undefined;
  extra: Record<string, unknown>;
  constructor(status: number, code: string | undefined, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function badRequest(message: string): KnowledgeError {
  return new KnowledgeError(400, "bad_request", message);
}

export function notFound(message: string): KnowledgeError {
  return new KnowledgeError(404, "not_found", message);
}

export function extractionRunning(): KnowledgeError {
  return new KnowledgeError(409, "extraction_running", "An extraction is running. Wait for it to finish, or stop it, and then try again.");
}

/** The identifier rule of the conventions: letters, digits, underscore and hyphen only. */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function checkId(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw badRequest(`The ${what} must use letters, digits, underscores and hyphens only.`);
  }
  return value;
}

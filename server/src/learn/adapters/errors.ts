// Turns the refusal of the model layer into the error that the runtime handlers answer with. A LearnError extends
// HttpError, whose envelope in the runtime handler drops the code, so the resolver throws a RuntimeError instead.
import type { LearnErrorBody, LearnErrorCode } from "../../../../shared/learn/index.ts";
import { LearnError } from "../models/errors.ts";
import { RuntimeError } from "../runtime/errors.ts";

export function toRuntimeError(e: unknown): unknown {
  if (e instanceof LearnError) return new RuntimeError(e.status, e.message, e.code as LearnErrorCode, e.extra as Partial<LearnErrorBody>);
  return e;
}

/** Runs a function and converts a LearnError that it throws. */
export function converting<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw toRuntimeError(e);
  }
}

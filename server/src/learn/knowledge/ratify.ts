// Route 50: ratifying a claim. The assertions of one claim are written through an
// injected function, and the graph is rebuilt through another, so that this
// module holds no knowledge of the harness files. docs/CONTRACTS.md, "Routes".

import type { RatifyClaim } from "../../../../shared/learn/knowledge.ts";
import { badRequest } from "./errors.ts";

export interface RatifyDeps {
  /** writes the assertions of the claim and returns how many it wrote */
  writeAssertions: (claim: RatifyClaim) => number | Promise<number>;
  /** rebuilds the graph after the assertions are written */
  rebuild: () => void | Promise<void>;
  /** the graph revision after the rebuild */
  revision: () => number;
}

const CLAIM = /^claim:[0-9a-f]{12}$/;

/** Reads and checks the body of POST /api/learn/graph/ratify. A reason is required for rejected. */
export function parseRatify(body: Record<string, unknown>): RatifyClaim {
  const claim = body.claim;
  if (typeof claim !== "string" || !CLAIM.test(claim)) throw badRequest("The claim must be an identifier of the form claim: followed by 12 hexadecimal characters.");
  const status = body.status;
  if (status !== "ratified" && status !== "rejected") throw badRequest("The status must be ratified or rejected.");
  const reason = body.reason;
  if (reason !== undefined && typeof reason !== "string") throw badRequest("The reason must be a text.");
  if (status === "rejected" && (typeof reason !== "string" || reason.trim() === "")) {
    throw badRequest("A rejection needs a reason.");
  }
  return typeof reason === "string" && reason.trim() !== "" ? { claim, status, reason: reason.trim() } : { claim, status };
}

export class Ratifier {
  private chain: Promise<unknown> = Promise.resolve();

  private readonly deps: RatifyDeps;

  constructor(deps: RatifyDeps) {
    this.deps = deps;
  }

  /** One ratification at a time, so that two rebuilds never overlap. */
  ratify(claim: RatifyClaim): Promise<{ assertions: number; graphRevision: number }> {
    const run = async (): Promise<{ assertions: number; graphRevision: number }> => {
      const assertions = await this.deps.writeAssertions(claim);
      await this.deps.rebuild();
      return { assertions, graphRevision: this.deps.revision() };
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}

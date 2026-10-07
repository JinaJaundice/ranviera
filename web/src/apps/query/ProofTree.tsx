import { useState } from "react";
import type { InferredFact, InferredRule, ProofNode } from "@shared/types";
import { useStore } from "../../lib/store";
import { Button } from "../../components/Button";
import { NodeChip } from "../../components/NodeChip";
import { MAX_DEPTH, factWords, negatedFact } from "./format";

/** A fact in plain words, with a NodeChip for each node id. */
export function FactText({ fact }: { fact: string }) {
  const byId = useStore((s) => s.byId);
  const segs = factWords(fact, (id) => byId.has(id));
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1 text-body text-ink">
      {segs.map((s, i) => (s.kind === "node" ? <NodeChip key={i} id={s.id} /> : <span key={i}>{s.text}</span>))}
    </span>
  );
}

function Level({ node, rules, depth }: { node: ProofNode; rules: InferredRule[]; depth: number }) {
  const message = node.rule ? rules.find((r) => r.id === node.rule)?.message : undefined;
  const absent = negatedFact(node.fact);
  return (
    <li className="min-w-0">
      {absent ? (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-body text-ink">
          <span className="text-hold">absent from the graph:</span>
          <FactText fact={absent} />
        </span>
      ) : (
        <FactText fact={node.fact} />
      )}
      <p className="text-small text-ink-faint">
        {absent ? (
          "this rule requires that the fact does not hold"
        ) : node.rule ? (
          <>
            by rule <span className="font-mono">{node.rule}</span>
            {message ? `. ${message}` : ""}
          </>
        ) : (
          "given in the graph"
        )}
      </p>
      {node.children.length ? (
        depth >= MAX_DEPTH ? (
          <p className="ml-3 border-l border-rule pl-3 text-small text-hold">
            The proof continues beyond {MAX_DEPTH} levels, which are not shown.
          </p>
        ) : (
          <ul className="ml-3 mt-1 space-y-2 border-l border-rule pl-3">
            {node.children.map((c, i) => (
              <Level key={i} node={c} rules={rules} depth={depth + 1} />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

/** The proof of one fact as a nested list, cut at 8 levels. */
export function ProofTree({ proof, rules }: { proof: ProofNode; rules: InferredRule[] }) {
  return (
    <ul className="min-w-0">
      <Level node={proof} rules={rules} depth={1} />
    </ul>
  );
}

/** One inferred fact in plain words, with a toggle that shows how the engine derived it. */
export function FactRow({ fact, rules }: { fact: InferredFact; rules: InferredRule[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0 border-t border-rule py-2 first:border-t-0">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <FactText fact={fact.key} />
        <Button variant="ghost" className="h-6 shrink-0 px-2 text-small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide explanation" : "Explain"}
        </Button>
      </div>
      {open ? (
        <div className="mt-2">
          {fact.proof ? (
            <ProofTree proof={fact.proof} rules={rules} />
          ) : (
            <p className="text-small text-ink-faint">No proof was recorded for this fact, because tracing failed or reached its limit.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

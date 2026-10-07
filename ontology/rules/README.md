# Cortex rules

This folder holds the Datalog rules that Cortex runs over its knowledge graph, in the syntax of Nemo (TU Dresden). `kg/cortex_kg/reason.py` loads every `*.rls` file here, adds the facts of the compiled graph and writes the results to `inferred.json` and `inferred.ttl` in the data folder. `docs/REASONING.md` describes the layer and lists the first rule set.

## Format

A header line gives the identifier, the kind and the message of a rule, and every statement after it, up to the next header, belongs to that rule and must derive one of the outputs:

```
%% R04 | violation | Two active rules conflict and neither a later date given in brackets nor a decision that governs both rules settles which of them applies.
violation("R04", ?A) :- conflict(?A, ?B), active(?A), active(?B), ~overrides(?A, ?B), ~overrides(?B, ?A), ~decided(?A, ?B) .
```

- The kinds are `violation`, `warning` and `info`, which become findings with the identifier as the check, and `inference`, which derives a fact that is kept and explained but is not a finding.
- A finding is the fact `violation(Id, Node)`, `warning(Id, Node)` or `info(Id, Node)`. An inferred edge is the fact `inferred(S, "relation", T)`.
- Statements before the first header are helpers. The run names them H01, H02 and so on in order, records them in `inferred.json` under `helpers`, and a proof names them by that identifier. A helper statement placed after a header, or an output statement without a header, is refused and the run reports finding B03.
- The message is one plain sentence in the register of `~/.claude/rules/writing.md`.

## Facts

| Predicate | Meaning |
|---|---|
| `node(Id, Class)` | a node and its class |
| `edge(S, Relation, T)` | an edge of provenance stated, computed or ratified (an edge with no provenance counts as stated), so a proposed edge and an edge that an earlier run inferred feed no rule |
| `status(Id, Status)` | the status of a node, or the term status of a concept |
| `day(Id, Day)` | the date of a node as an integer such as 20260929, kept only where it is a real calendar date |
| `stated_day(Id, Day)` | the same date where the node gives it in brackets (`props.dateSource` is `bracketed`, or the bracketed date in the text matches). R03, R04 and R07 order by this date only |
| `sensitivity(Id, Level)` | the sensitivity of a node, exported for rule authors and read by no rule at present |
| `uses(Id, N)` and `idle(Id, Days)` | the recorded uses, and the days since the last one where there is one |
| `observed(Days)` | the days from the first recorded event to the run date, where an event store exists |

## Helper predicates in `cortex.rls`

`inactive`, `active`, `decided` (one decision governs both rules of a conflicting pair), `contains_t` (the transitive closure of `contains`), `read_first`, `routed`, `pointed`, `conflict` (symmetric), `overrides`, `supersedes_t` and `mentioned`.

Each negated atom of a rule body is recorded in the proof as a child with the fact `not <atom>` and the rule `absent from the graph`. `reason.py` checks each child against the rows of the engine (or the facts given to it, for an input predicate) and refuses to record an absence that the engine contradicts.

## Inferred relations

`restates`, `supersedesChain`, `overrides` and `appliesToTask` are inferred. An inferred edge joins the graph only where its relation has a weight in `ontology/weights.json`. The proposed weights are in the result of the build that added this layer, and they are not yet in that file.

## Strings and limits

Nemo reads `\` as an escape, so `reason.py` doubles every backslash, writes a string that holds a quote in the triple-quoted form, and passes the facts through CSV files because Nemo loads and traces them much faster than the same facts as program text. Nemo cannot compare strings with `<` or `>`, so a rule that orders by date uses the integer `day`.

## Changes to this file

- 6 October 2026: first version.
- 6 October 2026 (after the rigour audit): provenance filter on edges, `stated_day`, `observed`, helper identifiers, negated atoms in proofs, R05 limited to active rules, R09 redefined, R13 added and `archival` removed.

# Ranviera reasoning

This document sets out how Ranviera reasons over its knowledge graph, following the pattern of RDFox from Oxford Semantic Technologies. RDFox keeps every inferred fact materialised, writes its rules in Datalog with negation, explains each inferred fact with a proof tree and answers queries in SPARQL. Ranviera reproduces that pattern with 2 open engines, because RDFox needs a time-limited licence key that a product distributed to other people could not hold.

## Engines

| Job | Engine | Version | Licence |
|---|---|---|---|
| Rules, materialisation and proof trees | Nemo (`nmo_python`), TU Dresden | 0.10.1, pinned | MIT or Apache-2.0 |
| SPARQL queries in the server | Oxigraph (`oxigraph` on npm) | 0.5.11 | MIT or Apache-2.0 |
| Shapes | pySHACL | 0.40.1 | Apache-2.0 |

The Nemo Python bindings are marked experimental by their authors, so `kg/cortex_kg/reason.py` is the only module that imports them. Where Nemo is not installed, the build skips the reasoning step, records finding `B03` as a warning and carries on.

## Rules

The rules are kept in `ontology/rules/*.rls` in Nemo's syntax. Each rule is preceded by a header comment that gives its identifier, its kind and its message:

```
%% R04 | violation | Two active rules conflict and neither a later date given in brackets nor a decision that governs both rules settles which of them applies.
violation("R04", ?A) :- conflict(?A, ?B), active(?A), active(?B), ~overrides(?A, ?B), ~overrides(?B, ?A), ~decided(?A, ?B) .
```

The kinds `violation`, `warning` and `info` become findings in `health.json`, with the identifier as the check. The kind `inference` derives a fact that is kept and explained in `inferred.json` and never reported as a finding.

## Facts given to the rules

`reason.py` turns the compiled graph into the facts below. Identifiers and values are quoted strings, and dates are integers of the form 20260929 so that they compare as numbers. A date is parsed as a calendar date, and a value such as 2026-13-45 is dropped. The rules read only edges of provenance stated, computed or ratified, and an edge with no provenance counts as stated, so a proposed link never feeds a conclusion (see `CONTRACTS.md`, section 'Provenance and freshness').

| Predicate | Meaning |
|---|---|
| `node(?Id, ?Class)` | a node and its class, such as `node("rule:style-001", "Rule")` |
| `edge(?S, ?R, ?T)` | an edge of the graph with provenance stated, computed or ratified |
| `status(?Id, ?Status)` | the status of a node, where it has one |
| `day(?Id, ?Day)` | the date of a node as an integer, where it has one |
| `stated_day(?Id, ?Day)` | the date of a node where it gives the date in brackets. A date that the harvester took from elsewhere in the text may be one that the text only mentions, so the date rules use `stated_day` |
| `sensitivity(?Id, ?Level)` | the sensitivity of a node, exported for rule authors and read by no rule at present |
| `uses(?Id, ?N)` and `idle(?Id, ?Days)` | the number of recorded uses and the days since the last one, in the local zone of the run date |
| `observed(?Days)` | the days from the first recorded event to the run date, so that no recorded use can be told from no coverage |

## Results

The predicates `inferred(?S, ?R, ?T)`, `violation(?Check, ?Id)`, `warning(?Check, ?Id)` and `info(?Check, ?Id)` are the outputs. An `inferred` fact becomes an edge of the graph with `"inferred": true` when its relation is in `ontology/weights.json`, and every output fact is written to `inferred.json` in the data folder with its proof tree.

```ts
interface InferredFile {
  v: 1
  built: string
  today: string                  // the run date, one for the whole run
  inputs: { graph_built: string | null; graph_sha256: string | null }   // the graph that the rules read
  engine: { name: "nemo"; version: string } | null
  rules: { id: string; kind: "violation" | "warning" | "info" | "inference"; message: string; text: string }[]
  helpers: { id: string; text: string }[]   // H01 onwards, in the order of the rule files
  facts: InferredFact[]
}
interface InferredFact {
  key: string                    // eg 'violation("R04","rule:style-012")', the Nemo form of the fact
  rule: string                   // the identifier of the rule that derived it
  kind: string
  args: string[]
  proof: ProofNode | null        // null where tracing failed or was capped
}
interface ProofNode { fact: string; rule: string | null; children: ProofNode[] }   // rule null for a given fact, "absent from the graph" for a negated atom (fact "not <atom>")
```

A proof is traced for every finding and for up to 2,000 inferred edges, and each proof tree is cut at a depth of 8. Nemo lists the positive premises of a rule only. For that reason `reason.py` adds one child for each negated atom of the rule body, instantiated from the variable assignment of the trace, with the fact `not <atom>` and the rule `absent from the graph`. Before it is recorded, each child is checked against the rows of the engine for a derived predicate and against the facts given to it for an input predicate. A negation that the engine contradicts stops the run with finding B03. A proof step by a helper rule carries its identifier, such as H08.

`graph_sha256` is the sha256 of the canonical JSON of the nodes and of the edges that are not inferred, so that the `graph.json` on disk gives the same value as the graph in memory when the rules ran. `today` is the date given to `reason.run`, which is the build date or, for the reason command, the date of the run. The values `idle` and `observed` are counted from it. `reason.run` writes both inferred files to temporary files and renames them together, so that the two cannot disagree. It raises where it cannot write them, and the build records that failure as B05.

## Queries

The server loads `graph.trig` into an Oxigraph store at start and after each rebuild. `POST /api/sparql` runs a read-only query, which may be a SELECT, an ASK or a CONSTRUCT and never an UPDATE, with a limit of 5,000 rows and a timeout of 10 seconds. Each saved query is kept in `ontology/queries/*.rq` and starts with a comment line that gives its title.

## Rule set

The first rule set (`ontology/rules/cortex.rls`) holds these rules:

| Id | Kind | Rule |
|---|---|---|
| R01 | inference | `restates` is symmetric |
| R02 | inference | `supersedes` is transitive, kept as the relation `supersedesChain` |
| R03 | inference | Where 2 rules conflict and both give a date in brackets, the later one `overrides` the earlier one |
| R04 | violation | 2 active rules conflict and neither a later bracketed date nor a decision that governs both rules settles which applies. It reports both rules of the pair and covers rules only, so a conflict between 2 guide files is a domain check and not an R04 finding |
| R05 | inference | An active rule applies to a task type where the task reads first the file that contains it, directly or through a section, kept as the relation `appliesToTask`. A superseded, archived or retired rule applies to no task type |
| R06 | warning | A reference or guide file that no task type reads first and that no rule file or map file cites directly is not routed |
| R07 | warning | 2 rules that restate each other give different dates in brackets, so the older copy may be out of date |
| R08 | violation | A rule supersedes itself through a chain |
| R09 | warning | An active rule is superseded by another active rule but is not marked as superseded, so the older rule may still be applied |
| R10 | warning | An active project has had no recorded use for over 30 days |
| R11 | info | A ratified term denotes a node that no file mentions |
| R12 | warning | An instruction file that no route, task type or path scope reaches has had no recorded use |
| R13 | warning | An active project has no recorded use although the event store covers more than 30 days |

## Restatements

The `restates` links between the rule files and the reference files are computed from the text by `kg/cortex_kg/restate.py`. A rule-file bullet restates the reference bullet that holds at least half of its content words, where the 2 bullets also share at least a tenth of their combined words. Each computed link carries its score as evidence.

## Running the reasoning

`reason.run` changes the working folder of the process while Nemo runs, because Nemo 0.10.1 does not accept absolute Windows paths in its imports. It is therefore called only from the command line and the build, and never from a threaded server.

## Changes to this document

- 6 October 2026: first public version, written from the project's internal specification.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

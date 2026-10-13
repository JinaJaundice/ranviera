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

## Agent transparency rules

Rules O03 to O07 and O09 to O14 check the integrity of an agent, its instructions, its runs and its mappings, and they read agent side classes only. They are in `ontology/rules/transparency.rls`, and `cortex.rls` is untouched. Rules O01, O02 and O08 read a bank's obligation pack and are supplied with it. The rules read class identifiers and relation identifiers only. A proposed mapping, a rejected mapping and an inferred edge are not read, because the edge facts hold stated, computed and ratified edges only.

### Facts added

The facts of `cortex_kg/reason.py` remain. The reasoning step adds these, each a quoted string or an integer as before and each empty where the graph holds no such data, so that a rule that needs one gives no finding without it.

| Predicate | Meaning |
|---|---|
| `today(?Day)` | the run date of the reasoning, as an integer such as 20261007 |
| `valid_from(?Id, ?Day)` and `valid_to(?Id, ?Day)` | the interval of an instruction version. An open interval has no `valid_to`. |
| `hash(?Id, ?Hash)` | the current hash of an instruction version, clause, provision or knowledge source snapshot |
| `approved_hash(?Id, ?Hash)` | the hash recorded when the version was approved |
| `mapping_end(?M, ?End, ?Node)` and `anchor(?M, ?End, ?Hash)` | the 2 ends of a mapping, with `?End` equal to "s" or "t", and the hash that the mapping recorded at ratification |
| `end_hash(?M, ?End, ?Hash)` | the current hash of an end of a mapping, computed in the same form as the anchor. A mapping whose end is absent from the graph gives no `end_hash` fact. |
| `loaded_hash(?Run, ?Instr, ?Hash)` | the hash of an instruction that the running agent reported in its first record |
| `prompt_hash(?Run, ?Hash)`, `params_hash(?Run, ?Hash)` and `snapshot_hash(?Source, ?Hash)` | the replay inputs of a run, where recorded |
| `source_hash(?Evid, ?Hash)` | the hash of an evidence item at the time the agent read it |
| `steps_captured(?Run, ?N)` and `steps_reported(?Run, ?N)` | the steps held in the ledger and the count in the closing record of the run |
| `ledger_break(?Run)` | a run with a broken hash chain, from the result of `ledger verify` |
| `measure(?Agent, ?Kind, ?N)`, `bound_max(?Agent, ?Kind, ?N)` and `bound_min(?Agent, ?Kind, ?N)` | a monitoring measure in thousandths (kind `override`) or seconds (kind `review_seconds`) and the bounds that the bank set. Without a bounds file there are no bound facts and rule O13 gives no finding. |

An instruction version is in force on a date when its status is approved, its `valid_from` is on or before that date and its `valid_to` is absent or on or after it.

### Rules O03 to O07 and O09 to O14

| Id | Kind | Reads and reports |
|---|---|---|
| O03 | violation | 2 in-force instruction versions of one agent conflict (`conflictsWith`, read in both directions) and neither has an `overrides` edge to the other |
| O04 | violation | An `AgentDecision` has no informing step that cites an instruction, or no informing step that used evidence, or an informing step that cites an instruction that was not in context for that step |
| O05 | warning | A ratified `Mapping` has an anchor hash that differs from the current hash of its source or its target (`end_hash`) |
| O06 | violation | An in-force instruction version has no `approvedBy` edge, has the same person for `approvedBy` and `proposedBy`, or has a hash that differs from the approved hash |
| O07 | warning | A step has an instruction version in context whose interval ended before the date of the step or began after it |
| O09 | violation | The hash that a running agent reported for an instruction differs from the approved hash of that version |
| O10 | warning | A `Run` has no `ranOn` model, no prompt hash or no parameters hash, or has retrieved from a source with no snapshot hash, so it cannot be replayed |
| O11 | violation | A run has fewer captured steps than its closing record reported, or its ledger chain is broken |
| O12 | violation | A run used a model version outside the approved model versions of its agent. A model version of status pending, such as a provider change not yet reviewed, counts as unapproved. |
| O13 | warning | A measure of an agent, namely the override rate or the average review time, is above the maximum that the bank set or below its minimum |
| O14 | warning | An `Evidence` item has no `sourcedFrom` edge, or its recorded hash differs from the snapshot hash of its source, which flags a possible injection through retrieval |

Rules O13 and O14 compare counts and hashes and do not judge whether a decision was correct. Rule O14 flags a mismatch and does not prevent prompt injection.

### Findings in the graph

A finding of these rules has the class `cx:Finding` with the check `O03` to `O14` and the severity of its kind, as the existing findings do, and `health.json` carries it. A finding that names a Run, Step, Mapping or InstructionVersion appears on that node in the decision trace and the review queue. A bank that runs rules O01, O02 and O08 with its own obligation pack sets `include_private_graphs` (`CONTRACTS.md`) on its own machine.

## Changes to this document

- 7 October 2026: rules O03 to O07 and O09 to O14 for agent transparency, with the facts that they read.
- 6 October 2026: first public version, written from the project's internal specification.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

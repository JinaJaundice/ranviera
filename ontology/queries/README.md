# Saved SPARQL queries

This folder holds the saved queries that the Query window lists. The server reads each `.rq` file when `GET /api/queries` is called, and uses the file name without its extension as the identifier and the text of the first comment line as the title. A query must be read-only, because the server refuses INSERT, DELETE, LOAD, CLEAR, CREATE, DROP, ADD, MOVE, COPY and WITH.

The queries run over `graph.trig` in the data folder, an RDF 1.1 dataset with one named graph for each kind of fact (`docs/CONTRACTS.md`). The server answers over the union of the named graphs by default, and a query selects a graph with `GRAPH <...>`. A query that reads a relation names the graphs it trusts: the stated and ratified graphs for asserted relations, so that a proposed link never counts, and the inferred graph for `cx:appliesToTask` and `cx:overrides`. The graph IRIs are `https://cortex.local/graph/ontology`, `stated`, `ratified`, `proposed` and `inferred`.

The prefixes are `cx:` for classes and properties (`https://cortex.local/ont#`), `cxi:` for instances (`https://cortex.local/id/`), `rdfs:` and `skos:`. An instance IRI is written in full, as in `<https://cortex.local/id/task/deck>`, because a prefixed name with an escaped slash is hard to read and to copy into another store.

## Queries and the graph of 6 October 2026

A query that asks what applies leaves out a rule with the status superseded or retired, and a rule that a stated or ratified `cx:supersedes` edge replaces. The row counts were taken with Oxigraph on a fresh build of 6 October 2026 (graph.trig, with the union of the named graphs as the default graph).

| File | What it returns | Rows |
|---|---|---|
| `rules-for-deck-task.rq` | rules in force for the deck task, through `cx:appliesToTask` or through the files that the task reads first, with the section that holds each rule | 227 |
| `conflicts-and-overrides.rq` | pairs of conflicting rules in force, with the dates they state and the rule that overrides, where `cx:overrides` has been inferred | 0 |
| `superseded-but-read-first.rq` | superseded rules and files that a task type still reads first, leaving out a rule filed under a heading for superseded, archived or retired rules | 0 |
| `unrouted-reference-files.rq` | reference and guide files that no task type reads first | 4 |
| `most-used-instruction-files.rq` | instruction files ranked by the rules they hold and the task types that read them first | 32 |
| `projects-by-status.rq` | every project with its status and summary | 45 |
| `terms-with-forms-to-avoid.rq` | concepts that have hidden labels, with the forms to avoid | 64 |
| `agents-and-task-types.rq` | each agent with its model and the task types that it handles | 6 |
| `hooks-and-tools.rq` | each hook with its event, matcher and the tool it invokes | 17 |
| `decisions-and-what-they-govern.rq` | each decision with the rule or file that it governs | 26 |

## Notes

- `most-used-instruction-files.rq` ranks by rules held and by readers, and shows `cx:uses` where the node carries it.
- `conflicts-and-overrides.rq` returns 0 rows on the fresh build, because both conflicts (`rule:visuals-012` with `rule:decks-011`, and `guide:humaniser` with `guide:fca-register`) are proposed assertions and the query reads the stated and ratified graphs only. The text of each rule is optional, so that a pair of guide files, which have no `cx:text`, is kept once the pair is ratified. The query shows an empty `overrides` column until the rules in `ontology/rules/` have run and written the inferred graph.
- `rules-for-deck-task.rq` returns rules before and after reasoning, because its first branch reads the inferred graph and its second the files that the task reads first. The filter that leaves out a superseded or retired rule stands after the union, so it covers both branches. It takes the count from 252 on the graph of the rigour audit to 227, and rule R05 no longer derives `cx:appliesToTask` for a superseded rule.
- A hook with no `cx:invokes` edge appears with an empty tool column. That is the condition that check S06 reports.
- `superseded-but-read-first.rq` returned 66 rows on the graph of the rigour audit, and every row came from the section 'Superseded rules', which keeps replaced rules as a record on purpose. The query now leaves out that section, so 0 rows means that no task type reads a superseded rule from a live section. The test `test_superseded_query_lists_a_stale_rule_and_leaves_out_the_archive_section` holds both cases.
- `kg/tests/test_ontology.py` runs every query on a small graph built for it and fails on a query that returns no row, which the counts above cannot show on their own.

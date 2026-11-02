# Learning folder format

This reference describes the folder that the readers open. It follows the contract of Ranviera, "Learning and knowledge", and is written for a reader of the files. The format is version 1. Identifiers use letters, digits, underscore and hyphen only. Times are ISO 8601 in UTC, except `timestamp` of a message and `startedAt` of a usage record, which are milliseconds since 1970. The learning folder is `~/.claude/cortex/learn` or, where only that exists, `~/.claude/ranviera/learn`.

## Folder map

| Path | Content |
|---|---|
| `chats/<id>.json` | one session record |
| `graph/format.json` | `{"version": 1}`. An absent file means version 1 |
| `graph/nodes.jsonl` | proposition lines, an id may repeat |
| `graph/chains.jsonl` | argument lines |
| `graph/sources.json` | source records keyed by id |
| `graph/sessions.jsonl` | extraction checkpoints of sources, not an index of sessions |
| `graph/coverage.jsonl` | fingerprints of covered session messages, not an assessment |
| `graph/positions.json`, `graph/render-settings.json`, `graph/source-organization.json` | presentation, rebuildable |
| `cortex/sources.json` | linked roots |
| `cortex/files.jsonl` | state of each file under a root, the newest line for a source id wins |
| `cortex/locators.jsonl` | the passage of each proposition in each source |
| `cortex/outcomes.jsonl` | graded answers, append only |
| `cortex/writer.lock` | present while a Ranviera process writes |
| `archive/<date>/` | lines removed by a deletion |
| `settings.json`, `prompts/`, `jobs/`, `debug/` | configuration, work records and captures. The skill does not read them |

The file `auth.json` sits one level above the learning folder. It holds keys and is never read.

## Session record

Fields: `id` (equal to the file name), `title`, `createdAt`, `updatedAt`, `kind` (`teach` or `practice`, absent means teach), `version` (absent means 1), `messages`, and optionally `tree`, `turns`, `extractions` and `settings`. A record with a newer `version` is refused. A message that has `parts` and no `content` is an older format and is refused.

Message roles:

- `user`: `content` is text, or blocks of text and image.
- `assistant`: `content` is a list of `text`, `thinking` and `toolCall` blocks. A tool call has `id`, `name` and `arguments`.
- `toolResult`: `toolCallId`, `toolName`, `content`, `details` and `isError`.
- `custom`: `customType`, `content`, `details`. The types are graph-context, probe-handoff, subagent-steer, subagent-abort, plan-block, practice-thinking, practice-next, problem-dismissed and compaction. Any other type is unsupported and is shown as stored.

A result of a question tool (quiz, probe, ask_user_question, explain, recall) keeps a compact form in `content` and the full graded form in `details`. The details hold `kind`, `tool`, `questionType`, `questionText`, `options`, `answers`, `text`, `other`, `dontKnow`, `dismissed`, `thinking` (an older record calls it `note`), `readingThinking`, `confidence` (0 to 100, absent when the learner chose not known), `correct`, `correctIndices`, `committed`, `explanation`, `target` (proposition ids) and `answeredAt`. Options are shuffled for display, so a display index is not the authored order. A stored answer key is written by the teacher.

## Propositions and chains

A proposition line holds `id` (`n_` and 12 hex digits), `name`, `statement`, `aliases`, `createdAt` and `provenance`, a list of `chatId` and `messageId` pairs. A `chatId` is a session id (`chat_`) or a source id (`src_`), and an empty `messageId` means attribution to the whole source.

A chain line holds `id` (`arg_`), `premises` (at least one proposition id, used together), `conclusion`, `createdAt` and `provenance`.

The readers apply this merge:

- Proposition lines merge by `id`. The first line fixes `name`, `statement` and `createdAt`. Each later line adds its statement and its aliases to the aliases, skipping empty text and exact duplicates. A later name is ignored. Provenance is the union of exact pairs in first seen order.
- Chain lines merge by the premise ids sorted and joined with `+`, then `>` and the conclusion id, for example `n_a+n_b>n_c`. The first line fixes the id, the order of the premises and `createdAt`. Provenance is the union.
- A line with bad JSON, a missing field or a wrong type is skipped and reported. A valid proposition has text `id`, `createdAt`, `name` and `statement`, a list of text `aliases` and a valid `provenance`. A valid chain has text `id`, `createdAt` and `conclusion`, a non empty list of text `premises` and a valid `provenance`.
- The birth source of a proposition is the `chatId` of its first provenance point after merging. A proposition without provenance has none. A birth source with at least 3 propositions is a cluster.
- Support is the number of distinct `chatId` values in the merged provenance.

## Sources

A source record in `graph/sources.json` has `id`, `filePath` (a label of the form root label, slash, path in the root) and `importedAt`. The file `cortex/sources.json` holds `{ "version": 1, "roots": { ... } }`. A root has `id` (`root_` and 8 hex digits), `kind`, `path`, `label`, `include`, `exclude`, `sensitivity` (public, internal or client-confidential), `mode`, `enabled`, `hostedConsentAt`, `createdAt` and `lastScanAt`. A file line holds `sourceId`, `rootId`, `path`, `state` (pending, current, missing or refused), hashes, times and, for a refused file, a `reason`.

## Outcomes

A line in `cortex/outcomes.jsonl` holds `id` (`out_`), `at`, `sessionId`, `messageId`, `toolCallId`, `tool`, `source` (choice or practice), `planNode`, `target` (proposition ids), `correct` (true, false or null when the learner chose not known), `confidence` (choice only), `outcome` (practice only), `rung` (null or R0 to R5), `missClass` (null, cue, discrimination, execution, careless or structural), `retest` and `thinkingChars`.

The held band is derived from the outcomes of one proposition ordered by `at`. It is `unknown` with no outcome. It is `held` with at least 2 outcomes when the newest 2 are both correct, the rung of each is null, R0 or R1, and none of the newest 3 has the miss class structural. Otherwise it is `shaky`. Calibration is shown only from 5 choice answers that carry a confidence. The thresholds are Ranviera proposals and the band is never graph truth.

## Reader limits

- No reader writes, migrates or repairs. A newer stamp is refused.
- A missing optional file is an empty result, and the output says nothing was created.
- Learning tool acknowledgements are shown. Operation tool content is dropped by default and named in the omission ledger.

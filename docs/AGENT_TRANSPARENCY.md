# Ranviera agent transparency

This document describes the agent transparency feature of Ranviera, which shows a reviewer in a bank which instruction an AI agent followed when it made a decision. It sets out what the feature does for second-line financial crime reviewers and the limits of what it can show. It also describes the split between the public product and the material that a bank supplies, and how to try the feature on a demonstrator. The shapes are in `CONTRACTS.md`, the classes and relations are in `ONTOLOGY.md` and the rules are in `REASONING.md`.

## What the feature does

A second-line reviewer opens a decision, such as the closure of a transaction monitoring alert. The reviewer sees the steps that the agent took and the instructions in its context. Each instruction links to the policy clause and control behind it, and each control links to its obligation. The bank owns the mapping from instruction to obligation in the knowledge graph, and each link has a status, an owner and a history that the bank can edit.

The feature serves second-line reviewers, the head of financial crime policy, model risk staff and the money laundering reporting officer. Its outputs are the decision trace for one alert and the evidence pack for an alert, a case, an agent or a period. Both read the same graph. The evidence pack shows the instructions in force on the day, who approved them, how the agent behaved, how often a human reviewer disagreed and whether the running agent matched the approved version. It does not show the internal computation of the model.

Accountability remains with the firm, and the judgement of suspicion remains with the nominated officer under regulation 21(5) of the Money Laundering Regulations 2017. Ranviera therefore records a human review and does not record a suspicion decision as made by the agent. A case is held as an external reference only.

## Questions that the feature answers

- A second-line reviewer asks why the agent closed an alert (decision trace), which policy and obligation an instruction implements (mapping chain) and how often reviewers overturn the agent (monitoring).
- The head of financial crime policy asks which obligations have no instruction (coverage matrix and rule O01) and which instructions have no policy clause (rule O02).
- Model risk and validation staff ask what changed since the last review and who approved it (instruction editor and rules O06 and O12).
- The money laundering reporting officer asks what the agent was told on the day it closed an alert (evidence pack, point in time query).
- The platform owner asks whether the running agent matches the approved version (rule O09).

## The decision trace

The decision trace shows the decision at the top, followed by its steps with the tool, the evidence and the stated rationale of each. Each step lists the instructions in context and the instructions that the agent cited, and each instruction expands to its clause, control and obligation with the status of each mapping. Findings of rules O04 and O07 appear in line.

Three labels apply. 'Recorded' marks tools and evidence, 'loaded' marks instruction context, and 'stated by the agent, cause unverified' marks the rationale and the citations of the agent. The human review appears as a separate act. The view says 'stated rationale' and does not say 'reasoning'.

Runs reach the graph through the `ranviera.run.v1` format, through OpenTelemetry GenAI spans, through Claude Agent SDK and Claude Code hooks, or through gateway capture. Each route is normalised to the same record, and a conformance test checks that each route gives the same graph.

## The coverage matrix

The coverage matrix has obligations as rows and controls, policy clauses and instructions as columns, and each cell shows the status of its mapping. Filters select the agent, the regime and the business unit. The page lists the findings of rules O01, O02 and O08 with their proofs, which a bank sees where it supplies its own obligation pack. The matrix exports to a spreadsheet.

## The mapping review queue

The mapping review queue lists proposed and stale mappings by owner and age. A checker ratifies a mapping, rejects it with a reason or reassigns it. A proposed mapping is drawn at half weight and feeds no rule, and a rejected mapping stays in its file with its reason. An edit after ratification returns the mapping to proposed.

The maker and the checker of a mapping must differ, and the server refuses a ratification by the maker. A ratified mapping records the hash of both ends, and rule O05 reports the mapping as stale when either end changes afterwards. A matcher or a language model may suggest mappings, which carry the origin `suggested` and a basis that quotes the clause. A suggestion does not have the status ratified at creation.

## The instruction editor and the signed bundle

The instruction editor shows an instruction, its versions, a difference between versions and the mappings and findings that the instruction affects. A change creates a draft and shows its impact before approval, namely the mappings that would become stale and the past decisions that used the earlier version. A named approver who differs from the maker approves the version (rule O06).

An approved version leaves Ranviera as a signed bundle that holds the instruction files, their hashes, the model version and the approval record. A verifier library, which the bank adds to the start up of its agent, checks the signature and loads only the files of the bundle. The agent reports the hashes that it loaded in its first record of each run, and rule O09 reports any difference from the approved hashes. Ranviera does not push a bundle to an agent, because the deployment route belongs to the bank. Until a bank adopts the verifier, the editor states that a deployed agent may differ from the graph.

## Monitoring, sampling and back-tests

Ranviera calculates measures of effectiveness from the ledger and the review records, in addition to the traceability of each decision. The bank sets each threshold, because the bank owns its risk appetite.

- Sampling: a reviewer draws a random or risk weighted sample of runs, records a verdict for each run and sees the agreement with the agent by instruction version.
- Override and disagreement rates by agent, version and period, with bounds that the bank sets in the bounds file (rule O13).
- Reviewer challenge: each review records the time open, the items viewed, the checks ticked and the override reason. These show reviewer activity and do not show what the reviewer thought.
- Back-test: the bank loads replays of closed historic alerts, produced by its own harness, with their final dispositions. Ranviera reports agreement, false closures and false escalations for a named instruction and model version, and shows a new version beside the version that it replaces. The bank sets the pass threshold.
- Drift: a change in instruction version, model version, retrieval snapshot or override rate raises a prompt for the agent owner to validate the agent again.
- Faithfulness: for a sample of runs, a replay removes or swaps a cited instruction and records whether the decision changes. The agreement rate is a measure for the bank to judge and does not change the 'unverified' label of the rationale. [To confirm: replay determinism at pinned parameters.]
- Inventory: each deployed agent with its owner, intended use, risk tier, approved model and instructions, and last validation date.

Ranviera does not run the model. The replays for a back-test come from the bank, in the run format.

## The evidence pack

The evidence pack is a dated folder for one alert, run, agent or period. It holds a JSON file and a rendered document that prints, together with a manifest of SHA-256 hashes. The JSON file contains the decision traces in scope, the instruction versions with their approvals, the mapping chain and the findings with proofs. It also contains the ledger head, the completeness result, the monitoring report, the back-tests and the graph hash. A period pack leads with the coverage matrix and the monitoring summary. The pack holds hashes and content references and holds no text from the controlled store.

## The run ledger

Each run record, approval and ratification becomes an entry in an append only ledger, which holds its own hash and the hash of the previous entry. The bank signs the ledger head with its own key. An alteration or a deletion breaks the chain, and rule O11 reports it. A completeness check compares the steps captured with the count that the agent reports at the end of its run. Full text is held in a controlled store and the graph holds hashes, because content attributes are likely to be sensitive. Personal data may be redacted from the store while the hash stays in the ledger. Replay needs the pinned model version, the prompt hash, the retrieval snapshot hash and the parameters, and a run without them is marked as not replayable (rule O10).

## Limits of the feature

The graph shows the context that the agent had, the tools that it called, the evidence that it read, the text that it wrote and the decision that it reached. It does not show the internal computation of the model, and a complete trace does not show that a decision was correct.

- Stated reasoning is an unreliable witness. Claude 3.7 Sonnet mentioned a hint that it had used in 25% of cases, and models that learned a reward hack admitted it in under 2% of cases in most scenarios (Anthropic, 3 April 2025). The scope was 2 models on multiple-choice hint tasks. Claude can also describe a method that differs from the one it used internally (Anthropic, 27 March 2025), and Ranviera does not promise the interpretability tools that detect this.
- Claude returns summarised thinking and reports thinking tokens separately. The trail therefore records that thinking occurred and its token count (Anthropic, 7 October 2026).
- A hook shows which instruction was loaded and does not show that the model weighed it. The links `inContext` and `citesInstruction` are separate for this reason, and rule O04 compares them. The faithfulness test measures agreement on sampled runs and gives no causal proof.
- Rules O03 to O07 and O09 to O14 check consistency and integrity. A tidy graph may give false assurance unless the monitoring is read with it, and the evidence pack shows both.
- Claude Code tracing is in beta and the OpenTelemetry conventions for generative AI are in Development status. The run format and gateway capture give routes that do not depend on them. Whether a second line accepts these records as evidence is [To confirm: second-line view].
- Prompt injection is a named risk (Bank of England, April 2025). The graph records provenance and hashes, rule O14 flags a mismatch, and Ranviera does not prevent injection.
- Maker and checker depend on the identity that the bank supplies, and the tool alone cannot assure that two accounts belong to 2 different people. A bank deployment connects its OIDC or SAML provider and maps roles from its groups.

## The public and private split

The public repository holds the generic capability under the Apache 2.0 licence, which comprises:

- the generic classes and relations
- the mapping workflow, with its maker and checker rules
- rules O03 to O07 and O09 to O14
- the run format `ranviera.run.v1` and the trace ingestion
- the run ledger and its verification
- the instruction store and the policy pack format
- the views, the evidence pack, the signed bundle with its verifier and the conflict scan.

A bank supplies its own obligation pack, loaded from a local folder that the configuration names, together with its instructions, policies, controls, typologies and bounds. Rules O01, O02 and O08 read that pack and are supplied with it. A pack loader may add its own configuration keys. The graph that a loader fills is written to the dataset only where `include_private_graphs` is true, and the public export does not carry it.

## Trying the feature

Where the demonstrator is installed, `npm run demo` from the repository root builds a synthetic bank into a folder, starts the server with its configuration and opens the Oversight window. The demonstrator holds a synthetic agent, its instructions, its runs and its reviews, with planted faults that the rules must find. It runs with `oversight_demo` set to true, and each view labels the identity 'demonstration identity' and the 'Acting as' selector chooses a person from the people file. The command prints the compiler's sentence and exits with status 2 where the demonstrator is not installed.

## Status

The oversight routes and the view shapes are provisional until the maintainer's validation with second-line reviewers reports. Thresholds, the signature scheme for a bank and the identity provider per bank are marked in `CONTRACTS.md` as [To confirm].

## Changes to this document

- 7 October 2026: first version.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

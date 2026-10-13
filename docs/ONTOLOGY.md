# Ranviera ontology

This document defines the classes, relations, identifiers, vocabulary format and validation rules of the Ranviera knowledge graph. The machine-readable versions are `ontology/cortex.ttl` (the OWL 2 DL ontology), `ontology/shapes.ttl` (SHACL shapes), `ontology/rules/` (the reasoning rules), `ontology/defaults/` (the starting vocabulary, task types and weights) and the profile folder of the person (their own vocabulary, task types, weights and assertions). Where this document and a machine-readable file differ, the machine-readable file must be corrected to match this document.

## Namespaces

| Prefix | IRI | Use |
|---|---|---|
| `cx:` | `https://cortex.local/ont#` | classes and properties |
| `cxi:` | `https://cortex.local/id/` | instances, as `cxi:<prefix>/<slug>` |
| `skos:` | `http://www.w3.org/2004/02/skos/core#` | the vocabulary |
| `sh:` | `http://www.w3.org/ns/shacl#` | the shapes |
| `prov:` | `http://www.w3.org/ns/prov#` | the record of use, in exports only |

The namespace `cortex.local` is an identifier. It keeps the identifiers stable from one version of the product to the next, and no network address is behind it.

## Classes

Each class belongs to one family, and the family sets the colour of its nodes in the graph. The prefix is the start of every identifier of that class.

| Prefix | Class | Parent | Family | What it is |
|---|---|---|---|---|
| `claudemd:` | MapFile | InstructionFile | instruction | a `CLAUDE.md` file (`claudemd:global` for `~/.claude/CLAUDE.md`, `claudemd:app-<folder>` for a project) |
| `rulefile:` | RuleFile | InstructionFile | instruction | a file in `~/.claude/rules/` |
| `outputstyle:` | OutputStyle | InstructionFile | instruction | a file in `~/.claude/output-styles/` |
| `skill:` | Skill | InstructionFile | instruction | a skill folder, with its `SKILL.md` as its path |
| `reference:` | ReferenceFile | InstructionFile | instruction | a file in the `references/` folder of a skill |
| `guide:` | GuideFile | InstructionFile | instruction | any other `.md` file in a skill |
| `section:` | Section | none | instruction | a heading in an instruction file, as `section:<file-key>-<heading-slug>` |
| `rule:` | Rule | none | instruction | one atomic rule, as `rule:<file-key>-<nnn>`, with its identifier kept by the rule ledger |
| `route:` | Route | none | instruction | one entry that maps a prompt pattern to a task type |
| `task:` | TaskType | none | instruction | a kind of task, from the task types of the defaults and the profile |
| `scope:` | PathScope | none | instruction | a path glob from a rule file's frontmatter |
| `agent:` | Agent | none | machinery | a file in `~/.claude/agents/` |
| `hook:` | Hook | none | machinery | one command in the `hooks` block of `settings.json`, as `hook:<event>-<script-stem>` |
| `tool:` | Tool | none | machinery | a script, with `props.scope` of harness, build or app |
| `gate:` | Gate | none | machinery | a named check run before work is handed over, from the task types |
| `fault:` | FaultCheck | none | machinery | one fault that a check looks for, keyed by its label |
| `schedule:` | ScheduledTask | none | machinery | a folder in `~/.claude/scheduled-tasks/` |
| `builtin:` | BuiltinTool | none | machinery | a Claude Code tool such as Read, Edit or Bash |
| `launch:` | LaunchConfig | none | machinery | one entry in a project's `launch.json` |
| `record:` | RecordStore | none | record | a single store such as `record:memory-index` or `record:backlog` |
| `memory:` | MemoryFile | none | record | a file in a memory folder |
| `backlog:` | BacklogSection | none | record | one project section of a backlog file |
| `openitem:` | OpenItem | none | record | one open item in a backlog section |
| `history:` | HistoryFile | none | record | a file in a history folder |
| `decision:` | Decision | none | record | a numbered decision, as `decision:<yyyy-mm-dd>-<n>` |
| `project:` | Project | none | work | a project with a memory file |
| `app:` | App | none | work | a folder in the `apps/` folder of the projects folder |
| `deliverable:` | Deliverable | none | work | a current file in a deliverables folder |
| `template:` | Template | none | work | a file in a shared templates folder |
| `folder:` | Folder | none | work | a folder that the set-up names |
| `org:` | Organisation | none | world | an organisation |
| `client:` | Client | Organisation | world | a client organisation |
| `person:` | Person | none | world | a named person (client-confidential by default) |
| `instrument:` | Instrument | none | world | a law, regulation or piece of guidance |
| `scheme:` | ConceptScheme | skos:ConceptScheme | language | a vocabulary scheme |
| `term:` | Concept | skos:Concept | language | one concept in a scheme |

A set-up that has no node of a class simply has no such nodes. Classes for work, records and the world appear only where the person's files and vocabulary name such things.

## Properties of every node

Every node must carry `rdfs:label`, `cx:family`, `cx:sensitivity` (public, internal or client-confidential) and `cx:evidence` (file and line). A node may carry `cx:path`, `cx:summary`, `cx:date`, `cx:status` (active, maintained, parked, blocked, superseded, archived or retired) and class-specific properties:

- Rule: `cx:text` (exactly 1, and an OpenItem carries it too), `cx:modal` (must, should, may, will, imperative or none), `cx:givenOn` (the date that the rule states), `cx:fingerprint`
- Agent: `cx:model`, `cx:effort`, `cx:tools`
- Hook: `cx:event`, `cx:matcher`, `cx:command`, `cx:async`
- Route: `cx:pattern` (1 or more)
- MemoryFile: `cx:memoryType` (user, feedback, project or reference), `cx:bytes`, `cx:indexed`
- Concept: `skos:prefLabel` (exactly 1), `skos:altLabel`, `skos:hiddenLabel`, `skos:definition`, `cx:termStatus` (ratified or proposed), `cx:severity` (warn or fail).

## Relations

The weights set how far activation spreads, forwards along the relation and backwards against it. They are kept in `ontology/weights.json`, and a person may override them in the profile.

| Relation | From and to | Forward | Backward |
|---|---|---|---|
| `contains` | a file or skill to its sections or files, a section to its rules, an agent body to its sections, a record store to its decisions, a tool to its fault checks | 0.60 | 0.35 |
| `triggers` | Route to TaskType | 0.95 | 0.50 |
| `readsFirst` | TaskType to an instruction file, or to a memory file where the task types name one | 0.85 | 0.40 |
| `handledBy` | TaskType to Agent | 0.80 | 0.40 |
| `checkedBy` | TaskType or Rule to Gate or FaultCheck | 0.70 | 0.50 |
| `appliesTo` | RuleFile or Rule to PathScope or TaskType | 0.50 | 0.50 |
| `loads` | Hook, Agent or Skill to a file | 0.70 | 0.30 |
| `invokes` | Hook or Gate to Tool | 0.80 | 0.40 |
| `enforces` | Gate, FaultCheck or Tool to Rule | 0.50 | 0.60 |
| `restates` | Rule to Rule | 0.60 | 0.60 |
| `supersedes` | a node to the node it replaces | 0.20 | 0.20 |
| `conflictsWith` | Rule to Rule | 0.40 | 0.40 |
| `governs` | Decision to a rule, an instruction file or a memory file | 0.40 | 0.50 |
| `refersTo` | a file to a path it cites | 0.35 | 0.15 |
| `mentions` | a file to an entity named in it | 0.30 | 0.15 |
| `documentedIn` | Project to a memory, backlog or history record | 0.60 | 0.70 |
| `belongsTo` | Deliverable or BacklogSection to Project, and OpenItem to BacklogSection | 0.40 | 0.50 |
| `deliveredTo` | Project or Deliverable to Organisation, which is a Client where the organisation pays for the work | 0.30 | 0.20 |
| `builtWith` | Project to App, Tool or Template | 0.50 | 0.30 |
| `dependsOn` | Project to Project | 0.30 | 0.20 |
| `locatedAt` | a node to its Folder | 0.30 | 0.30 |
| `usesTemplate` | a node to a Template | 0.60 | 0.30 |
| `ownedBy` | OpenItem to Person | 0.20 | 0.10 |
| `linksTo` | MemoryFile to MemoryFile | 0.35 | 0.35 |
| `indexes` | `record:memory-index` to MemoryFile | 0.20 | 0.20 |
| `launches` | LaunchConfig to App | 0.40 | 0.40 |
| `denotes` | Concept to the node it names, never another Concept or a ConceptScheme | 0.60 | 0.60 |
| `inScheme` | Concept to ConceptScheme | 0.10 | 0.05 |
| `overrides` | Rule to Rule, inferred by rule R03 | 0.50 | 0.40 |
| `supersedesChain` | a node to a node it replaces through a chain, inferred by rule R02 | 0.20 | 0.20 |
| `appliesToTask` | Rule to TaskType, inferred by rule R05, kept for queries and not in the live graph | none | none |

### What the ontology file states

Within OWL 2 DL, `ontology/cortex.ttl` states the axioms that the model relies on. `kg/tests/test_ontology.py` checks the restrictions of OWL 2 DL that apply to the file, which are a single declared kind for each entity, a declared class behind each domain and range, and the characteristics `Asymmetric`, `Symmetric`, `Transitive` and `Functional` only where the specification allows them. A reasoner such as HermiT has not classified the file.

- **Classes.** The classes are pairwise disjoint (`owl:AllDisjointClasses`), except that `InstructionFile` is the parent of its 6 subclasses and `Client` is a subclass of `Organisation`. `Concept` and `ConceptScheme` are subclasses of the SKOS classes of the same names. `Finding` is the class of a result written to the inferred graph.
- **Domains and ranges.** Each is the union of the classes that the compiled graph holds for the relation, as the Relations table shows. In OWL a domain or a range is an inference and not a check, so an edge outside it would give its node a wrong class instead of an error. The shapes S13 to S22 and the check P09 report such an edge. The tests expand the ontology with `owlrl` (OWL 2 RL) to show that the edges of the compiled graph are consistent and that a clash with a single-class range is an inconsistency. A union range is not decomposed by OWL 2 RL, so the shapes remain the check for it.
- **Open relations.** `refersTo`, `mentions`, `locatedAt` and `usesTemplate` have no domain, and `loads`, `denotes` and `onNode` have no range, because any kind of node may take part and a declared union would state nothing. Inverses are the annotation `cx:inverseLabel` and not `owl:inverseOf`, because the graph stores 1 direction of each relation.
- **Characteristics.** `conflictsWith` is symmetric. `supersedes` is asymmetric and a sub-relation of `supersedesChain`, which is transitive (rule R02). `overrides` is asymmetric and a sub-relation of `conflictsWith`, because rule R03 derives it only for 2 conflicting rules.
- **Datatype properties.** A property that holds 1 value at most is functional. The ranges of `family`, `sensitivity`, `status`, `modal`, `memoryType`, `termStatus`, `severity` and `findingSeverity` are enumerations.
- **Findings.** A finding in the inferred graph of `graph.trig` has the class `cx:Finding`, the check as `cx:checkId`, the severity as `cx:findingSeverity` (violation, warning or info), the text as `cx:message` and the node it concerns as `cx:onNode`.

## Where each kind of fact comes from

- **Parsed facts.** The harvesters read the files with fixed rules. Headings become sections, bullets and numbered items become rules, frontmatter becomes properties, cited paths become `refersTo` edges, `[[name]]` links become `linksTo` edges, and vocabulary matches become `mentions` edges.
- **Task types and gates.** The task types list each task type with its routes, the files it reads first, its agents and its gates. The starting task types are writing code, reviewing code, debugging, research, writing a document, making slides, analysing data and planning, each with plain route patterns. Where a person's `CLAUDE.md` holds a table that names a task and a file, the compiler adds the files read first, and the person can edit task types in the application.
- **Curated assertions.** Relations that parsing cannot settle, such as `restates`, `conflictsWith`, `supersedes` between rules and `deliveredTo`, are kept as assertions in the profile. Each assertion has a status of proposed, ratified or rejected.

The assertion format is:

```json
{ "s": "rule:style-014", "r": "restates", "t": "rule:style-common-031", "status": "proposed",
  "date": "2026-10-05", "by": "review", "evidence": "rules/style.md:22 and references/style-common.md:88" }
```

## The rule ledger

The ledger keeps the identifier of every rule ever seen. The file key is fixed for each file, and it is the stem of a rule file (`style`), a reference file (`style-common`) or a guide, `claude-md` for the global map, `agent-<name>` for an agent body, `skill-<name>` for a `SKILL.md` and `style-<stem>` for an output style.

```json
{ "v": 1,
  "rules": { "rule:style-014": { "file": "rules/style.md", "fingerprint": "<sha1 of the normalised text>",
             "text": "<normalised text>", "first_seen": "2026-10-05", "last_seen": "2026-10-05",
             "status": "active", "retired": null } },
  "next": { "style": 15 } }
```

Normalised text is lower case, with markdown marks, dates in brackets and repeated spaces removed. A bullet keeps its identifier when its fingerprint matches, or when its normalised text has a similarity of 0.8 or more (difflib ratio) to an active rule of the same file key.

## Vocabulary

Each scheme is a JSON file in `vocab/`, compiled to SKOS. The starting vocabulary in `ontology/defaults/vocab/` names the things that every Claude Code set-up has, which are `CLAUDE.md`, rules, skills, agents, hooks, memory, settings, output styles, slash commands, MCP servers and task types, with Claude Code's own words as the preferred labels. A person adds schemes for their own named things, preferred phrases and words to avoid.

```json
{ "scheme": { "id": "scheme:entities", "label": "Named things", "description": "..." },
  "concepts": [ { "id": "term:example-project", "prefLabel": "Example Project", "altLabels": [], "hiddenLabels": [],
                  "definition": "...", "denotes": ["project:example-project"], "status": "ratified",
                  "ratified": "2026-10-05", "severity": "warn", "case": "sensitive",
                  "source": "memory/project_example.md:3", "variant_counts": {} } ] }
```

A hidden label is a form that must not be used. A proposed concept is reported as a warning only, and it becomes enforceable when the person ratifies it in the Lexicon window, which records the date.

## Shapes

`ontology/shapes.ttl` holds the SHACL shapes, and `kg/cortex_kg/validate.py` holds the checks that SHACL cannot express. Each check has an identifier, a severity and a message. The shapes read the union of the stated and ratified graphs of `graph.trig` (a proposed edge and an inferred edge are left out) together with the ontology. Where `graph.trig` is missing, the check reads `graph.ttl`.

| Id | Check | Severity |
|---|---|---|
| S01 | every node of every class has 1 label, 1 family and 1 sensitivity from the 3 allowed values | violation |
| S02 | every rule has 1 non-empty text, 1 container and a modal from the allowed values | violation |
| S03 | every agent runs on the model that `agent_model` names, where the configuration sets it | violation |
| S04 | every route has a pattern and triggers a task type | violation |
| S05 | every task type reads at least 1 instruction file | warning |
| S06 | every hook invokes a tool | violation |
| S07 | every memory file has a type and a description and is in the index | warning |
| S08 | every project is documented in a memory file | violation |
| S09 | every entity concept has 1 preferred label, and no hidden label equals any preferred or accepted label | violation |
| S11 | a rule with no stated date | info |
| S12 | every typed node carries the family of its class | violation |
| S13 | a task type reads first an instruction file or a memory file (`readsFirst`) | violation |
| S14 | a task type is handled by an agent (`handledBy`) | violation |
| S15 | a task type or a rule is checked by a gate or a fault check (`checkedBy`) | violation |
| S16 | a route triggers a task type (`triggers`) | violation |
| S17 | a project is documented in a memory file, a backlog section or a history file (`documentedIn`) | violation |
| S18 | a deliverable or a backlog section belongs to a project and an open item to a backlog section (`belongsTo`) | violation |
| S19 | a concept denotes a node that is neither a concept nor a scheme (`denotes`) | violation |
| S20 | a file holds sections or files, a section rules, an agent sections, a record store decisions, a tool fault checks, a run steps, a step tool calls or a stated rationale and a test script test steps (`contains`) | violation |
| S21 | a decision governs a rule or a file (`governs`) | violation |
| S22 | only a rule conflicts with a rule (`conflictsWith`) | violation |
| S23 | every node that carries a family, a sensitivity, a text or a path has a class of the ontology | violation |
| S24 | every decision states 1 date (violation) and governs at least 1 rule or file (warning) | violation |
| S25 | every concept is in 1 scheme and has a definition | violation |
| S26 | every open item belongs to 1 backlog section and has its text | violation |
| P01 | every cited path exists | violation |
| P02 | the limits of `size_limits` on the map file, the memory index and each rule file, where the configuration sets them | warning |
| P03 | every route pattern compiles as a regular expression | violation |
| P04 | no hidden label of a ratified concept appears in an instruction file | warning |
| P05 | no assertion names a retired rule or a missing node | violation |
| P06 | no committed file yields a client-confidential node (CI) | violation |
| P07 | every hook command names a script that exists | violation |
| P08 | the evidence of each node and each edge names a file that exists and a line within it, and for a rule the line holds its text | warning |
| P09 | a stated or ratified edge whose subject or object has a class outside the domain or range that `cortex.ttl` declares for its relation | warning |

Shape S10 was removed, because reasoning rule R04 does the same job from the stated and ratified edges only. The identifier S10 is not reused. Checks S03 and P02 run only where the configuration sets `agent_model` (the model that every agent must use) and `size_limits` (the limits for the map file, the memory index and each rule file). Where a key is not set, the check does not run, because both encode the conventions of one set-up.

In CI (`python cortex.py check --ci --strict`) the blocking checks are S01, S02, S03, S04, S06, S09, S12, S23, P03, P05, P06, P07, B01 and B03. Check B03 (the reasoning engine Nemo is missing) is a warning on a developer machine and a violation in CI, because a run that skips the rules would pass a graph that the rules never read. Check P08 does not run in CI, which has none of the files that the evidence names. The shapes S13 to S22 and S24 to S26 are reported and are not blocking.

## Agent transparency extension

This section adds the classes, relations and shapes that the agent transparency feature needs (`AGENT_TRANSPARENCY.md`). The machine-readable files are at ontology version 0.3.0 and shapes version 0.4.0. Nothing above this section changes, except that the enumeration of `cx:status` gains the values `draft`, `approved`, `proposed`, `ratified` and `rejected`, and that `conflictsWith` and `overrides` also accept an InstructionVersion at both ends (shape S22). The new classes belong to the families `agent` and `obligation`.

### Agent side classes

The agent side classes describe the agents in service, their instructions, their runs and the oversight of those runs.

| Prefix | Class | Family | What it is |
|---|---|---|---|
| `dagent:` | DeployedAgent | agent | an agent in service, with `cx:intendedUse`, `cx:riskTier` and `cx:lastValidated`, an owner (`ownedBy`), approved instruction versions (`operatesUnder`) and approved model and knowledge sources (`drawsOn`) |
| `instr:` | InstructionVersion | agent | the text of one instruction in force over an interval, as `instr:<agent>-<name>@<version>`, with `cx:hash`, `cx:validFrom`, `cx:validTo` (null while open), `cx:version`, `cx:path` and a `cx:status` of draft, approved or withdrawn |
| `model:` | ModelVersion | agent | a pinned model, with `cx:provider`, `cx:modelId`, `cx:parameters` (canonical JSON) and a `cx:status` of approved or pending |
| `ksrc:` | KnowledgeSource | agent | a retrieval source, with `cx:snapshotHash`, `cx:snapshotDate` and `cx:licence` |
| `map:` | Mapping | agent | a reified design time link, as `map:<yyyymmdd>-<nnn>` (`CONTRACTS.md`) |
| `run:` | Run | agent | one agent run, keyed `run:<agent>-<run>` so that a run name need only be unique within its agent, with `cx:startedAt`, `cx:endedAt`, `cx:replayStatus` (replayable or not-replayable) and `cx:caseRef` |
| `step:` | Step | agent | one record of a run, as `step:<run>-<nnn>`, with `cx:ordinal`, `cx:stepKind` (start, instructions, retrieval, tool, evidence, rationale, decision, review or end) and `cx:ts` |
| `call:` | ToolCall | agent | a tool or MCP call inside a step, with input and output hashes |
| `evid:` | Evidence | agent | an item the agent read, with `cx:hash`, `cx:sourceHash` and `cx:sourceRef` |
| `rationale:` | StatedRationale | agent | the text the agent wrote to explain a decision, always `cx:causalStatus "unverified"`, held as a hash |
| `adec:` | AgentDecision | agent | the agent's decision, shown as 'Decision', with `cx:outcome` from the scheme `scheme:outcomes` (close, escalate, request-information) |
| `review:` | Review | agent | a human review of a decision, with reviewer, verdict, `cx:override`, `cx:overrideReason`, time open, items viewed and checks ticked |
| `sample:` | Sample | agent | a sample of runs drawn for review |
| `backtest:` | BackTest | agent | a replay of closed alerts through a named instruction and model version |
| `ledger:` | LedgerEntry | agent | one entry of the run ledger, with `cx:seq`, `cx:recordHash`, `cx:prevHash` and `cx:entryHash` |

A case reference is held in `cx:caseRef` and points to the bank's own case system. The graph holds no suspicion decision.

### Obligation side classes

The obligation side classes describe what a bank must do and how it has organised the work. They are generic, and the instances come from a bank's own obligation pack or from the policy pack of `CONTRACTS.md`.

| Prefix | Class | Family | What it is |
|---|---|---|---|
| `provision:` | LegislativeProvision | obligation | a provision of legislation or guidance, with its text hash, its version date and its effective date |
| `obligation:` | Obligation | obligation | something a bank must do, with the properties `bearer`, `action`, `condition`, `within` and `modality`, and an effective date |
| `policy:` | Policy | obligation | a policy, standard, procedure or guideline of the bank, with its specific kind in `props.kind` |
| `clause:` | PolicyClause | obligation | one clause of a policy, standard or procedure, with `cx:text` and `cx:hash`, contained in its instrument through `contains` |
| `control:` | Control | obligation | a control, with its `control_type` |
| `framework:` | ControlFramework | obligation | a framework that groups controls |
| `exception:` | PolicyException | obligation | an exemption from a requirement, which serves the exemption of rule O01 |
| `role:` | OrganisationalRole | obligation | a role that may own a policy, a control or an agent |
| `tscript:` | TestScript | obligation | a second-line test script, with `cx:version` and `cx:reviewed` |
| `tstep:` | TestStep | obligation | one step of a test script, `contained` in it |
| `req:` | Requirement | obligation | one requirement tested, which a TestStep `testedAgainst` |
| `typology:` | Typology | obligation | a pattern of financial crime that a bank watches for, with `source_url` and the status `active` |
| `riskind:` | RiskIndicator | obligation | a sign that may point to a typology (relation `signals`) |

### New relations

The weights are in `ontology/weights.json`, high on the chain from instruction to obligation and lower on the run record.

| Relation | From and to | Forward | Backward |
|---|---|---|---|
| `implementsClause` | InstructionVersion to PolicyClause | 0.85 | 0.55 |
| `realises` | PolicyClause to Control | 0.85 | 0.55 |
| `satisfies` | Control to Obligation | 0.85 | 0.55 |
| `expressedIn` | Obligation to LegislativeProvision | 0.70 | 0.50 |
| `appliesTo` (extended) | Obligation to DeployedAgent, as the scope the policy owner declares | 0.50 | 0.50 |
| `notDischargedBy` | Obligation to DeployedAgent, a ratified statement that the agent does not discharge it | 0.20 | 0.20 |
| `detects` | InstructionVersion to Typology | 0.50 | 0.40 |
| `signals` | RiskIndicator to Typology | 0.50 | 0.40 |
| `operatesUnder` | DeployedAgent to InstructionVersion | 0.70 | 0.40 |
| `drawsOn` | DeployedAgent to ModelVersion or KnowledgeSource | 0.50 | 0.30 |
| `performedBy` | Run to DeployedAgent | 0.60 | 0.40 |
| `ranOn` | Run to ModelVersion | 0.40 | 0.30 |
| `contains` (extended) | Run to Step, Step to ToolCall, Step to StatedRationale, TestScript to TestStep | 0.60 | 0.35 |
| `inContext` | Step to InstructionVersion, recorded from hooks or trace | 0.60 | 0.40 |
| `citesInstruction` | Step to InstructionVersion, the agent's own claim | 0.50 | 0.30 |
| `usedEvidence` | Step to Evidence | 0.50 | 0.30 |
| `sourcedFrom` | Evidence to KnowledgeSource | 0.40 | 0.30 |
| `informedDecision` | Step to AgentDecision | 0.60 | 0.40 |
| `reviewedBy` | AgentDecision to Review | 0.40 | 0.30 |
| `statesRationale` | AgentDecision to StatedRationale | 0.40 | 0.30 |
| `entryOf` | LedgerEntry to Run | 0.30 | 0.20 |
| `sampledFrom` | Sample to Run | 0.30 | 0.20 |
| `testedAgainst` | BackTest or Review to TestStep or Requirement | 0.40 | 0.30 |
| `approvedBy`, `proposedBy` | InstructionVersion or Mapping to Person | 0.30 and 0.20 | 0.20 and 0.10 |
| `ownedBy` (extended) | DeployedAgent, InstructionVersion, Mapping or Policy to Person or role | 0.20 | 0.10 |

`overrides` and `conflictsWith` are reused for instruction versions. Only a stated, computed or ratified `overrides` edge settles a conflict between 2 instruction versions, because rule R03 derives dates for rules only. Shape S22 admits an InstructionVersion at both ends of `conflictsWith`.

### Shapes F01 to F14

The shapes are in `ontology/shapes.ttl` and read the union of the stated and ratified graphs, as S01 to S26 do. Each finding has the severity shown.

| Id | Check | Severity |
|---|---|---|
| F01 | an obligation has 1 or more `expressedIn` provisions, a deontic type and an effective date | violation |
| F02 | a mapping has a status of proposed, ratified, rejected or superseded, an owner and a maker | violation |
| F03 | a ratified mapping has a checker who differs from its maker | violation |
| F04 | a ratified mapping records the hash of both ends and a ratification date | violation |
| F05 | an approved instruction version has a hash, a `cx:validFrom` date and an approver | violation |
| F06 | a run has 1 agent, 1 model version, a prompt hash and a start time | violation |
| F07 | a step has 1 run, a unique ordinal in that run, a step kind and a time | violation |
| F08 | a decision has an outcome from `scheme:outcomes`, 1 or more informing steps and a stated rationale | violation |
| F09 | a stated rationale has `cx:causalStatus "unverified"`, and an evidence item has a source reference and a hash | violation |
| F10 | a node loaded from a bank's own obligation pack has a sensitivity of internal or higher and is absent from the public export | violation |
| F11 | a deployed agent has an owner, an intended use, a risk tier and 1 or more approved model versions (`drawsOn`) | violation |
| F12 | a review with `cx:override` true has a reason | violation |
| F13 | a run has a replay status, and a run marked not-replayable names the missing items | warning |
| F14 | a run has 1 or more ledger entries | violation |

F10 blocks in CI with P06. The other F shapes do not block until the tests of the feature pass and the maintainer agrees.

## Changes to this document

- 7 October 2026: agent transparency extension, with the agent side classes, the obligation side classes, the new relations and shapes F01 to F14.
- 6 October 2026: first public version, written from the project's internal specification.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

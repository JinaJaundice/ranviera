# Ranviera interface contracts

This document fixes the data shapes that the parts of Ranviera exchange. The knowledge graph compiler, the hook, the server and the web app are built separately, and each part must read and write these shapes exactly. A change to a shape is made here first, with its date, and then in every part that uses it.

## Locations

Runtime data is machine-local and must not be committed. It is kept in the data folder, which defaults to `~/.claude/ranviera/` and is set by `data_dir` in the configuration.

| File | Written by | Read by |
|---|---|---|
| `graph.json` | `python -m cortex_kg build` | server, web (through the server) |
| `graph.ttl` and `graph.trig` | `python -m cortex_kg build` | SHACL validation, SPARQL queries |
| `index.json` | `python -m cortex_kg build` | the hook, server |
| `health.json` | `python -m cortex_kg check` | server |
| `events/YYYY-MM.jsonl` | the hook, server, `cortex_kg replay` | server |
| `missions/<id>.json` and `missions/<id>.stream.jsonl` | server | server |
| `changes/YYYY-MM-DD.json` | `python -m cortex_kg build` | web (timeline) |
| `inferred.json` and `inferred.ttl` | `python -m cortex_kg build` (the reasoning step) | server (SPARQL, `/api/inferred`), web |
| `setup.json` | server | server |
| `profile/` | the compiler and the person | the compiler |
| `bin/` | the packaged application | the hook entries |

The configuration file `cortex.config.json` is found in the repository root, or at the path in the environment variable `CORTEX_CONFIG`. Each path may start with `~`.

## Configuration

An environment variable named below overrides the key, and the key overrides the default.

| Key | Default | Meaning |
|---|---|---|
| `product` | `"ranviera"` | `"cortex"` selects the name and the default data folder of the original private copy of the code |
| `claude_home` | `~/.claude` | the Claude Code folder |
| `data_dir` | `~/.claude/ranviera` | the data folder (`CORTEX_DATA_DIR`) |
| `projects_root` | `null` | an optional folder of projects. When it is null, the project harvesters read nothing and report nothing |
| `memory_dir` | `"auto"` | a memory folder, or `"auto"` for every `<claude_home>/projects/*/memory` folder that holds a `MEMORY.md` |
| `profile_dir` | `<data_dir>/profile` | the person's own ontology content, described below |
| `kg_cmd` | `null` | the command that runs the compiler, as an array, for example the bundled `ranviera-kg` executable (`CORTEX_KG_CMD`, as JSON). When it is null, the server runs `python_cmd` with `cortex.py` |
| `python_cmd` | `python` on Windows and `python3` elsewhere | the Python executable for development |
| `port` | `5182` | the port of the server in development |
| `include_sensitivity` | all three levels | the sensitivity levels that the compiler includes |
| `log_prompt_snippets` | `false` | whether the hook stores the first 120 characters of each prompt |
| `brain_domains` | the word lists of `BRAIN.md` | `{ writing: string[], visual: string[] }` |
| `update_check` | `false` | whether the application reads the public list of releases on GitHub at start |

The desktop shell of the packaged application also sets `CORTEX_PORT` (`0` asks for a free port), `CORTEX_TOKEN`, `CORTEX_STATIC` (the built web folder) and `CORTEX_ONTOLOGY` (the ontology folder). When the server runs in an Electron utility process, it posts `{ type: "ready", port }` to `process.parentPort` once it listens.

## The profile

The product ships its starting content in `ontology/defaults/`, which holds `vocab/*.json`, `tasktypes.json` and `weights.json`. A person's own content is kept in the profile folder, which holds `vocab/*.json`, `tasktypes.json`, `weights.json`, `assertions/*.json`, `ledger/rules.json` and `ledger/openitems.json`. The compiler reads the defaults first and then the profile, and an entry of the profile with the same identifier replaces the default entry. The first build copies the default vocabulary and task types into a profile that does not exist yet.

## Identifiers

A node id has the form `<prefix>:<slug>`. The slug is lower case, uses hyphens and is stable across builds, because events and the change log refer to it. The prefixes are fixed in `kg/cortex_kg/ids.py` and listed in `ONTOLOGY.md`.

## graph.json

```ts
interface GraphFile {
  v: 1
  built: string                  // ISO 8601 UTC
  source: { claude_home: string; projects_root: string | null; git: string | null; host: string }
  classes: ClassDef[]
  relations: RelationDef[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  schemes: { id: string; label: string; concept_count: number }[]
  health: { errors: number; warnings: number; infos: number; checked: string }
  stats: { nodes: number; edges: number; by_class: Record<string, number> }
}
interface ClassDef { id: string; label: string; parent: string | null; family: Family; description: string }
type Family = "instruction" | "machinery" | "record" | "work" | "world" | "language"
interface RelationDef { id: string; label: string; inverse_label: string; weight: number; reverse_weight: number }
interface GraphNode {
  id: string
  type: string                   // a ClassDef id, eg "RuleFile"
  label: string
  family: Family
  path: string | null            // absolute, forward slashes
  summary: string | null
  date: string | null            // YYYY-MM-DD
  status: string | null
  sensitivity: "public" | "internal" | "client-confidential"
  props: Record<string, unknown>
  metrics: { uses: number; last_used: string | null; base_level: number | null; degree: number; heat: number }
}
interface GraphEdge { s: string; r: string; t: string; w: number; evidence: string | null }
```

The `heat` of a node is the rank of its base level among the nodes that have been used, from 0.15 to 1, or 0 for a node that has not been used.

## index.json

The hook reads this file on every call, so it holds only lookup tables. Paths are absolute, lower case and use forward slashes.

```ts
interface IndexFile {
  v: 1
  built: string
  paths: Record<string, string>                  // exact file path -> node id
  prefixes: [string, string][]                   // folder prefix -> node id, longest first
  routes: { id: string; patterns: string[]; fires: string[] }[]
  skills: Record<string, string>                 // skill name -> node id
  agents: Record<string, string>                 // agent name -> node id
  tools: Record<string, string>                  // tool script file name -> node id
  terms: { id: string; pattern: string; fires: string[] }[]   // entity labels (regex, case-insensitive)
  faults: Record<string, string>                 // fault key -> node id
  hooks: Record<string, string[]>                // hook event name, eg "PreToolUse" -> hook node ids
  always: string[]                               // nodes fired at every session start
}
```

## health.json

```ts
interface HealthFile {
  v: 1
  checked: string
  graph_built: string | null
  inferred_built: string | null
  counts: { violation: number; warning: number; info: number }
  findings: { check: string; severity: "violation" | "warning" | "info"; message: string; node: string | null; evidence: string | null }[]
}
```

Findings found while harvesting are written by the build to `findings.json` in the data folder, in the same shape, and `check` adds them to `health.json`. The build and the reasoning commands run the check at their end, so `health.json` always describes the latest graph. The server marks `GET /api/health` as `stale: true` when `graph_built` differs from the graph that it holds.

## Events

One event is one JSON line. The hook must append in under 50 milliseconds and must never raise. Prompt text is not stored unless `log_prompt_snippets` is true, and then only its first 120 characters.

```ts
interface CortexEvent {
  v: 1
  ts: string                     // ISO 8601 UTC with milliseconds
  session: string                // Claude Code session id, or "mission:<id>"
  source: "hook" | "orchestrator" | "replay" | "cortex"
  kind: EventKind
  nodes: string[]                // node ids fired directly
  weight: number                 // 0 to 1
  label: string                  // short description, at most 120 characters
  key: string | null             // de-duplication key, eg the tool_use_id
  meta: Record<string, unknown>  // eg { tool: "Read", path: "..." }
}
type EventKind =
  | "session.start" | "session.end" | "prompt" | "route" | "instructions"
  | "read" | "write" | "skill" | "agent.start" | "agent.stop" | "workflow" | "tool"
  | "fault" | "check" | "compile" | "mission.start" | "mission.step" | "mission.end"
```

The server ignores a second event with the same `session` and `key`.

## Server API

In development the server listens on `http://localhost:5182` and serves the web app on the same port. In the packaged application it listens on 127.0.0.1 on a free port. Every response is JSON unless stated.

| Method and path | Purpose |
|---|---|
| `GET /api/graph?max=<sensitivity>` | the graph, filtered to the given sensitivity and below |
| `GET /api/node/:id` | one node with its edges, neighbours and last 50 events |
| `GET /api/health` | the contents of `health.json` |
| `GET /api/register?days=<n>` | the register log of the last `n` days, 30 by default |
| `GET /api/lexicon` | the concept schemes and their concepts |
| `GET /api/activity?since=<iso>&until=<iso>` | events in the window given, at most 500, as `{ events }` |
| `GET /api/activity?with_activation=1&since=<iso>` | the same events with the spread computed, as `{ items: { event, activation }[] }`, at most 2,000 |
| `POST /api/lexicon/check` | body `{ text }`, returns `{ hits }` from `lexicon-check` |
| `POST /api/lexicon/ratify` | body `{ concept }`, ratifies a proposed concept with today's date, then rebuilds |
| `POST /api/open` | body `{ path }`, opens a file under the projects folder or the Claude Code folder in its default program |
| `POST /api/sparql` | body `{ query }`, a read-only SPARQL query over the graph and the inferred facts, returns `SparqlResult`, or 400 for an update or an invalid query, 408 after 10 seconds and 503 while the store restarts |
| `GET /api/queries` | the saved queries in `ontology/queries/*.rq`, as `{ queries: { id, title, query }[] }` |
| `GET /api/inferred?node=<id>&kind=<kind>` | the facts in `inferred.json`, filtered by a node in their arguments and by kind, as `{ rules, facts }` |
| `GET /api/status` | build time, event count today, `product`, `version`, the sign-in state of Claude Code, running missions, and `reasoning` ({ engine, facts, built }) when `inferred.json` exists |
| `POST /api/compile` | runs build then check, and returns the new stats |
| `POST /api/plan` | body `{ prompt }`, returns a `Plan` |
| `POST /api/missions` | body `{ prompt, plan?, permission? }`, starts a mission, returns `{ id }`, or 403 with a plain message when the person has not agreed to agent runs or Claude Code is not signed in |
| `GET /api/missions` and `GET /api/missions/:id` | mission list and one mission |
| `POST /api/missions/:id/stop` | stops a mission and its process tree |
| `GET /api/stream` | Server-Sent Events, described below |

```ts
interface Plan {
  prompt_hash: string
  task_types: { id: string; label: string; matched: string[] }[]
  entities: { id: string; label: string; matched: string }[]
  fire: { id: string; a: number }[]                       // the nodes the plan will fire, with activation
  spread: { id: string; a: number; hop: number; via: string | null }[]   // the activation of the plan, hop by hop
  load: { path: string; node: string; reason: string }[]  // files the agent must read first
  steps: { agent: string; purpose: string }[]             // eg writer, then checker
  gates: { node: string; command: string }[]
  cautions: string[]                                      // eg a client-confidential node is in scope
}
```

The stream sends these messages, each as `event: <type>` with a JSON `data` line:

```ts
type StreamMessage =
  | { type: "hello"; built: string; status: unknown }
  | { type: "fire"; event: CortexEvent; activation: { id: string; a: number; hop: number; via: string | null }[] }
  | { type: "graph"; built: string }                      // the graph was rebuilt, so the client refetches
  | { type: "mission"; id: string; state: MissionState; step?: number; line?: MissionLine }
  | { type: "heartbeat"; ts: string }
type MissionState = "planned" | "running" | "checking" | "done" | "failed" | "stopped"
interface MissionLine { ts: string; kind: "text" | "tool" | "result" | "error" | "system"; text: string; tool?: string; path?: string }
```

### Token

When `CORTEX_TOKEN` is set, `GET /auth?t=<token>` sets the cookie `cortex_token` (HttpOnly, SameSite Strict, path `/`) and redirects to `/?shell=desktop`. Every request to `/api/` without that cookie, or without the header `x-cortex-token` that holds the token, then receives 401. Static files need no token, because they hold no data.

## Set-up, hooks and Claude Code routes

`<data_dir>/setup.json` records the agreement that the person gave in the first run. A null time means that the step has not been agreed.

```ts
interface SetupFile { v: 1; accepted_at: string | null; read_consent_at: string | null;
  hooks_installed_at: string | null; missions_consent_at: string | null; version: string }
interface SetupState extends SetupFile { product: "cortex" | "ranviera"; claude_home: string; claude_home_found: boolean;
  projects_root: string | null; memory_dirs: string[]; graph_built: string | null; counts: { nodes: number; edges: number } | null }
interface HookEntry { event: string; matcher?: string; command: string; async?: boolean }
interface ClaudeState { installed: boolean; version: string | null; signed_in: boolean; auth_method: string | null;
  plan: string | null; checked: string }
```

| Method and path | Purpose |
|---|---|
| `GET /api/setup` | the `SetupState` |
| `POST /api/setup/accept` | records `accepted_at`, returns the `SetupState` |
| `POST /api/setup/read` | body `{ projects_root?: string \| null }`, records `read_consent_at`, writes `projects_root` to the configuration file, runs the build and the reasoning, and returns the `SetupState`. A `projects_root` that names no existing folder gives 400 |
| `GET /api/hooks` | `{ installed, settings_path, entries: HookEntry[], backup_dir }`, where `entries` are the entries that Ranviera has added or would add |
| `POST /api/hooks/install` | merges the entries into `settings.json` after a dated backup, records `hooks_installed_at`, returns `{ installed: true, backup }` |
| `POST /api/hooks/uninstall` | removes only the Ranviera entries after a dated backup, returns `{ installed: false, removed, backup }` |
| `GET /api/claude` | the `ClaudeState`, from `claude --version` and `claude auth status`, never with the e-mail address of the account |
| `POST /api/claude/login` | opens a terminal window that runs `claude auth login`, returns `{ started, terminal, message }` |
| `POST /api/setup/missions-consent` | records `missions_consent_at`, returns the `SetupState` |

No route returns, logs or writes the output of `claude auth status` beyond the five fields of `ClaudeState`.

## Compiler commands

The compiler has the commands `build`, `check`, `reason`, `replay`, `lexicon-check`, `hooks preview`, `hooks install` and `hooks uninstall`, each of the hook commands with `--json` for the server. The command `hook <Event>` reads the hook payload on standard input and behaves as `hooks/cortex_hook.py` does. In the packaged application, the command `bin` copies the runner to `<data_dir>/bin/`, and the hook entries name that copy.

## Activation

Activation spreads from the nodes that an event fires. A fired node starts at the event weight. Each hop multiplies by the relation weight, by the decay factor 0.6 and by one over the square root of the out-degree of the node it leaves, and the spread stops at 2 hops or below 0.05. The relation weights are in `ontology/weights.json`, and both the Python reference implementation (`kg/cortex_kg/activation.py`) and the server (`server/src/activation.ts`) must give the same result on the fixtures in `kg/tests/fixtures/activation/`.

The long-run heat of a node is its ACT-R base-level activation, B = ln(Σ t_j^-0.5), where t_j is the age in days of each use, with a floor of 0.01 days. A node with no use has a base level of null.

## Provenance and freshness

Every edge in `graph.json` carries `provenance`, one of `stated` (parsed from a file), `computed` (derived by Ranviera code from file text, such as the restatements of `kg/cortex_kg/restate.py`), `ratified` (a curated assertion with status ratified), `proposed` (a curated assertion not yet reviewed) and `inferred` (derived by the rules). The key `inferred: true` stays on inferred edges for older readers. The rules read stated, computed and ratified edges only, so a proposed link never produces a finding until it is reviewed.

```ts
interface GraphEdge { s: string; r: string; t: string; w: number; evidence: string | null;
  provenance: "stated" | "computed" | "ratified" | "proposed" | "inferred"; inferred?: true }
```

The build also writes `graph.trig`, an RDF 1.1 dataset with one named graph for each kind of fact, so that a SPARQL query can tell them apart:

| Named graph | Holds |
|---|---|
| `https://cortex.local/graph/ontology` | `ontology/cortex.ttl` |
| `https://cortex.local/graph/stated` | the nodes with their datatype properties and the stated and computed edges |
| `https://cortex.local/graph/ratified` | the ratified assertions |
| `https://cortex.local/graph/proposed` | the proposed assertions |
| `https://cortex.local/graph/inferred` | the inferred edges and each finding as a `cx:Finding` with its check, severity, message and node |

The server loads `graph.trig` and answers queries over the union of the named graphs by default, and `GRAPH <...>` selects one. The namespace `cortex.local` is an identifier and not an address, and it keeps the identifiers stable across versions of the product.

## Assertion statuses and negated conditions

A curated assertion in `profile/assertions/*.json` has the status `proposed`, `ratified` or `rejected`. A rejected assertion stays in its file with `reviewed_on`, `reviewed_by` and `reason`, as the record of the review, and the build never applies it. A proposed assertion is drawn at half weight and feeds no rule, and a ratified one feeds the rules.

A proof in `inferred.json` records each negated condition of a rule as a child whose `fact` is `not <atom>`, with the variables filled in, and whose `rule` is `absent from the graph`.

## Brain view

`shared/brain.ts` exports `RegionId`, `REGIONS` (each with `id`, `label` (the category name shown on screen, such as Rules and decisions), `holds`, `name` (the anatomical name, shown only as a second line in the legend), `func` and `source`) and `regionOf(node, containerPath, domains)`, which returns the region of a node by the table in `BRAIN.md`. The web app loads `/brain/brain.glb`, `/brain/brain-points.bin` and `/brain/brain-regions.json`, as `scripts/brain/build-brain-asset.mjs` writes them. `GraphView` in `web/src/lib/store.ts` has `layout: "brain" | "network"` (default `"brain"`) and `hiddenRegions: RegionId[]`. The brain scene also has these controls, which the web app keeps in its own state and does not send to the server: the Surface opacity, the Expand distance from 0 to 1, the labels switch, auto-rotate and the focused region. The window event `cortex:view-inset` tells the scene how many pixels of the canvas the thought trail covers.

### The traced path (13 October 2026)

The brain view draws each prompt and each recorded agent run as one ordered path (`BRAIN.md`, "The traced path"). No stream message, route or server command is new. The shapes are held in `web/src/graph/brain/types.ts`.

```ts
interface TrailStep {                       // gains the optional fields marked new
  n: number; kind: string; sentence: string; ts: string; activation: Activation[]
  mode: "observed" | "predicted" | "recorded"   // new value "recorded": a step built from a recorded agent run
  label?: string                                // new: "recorded", "loaded" or "stated by the agent, cause unverified" (a run step only)
  markers?: PathMarker[]                        // new: findings shown on this step
  absent?: string[]                             // new: ids of nodes of the step that the graph on screen does not hold
}
interface PathMarker { severity: "violation" | "warning" | "info"; title: string; node: string | null }
interface TracePath { id: string; source: "live" | "replay" | "plan" | "run"; run: string | null; steps: TrailStep[] }
```

- The order of `TrailStep.activation` is the order in which the line visits the nodes of hop 0. For a step from the stream it is the order of `event.nodes`. A node of hop 1 or hop 2 is a branch from the node named in its `via`.
- `DecisionTrace` gains the optional ids `review.id`, `steps[].rationale.id` and `steps[].tool_id`, so that the path can reach every node of a run. A reader of an older server treats a missing id as absent from the graph.
- `BusEvents` gains `path-open: { path: TracePath }` and `path-progress: { id: string; n: number; fraction: number; playing: boolean }`. The scene listens to the window events `cortex:path-set`, `cortex:path-seek`, `cortex:path-play`, `cortex:path-frame`, `cortex:path-previous` and `cortex:path-follow`.
- The Graph window opens on a run through the `open` event with the parameter `trace` set to the run reference. `GraphView` gains `pathPrevious` (default `false`) and `pathFollow` (default `true`), which the web app keeps in its own state.

## Agent transparency contracts

This section fixes the shapes that the mapping store, the run ingestion, the ledger, the oversight commands, the views and the bundle exchange. Classes, relations and shapes are in `ONTOLOGY.md`, rules O03 to O07 and O09 to O14 are in `REASONING.md`, and the feature is described in `AGENT_TRANSPARENCY.md`. The instruction store, the identity contract, the view shapes and the routes are provisional until the maintainer's validation with second-line reviewers reports.

### Configuration keys for oversight

Each key has the default null or false, and an environment variable overrides the key. A pack loader that a bank supplies may add its own keys, which this document does not list.

| Key | Environment variable | Meaning |
|---|---|---|
| `include_private_graphs` | `CORTEX_INCLUDE_PRIVATE_GRAPHS` | false by default. When true, `to_dataset` writes the graph that a pack loader fills from a bank's own obligation pack into `graph.trig`, and `graph.json` carries its nodes. The public export does not carry them. |
| `monitoring_bounds` | `CORTEX_MONITORING_BOUNDS` | the path of the bounds file that the bank sets (below). Null means that no bound exists and rule O13 gives no finding. |
| `ledger_key` | `CORTEX_LEDGER_KEY` | the path of the key that signs the ledger head. Null means that the head is not signed and `ledger verify` reports the signature as absent. |
| `bundle_key` | `CORTEX_BUNDLE_KEY` | the path of the key that signs a bundle. The option `--key` overrides it. |
| `oversight_people` | `CORTEX_OVERSIGHT_PEOPLE` | the path of the people file (below). Null means that no write is allowed. |
| `oversight_actor` | `RANVIERA_ACTOR` | the person id of the person who uses this installation |
| `oversight_demo` | `RANVIERA_DEMO` | false by default. When true, the header `x-ranviera-actor` selects any person of the people file, and each view labels the identity 'demonstration identity'. |

`kg/cortex_kg/config.py` holds the keys as defaults and exposes each as a property of `Config`, with the environment variable taking precedence.

### Mapping file

A design time link is a mapping. Mappings are kept in `<profile_dir>/mappings/<scope>.json`, which the person or the bank owns and may keep under version control. The build reads them, and a mapping becomes a `cx:Mapping` node and, where its status allows, an edge.

```ts
interface MappingFile { v: 1; scope: string; mappings: MappingRecord[] }
interface MappingRecord {
  id: string                       // map:<yyyymmdd>-<nnn>, the date of creation and a counter that restarts each day
  relation: "implementsClause" | "realises" | "satisfies" | "expressedIn" | "notDischargedBy" | "detects" | "appliesTo" | "conflictsWith"   // 13 October 2026: expressedIn added (Obligation to LegislativeProvision only), conflictsWith added for suggest-conflicts
  s: string                        // node id of the source
  t: string                        // node id of the target
  status: "proposed" | "ratified" | "rejected" | "superseded"
  basis: string                    // the words of the clause or provision that support the link
  origin: "reviewer" | "suggested" | "imported"
  owner: string                    // person or role id
  maker: string                    // person id of the proposer
  checker: string | null           // person id of the ratifier or rejecter, which differs from the maker
  valid_from: string | null        // YYYY-MM-DD, set at ratification
  valid_to: string | null
  anchors: { s_hash: string | null; t_hash: string | null }   // sha256 of both ends at ratification
  reason: string | null            // required when rejected
  superseded_by: string | null     // the id of the mapping that replaces it
  suggestion?: ConflictSuggestion  // 13 October 2026: only on a conflictsWith mapping that suggest-conflicts wrote
  history: { ts: string; action: "propose" | "ratify" | "reject" | "edit" | "supersede" | "reassign"; by: string; note: string | null }[]
}
```

The rules for a mapping are these:

- A new mapping has the status proposed, an empty `checker` and null anchors.
- Ratification needs a checker who differs from the maker (shape F03), sets `valid_from` to the date of ratification, records the sha256 of both ends as anchors, and appends a history entry. It refuses where either end is absent from the graph.
- Rejection needs a reason, keeps the mapping in its file and appends a history entry.
- An edit of a ratified mapping returns it to proposed, clears the checker and the anchors and appends an `edit` entry. A ratified mapping is not edited in place, and a replacement is a new mapping with the old one marked superseded.
- A proposed mapping gives an edge of provenance `proposed` at half weight, a ratified mapping gives an edge of provenance `ratified`, and a rejected or superseded mapping gives no edge. The evidence of the edge is `<file>#<id>`, and check P08 resolves that form against the mapping file.
- An imported or suggested mapping carries `origin` and a `basis`. A suggestion does not have the status ratified at creation.
- Each ratification, rejection and reassignment is also a ledger entry of kind `mapping.ratify`, `mapping.reject` or `mapping.reassign`.
- The relation `expressedIn` allows the source class Obligation (an id of the form `obligation:<slug>`) and the target class LegislativeProvision (`provision:<slug>`). The store refuses any other class at either end. The other relations name no class at the store, and their classes are checked by the shapes. A ratified `expressedIn` mapping adds a link from an obligation to a provision and no other, so rules O01 to O14 read the same graph as before.

### The run record, `ranviera.run.v1`

A run is a series of lines, one JSON object each, in UTF-8 with no byte order mark. The format does not depend on beta telemetry. Each ingestion route (OpenTelemetry, hooks, gateway capture and this format) is normalised to it, and a conformance test checks that each route gives the same graph.

```ts
interface RunRecord {
  schema: "ranviera.run.v1"
  run: string                       // unique within the agent
  step: number                      // 0 for the opening record, then 1, 2 and so on without gaps
  ts: string                        // ISO 8601 UTC with milliseconds
  kind: "start" | "instructions" | "retrieval" | "tool" | "evidence" | "rationale" | "decision" | "review" | "end"
  agent: { id: string; model_version?: string; prompt_hash?: string; params?: Record<string, unknown> }   // model_version, prompt_hash and params are required when step is 0
  payload: {
    instructions_loaded?: { id: string; hash: string; path?: string }[]   // required on the record of kind start, so that O09 can compare
    tool?: string; input_hash?: string; output_hash?: string
    evidence?: { id: string; hash: string; source?: string; source_hash?: string }[]
    cited?: string[]                // instruction identifiers that the agent names for a decision step
    outcome?: "close" | "escalate" | "request-information"
    rationale_hash?: string; content_ref?: string          // the text is held in the controlled store and is not in the record
    override?: boolean; override_reason?: string           // on a record of kind review
    reviewer?: string; verdict?: string; time_open_s?: number; items_viewed?: number; checks_ticked?: string[]
    steps_reported?: number         // required on the record of kind end
    thinking_tokens?: number
  }
  trace?: { trace_id: string; span_id: string; parent_span_id?: string | null }
  case_ref?: string                 // the external case reference, which is not a suspicion decision
  ext?: Record<string, unknown>
}
```

A hash is written `sha256:` followed by 64 lower case hexadecimal characters. A record that breaks the shape is refused with its line number and nothing of its run is written. Two records with the same `run` and `step` are refused unless they are byte identical, in which case the second is ignored. The compiler normalises each record to a `CortexEvent` with `source: "run"` and the kinds `run.start`, `run.step`, `run.decision`, `run.review` and `run.end`, whose `meta` holds the record, so that the event stream and the thought trail read it as they read any event.

### The run ledger

Each record, each approval and each ratification becomes one line of an append only ledger in `<data_dir>/ledger/YYYY-MM.jsonl`, with the head in `<data_dir>/ledger/head.json`.

```ts
interface LedgerLine {
  v: 1
  seq: number                      // 1 for the first entry, continuous across month files
  ts: string
  kind: "run.record" | "instruction.approve" | "instruction.publish" | "mapping.ratify" | "mapping.reject" | "mapping.reassign" | "review"
  run: string | null
  step: number | null
  actor: string                    // the authenticated identity, or "system" for ingestion
  record_hash: string              // sha256 of the canonical JSON of the record or action
  prev_hash: string                // the entry_hash of the previous line, and 64 zeros for seq 1
  entry_hash: string               // sha256 of the canonical JSON of the fields above except entry_hash
}
interface LedgerHead { v: 1; seq: number; entry_hash: string; signed_at: string | null; alg: "hmac-sha256" | null; key_id: string | null; signature: string | null }
```

Canonical JSON has sorted keys, the separators `,` and `:`, UTF-8 text and no non-finite numbers. The head is signed by the bank's key (the key `ledger_key`). The algorithm is HMAC-SHA256 until the bank names an asymmetric scheme [To confirm: signature scheme for the bank]. An alteration or a deletion breaks the chain at that entry and gives a finding of rule O11. Personal data may be redacted from the controlled store, and the hash stays in the ledger.

The controlled store is `<data_dir>/store/<sha256>`. It holds the full text that a record names in `content_ref`, with role based access and encryption at rest where the bank enables it. The graph holds hashes only.

### The instruction store

The instructions of a deployed agent are kept in `<profile_dir>/instructions/<agent>.json`, where `<agent>` is the slug of the agent id, and the text of each version in `<profile_dir>/instructions/<agent>/<version-slug>.md`. The bank owns these files and may keep them under version control. The build reads them, and each version becomes a `cx:InstructionVersion` node.

```ts
interface InstructionFile {
  v: 1
  agent: string                    // dagent:<slug>, the DeployedAgent node
  owner: string                    // person id of the agent owner
  intended_use: string
  risk_tier: "high" | "medium" | "low"
  approved_models: string[]        // model:<slug> ids that rule O12 accepts
  instructions: InstructionRecord[]
}
interface InstructionRecord {
  id: string                       // instr:<agent>-<slug>, the logical instruction
  label: string                    // eg "Escalate a match on name and date of birth"
  file: string                     // the instruction file of the agent that holds it, eg "escalation-criteria.md"
  detects?: string[]               // typology ids, for rule O08
  versions: InstructionVersionRecord[]
}
interface InstructionVersionRecord {
  id: string                       // instr:<agent>-<slug>-v<n>, the node id that run records name in instructions_loaded
  version: number
  text: string                     // the path of the text file, relative to the instruction folder
  hash: string                     // sha256: of the text file as stored
  status: "draft" | "approved" | "withdrawn"
  maker: string                    // person id
  approver: string | null          // person id, which differs from the maker (O06)
  approved_hash: string | null     // the hash at approval
  valid_from: string | null        // YYYY-MM-DD, set at approval
  valid_to: string | null          // set when a later version is approved or the version is withdrawn
  conflicts_with?: string[]        // version ids that this version conflicts with (O03)
  overrides?: string[]             // version ids that this version takes precedence over
  history: { ts: string; action: "draft" | "approve" | "withdraw"; by: string; note: string | null }[]
}
```

A version gives the node `instr:<agent>-<slug>-v<n>` of class `InstructionVersion` with the props `hash`, `approvedHash`, `validFrom`, `validTo`, `version`, `instruction` and `file`, the status of the record, and the edges `operatesUnder` (agent to version), `proposedBy` and `approvedBy` (version to person), `conflictsWith`, `overrides` and `detects`. The agent gives a `DeployedAgent` node with the props `owner`, `intendedUse` and `riskTier`, an `ownedBy` edge and a `drawsOn` edge to each approved model, and an approved model gives a `ModelVersion` node of status `approved`. The hash of a version is recomputed from its text file at each build, so an edit of the text outside Ranviera changes `hash` and rule O06 reports the difference from `approved_hash`.

`instructions draft` writes a new version of status draft with the next number. `instructions approve` refuses an approver who is the maker or who lacks the approver role, sets `approved_hash` to the current hash and `valid_from` to the date, closes the interval of the version it replaces, and writes a ledger entry of kind `instruction.approve`.

### The policy pack

A bank keeps its own policy clauses, controls, obligations, provisions and typologies in `<profile_dir>/policy/*.json`, one file per source or business area. The build reads each file and merges its nodes and edges as stated content. The importers of legislation write the same shape, so that a provision imported from a public source and a provision written by the bank meet on the same id.

```ts
interface PolicyPackFile {
  v: 1
  name: string                     // eg "Example bank sanctions policy"
  source: string                   // eg "written from public sources, 7 October 2026"
  licence: string | null           // eg "Open Government Licence v3.0" for provisions from legislation.gov.uk
  attribution: string | null
  nodes: { id: string; type: "PolicyClause" | "Policy" | "Procedure" | "Control" | "Obligation" | "LegislativeProvision" | "Typology" | "RiskIndicator"
           label: string; status?: string; props: Record<string, unknown> }[]
  edges: { s: string; r: string; t: string; evidence?: string }[]   // stated edges only, such as expressedIn, appliesTo and partOf
}
```

A clause and a provision carry `text` and `hash` (sha256 of the text), so that rule O05 finds a clause amended after a mapping was ratified. An obligation carries `effective_date` and the status `active`, and an `appliesTo` edge to each deployed agent that it binds. A control carries `control_type`. A typology carries the status `active` and `source_url`. The links that a person decides, from an instruction to a clause, from a clause to a control and from a control to an obligation, are mappings in the mapping store and are not stated edges of the pack, because each needs a maker and a checker. A pack file that holds a node class outside the list above, or an edge of a relation that the mapping store owns, is refused with finding B08.

### Identity and roles

The server takes the actor of each write from its configuration and not from the body of a request. The keys are in the table of configuration keys above.

```ts
interface PeopleFile { v: 1; people: { id: string; name: string; roles: ("maker" | "checker" | "approver" | "reviewer" | "viewer")[] }[] }
```

A proposal and a draft need the role maker. A ratification and a rejection need the role checker and a person other than the maker of the mapping. A reassignment needs the role checker. An approval needs the role approver and a person other than the maker of the version. A withdrawal needs the role approver. A sample draw and a sample verdict need the role reviewer. Where no people file is configured, each write command refuses with exit 2. The server refuses a write that breaks one of these rules with status 403 and a sentence that names the rule, and the Python command refuses it again with exit 2. A bank deployment replaces the people file with its OIDC or SAML provider and maps roles from its groups [To confirm: provider per bank].

### Commands for the mapping workflow and the ledger

Each command runs as `python -m cortex_kg <command>`, accepts `--json`, and exits 0 on success, 1 on a finding or a failed check and 2 on a refused or invalid request.

| Command | Purpose |
|---|---|
| `mappings list [--status S] [--owner O] [--stale] [--scope F]` | lists mappings. `--stale` lists the ratified mappings whose anchors differ from the current hashes (rule O05). |
| `mappings propose --relation R --from S --to T --basis TEXT --owner O --by MAKER [--origin reviewer\|suggested\|imported] [--scope F]` | adds a proposed mapping and prints its id |
| `mappings ratify ID --by CHECKER [--note TEXT]` | ratifies it. Exit 2 where the checker is the maker or an end is missing. |
| `mappings reject ID --by CHECKER --reason TEXT` | rejects it and keeps it in its file |
| `ingest-run FILE\|- [--format run.v1\|otlp\|hook\|gateway]` | validates records, normalises them, writes the nodes of the run, appends ledger entries and signs the head where `ledger_key` is set. The default format is `run.v1`. |
| `ledger verify [--head FILE]` | checks the hash chain, the completeness of each run (captured steps against `steps_reported`) and the signature, and writes `<data_dir>/ledger/verify.json`. Exit 1 on a break. |
| `conflicts scan ROOT [--json]` | lists the candidate conflicts between the instruction files of the set-up at ROOT, found by 3 deterministic signals (a term banned by one rule and required by another, different numbers for one setting, and different members of one set of exclusive choices), with stated exceptions and different folders suppressed. A candidate is a proposal for a person to ratify or reject, and the list is the same on each run. |
| `suggest-conflicts ROOT [--write] [--owner O] [--by MAKER] [--scope S] [--model M] [--timeout SECONDS] [--chunk-chars N] [--raw-dir DIR] [--json] [--config FILE]` | asks a model for conflicts between the instruction files of the set-up at ROOT, keeps each suggestion whose two quotes are found word for word in the files, and lists them. It writes nothing unless `--write` is given. It needs the key `conflict_suggest_cmd` (below) and exits 2 without it. |

### Conflict suggestions

The scan above is deterministic and finds few conflicts. `suggest-conflicts` adds a model suggester whose output is a proposal and never a finding. A suggestion enters the mapping store as a mapping of the relation `conflictsWith`, with the origin `suggested` and the status `proposed`. A person ratifies or rejects it, and only a ratified mapping gives an edge that rules R04 and O03 read.

Model calls are off by default. The key `conflict_suggest_cmd` (environment variable `CORTEX_CONFLICT_SUGGEST_CMD`, a JSON array or one path) names the command that the person or the bank allows, and a null key makes the command refuse with exit 2 and make no call. The command must accept the headless flags of Claude Code and print its JSON result on standard output. The module sends the prompt on standard input, runs the command in an empty temporary folder, limits the setting sources to the project and local sources, gives the model no tools, and removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment of the call. The default model is `sonnet` and the default time limit is 600 seconds for each call.

The module numbers the lines of the instruction files (every `CLAUDE.md`, `.claude/rules/*.md` and `.claude/agents/*.md`) and sends them in chunks of at most `--chunk-chars` characters (default 60000), cut at file boundaries. Where there is more than one chunk, each chunk and each pair of chunks is sent.

```ts
interface ConflictSuggestion {   // the optional key `suggestion` of the mapping record
  v: 1
  a: { file: string; line: number; quote: string }   // file relative to ROOT, the line that holds the quote
  b: { file: string; line: number; quote: string }
  reason: string
  model: string                  // the model that answered
  version: string                // the version of the command, from its --version, or unknown
  time: string                   // UTC time of the call
}
```

- A suggestion is kept only where each quote is found word for word (ignoring white space) in the named file and the two sides are different lines. A suggestion that fails is dropped and counted.
- Two suggestions for the same two lines are one.
- The mapping has `origin` `suggested`, `status` `proposed`, `maker` from `--by` (default `conflict-suggester`), `owner` from `--owner` (required with `--write`) and a `basis` that holds both quotes, their files and lines, and the reason. Its ends are the ids of the Rule nodes of `graph.json` whose evidence ends with `<file>:<line>`, or `<file>:<line>` where the graph holds none. A mapping whose end is not a node cannot be ratified.

### The bounds file of the bank

The file named by `monitoring_bounds` holds the thresholds of rule O13. Ranviera sets none, because the bank owns its risk appetite.

```json
{ "v": 1, "agents": { "dagent:alert-triage": { "override": { "min": null, "max": 150 }, "review_seconds": { "min": 20, "max": null } } } }
```

A measure of kind `override` is in thousandths of reviewed decisions, and a null bound is not checked.

### Oversight commands

Each command runs as `python -m cortex_kg <command>`, accepts `--json` and keeps the exit codes above. The view commands read `graph.json`, `inferred.json`, the run records, the mapping and instruction stores and the ledger, and write nothing.

| Command | Purpose |
|---|---|
| `oversight runs [--agent A] [--outcome O]` | lists the runs as `RunSummary[]` |
| `oversight trace RUN` | prints the `DecisionTrace` of one run |
| `oversight coverage [--agent A]` | prints the `CoverageMatrix` |
| `oversight instructions [--agent A]` and `oversight instruction ID` | list the instructions, and print the `InstructionDetail` of one |
| `instructions draft ID --text-file F --by MAKER` and `instructions approve VERSION --by APPROVER` | write the instruction store as above |
| `monitor [--agent A] [--from D] [--to D]` | prints the `MonitoringReport` |
| `sample draw --agent A --size N [--seed S] [--risk-weighted] --by REVIEWER` and `sample verdict SAMPLE RUN --verdict agree\|disagree --by REVIEWER [--reason TEXT]` | draw a sample into `<profile_dir>/samples/<id>.json` and record a verdict |
| `backtest compare --agent A --version V --replays FILE --dispositions FILE` | compares the decisions of replayed runs with the final dispositions of closed alerts and writes `<data_dir>/backtests/<id>.json` |
| `pack export --scope alert:ID\|run:ID\|agent:ID\|period:FROM..TO [--out DIR]` | writes the evidence pack below and prints its manifest |
| `bundle build --agent A [--key FILE] [--out DIR]` and `bundle verify DIR [--key FILE]` | write and check the signed bundle below |

Ranviera does not run the model. A back-test compares replays that the bank's harness produced in the `ranviera.run.v1` format, each with `ext.backtest` set to the back-test id, against a dispositions file `{ v: 1; alerts: { case_ref: string; final: "close" | "escalate" | "request-information" }[] }`.

### View shapes

```ts
interface RunSummary { run: string; agent: string; case_ref: string | null; ts: string; outcome: string | null; reviewed: boolean; override: boolean; findings: number; replayable: boolean }
interface InstrRef { id: string; label: string; version: number | null; status: string | null; in_force: boolean
                     maker: string | null; approver: string | null; approved_on: string | null; self_approved: boolean }   // 13 October 2026: the people and the day of the approval, from the instruction store
interface ChainLink { mapping: string | null; relation: string; from: string; to: string; to_label: string; to_type: string; status: "stated" | "ratified" | "proposed" | "missing"
                    maker?: string | null; checker?: string | null; since?: string | null
                    clause_ref?: string | null; policy?: string | null }   // 13 October 2026: from the mapping record, absent on a missing link. clause_ref and policy are on a link to a policy clause (the clause number and the policy that holds it)
interface DecisionTrace {
  run: string
  agent: { id: string; label: string }
  model: { id: string; status: string | null; approved: boolean; approver?: string | null; approved_on?: string | null }   // 13 October 2026: who approved the model version and on what day, from the instruction store (model_approvals), null where the version is not approved
  case_ref: string | null
  decision: { id: string; outcome: string; step: number; ts: string } | null
  review: { id?: string; reviewer: string; verdict: string | null; override: boolean; override_reason: string | null; time_open_s: number | null; items_viewed: number | null; checks_ticked: string[] } | null   // id: 13 October 2026, the Review node, for the brain path
  steps: { id: string; step: number; kind: string; ts: string; tool: string | null; tool_id?: string | null   // tool_id: 13 October 2026, the ToolCall node
           evidence: { id: string; label: string; hash: string | null; source: string | null }[]
           in_context: InstrRef[]; cited: InstrRef[]
           rationale: { id?: string; hash: string; content_ref: string | null; text: string | null } | null   // id: 13 October 2026, the StatedRationale node. text: 13 October 2026, read at view time from the content store, null where it is not held
           findings: TraceFinding[] }[]
  chains: Record<string, ChainLink[]>   // by instruction version id, the links to clause, control, obligation and provision
  findings: TraceFinding[]              // all findings of the run, with their proofs
  ledger: { entries: number; verified: boolean | null; breaks: number
            reported?: number; notes?: { seq: number | null; step: number | null; reason: string }[] }   // 13 October 2026: where the chain breaks
  replayable: boolean
  labels: { recorded: "recorded"; loaded: "loaded"; stated: "stated by the agent, cause unverified" }
}
interface TraceFinding { check: string; severity: "violation" | "warning" | "info"; node: string; message: string; proof: unknown | null }
interface CoverageMatrix {
  agent: string | null
  columns: { id: string; label: string; type: "Control" | "PolicyClause" | "InstructionVersion" }[]
  rows: { obligation: string; label: string; provision: { id: string; label: string } | null
          state: "covered" | "partial" | "gap" | "exempt"
          cells: Record<string, "ratified" | "proposed" | "stated">   // by column id, only where a link exists
        }[]
  findings: TraceFinding[]              // O01, O02 and O08, which a bank's obligation pack supplies
  earlier_versions: { id: string; label: string; runs: number }[]   // 13 October 2026: approved versions no longer in force, with no ratified clause, that past decisions cited (rule O02 reads only the versions in force today)
}
interface InstructionDetail {
  id: string; label: string; agent: string; file: string
  versions: (InstructionVersionRecord & { in_force: boolean })[]
  diff: { from: string; to: string; lines: { op: "same" | "add" | "remove"; text: string }[] } | null   // the last 2 versions
  mappings: MappingRecord[]
  findings: TraceFinding[]
  impact: { stale_mappings: string[]; decisions: { run: string; decision: string; ts: string }[] }   // for the latest draft against the version in force
}
interface MonitoringReport {
  from: string | null; to: string | null
  agents: { id: string; label: string; runs?: number; runs_recorded?: number; decisions: number; reviewed: number   // 13 October 2026: the runs inside the period and all the runs recorded for the agent
            override_per_mille: number | null; review_seconds_mean: number | null
            agreement_by_version: Record<string, { sampled: number; agree: number }>
            bounds: Record<string, { min: number | null; max: number | null }>
            drift: { kind: "instruction" | "model" | "snapshot" | "override"; detail: string; since: string }[]
            backtests: { id: string; version: string; n: number; agreement: number; false_closures: number; false_escalations: number }[]
          }[]
  findings: TraceFinding[]              // O13 and the faithfulness results where recorded
}
```

Presentation of the view shapes, 13 October 2026. No shape changed. The Oversight window shows the data as follows: the agent by `agent.label` with the prefix `dagent:` removed and the first letter capitalised, a person by the name in the people file that `GET /api/oversight/status` returns, an outcome as Closed, Escalated or Information requested, a relation in plain words (`implementsClause` as 'implements the clause', `realises` as 'realises the control', `satisfies` as 'satisfies the obligation'), and a date as '12 August 2026'. The identifier stays in a title attribute. The decision trace shows the findings of the run and the basis of the decision (the instructions cited at the decision step with their chains, the evidence read and the rationale reference) under the decision, and lists the instructions in context once, at the first step, with later steps noting only what changed. Second pass, 13 October 2026: `CoverageMatrix.earlier_versions` is new (optional for a reader of an older server). `pack.json` carries `names`, a map from identifier to name that the readable document uses, so that `pack.html` shows names, dates in the form 12 August 2026 and the facts of a proof in sentences, while `pack.json` keeps the identifiers. Later on 13 October 2026 the view shapes gained fields. `DecisionTrace.model` gains `approver` and `approved_on` (optional), `ChainLink` gains `clause_ref` and `policy` on a link to a policy clause, and `MonitoringReport.agents[]` gains `runs` and `runs_recorded` (optional), which the readable pack uses to say how many of the recorded runs its monitoring summary covers. The instruction store gains `model_approvals`, a map from model version to `{ approver, approved_on }`, and the model node carries `approvedBy` and `approvedOn` as properties. The finding code stays in the data and no longer appears on screen.


### Evidence pack

`pack export` writes a folder `<out>/pack-<scope>-<YYYYMMDD-HHMMSS>/` that holds `pack.json` (the scope, the build time, the graph hash, the decision traces in scope, the instruction versions with approvals, the mapping chain, the findings with proofs, the ledger head and the completeness result, the monitoring report and the back-tests), `pack.html` (the same content as a document that prints, with the labels of the trace and the limits stated in `AGENT_TRANSPARENCY.md`) and `manifest.json` (`{ v: 1; created: string; files: { path: string; sha256: string; bytes: number }[] }`). A period pack leads with the coverage matrix and the monitoring summary. The pack holds hashes and content references and no text from the controlled store.

### Oversight routes

These routes are provisional until the maintainer's validation with second-line reviewers reports. A read calls the matching command, and a write calls it with the actor of the configuration, then runs build and check and returns the updated object.

| Method and path | Purpose |
|---|---|
| `GET /api/oversight/status` | `{ available, actor, demo, people }`, where `available` is true when the data folder holds a run, a mapping or an instruction store |
| `GET /api/oversight/runs` | `RunSummary[]` |
| `GET /api/oversight/trace/:run` | `DecisionTrace` |
| `GET /api/oversight/coverage?agent=` | `CoverageMatrix` |
| `GET /api/oversight/mappings?status=&owner=&stale=1` | `MappingRecord[]` |
| `POST /api/oversight/mappings/:id/ratify`, `/reject` and `/reassign` | bodies `{ note? }`, `{ reason }` and `{ owner }` |
| `GET /api/oversight/instructions` and `GET /api/oversight/instructions/:id` | the list and one `InstructionDetail` |
| `POST /api/oversight/instructions/:id/draft` and `POST /api/oversight/versions/:id/approve` | bodies `{ text }` and `{}` |
| `GET /api/oversight/monitoring` | `MonitoringReport` |
| `POST /api/oversight/samples` and `POST /api/oversight/samples/:id/verdict` | bodies `{ agent, size, seed?, risk_weighted? }` and `{ run, verdict, reason? }` |
| `POST /api/oversight/pack` | body `{ scope }`, returns `{ path, manifest }` |

As built on 7 October 2026 (`server/src/oversight.ts`), the routes differ from the table in these points:

- `GET /api/oversight/status` returns `{ available, actor, demo, people }`, where `actor` is the person id or null and `people` is the list of the people file (`{ id, name, roles }[]`, empty where no file is configured). Where `oversight_demo` is true, the header `x-ranviera-actor` selects the actor only when it names a person of the people file. A write with an unknown name in the header is refused with 403 and does not fall back to the configured person. Where `oversight_demo` is false, the header is ignored.
- The server answers 403 with one sentence for each refusal of the role rules, for example 'The maker of a mapping may not ratify it.' or 'Ana Reyes does not hold the role checker, which ratifying a mapping needs.' A sample draw needs the role reviewer, as a verdict does.
- A read accepts the filters of its command: `agent` and `outcome` on `/runs`, `agent` on `/coverage`, `/instructions` and `/monitoring`, and `from` and `to` (YYYY-MM-DD) on `/monitoring`. The compiler exit code 1 of `monitor`, `oversight trace` and `oversight coverage`, which signals findings, is accepted where the output is the report.
- A write to a mapping or an instruction runs build and check, reloads the graph and returns the updated `MappingRecord` or `InstructionDetail`. A sample draw, a verdict and a pack export write no graph content, so they do not rebuild. A draw and a verdict return the `SampleRecord` that the command prints.
- A compiler refusal (exit 2) is returned as 400, or as 404 where the sentence says that no record matches. The sentence is in `{ error }`.
- The web app sends the person chosen in the 'Acting as' selector in the header `x-ranviera-actor`, which only a demonstration server reads.
- `npm run demo` (`scripts/demo/start.mjs`) builds the demonstrator into a folder and starts the server with `CORTEX_CONFIG` set to `<folder>/ranviera.config.json`. It prints the compiler's sentence and exits 2 where the demonstrator is not installed.

### The signed bundle and the verifier

`bundle build` writes `<out>/<agent>-<YYYYMMDD-HHMMSS>/` with the text of each instruction version in force, `bundle.json` (`{ v: 1; agent; created; model_versions: string[]; versions: { id; file; path; hash; approver; approved_at }[]; files: { path; sha256 }[] }`) and `bundle.sig` (HMAC-SHA256 of the canonical JSON of `bundle.json` under the key of `bundle_key` or `--key`). The `path` of a version names its text file in the bundle, because several instructions may share one instruction file. The verifier is `kg/cortex_kg/verifier.py`, which uses the Python standard library only, so that a bank can copy it into its agent start up. It checks the signature and each hash, returns the files to load and gives the `instructions_loaded` list for the opening record of a run, so that rule O09 compares the hashes that the agent loaded with the approved hashes.

## Changes to this document

- 13 October 2026: the traced path of the brain view. `TrailStep` gains the mode `recorded` and the optional fields `label`, `markers` and `absent`, `TracePath` is new, `DecisionTrace` gains the optional ids `review.id`, `steps[].rationale.id` and `steps[].tool_id`, `BusEvents` gains `path-open` and `path-progress`, and the Graph window opens on a run. No route or stream message is new.
- 13 October 2026: the mapping store accepts the relation `expressedIn`, from an Obligation to a LegislativeProvision. `MappingRecord.relation` gains the value, the store refuses `expressedIn` between any other classes, and the Oversight views word it as 'is expressed in the provision'.
- 13 October 2026: the model suggester of conflicts. The command `suggest-conflicts`, the key `conflict_suggest_cmd` (null by default, environment variable `CORTEX_CONFLICT_SUGGEST_CMD`), the shape `ConflictSuggestion`, the relation `conflictsWith` in the mapping store and the optional key `suggestion` of a mapping record.
- 7 October 2026: agent transparency contracts. The configuration keys for oversight, the mapping file, the run record `ranviera.run.v1`, the run ledger, the instruction store, the policy pack, identity and roles, the oversight commands, the view shapes, the evidence pack, the oversight routes (provisional), the signed bundle and its verifier, the bounds file and the conflict scan command.
- 12 October 2026: the compiler writes what shapes F02 to F04, F06, F08 and F14 read. A mapping node gains `sourceAnchor`, `targetAnchor` and `ratifiedOn` (ratified only) and the edges `ownedBy`, `proposedBy` and `approvedBy` (the last for a ratified mapping only) to Person nodes of the stated provenance, with the evidence `mappings/<scope>.json#<id>`. A Run node gains `promptHash`, a decision node gains a `statesRationale` edge to the last stated rationale before it (a rationale serves one decision), and the transparency stage writes a `ledger:<seq>` LedgerEntry node (`seq`, `recordHash`, `prevHash`, `entryHash`) with an `entryOf` edge to its run for each ledger entry that names a run. Check P08 also accepts `instructions/<agent>.json` and `instructions/<agent>.json#<version id>`, resolved in the profile folder and checked for the version, and resolves a bare vocabulary file name in `<profile>/vocab`.
- 13 October 2026: the views answer the review of three second-line roles. `ChainLink` gains `clause_ref` and `policy` on a link to a policy clause, `DecisionTrace.model` gains `approver` and `approved_on` from the new `model_approvals` of the instruction store, and an agent of `MonitoringReport` gains `runs` and `runs_recorded`. The demonstrator records the approver and the day of each approved model version.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

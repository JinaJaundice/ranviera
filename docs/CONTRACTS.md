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

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

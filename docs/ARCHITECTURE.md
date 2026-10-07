# Ranviera architecture

Ranviera is a local application that holds a person's Claude Code set-up as a knowledge graph. It keeps the set-up consistent through an ontology, a controlled vocabulary and validation, and it shows the graph live as each part is used. It also runs Claude Code agents with context chosen from the graph. This document sets out the parts, how they connect and the controls that stop a set-up degrading. The data shapes are fixed in `CONTRACTS.md` and the classes and relations in `ONTOLOGY.md`.

## Purpose

A Claude Code set-up grows over months into a large collection of instruction files, rules, skills, agents, hooks and memory files. The collection tends to drift, because rules are copied into several files, a rule is replaced but its older copy remains, and a path that a rule cites is later moved. Ranviera has 5 jobs:

- hold each rule, agent, hook, tool, memory file, project and term as a typed node with its source file and line
- check the whole set-up against the ontology on each build, and report each broken reference, conflict, duplicate and naming variant
- give each thing one preferred name, and flag the variants in prose
- record each use of a node as an event, and show the firing and its spread through linked nodes as it happens
- run Claude Code agents from a mission, with the files, agents and checks for the task chosen by the graph.

## Parts

| Part | Folder | Language | Job |
|---|---|---|---|
| Ontology | `ontology/` | Turtle and JSON | the classes, relations, SHACL shapes, rules, saved queries and the starting vocabulary and weights |
| Graph compiler | `kg/cortex_kg/` | Python, rdflib, pySHACL, Nemo | harvests the set-up, builds the graph, validates it, reasons over it and writes the runtime files |
| Event hook | `hooks/cortex_hook.py` and the `hook` command of the compiler | Python | turns Claude Code hook calls into events |
| Server | `server/src/` | TypeScript on Node | the API, the event stream, activation, planning and missions |
| Web app | `web/src/` | React, Vite, Tailwind, 3d-force-graph | the desktop shell and its windows |
| Desktop shell | `desktop/` | Electron | the packaged application, with the server in a utility process |
| Packaging | `packaging/` and `scripts/build/` | PyInstaller, esbuild | builds the compiler executable `ranviera-kg` and the server bundle |

In development, the launcher `cortex.py` in the repository root runs the compiler commands, for example `python cortex.py build`. The packaged application runs the same commands through the executable `ranviera-kg`.

## Content of the product and content of the person

The code is the same for everyone, and a person's content is not. The compiler reads the starting content from `ontology/defaults/` and then the person's own content from the profile folder in the data folder, so that the profile adds to or replaces the defaults entry by entry. On the first build, the compiler copies the default vocabulary and task types into a new profile, so that a person can edit and ratify their own vocabulary without changing the product. Nothing of a person's content is read from the repository.

## The graph compiler

The compiler runs in 4 steps, and each step can run alone from the command line.

- **Harvest.** Readers for the Claude Code folder, the skills, the memory folders, the optional projects folder and the vocabulary parse the files with fixed rules and return nodes and edges. Each node and edge carries its source as file and line. The harvest uses no language model, and 2 builds of the same files therefore give the same graph.
- **Assert.** Relations that parsing cannot find with certainty, such as one rule restating another or 2 rules in conflict, are kept as curated assertions. Each assertion names its source, its date and who made it, and it has the status proposed, ratified or rejected.
- **Compile.** The nodes, edges and assertions are joined with the ontology in one rdflib graph and written to the data folder as `graph.json`, `graph.ttl`, `graph.trig` and `index.json`. The compiler also writes a change record for the day, which lists each node added, changed or removed since the last build.
- **Validate.** pySHACL checks the graph against `ontology/shapes.ttl`, rules written in Nemo derive further findings, and Python checks cover what SHACL cannot, such as whether a cited path exists. The result is written to `health.json`.

### Stable identifiers for rules

An atomic rule is a single bullet or numbered instruction in a rule, reference or guide file. Its identifier must survive edits, because the event history and the curated assertions refer to it. The compiler keeps a rule ledger that maps each identifier to the rule's text fingerprint, its file and its first and last dates seen. On each build the compiler matches each bullet to the ledger, first by exact fingerprint and then by text similarity of 0.8 or more within the same file. A matched bullet keeps its identifier and a new bullet takes the next free one. A ledger entry with no match is marked retired with the build date and is never reused.

### Sensitivity

Each node carries a sensitivity of public, internal or client-confidential, which lets a person keep sensitive content out of a view or an export. The configuration key `include_sensitivity` chooses which levels the compiler includes. All content stays on the person's computer.

## Events and activation

The hook records each use of a node as an event. It reads `index.json`, maps the call to node identifiers and appends one event to the month's event file. It runs asynchronously where Claude Code allows and stores no prompt text by default. It exits with code 0 on any fault and cannot therefore slow or stop a session.

| Hook call | Event | Nodes fired |
|---|---|---|
| a session starts | `session.start` | the map file, the output style and the session-start hooks |
| a prompt is sent | `prompt` and `route` | the routes whose patterns match, their task types and the entities named |
| a file is read | `read` | the node for that path, or the folder that holds it |
| a file is written or edited | `write` | the node for that path, or its project folder |
| a skill, agent or workflow starts | `skill`, `agent.start`, `workflow` | the skill or agent node |
| another tool runs | `tool` | the tool script, gate or built-in tool |

On each event the server spreads activation from the fired nodes through the graph, as fixed in `CONTRACTS.md`, and sends the result to the web app. The web app lights each node in proportion to its activation and sends a pulse along each edge that the spread crossed. Each hop starts after the one before it. A node's resting glow and size come from its ACT-R base-level activation, and the parts used often and recently are therefore brighter. The relation weights in `ontology/weights.json` set how far activation travels.

## Missions

A mission is a task that Ranviera runs through Claude Code agents. The person types the task, and the server builds a plan from the graph before anything runs. The plan comprises:

- the task types whose routes match the prompt, and the projects, clients and apps it names
- the files that the agent must read first, each with the reason it was chosen
- the agent steps for the task, such as a writer and then a checker
- the gates to run before the mission is done
- the cautions, such as a client-confidential node in scope.

The plan fires its nodes in the graph, and the person sees what the agents will use before they start. When the person starts the mission, the server runs each step as `claude -p` with the stream-json output, the named agent and the plan appended to the system prompt. The stream is parsed into mission lines, files written and costs, and each tool call fires its nodes. The tool list given to each step excludes commands that push, publish or send.

Missions stay off until Claude Code is signed in and the person has agreed, once, that each run uses Claude Code under their own plan and its limits. Anthropic may change how `claude -p` counts against a subscription, and the product says so before the first run.

## The web app

The web app is a desktop shell over the live graph. The graph fills the background and runs at all times. A top bar shows the state of the system, a dock opens the windows, and a command palette (Ctrl K) searches each node and starts a mission. The windows are:

- **Missions**, the agent manager, with the composer, the plan, one lane for each agent step, the stream, the files written and the gate results
- **Graph**, the graph in front with the brain and network layouts, filters, search, a node inspector, the thought trail and a replay of past use. The brain layout groups the neurons into 10 regions that are named after their categories (see `BRAIN.md`), with clusters, and it has Surface, Expand and navigation controls
- **Rules**, each rule by task type and file, with its date, its status and its links
- **Lexicon**, the vocabulary by scheme, with a text check and the ratification of proposed terms
- **Projects**, each project with its status, open items and recent activity
- **Pulse**, the live event feed and the most and least used nodes
- **Query**, SPARQL queries over the graph and the inferred facts, with saved queries and the proof of each inferred fact
- **Health**, the validation results and the rebuild control.

Each colour is a token, the type ladder has an 11px floor, the icons are Lucide, and the light and dark themes override tokens only. Glow, gradients and motion are used inside the graph only, where they encode activation.

## Packaging and the desktop shell

Each installer carries everything that the product needs, so that a person needs no Python, Node or Git. It holds the web app built by Vite, the server bundled by esbuild into one module with the Oxigraph WebAssembly file beside it, the compiler built by PyInstaller, and the ontology files with the starting content. The server finds the compiler through the configuration key `kg_cmd`, which the application sets to the bundled executable, and it falls back to `python cortex.py` in development.

The Electron shell keeps context isolation and the sandbox, adds a content security policy that allows only the application's own origin, denies every permission request, and blocks navigation and new windows outside its origin. It sets the Electron fuses that turn off running as Node, the Node options variable and the inspector flags, and that turn on the integrity check of the application archive. The server listens on 127.0.0.1 on a free port, and every API request must carry a random token that the shell creates at each launch and hands to the window through a cookie that is HttpOnly and SameSite Strict.

## Controls against degradation

| Control | Where it runs | What it catches |
|---|---|---|
| Rule ledger | every build | a rule that changed or disappeared without a record |
| SHACL shapes and Python checks | every build and CI | broken paths, missing fields, a route with no target, an index line with no memory file |
| Reasoning rules | every build | conflicting rules, rules that restate each other with different dates, unrouted files, idle projects |
| Vocabulary check | the Lexicon window and the compiler command `lexicon-check` | a thing called by a variant of its preferred name |
| Cold-node report | the Pulse window and the reasoning rules | rules and references that have not been used for a long time, for review |
| Change record | every build | what changed in the graph and when |

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

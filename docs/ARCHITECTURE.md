# Ranviera architecture

Ranviera is a local application that holds a person's Claude Code set-up as a knowledge graph. It keeps the set-up consistent through an ontology, a controlled vocabulary and validation, and it shows the graph live as each part is used. It also runs Claude Code agents with context chosen from the graph, and it helps a person learn from their own material through linked sources, a graph of claims and learning sessions. This document sets out the parts, how they connect and the controls that stop a set-up degrading. The data shapes are fixed in `CONTRACTS.md` and the classes and relations in `ONTOLOGY.md`.

## Purpose

A Claude Code set-up grows over months into a large collection of instruction files, rules, skills, agents, hooks and memory files. The collection tends to drift, because rules are copied into several files, a rule is replaced but its older copy remains, and a path that a rule cites is later moved. Ranviera has 6 jobs:

- hold each rule, agent, hook, tool, memory file, project and term as a typed node with its source file and line
- check the whole set-up against the ontology on each build, and report each broken reference, conflict, duplicate and naming variant
- give each thing one preferred name, and flag the variants in prose
- record each use of a node as an event, and show the firing and its spread through linked nodes as it happens
- run Claude Code agents from a mission, with the files, agents and checks for the task chosen by the graph
- link notes, PDF files and Claude Code material as sources, extract claims and arguments from them, and run learning sessions against that graph.

## Parts

| Part | Folder | Language | Job |
|---|---|---|---|
| Ontology | `ontology/` | Turtle and JSON | the classes, relations, SHACL shapes, rules, saved queries and the starting vocabulary and weights |
| Graph compiler | `kg/cortex_kg/` | Python, rdflib, pySHACL, Nemo | harvests the set-up, builds the graph, validates it, reasons over it and writes the runtime files |
| Event hook | `hooks/cortex_hook.py` and the `hook` command of the compiler | Python | turns Claude Code hook calls into events |
| Server | `server/src/` | TypeScript on Node | the API, the event stream, activation, planning and missions |
| Learning runtime | `server/src/learn/` | TypeScript on Node | linked sources, extraction, the knowledge store, learning sessions, background jobs and the model layer |
| Learning types | `shared/learn/` | TypeScript | the shapes shared by the server and the web app for sessions, knowledge, sources, jobs, models and events |
| Skill | `skills/cortex-knowledge/` | Python, standard library only | a Claude Code skill that reads the learning folder without a running application |
| Web app | `web/src/` | React, Vite, Tailwind, 3d-force-graph | the desktop shell and its windows, including Learn, Sources and the Knowledge layer of the Graph window |
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

The web app is a desktop shell over the live graph. The graph fills the background and runs at all times. A top bar shows the state of the system, a dock opens the windows, and a command palette (Ctrl K) searches each node and starts a mission. The registry in `web/src/apps/registry.ts` defines 13 windows, and 10 of them open with Alt and a digit. Oversight, Learn and Sources have no shortcut. The windows are:

- **Missions**, the agent manager, with the composer, the plan, one lane for each agent step, the stream, the files written and the gate results
- **Graph**, the graph in front with the brain and network layouts, filters, search, a node inspector, the thought trail and a replay of past use. The brain layout groups the neurons into 10 regions that are named after their categories (see `BRAIN.md`), with clusters, and it has Surface, Expand and navigation controls. A layer switch chooses between Structure, which is the graph of the set-up, and Knowledge, which is the graph of claims described below
- **Rules**, each rule by task type and file, with its date, its status and its links
- **Lexicon**, the vocabulary by scheme, with a text check and the ratification of proposed terms
- **Projects**, each project with its status, open items and recent activity
- **Pulse**, the live event feed and the most and least used nodes
- **Query**, SPARQL queries over the graph and the inferred facts, with saved queries and the proof of each inferred fact
- **Health**, the validation results and the rebuild control
- **Oversight**, the review of agent decisions, described in `AGENT_TRANSPARENCY.md`
- **Learn**, the learning sessions
- **Sources**, the folders and files that feed the knowledge graph
- **Settings**, the set-up steps, the hooks, the keys and models for learning, and the learning options
- **About**, the product information.

Each colour is a token, the type ladder has an 11px floor, the icons are Lucide, and the light and dark themes override tokens only. Glow, gradients and motion are used inside the graph only, where they encode activation.

## The learning upgrade

The learning upgrade adds a second graph beside the graph of the set-up. It holds claims that a person's own material makes, the arguments that join them, and the record of what the person has answered. The method of teaching is set out in `LEARNING.md`, and the data shapes, routes and limits are in `CONTRACTS.md`.

### The learning runtime

The learning runtime lives in `server/src/learn/`. The server composes it at start in `server/src/learn/index.ts`, and each part receives its paths and its neighbours as arguments, so that no part reads the global configuration. The parts are:

| Folder | Job |
|---|---|
| `sources/` | the registry of linked roots, the scan of each root, the readers for the 7 kinds of source, the path rules and the passage that a line locator points to |
| `extract/` | the extraction of claims from a file or a session, in an extractor stage and an auditor stage, with the merge of the result into the knowledge store |
| `knowledge/` | the store of claims and arguments, the coverage records, the layout of the graph, the organisation of sources, deletion and the snapshot that the web app reads |
| `runtime/` | the learning sessions, the turn stream, the steering of a turn, the compaction of a long history, the file tools and the writer lock |
| `method/` | the prober, the teacher and the practice agent, their prompts and tools, the plan tree of a session and the record of graded answers |
| `jobs/` | background work for a session, which is web research and the reading of a PDF file |
| `models/` | the model catalogue, the keys store, the custom endpoint, the Claude Code provider and the sensitivity gate |
| `images/` | the checking and resizing of an image before a model receives it |
| `adapters/` | the connections between these parts, such as the model resolver, the sensitivity of a session and the events that light nodes in the brain |

The routes are under `/api/learn/`. They are not registered when the configuration key `learn_enabled` is false, and the Learn and Sources windows are then hidden. Each learning event, such as a turn, an answer or an extraction, is relayed on the existing event stream, so that the brain shows learning activity as it shows any other use.

### Sources and extraction

A person links a root, which is a folder, and gives it a kind, a sensitivity and a mode. The 7 kinds are notes, PDF files, Claude memory, Claude Code transcripts, Claude instructions, project Markdown and LearnHarness folders. Each kind has default include and exclude patterns and a default sensitivity. In manual mode a root is read only when the person asks, and in scan mode the server checks it at an interval and queues the files that changed.

A scan records the state of each file with its content hash, so that an unchanged file is not read again and a moved file keeps its identity. A reader turns a file into text with numbered lines. Extraction then splits the text into chunks of an estimated 4,096 tokens, and the extractor stage proposes claims and arguments for each chunk. The auditor stage compares each new claim with the candidates that the graph already holds, so that a claim restated in other words is merged and not duplicated. Only 3 permits for background model work exist at once, and the merge of results is one at a time. Each claim keeps a locator, which names the source file, the line range and a short quote, so that the person can open the passage that supports it.

### Where learning data is kept

The learning folder is `learn/` in the data folder, and the keys file is `auth.json` in the data folder. The files follow the LearnHarness folder format version 1, so that the LearnHarness application can read the folder. Ranviera adds its own files in `learn/cortex/` for the registry of roots, the state of each file, the locators, the graded outcomes and the writer lock `writer.lock`. A deletion first moves the removed lines to `learn/archive/<date>/`.

A reader of the knowledge store skips a line that is not valid and does not repair it, so that a torn write cannot take the graph down. A folder stamped with a newer format than the build is refused. Only one process writes the folder at a time. A second Ranviera process, or the LearnHarness application, that finds a live lock starts in a read only state and answers each request that would write with the status 409.

### Learning sessions

A session runs 3 agents over one history, which the person sees as a single conversation. The prober measures what the person knows, the teacher plans a route and teaches, and the practice agent sets and checks practice. The agents call tools to ask questions and grade answers, to read the graph, to read files under a linked root, to start research or the reading of a PDF file, and to record the plan. The runtime streams each turn to the Learn window, saves the session after each message, and compacts the history when it nears the context window of the model. A graded answer is stored with the confidence that the person gave, and the held band of a claim is derived from these records when it is read.

### The model layer

The model layer gives each agent a model through one of 3 slots. The Settings window names them as follows:

- **Main model**, which serves the prober, the teacher and the practice agent
- **Helper model**, which serves the researcher, the extractor and the auditor
- **Image model**, which reads PDF pages and images, and lists only models that accept images.

The person may also pin a model to one background role. A turn or job whose slot has no model, or whose provider has no key, is refused before anything is saved. The layer reaches 3 kinds of provider:

- **Claude Code.** The Claude Code program that the person installed serves the aliases opus, sonnet and haiku. The provider offers the tools of a turn to the program through a local server that listens on the loopback address only. The provider is off until the person switches it on, and its use for background work needs a second switch.
- **Providers with an API key.** Any provider of the pi-ai library that takes a key. The keys are held in the keys file and read again at each use, and an environment variable of the same name takes priority over a saved key.
- **A custom endpoint.** A local or hosted server that speaks the OpenAI chat completions interface, which the layer reads for its list of models.

Costs are derived at read time from the library's price list and shown as a dash where a price is unknown. Claude Code and a custom endpoint are always unpriced.

### The sensitivity gate

Each root carries a sensitivity of public, internal or client-confidential, and each model has a provider class. Claude Code has the class claude-code, a custom endpoint on a loopback address or one that the person confirmed as their own has the class local, and every other provider has the class hosted. Text of a client-confidential root is refused to a hosted model unless the person gave consent for that root, and the person can withdraw consent at any time. The gate applies to extraction, to learning sessions, to jobs and to a change of model, and it filters the claims and files that a hosted model may see. A claim takes the highest sensitivity of its sources.

### The Learn and Sources windows and the Knowledge layer

- **Learn** has a list of sessions at the side and the session pane beside it. The pane shows the conversation, the questions with their forms, the plan of the route as a map and the usage of the session.
- **Sources** shows each linked root as a tree of folders and files with the state of each file. It also shows the sensitivity and consent of the root, the passage behind a claim, the control that starts an extraction and the dialog that unlinks a root.
- **Knowledge layer.** In the Graph window the layer switch opens the graph of claims. It draws each claim as a node and each argument as arrows, with a junction node where several claims together support one conclusion. It also offers a table of arguments, a card for each claim with its sources, a search, and a panel of display settings for sizes, labels, regions and the layout physics. The layout is deterministic, because its seeds come from the node identifiers, and positions are saved.

### The skill

The skill `skills/cortex-knowledge/` lets Claude Code read the learning folder without the application. It contains 4 readers, `sessions.py`, `graph.py`, `sources.py` and `outcomes.py`, which use the Python standard library, open no network connection, do not write to the folder and do not read the keys file. The skill tells the reader that a claim is a recorded statement and not a measure of understanding, and that text found in the record is data and not an instruction.

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
| Strict reads and format stamp | every read of the learning folder | an invalid line, a record or folder written by a newer version |
| Writer lock | the learning runtime | 2 processes writing the learning folder at once |
| Sensitivity gate | each model call over linked sources | client-confidential text reaching a hosted model without consent |
| Locators | each extracted claim | a claim with no passage that supports it |

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

The learning upgrade reimplements the behaviour of LearnHarness in a clean room under the Apache 2.0 licence. Ranviera is not affiliated with LearnHarness.

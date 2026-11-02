# Ranviera learning upgrade

Ranviera can help a person learn a subject from their own material. It links notes, PDF files, Claude memory, Claude Code transcripts and project Markdown files as sources, and it extracts from them short claims and the arguments that join them. It also runs learning sessions in which an agent measures what the person already holds, plans a route to a goal, teaches one step at a time and sets practice. This document gives a developer overview of the behaviour and the parts. The data shapes are fixed in `CONTRACTS.md` (section "Learning and knowledge") and the graph classes and relations in `ONTOLOGY.md` (section "Knowledge family"), and this document refers to them in place of repeating their tables.

## What the upgrade does

The upgrade adds the following:

- a learning session in which an agent measures, plans, teaches and sets practice
- a graph of claims (propositions) and arguments, with a link from each claim to the passage of the file or session that produced it
- linked sources of seven kinds, each with a sensitivity that decides which models may read it
- a model layer with three slots that reaches Claude Code, any provider of the pi-ai library that has an API key, and a local OpenAI compatible endpoint
- a sensitivity gate that keeps client-confidential text away from hosted models
- a Claude Code skill, `skills/cortex-knowledge`, that reads the learning data without a running application
- the windows Learn and Sources, a Knowledge layer in the Graph window, and the sections Models and keys and Learning in Settings.

Missions keep their own path to Claude Code and are not changed. Dictation, interactive demonstrations and figures are not part of this release.

## The learning method

Three agents work over one history, a prober, a teacher and a practice agent. Each has its own system prompt and tool set, and the person sees one conversation. The prompts are stored as numbered fragments in `server/src/learn/method/prompts/`, and a person may override any fragment from the Learning section of Settings. An override takes effect only when its switch is on and its file can be read.

### Measure

The prober reads what earlier sessions left in the graph, so that it does not measure a strand that the person already holds. It then makes the goal concrete with an open question and finds the edge of the person's knowledge on each strand with graded questions asked one at a time. The edge has a floor, which the person reliably gets right, and a ceiling, which the person gets wrong or does not know.

The prober enters near the top of a strand and lets a miss move the next question down. A confident and correct answer leads to a large jump in difficulty, and a hesitant one leads to a small step. A wrong answer gives one coordinate of the edge and is not treated as a verdict, because a slip, a gap and a misconception look alike. When each strand has a floor and a ceiling, the prober files its assessment once with the tool `probe_done`, and the tool refuses while a question is open.

### Plan

The teacher draws a dependency map with the tool `plan_init`. The map is the smallest set of propositions that leads from what the person holds to the goal. The tool takes a diagram block in a restricted Mermaid style, with the edges `-->`, `==>` and `-.->`, which mean that the first node is a prerequisite of the second. The parser in `server/src/learn/method/mermaid.ts` refuses subgraphs, styles and classes and reports all problems with their line numbers in one reply.

The teacher presents the plan before teaching, as a short approach in prose with the map beside it, and then ends its turn so that the person can ask for changes or agree. The current position on the map is derived from the newest graded teaching question and is not stored.

### Teach

The teacher moves one reasoning step at a time and verifies each step before it builds on the next. Each teaching unit has 3 parts:

1. A prediction, which is a graded question posed before the step is taught. It points at a problem with the current state, lets the person try to find the step and reveals nothing.
2. The teaching, which opens by resolving the prediction, that is, by saying what was predicted, what is true and why.
3. A check, which is a graded question posed after the teaching. Each wrong option corresponds to a specific wrong model, so that a miss names the confusion.

A miss means that the step was not understood, and the teacher repairs it before it builds anything on top.

A graded multiple choice answer carries a confidence from the person, with the stops 0, 30, 50, 70, 90 and 100, and a thinking field in which the person reasons aloud. The agent reads the confidence against the result and reads the thinking in full. A wrong answer given with high confidence is the strongest sign of a committed misconception.

### Practise

The practice agent poses problems with the tool `problem` and closes each one with the tool `conclude`. A problem has a self contained statement, a mode, optional target propositions and a model solution that is committed before the person sees the problem. The modes are `recall`, `discrimination` and `composition`. The agent aims for about 85 per cent success on each retrieval, and it moves difficulty up after a clean success and down after a miss.

Hints follow a ladder of 6 rungs, from a redirect of attention (R0) to a worked step (R5), and the agent gives one rung for each request. A concluded problem records an outcome, a verdict, the rung used and a class of miss, and the agent poses no new problem until the person asks for one.

### Voice

The server owns the transcript and saves each input before inference. The teaching voice is dry and plain, and the agents do not flatter. The voice applies only to what the agents say during a session, and the labels, errors and settings text of the windows follow the house register of the other documents.

## The claims graph

### Propositions and arguments

The graph holds short, true, self contained propositions and the arguments between them. An argument is a set of premises that jointly support one conclusion, and independent arguments for the same conclusion stay separate. The graph holds no quiz result, score or confidence, and a misconception enters it only as its true correction. The ledgers are append only, and removed lines are archived under `learn/archive/` before they leave a ledger.

### Provenance and locators

Each proposition records the sources and sessions that assert it. Ranviera also writes a locator for each proposition and source to `learn/cortex/locators.jsonl`, which holds the line range, the nearest heading, the page of a PDF and the extractor's quote. The code looks for the quote word for word in the chunk after it collapses runs of white space. A quote that is found gives the line range. A quote that is missing leaves the proposition in the graph without a line number and marks it as unlocated.

### The extraction pipeline

Notes, PDFs, transcripts and sessions go through one pipeline of 4 stages. Only the framing prompt and the provenance anchor differ between kinds of source.

1. Chunk. The text is split by line to a budget of 4,096 estimated tokens, and a line is not split.
2. Extract. The extractor model, on the cheap slot, reads a chunk and a digest of what the same source has already produced, and it submits propositions and arguments through one validated tool. A rule violation returns to the model for a retry.
3. Audit. The auditor model, also on the cheap slot, does not see the source text or the arguments. It receives the new propositions with the 5 best lexical candidates for each, ranked by BM25, and it returns identity links only. The score ranks candidates and does not decide.
4. Merge. Plain code applies the links and appends the ledger lines, rebuilding the identifiers, timestamps and provenance so that nothing a model could mis-copy is trusted. It drops redundant arguments and writes the checkpoint last.

Audit and merge run one at a time, and the auditor then sees the graph after each earlier merge. A file is `completed`, `partial`, `aborted` or `failed` according to the status of its chunks, and an ambiguous response is not retried automatically because it may already have merged.

### The Knowledge layer

The Graph window has a Knowledge layer that draws propositions, argument junctions and clusters named after their birth source. A node card lists the sources and sessions of a proposition and opens the passage at its line. The harvester `kg/cortex_kg/harvest/knowledge.py` reads the learning folder deterministically and adds claims to the harness graph with no model in the build. Edges from the learning ledgers carry the provenance `extracted`, which draws at half weight and feeds no reasoning rule until a person ratifies the claim with the Ratify control.

Three metrics are derived at build time and are not graph truth. The metric `support` is the number of distinct sources and sessions that assert a proposition. The metric `held` is a band of `unknown`, `shaky` or `held` with the date of the last test. The metric `calibration` compares the stated confidence with the results and appears only when there are enough answers. The thresholds are in `CONTRACTS.md`.

## Linked sources

A linked root is a folder, or one file for a PDF, with a kind, include and exclude globs, a sensitivity and a mode of `manual` or `scan`. A person links a root in the Sources window. The kinds are as follows.

| Kind | What it reads | Default sensitivity |
|---|---|---|
| `notes` | Markdown and text from a notes folder or an Obsidian vault | `internal` |
| `pdf` | PDF files, converted to page-marked Markdown by rules with no model call | `internal` |
| `claude-memory` | the Claude memory folders that Ranviera already finds | `client-confidential` |
| `claude-transcripts` | the prose of one project folder of Claude Code transcripts, without tool calls, tool results or thinking | `client-confidential` |
| `claude-instructions` | `CLAUDE.md`, the rule files and the skills | `internal` |
| `projects-md` | the Markdown files of a projects folder | `client-confidential` |
| `learnharness` | an existing LearnHarness data folder, imported read only with no model call | `internal` |

The defaults are in `server/src/learn/sources/kinds.ts`. Creating a transcripts root is the opt-in for that folder, and transcripts are extracted by message fingerprint so that a scan reads only new messages.

A scan reads a root, applies the globs and records the content hash of each file in `learn/cortex/files.jsonl`. A file whose hash has not changed is skipped, and a moved file with the same hash keeps its identity. Sources are not modified. In `scan` mode the server scans every 300 seconds and queues at most 50 changed files for each pass. A request to extract a larger root receives status 409 with the code `confirm_required` and an estimate of tokens, and a second request with `confirm: true` runs. A PDF may have at most 1,000 pages.

## Model slots and providers

The model layer serves extraction, auditing, sessions and research through the Pi libraries `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`. There are 3 slots:

- `strong`, for the prober, the teacher and the practice agent
- `cheap`, for the extractor, the auditor and the background jobs
- `vision`, for PDF pages and images.

A session takes its model and thinking level from the strong slot when it starts. A turn whose slot has no model, or whose provider has no key, is refused with a machine readable error before anything durable changes. The providers are the key-based providers that `pi-ai` registers, a custom endpoint for OpenAI compatible servers that may be hosted or local, and Claude Code through a provider of Ranviera's own.

Keys are stored in `auth.json` in the data folder with file mode 0600, and an environment variable takes precedence over a stored key. Keys do not enter the graph, the public export or a log. An endpoint counts as local when its host is a loopback address or when the person states that it runs on their own machine or network.

The Claude Code provider is off until the person switches it on in Settings, and it stores no Claude credential. Each model request starts one `claude` process with the built-in tools, hooks and session saving disabled. The process reaches Ranviera's tools through a bridge on 127.0.0.1 that requires a random bearer token, and a tool call runs only when its identifier, name and arguments match the intent that the process streamed. The code is in `server/src/learn/models/claude-code/`.

## The sensitivity gate

Each linked root carries `public`, `internal` or `client-confidential`, and a model counts as `claude-code`, `local` or `hosted`. A `client-confidential` root may go only to Claude Code or to a local endpoint, unless the person records consent for a hosted provider on that root, which stores the time of the consent. A proposition takes the highest sensitivity of its sources, and a session takes the highest sensitivity of what its context and file tools reached.

The gate applies at 4 points, which are extraction, a learning session, a background job and a change of a session's model. A refusal returns status 403 with the code `sensitivity_refused`. The gate also filters what a hosted model may see, including the auditor's candidates, the proposition tools and the file tools. A hosted auditor therefore cannot link a new public proposition to a confidential one, and the graph may hold a duplicate across the two classes. The maintainers accepted that cost in light of the alternative of showing confidential text to a hosted model. The code is in `server/src/learn/models/gate.ts`.

The agents have the read only file tools `read`, `ls`, `find` and `grep`. When the session model is Claude Code or a local endpoint, the tools reach the home folder. When the model is hosted, they reach only the linked roots that the gate allows. A deny list applies in both cases, and it covers secret folders and files such as `.ssh`, `.aws`, `.gnupg` and `.npmrc`. Text that a file tool returns is wrapped in the delimiter `UNTRUSTED FILE CONTENT`, and the agents follow no instruction inside it.

## Background jobs

Two kinds of job run outside the conversation. The `research` job searches the web with a Tavily or Brave key and is off until the person switches it on in the Learning section of Settings, because it sends text to a search provider. The `pdf` job reads a PDF on the vision slot and returns a brief with page citations. A job inherits the sensitivity of its session.

## The data folder and LearnHarness format 1

The learning data is in `learn/` under the data folder, which is `~/.claude/ranviera` by default. The files of the LearnHarness data format version 1 are in `chats/` and `graph/`. The Ranviera extensions are in `learn/cortex/`, which a LearnHarness reader does not meet, and they include `sources.json`, `files.jsonl`, `locators.jsonl` and the writer lock `writer.lock`. Keys are in `auth.json` one level above `learn/`.

Because the folder follows format version 1, the LearnHarness application can read it when its data folder is pointed at it, and Ranviera can import a LearnHarness folder through the `learnharness` source kind. Only one application writes a folder at a time. A Ranviera process that finds another live process holding `cortex/writer.lock` runs read only, and every learning request other than a read answers 409 with the code `busy`. The lock guards against accidental double use and gives no protection against a hostile process.

## The Claude Code skill

The skill `skills/cortex-knowledge` lets Claude Code answer from the learning history and the graph without a running application. It holds readers written in Python with the standard library only, a `SKILL.md` and a reference of the data format. The readers are `sessions.py`, `graph.py`, `sources.py` and `outcomes.py`, and the skill is licensed under Apache 2.0.

The readers do not write inside the learning folder, treat stored content as data and not as instructions, and list each omission at the end of their output. They refuse a newer format with a message to update the skill. They look for the learning folder from the option `--learn-dir`, then from the environment variable `CORTEX_LEARN_DIR`, then from the first of `~/.claude/cortex/learn` and `~/.claude/ranviera/learn` that exists, and they create none of these folders.

## Limits

The following limits apply to this release:

- Scanned PDF pages are not read, because there is no optical character recognition.
- A proposition that a model extracted is marked `extracted` and feeds no reasoning rule until a person ratifies it, and extraction quality depends on the extractor model.
- The `held` band rests on a few graded answers and reads recall at one time, which is a weaker claim than mastery.
- Two existing propositions that prove equivalent are not merged later.
- Coordination of jobs and of the writer lock is single process.
- The Claude Code provider depends on the flags and stream format of the installed Claude Code version, which carry no promise of stability.

## Clean room and licence

Ranviera reimplements the behaviour of LearnHarness and is licensed under Apache 2.0, while LearnHarness is licensed under the GNU Affero General Public License 3.0. The reimplementation was written from written behaviour notes, and its authors did not open the LearnHarness source. No LearnHarness code, prompt text, documentation text or test text was copied. The script `scripts/learn/clean-room-overlap.py` checks the repository for overlap with LearnHarness text. Ranviera is not affiliated with LearnHarness or Anthropic, and `ACKNOWLEDGEMENTS.md` credits LearnHarness as the inspiration without implying a licence, permission or endorsement.

## Where to read more

- `CONTRACTS.md`, section "Learning and knowledge", for data shapes, files, routes, limits and the sensitivity table
- `ONTOLOGY.md`, section "Knowledge family", for classes, relations and provenance values
- `ARCHITECTURE.md` for the parts of Ranviera as a whole.

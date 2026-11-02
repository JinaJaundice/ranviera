# Ranviera operations

This guide covers the installation, running, checking and removal of Ranviera, and the maintenance of the public repository and its releases. `ARCHITECTURE.md` sets out the design and `CONTRACTS.md` fixes the data shapes.

## Installing the application

The installers are published on the Releases page of the repository. The installer for Windows is an NSIS installer for one user, which needs no administrator rights. The installers for macOS are a DMG for Apple silicon and a DMG for Intel, and the installer for Linux is an AppImage. Each installer carries everything that the product needs, so that no Python, Node or Git is required.

The first releases are not code-signed. Windows SmartScreen and macOS Gatekeeper may therefore ask for confirmation on the first run. Before running an installer, a person should verify it as the README describes, with the checksum in `SHA256SUMS.txt` and with `gh attestation verify <file> --repo JinaJaundice/ranviera`.

The application does not check for updates. A new version is a new download from the Releases page.

### Opening the app on a Mac

The macOS builds are not signed or notarised by Apple, so macOS blocks the first start of a copy that was downloaded. The steps below follow the route that Apple documents for an app from a developer it has not identified. The maintainers have not yet tried them on every version of macOS, and the guide `docs/guides/install.md` describes what to do when a step looks different.

1. Download the DMG for the processor, `Ranviera-<version>-arm64.dmg` for Apple silicon or `Ranviera-<version>-x64.dmg` for Intel. The menu Apple, About This Mac names the chip.
2. Check the file against `SHA256SUMS.txt` with `shasum -a 256 <file>` and against the attestation, as the README describes.
3. Open the DMG and drag Ranviera to the Applications folder.
4. Open Ranviera from the Applications folder. macOS then says that it cannot verify the app. Choose Done, open System Settings, then Privacy and Security, scroll to the Security section, choose Open Anyway next to the message about Ranviera, and confirm with the login password.
5. Where Open Anyway does not appear, run `xattr -dr com.apple.quarantine /Applications/Ranviera.app` in Terminal and open the app again.
6. The first sign-in with Claude Code opens Terminal, and macOS may ask whether Ranviera may control Terminal. Choose OK.

## The first run

The first run is a set-up window of 5 steps, and nothing is read, written or installed before the person agrees to the step that does it:

1. **Welcome.** The window shows what the product does, the non-affiliation statement, the privacy notice and the licence, and the person agrees to continue.
2. **Read your set-up.** The window lists the folders that the product will read (`~/.claude`, with its `CLAUDE.md`, rules, skills, agents, settings and memory folders) and offers an optional projects folder. It states that nothing leaves the computer. The person agrees, and the product builds the graph and shows the counts.
3. **See Claude Code at work (optional).** The window explains that hooks let the product see each step as Claude Code works, shows the exact entries that it will add to `~/.claude/settings.json`, and installs them only when the person agrees. It backs up the file first.
4. **Connect Claude Code (optional).** The window checks for Claude Code and its sign-in, as the section below describes.
5. **Done.** The window shows where the data folder is, how to remove the hooks and how to uninstall.

The person can repeat any step from the Settings window. A person who skips steps 3 and 4 still has the full graph, the brain view, the checks and the queries. The first build on an empty `~/.claude` gives a graph of the starting content with a clear empty state.

## Claude Code

Ranviera does not include, download or modify Claude Code. It finds the copy that the person installed and links to Anthropic's installation page where there is none. The server reports the state of Claude Code at `GET /api/claude` as `{ installed, version, signed_in, auth_method, plan }`, from `claude --version` and `claude auth status`. It does not return the e-mail address of the account and does not keep the output.

Where Claude Code is installed and the person is not signed in, the button Sign in with Claude Code opens a new terminal window that runs `claude auth login`, so that the whole sign-in, including any code that the person pastes, takes place inside Claude Code. The server then checks `claude auth status` every 3 seconds for up to 5 minutes. On Windows the terminal is Windows Terminal or, where it is missing, a console window. On macOS it is Terminal, and on Linux it is the first of `x-terminal-emulator`, `gnome-terminal`, `konsole` and `xterm` that exists.

Agent runs, which are called missions, stay off until Claude Code is signed in and the person has agreed, once, to a statement that each run uses Claude Code under their own plan and its limits. Anthropic may change how `claude -p` and third-party applications draw on a subscription, and Ranviera says so before the first run. Each run still shows its plan and needs a click to start.

## Learning

The learning upgrade adds the Learn and Sources windows, a Knowledge layer in the Graph window and 2 sections of Settings, which are Models and keys and Learning. `ARCHITECTURE.md` sets out the design and `LEARNING.md` the method. This section covers what a user or maintainer needs to run it.

### Where the learning data is kept

| Item | Default location | Configuration key and variable |
|---|---|---|
| Learning folder | `~/.claude/ranviera/learn/` | `learn_dir`, `CORTEX_LEARN_DIR` |
| Keys file | `~/.claude/ranviera/auth.json` | `auth_file`, `CORTEX_AUTH_FILE` |
| Claude Code program | the first `claude` on the search path | `claude_cmd`, `CORTEX_CLAUDE_CMD` |
| Learning switch | on | `learn_enabled`, `CORTEX_LEARN_ENABLED` |

An environment variable overrides the key in `cortex.config.json`, and the key overrides the default. Setting `learn_enabled` to false hides the Learn and Sources windows and registers no learning route. The keys file is written with permission 0600, and each change copies the earlier file to `auth.json.bak` beside it. A key does not appear in a response or a log, and the Settings window shows only its last four characters.

The learning folder holds the sessions in `chats/`, the background jobs in `jobs/`, the graph in `graph/` and Ranviera's own files in `cortex/`. The lock file `cortex/writer.lock` shows that a process is writing. A second Ranviera process, or the LearnHarness application, that starts while the lock is live opens the folder read only, and each change it attempts answers with the status 409 until the first process stops.

### Switching on Claude Code and background use

Claude Code is off as a model until the person switches it on. Open Settings, then Models and keys, then Claude Code. The switch Use Claude Code as a model allows lessons to use the installed program, which must be version 2.1.316 or later. The window reports where the program is not found or needs an update. A second switch, Allow background use, such as reading sources and research, lets extraction and research use Claude Code as well. While it is off, a request that would use Claude Code for background work answers with the refusal `consent_required`. Each switch records the time at which it was turned on, and both are off by default even where Claude Code is installed. The Missions window keeps its own path to Claude Code and is not changed by these switches.

### Adding a provider key

Open Settings, then Models and keys, then Provider keys. Each row is named by its environment variable, for example `OPENROUTER_API_KEY`, and a key may be pasted into the row or set in the environment before Ranviera starts. A real environment variable always wins over a saved key, and the row then says that the environment shadows it. The check is by shape only and makes no network call. A provider key needs at least 12 characters, a `TAVILY_API_KEY` starts with `tvly-` and has at least 20 characters, and a `BRAVE_API_KEY` has at least 20 characters. Tavily and Brave keys serve the web search of the research job. A key saved in the window applies at once without a restart.

Under Models, choose a model for each of the 3 slots. The Main model measures what the person knows, plans the route and teaches. The Helper model reads sources for the graph, checks links and runs research. The Image model reads PDF pages and images, and lists only models that accept images. Only providers that have a key, and Claude Code where it is switched on, offer models. A level of thinking and a prompt cache choice can be set for each slot.

### Adding a local or custom endpoint

Open Settings, then Models and keys, then Custom endpoint. Enter the base URL of a server that speaks the OpenAI chat completions interface, for example `http://localhost:11434/v1`, and choose whether it needs a key. Ranviera asks the server for its list of models, and a model name may also be typed by hand where the server does not list it. An address on `localhost`, `127.0.0.1` or `[::1]` counts as local. Any other address counts as hosted unless the person turns on the switch that states that the endpoint runs on their own machine or network. A key is sent over plain `http` only to a local endpoint, and a connection that would do otherwise is refused.

### Linking sources and running extraction

Open Sources and choose to link a root. Choose its kind, which is notes, PDF files, Claude memory, Claude Code transcripts, Claude instructions, project Markdown or a LearnHarness folder, then its folder, its sensitivity and its mode. The default sensitivity is internal for notes, PDF files, Claude instructions and LearnHarness folders, and client-confidential for Claude memory, Claude Code transcripts and project Markdown. Include and exclude patterns may be changed for each root. A root may hold up to 20,000 selected files, and a scan of a larger root stops before it writes anything.

In manual mode a root is read when the person starts an extraction. In scan mode the server checks the root every 300 seconds and queues at most 50 changed files in each pass, and both figures can be changed under Settings, then Learning. A file that failed, was partial or was stopped waits for a manual run, so that a failing file does not spend money at every pass. Extraction uses the Helper model, and the Sensitivity gate in `ARCHITECTURE.md` decides which models may read each root. A hosted model may read a client-confidential root only after the person turns on Allow hosted providers to read that root, and the same control withdraws the consent.

Where a request to extract a whole root would read more files than one scan pass queues, the server answers 409 with the code `confirm_required`. The answer gives the number of files and the estimated tokens, which are the bytes divided by 4. The Sources window shows these figures and asks the person to confirm before it starts, and a repeat of the request with `confirm: true` starts the run. The window then reports how many files started and how many wait. Extraction runs on up to 3 files at once, and an extraction of a file or a session is recorded with its model and token use. A scanned PDF page with no text is counted and not read, because there is no optical character recognition.

### Installing the cortex-knowledge skill

The skill is the folder `skills/cortex-knowledge/` in the repository. To install it by hand, copy that whole folder to `~/.claude/skills/cortex-knowledge/`, where Claude Code finds its skills, and keep the file names unchanged. The readers need Python 3.10 or later and no other package. Claude Code can then run them, or a person can run them from a terminal, for example `python ~/.claude/skills/cortex-knowledge/scripts/graph.py find "<topic>"`. A reader looks for the learning folder with the option `--learn-dir`, then the variable `CORTEX_LEARN_DIR`, then the default folder, and it names the folder it used at the start of its output. A reader does not change the folder and does not read the keys file.

### Backing up and removing learning data

To back up the learning data, stop Ranviera so that the writer lock is released and copy the learning folder. Copy the keys file separately and store it more carefully, because it holds secrets. The folder format is plain JSON and JSON Lines, so that the copy can be read with the skill and the option `--learn-dir`.

To remove a linked root, use Unlink in the Sources window. The dialog asks for a mode and neither is chosen at first. Keep the knowledge unlinks the root and leaves each claim and argument in the graph. Delete the knowledge unlinks the root and deletes the claims that only these files support. Both modes move the removed lines to `learn/archive/<date>/` first and leave the files under the root untouched. A session can be deleted in the same two modes.

To remove all learning data, stop Ranviera and delete the learning folder. To remove saved keys, delete a key in the Settings window or delete the keys file. Deleting the data folder removes both, together with the graph build output, as the section on uninstalling describes.

### Running the learning upgrade from source on a Mac

Running from source on a Mac uses the steps of `README.md`. Nothing in the learning upgrade needs another step, because the learning folder and the keys file are kept in the data folder with the rest of the data. The steps for the packaged app on a Mac are in the section on opening the app, and they have not yet been tried on a Mac.

## Hooks

The installer of hooks merges and never replaces. It adds one entry for each Ranviera hook event, marks each entry with the command of the bundled hook runner so that it can find its own entries later, leaves every other key and entry in `settings.json` as it was, never adds an entry twice, and writes a dated backup before each change. Removal deletes only the marked entries and leaves a backup. Settings offers removal at any time, and the uninstaller of the application offers it too.

The hook runner is the bundled compiler executable with the subcommand `hook <Event>`, which reads the payload that Claude Code sends on standard input, takes the event name from the payload or from the argument, and appends one line to `<data_dir>/events/YYYY-MM.jsonl`. The logic is in `kg/cortex_kg/hook.py`, and `hooks/cortex_hook.py` is a thin wrapper around it. Because the path of an installed application can change on update, and an AppImage runs from a temporary folder, the command `bin` (`ranviera-kg bin`) copies the runner folder to `<data_dir>/bin/<version>/` once for each version and keeps the earlier version folders. The install runs it before it writes the entries, so that each entry names the current copy, for example `"<data_dir>/bin/<version>/ranviera-kg" hook <Event>`. Outside the packaged application there is no runner folder, and the entries run `hooks/cortex_hook.py` from the repository.

The commands `python cortex.py hooks preview`, `hooks install` and `hooks uninstall` show, add and remove the entries from the command line, and each takes `--json`, which prints the shapes of `CONTRACTS.md` for the server. The preview prints `{ installed, settings_path, entries, backup_dir }` and writes nothing. The install copies `settings.json` to `<claude_home>/backups/<date>-ranviera-hooks/settings.<time>.json` before any change, and a second install adds nothing and writes no backup. A file that is not valid JSON, or that holds any value other than an object, is left untouched and the command reports the reason. Removal finds the Ranviera commands by their command line, keeps any other command in the same entry, and, where the newest backup holds the same content, writes back the bytes of that backup, so that an install followed by a removal restores the original file exactly.

The registration covers 7 events, which are `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `InstructionsLoaded`, `PreToolUse`, `SubagentStart` and `SubagentStop`. Each entry is asynchronous with a timeout of 10 seconds, which prevents any delay to a session. The hook prints nothing and exits with code 0 on any fault, such as a missing `index.json` or a payload that is not JSON. With `CORTEX_DEBUG=1` it writes the fault to `hook-errors.log` in the data folder. It stores no prompt text unless `log_prompt_snippets` is true, and it appends each event in under 50 milliseconds.

## The local server and its access token

The server listens on 127.0.0.1 only. In the packaged application the shell chooses a free port, creates a random token at each launch and passes it to the server as `CORTEX_TOKEN`. The window opens `/auth?t=<token>`, which sets an HttpOnly, SameSite Strict cookie, and every request to `/api/` without that cookie, or without the header `x-cortex-token`, receives 401. In development no token is set. The routes are in `CONTRACTS.md`.

## The brain view

The Graph window opens on the brain. Its regions are named after the categories of information they hold, such as Rules and decisions, Memory and history, Checks and gates and Agents, and `BRAIN.md` lists all 10. A control group at the bottom right of the canvas offers zoom, reset, 4 preset views, auto-rotate, a Surface slider for the opacity of the silhouette, an Expand slider that moves the regions apart so that the deep regions can be reached, and a labels switch. Clicking a region caption, a cluster label or a legend entry focuses that region, and Escape ends the focus. The keyboard turns the brain with the arrow keys, zooms with plus and minus, resets with 0 and chooses the preset views with 1 to 4.

## Running from source

A developer needs Python 3.12 or later, Node 22 or later and a copy of the repository. In development the server and the web app share port 5182.

```
pip install -r requirements.txt
npm install
cp cortex.config.example.json cortex.config.json
python cortex.py build
python cortex.py check
npm run dev
```

On Windows, `copy` replaces `cp`. The application then opens at `http://localhost:5182`. For production use, `npm run build` and then `npm start` serve at the same address. While a server is running, `npm run smoke` opens each window in a browser and saves screenshots in `shots/`. The command `npm run desktop` runs the Electron shell from the repository.

## Building and checking the graph

`python cortex.py build` performs the harvest of the set-up and the compilation of the graph, and it writes `graph.json`, `graph.ttl`, `graph.trig`, `index.json`, the inferred files and a daily change record into the data folder. `python cortex.py check` performs validation and writes `health.json`. The command `npm run graph` runs both commands in turn, and the Health window and `POST /api/compile` run the same steps from the web app.

A build is worth running after any change to a rule, an agent, a skill, a hook, a memory index or a vocabulary entry. Where the option `--ci --strict` is given, `check` exits with a failure on any warning as well as any violation, and CI uses that form. The command `python cortex.py reason` runs the reasoning step alone.

## Replaying past chats

`python cortex.py replay` converts the chats in `~/.claude/projects` into events with the source `replay`, which gives the graph a real history of use from the start. The command may be repeated at any time. Where the server has already recorded an event with the same session and key, it ignores the repeat.

## Uninstalling and removing data

To remove the hooks, open Settings and choose Remove the hooks, or run `hooks uninstall`, or restore the dated backup of `settings.json`. To uninstall the application, use Apps in the Windows settings, drag the application out of Applications on macOS, or delete the AppImage file on Linux. To remove all data, delete the data folder, which is `~/.claude/ranviera` by default and which holds the learning folder and the keys file. Uninstalling does not change the person's Claude Code files, and the uninstaller does not remove the hook entries, so the person removes them in Settings first.

## What is never committed

| Item | Reason |
|---|---|
| The data folder (`data_dir`, by default `~/.claude/ranviera/`) | it holds events, missions and build output that belong to one computer |
| The profile of the person (`<data_dir>/profile/`) | it holds the person's own vocabulary, assertions and rule ledger |
| The learning folder (`<data_dir>/learn/`) | it holds the person's sessions, answers, claims and linked sources |
| The keys file (`<data_dir>/auth.json`) and its copy `auth.json.bak` | they hold secrets |
| `cortex.config.json` | it holds the paths of one computer |
| `shots/`, `node_modules/`, `build/` and `release/` | they are generated |

The repository holds the code and the starting content only. A person's content is read from their data folder and never from the repository.

## Public content check

The script `scripts/public/check.mjs` fails, and names each file and line, when the tree holds a secret, an absolute path into a user folder, an e-mail address other than the GitHub no-reply address, or a file over 5 MB other than the brain model. The check also takes a private list of terms from a file outside the repository, which the maintainer keeps and seeds with `node scripts/public/check.mjs --seed`. The script `scripts/public/export.mjs` builds the public tree from an allow list of paths. It stops, and names each file and line, when a private term is found, and it never rewrites or drops a file to hide a name. It runs as a CI job on every push and again when a release is built. The command is `node scripts/public/check.mjs .`, and the tests are in `scripts/public/check.test.mjs`.

## Third-party notices

The script `scripts/public/notices.mjs` generates `THIRD_PARTY_NOTICES.md` from the licences of the npm packages (with `license-checker-rseidelsohn`) and of the Python packages of the compiler (with `pip-licenses`). It fails on a licence outside the allow list, which comprises MIT, ISC, BSD, Apache-2.0, 0BSD, Python-2.0 and PSF, MPL-2.0 for files only, CC-BY-4.0 for data, OFL-1.1 for fonts, and the PyInstaller exception for the bootloader. The command `node scripts/public/notices.mjs --check` reports the result without writing a file.

## Building the installers

`npm run build:app` assembles `build/app` from the web app, the server bundle and the compiler executable, and `npm run dist:win`, `npm run dist:mac` and `npm run dist:linux` package it with electron-builder as `electron-builder.yml` defines. The files are `Ranviera-Setup-<version>.exe` for Windows, `Ranviera-<version>-<arch>.dmg` and `Ranviera-<version>-<arch>-mac.zip` for macOS and `Ranviera-<version>-<arch>.AppImage` for Linux, where `<arch>` is the architecture name that electron-builder writes. Each build runs on the operating system that it targets, because PyInstaller does not build for another system.

## CI and releases

CI in `.github/workflows/ci.yml` runs on every push and pull request. The python job runs the tests and builds a graph on an empty Claude folder. The web job runs the type check, lint, tests and build. The public job runs the content check, the tests of the scripts and the licence check.

The workflow `.github/workflows/release.yml` runs when a tag of the form `v*` is pushed. It runs the tests and the public content check, then runs `npm run build:app` and the `dist` script of each operating system on Windows, macOS (Apple silicon and Intel) and Linux, collects the installers, writes `SHA256SUMS.txt`, creates build attestations with `actions/attest-build-provenance`, and creates a draft release that the maintainer publishes by hand. A manual run from the Actions tab runs the same checks and builds. It keeps the installers as workflow artifacts with no attestation and no release, which lets a build be tried on each system before a tag is pushed.

The blocking checks of the graph in CI are S01, S02, S03, S04, S06, S09, S12, S23, P03, P05, P06, P07, B01 and B03, as `ONTOLOGY.md` lists. Checks S03 and P02 run only where the configuration sets `agent_model` and `size_limits`.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

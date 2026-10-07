# Ranviera operations

This guide covers the installation, running, checking and removal of Ranviera, and the maintenance of the public repository and its releases. `ARCHITECTURE.md` sets out the design and `CONTRACTS.md` fixes the data shapes.

## Installing the application

The installers are published on the Releases page of the repository. The installer for Windows is an NSIS installer for one user, which needs no administrator rights. The installer for macOS is a DMG for Apple silicon and one for Intel, and the installer for Linux is an AppImage. Each installer carries everything that the product needs, so that no Python, Node or Git is required.

The first releases are not code-signed. Windows SmartScreen and macOS Gatekeeper may therefore ask for confirmation on the first run. Before running an installer, a person should verify it as the README describes, with the checksum in `SHA256SUMS.txt` and with `gh attestation verify <file> --repo JinaJaundice/ranviera`.

The application does not check for updates unless the person turns the check on in Settings, and the check then reads only the public list of releases on GitHub.

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

To remove the hooks, open Settings and choose Remove hooks, or run `hooks uninstall`, or restore the dated backup of `settings.json`. To uninstall the application, use Apps in the Windows settings, drag the application out of Applications on macOS, or delete the AppImage file on Linux. To remove all data, delete the data folder, which is `~/.claude/ranviera` by default. Uninstalling does not change the person's Claude Code files, apart from the hook entries.

## What is never committed

| Item | Reason |
|---|---|
| The data folder (`data_dir`, by default `~/.claude/ranviera/`) | it holds events, missions and build output that belong to one computer |
| The profile of the person (`<data_dir>/profile/`) | it holds the person's own vocabulary, assertions and rule ledger |
| `cortex.config.json` | it holds the paths of one computer |
| `shots/`, `node_modules/`, `build/` and `release/` | they are generated |

The repository holds the code and the starting content only. A person's content is read from their data folder and never from the repository.

## Public content check

The script `scripts/public/check.mjs` fails, and names each file and line, when the tree holds a secret, an absolute path into a user folder, an e-mail address other than the GitHub no-reply address, or a file over 5 MB other than the brain model. The check also takes a private list of terms from a file outside the repository, which the maintainer keeps and seeds with `node scripts/public/check.mjs --seed`. The script `scripts/public/export.mjs` builds the public tree from an allow list of paths. It stops, and names each file and line, when a private term is found, and it never rewrites or drops a file to hide a name. It runs as a CI job on every push and again when a release is built. The command is `node scripts/public/check.mjs .`, and the tests are in `scripts/public/check.test.mjs`.

## Third-party notices

The script `scripts/public/notices.mjs` generates `THIRD_PARTY_NOTICES.md` from the licences of the npm packages (with `license-checker-rseidelsohn`) and of the Python packages of the compiler (with `pip-licenses`). It fails on a licence outside the allow list, which comprises MIT, ISC, BSD, Apache-2.0, 0BSD, Python-2.0 and PSF, MPL-2.0 for files only, CC-BY-4.0 for data, OFL-1.1 for fonts, and the PyInstaller exception for the bootloader. The command `node scripts/public/notices.mjs --check` reports the result without writing a file.

## Building the installers

`npm run build:app` assembles `build/app` from the web app, the server bundle and the compiler executable, and `npm run dist:win`, `npm run dist:mac` and `npm run dist:linux` package it with electron-builder as `electron-builder.yml` defines. The files are `Ranviera-Setup-<version>.exe` for Windows, `Ranviera-<version>-<arch>.dmg` for macOS and `Ranviera-<version>-<arch>.AppImage` for Linux, where `<arch>` is the architecture name that electron-builder writes. Each build runs on the operating system that it targets, because PyInstaller does not build for another system.

## CI and releases

CI in `.github/workflows/ci.yml` runs on every push and pull request. The python job runs the tests and builds a graph on an empty Claude folder. The web job runs the type check, lint, tests and build. The public job runs the content check, the tests of the scripts and the licence check.

The workflow `.github/workflows/release.yml` runs when a tag of the form `v*` is pushed. It runs the tests and the public content check, then runs `npm run build:app` and the `dist` script of each operating system on Windows, macOS (Apple silicon and Intel) and Linux, collects the installers, writes `SHA256SUMS.txt`, creates build attestations with `actions/attest-build-provenance`, and creates a draft release that the maintainer publishes by hand.

The blocking checks of the graph in CI are S01, S02, S03, S04, S06, S09, S12, S23, P03, P05, P06, P07, B01 and B03, as `ONTOLOGY.md` lists. Checks S03 and P02 run only where the configuration sets `agent_model` and `size_limits`.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

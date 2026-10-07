# Ranviera

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

## What Ranviera does

Ranviera reads the Claude Code set-up on your computer and holds it as a knowledge graph. The set-up comprises the `CLAUDE.md` file, rules, skills, agents, hooks, memory files, settings and output styles in `~/.claude`, and optionally a folder of your projects. Ranviera gives each thing a typed node with its source file and line, checks the whole set-up against an ontology, and reports broken references, conflicting rules, duplicates and inconsistent names.

The Graph window draws the nodes as neurons in a brain. Each node is placed in the region whose function matches what the node is, so that rules are placed in the prefrontal cortex, memory files in the temporal lobe and agents in the cerebellum. Where you install the optional hooks, the view shows each step that Claude Code takes as a numbered thought trail. A pulse travels from the node that caused a firing to the node it fired. The Network layout shows the same graph as a force-directed diagram.

Ranviera also provides a lexicon of preferred terms, a view of rules by task type, a query window for the graph and a health view that lists the validation results. A mission window runs Claude Code agents with context chosen from the graph. Everything works on your own computer. Ranviera sends nothing to its authors and collects no usage data (see `PRIVACY.md`).

## Installation

Download the installer for your system from the Releases page of https://github.com/JinaJaundice/ranviera:

| System | File |
|---|---|
| Windows | `Ranviera-Setup-<version>.exe`, an installer for one user that needs no administrator rights |
| macOS, Apple silicon | `Ranviera-<version>-arm64.dmg` |
| macOS, Intel | `Ranviera-<version>-x64.dmg` |
| Linux | `Ranviera-<version>-<arch>.AppImage` |

You need no Python, Node or Git. The first releases are not code-signed, so Windows SmartScreen and macOS Gatekeeper may ask for confirmation when you first open the application. Please verify the download as described below before you confirm. Each file name is set by `electron-builder.yml`, and `<arch>` stands for the processor architecture that electron-builder writes into the name.

### First run

The first run is a window of 5 steps, and Ranviera reads, writes or installs nothing before you agree to the step that does it:

1. Welcome, with the non-affiliation statement, the privacy notice and the licence.
2. Read your set-up, which lists the folders that Ranviera will read and builds the graph.
3. See Claude Code at work (optional), which shows the exact entries that Ranviera would add to `~/.claude/settings.json` and installs them only where you agree.
4. Connect Claude Code (optional), which checks that Claude Code is installed and signed in.
5. Done, which shows where the data folder is and how to remove the hooks.

You can repeat any step from the Settings window. A person who skips steps 3 and 4 still has the graph, the brain view, the checks and the queries.

## Verifying a download

Each release carries the file `SHA256SUMS.txt` and a GitHub build attestation for each installer.

To check the checksum, put the installer and `SHA256SUMS.txt` in one folder and run one of these commands:

```
sha256sum --check --ignore-missing SHA256SUMS.txt
```

```
Get-FileHash .\Ranviera-Setup-<version>.exe -Algorithm SHA256
```

On Windows, compare the value that `Get-FileHash` prints with the line for that file in `SHA256SUMS.txt`.

To check the attestation, which shows that GitHub built the file from this repository, install the GitHub command line tool and run:

```
gh attestation verify <installer file> --repo JinaJaundice/ranviera
```

Do not run an installer if either check fails.

## Removing the hooks and uninstalling

The hooks are optional. Ranviera marks each entry that it adds to `~/.claude/settings.json` with the command of its own hook runner, leaves every other entry as it was and writes a dated backup before each change.

- To remove the hooks, open Settings and choose Remove hooks. Ranviera deletes only its own entries and leaves a backup.
- To remove them by hand, open `~/.claude/settings.json` and delete the entries whose command runs the `hook` subcommand of `ranviera-kg`, or restore the dated backup.
- To uninstall the application, use Apps in the Windows settings, drag the application out of Applications on macOS, or delete the AppImage file on Linux. The Windows uninstaller offers to remove the hooks.
- To remove all data, delete the data folder, which is `~/.claude/ranviera` by default.

Uninstalling does not change your Claude Code files, apart from the hook entries described above.

## Running from source

You need Python 3.12 or later, Node 22 or later and a copy of this repository.

```
pip install -r requirements.txt
npm install
cp cortex.config.example.json cortex.config.json
python cortex.py build
python cortex.py check
npm run dev
```

On Windows, use `copy` in place of `cp`. The application then opens at `http://localhost:5182`. The documents in `docs/` describe the architecture, the data contracts, the ontology, the reasoning rules, the brain view and the operation of the product.

## Licence and warranty

Ranviera is licensed under the Apache License, Version 2.0 (see `LICENSE`). The brain model and the fonts have their own licences, which are set out in `NOTICE` and `THIRD_PARTY_NOTICES.md`. As the licence says, the software is provided 'as is', without warranties or conditions of any kind. The authors give no warranty beyond the licence.

## Reporting a problem

A bug or a request can be raised as an issue in the repository. A security problem should be reported privately, as `SECURITY.md` describes.

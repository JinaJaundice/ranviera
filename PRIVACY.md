# Privacy

This notice states how Ranviera handles the files and data of the person who uses it. Ranviera is an independent open-source project, and the authors operate no service that receives data from the application.

## Summary

Ranviera processes your files on your own computer. We do not receive your files or any data about your use of the application, we collect no usage data, and the application has no account, no analytics and no tracking code. Where you choose to run Claude Code through Ranviera, Claude Code sends data to Anthropic under your own agreement with Anthropic.

## Files that Ranviera reads

After you give your agreement at the second step of the first run, Ranviera reads the following files on your computer:

- the Claude Code folder, normally `~/.claude`, with its `CLAUDE.md` file, rules, skills, agents, output styles, settings and memory folders
- a projects folder, but only where you choose one.

Ranviera reads these files to build a knowledge graph. The graph holds the text of rules and headings, file paths, dates, names and the links between them, and it can therefore hold any personal or confidential content that your own files contain. We recommend that you treat the data folder as private.

## Files that Ranviera writes

- **The data folder.** By default this is `~/.claude/ranviera`. It holds the graph, the results of validation, the record of events and of agent runs, the record of your agreements, a copy of the hook runner and the log of the local server. You may delete this folder at any time, and Ranviera then starts again from the beginning.
- **The Claude Code settings.** Where you agree at the third step of the first run, Ranviera adds hook entries to `~/.claude/settings.json`. It writes a dated backup before each change and leaves every other entry as it was. Removal deletes only the entries that Ranviera added.

Ranviera does not store the text of a prompt unless you turn on the setting `log_prompt_snippets`. Where you turn it on, Ranviera stores the first 120 characters of each prompt.

## Local operation

The local server listens on the address 127.0.0.1 on a free port, and it refuses any request that does not carry a random token created at each launch. A computer elsewhere on the network cannot therefore reach it. The application contains no code that sends the graph, the events or your files to the authors or to any other party.

## Network use

- **Updates.** The check for a new version is off by default. Where you turn it on in Settings, Ranviera reads the public list of releases on GitHub when it starts, and GitHub receives your IP address under GitHub's own terms. Ranviera adds no other information to that request.
- **Brain model.** The brain model is part of the application, and the application downloads no model when it draws the brain view.
- **Claude Code.** Ranviera does not include, download or modify Claude Code.

## Claude Code and Anthropic

Where you run an agent, Ranviera starts the `claude` command that you installed. Claude Code then sends the prompt, the files that it reads and its output to Anthropic, under the terms and the privacy policy of your own agreement with Anthropic. Ranviera starts the sign-in in a terminal window that belongs to Claude Code, and the whole sign-in, including any code that you paste, takes place inside Claude Code. Ranviera reads only whether you are signed in and the name of your plan where Claude Code reports one. It does not collect, store or pass on any Claude password, session token or sign-in code, and it does not read the e-mail address of the account.

Agent runs remain off until Claude Code is signed in and you have agreed, once, that each run uses Claude Code under your own plan and its limits.

## Questions and changes

A question about this notice can be raised as an issue in the public repository. Please include no personal data in the issue. A change to this notice is made in the repository, where its history is visible.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

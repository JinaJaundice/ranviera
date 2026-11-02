# Privacy

This notice states how Ranviera handles the files and data of the person who uses it. Ranviera is an independent open-source project, and the authors operate no service that receives data from the application.

## Summary

Ranviera processes your files on your own computer. We do not receive your files or any data about your use of the application, we collect no usage data, and the application has no account, no analytics and no tracking code. Where you choose to run Claude Code through Ranviera, Claude Code sends data to Anthropic under your own agreement with Anthropic. Where you choose another model provider for learning sessions, the text for the request goes only to that provider, under your own agreement with it.

## Files that Ranviera reads

After you give your agreement at the second step of the first run, Ranviera reads the following files on your computer:

- the Claude Code folder, normally `~/.claude`, with its `CLAUDE.md` file, rules, skills, agents, output styles, settings and memory folders
- a projects folder, but only where you choose one.

For the learning features, Ranviera reads only the folders that you link as sources in Sources. A source may be a folder of notes, PDF files, Claude memory, Claude Code transcripts, Claude instructions, project Markdown files or a LearnHarness data folder. Ranviera reads no other folder for these features, and a scan reads the files in place without changing them. Each source carries a sensitivity label of public, internal or client-confidential, which controls where its text may be sent (see the section on learning sessions and model providers).

Ranviera reads these files to build a knowledge graph. The graph holds the text of rules and headings, file paths, dates, names and the links between them, and it can therefore hold any personal or confidential content that your own files contain. We recommend that you treat the data folder as private.

## Files that Ranviera writes

- **The data folder.** By default this is `~/.claude/ranviera`. It holds the graph, the results of validation, the record of events and of agent runs, the record of your agreements, a copy of the hook runner and the log of the local server. You may delete this folder at any time, and Ranviera then starts again from the beginning.
- **The Claude Code settings.** Where you agree at the third step of the first run, Ranviera adds hook entries to `~/.claude/settings.json`. It writes a dated backup before each change and leaves every other entry as it was. Removal deletes only the entries that Ranviera added.
- **The learning folder.** This is `learn` inside the data folder. It holds the registry of linked sources, the claims and arguments that Ranviera extracts with line locators back to the source files, the records of learning sessions, your model settings and an `archive` folder. The folder follows the LearnHarness data format version 1, so the LearnHarness app can read it.
- **The keys file.** This is `auth.json` in the data folder, described in the section on keys.

Ranviera does not store the text of a prompt unless you turn on the setting `log_prompt_snippets`. Where you turn it on, Ranviera stores the first 120 characters of each prompt.

## Local operation

The local server listens on the address 127.0.0.1 on a free port, and it refuses any request that does not carry a random token created at each launch. A computer elsewhere on the network cannot therefore reach it. The application contains no code that sends the graph, the events or your files to the authors or to any other party.

## Network use

- **Updates.** Ranviera does not check for new versions and does not update itself. A new version is a new download from the Releases page.
- **Brain model.** The brain model is part of the application, and the application downloads no model when it draws the brain view.
- **Claude Code.** Ranviera does not include, download or modify Claude Code.

## Claude Code and Anthropic

Where you run an agent, Ranviera starts the `claude` command that you installed. Claude Code then sends the prompt, the files that it reads and its output to Anthropic, under the terms and the privacy policy of your own agreement with Anthropic. Ranviera starts the sign-in in a terminal window that belongs to Claude Code, and the whole sign-in, including any code that you paste, takes place inside Claude Code. Ranviera reads only whether you are signed in and the name of your plan where Claude Code reports one. It does not collect, store or pass on any Claude password, session token or sign-in code, and it does not read the e-mail address of the account.

Agent runs remain off until Claude Code is signed in and you have agreed, once, that each run uses Claude Code under your own plan and its limits.

## Learning sessions and model providers

Learning sessions and the extraction of claims from your sources run on one of three kinds of model that you choose in Settings: Claude Code, a provider of the pi-ai library for which you have saved an API key, or a local endpoint that speaks the OpenAI interface. Ranviera sends text only to the model that you have chosen. It never sends source text, claims, sessions or keys to the authors or to any other party.

- **Claude Code.** The text goes to Anthropic through Claude Code, as described in the previous section.
- **A hosted provider.** The text of the request, which may include extracts of your sources, goes to the provider that you chose, under your own agreement with that provider.
- **A local endpoint.** The text goes to the address that you entered. Ranviera treats the endpoint as local where its address is a loopback address or where you state that it runs on your own machine or network.
- **Web search.** The research agent searches the web only where you have saved a Tavily or a Brave key, and it then sends its search queries to that service. It fetches public web pages, and it refuses an address that points at your own machine or a private network.

Ranviera applies a sensitivity check before it sends the text of a source to a model. Where a source is labelled client-confidential and the chosen model is hosted, Ranviera refuses the request and sends nothing, unless you have recorded your consent for that source in Sources. The check allows Claude Code and a local model without consent. A request that mixes several sources is refused when any one of them fails the check.

## Keys

Ranviera stores the API keys that you paste in the file `auth.json` in the data folder, in plain text, as a JSON object. It writes the file with owner-only permissions where the file system supports them, and it keeps the previous version beside it as `auth.json.bak`. The application shows a saved key only as its last four characters and its length, and it never returns the full key to the browser. A key that you set as an environment variable before launch takes precedence over the file, and Ranviera shows that the file entry is shadowed. The deny list for file tools names `auth.json`, so an agent cannot read it through its file tools. Anyone who can read your data folder can read the keys, and we recommend that you treat it as private.

## Deleting learning data

- **One key.** Remove it in Settings. Ranviera deletes the entry from `auth.json`, and the previous version stays in `auth.json.bak` until you delete that file as well.
- **One source.** Unlink it in Sources and choose how to treat its knowledge. The option to delete nodes removes the claims and arguments from the source, and the option to preserve the graph keeps them. In both cases Ranviera moves the lines that it removes to `learn/archive/<date>/` and does not change your own files.
- **All learning data.** Delete the `learn` folder inside the data folder, which includes its `archive` folder. Ranviera then starts the learning features again from the beginning. Deleting the whole data folder also removes the keys file.

## Questions and changes

A question about this notice can be raised as an issue in the public repository. Please include no personal data in the issue. A change to this notice is made in the repository, where its history is visible.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic, or by LearnHarness or its authors. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.

# Learning record in Claude Code

Ranviera includes a skill called cortex-knowledge. It lets Claude Code read what you have learned in Ranviera and answer from it. This guide explains what the skill does, how to install it, how to point it at another folder, and which questions to ask.

## What the skill does

The skill reads your learning folder. That folder holds your saved Learn sessions, the claims that Ranviera extracted from your sources, the argument chains that link them, the sources you linked and your graded answers.

The skill follows four rules.

- It only reads. It does not create, change or delete a file in your learning folder, and it leaves no index or note there.
- It needs no running app. Ranviera does not have to be open.
- It needs Python 3.10 or later. It uses only the standard library and makes no network calls.
- It treats stored text as data. It does not follow an instruction found inside a session or a claim, and it does not open a path that a record names.

The skill does not teach you or grade you. Teaching and practice remain in the Learn window of Ranviera.

## Install the skill

The skill folder is `skills/cortex-knowledge`. It is available in a clone of the repository or from the source code of a release. A release is listed at https://github.com/JinaJaundice/ranviera/releases, and its source code downloads as a zip file that you extract first.

1. Open a terminal in the folder that holds `skills`.
2. Run the commands for your system.

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills"
Copy-Item -Recurse skills\cortex-knowledge "$HOME\.claude\skills\cortex-knowledge"
```

macOS or Linux:

```sh
mkdir -p ~/.claude/skills
cp -R skills/cortex-knowledge ~/.claude/skills/cortex-knowledge
```

3. Check that Python 3.10 or later is installed. On Windows run `python --version`. On macOS or Linux run `python3 --version`.
4. Check that the file `~/.claude/skills/cortex-knowledge/SKILL.md` exists, because the skill folder must hold `SKILL.md` directly.
5. Restart Claude Code, which may be needed before it lists the new skill. Then ask Claude Code which skills it has, and check that cortex-knowledge appears.

## Choose the learning folder

The skill looks for the learning folder in this order.

1. The option `--learn-dir`, which you add to the command that runs a reader. The option `--data-dir` means the same. For example: `python3 ~/.claude/skills/cortex-knowledge/scripts/sessions.py list --learn-dir ~/backups/ranviera/learn`.
2. The environment variable `CORTEX_LEARN_DIR`.
3. The folder `~/.claude/cortex/learn`, if it exists, because another build of the app uses that name.
4. The folder `~/.claude/ranviera/learn`. On Windows this is `C:\Users\<name>\.claude\ranviera\learn`.

The skill reads the first item in this list that applies. If both folders in items 3 and 4 exist, the skill reads `~/.claude/cortex/learn` and names the other folder in a message on stderr, the error output of the command. Most people have only `~/.claude/ranviera/learn`, so they need no setting.

If no folder is found, the skill stops with an error that names both default folders. It does not create a folder. The option or the variable lets you read a backup, a copy or an app installed with a different data folder.

To set the variable for one session:

Windows PowerShell:

```powershell
$env:CORTEX_LEARN_DIR = "D:\backups\ranviera\learn"
```

macOS or Linux:

```sh
export CORTEX_LEARN_DIR=~/backups/ranviera/learn
```

The folder you give must be the one that holds `chats/` and `graph/`.

## Ask Claude Code

You normally ask in plain words and Claude Code runs the readers for you. Three examples follow.

1. "Explain public-key cryptography in terms of what I already know." Claude Code searches your claims for the topic, follows the chains that use them and checks whether you have answered questions on them. It names the claim ids it used.
2. "What did I get wrong in my Learn sessions last week?" Claude Code lists your sessions, reads the ones from that week and reports the answers that were marked wrong.
3. "What do my notes say about key pairs?" Claude Code searches the claims by name, statement and alias, and tells you which source each claim came from.

You can also run a reader yourself. For example, this lists your saved sessions:

```sh
python3 ~/.claude/skills/cortex-knowledge/scripts/sessions.py list
```

On Windows PowerShell use `python` and the path `$HOME\.claude\skills\cortex-knowledge\scripts\sessions.py`. The other readers are `graph.py`, `sources.py` and `outcomes.py`. Add `--format json` to get the records instead of Markdown.

## Limits of the answers

A claim in the record was extracted by a model from a note or a session. It is a recorded statement that has not been checked as fact. A claim does not show that you understand it, and a missing claim does not show that you do not. The skill also reports a held band for a claim, which is one of held, shaky or unknown. Unknown means you have not answered a question on that claim. The band comes from a few graded answers and shows how recall looked at the time. It does not measure mastery. Claude Code should say so when an answer depends on this record.

Ranviera writes to the folder while it runs, so a read during a lesson may be one message behind. Ask again if that matters. If a record cannot be read, the output lists it under Skipped records, and the result is not complete. A folder in a newer format than the skill reads is refused with a message to update the skill.

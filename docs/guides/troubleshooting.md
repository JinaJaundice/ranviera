# Troubleshooting

This guide lists common problems with Ranviera. Each entry says what you see and what to do. Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. If your problem is not here, open an issue at https://github.com/JinaJaundice/ranviera/issues and say which step failed. Do not paste keys, passwords or private text into an issue.

## Windows or macOS blocks the app

**What you see.** The first releases are not code-signed. No company has vouched for the file. Windows SmartScreen may show the message Windows protected your PC. macOS may say that it cannot verify the app.

**What to do on Windows.**

1. Check the download against `SHA256SUMS.txt`, as the guide `install.md` describes.
2. In the SmartScreen message, choose More info.
3. Choose Run anyway.

**What to do on a Mac.**

1. Open Ranviera from the Applications folder. When macOS says it cannot verify the app, choose Done.
2. Open System Settings, then Privacy and Security, and scroll to the Security section.
3. Choose Open Anyway next to the message about Ranviera, then confirm with your login password.
4. If Open Anyway does not appear, open Terminal, run `xattr -dr com.apple.quarantine /Applications/Ranviera.app` and open Ranviera again.

## The Send button opens Settings

**What you see.** In the Learn window you type a question, and the notice Choose your models appears above the box. Choosing Send opens Settings. The notice means that at least one of the three model slots is empty. A slot is a place in Settings where you pick the model that does one kind of work. The slots are Main model, Helper model and Image model, and a session starts only when all three hold a model. If no provider key is saved either, the notice says Add a provider key.

**What to do.**

1. Open Settings and go to the Models section.
2. In each of the three slots, Main model, Helper model and Image model, choose a model. If you want to use Claude Code, switch on Use Claude Code as a model first in the Claude Code section. The guide `models.md` describes each slot.
3. If you chose a hosted provider, add its key under Provider keys.
4. Go back to the Learn window and send the question again.

## Claude Code is not found or is too old

**What you see.** In Settings, the Claude Code section says one of two things:

- Not found. Install Claude Code and sign in to it outside this app, then check again.
- Found, version followed by a number, which is below the minimum of 2.1.316. Update Claude Code.

A lesson that needs Claude Code may show The Claude Code CLI was not found. Install it or set its path in the configuration. It may also show The Claude Code CLI is older than the minimum version. Update it and then try again.

**What to do.**

1. Install or update Claude Code from the Anthropic installation page, which the first-run window links to.
2. Return to Ranviera and choose Check again in the Claude Code section of Settings.
3. If the status still says Not found, close Ranviera, open a new terminal window, run `claude --version` and confirm that it prints a version. Then open Ranviera again.

## Claude Code is not signed in

**What you see.** The set-up window says Claude Code sign-in needed. A lesson or a mission may show Claude Code is not signed in.

**What to do.**

1. Choose Sign in with Claude Code. A terminal window that belongs to Claude Code opens. Ranviera does not see your password, code or key.
2. Complete the sign-in in that terminal window. Ranviera checks at intervals of 3 seconds for up to 5 minutes.
3. If the window stops waiting, choose Check again.
4. If the button does not open a terminal, open any terminal and run `claude auth login`. When it finishes, choose Check again.

## An extraction that remains at not read

**What you see.** In the Sources window, a root still shows a count such as 5 not read after you choose Extract unread files. Extraction is the step that turns the text of a file into claims.

**What to do.**

1. Select the file in the tree and read its details. The Result row says Not read yet, Failed or Stopped. A message in a coloured box under the rows gives the reason.
2. Some messages tell you that extraction runs in the background and needs a model for that work. There are two routes. Either open the Claude Code section of Settings and switch on Allow background use, such as reading sources and research. Or open the Models section of Settings and choose a model for the Helper model slot, which reads sources for the graph, checks links and runs research. The message may call this slot the cheap slot.
3. If the Helper model slot is empty, the Models section shows no model for it. Choose one there.
4. If the message names a file problem, such as The file type is not supported, the file is refused. A file larger than the limit of 25 MiB is refused in the same way. Change the file or exclude it with a pattern.
5. Go back to Sources and choose Extract unread files again.

## A large extraction asks for confirmation

**What you see.** After you choose Extract unread files, a warning box says This will read followed by a number of files and an estimate of tokens. It ends Confirm to start the extraction. A token is a small piece of text that a model counts. The more tokens, the longer the work takes and the more it can cost on a provider with an API key.

**What to do.**

1. Read the number of files. If it is higher than you expected, choose Cancel and select fewer files, or add an exclude pattern to the root.
2. If the number is right, choose Confirm and extract.

## A source that a hosted provider may not read

**What you see.** A lesson or an extraction stops with the message This material is client-confidential and the chosen model is hosted. Choose Claude Code or a local model, or record consent for the source in Sources. In the Sources window, the Hosted providers switch is off, or you cannot switch it on.

A hosted provider is a model service that runs outside your computer. The server refuses a hosted model for a Client confidential root before it makes any model call, unless you have given consent for that root.

A root marked Public or Internal needs no switch. The model that you chose may read it wherever the model runs. For such a root the Hosted providers line says Allowed, because this root is not client confidential. and the switch cannot be changed.

A root marked Client confidential may be read only by Claude Code, which runs under your own agreement with Anthropic, or by a model on your own computer or network. A hosted provider may read it only after you switch on Hosted providers for that root.

**What to do.**

1. Open the Sources window and select the root.
2. Read the Sensitivity row in the details of the root. You chose the sensitivity when you added the root. Then read the line under Hosted providers. It says Not allowed. or Allowed since followed by a date.
3. Choose one of these fixes for a Client confidential root:
   - In Settings, choose Claude Code or a model on your own computer or network.
   - Or switch on Hosted providers for the root. Its label is Allow hosted providers to read followed by the name of the root. Switch it on only if you accept that the text of its files may be sent to the provider you chose. The line then shows the date, as in Allowed since followed by a date.
4. Try the lesson or the extraction again.

To stop any further text going to a hosted provider, switch Hosted providers off for the root.

## The port is already in use

**What you see.** This applies when you start the server yourself from the source code. The terminal prints Port followed by the number is already in use. Stop the other server, then start this one again. The installed app picks a free port on its own and does not show this message.

**What to do.**

1. Find the other copy of the server or another program that holds the port, and close it.
2. Run the server again.

## The graph has not been built

**What you see.** A window shows The graph has not been built. Open the Health window and choose Rebuild and check. A query may show The query service is not ready. Open the Health window, choose Rebuild and check, then try again. The Health window may also say that its report describes an older build of the graph.

**What to do.**

1. Open the Health window.
2. Choose Rebuild and check. While it works, the button shows Rebuilding followed by a count of seconds.
3. When it finishes, return to the Graph window. If the graph is still missing, look at the server log, as the next section describes.

## Where the server log is

Ranviera writes what its server prints to a file named `server.log` in the data folder. The default data folder is `~/.claude/ranviera`, which on Windows is `C:\Users\<name>\.claude\ranviera`.

To open the folder, go to Settings, find the Data folder section and choose Open. When Ranviera cannot start, its error box names the file, for example The Ranviera server did not start within 30 seconds, followed by See and the path to `server.log`. Read the last lines of the file for the cause, and include them in an issue if you ask for help. Remove any private text from them first.

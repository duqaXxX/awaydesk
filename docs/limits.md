# Limits

What you can do with Claude Code in the terminal and cannot do, or do differently, when you
drive it from Slack through awaydesk. Each limit is listed under whoever sets it, since
that says whether it can change: a limit of the Claude Agent SDK applies to any program that
drives Claude Code, a limit of Slack to any Slack app, and a choice of awaydesk is this
project's own.

Each agent awaydesk can drive has a section of its own, which lists every difference found
between a session started from Slack and the same agent in its terminal, the small ones too.
Claude Code is the only agent today. Elsewhere on the page, a limit that has an equivalent you
would not notice is left out. `!status`, `!help` and
`!resume` stand in for the terminal's `/status`, `/help` and `/resume`, `!stop` interrupts as
Esc does, and a command of Claude Code is typed with `!` in place of `/`. The limits of a
single command (how many folders `!bind` lists, how large a file `!open` shares) are in
[setup.md](setup.md), beside the command.

Where a limit may have a way around it, the last column names the issue that looks into it.

## Limits of the Claude Agent SDK

This is the section of the Claude agent. awaydesk drives Claude Code through the Claude Agent
SDK, which runs it without its interactive terminal. awaydesk starts a session with Claude
Code's own system prompt and with the terminal's defaults for subagents and web searches, which
the SDK leaves out; what still differs is below. Claude Code also keeps some features for the
interactive terminal: it answers a command it does not offer there with
`/<name> isn't available in this environment.` awaydesk passes every command through as you
type it.

The first rows are about how a session runs, the others about commands.

| What differs | In the terminal | From Slack | Looked into |
|---|---|---|---|
| A command left running in the background | Runs until it ends | Stopped after 30 minutes, or after the time Claude asked for, 2 hours at most; Claude is told and can start it again. `BASH_DEFAULT_TIMEOUT_MS` in `.env` replaces the 30 minutes, and the 2 hours when it is longer, up to 24.8 days ([setup.md](setup.md)) | none |
| How long Claude Code waits for a command in the foreground | 2 minutes by default | The same, unless `BASH_DEFAULT_TIMEOUT_MS` is set: its value replaces the 2 minutes too | none |
| Publishing a page as an artifact | The `Artifact` tool | Not offered | [#300](https://github.com/duqaXxX/awaydesk/issues/300) |
| A question that shows a preview beside each option | Offered | The question comes without previews | [#300](https://github.com/duqaXxX/awaydesk/issues/300) |
| The sign that Claude is working | A spinner with a word while a turn runs, and `Waiting for 1 background agent to finish` between two turns that report | `Working…` under the thread while Claude Code says it is running: every turn, and the whole wait for a subagent left in the background, with no words of its own for that wait. A session is started with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for this, which a terminal session is not | [#301](https://github.com/duqaXxX/awaydesk/issues/301) |
| A subagent that starts subagents in the background | Waits for them | Does not wait: one that ends later reports to the main conversation | none |
| A subagent that is continued | `Resuming agent <id>` under the line of its first end | The card of the call that continues it, which stays until the subagent ends again; after a restart of the daemon, a launch line under that call's name in place of the card | [#315](https://github.com/duqaXxX/awaydesk/issues/315) |
| The end line of a task | Text of the conversation behind a coloured dot | Small and grey behind `✓` or `✗` | none |
| A subagent that is stopped | `Agent "<description>" was stopped by Claude`, or `by user`, with a mark of a third colour | `✓ Agent "<description>" stopped` when Claude stops it; no line when you stop the thread with `!stop` | none |
| A command while it runs | Its description, and under it the command and its seconds: `$ sleep 20 (8s)` | Its description alone, as the title of the run's card | [#315](https://github.com/duqaXxX/awaydesk/issues/315) |
| A run of calls that has ended, while the reply goes on | A grey line of counts | A card titled with the counts, which becomes the grey line when the reply ends | [#100](https://github.com/duqaXxX/awaydesk/issues/100) |
| The counts of a run | A command is counted by what it does: `Listed 1 directory`, `Searched for 2 patterns` | Every command is `Ran 1 shell command` | none |
| The calls of a run, one by one | `ctrl+o` opens each call with its output | Not shown | [#312](https://github.com/duqaXxX/awaydesk/issues/312) |
| Several tasks started in the background by one message, one of which waits for an approval | The line of the ones already running is written at once | It is written when the last one has started, or when the reply writes anything else | none |
| The model of a subagent that runs on another model than the session | Its name and version after the call: `Agent(List folder files) Haiku 5.5` | The display name the SDK lists for the model, which carries no version in the list read on 2026-10-15 (`Haiku`); the full id when the list does not hold it | none |
| What a subagent was asked | `ctrl+o` shows its prompt under the launch line | Not shown | [#312](https://github.com/duqaXxX/awaydesk/issues/312) |
| A task started in the background | Words of its tool: `Monitor(<description>)` then `⎿ Monitor started · task <id> · timeout 1800s`; `⎿ Backgrounded agent` under a subagent | One form for every kind of task: its name and description, then `⎿ Running in background`; no task id, no timeout | none |
| A turn Claude Code opens by itself with no task's end to report, such as one a Monitor's event opens | What woke it, on a line of its own: `Monitor event: <the line the script printed> · <description>` | Claude Code's text alone, with no line before it: the SDK yields nothing of what woke a turn it opens while idle, and replays that prompt only when the event comes while a turn runs | none |
| The counts of a run that searched for tools | `ToolSearch` is not counted | Every tool is counted by its name, `ToolSearch` too | none |
| How Claude is told who it is | `You are Claude Code, Anthropic's official CLI for Claude.` | `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` | none |
| Sending feedback to Anthropic, ending a conversation | The `SendFeedback` and `EndConversation` tools | Not offered | none |
| The agent that answers questions about Claude Code, the skills on artifacts | `claude-code-guide` and three skills | Not listed | none |
| Running a shell command yourself | Claude may suggest that you type `! <command>` | Claude is not told of it, and in Slack `!` starts a command | none |
| Go back to an earlier point of the conversation or of the code | `/rewind` | Not offered | [#214](https://github.com/duqaXxX/awaydesk/issues/214) |
| Plan before any edit | `/plan`, or the mode switch on the keyboard | Not offered | [#213](https://github.com/duqaXxX/awaydesk/issues/213) |
| Branch the conversation, or ask a side question | `/branch`, `/fork`, `/subtask`, `/btw`, `/background` | Not offered | [#215](https://github.com/duqaXxX/awaydesk/issues/215) |
| Add or change the working directory of a running session | `/add-dir`, `/cd` | Not offered; a thread works in the folder its channel was bound to | [#216](https://github.com/duqaXxX/awaydesk/issues/216) |
| Review the changes, export or copy a reply | `/diff`, `/export`, `/copy` | Not offered; ask Claude for the diff, and copy from Slack | [#217](https://github.com/duqaXxX/awaydesk/issues/217) |
| Open the panels that manage a session | `/permissions`, `/memory`, `/hooks`, `/skills`, `/tasks`, `/sandbox` | Not offered; the settings you made in the terminal apply | [#218](https://github.com/duqaXxX/awaydesk/issues/218) |
| Let Claude use the apps on your screen | Computer use, a server built into Claude Code | Not available: Claude Code offers it in an interactive session only | [#219](https://github.com/duqaXxX/awaydesk/issues/219) |
| Dictate a message | `/voice`, from the microphone | Not offered; an audio clip is the closest thing, below | none |

The rows on how a session runs were measured on 2026-10-13 with Claude Code 2.1.296 and the
TypeScript SDK 0.3.296. The first request of an interactive session and of a session started
with awaydesk's options, in the same folder, with the same prompt and model, were written to
disk with `OTEL_LOG_RAW_API_BODIES` and compared. The model, the thinking and effort settings,
the CLAUDE.md block, the five sections of the system prompt and 12 of the 14 tools were
identical. Three lines of the system prompt differed (who Claude is, the hint on `!`, the note
on `EndConversation`), two tools differed (the rows on commands and on questions), and the
terminal sent two tools more. The time limits are the ones the `Bash` tool states to Claude,
read with and without the variable. The line on who Claude is, in the table, is the one a
session the daemon started quoted when asked. A command of 40 minutes left in the background of two
sessions of the SDK was stopped after 30 minutes in the one without the variable and ran to its
end in the one with `BASH_DEFAULT_TIMEOUT_MS=14400000`. That a subagent does not wait for the subagents it started
is Claude Code's own statement ([sub-agents](https://code.claude.com/docs/en/sub-agents)), and
was not run.

The rows on a task started in the background and on a turn Claude Code opens by itself were
measured on 2026-10-15 with Claude Code 2.1.300 and the TypeScript SDK 0.3.300, in one session
started with awaydesk's options (`replay-user-messages` included) and Haiku 5.5: a Monitor whose
script printed two lines and was stopped with `TaskStop`, a command and a subagent, both in the
background. The Monitor's first line came while the owner's turn still ran: Claude Code took it
into that turn and replayed the prompt that carries it, a `<task-notification>` text the SDK
does not document. Claude Code then opened three turns by itself, for the Monitor's second line
and for the two ends. No `user` record came before any of the three: only each turn's `result`
says, in its `origin`, that a task's notification opened it, and the one the Monitor's line
opened carries no `runId`. The release
probe sends a command to the background on every new SDK and checks that this still holds (claim
P25). The terminal's lines are those of a session run side by side with the daemon the same day.

The rows on commands were measured on 2026-10-09 with Claude Code 2.1.292 and again on
2026-10-10 with 2.1.294, and sent
again by the release probe on every new SDK (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the
pinned SDK bundles Claude Code 2.1.301. Claude
Code's commands reference lists 119 built-in commands; a session started through the SDK is
offered 50 of them. Twenty-two of the others were each sent as awaydesk sends a command:
the nineteen of the table, `/status`, `/help` and `/chrome`. Each got the answer quoted above,
at no cost in tokens. All twenty-two were sent again through the TypeScript SDK 0.3.296 (Claude
Code 2.1.296) on 2026-10-12, with the same answer, and the nineteen of the table through 0.3.300
(Claude Code 2.1.300) on 2026-10-14 and 0.3.301 (Claude Code 2.1.301) on 2026-10-15.
Computer use was absent from the session's servers although it was switched on for the folder,
on the Python SDK 0.2.164 (Claude Code 2.1.292, 2026-10-09) and again on the TypeScript SDK
0.3.296 (Claude Code 2.1.296, 2026-10-12), 0.3.300 (Claude Code 2.1.300, 2026-10-14) and 0.3.301
(Claude Code 2.1.301, 2026-10-15). The
same session started with `--chrome` listed
Claude in Chrome as connected, which is a different server.

For some rows the SDK has a way of its own, which awaydesk does not use: a program can
set a session's permission mode to `plan`, rewind the files of a session to an earlier message,
resume a session as a fork, and name more directories when it starts one. None was run with the
TypeScript SDK awaydesk is built on. The issues hold the earlier measurements and say what has to
be measured first.

## Limits of Slack

| What differs | In the terminal | From Slack | Looked into |
|---|---|---|---|
| Speaking a message | Dictation writes your words as you speak | You send an audio clip and choose **Generate transcript** on it: Slack writes no transcript by itself | none |
| The language of what you said | The `language` setting decides | Slack picks the language it hears, clip by clip, and nothing lets an app choose it | [#220](https://github.com/duqaXxX/awaydesk/issues/220) |
| Being told that Claude waits for your approval | The request appears where you work | A push to your phone does not come for every request. With iOS locked and Slack open in a browser (2026-09-29), a turn that asked two or three times brought no push for any of them. Slack gives an app no way to ask for one | [#71](https://github.com/duqaXxX/awaydesk/issues/71) |
| The list of what still runs, once you opened it | A line under the prompt counts the tasks and changes by itself (`· 1 shell still running`) | The list is one card, under the thread's last reply once it rests, and on no reply while that one is still written. A card you opened closes again after you leave the channel or scroll far away from it | none |

Of three clips spoken in Italian in a workspace set to English (Slack free plan, iOS app,
2026-10-09), Slack first wrote one in Italian and two as English words that were not what was
said. Later reads of the same clips gave Italian, and what changed in between is not known. The
transcript is what reaches Claude, so read it under the clip before you rely on the answer.

## Done on the machine, not from Slack

These need the terminal on the machine that runs the sessions, once or now and then. Away from
it they cannot be done.

| What | Why | Looked into |
|---|---|---|
| Logging Claude Code in or out | `claude` and `/login` on the machine. `!login` and `!logout` answer with that pointer | none |
| Configuring Claude Code: adding an MCP server or signing in to one, turning a plugin on, changing its settings | Done in the terminal, with `claude mcp`, `claude plugin`, `/mcp` or `/config`; awaydesk offers no way of its own. A session started from Slack loads the result from your Claude Code settings. Signing in from Slack would carry an authorization code through a Slack message | none |
| Trusting a folder or a repository you have not used before | Claude Code shows its trust dialog in the terminal only. A session starts only in a trusted folder, and the footer, `!status` and `!open` read git only in a repository trusted by itself, one inside a trusted folder too | none |

## Choices of awaydesk

| What | In the terminal | With awaydesk | Looked into |
|---|---|---|---|
| Who can use it | Whoever sits at the machine | One Slack user, in private channels that hold that user and the bot, in a workspace with no other member | none |
| Where it runs | macOS, Linux and Windows | macOS, as a LaunchAgent in your login session | [#197](https://github.com/duqaXxX/awaydesk/issues/197) |
| Permission modes | Every mode Claude Code has | Bypass on or off for a thread; any other mode is the one your Claude Code settings start in | [#213](https://github.com/duqaXxX/awaydesk/issues/213) |
| How many running tasks are listed | A line under the prompt counts every task | The card lists 6 of them, then `+N more`; its title counts all | none |

## Not checked

- A session of Claude Code past its first request. The comparison with the terminal covers how
  a session starts: what differs once it compacts, uses its memory or runs for hours was not
  measured ([#300](https://github.com/duqaXxX/awaydesk/issues/300)).
- The part of Claude Code's system prompt on Claude in Chrome, which the terminal sent and the
  compared session, started with Chrome off, did not.
- The 47 commands Claude Code does not offer to an SDK session and that are not named above were
  not sent one by one. Most are outside daily use (themes, key bindings, installers).
- A command that is offered can still open a dialog in the terminal (`/config`, `/mcp`,
  `/agents`): what each does from Slack was not tried with the TypeScript SDK awaydesk is built
  on. The issue holds an earlier measurement
  ([#218](https://github.com/duqaXxX/awaydesk/issues/218)).
- A reply that stays on a phone as its stream drew it. Seen twice on iOS, on 2026-10-08 and on
  2026-10-12, while desktop showed the whole reply: the first time it stopped 34 seconds into a
  turn of 116 and showed neither its text nor its footer; the second time it had its text and
  missed the footer and the line that folds the calls. Opening the thread again does not load
  it, nor does restarting the app. Resetting the app's cache does (in the Slack app:
  Preferences, then "Debug & reset cache"). What makes the app miss the end of a reply is not
  known ([#200](https://github.com/duqaXxX/awaydesk/issues/200)).
- A thread older than 90 days on Slack's free plan, where older messages are hidden (Slack's help
  pages, read 2026-10-08). What awaydesk does when the first message of a thread is hidden has
  not been measured ([#196](https://github.com/duqaXxX/awaydesk/issues/196)).
- The daemon has never run on a Linux or a Windows host. Its tests run on both in CI, where the
  ones that build a git layout are skipped on Windows
  ([#197](https://github.com/duqaXxX/awaydesk/issues/197)).

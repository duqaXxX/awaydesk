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
| A subagent that starts subagents in the background | Waits for them | Does not wait: one that ends later reports to the main conversation | none |
| How Claude is told who it is | `You are Claude Code, Anthropic's official CLI for Claude.` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | none |
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
read with and without the variable. A command of 40 minutes left in the background of two
sessions of the SDK was stopped after 30 minutes in the one without the variable and ran to its
end in the one with `BASH_DEFAULT_TIMEOUT_MS=14400000`. That a subagent does not wait for the subagents it started
is Claude Code's own statement ([sub-agents](https://code.claude.com/docs/en/sub-agents)), and
was not run.

The rows on commands were measured on 2026-10-09 with Claude Code 2.1.292 and again on
2026-10-10 with 2.1.294, and sent
again by the release probe on every new SDK (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the
pinned SDK bundles Claude Code 2.1.296. Claude
Code's commands reference lists 119 built-in commands; a session started through the SDK is
offered 50 of them. Twenty-two of the others were each sent as awaydesk sends a command:
the nineteen of the table, `/status`, `/help` and `/chrome`. Each got the answer quoted above,
at no cost in tokens. All twenty-two were sent again through the TypeScript SDK 0.3.296 (Claude
Code 2.1.296) on 2026-10-12, with the same answer.
Computer use was absent from the session's servers although it was switched on for the folder,
on the Python SDK 0.2.164 (Claude Code 2.1.292, 2026-10-09) and again on the TypeScript SDK
0.3.296 (Claude Code 2.1.296, 2026-10-12). The same session started with `--chrome` listed
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
| The list of what still runs, once you opened it | A line under the prompt counts the tasks and changes by itself (`· 1 shell still running`) | The list is one card, under the thread's last reply at rest. A card you opened closes again after you leave the channel or scroll far away from it | none |

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
| Signing in to an MCP server that asks for it | Claude Code runs that flow in the terminal: `claude mcp login <name>`, or `/mcp` | [#221](https://github.com/duqaXxX/awaydesk/issues/221) |
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

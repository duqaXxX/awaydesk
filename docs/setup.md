# Setup

This guide takes a Mac from installing the package to the first reply in Slack. It covers the
Slack app, the configuration awaydesk reads, how it starts on macOS, and the security settings the
design relies on.

Status: an early release (0.x); [CHANGELOG.md](CHANGELOG.md) lists each one, and
[features.md](features.md) what is tested and what is still checked by hand.

The install is one numbered sequence that runs through Parts 0 to 4. Three checkpoints in it say
what to run and what you should see, so a wrong turn shows up where it happened. Part 5 is the
security checklist. [Part 6](#part-6-a-second-instance) adds a second daemon on the same Mac, with
a Slack app of its own and, if you want, a Claude Code login of its own, and has a checkpoint of
its own. "Using it" describes the daily use, and the reference at the end holds the detail the
sequence leaves out.

## Requirements

- macOS 13 or later, with a user account that stays logged in on the machine that runs the
  sessions. The floor is Claude Code's (its system requirements, read 2026-10-12); awaydesk
  itself has been run on macOS 27 only. The Mac has to stay awake: a sleeping machine answers
  nothing until it wakes.
- Claude Code installed and logged in with a claude.ai subscription: run `claude`, then `/login`.
  The 5-hour and weekly usage figures in the status footer exist only with a subscription.
- [Node.js](https://nodejs.org/) 22.18 or later, which brings `npm`.
- A Slack workspace where you are the only member: a workspace admin could read or export what
  Claude prints, and whoever controls your Slack account controls the machine. On the free plan
  Slack allows one workspace; use it only if nobody else is in it (see Part 5).
- Full Disk Access for the Node executable that runs awaydesk, only if your projects
  live in a folder macOS protects, such as `~/Documents` or `~/Desktop`. Without it a session
  there fails to start. The step is under [Folders macOS protects](#folders-macos-protects).

## Part 0: install

1. Install the command from the npm registry:

   ```bash
   npm install -g awaydesk
   ```

That puts the `awaydesk` command in the `bin` folder of npm's global prefix (`npm prefix -g`) and
the package beside it, in `lib/node_modules/awaydesk`; the service of Part 4 runs that copy. When
npm answers `EACCES`, your user cannot write to that prefix: npm's page
[Resolving EACCES permissions errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)
gives the remedies. To update, `npm install -g awaydesk@latest`, then `awaydesk service restart`:
the running daemon keeps the old copy until it restarts. To run a copy built from the repository
instead, see [CONTRIBUTING.md](../CONTRIBUTING.md).

awaydesk runs the Claude Code CLI that ships inside the Claude Agent SDK it depends on,
not the `claude` on your `PATH`. Both read the same login, so logging in once with `claude` and
`/login` covers both.

### Checkpoint 1: the command is installed

```bash
command -v awaydesk
awaydesk --version
```

The first prints the command's path, which ends in `bin/awaydesk`; the second the version
installed, such as `0.1.0`, without starting anything. If the first prints nothing, the `bin`
folder of npm's global prefix is not on your `PATH`: add `$(npm prefix -g)/bin` to it in your
shell profile and open a new terminal. Running `awaydesk` now, before `.env` exists, ends at
once with `ERROR awaydesk.main:` and a line that says `.env` does not exist and gives the address
of Part 2 of this guide, and exit status 1. On a Node older than 22.18 the same command ends with
a line that starts `ERROR awaydesk.main: awaydesk needs Node 22.18.0 or later and this is Node`,
followed by the version found and the address of Requirements, and also with status 1: install a
newer Node.

## Part 1: the Slack app

### Create the app from the manifest

2. Create the app from the manifest:

   - Open <https://api.slack.com/apps> and choose **Create New App**, then **From a manifest**.
   - Pick your workspace and choose **Next**.
   - On the **JSON** tab, replace the example with the contents of
     [`slack-app-manifest.json`](../slack-app-manifest.json). To give the bot a name of your own,
     change `features.bot_user.display_name`: it is the name Slack shows on every reply and at
     the top of the bot's profile. For your first instance, leave `display_information.name`,
     the app's name, as `awaydesk`; the app of a second instance takes a name of its own in both
     fields (step 14 of [Part 6](#part-6-a-second-instance)). Choose **Next**.
   - Check the summary and choose **Create**.

What each scope and event of the manifest is for is under
[Slack scopes and what fails without one](#slack-scopes-and-what-fails-without-one).

awaydesk needs none of the app's agent features: leave **Agent experience** and the
**Slack Model Context Protocol (MCP) Server** off in the app settings. The MCP server lets an app
act on behalf of Slack users, which awaydesk never needs.

### Install it and collect two tokens

3. Open **Install App** and install the app to your workspace. Copy the **Bot User OAuth Token**
   (`xoxb-…`).
4. Open **Basic Information**, find **App-Level Tokens**, and choose **Generate Token and
   Scopes**. Name it, add the scope `connections:write`, and generate it. Copy the token
   (`xapp-…`).

Treat both as passwords: they go in the `.env` file of Part 2 and nowhere else. If one leaks,
regenerate it on the same page.

### Optional: a user token, to delete threads from the Home tab

Skip this unless you want the Home tab's **Edit** mode, which deletes a session's whole thread
and cleans up a channel (see "Deleting a thread" and "Cleaning up a channel" under "Using
it"). Slack lets a bot delete only its own messages
(`chat.delete` reference), and the first message of a thread and your replies are yours, so
deleting them takes a token that acts as you.

- Open **OAuth & Permissions**, and under **Scopes**, **User Token Scopes**, add `chat:write`.
- Reinstall the app to your workspace when Slack asks.
- Copy the **User OAuth Token** (`xoxp-…`) into `.env` as `SLACK_USER_TOKEN` (Part 2).

This token can post, edit and delete messages as you, anywhere you can. awaydesk uses it
for two calls: `auth.test` at startup, to check the token is yours, and `chat.delete`, on the
messages that are not the bot's in a thread you chose to delete or a channel you chose to clean
up. It is the one credential in `.env` that acts under your name: leave it out if you do not
need those two features. The manifest does not ask for the scope, so an app created from it has
no such token.

### Find your member ID

5. In Slack, open your profile, choose the **⋮** button, then **Copy member ID** (it starts with
   `U`). If the profile does not open in the desktop app, use <https://app.slack.com>.

### Create a channel per project

6. Create a channel for the project and invite the bot:

   - Create a channel and turn on **Make private**. Name it after the project, with a common
     prefix so the channels sort together, for example `cc-myproject`. Custom sidebar sections
     would group them better, but Slack offers those on paid plans only.
   - In the channel, run `/invite @awaydesk`, with the name you gave the bot in step 2 if you
     changed it.
   - Open the channel's notification settings. A reply, an approval request and a question post
     inside their own Slack thread, and Slack notifies you on a new message in a thread you
     started, whatever this setting is. It governs only the bot's top-level messages (the answer
     to a word typed in the channel, with `!resume`'s list, and the upgrade notice): with
     **Just mentions** those stay silent, since the bot writes no `@channel` mention anywhere;
     with **All new posts** they ring too. A word typed inside a thread is answered for you alone
     and never rings.

The bot sees private channels it was invited to, and nothing else.

## Part 2: configuration

awaydesk keeps its files in `~/.config/awaydesk/` (a named instance has a folder of its own, see
[Part 6](#part-6-a-second-instance)). `.env` is the one you write;
`state.json` is written by awaydesk and never needs editing (what it holds is under
[The config directory and `state.json`](#the-config-directory-and-statejson)).

awaydesk refuses to start when `.env` is readable by anyone else, is a symbolic link, or
belongs to another user, and when a token is of the wrong kind (`xoxb-` for the bot token,
`xapp-` for the app-level token, `xoxp-` for the user token). It also refuses a missing variable,
named in the message, and an `ALLOWED_ROOT` that is not an absolute path (or one starting with
`~/`) or is not a directory.

7. Create the directory and the file, readable by you only:

   ```bash
   mkdir -p ~/.config/awaydesk
   touch ~/.config/awaydesk/.env
   chmod 600 ~/.config/awaydesk/.env
   ```

8. Open the file in an editor (`nano ~/.config/awaydesk/.env` works) and write the
   variables, one `NAME=value` per line. Replace each `<...>` placeholder, brackets included,
   with the value from Part 1:

   ```
   SLACK_BOT_TOKEN=<bot token>
   SLACK_APP_TOKEN=<app-level token>
   SLACK_OWNER_USER_ID=<member id>
   ALLOWED_ROOT=~/code
   ```

   Add `SLACK_USER_TOKEN=<user token>` on a line of its own only if you took the optional step in
   Part 1.

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | the `xoxb-…` token |
| `SLACK_APP_TOKEN` | the `xapp-…` token |
| `SLACK_OWNER_USER_ID` | your member ID, the only person the bot answers |
| `ALLOWED_ROOT` | the directory `!bind` accepts paths under, for example `~/code` |
| `SLACK_USER_TOKEN` | optional: your own `xoxp-…` token, for the Home tab's Delete and Clean up |
| `AWAYDESK_AGENT` | optional: the agent awaydesk drives; `claude` when absent, the only one this release has |
| `AWAYDESK_CHAT` | optional: the chat awaydesk is driven from; `slack` when absent, the only one this release has |
| `BASH_DEFAULT_TIMEOUT_MS` | optional: Claude Code's own variable, in milliseconds, for how long a command may run; see below |
| `CLAUDE_CONFIG_DIR` | optional: Claude Code's own variable, the folder of a login of its own, for an instance that drives a second account; see [Part 6](#an-instance-with-its-own-claude-code-login) |

`AWAYDESK_AGENT` and `AWAYDESK_CHAT` can be set or left out: `claude` and `slack` are the only
agent and chat this release has, and a file without them works as one with them. A value awaydesk does not know
stops the start, and the message lists the valid ones. A variable that belongs to a module you did
not select is not read.

`BASH_DEFAULT_TIMEOUT_MS` is a variable of Claude Code, which awaydesk hands to every session as
you wrote it. In a session started through the Agent SDK, Claude Code stops a command left
running in the background after 30 minutes, where a terminal session lets it run. A value above
`1800000` replaces those 30 minutes, up to 24.8 days: `BASH_DEFAULT_TIMEOUT_MS=14400000` gives a
dev server or a long build 4 hours. The same value becomes how long a command in the foreground
may run before Claude Code stops waiting for it, 2 minutes when the variable is absent. Claude
Code reads the value and decides what an invalid one means; awaydesk does not check it.

`CLAUDE_CONFIG_DIR` is a variable of Claude Code too, and awaydesk reads it as well: it looks in
that folder for Claude Code's trust record, its Chrome setting and the transcripts of the
sessions. It is an absolute path, or starts with `~/`, and a relative one stops the start with
`CLAUDE_CONFIG_DIR must be an absolute path, or one starting with ~/; it is "<value>"`. When the
file leaves it out, the variable in awaydesk's own environment applies, and when that is absent
too, Claude Code's usual `~/.claude` and `~/.claude.json`.

The workspace ID is not configured: awaydesk reads it from Slack at startup with the bot
token and rejects events from any other workspace.

With `SLACK_USER_TOKEN` set, awaydesk asks Slack at startup whose token it is and refuses
to start unless it is yours (`SLACK_OWNER_USER_ID`) in the bot's workspace.

`ALLOWED_ROOT` guards against a typo such as `!bind /`. It is not a security boundary:
Claude Code can read and run outside its working directory once you approve it.

How the file is read:

- One `NAME=value` per line, with `export ` allowed in front. A value may be in single or double
  quotes. In an unquoted value a `#` starts a comment even with no space before it, so quote a
  value that holds one.
- Inside quotes a backslash is kept as written, except that `\n` in double quotes becomes a line
  break. `\t` and `\\` stay two characters, and a quote after a backslash still ends the value,
  so write a value that holds a quote in the other kind of quotes.
- A value is trimmed, and a variable with an empty value counts as missing.
- `${NAME}` and `${NAME:-default}` inside a value become the value of `NAME` defined above in the
  same file, else the one in awaydesk's own environment, else the default, else nothing.
  `$NAME` without braces stays as written.
- `ALLOWED_ROOT` is an absolute path, or starts with `~/`, which becomes your home directory. A
  relative path is refused, since launchd starts awaydesk in `/` and a terminal in its own folder.
  It must name a directory that exists once links are followed; the message shows the path it
  resolved to.
- The `.env` of a repository is never read. `BASH_DEFAULT_TIMEOUT_MS` and `CLAUDE_CONFIG_DIR` are
  handed on to the Claude Code sessions awaydesk starts. Of the file's values, `CLAUDE_CONFIG_DIR`
  is the one awaydesk also puts in its own process environment, once, at start: the Agent SDK
  finds a folder's sessions through the environment of the process and has no other way to be
  told where Claude Code keeps them. The other value awaydesk puts there is not from the file:
  `AWAYDESK_INSTANCE`, the instance's name ([Part 6](#choosing-the-instance-a-command-is-about)).

### Checkpoint 2: the daemon reads `.env` and connects

Run the daemon in the foreground once, before the LaunchAgent exists:

```bash
awaydesk
```

Within a few seconds the terminal prints a line that ends with:

```
2026-10-10 09:05:03,042 INFO awaydesk.chat.slack.thread: connected to Slack workspace <workspace id>
```

Each line of the log starts with the local date and time, then the level and the name of the part
that wrote it. Press Ctrl-C to stop it: it logs `shutting down` and exits. A problem in `.env`
ends the start at once with a line that holds `ERROR awaydesk.main:` and ends with what to fix,
for example:

```
2026-10-10 09:05:03,042 ERROR awaydesk.main: SLACK_BOT_TOKEN must be the Bot User OAuth Token (xoxb-...)
```

and exit status 1. A token that Slack itself refuses ends the start with
`ERROR awaydesk.main: stopped by an unexpected error: <name>` instead, where the name is Slack's
error code (`invalid_auth`, for a bot token Slack does not know). `another awaydesk is running`
means another daemon of the same instance holds the lock: stop it first. Leave no foreground run going when you
start the LaunchAgent in Part 4.

## Part 3: Claude Code

awaydesk drives Claude Code through the Claude Agent SDK, with the login already on the
machine. Your own Claude Code settings apply: `~/.claude/settings.json`, the project's
`.claude/settings.json`, and `.claude/settings.local.json`. Whatever Claude Code asks your
approval for reaches Slack as **Approve** and **Deny** buttons, with the tool's whole input.

9. Trust the project folder in Claude Code. A session starts only in a folder you have trusted in
   Claude Code. Claude Code shows its trust dialog only in the terminal, and a session started
   from Slack would otherwise run a repository's own hooks and apply its settings without asking.
   Before you bind a channel to a repository, open `claude` at its root in the terminal once and
   accept the dialog. A trusted parent folder does not cover a git repository inside it, such as
   a clone. Outside a repository a trusted parent folder is enough for a session to start, and
   Claude Code then leaves out the `permissions.allow` rules and `additionalDirectories` of the
   folder's own `.claude/settings.json` until you accept the dialog in that folder: Slack asks
   for approvals those rules would cover, and the terminal shows the dialog again there, listing
   them. How trust reaches worktrees and nested repositories is under
   [How trust applies to git](#how-trust-applies-to-git).

What else a session takes from your Claude Code setup (the models it offers, the Bash sandbox, MCP
servers, the Chrome integration) is under
[What a session takes from Claude Code](#what-a-session-takes-from-claude-code).

## Part 4: starting awaydesk on macOS

awaydesk runs as a user LaunchAgent: it starts when you log in and restarts if it exits.
It has to run inside your login session, because Claude Code keeps its credentials in the macOS
Keychain. After the Mac restarts, it starts again when you log in.

One daemon runs per instance. Slack spreads a Socket Mode app's events across all its open
connections, so a second daemon on the same Slack app would receive part of your messages;
awaydesk refuses to start while another daemon holds its instance's lock, or the lock of its Slack app. This part sets up the
default instance; a second daemon on the Mac is a second instance, under
[Part 6](#part-6-a-second-instance).

### Folders macOS protects

10. Give Full Disk Access to Node, only if your projects live in `~/Documents`, `~/Desktop`,
    `~/Downloads` or another folder macOS protects. Do this before the LaunchAgent starts, or the
    first session in such a folder fails.

macOS keeps `~/Documents`, `~/Desktop`, `~/Downloads` and a few other folders private to the
apps you allowed. A program started from Terminal uses Terminal's permission; awaydesk,
started by launchd, has none, and Claude Code fails to start in a directory there. The permission
goes to the Node executable that runs awaydesk, the one the service of the next step starts:

- Show the executable in Finder (it can sit in a folder Finder does not show, so this is the
  simplest way to reach it):

  ```bash
  open -R "$(readlink -f "$(command -v node)")"
  ```

  The command finds `node` on your `PATH`, resolves the links to the real file, and shows it in
  Finder. That file is what launchd starts, so it is the one macOS asks permission for.
- Open **System Settings**, **Privacy & Security**, **Full Disk Access**, and drag the selected
  file (`node`) from Finder into the list. Alternatively choose **+** and press **⌘⇧.** in the
  file picker to show hidden folders.
- Check that the new entry is turned on. If the service is already running, restart it:
  `awaydesk service restart`.

The permission belongs to that executable: any other program started outside Terminal with the
same `node` gets the same access. Projects outside the protected folders need no permission at
all.

### Install the service

11. Install and start the service:

    ```bash
    awaydesk service install
    ```

    It writes the plist `~/Library/LaunchAgents/local.awaydesk.plist`, checks it with `plutil
    -lint`, and loads it with `launchctl bootstrap` in your login session. awaydesk starts at once,
    and again at every login. The command prints the plist's path and the log's,
    `~/Library/Logs/awaydesk/awaydesk.log`, then the copy of the package the plist starts and that
    copy's version (`Runs the copy in <folder>, version <version>.`), and ends with status 0.

launchd does not expand `~` or `$HOME` and gives a service a minimal `PATH`, so the plist names
everything by absolute paths. `ProgramArguments` has two entries: the first `node` on the `PATH`
of the terminal you ran the command from (a link such as `/opt/homebrew/bin/node` stays valid
across Node upgrades; a Node installed under a version folder, as nvm does, stops working when that
version goes), and the real path of the `dist/main.js` the command belongs to. The `PATH` the
service gives Claude Code's commands starts with the folder of that Node, then npm's global `bin`
folder, then `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so a session finds `node`, `npm` and
the commands you installed with npm as your terminal does. The plist also sets `RunAtLoad`,
`KeepAlive` (launchd starts the daemon again after any exit) and an `ExitTimeOut` of 60 seconds,
and sends both outputs to the log.

Running `awaydesk service install` again changes nothing while the service is loaded with the same
plist. When the plist it would write differs (another Node, the package moved, a plist written by
hand before this command existed), it refuses and writes nothing: run `awaydesk service uninstall`,
then `awaydesk service install`. The uninstall stops the daemon, and ends turns still running after
60 seconds.

### Checkpoint 3: the service runs it

```bash
awaydesk service status
tail -n 5 ~/Library/Logs/awaydesk/awaydesk.log
```

The first prints `local.awaydesk is running, pid` and the pid, and ends with status 0 (3 when the
service is not running). After a few seconds the log ends with the line of checkpoint 2:

```
2026-10-10 09:05:03,042 INFO awaydesk.chat.slack.thread: connected to Slack workspace <workspace id>
```

A start that fails logs `ERROR awaydesk.main:` and what to fix; launchd starts the daemon again
after each exit (`KeepAlive`), so the same line repeats until you fix it and restart the service.

The log holds what the service did, never the content of your messages.

To restart it, read its state, or remove it:

```bash
awaydesk service restart
awaydesk service status
awaydesk service uninstall
```

`awaydesk service list` shows every instance's service on the Mac
(see [Part 6](#part-6-a-second-instance)).

`restart` sends `SIGTERM` to the running daemon (`launchctl kill TERM gui/$(id -u)/local.awaydesk`):
running turns finish first, then launchd starts it again. `status` reads `launchctl list`.
`uninstall` unloads the service (`launchctl bootout`) and removes the plist; it leaves
`~/.config/awaydesk/` (`.env`, `state.json`) and the log folder, and names both. On a system other
than macOS, `awaydesk service` answers that the service exists on macOS only, with status 1.

What a restart waits for, and what each way of stopping does, is under
[Restarts and shutdown](#restarts-and-shutdown).

### Bind the channel and send the first message

12. In the channel of step 6, send `!bind <folder>`, with the folder given relative to
    `ALLOWED_ROOT` (`!bind my-project`) and trusted in step 9. The folder must already exist
    under `ALLOWED_ROOT`: for one that does not, the answer starts with the path you typed and
    `is not a folder under`. For one that does, the answer starts `Bound this channel to`. Then
    send a message. The thread shows `Choose how this session starts`; choose **Start**, and
    Claude Code's reply grows in the thread. `!bind` alone lists the folders it accepts, with a
    **Bind** button each. A message sent before any `!bind` starts nothing and is answered
    `This channel is not bound to a folder yet`, with the same two ways to bind.

When the reply arrives, the install is done. Go through the checklist in Part 5 next.

## Part 5: security checklist

The bot answers one person, and the rest of this list protects what that person sees.

- Your workspace has no other member and no other admin. The bot checks who writes; a workspace
  admin could still read or export what Claude prints.
- Two-factor authentication is on for your Slack account. Whoever controls that account controls
  the machine, and no check in awaydesk can tell them apart from you.
- Every channel is private and holds you and the bot only. awaydesk refuses a channel that
  is public, shared, Slack Connect, or has a third member.
- The app stays undistributed: never turn on public distribution under **Manage Distribution**.
- The Slack MCP server stays off.
- The Home tab is published to you alone: awaydesk writes that page for no other member.
- `~/.config/awaydesk/.env` is mode `600`.
- `SLACK_USER_TOKEN` is set only if you use the Home tab's Delete or Clean up: it acts as you in the whole
  workspace, and whoever reads `.env` can post and delete under your name.
- Files you attach are copied to `$TMPDIR/awaydesk/` (`$TMPDIR/awaydesk-<name>/` for a named
  instance; mode `700`) and stay there for 3 days, so a conversation resumed after a restart still finds them.
- Trust a folder in Claude Code only after reading its `.claude/` settings and hooks: trusting it
  is what lets a session from Slack start there.
- With Chrome enabled by default in Claude Code, a session from Slack acts in your browser with
  your sign-ins, and a thread in bypass may do so without asking. Leave it off in `/chrome` if
  you do not want that reachable from Slack.
- The footer, `!status` and `!open` run git only in a repository you trusted in Claude Code by
  itself. A repository inside a trusted folder (one Claude clones during the session, or one
  unpacked from an archive) can name filters in its config that git would run outside the approval
  prompt, so it shows no branch and lists no changed files until you open `claude` in it once and
  accept the trust dialog. Accept it only for a repository whose config you know.
- With a static public IP, you can also restrict the tokens to it under **OAuth & Permissions**,
  **Restrict API Token Usage**. With a dynamic IP, the first address change stops the bot with
  `invalid_auth`.

## Part 6: a second instance

One daemon serves one Slack app. A second daemon on the same Mac is a second instance, with a name
and files of its own. Two reasons to run one: a second login for the agent, and a copy of awaydesk
under development beside the release you use every day. This part adds an instance beside the
default one that Parts 0 to 4 installed. Its steps continue the numbering of Part 4, and its
commands use the name `work`.

### Name the instance

13. Choose a name of 1 to 32 characters of `a-z`, `0-9` and `-`, starting with a letter or a
    digit. `default` and `awaydesk` are refused. Everything the instance owns derives from the name
    (the table under [What an instance owns](#what-an-instance-owns)), and `--instance <name>`
    tells a command which instance it is about.

### Create its Slack app

14. Create a Slack app for the instance from the same manifest: repeat steps 2 to 4 of Part 1,
    with a name of its own in both `display_information.name` and
    `features.bot_user.display_name`, for example `awaydesk work`. Slack shows the second on every
    reply. Then repeat step 6 for the channels this bot serves, inviting it by that name. Your
    member ID (step 5) is the same. To tell apart an app you created earlier under the default
    names, open it at <https://api.slack.com/apps>, choose **App Manifest** in the sidebar, change
    the same two fields, and save.

Each instance needs an app of its own. Slack spreads a Socket Mode app's events across its open
connections, so two daemons on one app would each receive part of your messages, and awaydesk
refuses to start the second ([One app per instance](#one-app-per-instance)).

### Write its `.env`

15. Create the instance's folder and `.env` as in step 7, with the name in the folder:

    ```bash
    mkdir -p ~/.config/awaydesk-work
    touch ~/.config/awaydesk-work/.env
    chmod 600 ~/.config/awaydesk-work/.env
    ```

    Write the variables of step 8 in it, with the two tokens of the new app and your member ID.
    The instance does not read `~/.config/awaydesk/.env`.

### Optional: its own Claude Code login

16. Skip this step to let the instance drive the login of the machine and the folders you trusted
    in step 9. To give it another account:

    - Log in once, in a terminal, with a folder of your choice:
      `CLAUDE_CONFIG_DIR=~/.claude-work claude`, then `/login`.
    - In that same terminal session, trust each project folder the instance will be bound to, as
      in step 9.
    - Add `CLAUDE_CONFIG_DIR=~/.claude-work` to the instance's `.env`, written exactly as you
      typed it for `/login`.

    What this changes, and the rules for the path, are under
    [An instance with its own Claude Code login](#an-instance-with-its-own-claude-code-login).

### Install its service

17. Install and start the instance's service:

    ```bash
    awaydesk service install --instance work
    ```

    It writes `~/Library/LaunchAgents/local.awaydesk.work.plist`, loads it, and prints the plist's
    path, the log's (`~/Library/Logs/awaydesk/work.log`) and the copy of the package the plist
    starts, as in step 11. `uninstall`, `status` and `restart` take the same flag. In a terminal,
    `awaydesk --instance work` runs the daemon in the foreground, as in checkpoint 2.

### Checkpoint 4: both instances run

```bash
awaydesk service list
awaydesk service status --instance work
tail -n 5 ~/Library/Logs/awaydesk/work.log
```

The first prints a table with one row for `default` and one for `work`, each with the state
`running, pid` and a pid. The second prints `local.awaydesk.work is running, pid` and the pid.
After a few seconds the log ends with the line of checkpoint 2, `connected to Slack workspace`.
Then bind a channel of the new bot with `!bind <folder>` and send a message, as in step 12: each
bot answers only in the channels it was invited to, and the other one stays silent there.

### What an instance owns

Everything that is an instance's own derives from its name:

| What | Default instance | Instance `work` |
|---|---|---|
| Configuration folder (`.env`, `state.json`, the lock) | `~/.config/awaydesk/` | `~/.config/awaydesk-work/` |
| Files you attach | `$TMPDIR/awaydesk/` | `$TMPDIR/awaydesk-work/` |
| LaunchAgent label | `local.awaydesk` | `local.awaydesk.work` |
| Plist | `~/Library/LaunchAgents/local.awaydesk.plist` | `~/Library/LaunchAgents/local.awaydesk.work.plist` |
| Log | `~/Library/Logs/awaydesk/awaydesk.log` | `~/Library/Logs/awaydesk/work.log` |
| Arguments of the plist after the entry file | none | `--instance work` |

The default instance's plist is the one earlier versions wrote, so the default instance runs the
same under a version that knows instances and one that does not.

### Choosing the instance a command is about

`--instance <name>` picks the instance a command is about, and so does `AWAYDESK_INSTANCE` in the
environment of the command when the flag is absent; the flag wins. With neither, the command is
about the default instance, which has no name and keeps the paths of Parts 2 to 4. A name that
breaks the rule of step 13 ends the command with status 2 and the reason on stderr. `--version`
and `--help` take no instance.

The daemon sets `AWAYDESK_INSTANCE` to its name in its own environment (and removes it for the
default instance), which every session it starts inherits. A session of `work` that runs
`awaydesk service status` therefore asks about `work`, under launchd and in a foreground run
alike, with no flag typed. To reach the default instance from such a session, empty the variable:
`AWAYDESK_INSTANCE= awaydesk service status`.

### Listing the instances

`awaydesk service list` shows every instance's service, whatever `--instance` or
`AWAYDESK_INSTANCE` say: it takes no instance. It reads each `local.awaydesk.plist` and
`local.awaydesk.<name>.plist` in `~/Library/LaunchAgents/`, takes the instance from the plist's
`--instance <name>` argument (none means the default instance), and prints it, whether
`launchctl` has it loaded (with the pid when it runs), the copy of the package the plist starts and
that copy's version:

```
INSTANCE  STATE              COPY                                                     VERSION
default   running, pid 4242  /opt/homebrew/lib/node_modules/awaydesk                  0.1.1
dev       not loaded         /usr/local/share/awaydesk-dev/lib/node_modules/awaydesk  0.2.0
```

A plist with no entry file is listed with `unreadable plist` as its copy, and a copy whose
`package.json` is gone with the version `unknown`. A plist that does not agree with itself is not
listed as an instance: the command names the file below the table, as `<file>: not an awaydesk
instance it can manage: <reason>`. That is a plist that cannot be read, whose arguments are
anything but the entry file with an optional `--instance <name>`, whose name breaks the name rule
(including `default` and `awaydesk`), whose `Label` is not `local.awaydesk` or
`local.awaydesk.<name>` for the instance its arguments start, or whose file name is not that label
with `.plist`. `service install`, `uninstall`, `status` and `restart` could not find such a file by
an instance name. Instances installed from one copy run it
together: `npm install -g awaydesk@latest` replaces that copy, and each of them needs its own
`awaydesk service restart --instance <name>` to run the new one.

### One app per instance

Each instance has its own lock, in its own configuration folder, so copying an instance's `.env`
to start another and leaving the old tokens in it would give two daemons on one Slack app. Slack
would then send each event to one of the two connections, and half of your messages would reach
the wrong daemon with no error. A second lock guards against it. Once the daemon has asked Slack
who its bot is, and before it opens its connection, it takes two locks: one named after the
workspace and the bot (the bot token), one named after a hash of the app-level token (`xapp-`),
which is what the connection uses. They are in `~/.config/awaydesk_identities/<16 hex digits>/`
(the same folder for every instance of the user, created at mode `700`; no instance name can hold
the underscore, so no instance's folder can be it). Both are checked because a copied `.env` with
only one token replaced, say a new bot token and the old `xapp-` token, still connects to the first
app. The hash is all that is stored: the token itself is never written to the folder name. A daemon
that finds either lock held ends with status 1 and this line in its log:

```
ERROR awaydesk.main: another awaydesk instance is connected to this chat app (lock on <folder>): give each instance its own app
```

The lock is held for as long as the daemon runs and is released with it. A folder left behind
after a stop is empty and harmless.

### A development copy beside the release

Install a build of a clone in a prefix of its own, never in npm's global one, which holds the
release and which `npm install -g` replaces:

```bash
npm install -g --prefix ~/.local/share/awaydesk-dev "./$(npm pack --silent)"
alias awaydesk-dev=~/.local/share/awaydesk-dev/bin/awaydesk
awaydesk-dev service install --instance dev
```

Run from the clone, `npm pack` builds the tarball. The alias (put it in the shell's profile) makes
`awaydesk-dev` the command of that copy, and `awaydesk-dev service install --instance dev` writes
a plist that starts it; its output names the copy and its version. The release keeps running as
the default instance from the global prefix.

### An instance with its own Claude Code login

An instance drives the Claude Code login of the machine unless its `.env` names another folder
with `CLAUDE_CONFIG_DIR`. Claude Code keeps a login, its settings, its trust record and its
sessions in such a folder, and on macOS the Keychain entry of the login is keyed to the folder
([authentication](https://code.claude.com/docs/en/authentication), read 2026-10-17). A Claude
Console sign-in made without an API key is stored outside that folder, so two folders do not keep
two of those apart. Step 16 gives an instance a second account. awaydesk reads the trust record
of the instance's folder, so a project folder trusted only in `~/.claude` is not trusted there.
After changing the line in an existing instance's `.env`, restart the instance.

Write in `.env` exactly the path you used with `/login`. On macOS Claude Code keys the Keychain
entry of the login by the folder's string as it is written, so `~/.claude-work/` (with a trailing
slash) is another entry from `~/.claude-work`, and the instance would find no login. awaydesk
reads `~` as your home and passes the rest on unchanged. The value must be absolute or start with
`~/`; a relative path ends the start with an error that names the variable. The same rule holds
for a `CLAUDE_CONFIG_DIR` the daemon inherits from its environment when `.env` sets none, and the
error then says it came from the environment.

That instance then reads the settings of `~/.claude-work`, not those of `~/.claude`: your
`CLAUDE.md`, skills, hooks, MCP servers and permission rules are the other folder's, and have to
be set there. Its sessions are written there as well, so in a terminal `claude --resume <id>`
finds them only with the same variable: `CLAUDE_CONFIG_DIR=~/.claude-work claude --resume <id>`.
The command `!status` prints carries it: `cd <folder> && CLAUDE_CONFIG_DIR=<folder of the login>
claude --resume <session id> --fork-session`, the login's folder quoted for the shell as the
project folder is. The default instance, and any instance whose `.env` does not set it, keep using
`~/.claude`, and its line is the one shown in "Continuing a session in the terminal".

### Instances that share a login and a folder

Two instances that use the same Claude Code login and are bound to the same folder list each
other's sessions in `!resume`, since Claude Code keeps the sessions of a folder in one place.
Resuming a session that another process has open gives two branches of one transcript, as it does
with two terminals. Keep the instances' folders apart, or resume only sessions of the instance you
are in.

## Using it

A top-level message in a bound channel opens a new Slack thread and starts a session there; a
reply inside that thread continues the same session, even days later, whether or not **Also
send to #channel** is ticked on it. Before the first message
is sent, the thread shows one row of controls under `Choose how this session starts`: a model
from the list Claude Code offers, an effort (`Effort: default` passes none), **Bypass**, and
**Start**, which starts the session with them and sends the message. `!stop` in the thread
cancels it with `Not sent.`, and a reply in a thread where nothing was sent asks again. Each
thread keeps the folder it was opened in: `!bind` only changes where the *next* thread starts. A
thread's Claude Code process closes on its own after an hour with nothing to do; the next message
sent to it resumes the session, as `claude --resume <id>` would.

### Speaking a message: an audio clip

An audio clip recorded in Slack (the microphone in the message field, or **Record an Audio Clip**
on the phone) can be the message. Send the clip, then choose **Generate transcript** on it: a
long press on the message on the phone, the transcript button beside the player on desktop. When
Slack has written the transcript, awaydesk sends its text to Claude as if you had typed
it, in a new thread for a clip sent in the channel and in the same session for a clip sent in a
thread. Until then a line says
``Waiting for this clip's transcript: choose `Generate transcript` on the clip, and its text is sent to Claude.``
It is a message of the bot's, in the channel for a clip sent in the channel and in the thread for a
clip sent in a thread, and awaydesk deletes it when the transcript arrives or the wait ends. A
clip with no transcript after 5 minutes is dropped, and a line that stays says that nothing was
sent; a clip that waits when awaydesk restarts is dropped without a message, and its line stays. Text you type with the clip comes before the
transcript. What Slack heard is always the message, never a `!word`: a clip cannot turn bypass
on or stop a session.

The transcript is Slack's: awaydesk does not listen to the audio and sends it nowhere.
Slack chooses the language it hears by itself, clip by clip. Of three clips spoken in Italian in
a workspace set to English (Slack free plan, iOS app, 2026-10-09), it wrote one in Italian and
two as English words that were not what was said, and those would have reached Claude as they
were. Read the transcript Slack shows under the clip before you rely on the answer. An audio
file you upload is taken the same way: Slack shows it with the same player and transcript.

### Continuing a session in the terminal

Claude Code leaves a session created through the Agent SDK out of the terminal's session picker
and out of `claude --continue`; it resumes one only by its id
([sessions reference](https://code.claude.com/docs/en/sessions)). Every session started from
Slack is such a session. `!status`, typed in the session's thread, shows the command to run:

```
Terminal: `cd <folder> && claude --resume <session id> --fork-session`
```

`--fork-session` continues in a copy with a session id of its own. The copy is a terminal
session, so the picker lists it from then on (measured 2026-09-26 on Claude Code 2.1.282, on one
session started from Slack). The thread stays on the session it had and sees nothing of what the
copy does afterwards. To bring the copy into Slack, send `!resume` in the channel: it opens in a
new thread. Slack does not look for the copy by itself: the thread never moves to it, and
nothing in the thread says that one exists.

Keep `--fork-session` in the command. Without it the terminal resumes the thread's own session,
and two processes on one session interleave their messages into one transcript (same
reference); the next message sent in the thread would do that while the terminal is still open.

The line shows as soon as the thread has a session id, which Claude Code reports when the first
turn starts; a fork made while a turn runs copies the conversation as it stands, with a tool call
still running marked as cut off. It is left out when the thread's folder is missing, unreadable
or not trusted, with the reason at the end of the status. `claude --resume <session id>` finds
the session from any folder (Claude Code 2.1.223 or later); the `cd` makes the copy work in the
thread's folder, which is where the picker and `!resume` in the channel then list it.

### Finding a session again: the Home tab

Open awaydesk from Slack's sidebar and choose its **Home** tab. It lists the sessions your
threads hold, one group per bound channel, the channel used last first. A channel shows its five
newest sessions and, when it has more, a **Show all** button. Each session takes two lines, with
a blank row before the next:

- the status reaction of the thread's root message and the title Claude Code gives the session;
- in small text, the status in a word (`working`, `waiting for you`, `ended`, `error`), the
  thread's number of replies and the time since its last reply, as the channel shows them under
  the root message, and an **Open** link, which opens the thread on its last message.

**New thread**, beside a channel's name, opens that channel: the message you send there starts a
session.

Four controls at the top of the page narrow it: a channel, a status, a period (`Last 48 hours`,
`Today`, `Yesterday`, `Last 7 days`, `Last 30 days`, `Any time`, by the thread's last reply,
the days being those of the machine awaydesk runs on)
and a search on the titles (type a word and press Enter). The page starts on `Last 48 hours`.
The controls add up, and with a channel, a status or a search chosen a channel shows every
session that matches, not five. **Show all** chooses that channel. The choices last until
awaydesk restarts.

The page leaves out a thread whose root message was deleted and a channel Slack no longer has.
It holds about 30 sessions at once and says so when it stops short. awaydesk rewrites it
whenever a session starts, ends or changes status, and nothing notifies you when it does. The
number of replies is read when a session starts or ends a turn, so a word typed in a thread
(`!status`) is counted at the thread's next turn.

#### Deleting a thread

With `SLACK_USER_TOKEN` configured (Part 1), the line above the sessions carries an **Edit**
button. In edit mode each session shows a red **Delete** button, the **New thread** buttons are
left out, and **Done** leaves the mode. A session that is working or waiting for you has no
Delete. A filter you choose in edit mode, **Show all** on a channel included, lasts while you
are in it: **Done** brings back the filters the page had when you pressed **Edit**.

Delete asks first, in a dialog titled `Delete this thread?` that names the thread, with the
buttons `Delete thread` and `Cancel`:

```
“Fix the footer” in #cc-articles, 19 replies. Every message of the thread is deleted from Slack, yours and the bot's. This cannot be undone. The session stays in Claude Code and can be resumed with !resume. Deleting takes about a minute.
```

Confirmed, awaydesk closes the thread's session if it is idle, deletes every message of
the thread, the first one last, and forgets the thread. The Claude Code session is not touched:
`!resume` lists it again.

A delete is not immediate: Slack limits how fast messages can be deleted, and a thread takes
about a minute, more for a long one. From the click on, three places say so. A line under the
header counts the threads being deleted (`Deleting 2 threads, one at a time.`, and why it takes
time). The channel's name is followed by `deleting 2 threads…` for its own. The session's small
line reads `deleting…` in bold behind an hourglass, in place of its status, and has no Delete.
The session leaves the page, and the counts go down, when its thread is gone. Threads are
deleted one at a time, so several chosen in a row go one after the other.

When a delete does not end, a line under the header names the thread and says why. The thread
then stays on the page:

| Line | What happened |
|---|---|
| `Not deleted: that thread is working or waiting for you.` | A turn runs in the thread, or an approval or a question waits for you: let it end, or send `!stop` in the thread |
| `` Could not delete every message of that thread (`<Slack's error>`). Delete it again to continue. `` | Slack or the network failed half way: Delete continues with the messages that are left |
| `` Slack refused to delete 2 of that thread's messages (`cant_delete_message`): they are not yours or the bot's, or your workspace does not let you delete them. Every other message is gone and the thread is still listed. `` | The first message stays so the thread can still be opened: delete what is left by hand in Slack |

A message you send in a thread while it is being deleted starts nothing: you are told
``This thread holds no session.``, and the message goes with the rest. A restart of
awaydesk cuts a delete short; Delete continues it. Without the token the page has no
Edit button.

#### Cleaning up a channel

In edit mode each channel's name carries a **Clean up** button, where **New thread** sits
otherwise. It removes what piles up in a channel outside the threads: your messages there that
have no reply (a word such as `!stop`, a prompt that was never answered, the first message of a
thread whose replies are gone) and the bot's messages, its answers to your words included. It
asks first, in a dialog titled `Clean up this channel?`:

```
Deletes from #cc-articles what sits outside a thread: your messages there that have no reply, commands like !stop included, and the bot's own messages. Every thread that has a reply stays. This cannot be undone and can take a few minutes.
```

What stays: every thread that has a reply, with or without a session, a message you just sent
whose session is still being set up, and Slack's own lines such as a member joining. Do not
keep notes of your own in a bound channel outside a thread: a clean-up takes them for
leftovers. While it runs the channel's name is followed by `cleaning up…`, a
line under the header says so, and the button is gone; it runs after any delete already on its
way. If Slack stops it, a line under the header names the channel and says
`` Could not clean up that channel (`<Slack's error>`). Clean it up again to continue. ``
If Slack refuses some messages, the rest still goes and the line reads
`` Slack refused to delete 2 of that channel's messages (`cant_delete_message`): your workspace does not let you delete them. Every other one is gone. ``

To keep the page one click away, star the app: open awaydesk in Slack on desktop and
click the star beside its name at the top of its page, or drag it from the apps list into
**Starred**. It then sits in the **Starred** section at the top of the sidebar, and a click on
it opens the Home tab. Slack's own steps for starring, mobile included, are in its Help Center
under [Star channels and direct messages](https://slack.com/help/articles/201331016-Star-channels-and-direct-messages).

From outside Slack, this link opens the Home tab in the desktop and mobile apps, for the Dock or
a shortcut: `slack://app?team=<workspace id>&id=<app id>&tab=home`. The workspace id starts with
`T` and the app id with `A`; the app id is on the app's **Basic Information** page.

### Commands

A message is a command when its first character is `!`, however it is formatted: inline code, a
code block, bold, italic and strikethrough are read through, so a word pasted from a place that
showed it as code still acts. The word ends at the first space or line break, and what follows
is sent as you wrote it. To send Claude a text that starts with `!`, put any character before it:
`\!goal`, `"!goal"`. A message that starts with a command you only meant to quote runs that
command: `!stop` or `!bypass on` alone in inline code acts as the word. Inside a quote or a list
a `!` is never a command.

| Word | At the top level (answered by a post in the channel) | Inside a session's thread (answered for you alone) |
|---|---|---|
| `!guide` | Explains in a few lines how awaydesk works | Same, as an ephemeral message you alone see |
| `!bind` | Lists `ALLOWED_ROOT` itself (shown as `.`) and the folders up to two levels below it, never inside a git repository, that Claude Code trusts, with a **Bind** button each; the channel's own folder is marked when it is listed. At most 20 are shown, in path order; when there are more, the higher levels fill the list first. A click never ends a running turn: it is refused until every session of the channel is idle | Refused, in an ephemeral message: `!bind works in the channel, not inside a thread.` |
| `!bind <folder>` | Binds the channel to a folder under `ALLOWED_ROOT`, given relative to it (`!bind my-project`); an absolute path inside it works too. A new channel does nothing else until bound. The answer names the folder each existing thread keeps working in, when it differs from the new one; every prompt sent in that thread after the bind gets the same notice, as an ephemeral message | Same refusal as above |
| `!bypass on` / `off` | Refused, in a post in the channel: `Bypass belongs to one session: send !bypass on inside its thread.` | Switches that session to `bypassPermissions` and back, kept in `state.json` per thread: an idle close and a restart of awaydesk keep it, `!resume` starts a session with it off. The answer is a line only you see, `Bypass is on in this session: every tool runs without asking, until !bypass off. It survives a restart.` or `Bypass is off in this session: Claude Code follows your permission settings again.`, and a ✅ on your word, which stays after a reload. Before the setup's Start (the setup waits, or was cancelled) the word changes nothing and answers `This session has not started yet: tick Bypass in its setup and press Start. If no setup is shown, send a message here first.` |
| `!status` | The channel's directory, then every live session of it, each linked to its thread, busy, waiting or idle, its bypass and running tasks, and its folder when it moved elsewhere | That session's directory, session id, the command that continues it in the terminal, its mode, the folder it works in when it moved elsewhere, then the footer's values one per line, in an ephemeral message |
| `!stop` | Stops every running session of the channel and its background tasks, and denies its pending approvals; the answer is `Stopped what was running in this channel.`, or `Nothing is running in this channel.`; each stopped session's root shows ✅ | Stops that session the same way; the answer is `Stopped.`, or `Nothing is running in this session.`, in a message that stays in the thread; ✅ on the session's root. A stop you gave is not an error, so it never shows ❌ |
| `!help [text]` | Says what makes a message a command, then lists awaydesk's own words; Claude Code's own commands are listed inside a session's thread | The same line, then awaydesk's own words and every command that session offers now, in an ephemeral message; with a text, only the lines whose name or description contains it, for example `!help model` |
| `!open` | Refused, in a post in the channel: ``Opening a file belongs to one session: send `!open` inside its thread.`` | Posts in the thread a message with a `Choose a file` button. It opens a modal with a search field and up to 10 rows, one for each file (its name, its folder below): the files changed in the session (left out when nothing changed or the folder holds no repository git may run in) while the field is empty, the files whose path contains what you type otherwise, updated on each character. `Open` shares the chosen row into the thread, where Slack opens it in its file viewer, and closes the modal; with no row chosen it says `Choose a file first.` and stays open |
| `!open <path or words>` | Refused, as above | Shares the file at that path, relative to the session's folder, into the thread. Words that are no path open the file whose path contains them, in the same listing as the search, ignoring case; several matches post ``N files match `<words>` `` with the `Choose a file` button, which opens the modal with the words in its field. ``No file matches `<words>`.`` when none does. A path outside the folder, one that is no regular file, an empty file and a file over 1 MB are refused with a line only you see; `files:write` missing says so, and any other refusal by Slack shows Slack's error code |
| `!resume` | Lists the twenty newest sessions of the channel's directory that no thread holds (not of other worktrees), terminal and Slack alike, as a post in the channel, each with the first 8 characters of its session id and a **Resume** button. A session already open in a thread of any channel has no row: the twenty rows are sessions you can resume, and a line under the list counts the open ones (`3 more are open in their own threads.`). A click resumes the session in the thread of your `!resume` message and removes the list from the channel; a list posted before that change answers `This list is out of date: send !resume again for a current one.` | Refused, in an ephemeral message: `!resume works in the channel, not inside a thread.` |
| `!resume <id or name>` | A Resume click, or the id (its first 8 characters, as the list shows them, or any longer start) or the name (set with `/rename` or generated by Claude Code, and must match one session), resumes that session in the thread of your `!resume` message, with bypass never chosen (the folder's own mode) and no `/effort` level set, whatever it had before; refused when the session is already open in another thread; it never touches or waits on any other thread | Same refusal as above |
| `!clear` (or `!reset`, `!new`) | Opens a new session (harmless: nothing to clear yet) | Refused: `One thread is one session: send a new message in the channel to start a new one.` |
| `!login`, `!logout` | Never sent to Claude Code, and no session starts. Answered in the channel: ``Log in on the host: on that machine, run `claude`, then `/login`. The login is never done from Slack.`` (for `!logout`: ``Log out on the host: on that machine, run `claude`, then `/logout`. It is never done from Slack.``) | Never sent to Claude Code. The same answer, as a message only you see |
| any other `!name [args]` | Opens a new session, asks its model, effort and bypass, and after **Start** runs `/name args` there if it offers that command, else sends the text as written | Runs `/name args` in that session if it offers the command, else sends the text as written |
| a message, or one with files | Opens a new session, asks its model, effort and bypass, and after **Start** sends the message; the reply appears in the thread and grows as Claude works | Continues that session |
| a question from Claude | Appears as one line with **Answer** and **Skip**; Answer opens a form with one question at a time, the options (one or several), **Other** as the last option (choosing it shows a field, **Your answer**) and optional **Notes** while an option is chosen (not for Other alone); with several questions a line of tabs marks each answered question with ☒ and the page you are on in bold; **Next** moves on once the question has an answer; the last question's **Review** shows all the answers, each with an **Edit** button that opens that question again (its button then reads **Review** and leads back), and **Submit answers** sends them (a question's notes show under its answer); with one question **Submit** sends; **Close** shuts the form and Answer reopens it where you left it | Same |

Where `!open` takes its files. The search reads the session's folder from disk, so it is there in a
folder that is not a repository too, and a path relative to the folder is what it lists and `!open`
takes. The repositories of a folder are the one that holds it when git may run there (see
`A session starts only in a folder you have trusted`, above), otherwise the ones that git may run
in at most two levels below it, the depth `!bind` lists. Inside them the files are the tracked ones
and the untracked ones that are not ignored (`git ls-files`), as the `@` file picker of Claude Code
does with its `respectGitignore` setting at its default; everywhere else the folder is walked:
regular files only, no symlinked folder entered, no `.git` entered. A repository deeper than two
levels is walked like any folder. A listing stops after 2 seconds with the files found so far,
and is kept for 30 seconds, so a folder is not walked again on every character typed. A listing
that ran out of time or lost a repository's git list is kept for 3 seconds instead of 30. The
changed files are the union over those repositories, each counted from where its `HEAD`
was when the thread started (committed since or not, plus untracked files that are not ignored),
newest first, with paths relative to the session's folder. The start is read when the modal's rows
are built, from the repository's reflog at the
time of the thread's first message (`git rev-parse HEAD@{<seconds> +0000}`), so a restart of the
daemon changes nothing and a repository that appears during the session counts from its first
commit. A reflog that does not go back that far gives its oldest entry. Where there is no reflog
(`core.logAllRefUpdates` off, or no commit yet) the rows hold what is uncommitted or untracked
now. A thread that began on one branch and is now on another counts what the other branch holds
beyond where `HEAD` was. Every git command is one that never writes the index, so it cannot leave
an `index.lock` that stops your own `git`. The file is read once, from the path checked, never
following a link or exceeding 1 MB, and handed to Slack as bytes.

The modal shows 10 rows, the most a Slack radio group holds, with the real count in the line above
them. A file name over 75 characters is shortened in its middle with `…`, a folder over 75 from the
left, and a path over 150 characters gets no row (Slack's limit for a value) and stays reachable by
`!open <path>`. Typing is checked for the owner and the workspace alone, with no call to Slack about
the channel; the rows go only to your own modal. `Open` also checks the channel.

A word typed in the channel is answered by a normal post in the channel, which stays there. A word
typed inside a session's thread is answered by an ephemeral message under it: Slack shows it with
`Only visible to you`, and it disappears when Slack reloads, so read it before you switch away.
The same holds for the notice that a thread keeps the folder it was opened in, and for `Not
sent.`. None of these rings a phone.

Slack does not pass a Claude Code command typed with its own slash: `/compact` alone makes Slack
answer that it is not a valid command. Type `!compact`. A `!word` that is not a command the
session offers is sent as a normal prompt, so `!important: …` reaches Claude as written.
`!resume` stands in for Claude Code's own `/resume`, which an SDK session does not offer. A reply
in a thread whose session no longer resumes (its transcript was deleted) gets `This thread's
session no longer exists: Claude Code deleted it or cannot find it. Send a new message in the
channel to start one.`; a reply in a thread that holds no session (a word's own thread, or
one with no entry in `state.json`) gets ``This thread holds no session. In the channel, send a
new message to start one, or `!resume` to continue an earlier one.``, except a word, which acts
as if typed at the top level. Three words change nothing there, since they act on the whole
channel: `!resume` and `!bind <folder>` answer `` `!resume` works in the channel, not inside a
thread.`` (with the word you typed), and `!stop` answers ``This thread holds no session. Send
`!stop` in the channel to stop every session, or inside a session's thread to stop that
one.`` A Resume click or
`!resume <id or name>` sent to a thread that already holds a session gets
``This thread already holds a session: send `!resume` again in the channel to pick another.`` A Resume
click or
`!resume <id or name>` that names a session already open in another thread of any channel gets
`This session is already open in another thread: <link>.` instead, with a permalink to that thread: one
session never runs in two threads at once.

A message with files: Claude sees a JPEG, PNG, GIF or WebP image (up to 7.5 MB and 8000x8000 px;
at most 5 images and 15 MB of images per message) as an image. Any other image type (SVG, HEIC,
TIFF...) is refused. A text, source code, PDF, JSON, XML, YAML or Jupyter notebook file, up to 100
MB, reaches Claude as the path of a copy in `$TMPDIR/awaydesk/` (an instance's own folder, see
[Part 6](#part-6-a-second-instance)), kept 3 days; any other
file (archives, Office documents, binaries) is refused. A file past a limit, or one that fails to
download, stops the whole message, and the reply says which file and why.

A reply is one message in the session's thread, and a native Slack stream. It appears when Claude
has something to show: its first words, or the card of the first tool it uses. Text then grows in
the order it is written. The tool calls between two pieces of text show as one card, as the terminal
draws one line for them: it names the call that runs now, a command by its description, and once
the calls have ended it counts them in the terminal's words (`Ran 2 shell commands, read 1 file`).
A command that has run 30 seconds adds its time to the title (`· 30s`, `· 1m 0s`), refreshed every
30 seconds for the first 280 seconds of the reply and after that only when the reply is written
again; opening the card lists the run's commands, `$ <command>`. A message Claude sends to a
subagent that has ended shows as one grey line, `⎿ Resuming agent <id>`, as in the terminal.
A command that failed is counted with the others, as in the terminal; a failed call of another
tool keeps a card that says why. A task Claude Code starts in the background has no card, whatever
its kind: it is two lines of text, its name in bold and what it does, `Monitor(ticks)` or
`mechanical(review)`, then `⎿ Running in background` (a subagent on another model than the
session names it after the description, `Agent(review) Haiku`), and it shows in the list of what still runs.
The call that left a command or a Monitor running is counted with the others, as in the terminal.
Several tasks started in one message share one line, `3 background tasks launched`, with what each
does under it. What a subagent does shows nowhere in the reply. A turn Claude Code opens by itself
opens with the end line of each task it reports, `✓ Background command "..." completed (exit code
0)`; one with no end to report, such as a turn a Monitor's event opens, shows Claude Code's text
alone, since the SDK does not say what woke it ([limits.md](limits.md)). An Edit or a Write shows once it has ended, as
one collapsed block titled with the call (`Update(notes.txt)`) that opens on its diff or on the
new file's first lines. When the reply ends, each of those cards gives way to its line of counts, in grey (`Ran 2 shell commands, read 1 file`). A reply still
running 280 seconds after it started stops being a stream (Slack closes streams at 5 minutes) and
goes on in the same message, updated instead of streamed; what Claude wrote after its last call
then arrives in a new message. A turn that ends with a background command
or agent still running stops the stream at once, with no footer, and the report that
follows grows the same message by edit; the reply ends, with a new message that holds what Claude
wrote after its last call, once the task and its report are done. A reply longer than one Slack message (12,000 characters or 50 cards) continues in the next one; the text inside collapsed diffs counts toward the 12,000 only while the message is a stream or a post, not once it is edited.

An approval request is a message of its own in the thread, below the reply, and rings, as a
question does; once you decide, it disappears and the tool's line in the reply records the call.
If Slack does not accept the request, Claude Code is told it was denied because it could not be
shown.

Messages sent to a thread while its turn is running wait their turn; each gets its own reply. When
a background task finishes while nothing runs, Claude Code starts a turn of its own to report it,
as it does in the terminal: that reply opens with Claude Code's own line for the task's end, such
as `✓ Agent "review" finished · 3m 59s`, or `✗ Agent "review" failed: ` and the reason. An agent
that ends while a turn runs has that line in the turn's reply. While tasks run, a card under the thread's
last reply lists them: a title such as `1 agent · 1 shell still running` and a line per task, up to
six, then `+N more`.

From the moment you send a message until its answer has ended and its footer shows, Slack shows
`Working…` under the thread's last message. It also shows whenever Claude Code says it is working: in a turn it
starts on its own to report a task, from the moment the task ends, and all through a subagent
it left in the background. A command left in the background does not keep it: the line goes
when the answer is in and comes back for the report. So a thread with neither `Working…` nor
the card of what still runs has ended. The line never counts what still runs: the card
does (`1 shell still running`), until the command ends.
The line goes while an approval or a question waits for you. Slack's clients draw it, and the
iOS app can show none for a thread that Slack on desktop already has open: with desktop closed,
or with the thread opened on iOS first, it shows on both (seen on 2026-10-04, five runs read by
eye, one per condition; the method's reference does not describe it). The reply's cards and
its footer do not depend on it.

What awaydesk says on its own (the answer to `!bind`, `!bypass` or `!stop`, a notice that
it is restarting, a refused attachment, an error) shows small and grey, as the footer does, so it
reads apart from Claude's replies. `!help`, `!guide`, `!status` and the answer to a resume show at
full size.

The footer says how the session stood when it ended. It shows once, under the reply of the
session's latest work, when the session has ended everything it was doing: no turn running, no
message of yours waiting for its answer, no background command or agent running, no report
expected, no approval or question open. It also shows when `!stop`, a restart, a lost process or
an error ends the session, with whatever can be read then. It comes a moment after the reply
ends, with ✅ on the root, by an edit that does not ring. A reply that waits for background work
shows the card of what still runs and no footer; a footer shown before stays where it is when
later work ends under it with a footer of its own. The footer sits on a reply, never on one of
the daemon's own lines: after `!stop` it stays on the reply the stop ended, with `Stopped.` below
it; a prompt that could not start has none. After a forced end it has no model or context share.
A thread with `Working…` or the card at its bottom has not ended; the footer says it has:

```
⚡ bypass · claude-opus-5-5 · effort auto (medium) · my-project · main · (+42,-10) · 10.2M tok · ctx 15% · 5h 16% ↻ 43m · 7d 46% ↻ 3d 4h
```

It holds `⚡ bypass` when bypass is on, the model, the effort level, the name of the folder this
thread was opened in (its whole path is on `!status`), the git branch, the lines changed since
the last commit (untracked files not counted), the session's tokens, the context used, and the
5-hour and weekly limits with the time to each reset, which exist only with a claude.ai
subscription. The labels (`effort`, `tok`, `ctx`, `5h`, `7d`) are bold. A field that is not known
is left out.
The branch and the changes are those of the folder the session works in: the thread's own folder
at first, then the one Claude moved to with `cd` or a worktree, as Claude Code reported it after
its last tool; `!status` names that folder when it is not the thread's own. The effort reads as
Claude Code's own `/effort` does. A level you fixed (at the setup, with `!effort` or `!model`, or
stored from an earlier run) shows as itself, `effort low`. Otherwise the effort is the model's
default and shows `effort auto`, then `effort auto (medium)` once a turn has ended, with the
level Claude Code reported for that turn (it follows each turn). A model that takes no effort level
shows `effort not supported` once a turn has reported that, whatever the setting, until a turn
reports a level again. If a turn reports a level other than the fixed one, the footer shows
the reported one, since that is what ran. A level set with `!effort` is kept for this thread and
reapplied on every reconnect, so it survives an idle close and a restart of awaydesk. A model set
with `!model` needs no such help, since Claude Code's own resume keeps it by itself. `!status`
writes the same value on its `Effort` line.

### Notifications

A reply, an approval request and a question post inside the session's own thread, and Slack
notifies you on a new message in a thread you started, whatever the channel's own notification
setting is:

- A reply rings once, when its stream stops: Slack pushes a stream when it stops, with the start
  of Claude's answer as the text. The stream stops when the turn ends, also when a background
  command or agent it started still runs. The report that follows grows the same message by edit,
  silently, and the ending, posted as a new message when the reply ends, rings a second time.
- A reply that has another reply's message below it ends in the message it is in, by edit, and
  rings no more. So does a reply that waited for background work, has a message of yours below
  it and got no text from Claude since; one that is still writing its turn when you write rings
  with its ending, unless it then waits for background work and gets no text before it ends, and
  one that got a report rings with it.
- A reply that is still open after about 4 minutes 40 seconds rings when its stream stops, and a
  second time when it ends: what Claude wrote after its last call arrives as a new message, and
  the notification reads the start of it. When Claude wrote nothing after its last call, the
  second message holds the footer alone and comes once the session has ended; it does not come
  when something was written below the reply meanwhile, such as `Stopped.`, or when a later
  reply ends the session.
- An approval request and a question ring.
- A reply that fails outright rings once, as any reply ending does.
- A restart ends the reply as any reply ending does, so it rings once. A `!stop` typed in the
  thread rings once, with its answer `Stopped.`; typed in the channel it does not ring. A reply
  longer than one message rings for every extra message.
- Nothing rings while Claude writes.

The channel's own setting (Part 1) governs only the bot's top-level messages (the answer to `!bind`, `!status`, `!resume`'s
own list, the upgrade notice): with **Just mentions** those stay silent, since the bot writes no
`@channel` mention anywhere; with **All new posts** they ring too.

The measurements behind this (what was tried, on what Slack plan and app, and on what date) are
in [features.md](features.md#notifications), not restated here.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The bot does not see a channel | The channel is public, or the bot was not invited: the manifest subscribes the app to the messages of private channels only (`message.groups`) |
| ``awaydesk does not work in this channel: <reason>. It answers only in a private channel whose only members are you and the bot.`` | The bot checked the channel on its own and refused it; only you see the message, in the channel for a message sent there and in the thread for a reply. `<reason>` is one of `it is not a private channel`, `it is shared with another workspace`, `it has members other than you and the bot` and `the bot cannot read its details`. Remove the other members, or use a channel of your own. The first reason can come only from an event of a channel that is not private, which the manifest does not subscribe to |
| `Claude Code is not logged in on the host` | Claude Code on the machine is logged out: run `claude`, then `/login` |
| Some messages get no reply | A second daemon is running on the same Slack app and receiving part of the events: each instance needs an app of its own. Since the chat identity locks, a daemon that starts beside another on the same app ends with the line of the next row, so this one points at a daemon of an older version |
| `another awaydesk instance is connected to this chat app (lock on ...)` in the log | The daemon ended at start because another daemon of this user, of any instance, holds the lock of the same Slack app (the same workspace and bot, or the same `xapp-` token). Give each instance its own app: [One app per instance](#one-app-per-instance) |
| `This thread's session no longer exists: Claude Code deleted it or cannot find it. Send a new message in the channel to start one.` | The stored session id can no longer be resumed (its transcript was deleted); send a new message in the channel to start one |
| ``This thread holds no session. In the channel, send a new message to start one, or `!resume` to continue an earlier one.`` | The thread holds no session (a word's own thread, or one with no entry in `state.json`); send a new message in the channel to start one, send `!resume` there to continue a session Claude Code still has, or type a word, which works as if typed there |
| ``This thread already holds a session: send `!resume` again in the channel to pick another.`` | A Resume click or `!resume <id or name>` was sent to a thread that already has a session; a new `!resume` in the channel gives a thread of its own |
| `This session is already open in another thread: <link>.` | A Resume click or `!resume <id or name>` named a session already open in some other thread; follow the link and send the message there instead |
| `Claude Code has not been trusted in ...`, after a message or a `!bind` | Open `claude` in that folder (the repository root) in the terminal, accept the trust dialog, and send the message again. For a worktree whose folder was moved by hand, run `git worktree repair` in it |
| The terminal shows the trust dialog in a folder you already use from Slack, or Slack asks for approvals the folder's allow rules cover | The folder is outside a repository and only a parent folder is trusted, which Claude Code does not count for the `permissions.allow` rules and `additionalDirectories` of the folder's `.claude/settings.json`. Accept the dialog in that folder: it lists them |
| `The directory ... no longer exists` | The thread's directory was moved or deleted: restore it to keep using this thread, or, in the channel, bind another folder with `!bind <path>` and send a new message to start a session there |
| `macOS does not let awaydesk read ...` | The directory is in a folder macOS protects: see Part 4, "Folders macOS protects" |
| `awaydesk needs Node 22.18.0 or later and this is Node ...` in the log, or on the terminal | The Node that runs awaydesk is older than 22.18; the process ends with status 1. Install a newer Node and run `awaydesk` again. The LaunchAgent names the Node executable in its plist: change it there too |
| `ALLOWED_ROOT must be an absolute path, or one starting with ~/; it is "..."` | `ALLOWED_ROOT` in `.env` is a relative path, which would be read from the folder the process starts in. Write the whole path, or start it with `~/` |
| `another awaydesk is running` in the log | A second daemon of the same instance tried to start; one daemon runs per instance |
| The app has no **Home** tab, or it stays empty | **Home Tab** is off in the app's settings, and the log says `the Home tab is not enabled in the Slack app`: turn it on under **App Home**, **Show Tabs**, then restart awaydesk |
| `forgot channel ...: Slack no longer has it` in the log | The channel was deleted, or the bot was removed from it: its binding and its threads are gone from `state.json`. If the bot is back in it, send `!bind` there again |
| `Slack finds none of the ... bound channels: nothing is forgotten` in the log | Every bound channel is out of the bot's reach: check that `SLACK_BOT_TOKEN` is the one of this workspace and that the bot is still in its channels |
| A session is missing from the Home tab | The page starts on `Last 48 hours`: choose `Any time`. A thread whose root message was deleted, and a channel the bot is no longer in, are left out |

## Reference

Detail that the install sequence links to, kept out of its way.

### The config directory and `state.json`

| File | Written by | Holds |
|---|---|---|
| `.env` | you | the tokens and the settings of Part 2 |
| `state.json` | awaydesk | the names of the agent and the chat that wrote it; for each channel, its directory; for each of its threads, the folder it was opened in, its Claude Code session id, its bypass choice (on, off or never chosen), the effort level set with `/effort`, the status of its root message (`working` or `waiting`) and the one it ended with (`done` or `error`), the ids (`open_replies`, `requests`) of the replies and request messages still open, and one word for the kind of each request (`request_kinds`: `question`, `approval`, `setup` or `hold`), which the repair after a crash needs. Never a message's text |

`state.json` looks like this; you never need to edit it:

```json
{"version": 3, "agent": "claude", "chat": "slack", "channels": {"C0123456789": {"directory": "/home/dev/code/project", "notice_pending": false, "threads": {"1700000000.000100": {"directory": "/home/dev/code/project", "session_id": "...", "bypass": false, "effort": null, "open_replies": [], "requests": [], "request_kinds": {}, "status": null, "ended": null}}}}}
```

`state.json` belongs to the agent and the chat named in it, since a session id and a thread's name
mean nothing to another. A file of version 2 names neither; awaydesk takes it for the ones running
and writes the names, as version 3, on its next save. If you select modules other than the ones the
file names, awaydesk does not start and the message names both pairs: select the ones the file
names again, or delete the file and bind the channels again.

awaydesk keeps `state.json` clean on its own, when it starts and then every 6 hours. It
forgets a channel Slack answers `channel_not_found` about, with its threads, a thread whose first
message Slack answers `thread_not_found` about (asked only in channels Slack found in the same
pass), a thread whose Claude Code session no longer exists, and a thread that has no session and was opened more than a
day ago. Anything it cannot tell for certain stays: a rate limit, a
server error or an unreadable folder removes nothing, and neither does a thread or a channel
with a session open at that moment. When Slack finds none of the bound channels it forgets none
and says so in the log, since that is what a bot token of another workspace looks like.

A private channel the bot was removed from answers `channel_not_found` too, so it is forgotten
like a deleted one. After inviting the bot back, send `!bind` there again; `!resume` brings back
the folder's sessions, which stay on disk.

### Restarts and shutdown

On `SIGTERM` awaydesk stops starting turns and lets everything already running finish: the
turns, the background commands and agents, which end with the Claude Code process, and the turn in
which Claude reports each one. Then it exits, and `KeepAlive` starts it again. Meanwhile a new
message gets `awaydesk is restarting; send this again in a moment.`, a queued one ends with
the same request. Under that sentence the refusal lists each thread the restart still waits for,
with a link to it and what holds it there (a turn, an approval or a question waiting for you,
background tasks), so you know where to answer or send `!stop`; `!status` typed in a channel
lists that channel's threads the same way and counts those of other channels without naming
them, since its answer is a post every member of the channel reads. An approval or a question Claude asks meanwhile stays open and can be answered, so
a session that restarts the daemon can still finish its turn. The daemon's `!words` keep working:
`!stop` ends a long turn so the restart goes on. A thread left with only background tasks says so
in the line under its last message (`Restart waits for 1 shell · !stop ends it now`), since
awaydesk cannot tell whether a task such as a dev server ever ends; `!stop` there stops
them and the restart goes on. That line is no message: it does not ring, and it goes with the
restart. A restart posts nothing in a thread that has nothing running, bypass on or not, since
bypass outlives it. If Slack refuses the app that line, one message says what the restart waits
for instead. The signal does not say who sent it, and a session that sends it
has a turn running at that moment: for every session with a turn running when the signal arrives,
awaydesk waits for the turn but not for a background task the session starts after the
signal, such as a loop waiting for the new process, which could only end once this one has exited.
The shutdown ends those tasks, and the session's root shows ✅. After 29 minutes awaydesk stops waiting and ends what still
runs, whose replies say that it stopped. Sending the signal a second time stops without waiting.
`SIGINT` (Ctrl-C in a terminal) stops without waiting too, because the terminal sends it to the
Claude Code processes as well. Once it has stopped waiting, the shutdown itself goes on for as long as it completes steps (the connection, each session, the chat). If 30 seconds pass with no step
completing, for instance on a start of Claude Code that never answers, the daemon ends the process
with exit status 1 and `KeepAlive` starts a new one. The next start's repair ends the replies the
stop left open; the note that lists the messages that were not sent is not written.

How long a turn can take to finish depends on who sends the signal. `launchctl kill TERM` only
sends it, so a restart waits up to those 29 minutes. `launchctl bootout` and `launchctl
kickstart -k` stop the job themselves and kill it `ExitTimeOut` seconds later; on macOS 27.0
launchd caps `ExitTimeOut` at 60 (`launchctl print` shows 60 for any larger value, and a job
stopped with `bootout` was killed within 60 seconds, measured 2026-09-26). A turn still running
then leaves its reply's stream open until Slack closes it, 5 minutes after it started.

`launchctl kill TERM` returns at once, so a Claude Code session running from Slack can restart
the daemon that hosts it and still finish its turn. `launchctl kickstart -k` waits until the old
instance has exited, which from such a session means waiting on its own turn, until launchd
kills the daemon and that turn with it after `ExitTimeOut`.

### Slack scopes and what fails without one

The manifest asks for private channels only (`groups:history`, `groups:read`,
`message.groups`), `chat:write`, `files:read` to download the files you attach to a message,
`files:write` for `!open`, which shares a file of the session's folder into its thread, and
`reactions:write` for the status reaction on a session's root message. It subscribes to one more
event, `file_change`, which is how the app learns that Slack has written the transcript of an
audio clip you sent; reading it needs `files:read` and no scope of its own. It also switches on the
app's **Home** tab, where awaydesk keeps the list of your sessions; publishing it needs no
scope and no event.
The app registers no slash command: commands are typed as `!word` messages. Socket Mode is on,
so the app needs no public URL and your machine opens no inbound port.

If the bot token lacks `files:read`, `files:write` or `reactions:write`, add the missing bot
scope on the app's **OAuth & Permissions** page, then reinstall the app to the workspace. Without
`files:read`, every attached file is refused with `HTTP 302`; without `files:write`, `!open`
answers that it needs the scope; without `reactions:write`, the status reaction is silently
skipped (logged, never surfaced). The modal of `!open` needs nothing more in the manifest: its
clicks, typed characters and submit arrive as interactivity events over the same Socket Mode
connection as the other buttons.

An audio clip needs the `file_change` event among the app's bot events. An app created from an
earlier manifest lacks it: add `file_change` under **Event Subscriptions**, **Subscribe to bot
events**, and save. Without it a clip waits 5 minutes and is dropped, since nothing tells the
app that its transcript is ready.

The line under a thread (`Working…`) is Slack's thread status
(`assistant.threads.setStatus`), which Slack's reference lists under `chat:write`. When Slack
refuses it, the refusal is logged and the line is skipped.

### What a session takes from Claude Code

The models a new thread offers are the ones Claude Code lists, older versions included. To offer
fewer, set Claude Code's `modelPicker` with `replaceBuiltInOptions: true` in
`~/.claude/settings.json` (Claude Code reads it only from user or managed settings); it changes
the terminal's `/model` picker the same way. Rows naming an alias (`opus`, `sonnet`, `haiku`)
follow the newest version of that model.

When Claude Code is logged out, a message in Slack replies with a note asking you to run `claude`
and `/login` on the machine; the login is never done from Slack. `!login` and `!logout` typed in
Slack get the same pointer to the machine and are never sent to Claude Code.

If you turn on Claude Code's Bash sandbox, do it in your own settings, where it applies to the
terminal and to Slack alike. Its auto-allow mode runs sandboxed Bash commands without asking,
so they would not reach Slack for approval.

The MCP servers you set up in Claude Code are available to a session started from Slack. A
server that needs you to sign in is signed in on the machine: run `claude mcp login <name>`, or
`/mcp` in the terminal. Computer use, and the commands Claude Code keeps for its interactive
terminal, are not available from Slack: [limits.md](limits.md) lists what differs from the
terminal and whose limit each is. Commands, scripts and command-line tools run from Slack as
they do in the terminal.

Claude Code's [Chrome integration](https://code.claude.com/docs/en/chrome) follows your choice in
Claude Code. When `/chrome` shows **Enabled by default: Yes** in the terminal, a session started
from Slack has the browser tools too, and Claude opens its tabs in the Chrome running on the
machine, with your sign-ins. Nothing about it is set in awaydesk: turn it on or off with
`/chrome` in the terminal, and a thread follows the change from its next start or resume. The
permissions are Claude Code's own: when it asks before a browser action, the request reaches
Slack as **Approve** and **Deny** buttons, and the sites Claude may act on are the ones the
extension allows. Chrome has to be open, with the extension signed in to the account Claude Code
uses.

### How trust applies to git

A worktree is covered by its main checkout while git registers it there: after moving a
worktree's folder by hand, run `git worktree repair` in it. The footer and `!status` show the
branch and the uncommitted lines, and `!open` lists the changed files, only where git may run: in
a repository you trusted in Claude Code. A trusted folder does not stand for a repository inside
it. A bound folder that is not a repository itself and holds one a level or two below it shows
them for that repository once you open `claude` in it and accept the trust dialog. Without that
trust the footer leaves the branch and the lines out, `!open` lists no changed files there, and
its search reads that repository from disk, the files its `.gitignore` names included.

### Upgrading from one session per channel

A channel bound by a version that held one session per channel keeps its directory, loses its old
session pointer and bypass switch, and gets this message once, posted top-level, not as a reply:

> awaydesk now runs one Claude Code session per thread. Send a new message in the channel
> to start a session; reply in its thread to continue it. The session this channel had is still
> in the folder: !resume brings it into a thread. Bypass is now set per session: send !bypass on
> inside a thread.

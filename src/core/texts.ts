/** Every sentence the owner can read in the chat. English only; one place to review the wording. */
import type { AgentBackend } from "../agent/seam.ts";
import type { ChatProvider } from "../chat/seam.ts";

/**
 * Fills a template's `{name}` fields: every template below keeps its `{name}` fields as written,
 * and a caller fills one with this. A field without a value throws.
 */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_field, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for the field {${name}}`);
    return String(value);
  });
}

/** The names a text takes from the agent and the chat the daemon runs with. */
export interface Names {
  /** The agent's name (`AgentBackend.name`). */
  readonly agent: string;
  /** Who writes the agent's replies (`AgentWords.author`). */
  readonly author: string;
  /** The command that opens the agent on the host (`AgentWords.command`). */
  readonly cli: string;
  /** The chat's name (`ChatProvider.name`). */
  readonly chat: string;
  /** Two of the agent's commands as the owner types them (`AgentWords.examples`). */
  readonly examples: string;
  /** The agent's commands that start a new session (`AgentWords.newSession`). */
  readonly newSession: readonly string[];
  /** The agent's command that logs in on the host (`AgentWords.login`); null when none. */
  readonly login: string | null;
  /** The agent's command that logs out on the host (`AgentWords.logout`); null when none. */
  readonly logout: string | null;
}

/**
 * A template that names the agent or the chat, with the fields `{agent}`, `{author}`, `{cli}`,
 * `{chat}`, `{examples}`, `{login}` and `{logout}`. It is no string, and it throws where one is
 * made of it: nothing can show it before `named` filled the names in.
 */
export class Named {
  readonly template: string;

  constructor(template: string) {
    this.template = template;
    Object.freeze(this);
  }

  toString(): never {
    throw new Error("a text that names the agent or the chat was shown before `named` filled it");
  }
}

function naming(template: string): Named {
  return new Named(template);
}

/**
 * `text` with the names filled in; its other `{name}` fields are left for `fill`. A text that
 * takes `{login}` or `{logout}` is never shown for an agent that has no such command: it throws.
 */
export function named(text: Named, names: Names): string {
  return text.template.replace(
    /\{(agent|author|cli|chat|examples|login|logout)\}/g,
    (_field, name: "agent" | "author" | "cli" | "chat" | "examples" | "login" | "logout") => {
      const value = names[name];
      if (value === null) throw new Error(`no name for the field {${name}}`);
      return value;
    },
  );
}

/** The names of an agent and a chat, as the two modules give them. */
export function namesOf(
  agent: Pick<AgentBackend, "name" | "words">,
  chat: Pick<ChatProvider, "name">,
): Names {
  return {
    agent: agent.name,
    author: agent.words.author,
    cli: agent.words.command,
    chat: chat.name,
    examples: agent.words.examples,
    newSession: agent.words.newSession,
    login: agent.words.login,
    logout: agent.words.logout,
  };
}

export const UNBOUND = naming(
  "This channel is not bound to a folder yet. Send `!bind` to choose one of the folders " +
    "{agent} trusts, or `!bind <folder>` with the folder's path relative to `{root}`, for " +
    "example `!bind my-project`. `!guide` explains how awaydesk works.",
);
// The same notice for an agent that keeps no record of trust: every folder under the root is offered.
export const UNBOUND_ANY =
  "This channel is not bound to a folder yet. Send `!bind` to choose one of the folders " +
  "under `{root}`, or `!bind <folder>` with the folder's path relative to `{root}`, for " +
  "example `!bind my-project`. `!guide` explains how awaydesk works.";
export const AUTH_FAILED = naming(
  "{agent} is not logged in on the host. On that machine, run `{cli}`, then `/{login}`. " +
    "The login is never done from {chat}.",
);
// The same for an agent with no command of its own that logs in.
export const AUTH_FAILED_NO_LOGIN = naming(
  "{agent} is not logged in on the host. Log in on that machine. " +
    "The login is never done from {chat}.",
);
export const LOGIN_ON_HOST = naming(
  "Log in on the host: on that machine, run `{cli}`, then `/{login}`. " +
    "The login is never done from {chat}.",
);
export const LOGOUT_ON_HOST = naming(
  "Log out on the host: on that machine, run `{cli}`, then `/{logout}`. " +
    "It is never done from {chat}.",
);
export const DIRECTORY_MISSING =
  "The directory `{directory}` no longer exists. Restore it to keep using this thread, or, in " +
  "the channel, bind another folder with `!bind <path>` and send a new message to start a " +
  "session there.";
export const DIRECTORY_UNTRUSTED = naming(
  "{agent} has not been trusted in `{directory}`, so its hooks and settings would run " +
    "without asking. Open `{cli}` there in the terminal once and accept the trust dialog, then " +
    "send your message again.",
);
export const DIRECTORY_UNREADABLE =
  "macOS does not let awaydesk read `{directory}`. Grant access in System Settings, " +
  "Privacy & Security, Full Disk Access (see docs/setup.md, Part 4).";
export const SESSION_GONE = naming(
  "This thread's session no longer exists: {agent} deleted it or cannot find it. Send a " +
    "new message in the channel to start one.",
);
// Names no cause: the daemon keeps no record of a thread whose entry it dropped, so it cannot
// tell a thread that never held a session from one whose session may still be resumable.
export const NOT_A_SESSION =
  "This thread holds no session. In the channel, send a new message to start one, or " +
  "`!resume` to continue an earlier one.";
export const OPEN_TOP_LEVEL =
  "Opening a file belongs to one session: send `!open` inside its thread.";
// Shown only by a chat that cannot share a file into a thread.
export const OPEN_UNAVAILABLE = naming("{chat} cannot show a file here, so `!open` does nothing.");
export const WORD_IN_THREAD = "`!{word}` works in the channel, not inside a thread.";
// `!stop` typed in a thread that holds no session: it would have stopped the whole channel.
export const STOP_OUTSIDE_SESSION =
  "This thread holds no session. Send `!stop` in the channel to stop every session, or inside " +
  "a session's thread to stop that one.";
export const CLEAR_IN_THREAD =
  "One thread is one session: send a new message in the channel to start a new one.";
export const UPGRADE_NOTICE = naming(
  "awaydesk now runs one {agent} session per thread. Send a new message in the " +
    "channel to start a session; reply in its thread to continue it. The session this channel " +
    "had is still in the folder: !resume brings it into a thread. Bypass is now set per " +
    "session: send !bypass on inside a thread.",
);
export const ERROR_REPLY = naming("{agent} reported an error: `{error}`");
export const ENDED = "_This reply ended before an answer: {reason}._";
export const ENDED_SHUTDOWN = "awaydesk stopped";
// Crash repair (issue #19): what a reply the daemon died in the middle of ends with.
export const STOPPED_BEFORE_ANSWER = "awaydesk stopped before this answer.";
// Messages a restart or a failure dropped from the queue (S3): they get no reply of their own,
// one note names them. `{because}` is one of the two phrases below.
export const NOT_SENT_ONE = "1 message was not sent because {because}: send it again.";
export const NOT_SENT_MANY = "{count} messages were not sent because {because}: send them again.";
// Prompts Claude Code took into a running turn of its own (a report of a background task): no
// result of their own follows, so the reply of that turn says so at its end.
export const TAKEN_INTO_REPLY_ONE = naming(
  "{agent} took your message into this reply: send it again if it is not answered here.",
);
export const TAKEN_INTO_REPLY_MANY = naming(
  "{agent} took {count} messages into this reply: " +
    "send them again if they are not answered here.",
);
export const BECAUSE_RESTARTED = "awaydesk restarted";
export const BECAUSE_SHUTDOWN = "awaydesk stopped";
export const BECAUSE_STOPPED = naming("{agent} stopped");
export const ENDED_RESTARTING = "awaydesk is restarting; send your message again in a moment";
// Never shown: an idle close always finds nothing running, sent or queued to end with it.
export const ENDED_IDLE = "awaydesk closed this idle session";
export const RESTARTING = "awaydesk is restarting; send this again in a moment.";
// Under RESTARTING, and after a channel's `!status`, while a stop waits: one row per thread that
// holds it (issue #119).
export const RESTART_WAITS_FOR = "It is waiting for:";
export const RESTART_WAITS_HEADER = `awaydesk is restarting. ${RESTART_WAITS_FOR}`;
export const RESTART_WAIT_ROW = "• {channel}, {link}: {hold}";
export const RESTART_WAIT_SESSION = "Session"; // the link's label for a session with no title yet
export const RESTART_WAIT_STOP = "`!stop` in a thread ends the wait there.";
export const RESTART_WAITS_MORE = "…and {count} more.";
// In a channel's `!status`, a post every member reads: the threads of other channels are counted
// and not named.
export const RESTART_WAITS_ELSEWHERE = "{count} more in other channels.";
export const RESTART_HOLD_OWNER = "an approval or a question is waiting for you";
export const RESTART_HOLD_TURN = "a turn is running";
export const RESTART_HOLD_TASKS = "{counts} running";
// Ends by itself (`INJECTED_TURN_WAIT`): `!stop` has nothing to stop there.
export const RESTART_HOLD_REPORT = "a background task is about to report, within 30 seconds";
export const BACKGROUND_NOTICE = "_Background task update_";
export const PROMPT_IMAGE = "an image";
export const COMPACTED = "Compacted the conversation: {before} → {after} tokens.";
export const COMPACTED_PLAIN = "Compacted the conversation.";
export const NO_OUTPUT = naming("_Done. {agent} returned no text._");
export const BIND_OK =
  "Bound this channel to `{directory}`. The next message starts a new session there.";
// An old thread's session keeps the folder it was created in; `{old}` names each of them
// (comma-separated, backticked).
export const BIND_OK_ELSEWHERE =
  "Bound this channel to `{directory}`. New messages start sessions there; existing threads " +
  "keep working in {old}, where their sessions live.";
export const BIND_UNAVAILABLE =
  "Bound this channel to `{directory}`, but no session can start there yet. {reason}";
// Shown, ephemeral, before every prompt in a thread whose folder differs from the channel's.
export const OLD_THREAD_FOLDER = naming(
  "This session works in `{old}`, the folder it was created in: {agent} resumes a session " +
    "only there. New messages in the channel use `{new}`.",
);
export const BIND_OUTSIDE =
  "`{path}` is not a folder under `{root}`. Give its path relative to that folder, for " +
  "example `!bind my-project`.";
export const SESSION_CLOSED =
  "Nothing was done: this session closed while it ran (idle for a while, or the daemon " +
  "restarted). Send it again if it is still meant.";
export const BIND_LIST = naming("Folders under `{root}` that {agent} trusts:");
// The title of the list for an agent that keeps no record of trust: every folder is offered.
export const BIND_LIST_ANY = "Folders under `{root}`:";
export const BIND_EMPTY = naming(
  "No folder under `{root}` is trusted by {agent} yet. Open one in the terminal with " +
    "`{cli}` and accept the trust dialog, then send `!bind` again.",
);
export const BIND_ALREADY = "This channel is already bound to `{directory}`.";
export const BIND_BUSY =
  "Sessions are running in this channel: binding another folder now would cut their work. " +
  "Let them finish or send `!stop`, then bind again.";
export const BYPASS_TOP_LEVEL =
  "Bypass belongs to one session: send `!bypass on` inside its thread.";
// True with the setup on screen and without it (after a stop, a restart or a Cancel).
// Shown only by an agent with no mode that skips permission requests.
export const BYPASS_UNAVAILABLE = naming(
  "{agent} has no mode that runs tools without asking, so there is no bypass to switch.",
);
export const BYPASS_BEFORE_START =
  "This session has not started yet: tick Bypass in its setup and press Start. " +
  "If no setup is shown, send a message here first.";
export const BYPASS_ON_THREAD =
  "Bypass is on in this session: every tool runs without asking, until `!bypass off`. " +
  "It survives a restart.";
// Says nothing about what is asked: that is the mode the owner's own settings give.
export const BYPASS_OFF_THREAD = naming(
  "Bypass is off in this session: {agent} follows your permission settings again.",
);
export const STOPPED = "Stopped the current turn.";
// An answered question, as the terminal keeps it in the transcript.
export const ANSWERED = naming("User answered {author}'s questions:");
// Slack drops plain spaces at the start of a line; no-break spaces stay and make the indent.
export const NESTED = `${"\u00a0".repeat(4)}⎿ `;
export const STOPPED_CHANNEL = "Stopped what was running in this channel.";
// The thread's status line while a restart waits for background tasks only, and the same after
// the app's name. Never a message: it would notify and stay in the thread after the restart.
export const RESTART_WAITS = "Restart waits for {counts} · !stop ends {them} now";
export const RESTART_WAITS_STATUS = "is waiting to restart: {counts} still running";
// The same as a message, only where Slack refuses the app a thread status.
export const RESTART_WAITS_MESSAGE =
  "awaydesk is restarting once these background tasks end: {counts}. `!stop` ends them now.";
export const NOTHING_TO_STOP = "Nothing is running in this channel.";
// Both answers to `!stop` in a thread are posts that stay: an ephemeral line is gone on reload.
export const STOPPED_THREAD = "Stopped.";
export const NOTHING_TO_STOP_THREAD = "Nothing is running in this session.";
// The same-folder hold: two sessions in one folder at once.
export const HOLD_QUESTION = "Another session is working in this folder: {link}. Send anyway?";
export const HOLD_UNPOSTED = naming(
  "awaydesk could not show this question in {chat}, so the message was not sent. Send it again.",
);
export const HOLD_GONE =
  "This question is no longer open: it was already answered, or awaydesk restarted.";
export const NOT_SENT = "Not sent.";
// Session setup: asked once per top-level message, before the first prompt of a new session.
export const SETUP_FALLBACK = "Set up this session";
// The line that replaces the setup's controls once the owner started the session.
export const SETUP_SUMMARY = "Model: {model} · Effort: {effort} · Bypass: {bypass}";
export const SETUP_EFFORT_DEFAULT = "Default";
export const STATUS = "Directory: `{directory}`\nSession: `{session}`";
export const STATUS_STATE = naming("Mode: `{mode}`\n{agent}: `{version}`\nNow: {activity}");
// The line between the two once the thread has a session id (issue #12). Claude Code leaves a
// session created through the Agent SDK out of the terminal's picker; a fork made in the
// terminal gets an id of its own and a row there (sessions reference, read 2026-10-04; the
// picker listing such a fork measured on CLI 2.1.282). `claude --resume <id>` finds a session
// from any folder since 2.1.223 (same reference): the `cd` chooses where the fork works and
// whose picker lists it. `directory` arrives quoted for the shell, and `command` as a code
// span, or escaped as plain text when it holds a backtick.
export const STATUS_TERMINAL = "Terminal: {command}";
export const ACTIVITY_IDLE = "idle";
export const VERSION_PENDING = "started, version shown after the first turn";
export const STATUS_BACKGROUND = "Background: `{counts}`";
export const STATUS_WORKING = "Working in: `{directory}`";
export const RUNNING = "⏳ {counts}";
// Slack's status line under a thread's last message (issues #83 and #295). A client shows the
// loading message: `THREAD_WORKING` while a prompt of the owner's is owed its answer.
// `STILL_RUNNING` is the terminal's words for a task that outlives its turn (`· 1 shell still
// running`, Claude Code 2.1.287, read 2026-10-02), with no hourglass: an emoji draws large and
// grey in a status line (seen on desktop, 2026-10-02). `THREAD_WORKING_STATUS` says the same
// after the app's name, which is what a client that draws `<app name> <status>` shows
// (measured 2026-10-02, desktop and iOS).
export const THREAD_WORKING = "Working…";
// The terminal's words while it compacts (`Compacting conversation`, read in the CLI 2.1.292).
export const THREAD_COMPACTING = "Compacting conversation…";
export const THREAD_COMPACTING_STATUS = "is compacting the conversation…";
export const STILL_RUNNING = "{counts} still running";
export const THREAD_WORKING_STATUS = "is working…";
export const ACTIVITY_BUSY = "running a turn, {queued} queued";
// `!status` sent to the channel (top-level, or a thread that holds no session): the channel's
// folder, then one line per live session, each with a link to its thread.
export const STATUS_CHANNEL_HEADER = "Directory: `{directory}`";
export const STATUS_CHANNEL_EMPTY = "No live session in this channel.";
export const STATUS_CHANNEL_ROW = "{link}: {activity}";
export const STATUS_CHANNEL_WAITING = "waiting for you";
export const STATUS_CHANNEL_BUSY = "busy";
export const STATUS_CHANNEL_IDLE = "idle";
// After `idle`, how long ago the session's last message was written, when that is known.
export const STATUS_CHANNEL_SINCE = " · {ago}";
export const STATUS_CHANNEL_SESSION = "Session"; // the link's label for a session with no title yet
export const STATUS_CHANNEL_BYPASS = " · ⚡ bypass";
export const STATUS_CHANNEL_FOLDER = " · folder `{directory}`";
export const STATUS_CHANNEL_LINK_FALLBACK = "thread `{thread_ts}`";
export const HELP_OWN = "**awaydesk**";
export const HELP_RULE =
  "A message that starts with `!` is a command, in code or bold too. To send it as text, put " +
  "anything before the `!`, as in `\\!goal`.";
export const HELP_WORDS: readonly Named[] = [
  "`!guide` how awaydesk works, in a few lines; in the channel or inside a thread",
  "`!help [text]` this list, or only the lines that contain the text; in the channel or " +
    "inside a thread",
  "`!status` in the channel: every session's state; inside a thread: that session's " +
    "directory, mode and the footer's values",
  "`!stop` in the channel: every running session, its background tasks and its pending " +
    "approvals; inside a thread: only that session",
  "`!bind [folder]` the folders {agent} trusts, or bind this channel to one, its path " +
    "relative to the allowed root; in the channel, refused inside a thread",
  "`!bypass on|off` run every tool without asking, until `!bypass off`; it survives a " +
    "restart; inside a thread, refused in the channel",
  "`!resume [session]` this directory's sessions, or resume one by id or name in the " +
    "thread of your `!resume` message; in the channel, refused inside a thread",
  "`!open [file]` share a file of the session's folder into the thread, where {chat} opens it in " +
    "its file viewer: a picker alone, or a path or part of a name; inside a thread, refused in " +
    "the channel",
].map(naming);
// The words for an agent that keeps no record of trust: only the `!bind` line differs.
const HELP_BIND_ANY = naming(
  "`!bind [folder]` the folders under the allowed root, or bind this channel to one, its " +
    "path relative to that root; in the channel, refused inside a thread",
);
export const HELP_WORDS_ANY: readonly Named[] = HELP_WORDS.map((word) =>
  word.template.startsWith("`!bind ") ? HELP_BIND_ANY : word,
);
export const HELP_NO_MATCH = "No command matches `{query}`.";
export const HELP_AGENT = naming(
  "\n**{agent}** (this session, now). Any other `!name args` runs that command; " +
    "these words above come first.",
);
export const HELP_UNBOUND = naming(
  "\n{agent}'s own commands are listed inside a session's thread.",
);
export const DENY_MESSAGE = naming("The owner denied this from {chat}.");
export const SKIP_MESSAGE = "The owner dismissed the question without answering.";
export const APPROVAL_UNPOSTED = naming(
  "awaydesk could not show this request in {chat}, so nobody approved it.",
);
export const APPROVAL_GONE =
  "This request is no longer pending: the turn ended or awaydesk restarted.";
export const RESUME_LIST = "Sessions in `{directory}`, newest first:";
// Shown only by an agent that keeps no list of its sessions.
export const RESUME_UNLISTED = naming(
  "{agent} keeps no list of its sessions, so `!resume` has nothing to pick from.",
);
// Two processes on one session share its file and not its conversation (measured 2026-10-03,
// issue #41, SDK 0.2.163 beside a host CLI 2.1.288 process): each keeps the session as it loaded
// it plus its own turns, and a later resume continues one of the two branches.
export const RESUME_OK =
  "Resumed **{title}**: your next message continues it. If it is open in a terminal, close it " +
  "there first: while it is open in both, neither sees the other's messages, and a later " +
  "resume keeps only one side's.";
export const RESUME_NONE =
  "No session in `{directory}` has the id or name `{target}`: `!resume` lists them.";
export const RESUME_AMBIGUOUS =
  "More than one session in `{directory}` is named or starts with `{target}`: pick one from " +
  "`!resume`.";
export const RESUME_STALE = "This list is out of date: send `!resume` again for a current one.";
export const RESUME_GONE =
  "That session is not in this channel's directory any more: `!resume` lists them.";
export const RESUME_HELD =
  "This thread already holds a session: send `!resume` again in the channel to pick another.";
// What the list is rewritten to after a Resume click, only when it cannot be deleted.
export const RESUME_LISTED = "Resumed {title} in {link}.";
// A session held by any thread of any channel is never resumed a second time; `{link}` is the
// holding thread's permalink (a plain fallback when Slack would not give one).
export const RESUME_ELSEWHERE = "This session is already open in another thread: {link}.";
// `!guide`: how to use the bot, in the owner's words, as parts that `src/core/guide.ts` chooses
// among and joins: a part appears only when the agent and the chat serve what it describes.
// `test/core/commands.test.ts` fails when a word of the daemon is missing from the whole; keep
// the tone plain and every line true of the current behaviour.
export const GUIDE_INTRO = naming(
  "**awaydesk**\n" +
    "This channel runs {agent} on your Mac, in one folder, and answers you alone. One {chat} " +
    "thread is one {agent} session: a top-level message starts a new one, and a reply inside its " +
    "thread continues it, even days later.",
);
export const GUIDE_START = "**Get started**";
export const GUIDE_BIND_TRUSTED = naming(
  "1. `!bind` lists the folders {agent} trusts, with a Bind button each; `!bind <folder>` " +
    "binds one by its path relative to your allowed root: `!bind my-project`. {agent} must trust " +
    "that folder first: open `{cli}` there once in the terminal and accept. `!bind` works only as a " +
    "top-level message in the channel.",
);
export const GUIDE_BIND_ANY =
  "1. `!bind` lists the folders under your allowed root, with a Bind button each; " +
  "`!bind <folder>` binds one by its path relative to your allowed root: `!bind my-project`. " +
  "`!bind` works only as a top-level message in the channel.";
export const GUIDE_FIRST_MESSAGE = naming(
  "2. Write a message in the channel: it opens a session, and its reply appears in a thread of its " +
    "own, growing as {author} works, with a line for each tool it uses. Reply inside that thread to " +
    "continue the same session. Attach images or files to a message: {author} sees a JPEG, PNG, GIF or " +
    "WebP image directly (other image types are refused) and reads a text, code, PDF, JSON, XML, YAML " +
    "or notebook file from a copy saved on this Mac; other files are refused.",
);
// Step 3 holds what the setup asks for; `{choices}` is the items on offer, joined as a list.
export const GUIDE_SETUP =
  "3. Before that first message is sent, the thread asks for {choices}; **Start** sends your " +
  "message with those choices, and `!stop` cancels it instead.";
export const GUIDE_SETUP_MODEL = "the **Model**";
export const GUIDE_SETUP_EFFORT = naming("the **Effort** (`Default` leaves {agent}'s own choice)");
export const GUIDE_SETUP_BYPASS = "**Bypass permissions**";
export const GUIDE_COMMANDS = naming(
  "**Commands**\n" +
    "{agent}'s commands start with `!` instead of `/`: {examples}. They run inside " +
    "a session's thread, where `!help` lists every command that session offers, and `!help <text>` " +
    "filters the list; typed in the channel, `!help` lists awaydesk's own words instead.",
);
// Joined to the guide's commands section, with `{names}` the agent's new-session commands.
export const GUIDE_NEW_SESSION =
  "{names} is refused inside a thread (one thread is one session): start a " +
  "fresh session with a new top-level message instead.";
export const GUIDE_APPROVALS = "**Approvals**";
export const GUIDE_APPROVALS_AND_QUESTIONS = "**Approvals and questions**";
export const GUIDE_PERMISSION = naming(
  "When {agent} asks permission, the request shows what will run, with **Approve** and " +
    "**Deny**; a very long one shows its start and its end and says how much it leaves out.",
);
export const GUIDE_QUESTION = naming(
  "A question from {author} comes with **Answer**, which opens a short form, and **Skip**.",
);
// The Sessions section, sentence by sentence: `guide.ts` leaves out the tasks and the resume ones.
export const GUIDE_SESSIONS_STATUS =
  "**Sessions**\n" +
  "`!status` typed in the channel lists the folder and every session still live, each linked to " +
  "its thread; inside a thread it shows that session's directory, mode and the footer's values. " +
  "`!stop` typed in the channel stops every running session";
export const GUIDE_SESSIONS_TASKS = " and its background tasks";
export const GUIDE_SESSIONS_STOP = "; inside a thread it stops only that one.";
export const GUIDE_SESSIONS_RESUME =
  "`!resume`, typed in the channel only, lists this folder's twenty " +
  "newest sessions, from the terminal too, each with the start of its id and a **Resume** button; " +
  "`!resume <id>` (that start is enough), or `!resume <title>` for a session that has one, resumes " +
  "it in the thread of your `!resume` message.";
export const GUIDE_SESSIONS_TERMINAL =
  "To continue a session in the terminal, run the `Terminal:` command `!status` shows in its thread.";
export const GUIDE_FILES = naming(
  "**Files**\n" +
    "`!open`, sent inside a session's thread, offers the files changed in that session and a search " +
    "over the folder's files; choosing one shares it into the thread, where {chat} opens it in its " +
    "file viewer, with Markdown rendered. `!open <path>` opens that file, and `!open <words>` the file " +
    "whose path contains them, or lists the files that do. The search reads the folder from disk and " +
    "leaves out what `.gitignore` excludes inside a git repository. A file over 1 MB is not opened.",
);
export const GUIDE_BYPASS = naming(
  "**Bypass**\n" +
    "`!bypass on`, sent inside a session's thread, lets {agent} run every tool without asking in " +
    "that session, until `!bypass off`; a restart of awaydesk keeps it. The footer shows ⚡ " +
    "bypass while it is on.",
);
export const GUIDE_END = "`!guide` shows this text again.";

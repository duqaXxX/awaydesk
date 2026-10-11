/**
 * The Slack provider's own words: what its controls, its forms, its Home tab and its file viewer
 * say, and why it refuses a channel, a file or a clip. English only. The sentences every chat
 * shows are the core's (`texts` of the port).
 */
import { Named } from "../../core/port.ts";

function naming(template: string): Named {
  return new Named(template);
}

export const CHANNEL_REFUSED =
  "awaydesk does not work in this channel: {reason}. It answers only in a private " +
  "channel whose only members are you and the bot.";
export const REASON_NOT_PRIVATE = "it is not a private channel";
export const REASON_SHARED = "it is shared with another workspace";
export const REASON_MEMBERS = "it has members other than you and the bot";
export const REASON_UNREADABLE = "the bot cannot read its details";
export const OPEN_FALLBACK = "Open a file";
export const OPEN_TITLE = "*Open a file*";
export const OPEN_BUTTON = "Choose a file";
export const OPEN_BY_NAME = "Or type `!open setup` to open a file by name.";
export const OPEN_NO_MATCH = "No file matches `{words}`.";
export const OPEN_NO_MATCH_PARTIAL =
  "No file matching `{words}` was found, but the folder could not be listed in full.";
export const OPEN_MATCHES = "*{count} files match* `{words}`";
export const OPEN_MATCHES_ONE = "*1 file matches* `{words}`";
export const OPEN_PARTIAL =
  "The folder could not be listed in full, so some files may be missing here.";
export const OPEN_MATCHES_CAPPED =
  "The first {shown} of {count} are listed: type more of the name to narrow it.";
export const OPEN_MATCHES_TOO_LONG =
  "None of their paths is short enough to list: open one with `!open <path>`.";
export const OPEN_MODAL_TITLE = "Open a file";
export const OPEN_MODAL_SUBMIT = "Open";
export const OPEN_MODAL_CLOSE = "Close";
export const OPEN_QUERY_LABEL = "Search any file";
export const OPEN_QUERY_HINT = "Type part of a name";
export const OPEN_ROWS_CHANGED = "Changed in this session ({count}), newest first";
export const OPEN_ROWS_MATCH = "{count} files match";
export const OPEN_ROWS_MATCH_ONE = "1 file matches";
export const OPEN_TYPE_A_NAME = "No changed files to show. Type part of a name to find a file.";
export const OPEN_LOADING = "Looking for files…";
export const OPEN_NONE_CHOSEN = "Choose a file first.";
export const OPEN_FORM_NOT_OPENED =
  "The file list could not open (`{error}`). Click Choose a file again.";
export const OPEN_NOT_A_FILE = "`{path}` is not a file inside this session's folder.";
export const OPEN_TOO_LARGE = naming(
  "`{path}` is larger than 1 MB, the most {chat} opens in its file viewer.",
);
export const OPEN_EMPTY = "`{path}` is empty: there is nothing to show.";
export const OPEN_NO_SCOPE =
  "Opening a file needs the `files:write` scope: add it to the app and reinstall it from " +
  "`slack-app-manifest.json` (docs/setup.md, Part 1).";
export const OPEN_FAILED = "Could not open `{path}`: {error}";
export const UPLOAD_FAILED = naming(
  "Nothing was sent to {author}: {name} {reason}. Send the message again without it.",
);
// An audio clip waits for the transcript only the owner can ask Slack for (`voice.ts`).
export const CLIP_WAITING = naming(
  "Waiting for this clip's transcript: choose `Generate transcript` on the clip, and its text " +
    "is sent to {author}.",
);
export const CLIP_NOT_SENT = naming(
  "Nothing was sent to {author}: this clip had no transcript after {minutes} minutes. Send it " +
    "again, or type the message.",
);
export const CLIP_NOT_YOURS = naming(
  "Nothing was sent to {author}: this audio is a file somebody else uploaded.",
);
export const CLIP_EMPTY = naming(
  "Nothing was sent to {author}: {chat}'s transcript of this clip is empty.",
);
export const CLIP_UNREADABLE = naming(
  "Nothing was sent to {author}: the transcript of this clip could not be read ({reason}).",
);
export const UPLOAD_IMAGE_TYPE = naming(
  "is an image of type `{mimetype}`, and {author} reads only JPEG, PNG, GIF and WebP images",
);
export const UPLOAD_IMAGE_SIZE = naming(
  "is {size}, over the {limit} {author} accepts for an image",
);
export const UPLOAD_IMAGE_SIDE = naming(
  "is {width}x{height} px, over the 8000x8000 px {author} accepts for an image",
);
export const UPLOAD_FILE_TYPE =
  "is a `{mimetype}` file, and awaydesk passes on only text, source code, PDF, JSON, " +
  "XML, YAML and notebook files";
export const UPLOAD_FILE_SIZE = "is {size}, over the {limit} limit for a file";
export const UPLOAD_TOO_MANY = naming(
  "Nothing was sent to {author}: the message has {count} images, over the {limit} one message " +
    "takes.",
);
export const UPLOAD_TOO_HEAVY = naming(
  "Nothing was sent to {author}: its images total {size}, over the {limit} one message takes.",
);
export const UPLOAD_NOT_SHARED = "is not a file shared in this channel that awaydesk can download";
export const UPLOAD_DOWNLOAD = "could not be downloaded ({error})";
export const BIND_MORE = "Only the first {rows} are shown: `!bind <folder>` binds any other.";
export const BIND_CURRENT = " · _current_";
export const BIND_BUTTON = "Bind";
// The words of the question itself, and close in length: Slack sizes a button by its text, so
// `Continue` beside `Cancel` made the second look the lesser choice (issue #76).
export const HOLD_CONTINUE_BUTTON = "Send anyway";
export const HOLD_CANCEL_BUTTON = "Don't send";
export const SETUP_HEADER = "*Choose how this session starts*";
export const SETUP_EFFORT_OPTION = "Effort: {level}";
export const SETUP_EFFORT_DEFAULT = "Default";
export const SETUP_BYPASS_OPTION = "Bypass permissions";
export const SETUP_BYPASS_DESCRIPTION = "Run every tool without asking, until `!bypass off`.";
export const SETUP_START_BUTTON = "Start";
export const SETUP_SUMMARY = "Model: {model} · Effort: {effort} · Bypass: {bypass}";
export const APPROVAL_PROMPT = naming("{agent} asks to use *{tool}*");
export const QUESTIONS_ONE = naming("{agent} has a question");
export const QUESTIONS_MANY = naming("{agent} has {count} questions");
export const QUESTION_ANSWER = "Answer";
export const QUESTION_TITLE = naming("{agent} asks");
export const QUESTION_CLOSE = "Later";
export const QUESTION_NOT_OPENED = "The form could not open (`{error}`). Click Answer again.";
export const QUESTION_MISSING = "Choose an option or type your own answer.";
export const QUESTION_WHERE = "{number} of {count}";
export const QUESTION_NEXT = "Next ({number}/{count})";
export const QUESTION_OTHER = "Other";
export const QUESTION_OTHER_HINT = "Or type your own answer";
export const APPROVAL_CUT =
  "_{count} characters of this request are not shown: Deny it unless you know them._";
export const RESUME_EMPTY = "No sessions in `{directory}` yet.";
// Every session of the folder is already open in a thread: the list has no row to offer.
export const RESUME_NONE_LEFT = "No session to resume in `{directory}`.";
// Under the list: the sessions a thread already holds (D6), counted and not listed (issue #69).
export const RESUME_OPEN_ONE = "1 more is open in its own thread.";
export const RESUME_OPEN_MANY = "{count} more are open in their own threads.";
export const RESUME_BUTTON = "Resume";
export const RESUME_MORE =
  "Only the newest {rows} are shown: `!resume <id>`, or `!resume <title>` for a session that " +
  "has one, resumes an older session.";
// The app's Home tab: the sessions the threads hold, by channel, newest activity first, under
// four filters. `{time}` is Slack's own date token, shown in the reader's time zone.
export const HOME_HEADER = "Sessions by channel, newest first · updated {time}";
export const HOME_EMPTY =
  "No channel is bound yet: `!bind` in a private channel binds it to a folder.";
export const HOME_NO_SESSIONS = "No sessions yet.";
export const HOME_NO_MATCH = "No session matches these filters.";
export const HOME_MORE = "Only the first {rows} sessions are shown: narrow the filters.";
export const HOME_OPEN = "Open";
export const HOME_NEW_THREAD = "New thread";
export const HOME_EDIT = "Edit";
export const HOME_DONE = "Done";
export const HOME_DELETE = "Delete";
// Bold, behind the hourglass the other two notes carry: mrkdwn has no colour, and the plain
// word was missed among the row's details.
export const HOME_DELETING = ":hourglass_flowing_sand: *deleting…*";
export const HOME_CHANNEL_DELETING_ONE = ":hourglass_flowing_sand: deleting 1 thread…";
export const HOME_CHANNEL_DELETING_MANY = ":hourglass_flowing_sand: deleting {count} threads…";
export const HOME_DELETING_ONE = naming(
  ":hourglass_flowing_sand: *Deleting 1 thread.* {chat} limits how fast messages are deleted: " +
    "a thread takes about a minute, and leaves this page when it is gone.",
);
export const HOME_DELETING_MANY = naming(
  ":hourglass_flowing_sand: *Deleting {count} threads, one at a time.* {chat} limits how fast " +
    "messages are deleted: each takes about a minute, and leaves this page when it is gone.",
);
export const HOME_DELETE_TITLE = "Delete this thread?";
export const HOME_DELETE_NAMED = "“{title}” in #{channel}, {replies}. ";
export const HOME_DELETE_NAMED_BARE = "“{title}” in #{channel}. ";
export const HOME_DELETE_TEXT = naming(
  "Every message of the thread is deleted from {chat}, yours and the bot's. This cannot be " +
    "undone. The session stays in {agent} and can be resumed with !resume. Deleting takes " +
    "about a minute.",
);
export const HOME_DELETE_CONFIRM = "Delete thread";
export const HOME_DELETE_DENY = "Cancel";
export const HOME_CLEAN = "Clean up";
export const HOME_CLEAN_TITLE = "Clean up this channel?";
export const HOME_CLEAN_TEXT =
  "Deletes from #{channel} what sits outside a thread: your messages there that have no " +
  "reply, commands like !stop included, and the bot's own messages. Every thread that has a " +
  "reply stays. This cannot be undone and can take a few minutes.";
export const HOME_CLEAN_CONFIRM = "Clean up";
export const HOME_CHANNEL_CLEANING = ":hourglass_flowing_sand: cleaning up…";
export const HOME_CLEANING_ONE = naming(
  ":hourglass_flowing_sand: *Cleaning up 1 channel.* {chat} limits how fast messages are " +
    "deleted: this can take a few minutes.",
);
export const HOME_CLEANING_MANY = naming(
  ":hourglass_flowing_sand: *Cleaning up {count} channels, one at a time.* {chat} limits how " +
    "fast messages are deleted: this can take a few minutes.",
);
export const HOME_CLEAN_FAILED =
  "Could not clean up that channel (`{error}`). Clean it up again to continue.";
export const HOME_DELETE_REFUSED = naming(
  "{chat} refused to delete {count} of that thread's messages (`cant_delete_message`): they " +
    "are not yours or the bot's, or your workspace does not let you delete them. Every other " +
    "message is gone and the thread is still listed.",
);
export const HOME_CLEAN_REFUSED = naming(
  "{chat} refused to delete {count} of that channel's messages (`cant_delete_message`): your " +
    "workspace does not let you delete them. Every other one is gone.",
);
export const HOME_DELETE_BUSY = "Not deleted: that thread is working or waiting for you.";
export const HOME_DELETE_FAILED =
  "Could not delete every message of that thread (`{error}`). Delete it again to continue.";
export const HOME_SHOW_ALL = "Show all {count}";
export const HOME_UNTITLED = "Session {id}";
export const HOME_REPLY = "1 reply";
export const HOME_REPLIES = "{count} replies";
export const HOME_LAST_REPLY = "last reply {when}";
export const HOME_STARTED = "started {when}";
export const HOME_WORKING = "working";
export const HOME_WAITING = "waiting for you";
export const HOME_ENDED = "ended";
export const HOME_ERROR = "error";
export const HOME_ALL_CHANNELS = "All channels";
export const HOME_ALL_STATUSES = "All statuses";
export const HOME_ANY_TIME = "Any time";
export const HOME_LAST_48 = "Last 48 hours";
export const HOME_TODAY = "Today";
export const HOME_YESTERDAY = "Yesterday";
export const HOME_LAST_7 = "Last 7 days";
export const HOME_LAST_30 = "Last 30 days";
export const HOME_SEARCH_LABEL = "Search titles";
export const HOME_SEARCH_HINT = "Type a word and press Enter";

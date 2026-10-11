/**
 * The chat seam: what the core writes in a chat and a provider draws, and what a provider tells
 * the core of what the owner did. No type of a chat library appears here.
 *
 * Outbound, the core calls a provider: the reply model (`ReplySink`, `TaskUpdate`, the footer's
 * fields), what a session does to its thread outside a reply (`ThreadChat`), what is said in a
 * channel outside any thread (`ChannelChat`), and the provider itself (`ChatProvider`: its name,
 * what it supports, its start and stop). Inbound, a provider calls the core (`ChatInbound`): a
 * message, the answer to a request, a pick from a list. The core decides what is asked, which
 * choices exist and what follows; a provider decides how each is drawn, and checks that it was
 * the owner before anything reaches the core.
 *
 * The one value declared here is `ChatError`, which names a failed call for the core's log.
 */
import type {
  ListedSession,
  ModelInfo,
  PermissionRequest,
  PromptContent,
  Question,
  QuestionRequest,
  UsageLimit,
} from "../agent/seam.ts";

export type { UsageLimit } from "../agent/seam.ts";

/**
 * A thread, by the two names its chat gives it. Only the provider that made them can read
 * them: the core stores them, compares them and hands them back.
 */
export interface ThreadRef {
  readonly channel: string;
  readonly thread: string;
}

export type TaskStatus = "pending" | "in_progress" | "complete" | "error";

/** The terminal's own view of a finished call. */
export interface Preview {
  /** `Update(notes.txt)` */
  readonly title: string;
  /** `Added 1 line, removed 1 line` */
  readonly summary: string;
  /** Numbered lines, as the terminal prints them. */
  readonly body: string;
  /** `diff` for a diff, which a provider may colour. */
  readonly language: "" | "diff";
  /** The body is lines of words, shown as written and in no code block. */
  readonly plain: boolean;
}

/** One line of a reply: a tool call, or a subagent's or a background command's task. */
export interface TaskUpdate {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly details: string | null;
  readonly output: string | null;
  /** The tool's name, which chooses its preview. */
  readonly name: string;
  /** A subagent's or a background command's line. */
  readonly task: boolean;
  /** Calls made inside it (a subagent's), counted in its title. */
  readonly calls: number;
  readonly preview: Preview | null;
  /**
   * On a line of a run of calls: what replaces it once the reply's body has ended; empty
   * removes it. Null on any other line, which stays.
   */
  readonly folded: string | null;
}

/** The footer as fields. A provider formats them in its own markup. */
export interface FooterFields {
  readonly bypass: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  /** The folder the thread was opened in. */
  readonly folder: string | null;
  readonly branch: string | null;
  /** Lines inserted and deleted since the last commit. */
  readonly changes: readonly [inserted: number, deleted: number] | null;
  readonly sessionTokens: number | null;
  readonly contextPercent: number | null;
  readonly sessionLimit: UsageLimit | null;
  readonly weekLimit: UsageLimit | null;
}

/**
 * One reply in a thread, as the core writes it. A write that has begun always runs to its end:
 * a `signal` only releases the caller, who stops waiting for it.
 */
export interface ReplySink {
  text(
    markdown: string,
    options?: { readonly notice?: boolean; readonly ending?: boolean },
  ): Promise<void>;
  task(update: TaskUpdate): Promise<void>;
  /** The reply's body has ended; `closing` are the lines still open, closed. */
  finish(closing: readonly TaskUpdate[], signal?: AbortSignal): Promise<void>;
  /** Ends the reply, with its footer when the turn has one. False when the end did not land. */
  closeOut(footer: FooterFields | null, signal?: AbortSignal): Promise<boolean>;
  waitLanded(signal?: AbortSignal): Promise<boolean>;
  settle(signal?: AbortSignal): Promise<boolean>;
}

/**
 * What differs between chats and the core adapts to. A capability is here because the core
 * reads it: without one the feature it names is not offered, and the core never calls what
 * serves it. Every chat receives a message, writes a reply it can edit, and puts a request or
 * a form to the owner: those need none.
 */
export interface ChatCapabilities {
  /** A reply's text is shown as it is written; without it the core hands over each text whole. */
  readonly nativeStreaming: boolean;
  /** `ThreadChat.showStatus`, `clearStatus`, `settleStatus` and `acknowledge`. */
  readonly reactions: boolean;
  /** `ThreadChat.showActivity`. */
  readonly activityLine: boolean;
  /** `ChatProvider.index`. */
  readonly homeIndex: boolean;
  /** `ChatProvider.openFile`. */
  readonly fileUpload: boolean;
  /** A line only the owner sees; without it `ThreadChat.tell` and `say` post in the thread. */
  readonly ownerOnlyNotices: boolean;
}

/**
 * A call the chat refused or could not take. `name` is the provider's code for the failure
 * (`channel_not_found`), or the error's own name: all a log line may say of it, never content.
 */
export class ChatError extends Error {
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = code;
  }
}

/** A message of the chat, by the id its provider gives it. The core stores it and hands it back. */
export type MessageId = string;

/** What the root of a thread shows of its session. */
export type SessionStatus = "working" | "waiting" | "done" | "error";

/**
 * One reply as a session holds it: the reply model, and its place in the thread. Only the
 * thread's latest reply says what still runs, at its end.
 */
export interface Reply extends ReplySink {
  /**
   * What still runs in the thread (`⏳ 1 shell · 1 agent`), shown after the footer; empty
   * removes it. Takes effect at once and is written with the reply's next write.
   */
  setRunning(counts: string): void;
  /** Whether this is the thread's latest reply: an older one drops the counts, keeps its footer. */
  setLatest(latest: boolean): void;
  /**
   * Whether the reply's end has landed in the chat: its footer is then what says the running
   * counts, and the thread's activity line does not repeat them.
   */
  readonly footerShown: boolean;
}

/**
 * Called when the message a crash would leave unfinished changes: `(old, fresh)` is one reply's
 * own transition, add `fresh` or drop `old`. Synchronous; a throw is the provider's to log.
 */
export type OpenMessageChange = (old: MessageId | null, fresh: MessageId | null) => void;

/**
 * One thread, as its session uses it. A call that has begun always runs to its end: a `signal`
 * only releases the caller. Unless it says otherwise a member never rejects: the provider logs
 * a failure (ids and codes only) and goes on, since the chat must never stop a turn.
 */
export interface ThreadChat {
  /**
   * A new reply in the thread. It writes nothing until it is given something to show.
   * `onOpenMessage` is told which of its messages a crash would leave unfinished.
   */
  openReply(onOpenMessage: OpenMessageChange): Reply;
  /**
   * Shows the session's status on the thread's root. Changes are made in the order asked; with
   * a `signal`, rejects with its reason when it aborts, and the change may be left half made.
   */
  showStatus(status: SessionStatus, signal?: AbortSignal): Promise<void>;
  /** Leaves the root with no status of this session. */
  clearStatus(): Promise<void>;
  /** Brings the root to the status asked for last: for whoever aborted a change on its way. */
  settleStatus(): Promise<void>;
  /**
   * What the thread says is going on under its last message, from now on; empty for nothing.
   * `afterName` says the same after the app's name, for a client that draws it that way.
   * Never waits on the chat.
   */
  showActivity(text: string, afterName: string): void;
  /** Whether the chat refuses this app an activity line for good: the session then posts. */
  readonly activityRefused: boolean;
  /** Something of the app's was posted in the thread outside this object. */
  written(): void;
  /**
   * A line of the daemon's own, small and grey, as a message of its own. `text` is plain: the
   * provider shows it as written, whatever marks it holds.
   */
  notice(text: string): Promise<void>;
  /**
   * Puts a request to the owner: a tool's permission, the agent's questions, the same-folder
   * hold or a session's setup. `requestId` is what the owner's answer comes back with
   * (`ChatInbound.answer`); `title` is the request in one line. Resolves with the message that
   * shows it; rejects with `ChatError` when it could not be shown.
   */
  ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId>;
  /** Removes a request that was decided or is stale; one already gone counts as removed. */
  withdraw(request: MessageId): Promise<void>;
  /**
   * Rewrites an answered question into the record of its answers, with nothing left to press.
   * Rejects with `ChatError` when the chat refuses the rewrite.
   */
  keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void>;
  /**
   * Rewrites a message of the daemon's into a notice that says `text`, with nothing left to
   * press: the record of an answered setup. `text` is written for a notice (`Markup`). Rejects
   * with `ChatError` when the chat refuses.
   */
  rewrite(message: MessageId, text: string): Promise<void>;
  /**
   * A line that answers what the owner just did in the thread, for the owner alone where the
   * chat can; with `stays` a message of the thread, which is still there later. `text` is
   * written for a notice (`Markup`). Never rejects: nobody is left to tell.
   */
  tell(text: string, options?: { readonly stays?: boolean }): Promise<void>;
  /**
   * A reference the owner reads, at full size, in Markdown; a long one continues in further
   * messages. With `ownerOnly`, for the owner alone where the chat can. Rejects with
   * `ChatError` when it could not be written.
   */
  say(markdown: string, options?: { readonly ownerOnly?: boolean }): Promise<void>;
  /** Marks a message of the owner's as a word that took effect. Never rejects. */
  acknowledge(message: MessageId): Promise<void>;
  /**
   * A link to the thread labelled `label`, written for `markup`; null when the chat gives
   * none. Never rejects.
   */
  link(label: string, markup: Markup): Promise<string | null>;
  /**
   * A reply a stop left unfinished, of a daemon that is gone: ended where it stands, with
   * `note` as its last line. Never rejects; a message already gone counts as ended.
   */
  endReply(reply: MessageId, note: string): Promise<void>;
  /** The session closed: the activity line is cleared, and nothing is left running. */
  close(): Promise<void>;
}

/**
 * The two ways the daemon writes its own words: a `notice` is a small line (`ThreadChat.tell`
 * and `rewrite`, `ChannelChat.notice` and `rewrite`), a `reference` is Markdown at full size
 * (`say`). A chat may mark each up differently, so a name that goes into either is escaped for
 * it (`ChatProvider.escape`), and a link is written for it (`ThreadChat.link`).
 */
export type Markup = "notice" | "reference";

/** What the controls of a session's setup hold: a model and an effort by value, and bypass. */
export interface SetupSelection {
  readonly model: string;
  readonly effort: string;
  readonly bypass: boolean;
}

/** The same-folder hold: another session works in the folder this message would wake one in. */
export interface HoldRequest {
  readonly type: "hold";
  readonly requestId: string;
  /** The thread of the session at work. */
  readonly other: ThreadRef;
  /** A link to it for a notice (`ThreadChat.link`), or the words that stand for one. */
  readonly link: string;
}

/** A session's setup, asked before its first prompt. */
export interface SetupRequest {
  readonly type: "setup";
  readonly requestId: string;
  /** The models offered, each with the effort levels it takes; empty when the agent lists none. */
  readonly models: readonly ModelInfo[];
  /** The effort levels offered when no model is; empty when the agent has none to choose. */
  readonly efforts: readonly string[];
  /** Whether running with no permission request is offered. */
  readonly bypassOffered: boolean;
  /** What the controls show at first. */
  readonly selection: SetupSelection;
}

/** What `ThreadChat.ask` puts to the owner. */
export type OwnerRequest = PermissionRequest | QuestionRequest | HoldRequest | SetupRequest;

/** The owner's answer to a request, by the request's type. */
export type OwnerAnswer =
  | { readonly type: "permission"; readonly allow: boolean }
  /** The answer to each question by its text, or null for a skip. */
  | {
      readonly type: "question";
      readonly answers: Readonly<Record<string, string | readonly string[]>> | null;
    }
  /** Whether the held message is sent. */
  | { readonly type: "hold"; readonly send: boolean }
  /** The controls as the owner left them; the core checks them against what it offered. */
  | { readonly type: "setup"; readonly selection: SetupSelection };

/** A list a word posts in a channel, each row with a control of its own. */
export type OwnerList =
  /** `folders` under `root` a session can start in; `bound` is the channel's own, if any. */
  | {
      readonly type: "folders";
      readonly root: string;
      readonly folders: readonly string[];
      readonly bound: string | null;
    }
  /**
   * The sessions of `folder` a thread can resume, and how many more a thread already holds.
   * `thread` is where the one picked will live.
   */
  | {
      readonly type: "sessions";
      readonly folder: string;
      readonly sessions: readonly ListedSession[];
      readonly held: number;
      readonly thread: ThreadRef;
    };

/** What the owner picked from an `OwnerList`. `list` is the message that showed it. */
export type ListPick =
  | {
      readonly type: "folder";
      readonly channel: string;
      readonly path: string;
      readonly list: MessageId;
    }
  /** `thread` is the one the list named; null when the control carried none. */
  | {
      readonly type: "session";
      readonly channel: string;
      readonly sessionId: string;
      readonly thread: ThreadRef | null;
      readonly list: MessageId;
    };

/**
 * A channel outside any thread: where a word typed in the channel is answered. A member
 * rejects with `ChatError` when the chat refused, unless it says otherwise.
 */
export interface ChannelChat {
  /** A line of the daemon's own, small and grey, as a message of the channel; a notice's markup. */
  notice(text: string): Promise<void>;
  /** A reference at full size, in Markdown; a long one continues in further messages. */
  say(markdown: string): Promise<void>;
  /** Posts a list, each row with its control; `title` is the list in one line. */
  offer(list: OwnerList, title: string): Promise<void>;
  /** Removes a list that did its job. False when the chat refused and it still shows. */
  withdraw(list: MessageId): Promise<boolean>;
  /** Rewrites a list into a notice that says `text`, in a notice's markup, with nothing left to press. */
  rewrite(list: MessageId, text: string): Promise<void>;
}

/** One message of the owner's, after the provider's own checks. */
export interface InboundMessage {
  /** The thread it was written in; for a message of the channel itself, the thread it opens. */
  readonly ref: ThreadRef;
  readonly id: MessageId;
  /** Written in the channel, not inside a thread. */
  readonly topLevel: boolean;
  /** The text as the owner typed it. */
  readonly text: string;
  /** The same with the chat's formatting marks removed: where a word of the daemon is read. */
  readonly plain: string;
  /** It carries files, or was spoken: never read as a word or a command. */
  readonly literal: boolean;
  /**
   * The prompt it makes, files included, read when its turn among the thread's messages comes.
   * Null when a file could not be taken: the provider told the owner, and nothing is sent.
   */
  content(): Promise<PromptContent | null>;
}

/**
 * What a provider tells the core. Each call is made for the owner alone: a provider checks who
 * acted, on every path of its own, before it calls. No member rejects for a failure the owner
 * should read: the core tells them in the chat.
 */
export interface ChatInbound {
  message(message: InboundMessage): Promise<void>;
  /**
   * The owner answered the request `requestId`, shown by `message` in `ref`. False when the
   * request is no longer waiting there: the core told the owner so.
   */
  answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean>;
  /** The owner used a control of a list a word posted. */
  picked(pick: ListPick): Promise<void>;
}

/** Whether a chat still has a channel; `no answer` when it could not say. */
export type ChannelState = "gone" | "there" | "no answer";

/** The list of every session the chat shows on a page of its own. */
export interface SessionIndex {
  /** The sessions of `changed` are no longer as shown; with none given, any may be. Never waits. */
  refresh(changed?: Iterable<ThreadRef>): void;
}

/**
 * A chat, as the daemon drives it. `start`, `stop` and `close` are called once each, in that
 * order.
 */
export interface ChatProvider {
  /** The chat's name as the daemon's texts say it. */
  readonly name: string;
  readonly capabilities: ChatCapabilities;
  thread(ref: ThreadRef): ThreadChat;
  channel(channel: string): ChannelChat;
  /** `text` made safe to stand inside a line of `markup`, where it is shown as written. */
  escape(text: string, markup: Markup): string;
  /**
   * When the thread was opened, in seconds since the epoch, as its name alone tells; null when
   * the name tells nothing.
   */
  openedAt(ref: ThreadRef): number | null;
  channelState(channel: string): Promise<ChannelState>;
  /** Present with `homeIndex`. */
  readonly index?: SessionIndex;
  /**
   * `!open` typed in a session's thread: offers the files of `folder`, or shares the one
   * `target` names, into the thread. Present with `fileUpload`.
   */
  openFile?(ref: ThreadRef, folder: string, target: string): Promise<void>;
  /** Opens the connection: from here what the owner does reaches `inbound`. */
  start(inbound: ChatInbound): Promise<void>;
  /**
   * Closes the connection: nothing reaches the core any more, and a call already under way
   * does nothing from its next step on.
   */
  stop(): Promise<void>;
  /** After every session closed: what the chat shows of them is written one last time. */
  close(): Promise<void>;
}

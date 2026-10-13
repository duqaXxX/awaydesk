/**
 * The agent seam: what the core asks of an agent back end and what a back end tells the core.
 * No type of an agent SDK appears here. One back end exists, `agent/claude`, and it is the only
 * module that imports the SDK.
 *
 * The one value declared here is `ResumeRefused`: the core has to tell that failure of a start
 * from every other, and it may import nothing of a back end.
 */
import type { Clock } from "../clock.ts";

/**
 * The agent refused to resume the session a start named (its transcript is gone): the thread
 * that held it cannot go on. Any other failure of a start rejects with the failure itself, and
 * the thread's next message tries again.
 */
export class ResumeRefused extends Error {
  constructor(options?: ErrorOptions) {
    super("the agent could not resume the session", options);
    this.name = "ResumeRefused";
  }
}

/** A permission mode, by the name the back end gives it. */
export type PermissionMode = string;

/** The modes a back end knows, by role. A role it lacks is null. */
export interface PermissionModes {
  readonly default: PermissionMode;
  readonly auto: PermissionMode | null;
  /** The mode that skips permission requests. */
  readonly bypass: PermissionMode | null;
}

/**
 * What differs between back ends and the core adapts to. A capability is here because the core
 * reads it: without one the feature it names is not offered (`!help` and `!guide` leave it
 * out), and the core never calls what serves it. What every back end does alike needs none.
 */
export interface Capabilities {
  /**
   * The levels `StartOptions.effort` and `setEffort` take. A stored level outside them is never
   * sent: the core drops it, with a line in the log.
   */
  readonly effortLevels: readonly string[];
  /** `setEffort` changes the live session; without it the core restarts the session. */
  readonly liveEffort: boolean;
  readonly permissionModes: PermissionModes;
  /** Calls run under a call of their own (`parentCallId`), and a task can be a subagent's. */
  readonly subagents: boolean;
  /** A task outlives the turn that started it, and the agent starts a turn to report it. */
  readonly backgroundTasks: boolean;
  /** The agent compacts a conversation (`compaction_started`, `compacted`). */
  readonly compaction: boolean;
  /**
   * The agent asks the owner questions (`RequestHandler.question`). The core offers nothing of
   * its own for a question, so the only thing that reads this is `!guide`, which names the
   * answer form when it is declared.
   */
  readonly questions: boolean;
  /** `AgentBackend.usageLimits`. */
  readonly usageLimits: boolean;
  /** `AgentInfo.models` lists what `setModel` takes. */
  readonly models: boolean;
  /** `AgentInfo.commands` lists commands of the agent's own, which a prompt can run. */
  readonly commands: boolean;
  /** A prompt sent while a turn runs is taken into that turn (`prompt_taken`). */
  readonly promptDuringTurn: boolean;
  /** `listSessions`, `datedSessions` and `aliveSessions`. */
  readonly sessionListing: boolean;
  /** `folderTrusted` and `trustedRepository` read a record of trust the owner keeps in the agent. */
  readonly folderTrust: boolean;
}

/** The agent's own words, which the daemon's texts are filled with. */
export interface AgentWords {
  /** Who writes the replies, where a text names them and not the product. */
  readonly author: string;
  /** The command that opens the agent in a terminal on the host. */
  readonly command: string;
  /** Two of its commands as the owner types them in the chat, for the guide. */
  readonly examples: string;
  /**
   * The agent's command names, without the slash, that start a new session; empty when it has
   * none. One thread is one session, so the daemon refuses each of them inside a thread.
   */
  readonly newSession: readonly string[];
  /**
   * The name of the agent's own command that logs in on the host, without the slash; null when
   * it has none. The daemon answers it with where it is done and never sends it.
   */
  readonly login: string | null;
  /** The same for the command that logs out. */
  readonly logout: string | null;
  /**
   * The shell line that continues a session in a terminal; `{directory}` and `{session}` are
   * filled in, each quoted for a shell.
   */
  readonly terminal: string;
}

export type SettingsSource = "user" | "project" | "local";

export interface StartOptions {
  readonly folder: string;
  /** The session to resume, or null for a new one. */
  readonly resume: string | null;
  readonly settingsSources: readonly SettingsSource[];
  readonly model: string | null;
  readonly effort: string | null;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly mediaType: string;
  /** Base64. */
  readonly data: string;
}

/** The owner's text, or the parts of one message when it carries images. */
export type PromptContent = string | readonly (TextPart | ImagePart)[];

export interface Prompt {
  /** The prompt's own id, a UUID the core makes, which `prompt_taken` names. */
  readonly id: string;
  readonly content: PromptContent;
}

/** What the agent says of its context window; a value it does not report is null. */
export interface ContextUsage {
  readonly model: string | null;
  /** The share of the context window in use, 0 to 100. */
  readonly percentage: number | null;
}

export interface ModelInfo {
  readonly value: string;
  /** The agent's name for the model, or its value when it gives none. */
  readonly displayName: string;
  readonly description: string | null;
  readonly supportsEffort: boolean;
  readonly supportedEffortLevels: readonly string[];
}

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases: readonly string[];
}

export interface AgentInfo {
  readonly models: readonly ModelInfo[];
  readonly commands: readonly CommandInfo[];
  /** The mode the session started in, or null when the agent does not say. */
  readonly permissionMode: PermissionMode | null;
}

export interface ListedSession {
  readonly id: string;
  /** What the agent's own picker shows for the session. */
  readonly title: string;
  /** The title the owner gave it or the agent generated, which `!resume <title>` matches. */
  readonly customTitle: string | null;
  readonly branch: string | null;
  /** Bytes of the transcript. */
  readonly size: number | null;
  /** Milliseconds since the epoch. */
  readonly lastModified: number;
}

export interface DiffHunk {
  /** The number of the hunk's first line in the file as it was, and as it is now. */
  readonly oldStart: number;
  readonly newStart: number;
  /**
   * Each line with its sign as the first character: `-` removed, `+` added, a space for a
   * line that did not change, a backslash for a note about the line above.
   */
  readonly lines: readonly string[];
}

/** What a call did to a file, when the agent reports it. */
export interface FileChange {
  /** As the agent names it, absolute in the Claude back end. */
  readonly path: string;
  /** `edited` always has a hunk; `created` has the file's content. */
  readonly kind: "created" | "edited";
  readonly hunks: readonly DiffHunk[];
  /** A created file's content. */
  readonly content: string | null;
}

export type TaskKind = "subagent" | "command" | "other";
export type TurnEnding = "done" | "interrupted" | "error";

export interface ModelTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/**
 * What a back end tells the core. An event can arrive while no turn of the owner's runs:
 * `turn_ended` is an event like the others, not the answer to `send`.
 *
 * `parentCallId` names the call a subagent's event runs under, and is null at the top level. A
 * subagent's text is never an event: the three text events carry no `parentCallId`.
 * The events of one message arrive in the order the agent produced them.
 */
export type SessionEvent =
  /**
   * The agent names its session. It can come again, and the id can change (a cleared conversation).
   * An id is announced only once a `start` that resumes it would succeed: the core stores it as
   * the event arrives, and the setup's Start may start a fresh client that resumes it before any
   * prompt was sent. An agent that keeps no record until its first prompt names the session with
   * that prompt.
   */
  | {
      readonly type: "session_started";
      readonly sessionId: string | null;
      readonly agentVersion: string | null;
    }
  /** The agent starts writing a message; its texts follow as `text_started` and `text_delta`. */
  | {
      readonly type: "message_started";
      readonly parentCallId: string | null;
    }
  | {
      readonly type: "message_ended";
      readonly parentCallId: string | null;
    }
  /** A text of the message being written starts; a message can hold several. */
  | { readonly type: "text_started" }
  /** The next piece of the text being written, never empty. */
  | { readonly type: "text_delta"; readonly text: string }
  /**
   * The whole text of a message that was not written piece by piece (a command's own output),
   * trimmed and never empty. A text reaches the core once: as deltas or whole, never both.
   */
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "call_started";
      readonly callId: string;
      readonly toolName: string;
      /** The input as the agent sent it. */
      readonly input: Readonly<Record<string, unknown>>;
      readonly parentCallId: string | null;
    }
  | {
      readonly type: "call_ended";
      readonly callId: string;
      readonly isError: boolean;
      /** The result's text, as the agent wrote it; null when the result holds none. */
      readonly output: string | null;
      readonly fileChange: FileChange | null;
      readonly parentCallId: string | null;
    }
  /** A task starts: the work of a call (`callId`), or of nothing the core saw (null). */
  | {
      readonly type: "task_started";
      readonly taskId: string;
      readonly kind: TaskKind;
      /**
       * The agent's own word for the kind, as written; null when it gives none. It names the
       * task's line in the reply; the core counts and words a task by `kind`.
       */
      readonly taskType: string | null;
      readonly description: string;
      readonly callId: string | null;
      /**
       * The type of agent a subagent is, as the agent names it (`mechanical`); null for any
       * other task and when the agent gives none.
       */
      readonly agentType: string | null;
      /**
       * Whether the task started in the background, the call that started it not waiting for
       * it; null when the agent does not say.
       */
      readonly background: boolean | null;
    }
  | {
      readonly type: "task_progress";
      readonly taskId: string;
      readonly description: string;
      readonly callId: string | null;
    }
  /**
   * A task's state changed. `terminal` says the task is over; the agent's report of the end
   * (`task_ended`) may follow, come first, or never come.
   */
  | {
      readonly type: "task_updated";
      readonly taskId: string;
      readonly status: string | null;
      readonly terminal: boolean;
    }
  /** The agent reports a task's end to the conversation. */
  | {
      readonly type: "task_ended";
      readonly taskId: string;
      /**
       * `completed`, `failed`, `killed` or `stopped` in the Claude back end. Any other word
       * reads as an end with no failure and is shown as written.
       */
      readonly status: string;
      readonly summary: string;
      readonly durationMs: number | null;
      readonly callId: string | null;
    }
  /** The agent is compacting the conversation. Not repeated while it lasts. */
  | { readonly type: "compaction_started" }
  /** It no longer is. */
  | { readonly type: "compaction_ended" }
  /** The conversation continues from its summary. A count the agent does not give is null. */
  | {
      readonly type: "compacted";
      readonly tokensBefore: number | null;
      readonly tokensAfter: number | null;
    }
  | { readonly type: "mode_changed"; readonly mode: PermissionMode }
  /** The effort the agent runs at; null is its default. */
  | { readonly type: "effort_observed"; readonly level: string | null }
  | { readonly type: "folder_changed"; readonly folder: string }
  /** The cached usage limits are stale. */
  | { readonly type: "limits_changed" }
  /** The agent took a prompt the core sent: into the running turn, or as the next turn's. */
  | { readonly type: "prompt_taken"; readonly promptId: string }
  /**
   * The turn the agent is about to start by itself answers what the background task `taskId`
   * told it (a subagent handing its report back). It comes before that turn's first event,
   * whether or not the task's own end was told yet.
   */
  | { readonly type: "report_started"; readonly taskId: string }
  | {
      readonly type: "turn_ended";
      readonly sessionId: string | null;
      readonly startedBy: "owner" | "agent";
      readonly finalText: string | null;
      readonly ending: TurnEnding;
      /**
       * How many times the agent went to its model in the turn, null when it does not say. 0
       * is a turn that did nothing: no message, no call, no text.
       */
      readonly steps: number | null;
      /** By model. Empty when the turn used none (a command the agent ran itself). */
      readonly tokens: Readonly<Record<string, ModelTokens>>;
    }
  /**
   * The agent wrote a message about a failed request of its own, in place of an answer.
   * `category` is its word for the failure, as written; `text` is what the message says, which
   * can be empty.
   */
  | {
      readonly type: "agent_error";
      readonly kind: "authentication" | "other";
      readonly category: string;
      readonly text: string;
      readonly parentCallId: string | null;
    }
  /**
   * The agent's process is gone and the core did not close it. The last event of the session:
   * `events` ends after it. `reason` is shown to the owner as the error's name: the back end's
   * own words for a process that exited, or the name of the failure that ended the stream,
   * never its message. A session the core closed ends its events with no `process_lost`.
   */
  | { readonly type: "process_lost"; readonly reason: string };

export type SessionEventType = SessionEvent["type"];

export interface PermissionRequest {
  readonly type: "permission";
  readonly callId: string | null;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The agent's own sentence for the request, when it writes one. */
  readonly title: string | null;
  readonly description: string | null;
}

export type PermissionAnswer =
  | { readonly allow: true }
  | { readonly allow: false; readonly message: string };

export interface QuestionOption {
  readonly label: string;
  readonly description: string | null;
  /** What picking the option would look like, in lines of the agent's own. */
  readonly preview: string | null;
}

export interface Question {
  /** A short title, empty when the agent gives none. */
  readonly header: string;
  /** The question, which also names it in the answer. */
  readonly text: string;
  readonly multiSelect: boolean;
  readonly options: readonly QuestionOption[];
}

export interface QuestionRequest {
  readonly type: "question";
  readonly callId: string | null;
  /** The tool that asks, which names the request in one line when the agent writes no title. */
  readonly toolName: string;
  /** The agent's own sentence for the request, when it writes one. */
  readonly title: string | null;
  readonly questions: readonly Question[];
}

/**
 * The answer to each question by its text: one answer, or the several of a multi-select. Or
 * skipped, with what the agent is told.
 */
export type QuestionAnswer =
  | {
      readonly answered: true;
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
    }
  | { readonly answered: false; readonly message: string };

/**
 * Asked by a back end while a call waits; each resolves once, for as long as it takes. A request
 * still waiting when the core closes the session resolves as refused (a denial, a skip).
 *
 * `signal` is the agent's: it aborts it when it no longer waits for the answer. The core then
 * takes the request back from the owner and the promise resolves as refused, like a request
 * still waiting when the session closes. A signal already aborted when the request arrives
 * shows the owner nothing.
 */
export interface RequestHandler {
  permission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  question(request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer>;
}

/** One live session of an agent. */
export interface AgentSession {
  /** Every event of the session, in order, until the session closes or its process is lost. */
  readonly events: AsyncIterable<SessionEvent>;
  /**
   * Hands the prompt to the agent and resolves: the turn's end is the event `turn_ended`. On a
   * session that has ended it rejects, and the owner is shown the error's name.
   */
  send(prompt: Prompt): Promise<void>;
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string | null): Promise<void>;
  setEffort(level: string | null): Promise<void>;
  contextUsage(): Promise<ContextUsage>;
  info(): Promise<AgentInfo>;
  /**
   * Resolves once the agent's process has gone, so a session started right after may resume
   * the same id. Safe to call again, and on a session whose process was lost.
   */
  close(): Promise<void>;
}

/** A folder's git repository, as the filesystem shows it. */
export interface Repository {
  /** The folder that holds the `.git` entry. */
  readonly root: string;
  /** The path whose trust covers it: the main checkout for a registered worktree. */
  readonly key: string;
  /** Null when the `.git` entry names none. */
  readonly gitDir: string | null;
  /** The folder is in the root's own `.git` directory, and has no work tree. */
  readonly insideGitDir: boolean;
}

/** The limits of the owner's account; one the account does not have, or the agent hid, is null. */
export interface UsageLimits {
  readonly session: UsageLimit | null;
  readonly week: UsageLimit | null;
}

export interface UsageLimit {
  readonly percent: number;
  /** Milliseconds since the epoch. */
  readonly resetsAt: number | null;
}

export interface AgentBackend {
  /** The agent's name as the daemon's texts say it. */
  readonly name: string;
  readonly words: AgentWords;
  readonly capabilities: Capabilities;
  /**
   * Starts a session and resolves once the agent answered. Rejects with `ResumeRefused` when
   * the agent refuses `options.resume`, and with the failure itself for any other reason; no
   * process is left running either way. Whether the owner trusted the folder is the caller's
   * to check first (`folderTrusted`). What the owner set in the agent for every session it
   * starts (the Chrome integration in Claude Code) is read by the back end at each start.
   */
  start(options: StartOptions, requests: RequestHandler): Promise<AgentSession>;
  /** The sessions of `folder` alone, newest first by the time their record last changed. */
  listSessions(folder: string): Promise<readonly ListedSession[]>;
  /**
   * `sessions` of `folder` by their last message, newest first, as the agent's own picker
   * shows them; `lastModified` is then that message's time on each session that was dated.
   * Dating reads files, so a caller that shows only some of a folder's sessions passes those
   * alone.
   */
  datedSessions(folder: string, sessions: readonly ListedSession[]): Promise<ListedSession[]>;
  /** The ids of the sessions the agent still holds for `folder`; null when it cannot tell. */
  aliveSessions(folder: string): Promise<ReadonlySet<string> | null>;
  /** Whether the owner trusted `folder` in the agent, as the agent itself would decide. */
  folderTrusted(folder: string): Promise<boolean>;
  /**
   * The repository holding `folder` when the daemon's own git may run in it: one the owner
   * trusted in the agent, by itself. Null anywhere else.
   */
  trustedRepository(folder: string): Promise<Repository | null>;
  /**
   * The account's limits as the agent reports them now; it can take a while, and rejects when
   * the agent gave none. Present with `usageLimits`.
   */
  usageLimits?(): Promise<UsageLimits>;
  /** Ends what the back end keeps running besides its sessions. Safe to call again. */
  close(): Promise<void>;
}

/** What a back end is built with. */
export interface AgentContext {
  /** The module's own variables as the owner's file gives them; one not set is absent. */
  readonly variables: Readonly<Record<string, string>>;
  /** Every wait of the back end. */
  readonly clock: Clock;
}

/** One agent the daemon can drive, as the registry holds it. */
export interface AgentEntry {
  /** The variables the module reads; the daemon does not start without the `required` ones. */
  readonly required: readonly string[];
  readonly optional: readonly string[];
  build(context: AgentContext): AgentBackend;
}

/**
 * The core's port: everything of the core a chat provider may call and read. A provider imports
 * this file, the two seams and the files any layer may import, and nothing else of the core.
 *
 * `CorePort` is the core as a provider reaches it while the daemon runs. What each flow of a
 * provider may call is declared, whole, in that flow's file under `port/`; the members here are
 * those together. The rest of this file is what a provider is built with (`ChatContext`,
 * `ChatEntry`) and the core's values a provider's own code works with, exported again from
 * where they are defined.
 */
import type { AgentBackend } from "../agent/seam.ts";
import type { ChatProvider } from "../chat/seam.ts";
import type { Clock } from "../clock.ts";
import type { FilesSessions, FilesState } from "./port/file-flows.ts";
import type { HomeAgent, HomeState } from "./port/home.ts";
import type { RequestsApprovals, RequestsHolds, RequestsSessions } from "./port/requests.ts";
import type { ThreadsSessions, ThreadsState } from "./port/threads.ts";

/** The live sessions, as every flow of a provider together may reach them. */
export type SessionsPort = RequestsSessions & FilesSessions & ThreadsSessions;

/** What the daemon keeps of its channels and threads. */
export type StatePort = FilesState & ThreadsState & HomeState;

/** The requests of the agent that wait for the owner. */
export type ApprovalsPort = RequestsApprovals;

/** The questions of the daemon's own that wait for the owner. */
export type HoldsPort = RequestsHolds;

/** What a provider reads of the agent. */
export type AgentPort = HomeAgent & Pick<AgentBackend, "name" | "words">;

/** The core as a provider reaches it while the daemon runs. */
export interface CorePort {
  readonly sessions: SessionsPort;
  readonly state: StatePort;
  readonly approvals: ApprovalsPort;
  readonly holds: HoldsPort;
  readonly agent: AgentPort;
}

/** What a chat provider is built with. */
export interface ChatContext {
  /** The module's own variables as the owner's file gives them; one not set is absent. */
  readonly variables: Readonly<Record<string, string>>;
  /** The folder the owner allowed sessions under. */
  readonly allowedRoot: string;
  /** Wall time, for what is dated. */
  readonly clock: Clock;
  /** Seconds that only move forward, for what is paced. */
  readonly steady: Clock;
  /**
   * The core. It exists once the daemon has built its sessions, which is before the first call
   * it makes on the provider it built; `build` itself must not read it.
   */
  core(): CorePort;
}

/** One chat the daemon can be driven from, as the registry holds it. */
export interface ChatEntry {
  /** The variables the module reads; the daemon does not start without the `required` ones. */
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /**
   * Builds the provider and learns who it is in the chat. Rejects with `ConfigError` when a
   * variable holds what the chat refuses.
   */
  build(context: ChatContext): Promise<ChatProvider>;
}

// ---- the core's values a provider's own code works with

export type { ChannelLookup, ThreadLookup } from "./cleanup.ts";
export { ConfigError } from "./config.ts";
export { changedIn } from "./files/changed.ts";
export type { Found } from "./files/listing.ts";
export { Listings } from "./files/listing.ts";
export {
  NotAFile,
  newestFirst,
  readOpenable,
  regularFiles,
  TooLarge,
  titleOf,
} from "./files/read.ts";
export { FOLDER_ROWS } from "./folders.ts";
export type { FooterKey } from "./footer.ts";
export { footerFields } from "./footer.ts";
export { Fold, shownPreview } from "./reply/fold.ts";
export type { Tail, TailEntry } from "./reply/tail.ts";
export { isLast, isOvertaken, tails } from "./reply/tail.ts";
export { oneLine, STOPPED, TITLE_LIMIT } from "./reply/words.ts";
export { answerOf } from "./requests.ts";
export { DirectoryUnavailable, SessionClosed, SessionGone } from "./sessions/errors.ts";
export { Cancelled, cancellable, Mutex, Semaphore, Task } from "./sessions/tasks.ts";
export type { Choice } from "./setup.ts";
export { choiceOf, DEFAULT, effortLevels } from "./setup.ts";
export type { Names } from "./texts.ts";
export * as texts from "./texts.ts";
export { fill, Named, NESTED, named } from "./texts.ts";

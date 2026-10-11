/**
 * The flows as they call one another, and as `Inbound` hands a provider's calls to them. Each
 * is built by the factory of its own file (`asking`, `lists`, `messages`) over `FlowDeps`.
 */
import type {
  InboundMessage,
  ListPick,
  MessageId,
  OwnerAnswer,
  ThreadRef,
} from "../../chat/seam.ts";
import type { ThreadSession } from "../sessions/session.ts";

/** A session's setup, asked before its first prompt. */
export interface SetupFlow {
  /**
   * Asks for the model, the effort and bypass and applies the answer to the live session. The
   * session to send the message on, which can be another object than `session` when that one
   * closed meanwhile; null when the message is not sent, and the owner was told.
   */
  beforeSending(ref: ThreadRef, session: ThreadSession): Promise<ThreadSession | null>;
}

/** The same-folder hold. */
export interface HoldFlow {
  /**
   * Asks whether to send a message that would wake `session` while `other` works in the same
   * folder. True to send it; false when it is not sent, and the owner was told.
   */
  beforeSending(ref: ThreadRef, session: ThreadSession, other: ThreadSession): Promise<boolean>;
}

/** The owner's answer to a request: a permission, a question, the hold, the setup. */
export interface AnswersFlow {
  /** As `ChatInbound.answer`. */
  answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean>;
}

/** `!resume`. */
export interface ResumeFlow {
  /**
   * `!resume` typed in a channel; `ref` is the thread of the owner's word. With no `target` it
   * offers the folder's sessions; with one it resumes the session it names into that thread.
   */
  word(ref: ThreadRef, target: string): Promise<void>;
}

/** `!bind`. */
export interface BindFlow {
  /** `!bind <folder>` typed in a channel. */
  to(channel: string, path: string): Promise<void>;
  /** `!bind` alone: the folders a session can start in, offered as a list. */
  list(channel: string): Promise<void>;
}

/** A pick from a list a word posted. */
export interface PicksFlow {
  /** As `ChatInbound.picked`. */
  picked(pick: ListPick): Promise<void>;
}

/** A message the owner wrote. */
export interface MessagesFlow {
  /** As `ChatInbound.message`. */
  message(message: InboundMessage): Promise<void>;
}

/** What the message flow calls of the others. */
export interface OtherFlows {
  readonly setup: SetupFlow;
  readonly hold: HoldFlow;
  readonly resume: ResumeFlow;
  readonly bind: BindFlow;
}

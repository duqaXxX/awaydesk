/**
 * What every flow shares: where the daemon's own answers go, how a failure after a provider's
 * checks reaches the owner, and what is said of a daemon that is stopping.
 *
 * The work handed to `replyOnFailure` is a function, called inside its guard.
 */
import type { AgentBackend } from "../../agent/seam.ts";
import type { ChatProvider, MessageId, ThreadChat, ThreadRef } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { Holds } from "../hold.ts";
import { oneLine } from "../reply/words.ts";
import type { Approvals } from "../requests.ts";
import { DirectoryUnavailable, SessionClosed, SessionGone } from "../sessions/errors.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { ThreadSession } from "../sessions/session.ts";
import { Cancelled } from "../sessions/tasks.ts";
import type { StateStore } from "../state.ts";
import * as texts from "../texts.ts";
import { fill, type Names, named } from "../texts.ts";

export const logger = getLogger("awaydesk.core.flows");

// Rows of threads a stop waits for in one notice: a row holds a link and a title of
// `TITLE_LIMIT`, and the whole must fit one notice of any chat.
export const RESTART_WAIT_ROWS = 8;
// The most of a session's title a row shows.
export const TITLE_LIMIT = 80;

/** What every flow is built over: the two modules, the core's stores and the daemon's stop. */
export interface FlowDeps {
  readonly chat: ChatProvider;
  readonly agent: AgentBackend;
  readonly sessions: SessionManager;
  readonly state: StateStore;
  readonly approvals: Approvals;
  readonly holds: Holds;
  /** The agent's and the chat's names, which the texts that name them take. */
  readonly names: Names;
  /** The folder sessions may start under. */
  readonly allowedRoot: string;
  /**
   * Aborts when the daemon stops. A flow still in flight then does nothing at its next step: the
   * sessions are closed and the lock is released.
   */
  readonly stopped: AbortSignal;
  /** Wall-clock seconds. */
  readonly now: () => number;
}

/** How a failure reaches the owner: the text of one line, delivered where the failed act answers. */
export type Report = (text: string) => Promise<void>;

/** Whether a wait was cancelled: a task's signal aborted. */
export function isCancelled(error: unknown): boolean {
  return error instanceof Cancelled;
}

export class Talk {
  private readonly deps: FlowDeps;

  constructor(deps: FlowDeps) {
    this.deps = deps;
  }

  /**
   * Whether the daemon has stopped. A flow that finds it so ends silently: its work goes on at
   * its next await after the stop.
   */
  get stopped(): boolean {
    return this.deps.stopped.aborted;
  }

  /** The thread as its live session holds it, so that what is posted there counts as written. */
  thread(ref: ThreadRef): ThreadChat {
    return this.deps.sessions.chatOf(ref.channel, ref.thread);
  }

  /**
   * A line for the owner alone, under their message in the thread: a refusal that answers what
   * they just did. With `stays` it is a message of the thread instead. Never throws.
   */
  async tell(
    ref: ThreadRef,
    text: string,
    options: { readonly stays?: boolean } = {},
  ): Promise<void> {
    if (this.stopped) return;
    await this.thread(ref).tell(text, options);
  }

  /**
   * A reference the owner reads (`!help`, `!guide`, `!status`), at full size: in the thread, or
   * in the channel when `thread` is null.
   */
  async say(
    channel: string,
    thread: string | null,
    markdown: string,
    options: { readonly ownerOnly?: boolean } = {},
  ): Promise<void> {
    if (this.stopped) return;
    if (thread === null) await this.deps.chat.channel(channel).say(markdown);
    else await this.thread({ channel, thread }).say(markdown, options);
  }

  /**
   * Answer in the channel itself: where a word typed in the channel, or a pick from a list
   * posted there, is answered.
   */
  async inChannel(channel: string, text: string): Promise<void> {
    if (this.stopped) return;
    await this.deps.chat.channel(channel).notice(text);
  }

  /** The mark that a word took effect, on the owner's own message, where the chat has one. */
  async acknowledge(ref: ThreadRef, message: MessageId): Promise<void> {
    if (this.stopped || !this.deps.chat.capabilities.reactions) return;
    await this.thread(ref).acknowledge(message);
  }

  /**
   * A failure after the checks reaches the owner as a line of its own, never as silence: by
   * `report`, or as a message of the thread, the one push of a turn that failed.
   */
  async replyOnFailure(ref: ThreadRef, work: () => Promise<void>, report?: Report): Promise<void> {
    const told = report ?? ((text: string) => this.tell(ref, text, { stays: true }));
    // Never throws: nobody is left to tell about a failure of the report itself.
    const guarded = async (text: string): Promise<void> => {
      try {
        await told(text);
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(
          `could not report a failure in ${ref.channel}/${ref.thread}: ${errorName(error)}`,
        );
      }
    };
    try {
      await work();
    } catch (error) {
      if (isCancelled(error)) throw error;
      if (
        error instanceof DirectoryUnavailable ||
        error instanceof SessionClosed ||
        error instanceof SessionGone
      ) {
        await guarded(error.message);
        return;
      }
      logger.error(`a request failed in ${ref.channel}/${ref.thread}: ${errorName(error)}`);
      await guarded(fill(named(texts.ERROR_REPLY, this.deps.names), { error: errorName(error) }));
    }
  }

  /** The request's message has done its job: removed from the chat and from what repair reads. */
  async removeRequest(ref: ThreadRef, message: MessageId | null): Promise<void> {
    if (message === null || this.stopped) return;
    await this.thread(ref).withdraw(message);
    try {
      // Spoken for either way, as the session's own removal does. A no-op for a message this
      // thread never recorded.
      this.deps.state.removeRequest(ref.channel, ref.thread, message);
    } catch (error) {
      logger.warning(
        `could not clear a removed request from state.json in ${ref.channel}: ${errorName(error)}`,
      );
    }
  }

  /** A link to a thread inside a reference, labelled with the session's title. */
  async referenceLink(ref: ThreadRef, title = ""): Promise<string> {
    const label = this.deps.chat.escape(title, "reference") || texts.STATUS_CHANNEL_SESSION;
    const link = await this.thread(ref).link(label, "reference");
    return link ?? fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: ref.thread });
  }

  /** A link to a thread inside a notice; `label` is already escaped for one. */
  async noticeLink(ref: ThreadRef, label: string): Promise<string> {
    const link = await this.thread(ref).link(label, "notice");
    return link ?? fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: ref.thread });
  }

  /**
   * The threads a stop still waits for, one row each: its channel, a link to it labelled with
   * its session's title, and what holds the restart there. Then the word that ends the wait,
   * when it ends any of them. Empty when nothing holds it. With `only`, the threads of that
   * channel are named and the others counted: the answer is a message the channel's members
   * read. At most `RESTART_WAIT_ROWS` rows. Never throws: a title or a link that cannot be read
   * falls back to a plain label.
   */
  async restartWaits(only: string | null = null): Promise<string> {
    const { sessions, state, chat } = this.deps;
    const every = sessions.restartHolds();
    const named_ = every.filter(([session]) => only === null || session.channelId === only);
    if (every.length === 0) return "";
    const shown = named_.slice(0, RESTART_WAIT_ROWS);
    const known = new Map<string, string>();
    for (const directory of new Set(shown.map(([session]) => session.directory))) {
      try {
        for (const listed of await sessions.sessionsIn(directory)) {
          known.set(listed.id, listed.title);
        }
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not list a folder's sessions: ${errorName(error)}`);
      }
    }

    const row = async (session: ThreadSession, hold: string): Promise<string> => {
      const stored = state.thread(session.channelId, session.threadId);
      const title = stored === null ? "" : (known.get(String(stored.sessionId)) ?? "");
      const label =
        chat.escape(oneLine(title, TITLE_LIMIT), "notice") || texts.RESTART_WAIT_SESSION;
      const link = await this.noticeLink(
        { channel: session.channelId, thread: session.threadId },
        label,
      );
      return fill(texts.RESTART_WAIT_ROW, { channel: session.channelId, link, hold });
    };

    const lines = await Promise.all(shown.map(([session, hold]) => row(session, hold)));
    if (named_.length > shown.length) {
      lines.push(fill(texts.RESTART_WAITS_MORE, { count: named_.length - shown.length }));
    }
    if (every.length > named_.length) {
      lines.push(fill(texts.RESTART_WAITS_ELSEWHERE, { count: every.length - named_.length }));
    }
    if (every.some(([, hold]) => hold !== texts.RESTART_HOLD_REPORT)) {
      // A thread that only waits for a task's report ends by itself: `!stop` stops nothing
      // there, so the line is left out when no other thread holds the stop.
      lines.push(texts.RESTART_WAIT_STOP);
    }
    return lines.join("\n");
  }

  /**
   * Tell the owner their message was not taken because the daemon is stopping, and which
   * threads the stop waits for: only they can answer or `!stop` those.
   */
  async refuseRestarting(ref: ThreadRef): Promise<void> {
    const waits = await this.restartWaits();
    let text: string = texts.RESTARTING;
    if (waits) text = [text, texts.RESTART_WAITS_FOR, waits].join("\n");
    await this.tell(ref, text);
  }
}

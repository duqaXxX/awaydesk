/**
 * What every listener shares: the checks each one runs on its own, where the daemon's own answers
 * go, and how a failure after the checks reaches the owner.
 *
 * The work handed to `replyOnFailure` is a function, called inside its guard.
 */
import type { WebClient } from "@slack/web-api";
import type { Clock } from "../../../clock.ts";
import type { ApprovalsPort, HoldsPort, SessionsPort, StatePort } from "../../../core/port.ts";
import { oneLine } from "../../../core/reply/words.ts";
import { DirectoryUnavailable, SessionClosed, SessionGone } from "../../../core/sessions/errors.ts";
import type { ThreadSession } from "../../../core/sessions/session.ts";
import { Cancelled } from "../../../core/sessions/tasks.ts";
import * as texts from "../../../core/texts.ts";
import { fill } from "../../../core/texts.ts";
import { getLogger } from "../../../log.ts";
import type { Home } from "../home.ts";
import { deliver } from "../notice.ts";
import type { Listings } from "../openfile/listing.ts";
import { contextBlock, noticeText } from "../reply/blocks.ts";
import { deleteRequest, describe } from "../reply/errors.ts";
import { markdownEscape, mrkdwnEscape } from "../reply/escape.ts";
import type { Limiter } from "../reply/limiter.ts";
import { TITLE_LIMIT } from "../resume.ts";
import type { SlackChat, SlackThread } from "../thread.ts";
import { type ChannelGuard, type Identity, isOwner } from "./guards.ts";

export const logger = getLogger("awaydesk.chat.slack.app");

// Rows of threads a stop waits for in one notice: a row is under 300 characters (a permalink,
// a title of TITLE_LIMIT), so the list stays inside a context element's 3,000.
export const RESTART_WAIT_ROWS = 8;

/** How a failure reaches the owner: the text of one line, delivered where the failed act answers. */
export type Report = (text: string) => Promise<void>;

/**
 * How a file is downloaded: its URL, its declared type and the size limit, to its bytes. Named
 * fields only: the two strings must never be swapped.
 */
export type Fetch = (request: {
  readonly url: string;
  readonly mimetype: string;
  readonly limit: number;
}) => Promise<Uint8Array>;

/** What the handlers read of the daemon's configuration. */
export interface AppConfig {
  /** Downloads a message's files with it. */
  readonly botToken: string;
  /** The folder sessions may start under. */
  readonly allowedRoot: string;
}

/** What the handlers are built over: every client, store and clock comes from outside. */
export interface AppParts {
  /** The shared client every handler calls Slack with. */
  readonly slack: WebClient;
  /** The provider the handlers answer through. */
  readonly chat: SlackChat;
  readonly config: AppConfig;
  readonly identity: Identity;
  readonly sessions: SessionsPort;
  readonly approvals: ApprovalsPort;
  readonly holds: HoldsPort;
  readonly guard: ChannelGuard;
  readonly state: StatePort;
  /** The folder a message's files that are no image are saved in. */
  readonly uploads: string;
  readonly home: Home;
  /** The `chat.update` budget every reply draws from (`SlackChat.limiter`). */
  readonly limiter: Limiter;
  readonly fetch: Fetch;
  /** Every wait of a handler: the clip's expiry, the rows of a modal that is opening. */
  readonly clock: Clock;
  /**
   * Aborts when the daemon stops (`SlackChat.stopped`). A listener still in flight then does
   * nothing at its next step: the sessions are closed and the lock is released.
   */
  readonly stopped: AbortSignal;
  /** Wall-clock seconds, as a Slack ts counts them. */
  readonly now: () => number;
  /** `!open`'s search reads each folder's files from disk, kept for a few seconds. */
  readonly listings: Listings;
}

/** Whether a wait was cancelled: a task's signal aborted. */
export function isCancelled(error: unknown): boolean {
  return error instanceof Cancelled;
}

export class Answers {
  private readonly parts: AppParts;

  constructor(parts: AppParts) {
    this.parts = parts;
  }

  /**
   * Whether the daemon has stopped. A listener that finds it so ends silently: Node's listeners
   * go on at their next await after the stop.
   */
  get stopped(): boolean {
    return this.parts.stopped.aborted;
  }

  /**
   * One message to the channel: a normal post (in `threadTs`'s thread, or top-level when it is
   * null) or, with `ephemeral`, one only the owner sees, under `threadTs`. A normal post pushes
   * only inside a thread the owner started; an ephemeral message never does.
   */
  async deliver(
    channel: string,
    threadTs: string | null,
    text: string,
    blocks: readonly object[],
    options: { readonly ephemeral: boolean },
  ): Promise<void> {
    const { slack, identity, sessions } = this.parts;
    if (this.stopped) return;
    await deliver(slack, identity.ownerUserId, { channel, threadTs }, text, blocks, options);
    if (threadTs !== null) {
      // Slack clears a thread's status line when the app replies: the session's is set
      // again, so `Working…` does not go for a minute after the answer to a word.
      sessions.wrote(channel, threadTs);
    }
  }

  /**
   * One of the daemon's own notices (a bind, a resume, a restart), small and grey as the footer,
   * so it reads apart from Claude's replies. `text` is mrkdwn.
   */
  async notice(
    channel: string,
    threadTs: string | null,
    text: string,
    options: { readonly ephemeral?: boolean } = {},
  ): Promise<void> {
    await this.deliver(channel, threadTs, text, [contextBlock(noticeText(text))], {
      ephemeral: options.ephemeral ?? false,
    });
  }

  /**
   * A reference the owner reads (`!help`, `!guide`, `!status`), at full size: a long one
   * continues in a new message past a markdown block's limit.
   */
  async say(
    channel: string,
    threadTs: string | null,
    text: string,
    options: { readonly ephemeral?: boolean } = {},
  ): Promise<void> {
    if (threadTs === null) await this.parts.chat.channel(channel).say(text);
    else await this.thread(channel, threadTs).say(text, { ownerOnly: options.ephemeral ?? false });
  }

  /**
   * A line for the owner alone, under their message in `threadTs`'s thread: a refusal that
   * answers what they just did. With `stays` it is a post in the thread instead, which a reload
   * keeps and which can notify. Never throws: nobody is left to tell about a failure.
   */
  async tellOwner(
    channel: string,
    threadTs: string,
    text: string,
    options: { readonly stays?: boolean } = {},
  ): Promise<void> {
    await this.thread(channel, threadTs).tell(text, options);
  }

  /**
   * Answer in the channel itself, as a normal post: where a word typed in the channel, or a
   * click on a list posted there, is answered.
   */
  async inChannel(channel: string, text: string): Promise<void> {
    await this.parts.chat.channel(channel).notice(text);
  }

  /**
   * The thread as a handler answers in it: what it posts clears the live session's status line,
   * which is set again.
   */
  private thread(channel: string, threadTs: string): SlackThread {
    const ref = { channel, thread: threadTs };
    return this.parts.chat.answering(ref, () => this.parts.sessions.wrote(channel, threadTs));
  }

  /**
   * A failure after the checks reaches the owner as a line of its own, never as silence: by
   * `report`, or as a post in the thread, the one push of a turn that failed.
   */
  async replyOnFailure(
    channel: string,
    threadTs: string,
    work: () => Promise<void>,
    report?: Report,
  ): Promise<void> {
    const told = report ?? ((text: string) => this.notice(channel, threadTs, text));
    // Never throws: this runs inside a handler's own `catch`, and a throw would reach the
    // message listener's outer handler, which posts `ERROR_REPLY` threaded under the word.
    const guarded = async (text: string): Promise<void> => {
      try {
        await told(text);
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not report a failure in ${channel}/${threadTs}: ${describe(error)}`);
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
      logger.error(`a request failed in ${channel}/${threadTs}: ${describe(error)}`);
      await guarded(fill(texts.ERROR_REPLY, { error: describe(error) }));
    }
  }

  /**
   * The two checks every inbound path that names a channel runs on its own: the owner acting from
   * the workspace read at startup, then the channel as Slack describes it now. Anyone else gets
   * nothing; the owner, in a channel the guard refuses, is told why.
   */
  async admitted(
    user: string | null,
    team: string | null,
    channel: string | null,
    threadTs: string,
  ): Promise<boolean> {
    const { identity, guard } = this.parts;
    if (this.stopped) return false;
    if (!channel || !isOwner(identity, user, team)) {
      logger.info("ignored an inbound event from someone other than the owner");
      return false;
    }
    const reason = await guard.refusal(channel);
    // The check can outlast the daemon: nothing is said, not even to refuse the channel.
    if (this.stopped) return false;
    if (reason !== null) {
      // For the owner alone, even from a top-level message: a channel the guard refuses may
      // hold people who must not read the bot's words.
      await this.tellOwner(channel, threadTs, fill(texts.CHANNEL_REFUSED, { reason }));
      return false;
    }
    return true;
  }

  /**
   * ✅ on the owner's own message: the mark that a word took effect, which stays after a reload.
   * A reaction never rings a phone; a failed one is logged, never thrown (the word already took
   * effect).
   */
  async acknowledge(channel: string, threadTs: string, ts: string): Promise<void> {
    await this.thread(channel, threadTs).acknowledge(ts);
  }

  /** The tool's line in the reply records the call: the request message has done its job. */
  async removeRequest(channel: string, threadTs: string, ts: string | null): Promise<void> {
    if (ts === null || this.stopped) return;
    await deleteRequest(this.parts.slack, { channel, ts }, { now: this.parts.now });
    try {
      // Crash repair (issue #19): spoken for either way, as the session's own delete does. A
      // no-op for a ts this thread never recorded (a folder or resume picker click).
      // Best-effort: a failed write here is logged and swallowed.
      this.parts.state.removeRequest(channel, threadTs, ts);
    } catch (error) {
      logger.warning(
        `could not clear a deleted request from state.json in ${channel}: ${describe(error)}`,
      );
    }
  }

  /**
   * `say` posts a markdown block: standard Markdown links (docs.slack.dev, markdown block), not
   * mrkdwn's `<url|label>`. The title is shown as written, so its own brackets cannot end the
   * label.
   */
  async threadLink(channel: string, threadTs: string, title = ""): Promise<string> {
    const label = markdownEscape(title) || texts.STATUS_CHANNEL_SESSION;
    const link = await this.thread(channel, threadTs).link(label, "reference");
    return link ?? fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: threadTs });
  }

  /** A resume row and a notice are mrkdwn (`contextBlock`), which takes `<url|label>`. */
  async threadMrkdwnLink(channel: string, threadTs: string, label: string): Promise<string> {
    const link = await this.thread(channel, threadTs).link(label, "notice");
    return link ?? fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: threadTs });
  }

  /**
   * The threads a stop still waits for, one mrkdwn row each: its channel, a link to it labelled
   * with its session's title, as the Home tab names it, and what holds the restart there. Then
   * the word that ends the wait, when it ends any of them. Empty when nothing holds it. With
   * `only`, the threads of that channel are named and the others counted: the answer is a post
   * the channel's members read. At most RESTART_WAIT_ROWS rows, so the whole fits a notice and is
   * never cut inside a link. Never throws: a title or a link that cannot be read falls back to a
   * plain label.
   */
  async restartWaits(only: string | null = null): Promise<string> {
    const { sessions, state } = this.parts;
    const every = sessions.restartHolds();
    const named = every.filter(([session]) => only === null || session.channelId === only);
    if (every.length === 0) return "";
    const shown = named.slice(0, RESTART_WAIT_ROWS);
    const known = new Map<string, string>();
    for (const directory of new Set(shown.map(([session]) => session.directory))) {
      try {
        for (const listed of await sessions.sessionsIn(directory)) {
          known.set(listed.id, listed.title);
        }
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not list a folder's sessions: ${describe(error)}`);
      }
    }

    const row = async (session: ThreadSession, hold: string): Promise<string> => {
      const stored = state.thread(session.channelId, session.threadId);
      const title = stored === null ? "" : (known.get(String(stored.sessionId)) ?? "");
      const label = mrkdwnEscape(oneLine(title, TITLE_LIMIT)) || texts.RESTART_WAIT_SESSION;
      const link = await this.threadMrkdwnLink(session.channelId, session.threadId, label);
      return fill(texts.RESTART_WAIT_ROW, { channel: session.channelId, link, hold });
    };

    const lines = await Promise.all(shown.map(([session, hold]) => row(session, hold)));
    if (named.length > shown.length) {
      lines.push(fill(texts.RESTART_WAITS_MORE, { count: named.length - shown.length }));
    }
    if (every.length > named.length) {
      lines.push(fill(texts.RESTART_WAITS_ELSEWHERE, { count: every.length - named.length }));
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
   * threads the stop waits for (issue #119): only they can answer or `!stop` those.
   */
  async refuseRestarting(channel: string, threadTs: string): Promise<void> {
    const waits = await this.restartWaits();
    let text: string = texts.RESTARTING;
    if (waits) text = [text, texts.RESTART_WAITS_FOR, waits].join("\n");
    await this.tellOwner(channel, threadTs, text);
  }
}

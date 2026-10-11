/**
 * What every listener shares: the checks each one runs on its own, where the daemon's own answers
 * go, and how a failure after the checks reaches the owner.
 *
 * The work handed to `replyOnFailure` is a function, called inside its guard.
 */

import type { WebClient } from "@slack/web-api";
import type { Clock } from "../../../clock.ts";
import {
  type ApprovalsPort,
  Cancelled,
  DirectoryUnavailable,
  fill,
  type HoldsPort,
  type Names,
  named,
  SessionClosed,
  SessionGone,
  type SessionsPort,
  type StatePort,
  texts,
} from "../../../core/port.ts";
import { getLogger } from "../../../log.ts";
import type { ChatInbound } from "../../seam.ts";
import type { Home } from "../home.ts";
import { deliver } from "../notice.ts";
import type { Listings } from "../openfile/listing.ts";
import { contextBlock, noticeText } from "../reply/blocks.ts";
import { describe } from "../reply/errors.ts";
import type { Limiter } from "../reply/limiter.ts";
import * as slackTexts from "../texts.ts";
import type { SlackChat, SlackThread } from "../thread.ts";
import { type ChannelGuard, type Identity, isOwner } from "./guards.ts";

export const logger = getLogger("awaydesk.chat.slack.app");

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
  /** The agent's and the chat's names, which the texts that name them take. */
  readonly names: Names;
  /** What the listeners tell the core of what the owner did. */
  readonly inbound: ChatInbound;
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
      await guarded(fill(named(texts.ERROR_REPLY, this.parts.names), { error: describe(error) }));
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
    if (!this.fromOwner(user, team, channel)) return false;
    return this.channelAllowed(channel, threadTs);
  }

  /**
   * The first of the two checks, with nothing awaited: false once the daemon has stopped, for an
   * event with no channel and for anyone but the owner acting from the workspace read at
   * startup. A listener that keeps an order takes its place only after it, so that anyone else
   * takes none.
   */
  fromOwner(user: string | null, team: string | null, channel: string | null): channel is string {
    if (this.stopped) return false;
    if (!channel || !isOwner(this.parts.identity, user, team)) {
      logger.info("ignored an inbound event from someone other than the owner");
      return false;
    }
    return true;
  }

  /** The second check: the channel as Slack describes it now, the owner told why when refused. */
  async channelAllowed(channel: string, threadTs: string): Promise<boolean> {
    const reason = await this.parts.guard.refusal(channel);
    // The check can outlast the daemon: nothing is said, not even to refuse the channel.
    if (this.stopped) return false;
    if (reason !== null) {
      // For the owner alone, even from a top-level message: a channel the guard refuses may
      // hold people who must not read the bot's words.
      await this.tellOwner(channel, threadTs, fill(slackTexts.CHANNEL_REFUSED, { reason }));
      return false;
    }
    return true;
  }
}

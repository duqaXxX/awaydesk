/**
 * A Slack channel outside any thread (`ChannelChat` of the chat seam): where a word typed in the
 * channel, or a click on a list posted there, is answered. Every post is a normal one in the
 * channel; the words are the daemon's, small and grey, or a reference at full size.
 */
import type { WebClient } from "@slack/web-api";
import type { Clock } from "../../clock.ts";
import { getLogger } from "../../log.ts";
import type { ChannelChat, MessageId, OwnerList } from "../seam.ts";
import { bindBlocks } from "./bind.ts";
import { crossing, deliver, deliverNotice, rewriteAsNotice } from "./notice.ts";
import { split } from "./reply/blocks.ts";
import { describe } from "./reply/errors.ts";
import type { Limiter } from "./reply/limiter.ts";
import { resumeBlocks } from "./resume.ts";

export const logger = getLogger("awaydesk.chat.slack.channel");

/** What a channel is drawn with: the provider's client, owner, budget and stop signal. */
export interface ChannelParts {
  readonly slack: WebClient;
  readonly ownerUserId: string;
  readonly limiter: Limiter;
  /** Wall-clock seconds: a session list dates its rows against them. */
  readonly clock: Clock;
  /** Aborts when the provider stops: nothing is posted from then on. */
  readonly stopped: AbortSignal;
}

export class SlackChannel implements ChannelChat {
  readonly #channel: string;
  readonly #parts: ChannelParts;

  constructor(channel: string, parts: ChannelParts) {
    this.#channel = channel;
    this.#parts = parts;
  }

  async notice(text: string): Promise<void> {
    if (this.#parts.stopped.aborted) return;
    const { slack, ownerUserId } = this.#parts;
    await crossing(() =>
      deliverNotice(slack, ownerUserId, { channel: this.#channel, threadTs: null }, text, {
        ephemeral: false,
      }),
    );
  }

  async say(markdown: string): Promise<void> {
    const { slack, ownerUserId, stopped } = this.#parts;
    for (const chunk of split(markdown)) {
      if (stopped.aborted) return;
      await crossing(() =>
        deliver(
          slack,
          ownerUserId,
          { channel: this.#channel, threadTs: null },
          chunk,
          [{ type: "markdown", text: chunk }],
          { ephemeral: false },
        ),
      );
    }
  }

  async offer(list: OwnerList, title: string): Promise<void> {
    const { slack, ownerUserId, clock, stopped } = this.#parts;
    if (stopped.aborted) return;
    const blocks =
      list.type === "folders"
        ? bindBlocks(list.root, [...list.folders], list.bound)
        : resumeBlocks(
            list.folder,
            list.sessions,
            list.held,
            new Date(clock.time() * 1000),
            list.thread.thread,
          );
    await crossing(() =>
      deliver(slack, ownerUserId, { channel: this.#channel, threadTs: null }, title, blocks, {
        ephemeral: false,
      }),
    );
  }

  async withdraw(list: MessageId): Promise<boolean> {
    try {
      await this.#parts.slack.chat.delete({ channel: this.#channel, ts: list });
      return true;
    } catch (error) {
      logger.warning(`could not delete a list in ${this.#channel}: ${describe(error)}`);
      return false;
    }
  }

  async rewrite(list: MessageId, text: string): Promise<void> {
    await rewriteAsNotice(this.#parts.slack, this.#parts.limiter, this.#channel, list, text);
  }
}

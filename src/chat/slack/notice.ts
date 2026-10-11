/**
 * The Slack calls behind the daemon's own words, in one place for the thread (`SlackThread`), the
 * channel (`SlackChannel`) and the handlers that post blocks of their own (`Answers.deliver`): a
 * message to the channel or to its thread, and a message rewritten into a notice.
 */
import type { KnownBlock, WebClient } from "@slack/web-api";
import { Cancelled } from "../../core/port.ts";
import { ChatError } from "../seam.ts";
import { contextBlock, FALLBACK_LIMIT, noticeText } from "./reply/blocks.ts";
import { take } from "./reply/chars.ts";
import { describe } from "./reply/errors.ts";
import type { Limiter } from "./reply/limiter.ts";

/** Where a message goes: a thread of the channel, or the channel itself when `threadTs` is null. */
export interface Place {
  readonly channel: string;
  readonly threadTs: string | null;
}

/**
 * One message to `place`: a normal post or, with `ephemeral`, one only `ownerUserId` sees. A
 * normal post pushes only inside a thread the owner started; an ephemeral message never does.
 * `blocks` are built to Block Kit's reference by the modules that make them: opaque to the
 * library's types.
 */
export async function deliver(
  slack: WebClient,
  ownerUserId: string,
  place: Place,
  text: string,
  blocks: readonly object[],
  options: { readonly ephemeral: boolean },
): Promise<void> {
  const where = place.threadTs === null ? {} : { thread_ts: place.threadTs };
  const shown = blocks as unknown as KnownBlock[];
  if (options.ephemeral) {
    await slack.chat.postEphemeral({
      channel: place.channel,
      user: ownerUserId,
      text: take(text, FALLBACK_LIMIT),
      blocks: shown,
      ...where,
    });
  } else {
    await slack.chat.postMessage({
      channel: place.channel,
      text: take(text, FALLBACK_LIMIT),
      blocks: shown,
      unfurl_links: false,
      unfurl_media: false,
      ...where,
    });
  }
}

/** One of the daemon's notices, small and grey as the footer; `text` is mrkdwn. */
export function deliverNotice(
  slack: WebClient,
  ownerUserId: string,
  place: Place,
  text: string,
  options: { readonly ephemeral: boolean },
): Promise<void> {
  return deliver(slack, ownerUserId, place, text, [contextBlock(noticeText(text))], options);
}

/**
 * `call`, with a failure crossing the seam as a `ChatError` named by Slack's code. A `Cancelled`
 * is no failure of the chat: it crosses as it is.
 */
export async function crossing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    throw new ChatError(describe(error), { cause: error });
  }
}

/**
 * The message `ts` rewritten into a notice that says `text`, with nothing left to press: an edit
 * (silent), against the app's `chat.update` budget, which every reply draws from. Rejects with a
 * `ChatError` named by Slack's code.
 */
export function rewriteAsNotice(
  slack: WebClient,
  limiter: Limiter,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  return crossing(async () => {
    await limiter.acquire();
    await slack.chat.update({ channel, ts, text, blocks: [contextBlock(noticeText(text))] });
  });
}

/** What the daemon asks Slack about the channels it is bound to, and the threads in them. */

import type { WebClient } from "@slack/web-api";
import type { ChannelLookup, ThreadLookup } from "../../core/port.ts";
import { ChatError } from "../seam.ts";
import { THREAD_NOT_FOUND } from "./delete.ts";
import { describe } from "./reply/errors.ts";

const CHANNEL_NOT_FOUND = "channel_not_found";

/**
 * What the cleanup asks about a bound channel: `conversations.info`. Only `channel_not_found` is
 * an answer that the channel is gone; any other failure crosses as a `ChatError` named by
 * Slack's code, which the cleanup logs as no answer.
 */
export function channelLookup(slack: WebClient): ChannelLookup {
  return async (channelId) => {
    try {
      await slack.conversations.info({ channel: channelId });
      return "there";
    } catch (error) {
      const code = describe(error);
      if (code === CHANNEL_NOT_FOUND) return "gone";
      throw new ChatError(code, { cause: error });
    }
  };
}

/**
 * What the cleanup asks about a thread: `conversations.replies` on its root with `limit=1`, which
 * a deleted root answers with `thread_not_found` (measured 2026-10-01, see `home.ts`). Only that
 * code says the thread is gone; any other failure crosses as a `ChatError` named by Slack's code.
 */
export function threadLookup(slack: WebClient): ThreadLookup {
  return async (ref) => {
    try {
      await slack.conversations.replies({ channel: ref.channel, ts: ref.thread, limit: 1 });
      return "there";
    } catch (error) {
      const code = describe(error);
      if (code === THREAD_NOT_FOUND) return "gone";
      throw new ChatError(code, { cause: error });
    }
  };
}

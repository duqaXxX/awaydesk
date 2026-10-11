/**
 * Repair what a crashed daemon left open (issue #19): a reply whose stream never stopped or
 * whose cards still run, a request still carrying its controls, and the working or waiting
 * status a turn mid-flight left on its thread's root. Runs once on start, right after the chat
 * is built and before its connection opens (a provider's own client works without it) and
 * before the state is pruned (a pruned thread's leftovers must still be repaired); a graceful
 * stop clears these same fields itself, so a second start finds nothing to do.
 */
import type { ChatProvider, ThreadChat } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { ThreadsState } from "../port/threads.ts";
import { STORED_STATUS } from "../sessions/constants.ts";
import * as texts from "../texts.ts";

export const logger = getLogger("awaydesk.core.flows.repair");

/** What the repair reads and clears of the daemon's state. */
export type RepairState = Pick<
  ThreadsState,
  "repairsPending" | "replaceOpenReply" | "removeRequest" | "setStatusPending"
>;

/**
 * Repair every thread `state` still shows as left open. One thread's failure (a deleted
 * message, a chat error) is logged and does not stop the others; each of a thread's three
 * fields is cleared once its own repair has been attempted, successfully or not, so a second
 * start never retries what this one already gave up on.
 */
export async function repair(chat: ChatProvider, state: RepairState): Promise<void> {
  for (const [channelId, threadId, thread] of state.repairsPending()) {
    try {
      const chatThread = chat.thread({ channel: channelId, thread: threadId });
      for (const messageId of thread.openReplies) {
        await chatThread.endReply(messageId, texts.STOPPED_BEFORE_ANSWER);
        safe(() => state.replaceOpenReply(channelId, threadId, messageId, null));
      }
      for (const messageId of thread.requests) {
        await chatThread.withdraw(messageId);
        safe(() => state.removeRequest(channelId, threadId, messageId));
      }
      if (thread.status !== null) {
        const ended = await repairStatus(chat, chatThread, thread.status);
        safe(() => state.setStatusPending(channelId, threadId, null, ended));
      }
    } catch (error) {
      logger.error(
        `could not repair a crashed thread's state in ${channelId}/${threadId}: ${errorName(error)}`,
      );
    }
  }
}

/**
 * A `StateStore` write is a plain synchronous file write, so it can throw like any other (disk
 * full, a permission problem): best-effort here, since repair itself must never crash the
 * daemon's startup over its own bookkeeping. Logged with the error name only.
 */
function safe(write: () => void): void {
  try {
    write();
  } catch (error) {
    logger.warning(`could not update state.json during crash repair: ${errorName(error)}`);
  }
}

/**
 * Shows the error status on a root left working or waiting, through a thread object of its
 * own (issue #19 fix round item 9): its first status also strips every other stray status
 * from the root, which is strictly more thorough than removing just the one name the state
 * recorded. Returns the stored word for the status asked for, the thread's ended one from now
 * on; null for a word that is neither.
 */
async function repairStatus(
  chat: ChatProvider,
  thread: Pick<ThreadChat, "showStatus">,
  stored: string,
): Promise<string | null> {
  if (stored !== STORED_STATUS.working && stored !== STORED_STATUS.waiting) return null;
  if (chat.capabilities.reactions) await thread.showStatus("error");
  return STORED_STATUS.error;
}

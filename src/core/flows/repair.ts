/**
 * Repair what a crashed daemon left open (issue #19): a reply whose stream never stopped or
 * whose cards still run, a request still carrying its controls, and the working or waiting
 * status a turn mid-flight left on its thread's root. Runs once on start, right after the chat
 * is built and before its connection opens (a provider's own client works without it) and
 * before the state is pruned (a pruned thread's leftovers must still be repaired); a graceful
 * stop clears these same fields itself, so a second start finds nothing to do. What the chat
 * did not repair stays in the state, and the next start asks again (issue #264).
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
 * message, a chat error) is logged and does not stop the others. An entry of a thread's three
 * fields is cleared when the chat repaired it or said its message is gone, and kept when the
 * chat did not: the next start asks again, once, and so does every start after it for as long
 * as the chat keeps refusing and the thread is in the state.
 */
export async function repair(chat: ChatProvider, state: RepairState): Promise<void> {
  for (const [channelId, threadId, thread] of state.repairsPending()) {
    try {
      const chatThread = chat.thread({ channel: channelId, thread: threadId });
      for (const messageId of thread.openReplies) {
        if (await chatThread.endReply(messageId, texts.STOPPED_BEFORE_ANSWER)) {
          safe(() => state.replaceOpenReply(channelId, threadId, messageId, null));
        } else left(channelId, threadId, "a reply");
      }
      for (const messageId of thread.requests) {
        if (await chatThread.withdraw(messageId)) {
          safe(() => state.removeRequest(channelId, threadId, messageId));
        } else left(channelId, threadId, "a request");
      }
      if (thread.status !== null) {
        const ended = await repairStatus(chat, chatThread, thread.status);
        if (ended !== undefined) {
          safe(() => state.setStatusPending(channelId, threadId, null, ended));
        } else left(channelId, threadId, "the status");
      }
    } catch (error) {
      logger.error(
        `could not repair a crashed thread's state in ${channelId}/${threadId}: ${errorName(error)}`,
      );
    }
  }
}

/** One line for what stays in the state for the next start: ids and the kind only. */
function left(channelId: string, threadId: string, what: string): void {
  logger.warning(
    `${what} of ${channelId}/${threadId} was not repaired: the next start tries again`,
  );
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
 * on; null for a word that is neither; undefined when the chat did not show it.
 */
async function repairStatus(
  chat: ChatProvider,
  thread: Pick<ThreadChat, "showStatus">,
  stored: string,
): Promise<string | null | undefined> {
  if (stored !== STORED_STATUS.working && stored !== STORED_STATUS.waiting) return null;
  if (chat.capabilities.reactions && !(await thread.showStatus("error"))) return undefined;
  return STORED_STATUS.error;
}

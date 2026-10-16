/**
 * Repair what a crashed daemon left open (issue #19): a reply whose stream never stopped or
 * whose cards still run, a request still carrying its controls, and the working or waiting
 * status a turn mid-flight left on its thread's root. Runs once on start, right after the chat
 * is built and before its connection opens (a provider's own client works without it) and
 * before the state is pruned (a pruned thread's leftovers must still be repaired); a graceful
 * stop clears these same fields itself, so a second start finds nothing to do. What the chat
 * did not repair stays in the state, and the next start asks again (issue #264).
 */
import type { ChatProvider, MessageId, SessionStatus, ThreadChat } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { ThreadsState } from "../port/threads.ts";
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
      // Read before the replies are repaired: a turn with no reply message (a question or an
      // approval opened it, and a reply starts on its first write) leaves its request as the
      // only trace in the thread.
      const hadReply = thread.openReplies.length > 0;
      for (const messageId of thread.openReplies) {
        if (await chatThread.endReply(messageId, texts.STOPPED_BEFORE_ANSWER)) {
          safe(() => state.replaceOpenReply(channelId, threadId, messageId, null));
        } else left(channelId, threadId, "a reply");
      }
      for (const messageId of thread.requests) {
        if (await settleRequest(chatThread, messageId, hadReply)) {
          safe(() => state.removeRequest(channelId, threadId, messageId));
        } else left(channelId, threadId, "a request");
      }
      if (thread.status !== null) {
        const { status } = thread;
        const ended = endedWord(status);
        // Shown through a thread object of its own: its first status also strips every other
        // stray status from the root, more than removing the one name the state recorded.
        const shown =
          ended === null || !chat.capabilities.reactions || (await chatThread.showStatus("error"));
        // Not shown: the word stays for the next start, and the ended one says meanwhile, to
        // whoever lists the sessions, that this one does not run.
        safe(() => state.setStatusPending(channelId, threadId, shown ? null : status, ended));
        if (!shown) left(channelId, threadId, "the status");
      }
    } catch (error) {
      logger.error(
        `could not repair a crashed thread's state in ${channelId}/${threadId}: ${errorName(error)}`,
      );
    }
  }
}

/**
 * A request the crash left open. With a reply in the thread the reply says the turn stopped, and
 * the request goes. Without one, the request is rewritten into that line (no controls, and no
 * notification: an edit), or it goes when the chat refuses the rewrite. False when it still shows.
 */
async function settleRequest(
  chatThread: ThreadChat,
  messageId: MessageId,
  hadReply: boolean,
): Promise<boolean> {
  if (!hadReply) {
    try {
      await chatThread.rewrite(messageId, texts.STOPPED_BEFORE_ANSWER);
      return true;
    } catch (error) {
      logger.warning(`could not rewrite a stale request: ${errorName(error)}`);
    }
  }
  return chatThread.withdraw(messageId);
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
 * The stored word a root left working or waiting ends on, the error one; null for a word that
 * is neither, which is cleared with nothing shown.
 */
function endedWord(stored: SessionStatus): SessionStatus | null {
  return stored === "working" || stored === "waiting" ? "error" : null;
}

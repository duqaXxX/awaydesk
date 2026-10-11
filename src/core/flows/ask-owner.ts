/**
 * The question that holds the owner's message: the same-folder hold and the session's setup.
 * It is shown through the chat seam, waits on a `Holds` entry that only the owner's answer, a
 * `!stop` or a drain settles, and ends with the message sent or not.
 */
import type { ModelInfo } from "../../agent/seam.ts";
import type { HoldRequest, MessageId, SetupRequest, ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import type { HoldAnswer, Pending } from "../hold.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { named } from "../texts.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/** What applies an answer while its hold is still open (`askOwner`). */
export type Settle = (answer: HoldAnswer, shownAt: MessageId, pending: Pending) => Promise<void>;

/** The question to put: what to show, and what to do with the answer. */
export interface Question {
  /** The request, given the id only its answer carries. */
  readonly request: (requestId: string) => HoldRequest | SetupRequest;
  /** The request in one line. */
  readonly title: string;
  readonly settle?: Settle;
  /** What comes back with an answer that carries only the id. */
  readonly context?: readonly ModelInfo[];
}

/**
 * Put a question that holds the owner's message and wait for the answer: whatever the owner
 * answered, or null when it was cancelled (`!stop`, a drain) or never shown (`Not sent.` or the
 * unposted notice, told already). `settle(answer, shownAt, pending)` applies an answer and
 * writes its summary while the thread still shows it waiting and the hold is still open, so a
 * `!stop` or drain meanwhile cancels (`Pending.cancelled`: nothing is sent, the message is
 * removed, `Not sent.`). When it throws, the message is removed, the hold ends as a cancel would
 * and the error goes on.
 */
export async function askOwner(
  deps: FlowDeps,
  talk: Talk,
  ref: ThreadRef,
  session: ThreadSession,
  question: Question,
): Promise<HoldAnswer | null> {
  const { sessions, holds, state } = deps;
  // (sync) The check and the hold it guards: a drain cancels every hold open when it starts
  // and never one opened after, so nothing is awaited between the two.
  if (talk.stopped) return null;
  if (sessions.draining) {
    // a restart could have started during an await before this
    await talk.refuseRestarting(ref);
    return null;
  }
  const [holdId, pending] = holds.open(ref.channel, ref.thread, question.context ?? null);
  let shownAt: MessageId;
  try {
    shownAt = await talk.thread(ref).ask(holdId, question.request(holdId), question.title);
  } catch (error) {
    if (isCancelled(error)) throw error;
    // Nobody can answer a question that was never shown: fail closed, as an unpostable
    // approval does, rather than send into a folder another session is using.
    logger.error(`could not post a hold in ${ref.channel}/${ref.thread}: ${errorName(error)}`);
    holds.discard(holdId);
    await talk.tell(ref, named(texts.HOLD_UNPOSTED, deps.names));
    return null;
  }
  // False when the answer came before `ask` returned (a fast answer, `!stop`, a drain): nobody
  // knew the message then, so it is still ours to settle or remove, and `holdStart`/`holdEnd`
  // (and the waiting status they hold) never run for it.
  const waiting = holds.posted(holdId, shownAt);
  if (waiting) {
    // Crash repair (issue #19): a hold question is a request like an approval. Best-effort:
    // outside the try/finally below on purpose, so a failed write here can never skip
    // `holdStart`/`holdEnd` and leave the hold itself undiscarded; the message is already
    // live either way, so a failure is logged loudly.
    try {
      state.addRequest(ref.channel, ref.thread, shownAt);
    } catch (error) {
      logger.error(
        `posted a hold in ${ref.channel}/${ref.thread} that state.json could not record: ${errorName(error)}`,
      );
    }
  }
  let answer: HoldAnswer | null = null;
  let sent = false;
  try {
    if (waiting) session.holdStart();
    answer = await pending.answer;
    if (answer === null) {
      if (!waiting) await talk.removeRequest(ref, shownAt);
    } else if (question.settle !== undefined) {
      try {
        await question.settle(answer, shownAt, pending);
      } catch (error) {
        if (isCancelled(error)) throw error;
        if (!pending.cancelled) {
          await talk.removeRequest(ref, shownAt);
          throw error;
        }
        logger.warning(
          `a cancelled hold in ${ref.channel}/${ref.thread} failed while applied: ${errorName(error)}`,
        );
      }
    }
    if (pending.cancelled) {
      answer = null;
      if (!waiting) await talk.removeRequest(ref, shownAt);
    }
    sent = answer !== null;
  } finally {
    if (waiting) await session.holdEnd({ continued: sent });
    holds.discard(holdId); // catches a cancelled wait, and ends an answered hold
  }
  if (answer === null) await talk.tell(ref, texts.NOT_SENT);
  return answer;
}

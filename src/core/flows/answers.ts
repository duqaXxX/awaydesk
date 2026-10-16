/**
 * The owner's answer to a request, and what follows it: a tool's permission or the agent's
 * questions (`Approvals`), the same-folder hold and a session's setup (`Holds`). The provider
 * has checked that it was the owner; here the answer is checked against the request it names.
 */
import type { MessageId, OwnerAnswer, ThreadRef } from "../../chat/seam.ts";
import { APPROVE, DENY } from "../requests.ts";
import * as texts from "../texts.ts";
import type { AnswersFlow } from "./contract.ts";
import { chosen } from "./setup.ts";
import { type FlowDeps, logger, type Talk } from "./talk.ts";

export function answersFlow(deps: FlowDeps, talk: Talk): AnswersFlow {
  const { approvals, holds } = deps;

  // Issue #142: the paths that answer `texts.HOLD_GONE` are told apart by these facts alone.
  // Ids and flags only: the answer's content and the setup's choice never reach the log.
  function logRefused(
    path: string,
    ref: ThreadRef,
    message: MessageId | null,
    facts: Record<string, boolean>,
  ): void {
    const told = Object.entries(facts)
      .map(([name, value]) => `${name}=${value ? "True" : "False"}`)
      .join(", ");
    logger.info(
      `refused a click (${path}) in ${ref.channel}/${ref.thread} on message ${message ?? "none"}; ${told}`,
    );
  }

  /**
   * Allow, deny or skip: the request must be waiting in this thread. Whether it was a question
   * only changes the words a refusal carries to the agent (`toAnswer`), except for a permission's
   * own buttons (`fromPermission`), which a question never shows: those are refused for one.
   * The message that goes is the one the core stored for the request; the click's only when the
   * core has none yet (answered before the post returned).
   */
  async function decide(
    ref: ThreadRef,
    requestId: string,
    outcome: typeof APPROVE | typeof DENY,
    message: MessageId | null,
    fromPermission: boolean,
  ): Promise<boolean> {
    const pending = approvals.get(requestId);
    if (
      pending === null ||
      pending.channelId !== ref.channel ||
      pending.threadId !== ref.thread ||
      (fromPermission && pending.questions !== null && pending.questions.length > 0)
    ) {
      await talk.tell(ref, texts.APPROVAL_GONE);
      return false;
    }
    const resolved = approvals.resolve(requestId, ref.channel, ref.thread, outcome);
    if (resolved === null) {
      await talk.tell(ref, texts.APPROVAL_GONE);
      return false;
    }
    await talk.removeRequest(ref, resolved.messageTs ?? message);
    return true;
  }

  async function answer(
    ref: ThreadRef,
    requestId: string,
    given: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean> {
    switch (given.type) {
      case "permission":
        return decide(ref, requestId, given.allow ? APPROVE : DENY, message, true);

      case "question": {
        if (given.answers === null) return decide(ref, requestId, DENY, message, false);
        const pending = approvals.get(requestId);
        if (
          pending === null ||
          pending.channelId !== ref.channel ||
          pending.threadId !== ref.thread ||
          pending.questions === null ||
          pending.questions.length === 0
        ) {
          await talk.tell(ref, texts.APPROVAL_GONE);
          return false;
        }
        const resolved = approvals.resolve(requestId, ref.channel, ref.thread, {
          kind: "answer",
          answers: given.answers,
          notes: given.notes,
        });
        if (resolved === null) {
          await talk.tell(ref, texts.APPROVAL_GONE);
          return false;
        }
        // The session that asked decides what becomes of the request message: its reply keeps
        // the answers, or the request itself does (`ThreadSession` keeps them).
        return true;
      }

      case "hold": {
        // (sync) What the log says of a refused answer is read with the resolve it explains.
        const held = holds.get(requestId);
        // A setup carries the model list it offered; a hold carries none (`Pending.context`).
        if (held?.context != null) {
          logRefused("hold decision, wrong kind", ref, message, {
            send: given.send,
            held: true,
            decided: held.decided,
            kind_matches: false,
          });
          await talk.tell(ref, texts.HOLD_GONE);
          return false;
        }
        const resolved = holds.resolve(
          requestId,
          ref.channel,
          ref.thread,
          given.send ? true : null,
        );
        if (resolved === null) {
          logRefused("hold decision", ref, message, {
            send: given.send,
            held: held !== null,
            decided: held?.decided ?? false,
          });
          await talk.tell(ref, texts.HOLD_GONE);
          return false;
        }
        await talk.removeRequest(ref, resolved.messageTs ?? message);
        return true;
      }

      case "setup": {
        const pending = holds.get(requestId);
        if (pending === null) {
          logRefused("setup start, not held", ref, message, { held: false });
          await talk.tell(ref, texts.HOLD_GONE);
          return false;
        }
        if (pending.context === null) {
          logRefused("setup start, wrong kind", ref, message, {
            held: true,
            decided: pending.decided,
            kind_matches: false,
          });
          await talk.tell(ref, texts.HOLD_GONE);
          return false;
        }
        // The controls' own state rides on the answer: nothing about the choice is stored
        // here, and the model list is the one the request was built from.
        const choice = chosen(deps, pending.context, given.selection);
        if (holds.resolve(requestId, ref.channel, ref.thread, choice) === null) {
          const sameThread = pending.channelId === ref.channel && pending.threadId === ref.thread;
          logRefused("setup start, not resolved", ref, message, {
            held: true,
            decided: pending.decided,
            same_thread: sameThread,
          });
          // A second Start while the first is applied (issue #142): what ends the apply (the
          // summary, `texts.NOT_SENT` or the error) says what happened.
          if (!(pending.decided && sameThread)) await talk.tell(ref, texts.HOLD_GONE);
          return false;
        }
        logger.info(
          `accepted a setup start in ${ref.channel}/${ref.thread} on message ${message ?? "none"}`,
        );
        return true;
      }
    }
  }

  return { answer };
}

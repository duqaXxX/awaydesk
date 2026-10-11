/**
 * The same-folder hold: before a message wakes an idle session while a live session of another
 * thread is busy in the same folder, the owner is asked whether to send it anyway.
 */
import type { HoldRequest, ThreadRef } from "../../chat/seam.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { askOwner } from "./ask-owner.ts";
import type { HoldFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

export function holdFlow(deps: FlowDeps, talk: Talk): HoldFlow {
  /**
   * Post `Another session is working in this folder: <link>. Send anyway?` and wait for the
   * owner's answer, cancelled the same way by `!stop` (in this thread or the whole channel) or
   * a drain. True to send the message on; false when it was not, either way telling the owner
   * `Not sent.` already.
   */
  async function beforeSending(
    ref: ThreadRef,
    session: ThreadSession,
    other: ThreadSession,
  ): Promise<boolean> {
    const otherRef = { channel: other.channelId, thread: other.threadId };
    const link = await talk.noticeLink(otherRef, "Session");
    const answer = await askOwner(deps, talk, ref, session, {
      title: fill(texts.HOLD_QUESTION, { link }),
      request: (requestId): HoldRequest => ({ type: "hold", requestId, other: otherRef, link }),
    });
    return answer === true;
  }

  return { beforeSending };
}

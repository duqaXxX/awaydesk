/**
 * `!bind` and `!resume`, typed or clicked, as the Slack provider hears them. What is offered,
 * which rows a list holds and what follows a pick are the core's (`src/core/flows/lists.ts`);
 * here a click is acknowledged, checked for the owner and the channel, and read into the pick
 * the core is told of. The lists themselves are drawn by `SlackChannel.offer`.
 */

import { boundText } from "../../../core/port.ts";
import { parseResumeValue } from "../resume.ts";
import type { Answers, AppParts } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import {
  type Ack,
  clickThread,
  firstAction,
  messageTs,
  type Payload,
  record,
  str,
  text,
} from "./wire.ts";

export class ResumeBind {
  private readonly parts: AppParts;
  private readonly answers: Answers;

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /** `!bind <folder>` typed in the channel. */
  bindTo(channel: string, path: string): Promise<void> {
    return this.parts.flows.bind.to(channel, path);
  }

  /** `!bind` alone: the folders a session can start in, each with its button. */
  listFolders(channel: string): Promise<void> {
    return this.parts.flows.bind.list(channel);
  }

  /**
   * `!resume` typed in the channel (`threadTs` is the thread of the owner's word: the message
   * itself when top-level).
   */
  handleResume(channel: string, threadTs: string, target: string): Promise<void> {
    return this.parts.flows.resume.word({ channel, thread: threadTs }, target);
  }

  /** A Bind button of the folder list. */
  onBind = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    // The button is not trusted: the core checks its folder as it checks a typed `!bind`.
    await this.parts.inbound.picked({
      type: "folder",
      channel,
      path: str(firstAction(body).value),
      list: messageTs(body),
    });
  };

  /** A Resume button of the session list. */
  onResume = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    // A value of another shape is a list posted before the button carried its thread: the core
    // is told the button named none. The session and the thread are checked again by the core.
    const value = str(firstAction(body).value);
    const parsed = parseResumeValue(value);
    await this.parts.inbound.picked({
      type: "session",
      channel,
      sessionId: parsed === null ? value : parsed[0],
      thread: parsed === null ? null : { channel, thread: parsed[1] },
      list: messageTs(body),
    });
  };
}

// Until `app.ts` stops re-exporting it: the answer to a bind is the core's words now.
export { boundText };

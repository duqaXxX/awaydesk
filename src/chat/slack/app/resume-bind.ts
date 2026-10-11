/**
 * `!bind` and `!resume`, typed or clicked, as the Slack provider hears them. What is offered,
 * which rows a list holds and what follows a pick are the core's (`src/core/flows/lists.ts`);
 * here a click is acknowledged, checked for the owner and the channel, and read into the pick
 * the core is told of. The lists themselves are drawn by `SlackChannel.offer`.
 */

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

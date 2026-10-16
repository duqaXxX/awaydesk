/**
 * The clicks and forms that answer the questions the daemon puts to the owner, as Slack sends
 * them: a tool's permission request and the agent's own questions, the same-folder hold and the
 * session setup. What is asked, which choices exist and what follows an answer are the core's
 * (`core/flows/`); each listener checks the owner and the channel, reads its payload and tells
 * the core through `ChatInbound.answer`. The controls that only redraw a message stay here.
 */

import type { KnownBlock, ModalView } from "@slack/web-api";
import { fill, texts } from "../../../core/port.ts";
import type { OwnerAnswer } from "../../seam.ts";
import { HOLD_CONTINUE } from "../hold.ts";
import { describe } from "../reply/errors.ts";
import {
  APPROVAL_ALLOW,
  absorb,
  blockIdIn,
  type Draft,
  draftAnswers,
  excluding,
  type Field,
  firstUnanswered,
  isAnswered,
  loadDraft,
  newDraft,
  QUESTION_FORM,
  QUESTION_SKIP,
  questionView,
  refusedView,
} from "../requests.ts";
import { readChoice, readSelection, setupBlocks } from "../setup.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, isCancelled, logger } from "./answers.ts";
import { interactionActor, isOwner } from "./guards.ts";
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

export class Requests {
  private readonly parts: AppParts;
  private readonly answers: Answers;

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  // Issue #142: the facts that tell apart the paths that answer `texts.HOLD_GONE`, for the click
  // that only redraws (a model picked); the core logs those of the answers it refuses. Ids and
  // flags only: the click's text and the setup's choice never reach the log.
  private logRefusedClick(path: string, body: Payload, facts: Record<string, boolean>): void {
    const told = Object.entries(facts)
      .map(([name, value]) => `${name}=${value ? "True" : "False"}`)
      .join(", ");
    logger.info(
      `refused a click (${path}): action ${str(firstAction(body).action_id)} in ` +
        `${str(record(body.channel).id)}/${clickThread(body)} on message ` +
        `${str(record(body.message).ts)}; ${told}`,
    );
  }

  /** Send anyway, or Don't send: the two buttons of the same-folder hold. */
  onHoldDecision = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    const action = firstAction(body);
    await this.parts.inbound.answer(
      { channel, thread: threadTs },
      str(action.value),
      { type: "hold", send: action.action_id === HOLD_CONTINUE },
      // A click that names no message is still answered: nothing is removed for it.
      text(record(body.message).ts),
    );
  };

  /** Start, in a session's setup: the controls as they stand ride on the click. */
  onSetupStart = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    await this.parts.inbound.answer(
      { channel, thread: threadTs },
      str(firstAction(body).value),
      { type: "setup", selection: readSelection(record(body.state).values) },
      text(record(body.message).ts),
    );
  };

  /**
   * A new model changes which efforts exist: the message is rewritten with the levels of the
   * model now chosen, keeping the rest. An edit never rings a phone.
   */
  onSetupModel = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const { holds, limiter, slack } = this.parts;
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    const shownAt = messageTs(body);
    const setupId = holds.atMessage(channel, threadTs, shownAt);
    if (setupId === null && holds.decidedAt(channel, threadTs, shownAt)) {
      // Picked just before Start and handled once Start decided the setup (issue #142): what
      // ends the apply (the summary, `Not sent.` or the error) says what happened.
      this.logRefusedClick("setup model, decided", body, { open_at_message: false, held: true });
      return;
    }
    if (setupId === null) {
      this.logRefusedClick("setup model, no open setup", body, {
        open_at_message: false,
        held: false,
      });
      await this.answers.tellOwner(channel, threadTs, texts.HOLD_GONE);
      return;
    }
    const draw = this.parts.chat.drawnSetup(setupId);
    if (draw === undefined) {
      // Not kept (a long-forgotten request): the controls keep what they showed.
      this.logRefusedClick("setup model, draw not kept", body, { open_at_message: true });
      return;
    }
    const choice = readChoice(record(body.state).values, draw.models);
    try {
      await limiter.acquire();
      // The wait above can outlast Start: a decided setup now shows its summary, which this
      // edit must not overwrite.
      if (holds.atMessage(channel, threadTs, shownAt) !== setupId || this.answers.stopped) return;
      await slack.chat.update({
        channel,
        ts: shownAt,
        text: texts.SETUP_FALLBACK,
        blocks: setupBlocks(setupId, draw, choice) as unknown as KnownBlock[],
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      // The controls keep what they showed; Start still reads the model and the effort.
      logger.warning(`could not update a setup message in ${channel}: ${describe(error)}`);
    }
  };

  /** An effort or bypass change needs nothing: Start reads every control's state. */
  onSetupEdit = async (ack: Ack): Promise<void> => {
    await ack();
  };

  /** Approve, Deny or Skip on a request of the agent's. */
  onDecision = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    const action = firstAction(body);
    const answer: OwnerAnswer =
      action.action_id === QUESTION_SKIP
        ? { type: "question", answers: null, notes: {} }
        : { type: "permission", allow: action.action_id === APPROVAL_ALLOW };
    await this.parts.inbound.answer(
      { channel, thread: threadTs },
      str(action.value),
      answer,
      text(record(body.message).ts),
    );
  };

  /**
   * A change in the form of a single select, dispatched by Slack with the form's state (block
   * reference, input block `dispatch_action` and `dispatch_action_config`; block_actions payload
   * reference; `views.update`, all read 2026-10-16): an option picked while a text stands under
   * Other, or a character typed there while an option stands. The one that was not just changed
   * is emptied in a single `views.update`; typing then goes on with no further call. `hash`
   * makes a stale payload (the keystroke after the first) a `hash_conflict`, which is ignored.
   * Submit reads the state again, so a missed update costs a second click on the right field.
   */
  private onQuestionLive = async (ack: Ack, body: Payload, changed: Field): Promise<void> => {
    await ack();
    const { approvals, identity, slack } = this.parts;
    const [user, team] = interactionActor(body);
    // (sync) The owner and the workspace, as on Next; the channel is checked at Submit.
    if (!isOwner(identity, user, team)) {
      logger.info("ignored an inbound event from someone other than the owner");
      return;
    }
    const view = record(body.view);
    if (view.callback_id !== QUESTION_FORM) return;
    let draft: Draft;
    try {
      draft = loadDraft(str(view.private_metadata));
    } catch {
      return;
    }
    const questions = approvals.questions(draft.approvalId, draft.channelId, draft.threadTs);
    if (questions === null) return;
    const cleared = excluding(absorb(draft, record(view.state).values), questions, changed);
    const viewId = text(view.id);
    if (cleared === null || viewId === null || this.answers.stopped) return;
    const hash = text(view.hash);
    try {
      await slack.views.update({
        view_id: viewId,
        ...(hash === null ? {} : { hash }),
        view: questionView(cleared, questions, this.parts.names) as unknown as ModalView,
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      // hash_conflict (a newer payload moved the form on) or not_found (closed): Submit reads
      // the state as it stands.
      logger.warning(`could not update the question form: ${describe(error)}`);
    }
  };

  /**
   * An option picked in a single select's form. A multi-select's checkboxes dispatch nothing;
   * their values are read when Submit is clicked.
   */
  onQuestionChoice = (ack: Ack, body: Payload): Promise<void> =>
    this.onQuestionLive(ack, body, "choice");

  /** A character typed under Other in a single select's form. */
  onQuestionOther = (ack: Ack, body: Payload): Promise<void> =>
    this.onQuestionLive(ack, body, "other");

  /**
   * Answer, on a question of Claude's: opens the form, then checks the channel. The form shows
   * the owner alone what the request already shows, and Submit checks the channel again before
   * anything reaches the agent; a refused channel turns the open form into the reason.
   */
  onQuestionOpen = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const { approvals, guard, names, slack } = this.parts;
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!this.answers.fromOwner(user, team, channel) || channel === null) return;
    const approvalId = str(firstAction(body).value);
    const questions = approvals.questions(approvalId, channel, threadTs);
    if (questions === null) {
      await this.answers.tellOwner(channel, threadTs, texts.APPROVAL_GONE);
      return;
    }
    // trigger_id lives 3 seconds: no network call before this one (#325).
    const view = questionView(newDraft(approvalId, channel, threadTs), questions, names);
    let opened: { id?: string; hash?: string } | undefined;
    try {
      const trigger = text(body.trigger_id);
      if (trigger === null) throw new TypeError("the click carries no trigger_id");
      const answer = await slack.views.open({
        trigger_id: trigger,
        view: view as unknown as ModalView,
      });
      opened = answer.view;
    } catch (error) {
      if (isCancelled(error)) throw error;
      // an expired trigger_id, say: the turn must not wait unseen
      const message = fill(slackTexts.QUESTION_NOT_OPENED, { error: describe(error) });
      await this.answers.tellOwner(channel, threadTs, message);
      return;
    }
    if (this.answers.stopped) return;
    const reason = await guard.refusal(channel);
    if (this.answers.stopped || reason === null) return;
    const told = fill(slackTexts.CHANNEL_REFUSED, { reason });
    try {
      if (opened?.id === undefined) throw new TypeError("views.open answered no view id");
      // The hash it was opened with: a Next clicked meanwhile is not overwritten.
      await slack.views.update({
        view_id: opened.id,
        ...(opened.hash === undefined ? {} : { hash: opened.hash }),
        view: refusedView(told, names) as unknown as ModalView,
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      // Closed, or moved on: Submit refuses it, and the owner learns why here.
      logger.warning(`could not show the refusal in the question form: ${describe(error)}`);
      await this.answers.tellOwner(channel, threadTs, told);
    }
  };

  /**
   * Next or Submit, in the question form. Slack wants the answer within 3 seconds, and a missing
   * answer can only be shown in it: the checks before it make no network call. The channel is
   * checked before acting.
   */
  onQuestionSubmit = async (ack: Ack, body: Payload): Promise<void> => {
    const { approvals, identity } = this.parts;
    const [user, team] = interactionActor(body);
    const view = record(body.view);
    let draft: Draft;
    try {
      draft = loadDraft(str(view.private_metadata));
    } catch {
      await ack();
      return;
    }
    if (!isOwner(identity, user, team)) {
      await ack();
      logger.info("ignored an inbound event from someone other than the owner");
      return;
    }
    const questions = approvals.questions(draft.approvalId, draft.channelId, draft.threadTs);
    if (questions === null) {
      await ack();
      await this.answers.tellOwner(draft.channelId, draft.threadTs, texts.APPROVAL_GONE);
      return;
    }
    draft = absorb(draft, record(view.state).values);
    if (!isAnswered(draft, questions, draft.active)) {
      await ack({
        response_action: "errors",
        errors: { [blockIdIn(draft, "choice", draft.active)]: slackTexts.QUESTION_MISSING },
      });
      return;
    }
    const missing = firstUnanswered(draft, questions);
    if (missing !== null) {
      // Next: the following question, or one left unanswered (never, since each Next checks
      // its own; kept so a draft cannot reach Claude incomplete).
      const following = draft.active + 1 < questions.length ? draft.active + 1 : missing;
      await ack({
        response_action: "update",
        view: questionView({ ...draft, active: following }, questions, this.parts.names),
      });
      return;
    }

    await ack();
    if (!(await this.answers.admitted(user, team, draft.channelId, draft.threadTs))) return;
    const given = draftAnswers(draft, questions);
    if (given === null) throw new Error("a draft with every question answered has no answers");
    // The form is no message of the thread: the session that asked decides what becomes of the
    // request message (`ThreadSession` keeps the answers in the reply, or in the request).
    await this.parts.inbound.answer(
      { channel: draft.channelId, thread: draft.threadTs },
      draft.approvalId,
      { type: "question", ...given },
      null,
    );
  };
}

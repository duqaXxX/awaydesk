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
  type Draft,
  draftAnswers,
  type FormIds,
  firstIncomplete,
  isAnswered,
  loadIds,
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
  /**
   * What the owner filled in each open question form, by request id: kept here, not in the
   * view's `private_metadata` (which holds the request's ids, the form's generation and its
   * page), so Other and Notes are bound by no
   * Slack limit and Answer reopens a closed form with the answers kept. An entry goes when its
   * request is answered, skipped or found gone, at the next Answer for any request that ended
   * another way, and when the app closes.
   */
  readonly drafts = new Map<string, Draft>();

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /** Drops the drafts of requests that no longer wait for an answer. */
  private sweep(): void {
    for (const [approvalId, draft] of this.drafts) {
      if (this.parts.approvals.questions(approvalId, draft.channelId, draft.threadTs) === null) {
        this.drafts.delete(approvalId);
      }
    }
  }

  /** Gives up the drafts: the daemon is stopping. */
  close(): void {
    this.drafts.clear();
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
    if (action.action_id === QUESTION_SKIP) this.drafts.delete(str(action.value));
    await this.parts.inbound.answer(
      { channel, thread: threadTs },
      str(action.value),
      answer,
      text(record(body.message).ts),
    );
  };

  /**
   * A change in the question form, dispatched by Slack with the form's state (block reference,
   * input block `dispatch_action` and `dispatch_action_config`; block_actions payload reference;
   * `views.update`, all read 2026-10-16). Every field reports, so the draft holds what is on
   * screen when the form is closed with Later. Only a change of the choice redraws, with Other's
   * field and Notes as the new choice needs them, in one `views.update`; typing never does. `hash`
   * makes a stale payload a `hash_conflict`, which is ignored. Submit reads the state again. Only
   * the newest form of a request counts (`Draft.generation`) and only the page it shows now
   * (`FormIds`); anything else is ignored.
   */
  private onQuestionLive = async (ack: Ack, body: Payload, redraw: boolean): Promise<void> => {
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
    let ids: FormIds;
    try {
      ids = loadIds(str(view.private_metadata));
    } catch {
      return;
    }
    const questions = approvals.questions(ids.approvalId, ids.channelId, ids.threadTs);
    if (questions === null) {
      this.drafts.delete(ids.approvalId);
      return;
    }
    // Only the newest form of the request counts, and only the page it shows now: a late change
    // from an older form, or from a page Next has left, writes nothing.
    const kept = this.drafts.get(ids.approvalId);
    if (kept === undefined || kept.generation !== ids.generation || kept.active !== ids.active) {
      return;
    }
    // (sync) Kept before any await: a payload handled next finds what this one saw.
    const draft = absorb(kept, record(view.state).values);
    this.drafts.set(ids.approvalId, draft);
    const viewId = text(view.id);
    if (!redraw || viewId === null || this.answers.stopped) return;
    const hash = text(view.hash);
    try {
      await slack.views.update({
        view_id: viewId,
        ...(hash === null ? {} : { hash }),
        view: questionView(draft, questions, this.parts.names) as unknown as ModalView,
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      // hash_conflict (a newer payload moved the form on) or not_found (closed): Submit reads
      // the state as it stands.
      logger.warning(`could not update the question form: ${describe(error)}`);
    }
  };

  /** An option picked, or a box ticked, in the question form: the form is drawn again. */
  onQuestionChoice = (ack: Ack, body: Payload): Promise<void> =>
    this.onQuestionLive(ack, body, true);

  /** A character typed under Other or in Notes in the question form: the draft alone changes. */
  onQuestionTyping = (ack: Ack, body: Payload): Promise<void> =>
    this.onQuestionLive(ack, body, false);

  /**
   * Back, in the question form: the page before, with every answer kept. The payload's state
   * holds what the page on screen shows, so it is absorbed into the draft first (Back never
   * validates), then the form is redrawn with `views.update` (block_actions payload and
   * `views.update` references, read 2026-10-16). It checks the owner and the workspace like any
   * inbound path, follows the newest-form rule of `onQuestionLive` and never reaches the core.
   * The draft's page moves before the call so that a late change from the page left is ignored;
   * when Slack refuses the update (`hash_conflict`: the form moved on, `not_found`: it closed)
   * the page goes back to the one still on screen.
   */
  onQuestionBack = async (ack: Ack, body: Payload): Promise<void> => {
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
    let ids: FormIds;
    try {
      ids = loadIds(str(view.private_metadata));
    } catch {
      return;
    }
    const questions = approvals.questions(ids.approvalId, ids.channelId, ids.threadTs);
    if (questions === null) {
      this.drafts.delete(ids.approvalId);
      return;
    }
    const kept = this.drafts.get(ids.approvalId);
    if (
      kept === undefined ||
      kept.generation !== ids.generation ||
      kept.active !== ids.active ||
      ids.active === 0
    ) {
      return;
    }
    // (sync) Kept before any await: a payload handled next finds what this one saw. The review
    // page has no field to read.
    const shown = questions.length > 1 && ids.active === questions.length;
    const here = shown ? kept : absorb(kept, record(view.state).values);
    const back = { ...here, active: ids.active - 1 };
    this.drafts.set(ids.approvalId, back);
    const viewId = text(view.id);
    if (viewId === null || this.answers.stopped) return;
    const hash = text(view.hash);
    try {
      await slack.views.update({
        view_id: viewId,
        ...(hash === null ? {} : { hash }),
        view: questionView(back, questions, this.parts.names) as unknown as ModalView,
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      // The form on screen is still the page the click came from.
      if (this.drafts.get(ids.approvalId) === back) this.drafts.set(ids.approvalId, here);
      logger.warning(`could not go back in the question form: ${describe(error)}`);
    }
  };

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
    this.sweep();
    if (questions === null) {
      await this.answers.tellOwner(channel, threadTs, texts.APPROVAL_GONE);
      return;
    }
    // A form closed with Later and opened again shows what was given, on the page it was left
    // on. Every Answer opens a new generation, and the older forms of the request go stale.
    const kept = this.drafts.get(approvalId) ?? newDraft(approvalId, channel, threadTs);
    const draft = { ...kept, generation: kept.generation + 1 };
    this.drafts.set(approvalId, draft);
    // trigger_id lives 3 seconds: no network call before this one (#325).
    const view = questionView(draft, questions, names);
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
      // an expired trigger_id, say: the turn must not wait unseen. The form did not open, so
      // the one still on screen stays the valid one.
      if (this.drafts.get(approvalId) === draft) this.drafts.set(approvalId, kept);
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
   * Next, Review or Submit, in the question form. Slack wants the answer within 3 seconds, and a missing
   * answer can only be shown in it: the checks before it make no network call. The channel is
   * checked before acting.
   */
  onQuestionSubmit = async (ack: Ack, body: Payload): Promise<void> => {
    const { approvals, identity } = this.parts;
    const [user, team] = interactionActor(body);
    const view = record(body.view);
    let ids: FormIds;
    try {
      ids = loadIds(str(view.private_metadata));
    } catch {
      await ack();
      return;
    }
    if (!isOwner(identity, user, team)) {
      await ack();
      logger.info("ignored an inbound event from someone other than the owner");
      return;
    }
    const questions = approvals.questions(ids.approvalId, ids.channelId, ids.threadTs);
    if (questions === null) {
      this.drafts.delete(ids.approvalId);
      await ack();
      await this.answers.tellOwner(ids.channelId, ids.threadTs, texts.APPROVAL_GONE);
      return;
    }
    const state = record(view.state).values;
    // The page after the last question lists the answers (only a form of several has one).
    const reviewing = questions.length > 1 && ids.active === questions.length;
    const kept = this.drafts.get(ids.approvalId);
    if (kept === undefined || kept.generation !== ids.generation) {
      // An older form: it sends nothing, and the newest one is told apart from it. The review
      // page has no field to carry an error, so it is replaced by the reason.
      if (reviewing) {
        await ack({
          response_action: "update",
          view: refusedView(slackTexts.QUESTION_STALE, this.parts.names),
        });
        return;
      }
      await ack({
        response_action: "errors",
        errors: { [`q${ids.active}`]: slackTexts.QUESTION_STALE },
      });
      return;
    }
    const at = ids.active;
    // The review page has no field: its draft is the one kept.
    const draft = reviewing ? { ...kept, active: at } : absorb({ ...kept, active: at }, state);
    this.drafts.set(ids.approvalId, draft);
    if (!reviewing && !isAnswered(draft, questions, at)) {
      if (draft.other.has(at)) {
        // Slack checks the required Other field before this point; reaching here means the
        // redraw that shows it was dropped, so the form is drawn again with the field.
        await ack({
          response_action: "update",
          view: questionView(draft, questions, this.parts.names),
        });
        return;
      }
      await ack({
        response_action: "errors",
        errors: { [`q${at}`]: slackTexts.QUESTION_MISSING },
      });
      return;
    }
    // A form of several questions sends from its review page alone; every other page, the last
    // question included, moves on, whether or not the rest have an answer already.
    const sends = reviewing || questions.length === 1;
    const missing = sends ? firstIncomplete(draft, questions) : null;
    if (!sends || missing !== null) {
      // Each Next checks its own page, so `missing` is never set unless the draft changed under
      // the form; kept so that a draft cannot reach the agent incomplete.
      const next = { ...draft, active: missing ?? at + 1 };
      this.drafts.set(ids.approvalId, next);
      await ack({
        response_action: "update",
        view: questionView(next, questions, this.parts.names),
      });
      return;
    }

    await ack();
    if (!(await this.answers.admitted(user, team, ids.channelId, ids.threadTs))) return;
    const given = draftAnswers(draft, questions);
    if (given === null) throw new Error("a draft with every question answered has no answers");
    this.drafts.delete(ids.approvalId);
    // The form is no message of the thread: the session that asked decides what becomes of the
    // request message (`ThreadSession` keeps the answers in the reply, or in the request).
    await this.parts.inbound.answer(
      { channel: ids.channelId, thread: ids.threadTs },
      ids.approvalId,
      { type: "question", ...given },
      null,
    );
  };
}

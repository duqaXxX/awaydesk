/**
 * A session's setup: the model, the effort and bypass, asked before its first prompt and applied
 * to the live session when the owner starts it. What the choice is checked against, and the line
 * that replaces the request, are the core's; how the controls are drawn is the chat's.
 */
import type { ModelInfo } from "../../agent/seam.ts";
import type { MessageId, SetupRequest, SetupSelection, ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { SessionClosed, SessionGone } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import { type Choice, choiceOf, DEFAULT, DEFAULT_CHOICE, summaryOf } from "../setup.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { askOwner, type Settle } from "./ask-owner.ts";
import type { SetupFlow } from "./contract.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/** The one line that replaces the controls once the owner pressed Start. */
export function summaryLine(models: readonly ModelInfo[], choice: Choice): string {
  const data = summaryOf(models, choice);
  return fill(texts.SETUP_SUMMARY, {
    model: data.model,
    effort: data.effort ?? texts.SETUP_EFFORT_DEFAULT,
    bypass: data.bypass ? "on" : "off",
  });
}

/**
 * The effort levels a setup offers by themselves: the agent's own, for an agent that lists no
 * models. An agent that lists models offers none here, even when its list came back empty:
 * each model names the levels it takes.
 */
export function effortsOffered(deps: FlowDeps): readonly string[] {
  const { capabilities } = deps.agent;
  return capabilities.models ? [] : capabilities.effortLevels;
}

/** Whether the agent has a mode that skips permission requests, which a setup then offers. */
export function bypassOffered(deps: FlowDeps): boolean {
  return deps.agent.capabilities.permissionModes.bypass !== null;
}

/**
 * The owner's choice from the controls they left, held to what the request offered: a model the
 * agent did not list reads as its default, an effort the model (or, for an agent with no model
 * list, the agent) does not take reads as `Default`, and bypass reads as off when none was
 * offered.
 */
export function chosen(
  deps: FlowDeps,
  models: readonly ModelInfo[],
  selection: SetupSelection,
): Choice {
  const choice = choiceOf(models, selection);
  const efforts = effortsOffered(deps);
  const effort =
    efforts.length === 0
      ? choice.effort
      : efforts.includes(selection.effort)
        ? selection.effort
        : DEFAULT;
  return { ...choice, effort, bypass: choice.bypass && bypassOffered(deps) };
}

export function setupFlow(deps: FlowDeps, talk: Talk): SetupFlow {
  /**
   * Ask for the session's model, effort and bypass before its first prompt, and apply the
   * answer to the live session. The session to send the message on, or null when it was not
   * sent, either way telling the owner `Not sent.` already. The session is connected first: the
   * agent's own model list is what the request offers, and a folder that cannot start fails
   * here, before the owner picks anything.
   */
  async function beforeSending(
    ref: ThreadRef,
    asked: ThreadSession,
  ): Promise<ThreadSession | null> {
    const { sessions, state } = deps;
    let session = asked;
    try {
      // First what an earlier, unsent Start left: the session it changed is dropped, so the
      // connect below reads the folder's own mode again.
      await session.forgetSetup();
      await session.ensureConnected();
    } catch (error) {
      if (!(error instanceof SessionClosed)) throw error;
      // Closed during the downloads before this: the retry of the submit never sees this
      // step, so the thread's fresh session is looked up here, as it does.
      const fresh = sessions.get(ref.channel, ref.thread);
      if (fresh === null) throw new SessionGone(deps.names);
      session = fresh;
      await session.ensureConnected();
    }
    const live = session;
    const models = live.models;
    // Ticked when the connect above runs in bypass (a folder whose own settings start the agent
    // so): it is what would run, and unticking is the explicit off.
    const ticked = live.bypass;

    // Apply the choice, then turn the message into its summary line: all of it while the hold
    // is still open, so a stop that lands anywhere in here still cancels.
    const settle: Settle = async (answer, shownAt: MessageId, pending) => {
      // A hold's Continue carries no choice: one answered with a setup's id applies nothing.
      if (answer === true) throw new TypeError("a setup was answered with no choice");
      const choice: Choice = answer;
      await live.applySetup(choice);
      // The message stays as a record of what was set: no longer a request, not deleted.
      try {
        state.removeRequest(ref.channel, ref.thread, shownAt);
      } catch (error) {
        logger.warning(
          `could not clear a setup message from state.json in ${ref.channel}/${ref.thread}: ${errorName(error)}`,
        );
      }
      // Nothing to edit: deleted, or the daemon is gone.
      if (pending.cancelled || talk.stopped) return;
      try {
        await talk.thread(ref).rewrite(shownAt, summaryLine(models, choice));
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not update a setup message in ${ref.channel}: ${errorName(error)}`);
      }
    };

    const answer = await askOwner(deps, talk, ref, live, {
      title: texts.SETUP_FALLBACK,
      request: (requestId): SetupRequest => ({
        type: "setup",
        requestId,
        models,
        efforts: effortsOffered(deps),
        bypassOffered: bypassOffered(deps),
        selection: { ...DEFAULT_CHOICE, bypass: ticked },
      }),
      settle,
      context: models,
    });
    if (answer === null) {
      // A stop or drain that came while Start was applied. Not once the daemon is gone: the
      // state it would rewrite is the next start's.
      if (!talk.stopped) await live.forgetSetup();
      return null;
    }
    return live;
  }

  return { beforeSending };
}

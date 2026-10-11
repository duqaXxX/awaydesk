/**
 * A word of the daemon's own: what each does, and where it is answered. Typed in the channel (or
 * in a thread that holds no session) it is answered by a normal post in the channel; typed
 * inside a session's thread it is answered for the owner alone under the owner's message, or by
 * a mark on it, so nothing rings a phone; `!stop` is answered by a post that stays in the
 * thread, and `!open` shows its files there.
 */
import type { MessageId, ThreadRef } from "../../chat/seam.ts";
import { helpText, WORD, type Word } from "../commands.ts";
import { BypassUnavailable } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { OtherFlows } from "./contract.ts";
import { channelStatus } from "./status.ts";
import type { FlowDeps, Talk } from "./talk.ts";

/** Where a word was typed. */
export interface WordPlace {
  /** The live session of the thread it was typed in; null in the channel, or in a thread with none. */
  readonly session: ThreadSession | null;
  /**
   * A thread that holds no session: a word typed there reads as being about that thread, so
   * the ones that act on the whole channel (`!stop`, `!resume`, `!bind` with a folder) say where
   * to send them, for the owner alone, and change nothing.
   */
  readonly outside: boolean;
}

/** What a word does. `message` is the word's own message in the chat. */
export type WordFlow = (
  ref: ThreadRef,
  message: MessageId,
  command: Word,
  place: WordPlace,
) => Promise<void>;

export function wordFlow(deps: FlowDeps, talk: Talk, others: OtherFlows): WordFlow {
  const { chat, agent, sessions, names } = deps;
  const status = channelStatus(deps, talk);

  return async (ref, message, command, { session, outside }) => {
    const { channel, thread } = ref;
    const where = session === null ? null : thread;
    const quiet = session !== null;
    switch (command.kind) {
      case "help":
      case "invalid": {
        // A mistyped word gets the full list, which shows how each word is written.
        const query = command.kind === "help" ? command.query : "";
        if (session !== null) await session.ensureConnected();
        const commands = session === null ? null : session.commands;
        await talk.say(
          channel,
          where,
          helpText(
            commands,
            query,
            (text) => chat.escape(text, "reference"),
            names,
            agent.capabilities.commands,
          ),
          { ownerOnly: quiet },
        );
        return;
      }
      case "guide":
        await talk.say(channel, where, named(texts.GUIDE, names), { ownerOnly: quiet });
        return;
      case "bind":
        if (session !== null || (outside && command.path)) {
          await talk.tell(ref, fill(texts.WORD_IN_THREAD, { word: WORD.bind }));
        } else if (command.path) {
          await others.bind.to(channel, command.path);
        } else {
          await others.bind.list(channel);
        }
        return;
      case "bypass": {
        if (session === null) {
          await talk.inChannel(channel, texts.BYPASS_TOP_LEVEL);
          return;
        }
        let switched: boolean;
        try {
          switched = await session.switchBypass(command.on);
        } catch (error) {
          if (!(error instanceof BypassUnavailable)) throw error;
          await talk.tell(ref, named(texts.BYPASS_UNAVAILABLE, names));
          return;
        }
        if (!switched) {
          // Start writes the setup's box over the switch (`applySetup`): one flipped before
          // it would not hold, so the word changed nothing.
          await talk.tell(ref, texts.BYPASS_BEFORE_START);
        } else {
          // Both: the line says what changed and is gone on reload, the mark stays.
          await talk.acknowledge(ref, message);
          await talk.tell(
            ref,
            command.on ? texts.BYPASS_ON_THREAD : named(texts.BYPASS_OFF_THREAD, names),
          );
        }
        return;
      }
      case "status":
        if (session === null) await status(channel);
        else await talk.say(channel, thread, await session.status(), { ownerOnly: true });
        return;
      case "stop":
        if (outside) {
          await talk.tell(ref, texts.STOP_OUTSIDE_SESSION);
        } else if (session === null) {
          const stopped = await sessions.stopChannel(channel);
          // null: only a hold was cancelled somewhere in the channel (`Not sent.`, from its
          // own waiter); no second notice, since nothing the agent was doing stopped.
          if (stopped !== null) {
            await talk.inChannel(channel, stopped ? texts.STOPPED_CHANNEL : texts.NOTHING_TO_STOP);
          }
        } else {
          // Either answer is a post that stays in the thread: a line for the owner alone is
          // gone on reload, and the root's mark alone does not say a stop was received. null:
          // only a hold was cancelled, which already said `Not sent.` from its own waiter.
          const stopped = await session.stop();
          if (stopped) {
            // The answer goes under the ending and the footer of the reply the stop cut
            // short, which may be a message of its own.
            await session.stopLanded();
          }
          if (stopped !== null) {
            await talk.tell(ref, stopped ? texts.STOPPED_THREAD : texts.NOTHING_TO_STOP_THREAD, {
              stays: true,
            });
          }
        }
        return;
      case "open":
        if (session === null) {
          await talk.inChannel(channel, texts.OPEN_TOP_LEVEL);
        } else if (!chat.capabilities.fileUpload || chat.openFile === undefined) {
          await talk.tell(ref, named(texts.OPEN_UNAVAILABLE, names));
        } else {
          await chat.openFile(ref, session.directory, command.target);
        }
        return;
      case "resume":
        if (session !== null || outside) {
          await talk.tell(ref, fill(texts.WORD_IN_THREAD, { word: WORD.resume }));
        } else {
          await others.resume.word(ref, command.target);
        }
        return;
    }
  };
}

/**
 * `!resume`, typed or picked from the list of sessions: which stored session a thread
 * continues. The core decides which sessions the list holds, which one a typed name means and
 * what follows a pick; the chat draws the list.
 */
import type { ListedSession } from "../../agent/seam.ts";
import type { ListPick, MessageId, ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { oneLine } from "../reply/words.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { ResumeFlow } from "./contract.ts";
import { type FlowDeps, isCancelled, logger, type Talk, TITLE_LIMIT } from "./talk.ts";

/**
 * The fewest characters of a session's id that `!resume` reads as an id and not as a name: what
 * a list shows of each row, so that a short title such as "add" is not read as one.
 */
export const ID_PREFIX_MIN = 8;

// The words that label a link to a thread inside a notice.
const HOLDER_LABEL = "Session";
const THIS_THREAD = "this thread";

/**
 * The sessions `!resume <target>` names: those whose id is `target` or starts with it, when it
 * is at least `ID_PREFIX_MIN` characters long, else those whose title (set with a rename or
 * generated, the agent's `customTitle`) is `target`.
 */
export function matching(sessions: readonly ListedSession[], target: string): ListedSession[] {
  const byId = sessions.filter(
    (s) => Array.from(target).length >= ID_PREFIX_MIN && s.id.startsWith(target),
  );
  return byId.length > 0 ? byId : sessions.filter((s) => s.customTitle === target);
}

/** A session picked from the list, and what follows `!resume`. */
export interface Resuming extends ResumeFlow {
  /** The pick of a session from a list `word()` posted. */
  picked(pick: Extract<ListPick, { type: "session" }>): Promise<void>;
}

export function resuming(deps: FlowDeps, talk: Talk): Resuming {
  const { agent, chat, sessions, state, names } = deps;
  const inNotice = (text: string): string => chat.escape(text, "notice");

  /**
   * The list has done its job once a session is resumed from it. With `remove`, the
   * confirmation is in the thread and is the one record of what was resumed: the list is
   * removed (issue #70). Without it, or when the removal fails, the list is rewritten into a
   * line that says what was resumed and where, so its controls never stay live.
   */
  const showResumed = async (
    ref: ThreadRef,
    list: MessageId | null,
    chosen: ListedSession,
    options: { readonly remove: boolean },
  ): Promise<void> => {
    if (list === null || talk.stopped) return;
    const picker = chat.channel(ref.channel);
    if (options.remove && (await picker.withdraw(list))) return;
    const title = inNotice(oneLine(chosen.title, TITLE_LIMIT)) || chosen.id;
    const link = await talk.noticeLink(ref, THIS_THREAD);
    try {
      await picker.rewrite(list, fill(texts.RESUME_LISTED, { title, link }));
    } catch (error) {
      if (isCancelled(error)) throw error;
      // The session is resumed either way; a list that keeps its controls only refuses.
      logger.warning(`could not update the resume list in ${ref.channel}: ${errorName(error)}`);
    }
  };

  /**
   * Point the thread `ref` at `chosen`, a session read from `directory`; false, after telling
   * the owner why in the channel, when nothing changed: that thread already holds a session (a
   * resume is never a swap), `chosen` is already held by some other thread (one session lives
   * in one thread), or the channel was bound to another folder while `chosen` was read from
   * `directory`. Every check runs with no `await` before the `resume` they guard, so nothing
   * can change between the checks and the call they protect. `list`: the list a pick came from,
   * removed once the confirmation is posted or has failed, so its controls never outlive a
   * resume.
   */
  const resumeInto = async (
    ref: ThreadRef,
    directory: string,
    chosen: ListedSession,
    list: MessageId | null = null,
  ): Promise<boolean> => {
    const { channel, thread } = ref;
    // (sync) From here to `sessions.resume`, which opens the thread's entry inside the call:
    // each refusal below leaves through its own `await`, and nothing is awaited on the way
    // to the resume itself.
    // A thread being deleted still holds its session's entry, and hands out no session.
    if (sessions.get(channel, thread) !== null || sessions.held(channel, thread)) {
      await talk.inChannel(channel, texts.RESUME_HELD);
      return false;
    }
    const holder = state.holder(chosen.id);
    if (holder !== null) {
      const link = await talk.noticeLink(holder, HOLDER_LABEL);
      await talk.inChannel(channel, fill(texts.RESUME_ELSEWHERE, { link }));
      return false;
    }
    const record = state.channel(channel);
    if (record === null || record.directory !== directory) {
      await talk.inChannel(channel, texts.RESUME_GONE);
      return false;
    }
    const session = await sessions.resume(channel, thread, chosen.id);
    // just confirmed the channel is bound to `directory`
    if (session === null) throw new Error("a bound channel resumed no session");
    // A reference, not a notice: the title is escaped so it cannot close or open the bold.
    const title = chat.escape(oneLine(chosen.title, TITLE_LIMIT), "reference") || chosen.id;
    let confirmed = false;
    try {
      await talk.say(channel, thread, fill(texts.RESUME_OK, { title }));
      confirmed = true;
    } finally {
      // Independent of the confirmation: a failing one still takes the list's controls away,
      // and a failure there (swallowed in `showResumed`) never blocks it. With no
      // confirmation in the thread the list is kept, rewritten, as the record.
      await showResumed(ref, list, chosen, { remove: confirmed });
    }
    return true;
  };

  return {
    async word(ref, target) {
      const { channel } = ref;
      const record = state.channel(channel);
      if (record === null) {
        await talk.unbound(channel);
        return;
      }
      if (!agent.capabilities.sessionListing) {
        await talk.inChannel(channel, named(texts.RESUME_UNLISTED, names));
        return;
      }
      const directory = record.directory;
      const stored = await sessions.sessionsIn(directory);
      if (!target) {
        // A session a thread already holds cannot be resumed: it takes no row, so the rows are
        // the ones the owner can pick (issue #69). Only the list shows dates, and dating reads
        // files: the sessions left out are not dated.
        const free = stored.filter((session) => state.holder(session.id) === null);
        await chat.channel(channel).offer(
          {
            type: "sessions",
            folder: directory,
            sessions: await sessions.dated(directory, free),
            held: stored.length - free.length,
            thread: ref,
          },
          fill(texts.RESUME_LIST, { directory }),
        );
        return;
      }
      const found = matching(stored, target);
      const [only] = found;
      if (found.length !== 1 || only === undefined) {
        const template = found.length > 0 ? texts.RESUME_AMBIGUOUS : texts.RESUME_NONE;
        await talk.inChannel(
          channel,
          fill(template, { directory: inNotice(directory), target: inNotice(target) }),
        );
        return;
      }
      await resumeInto(ref, directory, only);
    },

    async picked(pick) {
      const { channel } = pick;
      const record = state.channel(channel);
      if (record === null) {
        await talk.unbound(channel);
        return;
      }
      // The pick is not trusted: the session must still belong to the channel's folder, and
      // the thread it names must be well formed (`resumeInto` refuses one that already holds a
      // session).
      if (pick.thread === null) {
        // A list posted before its controls carried their thread.
        await talk.inChannel(channel, texts.RESUME_STALE);
        return;
      }
      const stored = await sessions.sessionsIn(record.directory);
      const chosen = stored.find((session) => session.id === pick.sessionId);
      if (chosen === undefined) {
        await talk.inChannel(channel, texts.RESUME_GONE);
        return;
      }
      // The channel is the one checked above: the thread names only where in it.
      const ref = { channel, thread: pick.thread.thread };
      await resumeInto(ref, record.directory, chosen, pick.list);
    },
  };
}

/**
 * The words that post a list in a channel, and what follows a pick from one: `!resume` with a
 * folder's sessions, `!bind` with the folders a session can start in. The core decides what is
 * offered, which rows the list holds and what a pick does; the chat provider draws the list and
 * checks that it was the owner who picked.
 */
import { binding } from "./bind.ts";
import type { BindFlow, PicksFlow, ResumeFlow } from "./contract.ts";
import { resuming } from "./resume.ts";
import type { FlowDeps, Talk } from "./talk.ts";

/** The three flows of this file, over one set of stores. */
export interface Lists {
  readonly resume: ResumeFlow;
  readonly bind: BindFlow;
  readonly picks: PicksFlow;
}

export function lists(deps: FlowDeps, talk: Talk): Lists {
  const bind = binding(deps, talk);
  const resume = resuming(deps, talk);
  return {
    resume: { word: resume.word },
    bind: { to: bind.to, list: bind.list },
    picks: {
      // A failure after the provider's checks reaches the owner in the channel, where the list
      // was posted. The thread of the guard is the list's own: it names a message of the channel.
      picked: (pick) =>
        talk.replyOnFailure(
          { channel: pick.channel, thread: pick.list },
          () => (pick.type === "folder" ? bind.picked(pick) : resume.picked(pick)),
          (told) => talk.inChannel(pick.channel, told),
        ),
    },
  };
}

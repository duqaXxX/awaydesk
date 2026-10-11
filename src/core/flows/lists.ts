/**
 * The words that post a list in a channel, and what follows a pick from one: `!resume` with a
 * folder's sessions, `!bind` with the folders a session can start in.
 */
import type { BindFlow, PicksFlow, ResumeFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

/** The three flows of this file, over one set of stores. */
export interface Lists {
  readonly resume: ResumeFlow;
  readonly bind: BindFlow;
  readonly picks: PicksFlow;
}

export function lists(_deps: FlowDeps, _talk: Talk): Lists {
  const missing = (): never => {
    throw new Error("the lists are not a flow of the core yet");
  };
  return {
    resume: { word: missing },
    bind: { to: missing, list: missing },
    picks: { picked: missing },
  };
}

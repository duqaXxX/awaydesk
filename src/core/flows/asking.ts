/**
 * The questions the daemon and the agent put to the owner, and what follows each answer: a
 * tool's permission, the agent's questions, the same-folder hold, a session's setup.
 */
import type { AnswersFlow, HoldFlow, SetupFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

/** The three flows of this file, over one set of stores. */
export interface Asking {
  readonly setup: SetupFlow;
  readonly hold: HoldFlow;
  readonly answers: AnswersFlow;
}

export function asking(_deps: FlowDeps, _talk: Talk): Asking {
  const missing = (): never => {
    throw new Error("the requests are not a flow of the core yet");
  };
  return {
    setup: { beforeSending: missing },
    hold: { beforeSending: missing },
    answers: { answer: missing },
  };
}

/** Every flow of the core, built over one set of stores and wired to one another. */
import { asking } from "./asking.ts";
import type { OtherFlows } from "./contract.ts";
import { Inbound } from "./inbound.ts";
import { lists } from "./lists.ts";
import { messages } from "./messages.ts";
import { type FlowDeps, Talk } from "./talk.ts";

export interface Built {
  /** What the chat provider calls when the owner did something. */
  readonly inbound: Inbound;
  /** The flows a provider's own code still calls, until the message flow is the core's. */
  readonly flows: OtherFlows;
}

export function buildFlows(deps: FlowDeps): Built {
  const talk = new Talk(deps);
  const { setup, hold, answers } = asking(deps, talk);
  const { resume, bind, picks } = lists(deps, talk);
  const flows: OtherFlows = { setup, hold, resume, bind };
  const all = messages(deps, talk, flows);
  return {
    inbound: new Inbound({
      message: (message) => all.message(message),
      answer: (ref, requestId, answer, message) => answers.answer(ref, requestId, answer, message),
      picked: (pick) => picks.picked(pick),
    }),
    flows,
  };
}

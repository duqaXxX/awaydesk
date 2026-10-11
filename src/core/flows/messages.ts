/**
 * A message the owner wrote: read as a word of the daemon's, a command of the agent's or a
 * prompt, and sent to its thread's session after the setup and the hold when either is due.
 */
import type { MessagesFlow, OtherFlows } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

export function messages(_deps: FlowDeps, _talk: Talk, _others: OtherFlows): MessagesFlow {
  return {
    message: () => {
      throw new Error("the messages are not a flow of the core yet");
    },
  };
}

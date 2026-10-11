/**
 * The core's side of the chat seam's inbound half: what a provider calls when the owner did
 * something. Each member hands the call to the flow that decides what follows.
 */
import type {
  ChatInbound,
  InboundMessage,
  ListPick,
  MessageId,
  OwnerAnswer,
  ThreadRef,
} from "../../chat/seam.ts";

/** The flows a call is handed to; one that is absent is not in the core yet. */
export interface Flows {
  readonly message?: (message: InboundMessage) => Promise<void>;
  readonly answer?: (
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ) => Promise<boolean>;
  readonly picked?: (pick: ListPick) => Promise<void>;
}

export class Inbound implements ChatInbound {
  readonly #flows: Flows;

  constructor(flows: Flows = {}) {
    this.#flows = flows;
  }

  message(message: InboundMessage): Promise<void> {
    return this.#flow("message")(message);
  }

  answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean> {
    return this.#flow("answer")(ref, requestId, answer, message);
  }

  picked(pick: ListPick): Promise<void> {
    return this.#flow("picked")(pick);
  }

  #flow<Name extends keyof Flows>(name: Name): NonNullable<Flows[Name]> {
    const flow = this.#flows[name];
    if (flow === undefined) throw new Error(`the core has no flow for ${name}`);
    return flow as NonNullable<Flows[Name]>;
  }
}

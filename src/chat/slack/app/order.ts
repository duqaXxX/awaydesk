/**
 * The places of the messages of one thread, in the order their listeners were called. A listener
 * takes its place (`enter`) before its first await, so the channel check that follows, which
 * takes longer for one message than for the next, cannot reorder them; it leaves the place when
 * it has handed its message to the core, whose own ordering holds from there (`arrival` in
 * `core/flows/messages.ts`).
 */

/** One message's place among its thread's. */
export interface Place {
  /** Settles when every place entered before this one has been left. */
  readonly turn: Promise<void>;
  /** Gives the place up: the next one's turn comes. Calling it again does nothing. */
  leave(): void;
}

export class ThreadOrder {
  // The last place entered, by thread. A thread is in the map only while a place of it is held
  // or waits: a channel keeps opening threads for as long as it runs.
  readonly #last = new Map<string, Promise<void>>();

  /** The threads that hold or await a place. */
  get size(): number {
    return this.#last.size;
  }

  /** The next place of `key`, taken now. */
  enter(key: string): Place {
    const before = this.#last.get(key) ?? Promise.resolve();
    let left!: () => void;
    const mine = new Promise<void>((resolve) => {
      left = resolve;
    });
    this.#last.set(key, mine);
    return {
      turn: before,
      leave: () => {
        if (this.#last.get(key) === mine) this.#last.delete(key);
        left();
      },
    };
  }
}

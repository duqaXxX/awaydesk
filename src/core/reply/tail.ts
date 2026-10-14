/**
 * Where a thread's list of what still runs is drawn. A pure function of the order of the
 * messages, so a provider can ask it again after every change. The footer is not placed here: the
 * session decides it, once, and a provider draws it under the app's last message.
 */

/** One reply that has a message in the thread, as the thread's order sees it. */
export interface TailEntry<K> {
  readonly key: K;
  /** Where its last message sits: a larger number is lower in the thread. */
  readonly at: number;
  /** Its turn has ended and its last message can be rewritten. */
  readonly resting: boolean;
}

/** What a reply shows under its last message. */
export interface Tail {
  /** Whether the list of what still runs is drawn here. */
  readonly running: boolean;
}

/** For each entry, what it shows: the list goes to the lowest resting reply of the thread. */
export function tails<K>(entries: readonly TailEntry<K>[]): Map<K, Tail> {
  const lowest = entries
    .filter((entry) => entry.resting)
    .reduce<TailEntry<K> | undefined>(
      (found, entry) => (found === undefined || entry.at > found.at ? entry : found),
      undefined,
    );
  return new Map(entries.map((entry) => [entry.key, { running: entry === lowest }]));
}

/** Nothing of the owner's and no other reply sits below `at`. */
export function isLast(
  at: number,
  others: readonly number[],
  ownerMarks: readonly number[],
): boolean {
  return others.every((other) => other < at) && ownerMarks.every((mark) => mark < at);
}

/** Another reply has a message below `at`. */
export function isOvertaken(at: number, others: readonly number[]): boolean {
  return others.some((other) => other > at);
}

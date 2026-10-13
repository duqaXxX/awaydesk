/**
 * Where a thread's footer and its list of what still runs are drawn. A pure function of the order
 * of the messages, so a provider can ask it again after every change.
 */

/** One reply that has a message in the thread, as the thread's order sees it. */
export interface TailEntry<K, F> {
  readonly key: K;
  /** Where its last message sits: a larger number is lower in the thread. */
  readonly at: number;
  /** Its turn has ended and its last message can be rewritten. */
  readonly resting: boolean;
  /** The footer its last ended turn left; null when that turn had none. */
  readonly footer: F | null;
}

/** What a reply shows under its last message. */
export interface Tail<F> {
  readonly footer: F | null;
  /** Whether the list of what still runs is drawn here. */
  readonly running: boolean;
}

/**
 * For each entry, what it shows. `ownerMarks` are the positions of the owner's messages: they cut
 * the thread into stretches, and each stretch keeps one footer, on its lowest resting reply.
 */
export function tails<K, F>(
  entries: readonly TailEntry<K, F>[],
  ownerMarks: readonly number[],
): Map<K, Tail<F>> {
  const stretchOf = (at: number) => ownerMarks.filter((mark) => mark < at).length;
  const resting = entries.filter((entry) => entry.resting).sort((a, b) => a.at - b.at);
  const lowest = resting.at(-1);
  const result = new Map<K, Tail<F>>();
  for (const entry of entries) result.set(entry.key, { footer: null, running: false });
  const stretches = new Map<number, TailEntry<K, F>[]>();
  for (const entry of resting) {
    const stretch = stretchOf(entry.at);
    stretches.set(stretch, [...(stretches.get(stretch) ?? []), entry]);
  }
  for (const members of stretches.values()) {
    const holder = members[members.length - 1] as TailEntry<K, F>;
    // The holder is the lowest resting reply, but the footer is the latest one a turn left: a
    // lower reply with none must not blank the stretch.
    const source = members.findLast((member) => member.footer !== null);
    result.set(holder.key, { footer: source?.footer ?? null, running: holder === lowest });
  }
  return result;
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

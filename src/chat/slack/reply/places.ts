/**
 * Where the messages of one thread sit, as far as the daemon saw them: the owner's, and the last
 * message of each reply. Kept in memory only (a restart forgets it), and decided by `isLast`,
 * `isOvertaken` and `tails` of the core. A reply the places let go of leaves its position behind
 * in `floor`, so that the answers do not change when it goes, and keeps showing what it showed.
 */

import {
  isLast,
  isOvertaken,
  Mutex,
  type Tail,
  type TailEntry,
  tails,
} from "../../../core/port.ts";

/**
 * A Slack `ts` as an integer of microseconds: exact below 2^53, ordered as the thread is. Null
 * for text that is no `ts`, which no position is made of.
 */
export function positionOf(ts: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(ts)) return null;
  const [seconds = "0", fraction = ""] = ts.split(".");
  const position = Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
  return Number.isSafeInteger(position) ? position : null;
}

/** What the places need of a reply. `ReplySink` implements it. */
export interface Placed {
  /** The position of its last message, null while it has none. */
  readonly lastAt: number | null;
  /** Its end has landed: its last message can be rewritten. */
  readonly resting: boolean;
  /** The footer its turn left, formatted; null when that turn had none. */
  readonly ownFooter: string | null;
  /** What it shows under its last message from now on. */
  assign(tail: Tail<string>): void;
}

export class ThreadPlaces {
  /**
   * Held by whoever creates a message of a reply in this thread (a stream's start, a
   * continuation, an ending, a closing message), and by the end's decision whether to create one:
   * two replies cannot each decide on the other's absence. Taken after a sink's own lock, and
   * never while waiting for one.
   */
  readonly lock = new Mutex();
  private readonly replies = new Set<Placed>();
  /** The replies whose end has landed. */
  private readonly done = new Set<Placed>();
  /** The replies whose opening thread object closed. */
  private readonly shut = new Set<Placed>();
  private marks: number[] = [];
  /** The highest position of a reply let go of: it still sits in the thread. */
  private floor: number | null = null;
  private readonly onEmpty: () => void;

  /** `onEmpty` is told when the last registered reply is let go of. */
  constructor(onEmpty: () => void = () => {}) {
    this.onEmpty = onEmpty;
  }

  /** A reply exists, with a message or without. */
  join(reply: Placed): void {
    this.replies.add(reply);
  }

  /** Whether the reply is registered and not let go of. */
  holds(reply: Placed): boolean {
    return this.replies.has(reply);
  }

  /** Whether any reply is registered. */
  get held(): boolean {
    return this.replies.size > 0;
  }

  /** The owner wrote a message of this thread at `ts`. */
  ownerPosted(ts: string): void {
    const at = positionOf(ts);
    if (at === null) return;
    this.marks.push(at);
    this.place();
    this.release();
    this.prune();
  }

  /** A reply got its first message, or its last message moved. */
  moved(_reply: Placed): void {
    this.prune();
    this.place();
  }

  /**
   * The reply's end has landed: it is let go of once an owner message sits below it and no reply
   * of its stretch is still to end. Every reply is handed its tail first, so that the one that
   * gives its footer up is told before it can be let go of.
   */
  ended(reply: Placed): void {
    if (!this.replies.has(reply)) return;
    this.done.add(reply);
    this.place();
    this.release();
  }

  /**
   * Work out every reply's tail with `tails` of the core and hand each its own. Sync: a reply
   * whose tail did not change does nothing. Called whenever a reply's position, its resting or
   * its own footer changes.
   */
  place(): void {
    const result = this.tailsWith(null);
    for (const reply of [...this.replies]) {
      reply.assign(result.get(reply) ?? { footer: null, running: false });
    }
  }

  /**
   * The tail the reply would be handed if its end had landed now: what its end writes while it
   * is still on the way, so that a footer is not written where the next pass takes it off.
   */
  tailIf(reply: Placed): Tail<string> {
    return this.tailsWith(reply).get(reply) ?? { footer: reply.ownFooter, running: false };
  }

  /** The tails of the registered replies; `subject` counts as resting, and as the lowest if unplaced. */
  private tailsWith(subject: Placed | null): Map<Placed, Tail<string>> {
    const entries: TailEntry<Placed, string>[] = [];
    for (const reply of this.replies) {
      const resting = reply.resting || reply === subject;
      // A reply whose first message is not written yet lands below everything.
      const at = reply.lastAt ?? (reply === subject ? Number.POSITIVE_INFINITY : null);
      if (at !== null) entries.push({ key: reply, at, resting, footer: reply.ownFooter });
    }
    return tails(entries, this.marks);
  }

  /** The thread object that opened the reply closed: the reply is let go of once its end landed. */
  closed(reply: Placed): void {
    if (!this.replies.has(reply)) return;
    this.shut.add(reply);
    this.release();
  }

  /** Whether nothing of the owner's and no other reply sits below the reply. */
  last(reply: Placed): boolean {
    if (!this.replies.has(reply) || reply.lastAt === null) return false;
    return isLast(reply.lastAt, this.others(reply), this.marks);
  }

  /** Whether another reply has a message below the reply; a reply let go of keeps its answer. */
  overtaken(reply: Placed): boolean {
    if (reply.lastAt === null) return false;
    return isOvertaken(reply.lastAt, this.others(reply));
  }

  private others(reply: Placed): number[] {
    const at: number[] = this.floor === null ? [] : [this.floor];
    for (const other of this.replies) {
      if (other !== reply && other.lastAt !== null) at.push(other.lastAt);
    }
    return at;
  }

  /** Lets go of the ended replies that an owner message or a closed thread seals. */
  private release(): void {
    const top = this.marks.length === 0 ? null : Math.max(...this.marks);
    let gone = false;
    for (const reply of [...this.done]) {
      if (!this.sealed(reply, top)) continue;
      const at = reply.lastAt;
      if (at !== null) this.floor = Math.max(this.floor ?? at, at);
      this.done.delete(reply);
      this.shut.delete(reply);
      this.replies.delete(reply);
      gone = true;
    }
    if (gone && this.replies.size === 0) this.onEmpty();
  }

  /**
   * Whether an ended reply is let go of: its thread closed, or an owner message sits below it
   * and no reply of its stretch (one with a message above that owner message, or without a
   * message yet) is still to end, since that one takes the stretch's footer from it.
   */
  private sealed(reply: Placed, top: number | null): boolean {
    const at = reply.lastAt;
    if (this.shut.has(reply) || at === null) return true;
    if (top === null || top <= at) return false;
    const next = Math.min(...this.marks.filter((mark) => mark > at));
    for (const other of this.replies) {
      if (other === reply || this.done.has(other) || other.lastAt === null) continue;
      if (other.lastAt > at && other.lastAt < next) return false;
    }
    return true;
  }

  /** Keeps the marks not below the lowest placed reply, and always the highest. */
  private prune(): void {
    if (this.marks.length === 0) return;
    const top = Math.max(...this.marks);
    const placed = [...this.replies].flatMap((reply) =>
      reply.lastAt === null ? [] : [reply.lastAt],
    );
    const lowest = Math.min(...placed);
    this.marks = this.marks.filter((mark) => mark === top || mark >= lowest);
  }
}

/**
 * Where the messages of one thread sit, as far as the daemon saw them: the owner's, and the last
 * message of each reply. Kept in memory only (a restart forgets it), and decided by `isLast` and
 * `isOvertaken` of the core. A reply the places let go of leaves its position behind in `floor`,
 * so that the answers do not change when it goes.
 */

import { isLast, isOvertaken, Mutex } from "../../../core/port.ts";

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

  /** Whether any reply is registered. */
  get held(): boolean {
    return this.replies.size > 0;
  }

  /** The owner wrote a message of this thread at `ts`. */
  ownerPosted(ts: string): void {
    const at = positionOf(ts);
    if (at === null) return;
    this.marks.push(at);
    this.release();
    this.prune();
  }

  /** A reply got its first message, or its last message moved. */
  moved(_reply: Placed): void {
    this.prune();
  }

  /** The reply's end has landed: it is let go of once an owner message sits below it. */
  ended(reply: Placed): void {
    if (!this.replies.has(reply)) return;
    this.done.add(reply);
    this.release();
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

  /** Whether another reply has a message below the reply. */
  overtaken(reply: Placed): boolean {
    if (!this.replies.has(reply) || reply.lastAt === null) return false;
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
    for (const reply of this.done) {
      const at = reply.lastAt;
      const sealed = this.shut.has(reply) || at === null || (top !== null && top > at);
      if (!sealed) continue;
      if (at !== null) this.floor = Math.max(this.floor ?? at, at);
      this.done.delete(reply);
      this.shut.delete(reply);
      this.replies.delete(reply);
      gone = true;
    }
    if (gone && this.replies.size === 0) this.onEmpty();
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

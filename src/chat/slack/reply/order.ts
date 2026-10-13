/**
 * The order of the messages of one thread, as far as the daemon saw them: the owner's, and the
 * last message of each reply. Kept in memory only (a restart forgets it), and decided by
 * `isLast` and `isOvertaken` of the core.
 */

import { isLast, isOvertaken } from "../../../core/port.ts";

/** A Slack `ts` as an integer of microseconds: exact below 2^53, ordered as the thread is. */
export function positionOf(ts: string): number {
  const [seconds = "0", fraction = ""] = ts.split(".");
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

/** What the order needs of a reply. `ReplySink` implements it. */
export interface Placed {
  /** The position of its last message, null while it has none. */
  readonly lastAt: number | null;
}

export class ThreadOrder {
  private readonly replies = new Set<Placed>();
  /** The replies whose end has landed. */
  private readonly done = new Set<Placed>();
  private marks: number[] = [];
  private readonly onPresence: (present: boolean) => void;

  /** `onPresence` is told when the order gains its first reply and when it loses its last. */
  constructor(onPresence: (present: boolean) => void = () => {}) {
    this.onPresence = onPresence;
  }

  /** The owner wrote a message of this thread at `ts`. */
  ownerPosted(ts: string): void {
    // A mark above no reply can never sit below one that is yet to come.
    if (this.replies.size === 0) return;
    this.marks.push(positionOf(ts));
    this.forget();
  }

  /** A reply got its first message, or its last message moved. */
  moved(reply: Placed): void {
    if (reply.lastAt === null) return;
    const first = this.replies.size === 0;
    this.replies.add(reply);
    if (first) this.onPresence(true);
  }

  /** The reply's end has landed: it is forgotten once an owner message sits below it. */
  ended(reply: Placed): void {
    if (!this.replies.has(reply)) return;
    this.done.add(reply);
    this.forget();
  }

  /** Whether nothing of the owner's and no other reply sits below the reply. */
  last(reply: Placed): boolean {
    if (reply.lastAt === null) return false;
    return isLast(reply.lastAt, this.others(reply), this.marks);
  }

  /** Whether another reply has a message below the reply. */
  overtaken(reply: Placed): boolean {
    if (reply.lastAt === null) return false;
    return isOvertaken(reply.lastAt, this.others(reply));
  }

  private others(reply: Placed): number[] {
    const at: number[] = [];
    for (const other of this.replies) {
      if (other !== reply && other.lastAt !== null) at.push(other.lastAt);
    }
    return at;
  }

  /** Drops the ended replies an owner message seals, and the marks no reply is above any more. */
  private forget(): void {
    for (const reply of this.done) {
      const at = reply.lastAt;
      if (at !== null && this.marks.some((mark) => mark > at)) {
        this.done.delete(reply);
        this.replies.delete(reply);
      }
    }
    const placed = [...this.replies].flatMap((reply) =>
      reply.lastAt === null ? [] : [reply.lastAt],
    );
    const lowest = Math.min(...placed);
    this.marks = this.marks.filter((mark) => mark > lowest);
    if (this.replies.size === 0) {
      this.marks = [];
      this.onPresence(false);
    }
  }
}

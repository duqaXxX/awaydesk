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
import type { RunningList } from "../../seam.ts";

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

/** What a reply shows under its last message: the footer, and the list of what still runs. */
export interface Shown {
  readonly footer: string | null;
  /** Only the reply that holds the thread's list has one. */
  readonly list: RunningList | null;
}

/** What the places need of a reply. `ReplySink` implements it. */
export interface Placed {
  /** The position of its last message, null while it has none. */
  readonly lastAt: number | null;
  /** It rests or its end has landed: its last message can be rewritten, and it can show a footer. */
  readonly resting: boolean;
  /** The footer its turn left, formatted; null when that turn had none. */
  readonly ownFooter: string | null;
  /** What it shows under its last message from now on. */
  assign(shown: Shown): void;
  /** Writes what it still owes now; false when it is not on Slack. */
  settle(): Promise<boolean>;
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
  /** What still runs in the thread, drawn under the reply `tails` names. */
  private list: RunningList | null = null;
  /** The reply that holds the list now: it is not let go of while it does. */
  private holder: Placed | null = null;
  /** The replies that held the list, for a change of it that only debounced. */
  private readonly listed = new Set<Placed>();
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
  moved(): void {
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

  /** What still runs in the thread changed; null for nothing. The holder is written at once. */
  showRunning(list: RunningList | null): void {
    this.list = list;
    this.place();
  }

  /**
   * The reply no longer shows the list and is not to: the close has nothing to settle on it. The
   * holder stays, since the list may be handed to it again.
   */
  unlisted(reply: Placed): void {
    if (reply !== this.holder) this.listed.delete(reply);
  }

  /**
   * A shutdown's last chance for the changes of the list that only debounced, on every reply that
   * held it, let go of or not, since no session settles a reply whose end landed.
   */
  async settleListed(): Promise<void> {
    const replies = [...this.listed];
    this.listed.clear();
    for (const reply of replies) await reply.settle().catch(() => {});
  }

  /**
   * Work out every reply's tail with `tails` of the core and hand each its own. Sync: a reply
   * whose tail did not change does nothing. Called whenever a reply's position, its resting or
   * its own footer changes. A reply that stops holding the list may be let go of from then on.
   */
  place(): void {
    const result = this.tailsWith(null);
    let holder: Placed | null = null;
    for (const reply of [...this.replies]) {
      const shown = this.shownOf(result.get(reply));
      if (shown.list !== null) {
        holder = reply;
        this.listed.add(reply);
      }
      reply.assign(shown);
    }
    const previous = this.holder;
    this.holder = holder;
    if (previous !== null && previous !== holder) this.release();
  }

  /**
   * What the reply would be handed if it rested now: what its stop or its end writes while it is
   * still on the way, so that a footer is not written where the next pass takes it off.
   */
  tailIf(reply: Placed): Shown {
    return this.shownOf(this.tailsWith(reply).get(reply), reply.ownFooter);
  }

  private shownOf(tail: Tail<string> | undefined, footer: string | null = null): Shown {
    if (tail === undefined) return { footer, list: null };
    return { footer: tail.footer, list: tail.running ? this.list : null };
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

  /** The thread object that opened the reply closed: the reply is let go of, its end landed or not. */
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

  /**
   * Lets go of the replies a closed thread or an owner message seals (`sealed`). The holder of the
   * list stays while it holds it, unless its thread closed.
   */
  private release(): void {
    const top = this.marks.length === 0 ? null : Math.max(...this.marks);
    let gone = false;
    for (const reply of [...this.replies]) {
      // A closed thread lets go of its replies whether or not their end landed: the session is
      // gone, and nothing else would drop a reply whose end never lands.
      if (!this.shut.has(reply) && !this.done.has(reply)) continue;
      // The reply that holds the list stays while it does: the list could never be taken off a
      // reply that is gone. A closed thread lets go of it all the same.
      if (reply === this.holder && !this.shut.has(reply)) continue;
      if (!this.sealed(reply, top)) continue;
      const at = reply.lastAt;
      if (at !== null) this.floor = Math.max(this.floor ?? at, at);
      this.done.delete(reply);
      this.shut.delete(reply);
      this.replies.delete(reply);
      if (this.holder === reply) this.holder = null;
      gone = true;
    }
    if (gone && this.replies.size === 0) this.onEmpty();
  }

  /**
   * Whether a reply is let go of: its thread closed, or an owner message sits below it and no
   * reply of its stretch, above it or below, is still to end. The holder of the list counts as
   * still to end while it holds it: it stays, and may show the footer of a reply above it, which
   * `tails` could not find once that reply is gone. A stretch is let go of as a whole: the reply
   * still to end takes the stretch's footer from its holder, or gives it back. A reply with no
   * message yet counts in no stretch.
   */
  private sealed(reply: Placed, top: number | null): boolean {
    const at = reply.lastAt;
    if (this.shut.has(reply) || at === null) return true;
    if (top === null || top <= at) return false;
    const prev = Math.max(Number.NEGATIVE_INFINITY, ...this.marks.filter((mark) => mark < at));
    const next = Math.min(...this.marks.filter((mark) => mark > at));
    for (const other of this.replies) {
      if (
        other === reply ||
        (this.done.has(other) && other !== this.holder) ||
        other.lastAt === null
      ) {
        continue;
      }
      if (other.lastAt > prev && other.lastAt < next) return false;
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

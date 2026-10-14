/**
 * Where the messages of one thread sit, as far as the daemon saw them: the owner's, and the last
 * message of each reply. Kept in memory only (a restart forgets it), and decided by `isLast`,
 * `isOvertaken` and `tails` of the core. The session's footer is not placed here: the session
 * names the reply it goes under. A reply the places let go of leaves its position behind
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

/** What the places need of a reply. `ReplySink` implements it. */
export interface Placed {
  /** The position of its last message, null while it has none. */
  readonly lastAt: number | null;
  /** It rests or its end has landed: its last message can be rewritten. */
  readonly resting: boolean;
  /** What it shows under its last message from now on; only the reply that holds the list has one. */
  assign(list: RunningList | null): void;
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
  /** The highest position of a message of the owner's or of one the app posted outside a reply. */
  private latest: number | null = null;
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
    this.latest = Math.max(this.latest ?? at, at);
    this.marks.push(at);
    this.place();
    this.release();
    this.prune();
  }

  /**
   * The app posted a message of its own in the thread, outside its replies (a notice, a request).
   * It changes no reply's place: it only counts in `newestAt`.
   */
  posted(ts: string): void {
    const at = positionOf(ts);
    if (at !== null) this.latest = Math.max(this.latest ?? at, at);
  }

  /** The position of the newest message of the thread the places know of; null when none. */
  get newestAt(): number | null {
    let newest = this.latest ?? this.floor;
    if (this.floor !== null && newest !== null) newest = Math.max(newest, this.floor);
    for (const reply of this.replies) {
      if (reply.lastAt !== null) newest = Math.max(newest ?? reply.lastAt, reply.lastAt);
    }
    return newest;
  }

  /** A reply got its first message, or its last message moved. */
  moved(): void {
    this.prune();
    this.place();
  }

  /**
   * The reply's end has landed: it is let go of once an owner message sits below it.
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
   * whose tail did not change does nothing. Called whenever a reply's position or its resting
   * changes. A reply that stops holding the list may be let go of from then on.
   */
  place(): void {
    const result = this.tailsOf();
    let holder: Placed | null = null;
    for (const reply of [...this.replies]) {
      const list = result.get(reply)?.running ? this.list : null;
      if (list !== null) {
        holder = reply;
        this.listed.add(reply);
      }
      reply.assign(list);
    }
    const previous = this.holder;
    this.holder = holder;
    if (previous !== null && previous !== holder) this.release();
  }

  /** The tails of the registered replies that have a message. */
  private tailsOf(): Map<Placed, Tail> {
    const entries: TailEntry<Placed>[] = [];
    for (const reply of this.replies) {
      if (reply.lastAt !== null)
        entries.push({ key: reply, at: reply.lastAt, resting: reply.resting });
    }
    return tails(entries);
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
   * Whether a reply is let go of: its thread closed, or an owner message sits below it. The
   * holder of the list counts as still to end while it holds it (`release`). A reply with no
   * message yet is let go of with its thread alone.
   */
  private sealed(reply: Placed, top: number | null): boolean {
    const at = reply.lastAt;
    if (this.shut.has(reply) || at === null) return true;
    return top !== null && top > at;
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

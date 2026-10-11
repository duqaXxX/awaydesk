/**
 * The primitives of the sessions: a task that can be cancelled, an event, a semaphore, a lock, a
 * queue, and a wait that a signal ends. The rule they serve is the header of `session.ts`.
 *
 * A promise callback runs at the next `await` of the code that made it ready, whether or not
 * that `await` waits for anything. So a new task starts, and the waiters of an event wake, on
 * the next turn of the event loop (`setImmediate`), in the order they became ready: the code
 * that made them ready reaches its own next real wait first.
 */
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";

export const logger = getLogger("awaydesk.core.sessions.tasks");

// A stack frame as V8 writes it: `at name (place:line:column)` or `at place:line:column`.
const FRAME = /^\s+at (?:.+ \()?[^\s()]+:\d+:\d+\)?$/;

/**
 * Where an error was thrown, as a log line may say it: the first frame of its stack. The stack
 * opens with the error's own words, which may run over several lines and may hold one that reads
 * like a frame, so only what follows them is looked at, and only a line shaped as a frame.
 */
function thrownAt(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") return "";
  const words = error.stack.indexOf(error.message);
  if (words === -1) return "";
  const frames = error.stack.slice(words + error.message.length).split("\n");
  const frame = frames.find((line) => FRAME.test(line));
  return frame === undefined ? "" : ` (${frame.trim()})`;
}

/** Resolves on the next turn of the event loop, after every promise callback that is ready. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** What a wait rejects with when its signal aborts. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/**
 * `promise`, for a caller that may stop waiting: rejects with the signal's reason when it aborts
 * first. The promise itself goes on: what it began runs to its end.
 */
export function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      // Whoever began it still owns its outcome: no unhandled rejection from this side.
      promise.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A task. The function starts on the next turn of the event loop, never inside the call that
 * made the task, and the sessions set state right after creating one. A task cancelled before
 * it started never runs. With `immediate`, the function has started running when the task is
 * made, which is the rule of the chat provider's passes (the header of `sinks.ts`).
 * `cancel` aborts the task's signal with `Cancelled`; the function decides which of its waits
 * take it. A task that fails rejects `result()` and never surfaces as an unhandled rejection.
 * When nobody has asked for its result, the failure is logged by its name and by where it was
 * thrown, so that a task that broke leaves a trace.
 */
export class Task<T = void> {
  private readonly controller = new AbortController();
  private readonly promise: Promise<T>;
  private finished = false;
  private retrieved = false;

  constructor(
    run: (signal: AbortSignal) => Promise<T>,
    options: { readonly immediate?: boolean } = {},
  ) {
    this.promise = this.start(run, options.immediate === true);
    this.promise.catch((error: unknown) => {
      if (this.retrieved || error instanceof Cancelled) return;
      logger.error(`a task failed: ${errorName(error)}${thrownAt(error)}`);
    });
  }

  private async start(run: (signal: AbortSignal) => Promise<T>, immediate: boolean): Promise<T> {
    try {
      if (!immediate) {
        await nextTurn();
        this.controller.signal.throwIfAborted();
      }
      return await run(this.controller.signal);
    } finally {
      this.finished = true;
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the function has returned or thrown. */
  get done(): boolean {
    return this.finished;
  }

  cancel(): void {
    if (!this.finished && !this.controller.signal.aborted) this.controller.abort(new Cancelled());
  }

  /** The function's own outcome: whoever asks for it answers for its failure. */
  result(): Promise<T> {
    this.retrieved = true;
    return this.promise;
  }

  /** Resolves when the task ends, however it ends: awaiting a task one has just cancelled. */
  settled(): Promise<void> {
    return this.promise.then(
      () => {},
      () => {},
    );
  }
}

/**
 * An event. `set` wakes its waiters on the next turn of the event loop: whoever set it goes on
 * to its own next real wait first, so a waiter never sees the state of the setter half-way
 * through what it was doing. A waiter whose signal aborts leaves and rejects with the signal's
 * reason.
 */
export class Event {
  private value = false;
  private readonly waiters = new Set<() => void>();

  get isSet(): boolean {
    return this.value;
  }

  set(): void {
    this.value = true;
    if (this.waiters.size === 0) return;
    const waiting = [...this.waiters];
    this.waiters.clear();
    setImmediate(() => {
      for (const wake of waiting) wake();
    });
  }

  clear(): void {
    this.value = false;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.value) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(wake);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(wake);
    });
  }
}

/**
 * A counting gate: at most `limit` holders at once, the others served in the order they
 * came. A place given back goes straight to the first in line, so it is never free for a
 * newcomer to take ahead of a waiter.
 */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.free = limit;
  }

  /**
   * Resolves with the function that gives the place back, once it is this caller's turn; calling
   * that function twice gives back one place. A waiter whose signal aborts leaves the line and
   * rejects with the signal's reason.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.releaser());
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(turn);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(turn);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.free += 1;
      else next();
    };
  }

  /** `work` while holding a place, given back however `work` ends. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/** A lock: a semaphore of one place. */
export class Mutex extends Semaphore {
  constructor() {
    super(1);
  }
}

/** A queue, unbounded, for one consumer. */
export class Queue<T> {
  private readonly items: T[] = [];
  private readonly filled = new Event();

  get size(): number {
    return this.items.length;
  }

  get empty(): boolean {
    return this.items.length === 0;
  }

  putNowait(item: T): void {
    this.items.push(item);
    this.filled.set();
  }

  /** The next item now; throws on an empty queue, as `get_nowait` raised. */
  getNowait(): T {
    const item = this.items.shift();
    if (item === undefined) throw new RangeError("the queue is empty");
    if (this.items.length === 0) this.filled.clear();
    return item;
  }

  /** The next item, waiting for one; the wait leaves through its signal. */
  async get(signal?: AbortSignal): Promise<T> {
    while (this.items.length === 0) await this.filled.wait(signal);
    return this.getNowait();
  }
}

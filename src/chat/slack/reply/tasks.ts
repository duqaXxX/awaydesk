/**
 * What stands for an asyncio task in the provider: one that has started running when it is made,
 * where the sessions' `Task` starts on the next turn of the event loop. `Cancelled`, the lock and
 * the wait that a signal ends are the sessions' own (`core/sessions/tasks.ts`). The rule the task
 * serves is the header of `sinks.ts`.
 */
import { Cancelled } from "../../../core/sessions/tasks.ts";

/**
 * `asyncio.create_task`: an async function that started running, and the signal it was given.
 * `cancel` aborts that signal with `Cancelled`; the function decides which of its waits take it.
 * A task that fails rejects `result()` and nothing else: it never surfaces as an unhandled
 * rejection.
 */
export class Task<T> {
  private readonly controller = new AbortController();
  private readonly promise: Promise<T>;
  private finished = false;

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = this.run(run);
    this.promise.catch(() => {});
  }

  private async run(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await run(this.controller.signal);
    } finally {
      this.finished = true;
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the function has returned or thrown. True a turn of the microtask queue late. */
  get done(): boolean {
    return this.finished;
  }

  cancel(): void {
    if (!this.finished && !this.controller.signal.aborted) this.controller.abort(new Cancelled());
  }

  /** The function's own outcome. */
  result(): Promise<T> {
    return this.promise;
  }

  /** `asyncio.wait([task])`: resolves when the task ends, however it ends. */
  settled(): Promise<void> {
    return this.promise.then(
      () => {},
      () => {},
    );
  }
}

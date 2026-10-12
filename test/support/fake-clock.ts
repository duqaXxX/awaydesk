/** The fake clock and the latch the tests of the core and of a provider share. */
import type { Clock } from "../../src/clock.ts";

/** A latch: `wait` resolves once the event is set, at once when it already is. */
export class AsyncEvent {
  #isSet = false;
  #waiters: Array<() => void> = [];

  isSet(): boolean {
    return this.#isSet;
  }

  set(): void {
    this.#isSet = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  clear(): void {
    this.#isSet = false;
  }

  wait(): Promise<void> {
    if (this.#isSet) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

interface Sleeper {
  readonly due: number;
  wake(): void;
}

/**
 * The stream deadline's clock: a sleep ends when `advance` reaches its time, so a test crosses
 * the 280 seconds without waiting. `advance` wakes the sleepers whose time has come in the order
 * they began to sleep, whatever their times, then lets what woke run to its next wait.
 */
export class FakeClock implements Clock {
  now = 0;
  #sleepers: Sleeper[] = [];

  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
        reject(signal?.reason);
      };
      const sleeper: Sleeper = {
        due: this.now + seconds,
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });
  }

  time(): number {
    return this.now;
  }

  async advance(seconds: number): Promise<void> {
    this.now += seconds;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.now);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.now);
    for (const sleeper of due) sleeper.wake();
    // Let what woke run to its next wait: a turn of the event loop drains every microtask.
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

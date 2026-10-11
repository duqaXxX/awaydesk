/**
 * The waits `!open` is made of: a counting gate for git's turns and for one modal's updates, and
 * a time limit on the injected clock. Python's `asyncio.Semaphore`, `asyncio.Lock` and
 * `asyncio.timeout`.
 */
import type { Clock } from "../../../clock.ts";

/** What `within` answers when the time ran out first. */
export const TIMED_OUT = Symbol("timed out");

/**
 * `work` with `seconds` of the clock to finish: `TIMED_OUT` when they pass first, after the signal
 * given to `work` is aborted. A `seconds` of nothing is out of time at once, with `work` not
 * started. Work that ignores its signal keeps running unseen: a call to Slack or a lookup cannot be
 * cut short.
 */
export async function within<T>(
  clock: Clock,
  seconds: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  if (seconds <= 0) return TIMED_OUT;
  const limit = new AbortController();
  const finished = new AbortController();
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    clock.sleep(seconds, finished.signal).then(
      () => {
        limit.abort(new Error("time limit"));
        resolve(TIMED_OUT);
      },
      () => {},
    );
  });
  const running = work(limit.signal);
  // Raced out, it may still reject later: nobody is left to read that.
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } catch (error) {
    if (limit.signal.aborted) return TIMED_OUT;
    throw error;
  } finally {
    finished.abort();
  }
}

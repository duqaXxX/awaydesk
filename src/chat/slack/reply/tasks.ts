import { Task as SessionTask } from "../../../core/port.ts";
/**
 * The task of the provider's passes: the sessions' `Task`, started when it is made, where a
 * session's own starts on the next turn of the event loop. The rule it serves is the header of
 * `sinks.ts`.
 */

export class Task<T> extends SessionTask<T> {
  constructor(run: (signal: AbortSignal) => Promise<T>) {
    super(run, { immediate: true });
  }
}

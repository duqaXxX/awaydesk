/**
 * The daemon's two Slack clients on one token, with the daemon's retry policy:
 *
 * - every call that Slack rate limited (HTTP 429) is sent again after the `Retry-After` Slack
 *   gave, up to 3 times. That is safe for every method: a rate limited call never ran. Once the
 *   daemon stops (`ClientOptions.stopped`) such a call is thrown as it is and the pause of one
 *   that waits ends: Slack names the length of that pause, and a stop does not wait for it.
 *   Each rate limit is logged with its method, its `Retry-After` and the send it answered.
 * - a call that failed on the connection (a reset, a refused or unreachable host: a
 *   `WebAPIRequestError` that is not a timeout) is sent again once, after a backoff pause.
 *   `sharedClient` does so for every method, which is safe for a post that is an approval, a
 *   question or a notice. `repliesClient`, the one a reply is written with, does so for every
 *   method but the four of `CREATING_METHODS`: a start, an append, a stop and a post are not
 *   idempotent, a connection can reset after Slack applied the call, and a second send would
 *   duplicate a message or its text, or stop a stream twice. The sink reads the thread back
 *   instead, and adopts what landed.
 * - a call Slack answered with HTTP 500 or 503 (`SERVER_ERROR_STATUSES`) is sent again as one
 *   that failed on the connection is: once, after the same pause, by the same client for the
 *   same methods. The statuses and the one retry are those of slack-sdk's
 *   `ServerErrorRetryHandler` (`slack_sdk/http_retry/builtin_handlers.py`, read 2026-10-11).
 *   The sink reads an HTTP status as a call that did not run (`unknownOutcome` in `errors.ts`),
 *   which would let the four creating calls be sent again too; they are left out, since whether
 *   Slack can answer 500 or 503 after it applied a call was not measured.
 * - nothing else is sent again: Slack answering with an error (`WebAPIPlatformError`), any other
 *   HTTP status, a timeout (a timed out call may have run).
 *
 * `@slack/web-api` 8.2.0 retries every failure or none: `WebClient.makeRequest` ends in
 * `pRetry(task, this.retryConfig)`, with no option per method and none per error. So both clients
 * are built with the two documented options that switch its retries off (`SENT_ONCE`), which
 * makes the library report each failure once, as a typed error, and `PolicyClient.apiCall` applies
 * the policy around `WebClient.apiCall`. A retry counts toward one budget per call, as slack-sdk's
 * `RetryState.current_attempt` did: a connection or server error retry is allowed while no retry
 * was made, a rate limit retry while fewer than 3 were.
 *
 * Differences from slack-sdk: a 429 with no valid `Retry-After` is thrown as the library's plain
 * error at once (slack-sdk waited 1 to 2 seconds and retried; Slack always sends the header); and
 * the pause before a retry is taken from the injected `Clock`, so a test crosses it without
 * waiting. `files.uploadV2` is passed through untouched: it is not a Slack method but the
 * library's three step upload, whose `files.getUploadURLExternal` and
 * `files.completeUploadExternal` come back through `apiCall` and are retried there, one by one.
 */
import {
  type WebAPICallResult,
  WebAPIHTTPError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type WebClientOptions,
} from "@slack/web-api";
import { type Clock, systemClock } from "../../../clock.ts";
import { getLogger } from "../../../log.ts";
import { silentLogger } from "../quiet-logger.ts";

export const logger = getLogger("awaydesk.chat.slack.reply.clients");

/**
 * The four calls that create or grow a message: the replies client never sends one again after a
 * failed connection or a server error.
 */
export const CREATING_METHODS = [
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.postMessage",
] as const;

// What slack-sdk's client waited for an answer by default (`AsyncWebClient(timeout=30)`). The
// library's default is no timeout at all (`WebClientOptions.timeout`, 0), and a pass of the sink
// waits for its call to answer.
export const REQUEST_TIMEOUT_MS = 30_000;

/** The two options that make the library report each failure once, whatever else it is built with. */
export const SENT_ONCE = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
} as const satisfies WebClientOptions;

// `AsyncRateLimitErrorRetryHandler(max_retry_count=3)`, and the default of slack-sdk's connection
// handler and of its server error one: the one retry of a call covers both kinds of failure.
export const RATE_LIMIT_RETRIES = 3;
export const CONNECTION_RETRIES = 1;
/** The HTTP statuses a call is sent again after, as after a failed connection. */
export const SERVER_ERROR_STATUSES: readonly number[] = [500, 503];
// `BackoffRetryIntervalCalculator(backoff_factor=0.5)`: 0.5 * 2^attempt seconds, plus a jitter.
const BACKOFF_FACTOR = 0.5;

/**
 * What a client is built with: the library's options but its retries, which the policy owns, and
 * its logger, which writes nothing (`silentLogger`: the library's lines can quote a message, and
 * a `logLevel` given here is ignored with it).
 */
export interface ClientOptions extends Omit<WebClientOptions, keyof typeof SENT_ONCE | "logger"> {
  /** Waits the pause before a retry. */
  readonly clock?: Clock;
  /** The jitter added to a pause, in [0, 1) seconds. */
  readonly random?: () => number;
  /**
   * Aborts when the daemon stops: from then on a rate limited call is thrown as it is, and the
   * pause of one that waits ends. Nothing is in flight during that pause, and Slack did not apply
   * the call it answered `ratelimited`.
   */
  readonly stopped?: AbortSignal;
}

/** A request that failed before an answer, and not by the client's own timeout. */
function failedOnConnection(error: unknown): boolean {
  return (
    error instanceof WebAPIRequestError &&
    error.original.name !== "TimeoutError" &&
    error.original.name !== "AbortError"
  );
}

/** Slack answered with a status that says its side failed, with no word on the call itself. */
function failedOnServer(error: unknown): boolean {
  return error instanceof WebAPIHTTPError && SERVER_ERROR_STATUSES.includes(error.statusCode);
}

/** A `WebClient` that sends each call by the policy at the top of this file. */
class PolicyClient extends WebClient {
  readonly #notRetried: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #stopped: AbortSignal | undefined;

  constructor(token: string | undefined, notRetried: readonly string[], options: ClientOptions) {
    const { clock, random, stopped, ...rest } = options;
    super(token, { timeout: REQUEST_TIMEOUT_MS, ...rest, ...SENT_ONCE, logger: silentLogger() });
    this.#notRetried = new Set(notRetried);
    this.#clock = clock ?? systemClock;
    this.#random = random ?? Math.random;
    this.#stopped = stopped;
  }

  /** Seconds to wait before sending the call again, or null when it is not sent again. */
  #pause(method: string, error: unknown, retries: number): number | null {
    if (error instanceof WebAPIRateLimitedError) {
      return retries < RATE_LIMIT_RETRIES ? error.retryAfter + this.#random() : null;
    }
    if (
      (failedOnConnection(error) || failedOnServer(error)) &&
      retries < CONNECTION_RETRIES &&
      !this.#notRetried.has(method)
    ) {
      return BACKOFF_FACTOR * 2 ** retries + this.#random();
    }
    return null;
  }

  override async apiCall(
    method: string,
    options: Record<string, unknown> = {},
  ): Promise<WebAPICallResult> {
    if (method === "files.uploadV2") return super.apiCall(method, options);
    for (let retries = 0; ; retries += 1) {
      try {
        return await super.apiCall(method, options);
      } catch (error) {
        if (error instanceof WebAPIRateLimitedError) {
          // The method and Slack's own number, never the call's arguments: which methods are
          // rate limited, and for how long, is what issue #236 waits for.
          logger.info(
            `Slack rate limited ${method}: Retry-After ${error.retryAfter} s, ` +
              `send ${retries + 1} of ${RATE_LIMIT_RETRIES + 1}`,
          );
        }
        const pause = this.#pause(method, error, retries);
        if (pause === null) throw error;
        if (error instanceof WebAPIRateLimitedError) {
          // The one pause that can last minutes (Slack names its length), and the one a stop
          // may leave: see `ClientOptions.stopped`.
          if (this.#stopped?.aborted) throw error;
          try {
            await this.#clock.sleep(pause, this.#stopped);
          } catch (stop) {
            if (this.#stopped?.aborted) throw error;
            throw stop;
          }
        } else {
          await this.#clock.sleep(pause);
        }
      }
    }
  }
}

/** The shared client: connection, server error and rate limit retries for every call. */
export function sharedClient(token: string | undefined, options: ClientOptions = {}): WebClient {
  return new PolicyClient(token, [], options);
}

/**
 * The replies client: the shared client's policy, except that `CREATING_METHODS` are not resent
 * on a connection failure or a server error.
 */
export function repliesClient(token: string | undefined, options: ClientOptions = {}): WebClient {
  return new PolicyClient(token, CREATING_METHODS, options);
}

#!/usr/bin/env node
/**
 * `awaydesk`: start the daemon (normally from the LaunchAgent in docs/setup.md), or answer one of
 * the arguments of `cli.ts` and end. The one module that may import all three layers.
 *
 * How the process behaves under Node:
 *
 * - Signals. `SIGTERM` and `SIGINT` are caught with `process.on`, from the start of `run` up to
 *   the end of the shutdown. Node's signal watchers do not keep the event loop alive, and a
 *   listener removed at the end puts the default disposition back.
 * - What keeps the process running. A pending promise holds nothing. While the daemon waits for
 *   a signal, the Socket Mode client and the cleanup's timer are what the libraries and the
 *   clock happen to keep alive, so `run` holds one timer of its own until the shutdown ends. On
 *   a stop it clears that timer and closes everything else it made (the cleanup's sleep and the
 *   drain's limit are aborted, never left to run out).
 * - Errors nobody handles. A rejected promise or a thrown exception that nobody handles would
 *   end a Node process at once, without the shutdown below, with open replies and a Claude Code
 *   process per session. `installProcessHandlers` logs each by its name (the message and the
 *   stack can quote a request). After a rejected promise nobody handled the daemon goes on: it
 *   is a piece of work that failed with nobody waiting for it, and with a listener set Node
 *   leaves the process running (`--unhandled-rejections`, default `throw`).
 *   An uncaught exception stops the daemon as a SIGINT would (the shutdown without a drain:
 *   sessions closed, lock released) and ends the process with status 1, so that launchd starts
 *   a clean daemon and the crash repair runs: Node's documentation of the event says it is not
 *   safe to resume normal operation after it (read 2026-10-10, v22). One rejection the daemon
 *   goes on from leaves it deaf: `@slack/socket-mode` 3.1.0 reconnects from its `close`
 *   listener without awaiting the call (`SocketModeClient.delayReconnectAttempt`), and when
 *   Slack refuses the app token for good (`invalid_auth` and the four other codes of
 *   `UnrecoverableSocketModeStartError`) nothing but that rejection shows it. The log then
 *   holds `unhandled rejection: <code>`, and the fix is the token and a restart.
 * - The end of the process. `main` ends it with the code `run` gave as soon as `run` returns.
 *   Node would otherwise stay alive for as long as anything holds its event loop, and the
 *   Socket Mode connection does after every stop: `SocketModeReceiver.stop` of `@slack/bolt`
 *   5.1.0 does not wait for the client's `disconnect`, the WebSocket stays open once the close
 *   frame is sent, and `@slack/socket-mode` 3.1.0 ends it only when its own ping goes
 *   unanswered (measured on 2026-10-10: 5.9 seconds after the stop, three times out of three).
 *   In that time the lock is already free, and launchd, which sees a live job, starts nothing.
 *   A shutdown that completes no step for `SHUTDOWN_LIMIT_SECONDS` ends the process with 1 on
 *   a timer that does not keep it alive (`deferred`): a shutdown stuck on a connection, or on a
 *   start of the agent that never answers (one a word of the daemon made, `!status` or the
 *   setup of a thread, or one the session's own worker gave up: `ThreadSession.close` waits for
 *   both), would leave the daemon deaf, still
 *   holding the single-instance lock, with nobody to Ctrl-C it. For a stop that a signal asked
 *   for, the limit starts once the drain is over (the drain's own wait is
 *   `DRAIN_LIMIT_SECONDS`, never shortened) and runs from the last step that completed: each
 *   step of the shutdown, and each session `SessionManager.closeAll` has closed, reports through
 *   `RunOptions.shutdownProgress`, since a shutdown with many replies to end takes longer than
 *   the limit and is not stuck. For a stop that a failure asked for, one deadline runs from the
 *   failure and no step moves it; a failure during a signal's shutdown replaces the deadline of
 *   progress with that one. What an end by the limit leaves is ended by the next start's repair:
 *   the replies still open, the status of the threads. The note that lists the prompts that
 *   were not sent lives in memory only and is not written.
 * - The entry point. `import.meta.main` (Node 22.18, `@since v22.18.0` in `@types/node`, and
 *   run on 22.23 and 26.5) is true only for the module the process started with, a symlink in
 *   `node_modules/.bin` included: Node runs the real path. Comparing `process.argv[1]` with
 *   this file's path would fail through that symlink. Below 22.18 the value is undefined and
 *   `main` would never run, so the first import, `require-node.ts`, ends the process with a
 *   refusal on an older Node (see `node-version.ts`); it does not rest on `import.meta.main`.
 */
import "./require-node.ts";
import { join } from "node:path";
import type { AgentEntry } from "./agent/seam.ts";
import { answer, parseArguments } from "./cli.ts";
import { type Clock, monotonicClock, systemClock } from "./clock.ts";
import { CLEAN_EVERY_SECONDS, clean } from "./core/cleanup.ts";
import { CONFIG_DIR, ConfigError, loadConfig } from "./core/config.ts";
import { buildFlows } from "./core/flows/flows.ts";
import { postUpgradeNotices } from "./core/flows/notices.ts";
import { repair } from "./core/flows/repair.ts";
import { UsageCache } from "./core/footer.ts";
import { Holds } from "./core/hold.ts";
import { AlreadyRunning, singleInstance } from "./core/lock.ts";
import type { ChatContext, ChatEntry, CorePort } from "./core/port.ts";
import { Approvals } from "./core/requests.ts";
import { SessionManager } from "./core/sessions/manager.ts";
import { StateError, type StateModules, StateStore } from "./core/state.ts";
import { namesOf } from "./core/texts.ts";
import { getLogger } from "./log.ts";
import { REGISTRY, type Registry } from "./registry.ts";
import { errorName } from "./values.ts";

export const logger = getLogger("awaydesk.main");

// How long a stop waits for running turns before it ends them itself. It holds after
// `launchctl kill TERM`, which only sends the signal; a stop launchd makes itself (`bootout`,
// `kickstart -k`) kills the process after ExitTimeOut, which launchd caps at 60 seconds.
export const DRAIN_LIMIT_SECONDS = 1740;

// How long a shutdown may go without completing a step before `main` ends the process with 1: one
// that hangs on a connection, a child or a start of the agent leaves the daemon deaf, with nobody
// to Ctrl-C it. For a failure's stop it is the whole stop, from the failure.
export const SHUTDOWN_LIMIT_SECONDS = 30;

/** `action` after `seconds`, on a timer that does not keep the process alive. */
export function deferred(seconds: number, action: () => void): NodeJS.Timeout {
  return setTimeout(action, seconds * 1000).unref();
}

/** The two signals a stop is asked with. */
export type Stop = "SIGTERM" | "SIGINT";

/** Where the signals come from: the process, or an emitter in a test. */
export interface SignalSource {
  on(signal: Stop, listener: () => void): unknown;
  off(signal: Stop, listener: () => void): unknown;
}

/** The two events of the process that `installProcessHandlers` listens to. */
export interface ProcessEvents {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

/** Every outside thing `run` uses, with the real one as the default. */
export interface RunOptions {
  /** `~/.config/awaydesk`. */
  readonly configDir?: string;
  /**
   * The agents and the chats the configuration may select: `REGISTRY`. What a test replaces of a
   * module is an option of that module's entry (`slackChat({ clients })`), never of `run`.
   */
  readonly registry?: Registry;
  /**
   * Aborts when the process met what it cannot go on from (see the header): the daemon stops as
   * a SIGINT does, and `run` answers 1.
   */
  readonly failure?: AbortSignal;
  /**
   * Called when the shutdown begins (after the drain of a signal's stop, if it had one) and each
   * time a step of it completes: a step of the shutdown, a session closed.
   */
  readonly shutdownProgress?: () => void;
  /** Every wait of the daemon; the system clock for wall time and the monotonic one for pauses. */
  readonly clock?: Clock;
  /** `process`. */
  readonly signals?: SignalSource;
  /** `new StateStore(path, { modules })`. */
  readonly openState?: (path: string, modules: StateModules) => StateStore;
}

export interface MainOptions extends RunOptions {
  /** `process.exit`. */
  readonly exit?: (code: number) => void;
  /** `process`. */
  readonly process?: ProcessEvents;
  /**
   * Runs an action after the seconds given, on a timer that does not keep the process alive.
   * Returns what cancels it.
   */
  readonly later?: (seconds: number, action: () => void) => () => void;
}

/**
 * The scheduled cleanup of `state.json`: a pass every `seconds`, none once a stop has begun (the
 * sessions are closing, and the next start cleans anyway). Ends when `signal` aborts; a pass in
 * flight is finished first, since a call to Slack cannot be cut short, though it asks about no
 * further thread once the stop has begun (`CleanOptions.stopping`).
 */
export async function cleanEvery(options: {
  readonly seconds: number;
  readonly clean: () => Promise<void>;
  readonly sessions: { readonly draining: boolean };
  readonly clock: Clock;
  readonly signal: AbortSignal;
}): Promise<void> {
  for (;;) {
    try {
      await options.clock.sleep(options.seconds, options.signal);
    } catch {
      return; // the stop: the only thing that ends a sleep
    }
    if (options.sessions.draining) return;
    await options.clean();
  }
}

/**
 * The signals of a stop. The first one starts it: `SIGTERM` lets running turns finish
 * (`drain`), `SIGINT` does not, since a Ctrl-C in a terminal reaches the Claude Code processes
 * too, which share the daemon's process group. A signal that arrives while the drain runs ends
 * the wait. One that arrives before the drain starts (during a long repair, say) is only
 * counted.
 */
export class StopSignals {
  readonly received: Stop[] = [];
  /** Whether the stop was asked for by a failure, not by a signal (`fail`). */
  failed = false;
  /** Settles on the first signal. */
  readonly requested: Promise<void>;
  readonly #source: SignalSource;
  readonly #listeners: Array<readonly [Stop, () => void]> = [];
  #requested: () => void = () => {};
  #draining: AbortController | null = null;

  constructor(source: SignalSource) {
    this.#source = source;
    this.requested = new Promise((resolve) => {
      this.#requested = resolve;
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const listener = () => {
        this.received.push(signal);
        this.#requested();
        this.#draining?.abort();
      };
      this.#listeners.push([signal, listener]);
      source.on(signal, listener);
    }
  }

  /**
   * Asks for a stop the process cannot go without (an uncaught exception, a connection that is
   * gone for good): counted as a SIGINT, so no drain starts and one under way is cut short.
   */
  fail(): void {
    this.failed = true;
    this.received.push("SIGINT");
    this.#requested();
    this.#draining?.abort();
  }

  /**
   * Runs `drain` until it ends, `limitSeconds` pass, or another signal arrives, the last two
   * through the signal `drain` is given. Leaves no timer behind.
   */
  async drain(
    drain: (cutShort: AbortSignal) => Promise<void>,
    clock: Clock,
    limitSeconds: number,
  ): Promise<void> {
    const cut = new AbortController();
    this.#draining = cut;
    const limit = clock.sleep(limitSeconds, cut.signal).then(
      () => cut.abort(),
      () => undefined, // ended by the drain
    );
    try {
      await drain(cut.signal);
    } finally {
      cut.abort();
      this.#draining = null;
      await limit;
    }
  }

  /** Stops listening: the default disposition of the signals returns. */
  dispose(): void {
    for (const [signal, listener] of this.#listeners.splice(0)) this.#source.off(signal, listener);
  }
}

/**
 * Runs one step of the shutdown, then reports it done; a step that fails is logged by its name,
 * never skips the rest.
 */
async function step(name: string, work: () => unknown, done: () => void): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.error(`shutdown: could not ${name}: ${errorName(error)}`);
  }
  done();
}

/**
 * Start the daemon and return once it has stopped: 0 for a stop by a signal, 1 for one a failure
 * asked for (`RunOptions.failure`).
 */
export async function run(options: RunOptions = {}): Promise<number> {
  const configDir = options.configDir ?? CONFIG_DIR;
  // Wall time for what is dated (a reply's footer, the page's hours), the monotonic clock for
  // what is paced.
  const wall = options.clock ?? systemClock;
  const steady = options.clock ?? monotonicClock;

  const registry = options.registry ?? REGISTRY;
  const config = loadConfig(registry, configDir);
  const lock = await singleInstance(configDir);
  let stop: StopSignals | null = null;
  const onFailure = (): void => stop?.fail();
  try {
    const state = (options.openState ?? ((path, modules) => new StateStore(path, { modules })))(
      join(configDir, "state.json"),
      { agent: config.agent, chat: config.chat },
    );
    // `loadConfig` refused a name the registry does not hold, so both entries exist.
    const agentEntry = registry.agents[config.agent] as AgentEntry;
    const chatEntry = registry.chats[config.chat] as ChatEntry;
    const backend = agentEntry.build({ variables: config.agentVariables, clock: steady });
    const limits = backend.usageLimits?.bind(backend);
    // The core exists once the sessions do, and the chat is built before them: it reads the core
    // through `context.core()` when it first needs it.
    let core: CorePort | null = null;
    const context: ChatContext = {
      variables: config.chatVariables,
      allowedRoot: config.allowedRoot,
      clock: wall,
      steady,
      core: () => {
        if (core === null) throw new Error("the core is read before the daemon built it");
        return core;
      },
    };
    const chat = await chatEntry.build(context);
    const names = namesOf(backend, chat);
    const approvals = new Approvals(names);
    const holds = new Holds();
    const sessions = new SessionManager({
      chat,
      agent: backend,
      state,
      approvals,
      holds,
      usage: limits === undefined ? null : new UsageCache(limits),
      clock: steady,
    });
    // Aborted once the chat has stopped: a flow still in flight then does nothing more.
    const stopping = new AbortController();
    const { inbound } = buildFlows({
      chat,
      agent: backend,
      sessions,
      state,
      approvals,
      holds,
      names,
      allowedRoot: config.allowedRoot,
      stopped: stopping.signal,
      now: () => wall.time(),
    });
    core = { sessions, state, approvals, holds, agent: backend };

    const cleanOnce = (): Promise<void> =>
      clean((channel) => chat.channelState(channel), state, {
        threadLookup: (ref) => chat.threadState(ref),
        stopping: () => sessions.draining || (stop?.received.length ?? 0) > 0,
        alive: async (directory) =>
          backend.capabilities.sessionListing ? backend.aliveSessions(directory) : null,
        live: () => sessions.liveThreads(),
        chat: chat.name,
        openedAt: (ref) => chat.openedAt(ref),
      });
    const cleaning = new AbortController();
    let cleaned: Promise<void> | null = null;
    // Held until the shutdown is done (see the header).
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    try {
      // Installed before the repair, not after, so a SIGTERM that arrives during a long repair
      // (many threads, each Slack call under the shared rate limiter) is caught and not left to
      // the default disposition, which ends the process at once and skips the shutdown below
      // (the single-instance lock, the Socket Mode connection, every session). The repair still
      // runs to completion either way: the signal is only lost if nothing listens yet.
      const signals = new StopSignals(options.signals ?? process);
      stop = signals;
      // A failure that came earlier is applied now, like a signal that came during the repair.
      if (options.failure?.aborted) signals.fail();
      else options.failure?.addEventListener("abort", onFailure, { once: true });

      // Repaired, then cleaned, before the connection opens: the chat (already built, and so
      // known to its workspace) works without it, and opening it is what starts delivering
      // events. A pruned thread's leftovers must be repaired first.
      await repair(chat, state);
      await cleanOnce();
      cleaned = cleanEvery({
        seconds: CLEAN_EVERY_SECONDS,
        clean: cleanOnce,
        sessions,
        clock: steady,
        signal: cleaning.signal,
      });
      // The session index (the owner's Home tab): written once what the last run left is
      // repaired and pruned, then again whenever state.json's sessions change.
      state.onSessionsChange = (changed) => chat.index?.refresh(changed);
      chat.index?.refresh();

      await chat.start(inbound);
      await postUpgradeNotices(chat, state, names);
      await signals.requested;
      // launchd stops and restarts with SIGTERM: the turns already running finish first. Not on
      // SIGINT: see `StopSignals`. A second signal stops without waiting.
      if (signals.received[0] === "SIGTERM") {
        logger.info("stopping: letting running turns finish");
        await signals.drain((cutShort) => sessions.drain(cutShort), steady, DRAIN_LIMIT_SECONDS);
      }
    } finally {
      logger.info("shutting down");
      const progress = options.shutdownProgress ?? (() => {});
      progress();
      cleaning.abort();
      if (cleaned !== null) await step("stop the cleanup", () => cleaned, progress);
      // The connection, and the clips' waits, whose timers would keep the process alive.
      await step(
        "stop the chat",
        async () => {
          try {
            await chat.stop();
          } finally {
            stopping.abort();
          }
        },
        progress,
      );
      await step("close the sessions", () => sessions.closeAll(progress), progress);
      // After the sessions: the page shows them as this stop left them.
      await step("close the chat", () => chat.close(), progress);
      await step("close the agent", () => backend.close(), progress);
      clearInterval(keepAlive);
    }
  } finally {
    options.failure?.removeEventListener("abort", onFailure);
    try {
      await lock.release();
    } finally {
      stop?.dispose();
    }
  }
  return stop?.failed ? 1 : 0;
}

/**
 * What the process does with a rejection or an exception nobody handled: the name goes to the
 * log, and after an exception `stop` is asked for, which stops the daemon (see the header).
 */
export function installProcessHandlers(events: ProcessEvents, stop: () => void): void {
  events.on("unhandledRejection", (reason) => {
    logger.error(`unhandled rejection: ${errorName(reason)}`);
  });
  events.on("uncaughtException", (error) => {
    logger.error(`uncaught exception: ${errorName(error)}`);
    stop();
  });
}

/** The entry point: runs the daemon, then ends the process: 0 after a stop, 1 after a failure. */
export async function main(options: MainOptions = {}): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const later =
    options.later ??
    ((seconds, action) => {
      const timer = deferred(seconds, action);
      return () => clearTimeout(timer);
    });
  const failure = new AbortController();
  // One deadline at a time. A failure's is fixed: armed at the failure, replacing any other, and
  // never moved. A signal's moves at every report of progress, so that it ends only a shutdown
  // that completes no step for `SHUTDOWN_LIMIT_SECONDS`.
  let cancel: (() => void) | null = null;
  let fixed = false;
  const arm = (): void => {
    cancel?.();
    cancel = later(SHUTDOWN_LIMIT_SECONDS, () => {
      logger.error("the shutdown did not finish: ending the process");
      exit(1);
    });
  };
  installProcessHandlers(options.process ?? process, () => {
    if (failure.signal.aborted) return;
    failure.abort();
    fixed = true;
    arm();
  });
  const progress = (): void => {
    if (!fixed) arm();
  };
  try {
    const code = await run({ ...options, failure: failure.signal, shutdownProgress: progress });
    // At once: the Socket Mode connection outlives the stop (see the header).
    exit(code);
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof StateError ||
      error instanceof AlreadyRunning
    ) {
      logger.error(error.message);
    } else {
      logger.error(`stopped by an unexpected error: ${errorName(error)}`);
    }
    exit(1);
  }
}

if (import.meta.main) {
  const invocation = parseArguments(process.argv.slice(2));
  if (invocation.kind === "run") {
    void main();
  } else {
    // An exit code, not `process.exit`: a write to a pipe can still be pending on macOS.
    process.exitCode = answer(invocation, {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  }
}

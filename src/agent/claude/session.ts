/**
 * One Claude Code session over a single `query()` with streaming input.
 *
 * The SDK's `query()` starts one Claude Code process. Prompts reach it through an async iterable
 * the session keeps open, so a prompt can be sent at any moment, in the middle of a turn too
 * (`replay-user-messages` makes Claude Code say which prompts it took). Everything the process
 * says comes back as the records of the query's stream, which a `Translator` turns into the
 * seam's events, and as the calls of the permission callback and of the two hooks the daemon
 * registers. A task of its own (`#pump`) reads that stream.
 */
import {
  type EffortLevel,
  type HookCallback,
  type Options,
  type SDKUserMessage,
  type PermissionMode as SdkPermissionMode,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "../../log.ts";
import { errorName, isRecord } from "../../values.ts";
import {
  type AgentInfo,
  type AgentSession,
  type ContextUsage,
  type PermissionMode,
  type Prompt,
  type RequestHandler,
  ResumeRefused,
  type SessionEvent,
  type StartOptions,
} from "../seam.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { postToolUseHookEvents, stopHookEvents } from "./hooks.ts";
import { agentInfo, contextUsage as contextUsageOf } from "./info.ts";
import { userMessage } from "./prompt.ts";
import { permissionResult, questionResult, toRequest } from "./requests.ts";
import { Translator } from "./translate.ts";

export const logger = getLogger("awaydesk.agent.claude.session");

// The reason given when the stream ends without an exception.
const PROCESS_EXITED = "the Claude Code process exited";
// How the SDK says the process ended, and the name each way is given (issue #238). It throws a
// plain `Error` for these, with no class and no code to tell them by, and its troubleshooting
// page says to match on the message (code.claude.com/docs/en/agent-sdk/troubleshooting, read
// 2026-10-11): a nonzero exit, a signal, and an error result the CLI reported before it exited.
// Only the start of the message is read; what follows is the CLI's own words.
const LOST_PROCESS: readonly (readonly [start: string, name: string])[] = [
  ["Claude Code process exited with code ", "ProcessExited"],
  ["Claude Code process terminated by signal ", "ProcessKilled"],
  ["Claude Code returned an error result: ", "ErrorResult"],
];

/**
 * The name of a failure of the SDK: `errorName`, except for an error that names itself no more
 * than `Error` and whose message starts as one of `LOST_PROCESS`.
 */
function lostName(error: unknown): string {
  const name = errorName(error);
  if (name !== "Error" || !(error instanceof Error)) return name;
  return LOST_PROCESS.find(([start]) => error.message.startsWith(start))?.[1] ?? name;
}

/** A Claude Code process that ended, named for how it did; the SDK's own error is its cause. */
export class ProcessLostError extends Error {
  constructor(name: string, cause: unknown) {
    super("the Claude Code process ended", { cause });
    this.name = name;
  }
}

/** `error` as it leaves this class: under its name when it says the process ended, else itself. */
function underItsName(error: unknown): unknown {
  const name = lostName(error);
  return name === errorName(error) ? error : new ProcessLostError(name, error);
}
// What a call is told when nobody could be asked about it. This layer does not import
// `src/core/`, so the core's own text for it (`APPROVAL_UNPOSTED`) is not reused.
const REQUEST_UNSHOWN = "awaydesk could not show this request in Slack, so nobody approved it.";

/** The members of the SDK's `Query` this class calls: a test passes a fake that has these. */
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel: EffortLevel | null }): Promise<void>;
  initializationResult(): Promise<unknown>;
  getContextUsage(): Promise<unknown>;
  close(): void;
}

/** The SDK's `query` as this class uses it. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryHandle;

/** A session was used after it ended: closed, or its process lost. */
export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";

  constructor() {
    super("the Claude Code session is closed");
  }
}

/** What a session is started with: the seam's options, and whether Claude Code gets `--chrome`. */
export interface SessionConfig extends StartOptions {
  readonly chrome: boolean;
  /**
   * A session the daemon starts for itself (the usage probe), not for a thread: it is not given
   * the permission to bypass that a thread's `!bypass on` needs.
   */
  readonly bare?: boolean;
}

/**
 * An unbounded queue read as an async iterable by one consumer. `end` lets what was pushed be
 * read first, then finishes; a `return` from the consumer (a `break`) leaves the queue as it is.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #ended = false;
  #wake: (() => void) | null = null;

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    this.#signal();
  }

  end(): void {
    this.#ended = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (this.#items.length === 0 && !this.#ended) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        const item = this.#items.shift();
        if (item === undefined) return { done: true, value: undefined };
        return { done: false, value: item };
      },
      return: async (): Promise<IteratorResult<T>> => ({ done: true, value: undefined }),
    };
  }
}

// A level or a mode outside what `CAPABILITIES` declares is refused (the seam's contract): the
// core sends only declared ones.
function effortOf(level: string): EffortLevel {
  if (!CAPABILITIES.effortLevels.includes(level)) {
    throw new RangeError(`unknown effort level: ${level}`);
  }
  return level as EffortLevel;
}

function modeOf(mode: PermissionMode): SdkPermissionMode {
  if (!Object.values(CAPABILITIES.permissionModes).includes(mode)) {
    throw new RangeError(`unknown permission mode: ${mode}`);
  }
  return mode as SdkPermissionMode;
}

export class ClaudeSession implements AgentSession {
  readonly events: AsyncIterable<SessionEvent>;
  readonly #config: SessionConfig;
  readonly #translator = new Translator();
  readonly #queue = new AsyncQueue<SessionEvent>();
  readonly #input = new AsyncQueue<SDKUserMessage>();
  readonly #query: QueryHandle;
  readonly #finished: Promise<void>;
  #closing = false;
  #ended = false;
  #started = false;
  // An error result arrived before the process answered the start: a resume it refused.
  #startRefused = false;

  /** Spawns the Claude Code process: `ready` says when it answered. */
  constructor(
    config: SessionConfig,
    requests: RequestHandler,
    queryFunction: QueryFunction = sdkQuery,
  ) {
    this.#config = config;
    this.events = this.#queue;
    this.#query = queryFunction({
      prompt: this.#input,
      options: this.#options(requests),
    });
    this.#finished = this.#pump();
  }

  #options(requests: RequestHandler): Options {
    const { folder, resume, model, effort, chrome } = this.#config;
    // Makes bypass possible, not active: `setPermissionMode` switches it on the live session.
    // `replay-user-messages` (CLI reference): Claude Code re-emits each prompt with the uuid the
    // daemon sent it under, which tells a prompt it took into a running turn from one that waits
    // for a turn of its own. The owner's "Enabled by default" reaches an interactive session
    // only: here `--chrome` is what connects Claude Code's Chrome integration.
    const extraArgs: Record<string, string | null> = { "replay-user-messages": null };
    if (chrome) extraArgs.chrome = null;
    return {
      cwd: folder,
      ...(resume !== null && { resume }),
      // The effort `/effort` set does not survive a resume (measured 2026-09-28), so the daemon
      // keeps it per thread and passes it back here.
      ...(effort !== null && { effort: effortOf(effort) }),
      ...(model !== null && { model }),
      settingSources: [...this.#config.settingsSources],
      includePartialMessages: true,
      ...(!this.#config.bare && { allowDangerouslySkipPermissions: true }),
      extraArgs,
      canUseTool: async (toolName, input, context) => {
        // A callback that rejects is answered with a `control_response` of subtype `error`
        // (`handleControlRequest`, SDK 0.3.296), which is not a deny. A request nobody could be
        // asked about is refused here, and only the error's name is kept: its message may quote
        // the tool's input.
        try {
          const request = toRequest(toolName, input, context);
          if (request.type === "question") {
            return questionResult(await requests.question(request), input);
          }
          return permissionResult(await requests.permission(request), input);
        } catch (error) {
          logger.error(`could not ask the owner about a call: ${errorName(error)}`);
          return { behavior: "deny", message: REQUEST_UNSHOWN };
        }
      },
      // The Stop hook's input carries the effort level Claude Code runs at: the footer's only
      // source for it, since no message reports it. Every hook input carries the `cwd` the
      // session works in; PostToolUse reports it after each tool, so a turn stopped or failed
      // before its Stop still moves the footer's branch.
      hooks: {
        Stop: [{ hooks: [this.#hook(stopHookEvents)] }],
        PostToolUse: [{ hooks: [this.#hook(postToolUseHookEvents)] }],
      },
      // The process's stderr may quote the conversation: only its size is kept.
      stderr: (line) => logger.debug(`claude stderr: ${line.length} chars`),
    };
  }

  #hook(events: (input: unknown) => SessionEvent[]): HookCallback {
    return async (input) => {
      for (const event of events(input)) this.#queue.push(event);
      return {};
    };
  }

  /** Reads the query's stream until it ends, whatever ends it; never rejects. */
  async #pump(): Promise<void> {
    let reason = PROCESS_EXITED;
    try {
      for await (const record of this.#query) {
        if (!this.#started && isRecord(record) && record.type === "result") {
          this.#startRefused = record.is_error === true;
        }
        try {
          for (const event of this.#translator.translate(record)) this.#queue.push(event);
        } catch (error) {
          // One record that fails to read must not end the session.
          logger.error(`could not read a record: ${errorName(error)}`);
        }
      }
    } catch (error) {
      reason = lostName(error);
    }
    this.#ended = true;
    if (!this.#closing) {
      logger.error(`session stopped: ${reason}`);
      this.#queue.push({ type: "process_lost", reason });
    }
    this.#queue.end();
    // The process may still be running (a stream that failed): reap it.
    try {
      this.#query.close();
    } catch (error) {
      logger.error(`could not close the process: ${errorName(error)}`);
    }
  }

  /**
   * Resolves once Claude Code answered the start. Rejects with `ResumeRefused` when it refused to
   * resume the stored session, and with the failure itself otherwise; the session is closed then.
   */
  async ready(): Promise<void> {
    try {
      await this.#query.initializationResult();
      this.#started = true;
    } catch (error) {
      // The stream is read to its end first: the error result it carries tells a refused resume
      // from a process that failed to start.
      await this.close();
      if (this.#config.resume !== null && this.#startRefused)
        throw new ResumeRefused({ cause: error });
      throw underItsName(error);
    }
  }

  /**
   * Asks the query. The SDK rejects a request with the error that ended the process, when it
   * did: that one leaves under its name, as the stream's own end does.
   */
  async #ask<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw underItsName(error);
    }
  }

  async send(prompt: Prompt): Promise<void> {
    if (this.#closing || this.#ended) throw new SessionClosedError();
    // Before the push: the replay can come back before this call returns.
    this.#translator.promptSent(prompt.id);
    this.#input.push(userMessage(prompt));
  }

  async interrupt(): Promise<void> {
    await this.#ask(() => this.#query.interrupt());
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#ask(() => this.#query.stopTask(taskId));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#ask(() => this.#query.setPermissionMode(modeOf(mode)));
  }

  async setModel(model: string | null): Promise<void> {
    await this.#ask(() => this.#query.setModel(model ?? undefined));
  }

  /**
   * Live, with no reconnect (`applyFlagSettings`, SDK 0.3.296): 36 ms in the spike's measurement,
   * 28 ms in the back end's own live check, both on 2026-10-10.
   */
  async setEffort(level: string | null): Promise<void> {
    const effortLevel = level === null ? null : effortOf(level);
    await this.#ask(() => this.#query.applyFlagSettings({ effortLevel }));
  }

  async contextUsage(): Promise<ContextUsage> {
    return contextUsageOf(await this.#ask(() => this.#query.getContextUsage()));
  }

  /**
   * The initialization result holds the models, the commands with their aliases and the mode the
   * session started in (measured 2026-10-10 on SDK 0.3.296): nothing else is asked.
   */
  async info(): Promise<AgentInfo> {
    return agentInfo(await this.#ask(() => this.#query.initializationResult()));
  }

  /**
   * Ends the input, closes the query and resolves once its stream has ended, so that a new
   * session may resume the same id right after (the process needs real time to flush).
   */
  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#input.end();
      try {
        this.#query.close();
      } catch (error) {
        logger.error(`could not close the process: ${errorName(error)}`);
      }
    }
    await this.#finished;
  }
}

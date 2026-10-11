/**
 * The harness of the session tests: a real `SessionManager` over a scripted agent back end and
 * the real Slack provider on `FakeSlack`.
 *
 * The fake stands at the agent seam, and a script is made of recordings: each wire record goes
 * through the session's own `Translator` (the real one, as the live session does it), so a text
 * streamed and then repeated reaches the core once and a replayed prompt is `prompt_taken`. A
 * script can also hold a session event as it is, a request put to the handler the core passed to
 * `start`, a hook's run, and the end of the stream.
 *
 * `sdkMessages` gives a recording as one item per message the Python SDK parsed: it parsed no
 * `command_lifecycle` and no `tool_progress` record (checked on every recording,
 * claude-agent-sdk 0.2.165), so an index into the list is the message's index in that SDK's.
 *
 * Two clocks, both fake. `clock` is the sessions' own (`INJECTED_TURN_WAIT`, the idle close, the
 * drain's poll): what a test moves with `advance` to cross a wait of the sessions.
 * `slackClock` is the provider's (a reply's debounce and deadline, the status line's refresh).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { NAME, WORDS } from "../../src/agent/claude/backend.ts";
import { CAPABILITIES } from "../../src/agent/claude/capabilities.ts";
import { postToolUseHookEvents, stopHookEvents } from "../../src/agent/claude/hooks.ts";
import { agentInfo, contextUsage } from "../../src/agent/claude/info.ts";
import { toRequest } from "../../src/agent/claude/requests.ts";
import { Translator } from "../../src/agent/claude/translate.ts";
import { locate, Unkeyed } from "../../src/agent/claude/trust.ts";
import type {
  AgentBackend,
  AgentInfo,
  AgentSession,
  Capabilities,
  ContextUsage,
  ListedSession,
  PermissionAnswer,
  PermissionRequest,
  Prompt,
  PromptContent,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import type { ChatCapabilities } from "../../src/chat/seam.ts";
import { UpdateLimiter } from "../../src/chat/slack/reply/limiter.ts";
import { resetStatusFlags } from "../../src/chat/slack/reply/status.ts";
import { SlackChat } from "../../src/chat/slack/thread.ts";
import { UsageCache } from "../../src/core/footer.ts";
import { Holds } from "../../src/core/hold.ts";
import { Approvals } from "../../src/core/requests.ts";
import { PROCESS_EXITED } from "../../src/core/sessions/constants.ts";
import type { SessionDeps } from "../../src/core/sessions/deps.ts";
import { SessionManager } from "../../src/core/sessions/manager.ts";
import type { ThreadSession } from "../../src/core/sessions/session.ts";
import { StateStore } from "../../src/core/state.ts";
import { named } from "../../src/core/texts.ts";
import { setWriter } from "../../src/log.ts";
import {
  type AsyncEvent,
  BOT,
  CHANNEL,
  FakeClock,
  FakeSlack,
  OWNER,
  TEAM,
  THREAD,
} from "./fake-slack.ts";
import { type JsonObject, sdkJson, sdkRecords } from "./fixtures.ts";
import { NAMES } from "./names.ts";

/** A point in a scripted turn where the CLI would ask the host for a permission decision. */
export interface CanUseToolCall {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly callId: string;
}

/** One step of a script. */
export type Item =
  /** A wire record of a recording, read by the session's translator. */
  | { readonly record: JsonObject }
  /** A session event as it is. */
  | { readonly event: SessionEvent }
  /** The CLI asks for a permission decision, and waits for it before it goes on. */
  | { readonly ask: CanUseToolCall }
  /** The CLI runs the host's hooks: Stop before the result, PostToolUse after a tool. */
  | { readonly hook: "Stop" | "PostToolUse"; readonly input: JsonObject }
  /** The CLI process exits and its stream ends. */
  | { readonly end: true };

export type Batch = readonly Item[];

// The records the Python SDK's parser gave no message for.
const UNPARSED = new Set(["command_lifecycle", "tool_progress"]);

/** A recording as one item per message the Python SDK parsed. */
export function sdkMessages(name: string): Item[] {
  return sdkRecords(name)
    .filter((record) => !UNPARSED.has(String(record.type)))
    .map((record) => ({ record }));
}

/** The record of an item, or null for an item that is none. */
export function recordOf(item: Item | undefined): JsonObject | null {
  return item !== undefined && "record" in item ? item.record : null;
}

/** Whether the item is a record of that type, and of that subtype when one is given. */
export function isRecord(item: Item | undefined, type: string, subtype?: string): boolean {
  const record = recordOf(item);
  return (
    record !== null && record.type === type && (subtype === undefined || record.subtype === subtype)
  );
}

/** Whether the item is a result record. */
export function isResult(item: Item | undefined): boolean {
  return isRecord(item, "result");
}

/** Whether the item is a `system` record of that subtype. */
export function isSystem(item: Item | undefined, subtype: string): boolean {
  return isRecord(item, "system", subtype);
}

/** The turns of a script: cut after each result. */
export function splitTurns(items: readonly Item[]): Item[][] {
  const turns: Item[][] = [[]];
  for (const item of items) {
    turns.at(-1)?.push(item);
    if (isResult(item)) turns.push([]);
  }
  return turns.filter((turn) => turn.length > 0);
}

export function canUseToolCall(toolName: string, input: JsonObject, callId = "toolu_fake_1"): Item {
  return { ask: { toolName, input, callId } };
}

export function hookRun(input: JsonObject, hook: "Stop" | "PostToolUse" = "Stop"): Item {
  return { hook, input };
}

export const END_OF_STREAM: Item = { end: true };

export function event(sessionEvent: SessionEvent): Item {
  return { event: sessionEvent };
}

// The items a prompt's replay goes before: the first stream event, assistant, user or result
// message of the turn.
const WORDED_RECORDS = new Set(["stream_event", "assistant", "user", "result"]);
const WORDED_EVENTS = new Set<SessionEvent["type"]>([
  "message_started",
  "message_ended",
  "text_started",
  "text_delta",
  "text",
  "call_started",
  "call_ended",
  "agent_error",
  "turn_ended",
]);

function worded(item: Item): boolean {
  if ("record" in item) return WORDED_RECORDS.has(String(item.record.type));
  return "event" in item && WORDED_EVENTS.has(item.event.type);
}

/** What a scripted session is given. */
export interface Script {
  readonly turns?: readonly Batch[];
  /** The answer to `info()`; the recorded `server-info.json`, started in `default`, when absent. */
  readonly info?: AgentInfo;
  readonly contextUsage?: ContextUsage;
  /** `start` rejects with it. */
  readonly startError?: Error;
  /** A start that waits for the test, as a CLI does while it starts. */
  readonly startGate?: AsyncEvent;
  readonly infoError?: Error;
  readonly contextUsageError?: Error;
  /** `close` rejects with it. */
  readonly closeError?: Error;
  /** A close that waits for the test, as a CLI takes real time to flush and exit after EOF. */
  readonly closeGate?: AsyncEvent;
}

const CLOSED = Symbol("closed");

/**
 * A feed of batches for one reader. A batch put while the reader waits reaches it on the next
 * turn of the event loop (`setImmediate`): what the test, or the session that just sent a prompt,
 * does next in the same step comes first.
 */
class Feed {
  readonly #items: Array<Batch | typeof CLOSED> = [];
  #wake: (() => void) | null = null;

  put(item: Batch | typeof CLOSED): void {
    this.#items.push(item);
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) setImmediate(wake);
  }

  async get(): Promise<Batch | typeof CLOSED> {
    while (this.#items.length === 0) {
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    return this.#items.shift() as Batch | typeof CLOSED;
  }
}

function defaultInfo(): AgentInfo {
  const recorded = sdkJson("server-info") as JsonObject;
  return agentInfo({
    commands: recorded.commands,
    models: recorded.models,
    current_permission_mode: "default",
  });
}

/** Stands in for a live agent session at the seam and plays scripted turns. */
export class FakeAgentSession implements AgentSession {
  readonly options: StartOptions;
  readonly events: AsyncIterable<SessionEvent>;
  readonly #requests: RequestHandler;
  readonly #script: Script;
  readonly #turns: Batch[];
  readonly #feed = new Feed();
  readonly #translator = new Translator();
  connected = false;
  /** Each prompt as sent: its text, or the parts of a prompt with an image. */
  queries: PromptContent[] = [];
  /** Every prompt as sent, id included. */
  sent: Prompt[] = [];
  modes: string[] = [];
  modelsSet: Array<string | null> = [];
  effortsSet: Array<string | null> = [];
  interrupts = 0;
  stoppedTasks: string[] = [];
  /** What the core answered each request with, in order. */
  permissionResults: Array<PermissionAnswer | QuestionAnswer> = [];

  constructor(options: StartOptions, requests: RequestHandler, script: Script = {}) {
    this.options = options;
    this.#requests = requests;
    this.#script = script;
    this.#turns = [...(script.turns ?? [])];
    this.events = this.#stream();
  }

  async send(prompt: Prompt): Promise<void> {
    this.sent.push(prompt);
    this.queries.push(prompt.content);
    this.#translator.promptSent(prompt.id);
    const batch = this.#turns.shift();
    if (batch !== undefined) this.#feed.put(this.#replayed(batch, prompt));
  }

  /**
   * `batch` with the replay of the prompt it answers, as Claude Code sends it with
   * `--replay-user-messages`: a `user` record of the prompt's text under the id it was sent
   * with, after the turn's `init` and before its first words (recorded 2026-10-06, CLI 2.1.286,
   * and 2026-10-09, 2.1.292). A command is not replayed so (`compact.jsonl`), and a prompt with
   * an image was never recorded: those turns are played as scripted.
   */
  #replayed(batch: Batch, prompt: Prompt | undefined): Batch {
    if (prompt === undefined) return batch;
    const { content } = prompt;
    if (typeof content !== "string" || content.trimStart().startsWith("/")) return batch;
    const found = batch.findIndex(worded);
    const at = found === -1 ? batch.length : found;
    const replay: Item = {
      record: {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: prompt.id,
      },
    };
    return [...batch.slice(0, at), replay, ...batch.slice(at)];
  }

  /**
   * Deliver the turn of the last prompt sent, with its replay, when the test rather than
   * `turns` holds that turn.
   */
  answer(batch: Batch): void {
    this.#feed.put(this.#replayed(batch, this.sent.at(-1)));
  }

  /** Deliver a turn nobody asked for, as the CLI does for a background-task notification. */
  inject(batch: Batch): void {
    this.#feed.put(batch);
  }

  async *#stream(): AsyncGenerator<SessionEvent> {
    for (;;) {
      const batch = await this.#feed.get();
      if (batch === CLOSED) return;
      for (const item of batch) {
        if ("end" in item) {
          yield { type: "process_lost", reason: named(PROCESS_EXITED, NAMES) };
          return;
        }
        if ("ask" in item) {
          this.permissionResults.push(await this.#ask(item.ask));
        } else if ("hook" in item) {
          yield* item.hook === "Stop"
            ? stopHookEvents(item.input)
            : postToolUseHookEvents(item.input);
        } else if ("record" in item) {
          yield* this.#translator.translate(item.record);
        } else {
          yield item.event;
        }
      }
    }
  }

  /** The request the back end makes of a permission callback, put to the core's handler. */
  #ask(call: CanUseToolCall): Promise<PermissionAnswer | QuestionAnswer> {
    const mapped = toRequest(`request-${call.callId}`, call.toolName, call.input, {
      toolUseID: call.callId,
    });
    if (mapped.type === "question") {
      const request: QuestionRequest = { ...mapped, toolName: call.toolName, title: null };
      return this.#requests.question(request);
    }
    const request: PermissionRequest = mapped;
    return this.#requests.permission(request);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async setModel(model: string | null): Promise<void> {
    this.modelsSet.push(model);
  }

  async setEffort(level: string | null): Promise<void> {
    this.effortsSet.push(level);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
  }

  async info(): Promise<AgentInfo> {
    if (this.#script.infoError !== undefined) throw this.#script.infoError;
    return this.#script.info ?? defaultInfo();
  }

  async contextUsage(): Promise<ContextUsage> {
    if (this.#script.contextUsageError !== undefined) throw this.#script.contextUsageError;
    return this.#script.contextUsage ?? contextUsage(sdkJson("context-usage"));
  }

  async close(): Promise<void> {
    if (this.#script.closeGate !== undefined) await this.#script.closeGate.wait();
    this.connected = false;
    this.#feed.put(CLOSED);
    if (this.#script.closeError !== undefined) throw this.#script.closeError;
  }
}

/** `trust.trusted_repository` for a test about something else: every repository counts as trusted. */
export async function anyRepository(directory: string): Promise<Repository | null> {
  try {
    return await locate(directory);
  } catch (error) {
    if (error instanceof Unkeyed) return null;
    throw error;
  }
}

/** The back end of a harness: each `start` plays the next script. */
export class FakeAgentBackend implements AgentBackend {
  readonly name = NAME;
  readonly words = WORDS;
  capabilities: Capabilities = CAPABILITIES_FOR_TESTS;
  /** Every session started, in order; one whose start failed is there too. */
  readonly sessions: FakeAgentSession[] = [];
  /** What `listSessions` answers for a folder. */
  listed: ListedSession[] = [];
  /** The members of the listing, the trust and the usage limits called, in order. */
  readonly called: string[] = [];
  trusted: (folder: string) => Promise<boolean> = async () => true;
  repository: (folder: string, sessionFolder: string) => Promise<Repository | null> = (folder) =>
    anyRepository(folder);
  readonly #scripts: Script[];

  constructor(scripts: readonly Script[]) {
    this.#scripts = [...scripts];
  }

  async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    const script = this.#scripts.shift() ?? {};
    const session = new FakeAgentSession(options, requests, script);
    this.sessions.push(session);
    if (script.startGate !== undefined) await script.startGate.wait();
    if (script.startError !== undefined) throw script.startError;
    session.connected = true;
    return session;
  }

  async listSessions(_folder: string): Promise<readonly ListedSession[]> {
    this.called.push("listSessions");
    return this.listed;
  }

  async datedSessions(
    _folder: string,
    sessions: readonly ListedSession[],
  ): Promise<ListedSession[]> {
    this.called.push("datedSessions");
    return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  }

  async aliveSessions(_folder: string): Promise<ReadonlySet<string> | null> {
    this.called.push("aliveSessions");
    return new Set(this.listed.map((session) => session.id));
  }

  folderTrusted(folder: string): Promise<boolean> {
    this.called.push("folderTrusted");
    return this.trusted(folder);
  }

  trustedRepository(folder: string, sessionFolder: string): Promise<Repository | null> {
    this.called.push("trustedRepository");
    return this.repository(folder, sessionFolder);
  }

  async close(): Promise<void> {}
}

// The Claude back end's capabilities, with the effort levels the seam asks a back end to name
// (`EffortLevel` of the SDK, as `src/agent/claude/session.ts` lists them).
const CAPABILITIES_FOR_TESTS: Capabilities = {
  ...CAPABILITIES,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
};

export const WRITES = [
  "chat.postMessage",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
] as const;

// The work of the daemon that a turn of the event loop does not finish: a file call and the
// close of its handle, a git process and its pipes. The test runner's own pipes are there from
// the start, so what counts is what is in flight beyond them.
const REAL_WORK = new Set([
  "FSReqPromise",
  "FSReqCallback",
  "CloseReq",
  "ProcessWrap",
  "PipeWrap",
  "WriteWrap",
  "ShutdownWrap",
]);

function realWorkInFlight(): number {
  return process.getActiveResourcesInfo().filter((name) => REAL_WORK.has(name)).length;
}

const AT_REST = realWorkInFlight();
// Turns of the event loop with no real work in flight before the daemon counts as at rest.
const CALM_TURNS = 5;
// The footer's own limit on its `git` is 5 seconds; past this a stuck resource is not waited for.
const REAL_WORK_LIMIT_MS = 10_000;

/**
 * What a running daemon keeps open for as long as it runs, and so is no work in flight: outside
 * macOS its single-instance lock is a listening socket or pipe (`src/core/lock.ts`).
 */
export const HELD_BY_A_RUNNING_DAEMON = process.platform === "darwin" ? 0 : 1;

/**
 * Wait until no real work started by the daemon is in flight (a file call, a `git` process): it
 * answers on the operating system's time, so under load it outlasts any fixed number of turns.
 * Returns at once when nothing is in flight. `held` counts what stays open on purpose while the
 * caller's daemon runs (`HELD_BY_A_RUNNING_DAEMON`), which would otherwise be waited for until
 * the limit, every time.
 */
export async function realWorkDone(held = 0): Promise<void> {
  const deadline = Date.now() + REAL_WORK_LIMIT_MS;
  let calm = 0;
  while (calm < CALM_TURNS && Date.now() < deadline) {
    if (realWorkInFlight() > AT_REST + held) {
      calm = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    } else {
      calm += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * One turn of the event loop, then whatever real work it set going: what a test waits between
 * two looks at the daemon. A count of bare turns is not a wait: a file call outlasts any number
 * of them on a loaded machine.
 */
export async function settledTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await realWorkDone();
}

/**
 * A fake clock whose `advance` returns once the real work it set going is done: a timer that
 * fires into an end of turn starts the footer's `git`, and a test that advances a clock and
 * then asserts the end state would otherwise race the operating system.
 */
export class SettledClock extends FakeClock {
  override async advance(seconds: number): Promise<void> {
    await super.advance(seconds);
    await realWorkDone();
  }
}

export interface HarnessOptions {
  /** The reply's debounce, in seconds on `slackClock`. */
  readonly debounceSeconds?: number;
  readonly finalRetrySeconds?: number;
  readonly tasksKept?: number;
  readonly taskRepliesKept?: number;
  /** The client replies are written with, when it is not the one everything else goes through. */
  readonly replies?: FakeSlack;
  /**
   * What the sessions' chat declares instead of the provider's own. The sessions then write
   * through a facade that records every call (`Harness.chatCalls`); without it they get the
   * provider itself.
   */
  readonly chatCapabilities?: Partial<ChatCapabilities>;
  /** `null`: no usage cache in the sessions' deps, as for an agent with no limits. */
  readonly usage?: null;
}

/**
 * `target` with every member called and every property read reported; `wrap` replaces what a
 * member returns (a thread's reply, recorded in turn).
 */
function recording<T extends object>(
  target: T,
  seen: {
    readonly call: (name: string, args: readonly unknown[]) => void;
    readonly read: (name: string) => void;
  },
  wrap: (name: string, value: unknown) => unknown = (_name, value) => value,
): T {
  return new Proxy(target, {
    get(object, name) {
      const value = Reflect.get(object, name);
      if (typeof name !== "string") return value;
      if (typeof value !== "function") {
        seen.read(name);
        return value;
      }
      return (...args: unknown[]) => {
        seen.call(name, args);
        return wrap(name, value.apply(object, args));
      };
    },
  });
}

export class Harness {
  readonly slack: FakeSlack;
  /** A scratch folder, bound to `CHANNEL`, with its symlinks resolved. */
  readonly tmpPath: string;
  readonly state: StateStore;
  readonly approvals = new Approvals(NAMES);
  readonly holds = new Holds();
  readonly backend: FakeAgentBackend;
  /** The sessions' own clock. */
  readonly clock = new SettledClock();
  /** The Slack provider's clock. */
  readonly slackClock = new SettledClock();
  readonly chat: SlackChat;
  readonly deps: SessionDeps;
  manager: SessionManager;
  usageFetches = 0;
  /** The usage cache of the sessions' deps; throws when the harness was made with none. */
  get usage(): UsageCache {
    if (this.deps.usage === null) throw new Error("the harness has no usage cache");
    return this.deps.usage;
  }

  /** The members of the sessions' threads and replies called, when `chatCapabilities` is set. */
  readonly chatCalls: string[] = [];
  /** The properties of those threads read. */
  readonly chatReads: string[] = [];
  /** Every text handed to a reply, as the core handed it. */
  readonly replyTexts: string[] = [];

  constructor(
    slack: FakeSlack,
    tmpPath: string,
    scripts: readonly Script[],
    options: HarnessOptions,
  ) {
    this.slack = slack;
    this.tmpPath = tmpPath;
    this.state = new StateStore(join(tmpPath, "state.json"));
    this.state.bind(CHANNEL, tmpPath);
    this.backend = new FakeAgentBackend(scripts);
    this.chat = new SlackChat({
      slack,
      replies: options.replies ?? slack,
      identity: { teamId: TEAM, ownerUserId: OWNER, botUserId: BOT },
      agent: () => this.backend,
      // A generous burst: these tests are about session orchestration, not the shared
      // limiter's own pacing (that lives in the sink's tests).
      limiter: new UpdateLimiter({ burst: 1_000, clock: this.slackClock }),
      clock: this.slackClock,
      ...(options.debounceSeconds !== undefined && { debounceSeconds: options.debounceSeconds }),
      ...(options.finalRetrySeconds !== undefined && {
        finalRetrySeconds: options.finalRetrySeconds,
      }),
    });
    this.deps = {
      chat:
        options.chatCapabilities === undefined
          ? this.chat
          : this.declaring(options.chatCapabilities),
      agent: this.backend,
      state: this.state,
      approvals: this.approvals,
      usage:
        options.usage === null
          ? null
          : new UsageCache(async () => {
              this.usageFetches += 1;
              return { session: { percent: 5, resetsAt: null }, week: null };
            }),
      holds: this.holds,
      clock: this.clock,
      ...(options.tasksKept !== undefined && { tasksKept: options.tasksKept }),
      ...(options.taskRepliesKept !== undefined && { taskRepliesKept: options.taskRepliesKept }),
    };
    this.manager = new SessionManager(this.deps);
  }

  /** The provider as the sessions see it when the test chooses what the chat declares. */
  private declaring(declared: Partial<ChatCapabilities>): SlackChat {
    const capabilities = { ...this.chat.capabilities, ...declared };
    const seen = {
      call: (name: string, args: readonly unknown[]) => {
        this.chatCalls.push(name);
        if (name === "text" && typeof args[0] === "string") this.replyTexts.push(args[0]);
      },
      read: (name: string) => {
        this.chatReads.push(name);
      },
    };
    const reply = (name: string, value: unknown): unknown =>
      name === "openReply" ? recording(value as object, seen) : value;
    return new Proxy(this.chat, {
      get: (object, name) => {
        if (name === "capabilities") return capabilities;
        if (name !== "thread") {
          const value = Reflect.get(object, name);
          return typeof value === "function" ? value.bind(object) : value;
        }
        return (ref: Parameters<SlackChat["thread"]>[0]) =>
          recording(object.thread(ref), seen, reply);
      },
    });
  }

  /** A restart of the daemon: every session closed, then a new manager on the same state. */
  async restart(): Promise<void> {
    await this.manager.closeAll();
    this.manager = new SessionManager(this.deps);
  }

  /** Every agent session started, in order: the back end's `sessions`. */
  get clients(): FakeAgentSession[] {
    return this.backend.sessions;
  }

  /** The live session of `thread`, opened as a top-level owner message would. */
  session(thread: string = THREAD): ThreadSession {
    const session = this.manager.open(CHANNEL, thread);
    if (session === null) throw new Error("the channel is not bound");
    return session;
  }

  /** The text every posted message ends up showing, in the order they were posted. */
  replies(): string[] {
    return this.slack.messageTexts();
  }

  /**
   * Each reply's own text: `replies()` with the empty entries a silent closing message leaves
   * (it carries no markdown or tool line) filtered out.
   */
  bodies(): string[] {
    return this.replies().filter((reply) => reply !== "");
  }

  /**
   * Every reaction shown on `thread`'s root message, in order: `reactions.add` alone, since
   * `StatusReaction` always adds the new one before removing the previous.
   */
  reactions(thread: string = THREAD): string[] {
    return this.slack
      .callsTo("reactions.add")
      .filter((args) => args.timestamp === thread)
      .map((args) => String(args.name));
  }

  /** Every markdown a write carried: blocks of a post or an update, chunks of a stream. */
  writtenText(): string {
    const texts = (methods: readonly string[], field: string, type: string): string =>
      methods
        .flatMap((method) => this.slack.callsTo(method))
        .flatMap((args) => (Array.isArray(args[field]) ? args[field] : []))
        .filter(
          (part): part is JsonObject =>
            typeof part === "object" && part !== null && !Array.isArray(part) && part.type === type,
        )
        .map((part) => String(part.text))
        .join("\n");
    const blocks = texts(["chat.postMessage", "chat.update"], "blocks", "markdown");
    const chunks = texts(
      ["chat.startStream", "chat.appendStream", "chat.stopStream"],
      "chunks",
      "markdown_text",
    );
    return `${blocks}\n${chunks}`;
  }

  /** The task cards of the first reply's message, as it shows them now. */
  cards(): JsonObject[] {
    return this.slack.createdTs.length > 0 ? (this.slack.messageCards()[0] ?? []) : [];
  }

  /** The methods of the writes made so far, in order. */
  writes(): string[] {
    const writes: readonly string[] = WRITES;
    return this.slack.apiCalls.map((call) => call.method).filter((m) => writes.includes(m));
  }

  /**
   * Let what is ready run to its next wait: every promise callback, and every task that starts
   * on a later turn of the event loop. What a test awaits for the daemon to have acted.
   * Real work the daemon started (a file read, the footer's `git`) is waited for too: its
   * answer comes from the operating system, not from a turn of the loop, so no number of turns
   * stands for it on a loaded machine.
   */
  async idle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await realWorkDone();
  }

  /**
   * A pause of `seconds` as the daemon sees it: what is ready runs, and Slack's clock moves on by
   * `seconds`, a hundredth at a time. The sessions' clock stays put. A step ends with the real
   * work it set going done (`SettledClock`), so a pause is never over before an end of turn
   * that was under way has landed: what a pause asserts afterwards is what it asserted when
   * the footer's `git` answered at once.
   */
  async sleep(seconds: number): Promise<void> {
    await this.idle();
    for (let waited = 0; waited < seconds - 1e-9; waited += 0.01) {
      await this.slackClock.advance(0.01);
    }
  }

  /**
   * Wait for a condition on the fakes by polling it: what is ready runs, and Slack's clock
   * moves on a hundredth of a second at a time, for two seconds at most, so a reply's debounce
   * passes while it polls. The sessions' clock stays put.
   * Each step also yields a moment of real time on top of the real work it waits for
   * (`SettledClock`): some of what a test waits for ends in real file reads and a `git`
   * subprocess, and a loaded machine must not use up the steps first.
   */
  async until(condition: () => boolean, limit = 2.0): Promise<void> {
    await this.idle();
    for (let waited = 0; !condition(); waited += 0.01) {
      if (waited >= limit) throw new Error("the condition never held");
      await this.slackClock.advance(0.01);
      if (!condition()) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}

/**
 * A harness maker for one test: each harness it made has its manager closed and its folder
 * removed when the test ends.
 */
export function harnessFor(
  t: TestContext,
  options: HarnessOptions = {},
): ((...scripts: Script[]) => Harness) & { readonly tmpPath: string } {
  const made: Harness[] = [];
  const slack = new FakeSlack();
  const tmpPath = realpathSync(mkdtempSync(join(tmpdir(), "awd-sessions-")));
  // The two "stop for the rest of the run" flags are the process's: each test starts clear.
  resetStatusFlags();
  // The daemon's log stays out of the test report: a test that reads a line
  // replaces the logger's method (`mock.method`), which this does not touch.
  const writer = setWriter(() => {});
  // A timer that keeps the loop alive for the test's duration: on Node 22 a test that awaits
  // something which never comes, with only unref'd timers pending, lets the process finish and
  // cancels the rest of the file. With this it waits for the runner's own timeout instead.
  const guard = setInterval(() => {}, 1_000);
  t.after(async () => {
    clearInterval(guard);
    for (const harness of made) await harness.manager.closeAll();
    rmSync(tmpPath, { recursive: true, force: true });
    setWriter(writer);
  });
  // `tmpPath` is there before any harness, for a test that arranges the folder first.
  return Object.assign(
    (...scripts: Script[]) => {
      const harness = new Harness(slack, tmpPath, scripts, options);
      made.push(harness);
      return harness;
    },
    { tmpPath },
  );
}

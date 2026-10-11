/**
 * The plain agent: a second, smaller back end of the agent seam, for the tests. It imports the
 * seam and nothing else of the daemon, so a test run with it shows what the core does with an
 * agent that is not Claude.
 *
 * It declares two effort levels that cannot change on a live session, one permission mode,
 * questions, two commands of its own and session listing. It lacks subagents, background tasks,
 * compaction, usage limits, a model list, a changed input, a prompt during a turn and folder
 * trust.
 *
 * A test scripts what each prompt does with `agent.next(...steps)`: one turn per call, played by
 * the next prompt of any session, in order (a prompt past the script gets `say("ok")`). A prompt
 * that starts with `/` and names one of the agent's commands runs the command and takes no turn
 * of the script.
 *
 *   const store = new PlainStore(); // the agent's record of sessions; a test that keeps it and
 *   const agent = new PlainAgent({ store }); // hands it to a new agent has restarted the daemon
 *   agent.next(say("Reading it."), call("Shell", { command: "ls" }, { permission: true }));
 *   agent.next(question("Which one?", ["red", "blue"]), say("Done."));
 *   agent.next(say("Working"), hold());   // waits for `interrupt()` or `session.release()`
 *   agent.next(fail("The request failed."));
 *   agent.next(say("Half"), die());       // the process is gone: `process_lost`
 *   agent.failNextStart(new Error("x"));  // the next `start` rejects with it
 *   agent.sessions;                       // every session started, with `prompts`, `answers`
 */
import type {
  AgentBackend,
  AgentContext,
  AgentEntry,
  AgentInfo,
  AgentSession,
  AgentWords,
  Capabilities,
  CommandInfo,
  ContextUsage,
  ListedSession,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  Prompt,
  Question,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { ResumeRefused } from "../../src/agent/seam.ts";

export const PLAIN_NAME = "Plain";

export const PLAIN_WORDS: AgentWords = Object.freeze({
  author: "Plain",
  command: "plain",
  terminal: "cd {directory} && plain --resume {session}",
});

/** The one permission mode of the plain agent. */
export const PLAIN_MODE = "standard";

export const PLAIN_CAPABILITIES: Capabilities = Object.freeze({
  effortLevels: Object.freeze(["brief", "full"]),
  liveEffort: false,
  permissionModes: Object.freeze({ default: PLAIN_MODE, auto: null, bypass: null }),
  subagents: false,
  backgroundTasks: false,
  compaction: false,
  questions: true,
  changedInput: false,
  usageLimits: false,
  models: false,
  commands: true,
  promptDuringTurn: false,
  sessionListing: true,
  folderTrust: false,
});

/** The two commands of the agent, run by a prompt `/echo text` and `/count text`. */
export const PLAIN_COMMANDS: readonly CommandInfo[] = Object.freeze([
  { name: "echo", description: "Say the text back", argumentHint: "<text>", aliases: ["say"] },
  { name: "count", description: "Count the words", argumentHint: "<text>", aliases: [] },
]);

const VERSION = "plain-1.0";

// The steps of a turn.

export interface CallOptions {
  /** The call's output; `done` when absent. */
  readonly output?: string;
  /** The call fails when it runs (an allowed call, or one that asks nothing). */
  readonly isError?: boolean;
  /** The call asks the owner first (`RequestHandler.permission`); a denial ends it as an error. */
  readonly permission?: boolean;
}

export type PlainStep =
  | { readonly say: string }
  | { readonly whole: string }
  | {
      readonly call: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly options: CallOptions;
    }
  | { readonly question: readonly Question[] }
  | { readonly fail: string }
  | { readonly hold: true }
  | { readonly die: true };

/** A text written piece by piece, as deltas of one message. */
export function say(text: string): PlainStep {
  return { say: text };
}

/** A text that arrives whole, as the output of a command does. */
export function whole(text: string): PlainStep {
  return { whole: text };
}

/** A tool call, started and ended; with `permission` it asks the owner between the two. */
export function call(
  toolName: string,
  input: Readonly<Record<string, unknown>> = {},
  options: CallOptions = {},
): PlainStep {
  return { call: toolName, input, options };
}

/** A question to the owner, with the labels of its options. */
export function question(
  text: string,
  labels: readonly string[],
  options: { readonly header?: string; readonly multiSelect?: boolean } = {},
): PlainStep {
  return {
    question: [
      {
        header: options.header ?? "",
        text,
        multiSelect: options.multiSelect ?? false,
        options: labels.map((label) => ({ label, description: null, preview: null })),
      },
    ],
  };
}

/** The agent answers with a message about a failed request of its own; the turn ends as `error`. */
export function fail(text: string): PlainStep {
  return { fail: text };
}

/** The turn waits here until `interrupt()` (it ends as `interrupted`) or `release()`. */
export function hold(): PlainStep {
  return { hold: true };
}

/** The process dies: `process_lost` is the session's last event. */
export function die(): PlainStep {
  return { die: true };
}

// The agent's record of sessions.

interface Stored {
  readonly id: string;
  readonly folder: string;
  title: string;
  lastModified: number;
}

/**
 * What the agent keeps of its sessions, as a transcript folder would. A test keeps the store and
 * gives it to the next `PlainAgent` to restart the daemon.
 */
export class PlainStore {
  readonly #sessions = new Map<string, Stored>();
  readonly #now: () => number;
  #counter = 0;
  #last = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  newId(): string {
    this.#counter += 1;
    return `plain-session-${this.#counter}`;
  }

  has(folder: string, id: string): boolean {
    return this.#sessions.get(id)?.folder === folder;
  }

  /** Records that the session ran: a time later than every earlier one unless `at` says. */
  remember(folder: string, id: string, title: string, at?: number): void {
    this.#last = Math.max(this.#now(), this.#last + 1);
    const stored = this.#sessions.get(id);
    if (stored === undefined) {
      this.#sessions.set(id, { id, folder, title, lastModified: at ?? this.#last });
    } else {
      stored.lastModified = at ?? this.#last;
    }
  }

  /** The sessions of `folder`, newest first. */
  list(folder: string): ListedSession[] {
    return [...this.#sessions.values()]
      .filter((stored) => stored.folder === folder)
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((stored) => ({
        id: stored.id,
        title: stored.title,
        customTitle: null,
        branch: null,
        size: null,
        lastModified: stored.lastModified,
      }));
  }
}

// A single-reader queue of events.

class EventQueue implements AsyncIterable<SessionEvent> {
  readonly #items: SessionEvent[] = [];
  #ended = false;
  #wake: (() => void) | null = null;

  push(event: SessionEvent): void {
    if (this.#ended) return;
    this.#items.push(event);
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

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: async (): Promise<IteratorResult<SessionEvent>> => {
        while (this.#items.length === 0 && !this.#ended) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        const event = this.#items.shift();
        if (event === undefined) return { done: true, value: undefined };
        return { done: false, value: event };
      },
    };
  }
}

/** Sending to a session that has ended: closed, or its process lost. */
export class PlainSessionClosed extends Error {
  override readonly name = "PlainSessionClosed";

  constructor() {
    super("the plain session is closed");
  }
}

const NOT_SHOWN = "The request could not be shown to the owner.";

/** What the owner was asked and answered, in order. */
export type PlainAnswered =
  | { readonly request: PermissionRequest; readonly answer: PermissionAnswer }
  | { readonly request: QuestionRequest; readonly answer: QuestionAnswer };

/** Settles with `value`, or with the abort when the signal fires first. */
function orAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const ABORTED = Symbol("aborted");

/** Words of a text with their trailing space, so that they join back to the text. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function textOf(prompt: Prompt): string {
  const { content } = prompt;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

class Turn {
  messages = 0;
  calls = 0;
  finalText: string | null = null;
  ending: "done" | "interrupted" | "error" = "done";
}

export interface PlainSessionContext {
  readonly id: string;
  readonly options: StartOptions;
  readonly requests: RequestHandler;
  readonly store: PlainStore;
  /** The steps of the next turn of the script. */
  readonly takeTurn: () => readonly PlainStep[];
}

export class PlainSession implements AgentSession {
  readonly events: AsyncIterable<SessionEvent>;
  readonly id: string;
  readonly options: StartOptions;
  /** Every prompt sent, in order. */
  readonly prompts: Prompt[] = [];
  /** Every request put to the owner with the answer it got. */
  readonly answers: PlainAnswered[] = [];
  closed = false;
  lost = false;
  readonly #queue = new EventQueue();
  readonly #context: PlainSessionContext;
  #chain: Promise<void> = Promise.resolve();
  #turn: AbortController | null = null;
  #released: (() => void) | null = null;
  #sequence = 0;

  constructor(context: PlainSessionContext) {
    this.#context = context;
    this.id = context.id;
    this.options = context.options;
    this.events = this.#queue;
    this.#queue.push({ type: "session_started", sessionId: this.id, agentVersion: VERSION });
  }

  async send(prompt: Prompt): Promise<void> {
    if (this.closed || this.lost) throw new PlainSessionClosed();
    this.prompts.push(prompt);
    const text = textOf(prompt);
    this.#context.store.remember(this.options.folder, this.id, text);
    this.#chain = this.#chain.then(() => this.#play(text));
  }

  /** Lets a turn waiting at `hold()` go on. */
  release(): void {
    this.#released?.();
  }

  /** The process dies, with no word from the core. */
  kill(): void {
    if (this.closed || this.lost) return;
    this.lost = true;
    this.#turn?.abort();
    this.#queue.push({ type: "process_lost", reason: "the plain process exited" });
    this.#queue.end();
  }

  async interrupt(): Promise<void> {
    this.#turn?.abort();
  }

  async stopTask(): Promise<void> {
    throw new Error("the plain agent runs no task");
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode !== PLAIN_MODE) throw new RangeError(`unknown permission mode: ${mode}`);
  }

  async setModel(model: string | null): Promise<void> {
    if (model !== null) throw new Error("the plain agent has no model to choose");
  }

  async setEffort(): Promise<void> {
    throw new Error("the plain agent cannot change its effort on a live session");
  }

  async contextUsage(): Promise<ContextUsage> {
    return { model: null, percentage: null };
  }

  async info(): Promise<AgentInfo> {
    return { models: [], commands: PLAIN_COMMANDS, permissionMode: PLAIN_MODE };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.#turn?.abort();
      this.#queue.end();
    }
    await this.#chain;
  }

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.id}-${this.#sequence}`;
  }

  #push(event: SessionEvent): void {
    if (!this.lost) this.#queue.push(event);
  }

  async #play(text: string): Promise<void> {
    if (this.closed || this.lost) return;
    const command = this.#command(text);
    const turn = new Turn();
    if (command !== null) {
      this.#push({
        type: "text",
        messageId: this.#nextId("message"),
        text: command,
        parentCallId: null,
      });
      turn.finalText = command;
    } else {
      this.#turn = new AbortController();
      await this.#steps(this.#context.takeTurn(), turn, this.#turn.signal);
      if (this.#turn.signal.aborted && !this.closed && !this.lost) turn.ending = "interrupted";
      this.#turn = null;
    }
    if (this.closed || this.lost) return;
    const level = this.options.effort;
    this.#push({
      type: "effort_observed",
      level: level !== null && PLAIN_CAPABILITIES.effortLevels.includes(level) ? level : null,
    });
    this.#push({
      type: "turn_ended",
      sessionId: this.id,
      startedBy: "owner",
      finalText: turn.finalText,
      ending: turn.ending,
      // Each call goes back to the model once; a turn that did nothing never went to it.
      steps: turn.messages + turn.calls === 0 ? 0 : turn.calls + 1,
      tokens: {},
    });
  }

  /** The output of a command the prompt names, or null for a prompt that is a turn. */
  #command(text: string): string | null {
    const match = /^\/(\S+)\s*(.*)$/s.exec(text.trim());
    if (match === null) return null;
    const name = match[1] ?? "";
    const argument = (match[2] ?? "").trim();
    const known = PLAIN_COMMANDS.find(
      (entry) => entry.name === name || entry.aliases.includes(name),
    );
    if (known === undefined) return `Unknown command: /${name}`;
    if (known.name === "count") return `${argument.split(/\s+/).filter(Boolean).length} words`;
    return argument === "" ? "(nothing to say)" : argument;
  }

  async #steps(steps: readonly PlainStep[], turn: Turn, signal: AbortSignal): Promise<void> {
    for (const step of steps) {
      if (signal.aborted || this.closed || this.lost) return;
      if ("say" in step) {
        this.#say(step.say, turn);
      } else if ("whole" in step) {
        const trimmed = step.whole.trim();
        if (trimmed !== "") {
          this.#push({
            type: "text",
            messageId: this.#nextId("message"),
            text: trimmed,
            parentCallId: null,
          });
          turn.finalText = trimmed;
          turn.messages += 1;
        }
      } else if ("call" in step) {
        await this.#call(step.call, step.input, step.options, turn, signal);
      } else if ("question" in step) {
        await this.#ask(step.question, turn, signal);
      } else if ("fail" in step) {
        this.#push({
          type: "agent_error",
          kind: "other",
          category: "plain_failure",
          text: step.fail,
          parentCallId: null,
        });
        turn.ending = "error";
        return;
      } else if ("hold" in step) {
        await orAborted(
          new Promise<void>((resolve) => {
            this.#released = resolve;
          }),
          signal,
        );
        this.#released = null;
      } else {
        this.kill();
        return;
      }
    }
  }

  #say(text: string, turn: Turn): void {
    const messageId = this.#nextId("message");
    this.#push({ type: "message_started", messageId, parentCallId: null });
    this.#push({ type: "text_started", messageId, parentCallId: null });
    for (const piece of pieces(text)) {
      this.#push({ type: "text_delta", messageId, text: piece, parentCallId: null });
    }
    this.#push({ type: "message_ended", messageId, parentCallId: null });
    const trimmed = text.trim();
    turn.messages += 1;
    if (trimmed !== "") turn.finalText = trimmed;
  }

  async #call(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: CallOptions,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<void> {
    const callId = this.#nextId("call");
    turn.calls += 1;
    this.#push({ type: "call_started", callId, toolName, input, parentCallId: null });
    let allowed = true;
    let message = "";
    if (options.permission === true) {
      const request: PermissionRequest = {
        type: "permission",
        requestId: this.#nextId("request"),
        callId,
        toolName,
        input,
        title: null,
        description: null,
      };
      const answer = await this.#request(
        () => this.#context.requests.permission(request),
        { allow: false, message: NOT_SHOWN },
        signal,
      );
      if (answer === ABORTED) return;
      this.answers.push({ request, answer });
      if (!answer.allow) {
        allowed = false;
        message = answer.message;
      }
    }
    this.#push({
      type: "call_ended",
      callId,
      isError: !allowed || options.isError === true,
      output: allowed ? (options.output ?? "done") : message,
      fileChange: null,
      parentCallId: null,
    });
  }

  async #ask(questions: readonly Question[], turn: Turn, signal: AbortSignal): Promise<void> {
    const callId = this.#nextId("call");
    turn.calls += 1;
    this.#push({
      type: "call_started",
      callId,
      toolName: "Ask",
      input: { questions },
      parentCallId: null,
    });
    const request: QuestionRequest = {
      type: "question",
      requestId: this.#nextId("request"),
      callId,
      toolName: "Ask",
      title: null,
      questions,
    };
    const answer = await this.#request(
      () => this.#context.requests.question(request),
      { answered: false, message: NOT_SHOWN },
      signal,
    );
    if (answer === ABORTED) return;
    this.answers.push({ request, answer });
    this.#push({
      type: "call_ended",
      callId,
      isError: !answer.answered,
      output: answer.answered ? JSON.stringify(answer.answers) : answer.message,
      fileChange: null,
      parentCallId: null,
    });
  }

  /** Asks the handler; a handler that throws is a refusal, an interrupt or a close ends the wait. */
  async #request<T>(
    ask: () => Promise<T>,
    refused: T,
    signal: AbortSignal,
  ): Promise<T | typeof ABORTED> {
    let pending: Promise<T>;
    try {
      pending = ask();
    } catch {
      return refused;
    }
    try {
      return await orAborted(pending, signal);
    } catch {
      return refused;
    }
  }
}

export interface PlainAgentOptions {
  /** The agent's record of sessions; a new one when absent. */
  readonly store?: PlainStore;
  /** The script: one array of steps per turn. A test that shares it across agents shares the rest of it. */
  readonly turns?: PlainStep[][];
}

export class PlainAgent implements AgentBackend {
  readonly name = PLAIN_NAME;
  readonly words = PLAIN_WORDS;
  readonly capabilities = PLAIN_CAPABILITIES;
  readonly store: PlainStore;
  /** The script not yet played. */
  readonly turns: PlainStep[][];
  /** Every session started, in order. */
  readonly sessions: PlainSession[] = [];
  /** Every start asked of the agent, in order, a failed one too. */
  readonly starts: StartOptions[] = [];
  readonly #startFailures: Error[] = [];
  closed = false;

  constructor(options: PlainAgentOptions = {}) {
    this.store = options.store ?? new PlainStore();
    this.turns = options.turns ?? [];
  }

  /** Scripts the next turn, after those already scripted. */
  next(...steps: PlainStep[]): this {
    this.turns.push(steps);
    return this;
  }

  /** The next `start` rejects with `error`, with no session left. */
  failNextStart(error: Error): void {
    this.#startFailures.push(error);
  }

  /** The sessions started and neither closed nor lost. */
  get running(): PlainSession[] {
    return this.sessions.filter((session) => !session.closed && !session.lost);
  }

  async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    this.starts.push(options);
    const failure = this.#startFailures.shift();
    if (failure !== undefined) throw failure;
    if (options.resume !== null && !this.store.has(options.folder, options.resume)) {
      throw new ResumeRefused();
    }
    const session = new PlainSession({
      id: options.resume ?? this.store.newId(),
      options,
      requests,
      store: this.store,
      takeTurn: () => this.turns.shift() ?? [say("ok")],
    });
    this.sessions.push(session);
    return session;
  }

  async listSessions(folder: string): Promise<readonly ListedSession[]> {
    return this.store.list(folder);
  }

  async datedSessions(
    _folder: string,
    sessions: readonly ListedSession[],
  ): Promise<ListedSession[]> {
    return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  }

  async aliveSessions(folder: string): Promise<ReadonlySet<string> | null> {
    return new Set(this.store.list(folder).map((session) => session.id));
  }

  // The agent keeps no record of trust: no folder is refused, and the daemon's git runs nowhere.
  async folderTrusted(): Promise<boolean> {
    return true;
  }

  async trustedRepository(): Promise<Repository | null> {
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface PlainEntry extends AgentEntry {
  /** Every agent the entry built, in order. */
  readonly built: PlainAgent[];
}

/** The entry that builds a plain agent over `options`, for a registry. */
export function plainAgent(options: PlainAgentOptions = {}): PlainEntry {
  const built: PlainAgent[] = [];
  return {
    required: [],
    optional: [],
    built,
    build: (_context: AgentContext) => {
      const agent = new PlainAgent(options);
      built.push(agent);
      return agent;
    },
  };
}

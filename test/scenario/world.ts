/**
 * What the seven steps of the scenario share: the real daemon (`run` of `src/main.ts`) started
 * in a config folder of its own, whose `.env` selects the plain agent and the memory chat by
 * name, over a registry that holds those two entries and nothing else. The test plays the owner
 * through the memory chat and scripts the plain agent; nothing is mocked below `run`.
 *
 * The daemon waits on a fake clock (set to a date, so the threads the chat dates are not old),
 * is stopped with a signal from an emitter, and is waited for without a real sleep: `settle`
 * lets what is ready run and then waits for the file calls it started (`realWorkDone`).
 *
 * Two things are watched in every test (`finish`): the memory chat records a call the core made
 * for a capability the chat does not declare (`strayCalls`), and the plain agent is wrapped to
 * record a call the core made for one it does not declare (`World.undeclared`).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentEntry, AgentSession, Prompt } from "../../src/agent/seam.ts";
import type { ChatProvider, Reply, ThreadChat, ThreadRef } from "../../src/chat/seam.ts";
import type { ChatEntry } from "../../src/core/port.ts";
import { StateStore } from "../../src/core/state.ts";
import type { Names } from "../../src/core/texts.ts";
import { run, type SignalSource, type Stop } from "../../src/main.ts";
import type { Registry } from "../../src/registry.ts";
import { type MemoryChat, memoryChat, OWNER } from "../support/memory-chat.ts";
import {
  type PlainAgent,
  type PlainEntry,
  type PlainStep,
  PlainStore,
  plainAgent,
} from "../support/plain-agent.ts";
import { realWorkDone, SettledClock } from "../support/sessions.ts";

/** The names the registry holds the two modules under, and so the values of the `.env`. */
export const AGENT_NAME = "plain";
export const CHAT_NAME = "memory";

/** What the daemon's texts take from the two modules, written out (the plain agent and the memory chat). */
export const NAMES: Names = {
  agent: "Plain",
  author: "Plain",
  cli: "plain",
  chat: "Memory chat",
};

/** A date, in seconds: threads the memory chat opens are dated by it. */
const START_TIME = 1_780_000_000;

/** The members of the plain agent and of its sessions that a capability it lacks stands for. */
const NOT_DECLARED = new Set([
  "usageLimits",
  "folderTrusted",
  "trustedRepository",
  "setModel",
  "setEffort",
  "stopTask",
]);

/** `target` with a call to any of `NOT_DECLARED` written to `calls`. */
function watched<T extends object>(target: T, calls: string[], label: string): T {
  return new Proxy(target, {
    get(inner, property) {
      const member = Reflect.get(inner, property, inner);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (typeof property === "string" && NOT_DECLARED.has(property)) {
          calls.push(`${label}.${property}`);
        }
        const result = member.apply(inner, args);
        // A session the agent starts is watched too.
        if (property === "start" && result instanceof Promise) {
          return result.then((session: AgentSession) => watched(session, calls, "session"));
        }
        return result;
      };
    },
  });
}

/** `thread` with every text handed to a reply it opens written to `handed`. */
function replyWatched(thread: ThreadChat, handed: string[]): ThreadChat {
  return new Proxy(thread, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property !== "openReply")
        return typeof member === "function" ? member.bind(target) : member;
      return (...args: Parameters<ThreadChat["openReply"]>): Reply => {
        const reply = target.openReply(...args);
        return new Proxy(reply, {
          get(inner, name) {
            const part = Reflect.get(inner, name, inner);
            if (name !== "text") return typeof part === "function" ? part.bind(inner) : part;
            return (markdown: string, ...rest: unknown[]) => {
              handed.push(markdown);
              return (inner.text as (...a: unknown[]) => Promise<void>)(markdown, ...rest);
            };
          },
        });
      };
    },
  });
}

export interface WorldOptions {
  /** More entries the registry holds beside the two (the selection test's decoys). */
  readonly more?: {
    readonly agents?: Readonly<Record<string, AgentEntry>>;
    readonly chats?: Readonly<Record<string, ChatEntry>>;
  };
  /** The entries taken when the `.env` selects none; the two modules under test when absent. */
  readonly defaults?: { readonly agent: string; readonly chat: string };
}

/** A promise settled from outside. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export class World {
  /** The folder the daemon reads its configuration and writes `state.json` in. */
  readonly config: string;
  /** The temp folder that holds the other two. */
  readonly base: string;
  /** `ALLOWED_ROOT`. */
  readonly root: string;
  /** The folder the channel is bound to. */
  readonly folder: string;
  readonly channel: string;
  readonly chat: MemoryChat;
  /** The plain agent's entry: `built` holds every agent a start made. */
  readonly entry: PlainEntry;
  /** What the agent keeps of its sessions: it outlives a stop of the daemon. */
  readonly store: PlainStore;
  /** The script of the agent's turns, shared by every agent a start builds. */
  readonly turns: PlainStep[][] = [];
  readonly clock = new SettledClock();
  readonly signals = new EventEmitter();
  /** Calls the core made that a capability the plain agent lacks stands for. */
  readonly undeclared: string[] = [];
  /** Every text the core handed to a reply of the chat, in order. */
  readonly handed: string[] = [];
  readonly registry: Registry;
  running: Promise<number> | null = null;
  #started = latch();

  private constructor(t: TestContext, options: WorldOptions) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "awaydesk-scenario-")));
    this.base = base;
    this.root = join(base, "root");
    mkdirSync(this.root);
    this.config = join(base, "config");
    mkdirSync(this.config);
    this.folder = join(this.root, "work");
    mkdirSync(this.folder);
    const env = join(this.config, ".env");
    writeFileSync(
      env,
      [
        `AWAYDESK_AGENT=${AGENT_NAME}`,
        `AWAYDESK_CHAT=${CHAT_NAME}`,
        `ALLOWED_ROOT=${this.root}`,
      ].join("\n"),
    );
    chmodSync(env, 0o600);

    this.clock.now = START_TIME;
    this.signals.setMaxListeners(0);
    this.store = new PlainStore({ now: () => START_TIME * 1000 });
    this.entry = plainAgent({ store: this.store, turns: this.turns });
    this.chat = memoryChat();
    this.channel = this.chat.openChannel("work");
    // The channel is bound before the first start, as the owner's `!bind` of an earlier day left it.
    const state = new StateStore(join(this.config, "state.json"), {
      modules: { agent: AGENT_NAME, chat: CHAT_NAME },
    });
    state.bind(this.channel, this.folder);

    const agent: AgentEntry = {
      required: [],
      optional: [],
      build: (context) => watched(this.entry.build(context), this.undeclared, "agent"),
    };
    const chat: ChatEntry = {
      required: [],
      optional: [],
      build: async (context) => this.#watchStart(await this.chat.build(context)),
    };
    this.registry = {
      agents: { [AGENT_NAME]: agent, ...options.more?.agents },
      chats: { [CHAT_NAME]: chat, ...options.more?.chats },
      defaults: options.defaults ?? { agent: AGENT_NAME, chat: CHAT_NAME },
    };

    t.after(async () => {
      // A test that failed must not leave the daemon running.
      if (this.running !== null) {
        this.signals.emit("SIGINT");
        await this.running.catch(() => undefined);
      }
      rmSync(this.base, { recursive: true, force: true });
    });
  }

  static make(t: TestContext, options: WorldOptions = {}): World {
    return new World(t, options);
  }

  /**
   * The provider, which says when the daemon has started it (the owner is heard from then on)
   * and writes to `handed` every text the core hands to a reply.
   */
  #watchStart(provider: ChatProvider): ChatProvider {
    const started = this.#started;
    const handed = this.handed;
    return new Proxy(provider, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "start") {
          return async (...args: Parameters<ChatProvider["start"]>) => {
            await target.start(...args);
            started.open();
          };
        }
        if (property === "thread") {
          return (ref: ThreadRef) => replyWatched(target.thread(ref), handed);
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  get state(): string {
    return join(this.config, "state.json");
  }

  /** The owner. */
  get owner() {
    return this.chat.as(OWNER);
  }

  /** A folder under the allowed root, made. */
  makeFolder(name: string): string {
    const folder = join(this.root, name);
    mkdirSync(folder);
    return folder;
  }

  /** Scripts the next turn of the agent, after those already scripted. */
  script(...steps: PlainStep[]): void {
    this.turns.push(steps);
  }

  /** The plain agent the last start built. */
  get plain(): PlainAgent {
    const built = this.entry.built.at(-1);
    if (built === undefined) throw new Error("the daemon has not built the agent");
    return built;
  }

  /** The daemon starts, and is waited for until it hears the owner. */
  async start(): Promise<void> {
    assert.equal(this.running, null, "the daemon is running");
    this.#started = latch();
    this.running = run({
      configDir: this.config,
      registry: this.registry,
      clock: this.clock,
      signals: this.signals as SignalSource,
    });
    await Promise.race([
      this.#started.promise,
      this.running.then(() => assert.fail("run ended before it started the chat")),
    ]);
    await this.settle();
  }

  /** The daemon is told to stop with `signal`, and waited for; resolves with its exit code. */
  async stop(signal: Stop = "SIGTERM"): Promise<number> {
    const running = this.running;
    assert.ok(running !== null, "the daemon is not running");
    this.signals.emit(signal);
    const code = await running;
    this.running = null;
    await this.settle();
    return code;
  }

  /** A stop, then a start over the same config folder, the same chat and the same agent store. */
  async restart(signal: Stop = "SIGINT"): Promise<void> {
    await this.stop(signal);
    await this.start();
  }

  /** Lets what is ready run, and the file calls it started. */
  async settle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await realWorkDone();
  }

  /** Settles until `done` holds; fails with `what` when it never does. */
  async until(done: () => boolean, what: string): Promise<void> {
    for (let round = 0; round < 200; round += 1) {
      if (done()) return;
      await this.settle();
    }
    assert.ok(done(), `never reached: ${what}`);
  }

  /**
   * Waits for an open request of `type` that is not one of `except`, in `thread` when given, and
   * returns it.
   */
  async request(type: string, thread?: string, except: ReadonlySet<string> = new Set()) {
    const find = () =>
      this.chat
        .requests()
        .find(
          (r) =>
            r.request.type === type &&
            !except.has(r.requestId) &&
            (thread === undefined || r.ref.thread === thread),
        );
    await this.until(() => find() !== undefined, `a ${type} request`);
    return find() as NonNullable<ReturnType<typeof find>>;
  }

  /**
   * The owner writes `text` in the channel and answers the setup it opens with `effort`: the
   * thread, once the prompt has gone to the agent.
   */
  async open(text: string, effort = "full"): Promise<string> {
    const before = new Set(this.chat.requests().map((r) => r.requestId));
    const sending = this.owner.says(this.channel, text);
    const setup = await this.request("setup", undefined, before);
    await this.owner.answers(setup.requestId, {
      type: "setup",
      selection: { model: "default", effort, bypass: false },
    });
    await sending;
    return setup.ref.thread;
  }

  /** Waits until the thread holds `replies` replies of the daemon and none is unfinished. */
  async ended(thread: string, replies = 1): Promise<void> {
    const replying = () =>
      this.chat.messages(this.channel, thread).filter((m) => m.kind === "reply");
    await this.until(
      () => replying().length === replies && replying().every((m) => !m.unfinished),
      `${replies} reply(ies) ended`,
    );
  }

  /** What a thread shows, as text. */
  shown(thread: string): readonly string[] {
    return this.chat.texts(this.channel, thread);
  }

  /** What a thread shows, with the kind of each message. */
  kinds(thread: string): ReadonlyArray<readonly [string, string]> {
    return this.chat.messages(this.channel, thread).map((m) => [m.kind, m.text] as const);
  }

  /** The text of every prompt the plain agent got, over every session, in order. */
  prompts(): string[] {
    return this.entry.built.flatMap((agent) =>
      agent.sessions.flatMap((session) => session.prompts.map(textOf)),
    );
  }

  /** Stops the daemon if it runs, then checks what no test may leave: no stray call either way. */
  async finish(): Promise<void> {
    if (this.running !== null) await this.stop("SIGINT");
    assert.deepEqual(this.chat.strayCalls(), [], "the core called what the chat does not declare");
    assert.deepEqual(this.undeclared, [], "the core called what the agent does not declare");
  }
}

function textOf(prompt: Prompt): string {
  const { content } = prompt;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

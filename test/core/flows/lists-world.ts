/**
 * What the tests of the lists flows share: the flows of `lists()` over the memory chat and a
 * real `SessionManager` driving the plain agent, in a folder of its own with a root and two
 * folders under it. The owner and somebody else act through the memory chat, which checks who
 * acted before anything reaches the core.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ListedSession } from "../../../src/agent/seam.ts";
import type {
  ChannelChat,
  ChatCapabilities,
  ChatInbound,
  ChatProvider,
  ListPick,
  Markup,
  Presence,
  ThreadChat,
  ThreadRef,
} from "../../../src/chat/seam.ts";
import { Inbound } from "../../../src/core/flows/inbound.ts";
import { type Lists, lists } from "../../../src/core/flows/lists.ts";
import { type FlowDeps, Talk } from "../../../src/core/flows/talk.ts";
import { Holds } from "../../../src/core/hold.ts";
import { Approvals } from "../../../src/core/requests.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { StateStore } from "../../../src/core/state.ts";
import { type Names, namesOf } from "../../../src/core/texts.ts";
import { FakeClock } from "../../support/fake-slack.ts";
import {
  type MemoryChat,
  memoryChat,
  OWNER,
  type ShownMessage,
} from "../../support/memory-chat.ts";
import { hold, PlainAgent, say } from "../../support/plain-agent.ts";

/** The chat of a test, which a test may make fail where it wants to. */
class Faulty implements ChatProvider {
  readonly #inner: ChatProvider;
  /** A thread's `say` rejects while this is set. */
  sayFails = false;
  /** The channel's `withdraw` answers false (the chat refused) while this is set. */
  withdrawRefused = false;
  /** Every `rewrite` of a list: the message and what it was rewritten to. */
  readonly rewrites: Array<readonly [string, string]> = [];

  constructor(inner: ChatProvider) {
    this.#inner = inner;
  }

  get name(): string {
    return this.#inner.name;
  }

  get capabilities(): ChatCapabilities {
    return this.#inner.capabilities;
  }

  thread(ref: ThreadRef): ThreadChat {
    const thread = this.#inner.thread(ref);
    const sayFails = (): boolean => this.sayFails;
    return new Proxy(thread, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "say" && sayFails()) {
          return async () => {
            throw new Error("say refused");
          };
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  channel(channel: string): ChannelChat {
    const inner = this.#inner.channel(channel);
    return {
      notice: (text) => inner.notice(text),
      say: (markdown) => inner.say(markdown),
      offer: (list, title) => inner.offer(list, title),
      withdraw: async (list) => (this.withdrawRefused ? false : inner.withdraw(list)),
      rewrite: (list, text) => {
        this.rewrites.push([list, text]);
        return inner.rewrite(list, text);
      },
    };
  }

  escape(text: string, markup: Markup): string {
    return this.#inner.escape(text, markup);
  }

  channelName(channel: string, markup: Markup): string {
    return this.#inner.channelName(channel, markup);
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#inner.openedAt(ref);
  }

  channelState(channel: string): Promise<Presence> {
    return this.#inner.channelState(channel);
  }

  threadState(ref: ThreadRef): Promise<Presence> {
    return this.#inner.threadState(ref);
  }

  start(inbound: ChatInbound): Promise<void> {
    return this.#inner.start(inbound);
  }

  stop(): Promise<void> {
    return this.#inner.stop();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

/** A session of the agent's record, listed in the folder it names. */
export function stored(id: string, title: string, lastModified: number): ListedSession {
  return { id, title, customTitle: null, branch: null, size: null, lastModified };
}

/** What a world is made of. */
interface Parts {
  readonly root: string;
  readonly chat: MemoryChat;
  readonly agent: PlainAgent;
  readonly state: StateStore;
  readonly sessions: SessionManager;
  readonly faulty: Faulty;
  readonly flows: Lists;
  readonly names: Names;
  readonly channel: string;
}

export class ListsWorld {
  /** The folder sessions may start under. */
  readonly root: string;
  readonly app: string;
  readonly docs: string;
  /** The room the owner and somebody else act in. */
  readonly chat: MemoryChat;
  readonly agent: PlainAgent;
  readonly state: StateStore;
  readonly sessions: SessionManager;
  readonly faulty: Faulty;
  readonly flows: Lists;
  /** The names the core's texts take here. */
  readonly names: Names;
  readonly channel: string;
  /** What reached the core as a pick, in order. */
  readonly picked: ListPick[] = [];

  private constructor(parts: Parts) {
    this.root = parts.root;
    this.app = join(parts.root, "app");
    this.docs = join(parts.root, "docs");
    this.chat = parts.chat;
    this.agent = parts.agent;
    this.state = parts.state;
    this.sessions = parts.sessions;
    this.faulty = parts.faulty;
    this.flows = parts.flows;
    this.names = parts.names;
    this.channel = parts.channel;
  }

  /** A world with an unbound channel. */
  static async build(t: TestContext, agent: PlainAgent = new PlainAgent()): Promise<ListsWorld> {
    const folder = mkdtempSync(join(tmpdir(), "awaydesk-lists-"));
    const root = realpathSync(folder);
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "docs"));
    const chat = memoryChat();
    const clock = new FakeClock();
    const provider = await chat.build({
      variables: {},
      allowedRoot: root,
      clock,
      steady: clock,
      core: () => {
        throw new Error("the memory chat never reads the core");
      },
    });
    const faulty = new Faulty(provider);
    const state = new StateStore(join(root, "state.json"));
    const names = namesOf(agent, faulty);
    const approvals = new Approvals(names);
    const holds = new Holds();
    const sessions = new SessionManager({
      chat: faulty,
      agent,
      state,
      approvals,
      holds,
      usage: null,
      clock,
    });
    t.after(async () => {
      // A turn that holds is let go first, so that the sessions close; the folder goes last.
      for (const session of agent.running) session.release();
      await sessions.closeAll();
      rmSync(folder, { recursive: true, force: true });
    });
    const deps: FlowDeps = {
      chat: faulty,
      agent,
      sessions,
      state,
      approvals,
      holds,
      names,
      allowedRoot: root,
      stopped: new AbortController().signal,
      now: () => clock.time(),
    };
    const flows = lists(deps, new Talk(deps));
    const world = new ListsWorld({
      root,
      chat,
      agent,
      state,
      sessions,
      faulty,
      flows,
      names,
      channel: chat.openChannel("work"),
    });
    await provider.start(
      new Inbound({
        // The owner's words are typed here and handed to the flows by the test itself.
        message: async () => {},
        picked: async (pick) => {
          world.picked.push(pick);
          await flows.picks.picked(pick);
        },
      }),
    );
    return world;
  }

  /** The channel bound to `folder`, as an earlier `!bind` left it. */
  async bound(folder: string): Promise<void> {
    await this.sessions.bind(this.channel, folder);
  }

  /** A session in the agent's record of `folder`. */
  remember(folder: string, id: string, title: string, at: number): void {
    this.agent.store.remember(folder, id, title, at);
  }

  /** What the channel's main view shows, as text: the daemon's lines and the lists. */
  said(): readonly string[] {
    return this.chat.texts(this.channel);
  }

  /** The messages of the channel's main view that carry a control. */
  pressable(): readonly ShownMessage[] {
    return this.chat.messages(this.channel).filter((message) => message.pressable);
  }

  /** The owner's top-level word in the channel: the thread its answer lives in. */
  async word(text = "!resume"): Promise<ThreadRef> {
    return (await this.chat.as(OWNER).says(this.channel, text)).ref;
  }

  /** A session of the bound channel in `thread`, with a turn that holds until the world ends. */
  async work(thread: ThreadRef): Promise<ThreadSession> {
    this.agent.next(say("Working."), hold());
    const session = this.sessions.open(thread.channel, thread.thread);
    if (session === null) throw new Error("the channel is not bound");
    await session.submit("work");
    return session;
  }
}

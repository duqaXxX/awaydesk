/**
 * What the tests of the message flow share: `buildFlows()` over the memory chat and a real
 * `SessionManager` driving a scripted agent, in a folder of its own. The owner and somebody else
 * act through the memory chat, which checks who acted before anything reaches the core; a test
 * may also hand `inbound.message` a message of its own, to slow the files down or to hold a
 * prompt back.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
  AgentBackend,
  Prompt,
  PromptContent,
  RequestHandler,
  StartOptions,
} from "../../../src/agent/seam.ts";
import type {
  ChatCapabilities,
  ChatInbound,
  ChatProvider,
  InboundMessage,
  ThreadRef,
} from "../../../src/chat/seam.ts";
import { buildFlows } from "../../../src/core/flows/flows.ts";
import type { FlowDeps } from "../../../src/core/flows/talk.ts";
import { Holds } from "../../../src/core/hold.ts";
import { Approvals } from "../../../src/core/requests.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import { StateStore } from "../../../src/core/state.ts";
import { namesOf } from "../../../src/core/texts.ts";
import { FakeClock } from "../../support/fake-slack.ts";
import { type MemoryChat, memoryChat, OWNER } from "../../support/memory-chat.ts";
import { PLAIN_CAPABILITIES, PlainAgent, type PlainSession } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/sessions.ts";

/** The names the texts take when the plain agent and the memory chat are the two modules. */
export const PLAIN_NAMES = { agent: "Plain", author: "Plain", cli: "plain", chat: "Memory chat" };

/** A plain agent that offers no command of its own. */
export class NoCommands extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, commands: false };
}

/** A plain agent with a mode that runs tools without asking, as Claude has. */
export class WithBypass extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    permissionModes: { default: "standard", auto: null, bypass: "unrestricted" },
  };

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    // The plain session knows one mode; this agent takes the other too and runs no differently.
    session.setPermissionMode = async () => {};
    return session;
  }
}

/** What the memory chat is made into: a chat that can share a file, or that has reactions. */
interface Variant {
  readonly files: boolean;
  readonly reactions: boolean;
  readonly openFails: boolean;
}

function variant(
  inner: ChatProvider,
  how: Variant,
  opened: Array<readonly [ThreadRef, string, string]>,
): ChatProvider {
  const capabilities: ChatCapabilities = {
    ...inner.capabilities,
    fileUpload: how.files,
    reactions: how.reactions,
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === "capabilities") return capabilities;
      if (property === "openFile" && how.files) {
        return async (ref: ThreadRef, folder: string, words: string) => {
          if (how.openFails) throw new Error("the file viewer is down");
          opened.push([ref, folder, words]);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

export interface WorldOptions {
  /** The agent: the plain one by default. */
  readonly agent?: AgentBackend;
  /** The chat can share a file; `openFile` records its calls in `World.fileCalls`. */
  readonly files?: boolean;
  /** `openFile` rejects. */
  readonly openFails?: boolean;
  /** The chat has reactions: a word that took effect is marked on the owner's message. */
  readonly reactions?: boolean;
}

/** A message the test writes itself, as a provider would hand it over. */
export interface Own {
  readonly ref: ThreadRef;
  readonly id: string;
  readonly topLevel?: boolean;
  readonly text: string;
  readonly plain?: string;
  readonly literal?: boolean;
  readonly content?: () => Promise<PromptContent | null>;
}

export class MessagesWorld {
  readonly folder: string;
  readonly chat: MemoryChat;
  readonly agent: AgentBackend;
  readonly state: StateStore;
  readonly sessions: SessionManager;
  readonly channel: string;
  /** What the core hands the provider. */
  readonly inbound: ChatInbound;
  /** The stop of the daemon. */
  readonly stopping = new AbortController();
  readonly clock = new FakeClock();
  readonly provider: ChatProvider;
  /** Every `openFile` the chat was asked for: the thread, the folder, the words. */
  readonly fileCalls: Array<readonly [ThreadRef, string, string]> = [];
  /** Wall-clock seconds as the flows read them. */
  now = 1_780_000_000;
  readonly #deps: FlowDeps;

  private constructor(
    folder: string,
    chat: MemoryChat,
    provider: ChatProvider,
    agent: AgentBackend,
    how: Variant,
  ) {
    this.folder = folder;
    this.chat = chat;
    this.agent = agent;
    this.channel = chat.openChannel("work");
    this.state = new StateStore(join(folder, "state.json"));
    this.state.bind(this.channel, folder);
    const names = namesOf(agent, provider);
    const approvals = new Approvals(names);
    const holds = new Holds();
    this.provider = variant(provider, how, this.fileCalls);
    this.sessions = new SessionManager({
      chat: this.provider,
      agent,
      state: this.state,
      approvals,
      holds,
      usage: null,
      clock: this.clock,
    });
    this.#deps = {
      chat: this.provider,
      agent,
      sessions: this.sessions,
      state: this.state,
      approvals,
      holds,
      names,
      allowedRoot: folder,
      stopped: this.stopping.signal,
      now: () => this.now,
    };
    this.inbound = buildFlows(this.#deps).inbound;
  }

  /** A world over the memory chat, with the plain agent unless `options.agent` names another. */
  static async make(t: TestContext, options: WorldOptions = {}): Promise<MessagesWorld> {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "awaydesk-messages-")));
    const chat = memoryChat();
    const provider = await chat.build({
      variables: {},
      allowedRoot: folder,
      clock: { sleep: async () => {}, time: () => 1_780_000_000 },
      steady: { sleep: async () => {}, time: () => 1_780_000_000 },
      core: () => {
        throw new Error("the memory chat never reads the core");
      },
    });
    const world = new MessagesWorld(folder, chat, provider, options.agent ?? new PlainAgent(), {
      files: options.files ?? false,
      reactions: options.reactions ?? false,
      openFails: options.openFails ?? false,
    });
    await world.provider.start(world.inbound);
    t.after(async () => {
      await world.sessions.closeAll();
      await world.provider.stop();
      rmSync(folder, { recursive: true, force: true });
    });
    return world;
  }

  /** The owner writes `text` in the channel, or inside `thread`. */
  says(text: string, thread?: string) {
    return this.chat
      .as(OWNER)
      .says(this.channel, text, thread === undefined ? undefined : { thread });
  }

  /** The owner's message handed to the flow as the test wrote it. */
  send(own: Own): Promise<void> {
    return this.inbound.message({
      ref: own.ref,
      id: own.id,
      topLevel: own.topLevel ?? false,
      text: own.text,
      plain: own.plain ?? own.text,
      literal: own.literal ?? false,
      content: own.content ?? (async () => own.text),
    } satisfies InboundMessage);
  }

  /** Lets what is ready run, and what it starts. */
  async settle(rounds = 30): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await settledTurn();
    }
  }

  /** Waits until a thread (`ref`, or any) has an open request of `type` and returns it. */
  async asked(type: string, ref?: ThreadRef) {
    for (let round = 0; round < 200; round += 1) {
      const found = this.chat
        .requests()
        .find((r) => (ref === undefined || r.ref.thread === ref.thread) && r.request.type === type);
      if (found !== undefined) return found;
      await settledTurn();
    }
    throw new Error(`no ${type} request was asked`);
  }

  /** The owner presses Start on the setup asked in `ref`. */
  async start(ref: ThreadRef, bypass = false): Promise<void> {
    const open = await this.asked("setup", ref);
    await this.chat.as(OWNER).answers(open.requestId, {
      type: "setup",
      selection: { model: "default", effort: "default", bypass },
    });
  }

  /**
   * The owner's first message of a new thread, its setup answered: the thread, once the prompt
   * reached the agent.
   */
  async opened(prompt = "first"): Promise<ThreadRef> {
    const sending = this.says(prompt);
    const { ref } = await this.asked("setup");
    await this.start(ref);
    await sending;
    await this.settle();
    return ref;
  }

  /** What `ref` shows, as text. */
  shown(ref: ThreadRef): readonly string[] {
    return this.chat.texts(ref.channel, ref.thread);
  }

  /** What the channel's main view shows, as text. */
  inChannel(): readonly string[] {
    return this.chat.texts(this.channel);
  }

  /** The session the agent started for the n-th time. */
  agentSession(index = 0): PlainSession {
    const session = (this.agent as PlainAgent).sessions[index];
    if (session === undefined) throw new Error(`no agent session ${index}`);
    return session;
  }

  /** The prompts the agent got, as text, over every session, once what is queued was sent. */
  async prompts(): Promise<string[]> {
    await this.settle(10);
    return (this.agent as PlainAgent).sessions.flatMap((s) => s.prompts.map(textOf));
  }
}

function textOf(prompt: Prompt): string {
  const { content } = prompt;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

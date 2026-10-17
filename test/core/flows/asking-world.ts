/**
 * What the tests of the asking flows share: `asking()` over the memory chat and a real
 * `SessionManager` driving a scripted agent, in a folder of its own. The owner and somebody else
 * act through the memory chat, which checks who acted before anything reaches the core; the
 * inbound the chat is started with records every answer that reached it.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentBackend } from "../../../src/agent/seam.ts";
import type {
  ChatInbound,
  ChatProvider,
  MessageId,
  OwnerAnswer,
  ThreadChat,
  ThreadRef,
} from "../../../src/chat/seam.ts";
import { type Asking, asking } from "../../../src/core/flows/asking.ts";
import { Inbound } from "../../../src/core/flows/inbound.ts";
import { type FlowDeps, Talk } from "../../../src/core/flows/talk.ts";
import { Holds } from "../../../src/core/hold.ts";
import { Approvals } from "../../../src/core/requests.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { StateStore } from "../../../src/core/state.ts";
import { namesOf } from "../../../src/core/texts.ts";
import { AsyncEvent, FakeClock } from "../../support/fake-slack.ts";
import {
  type MemoryChat,
  memoryChat,
  OWNER,
  type ShownMessage,
} from "../../support/memory-chat.ts";
import { NO_SYNC } from "../../support/no-sync.ts";
import { PlainAgent } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/sessions.ts";

/** One answer that reached the core. */
export interface Reached {
  readonly ref: ThreadRef;
  readonly requestId: string;
  readonly answer: OwnerAnswer;
  readonly message: MessageId | null;
}

/** The provider with the `rewrite` of every thread held until the test lets it go. */
function rewriteGated(inner: ChatProvider, gate: AsyncEvent): ChatProvider {
  return new Proxy(inner, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (property !== "thread") return typeof member === "function" ? member.bind(target) : member;
      return (ref: ThreadRef): ThreadChat =>
        new Proxy(target.thread(ref), {
          get(thread, name) {
            const value = Reflect.get(thread, name, thread);
            if (name === "rewrite") {
              return async (...args: Parameters<ThreadChat["rewrite"]>) => {
                await gate.wait();
                return thread.rewrite(...args);
              };
            }
            return typeof value === "function" ? value.bind(thread) : value;
          },
        });
    },
  });
}

export interface WorldOptions {
  /** The agent: the plain one by default. */
  readonly agent?: AgentBackend;
  /** Hold every setup's summary (`rewrite`) until `gate.set()`. */
  readonly gated?: boolean;
}

export class AskingWorld {
  readonly folder: string;
  readonly chat: MemoryChat;
  readonly agent: AgentBackend;
  readonly state: StateStore;
  readonly approvals: Approvals;
  readonly holds = new Holds();
  readonly sessions: SessionManager;
  readonly flows: Asking;
  readonly channel: string;
  /** What `inbound.answer` was called with, in order. */
  readonly reached: Reached[] = [];
  /** The core's side of the chat's inbound half, as the provider calls it. */
  readonly inbound: ChatInbound;
  /** The stop of the daemon. */
  readonly stopping = new AbortController();
  /** Lets a gated `rewrite` go. */
  readonly gate = new AsyncEvent();
  readonly clock = new FakeClock();
  readonly provider: ChatProvider;

  private constructor(
    folder: string,
    chat: MemoryChat,
    provider: ChatProvider,
    agent: AgentBackend,
    gated: boolean,
  ) {
    this.folder = folder;
    this.chat = chat;
    this.agent = agent;
    this.channel = chat.openChannel("work");
    this.state = new StateStore(join(folder, "state.json"), { sync: NO_SYNC });
    this.state.bind(this.channel, folder);
    const names = namesOf(agent, provider);
    this.approvals = new Approvals(names);
    this.provider = gated ? rewriteGated(provider, this.gate) : provider;
    this.sessions = new SessionManager({
      chat: this.provider,
      agent,
      state: this.state,
      approvals: this.approvals,
      holds: this.holds,
      usage: null,
      clock: this.clock,
    });
    const deps: FlowDeps = {
      chat: this.provider,
      agent,
      sessions: this.sessions,
      state: this.state,
      approvals: this.approvals,
      holds: this.holds,
      names,
      allowedRoot: folder,
      stopped: this.stopping.signal,
      now: () => this.clock.time(),
    };
    this.flows = asking(deps, new Talk(deps));
    const answers = this.flows.answers;
    const flows = new Inbound({
      answer: async (ref, requestId, answer, message) => {
        this.reached.push({ ref, requestId, answer, message });
        return answers.answer(ref, requestId, answer, message);
      },
    });
    this.inbound = flows;
  }

  /** A world over the memory chat, with the plain agent unless `options.agent` names another. */
  static async make(t: TestContext, options: WorldOptions = {}): Promise<AskingWorld> {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "awaydesk-asking-")));
    const chat = memoryChat();
    const provider = await chat.build({
      variables: {},
      allowedRoot: folder,
      scratchDir: join(folder, "scratch"),
      clock: { sleep: async () => {}, time: () => 1_780_000_000 },
      steady: { sleep: async () => {}, time: () => 1_780_000_000 },
      core: () => {
        throw new Error("the memory chat never reads the core");
      },
    });
    const world = new AskingWorld(
      folder,
      chat,
      provider,
      options.agent ?? new PlainAgent(),
      options.gated ?? false,
    );
    await provider.start(world.inbound);
    t.after(async () => {
      world.gate.set();
      await world.sessions.closeAll();
      await provider.stop();
      rmSync(folder, { recursive: true, force: true });
    });
    return world;
  }

  /** A new thread of the channel, with its live session as a top-level message would open it. */
  thread(): { readonly ref: ThreadRef; readonly session: ThreadSession } {
    const ref = this.chat.openThread(this.channel);
    const session = this.sessions.open(ref.channel, ref.thread);
    if (session === null) throw new Error("the channel is not bound");
    return { ref, session };
  }

  /** The requests the owner can still answer, in the thread. */
  open(ref: ThreadRef) {
    return this.chat.requests().filter((r) => r.ref.thread === ref.thread);
  }

  /** What the thread shows, as text. */
  shown(ref: ThreadRef): readonly string[] {
    return this.chat.texts(ref.channel, ref.thread);
  }

  messages(ref: ThreadRef): readonly ShownMessage[] {
    return this.chat.messages(ref.channel, ref.thread);
  }

  /** Waits until `ref` has an open request of `type` and returns it. */
  async asked(ref: ThreadRef, type: string) {
    for (let round = 0; round < 200; round += 1) {
      const found = this.open(ref).find((r) => r.request.type === type);
      if (found !== undefined) return found;
      await settledTurn();
    }
    throw new Error(`no ${type} request was asked in ${ref.thread}`);
  }

  /** The owner answers the open request, through the memory chat. */
  answers(requestId: string, answer: OwnerAnswer): Promise<boolean | null> {
    return this.chat.as(OWNER).answers(requestId, answer);
  }
}

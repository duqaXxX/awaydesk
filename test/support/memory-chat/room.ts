/**
 * The memory chat's room: the channels, threads and messages it holds, and the people a test
 * plays in it. It is written against the chat seam alone: nothing here knows a chat library, the
 * core or the other modules.
 *
 * A person acts through `Room.as`. Every path of a person that could reach the daemon (a
 * message, an answer to a request, a pick from a list) checks on its own that the person is the
 * owner before it calls `ChatInbound`, as a provider must (invariant 1 of CLAUDE.md); and none
 * reaches it before `start` or after `stop`. What a person does is kept in the room whoever
 * does it, so a test reads it back.
 */
import {
  ChatError,
  type ChatInbound,
  type ListPick,
  type MessageId,
  type OwnerAnswer,
  type OwnerList,
  type OwnerRequest,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import type { ChatContext } from "../../../src/core/port.ts";

/** The owner of a memory chat unless a test names another. */
export const OWNER = "alice";
/** Somebody who is not the owner. */
export const SOMEONE = "bob";
/** The author of everything the daemon writes. */
export const DAEMON = "daemon";

export type MessageKind = "message" | "reply" | "notice" | "reference" | "request" | "list";

/** A message as the chat holds it. */
export interface StoredMessage {
  readonly id: MessageId;
  /** Its place in the chat: a larger number was written later (ids do not sort as strings). */
  readonly position: number;
  readonly channel: string;
  /** The thread it belongs to; null for a line the daemon wrote in a channel outside any. */
  readonly thread: string | null;
  /** Written in the channel's main view (a thread's root, or a line of the channel itself). */
  readonly topLevel: boolean;
  readonly author: string;
  kind: MessageKind;
  /** What it shows now. */
  text: string;
  /** It has a control to press. */
  pressable: boolean;
  /** A reply the daemon has not ended. */
  unfinished: boolean;
  deleted: boolean;
}

/** A message as a test reads it: a copy, so what it holds does not change under the reader. */
export interface ShownMessage {
  readonly id: MessageId;
  readonly author: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly pressable: boolean;
  readonly unfinished: boolean;
  readonly topLevel: boolean;
}

/** A request the owner can answer: the daemon asked it and nobody answered or withdrew it. */
export interface OpenRequest {
  readonly requestId: string;
  readonly message: MessageId;
  readonly ref: ThreadRef;
  readonly request: OwnerRequest;
  readonly title: string;
}

/** A list the owner can pick from. */
export interface OpenList {
  readonly message: MessageId;
  readonly channel: string;
  readonly list: OwnerList;
  readonly title: string;
}

/** A message a person wrote: what a test needs to answer in its thread. */
export interface Sent {
  readonly id: MessageId;
  readonly ref: ThreadRef;
  readonly topLevel: boolean;
}

export interface SaysOptions {
  /** A thread the message is written in; absent, the message is top-level and opens its own. */
  readonly thread?: string;
  /** The message carries files or was spoken: the daemon never reads it as a word. */
  readonly literal?: boolean;
}

/** The people of the room. */
export interface Person {
  /**
   * Writes `text` in `channel`. The message is in the chat whoever writes it; it reaches the
   * daemon only from the owner, only while the provider runs.
   */
  says(channel: string, text: string, options?: SaysOptions): Promise<Sent>;
  /**
   * Answers the open request `requestId` with the answer its control would give (a permission's
   * allow or deny, a question form's answers, the hold's choice, the setup's selection). Throws
   * when no such request is open or the answer is of another type. Resolves with what
   * `ChatInbound.answer` answered, or null when nothing reached the daemon.
   */
  answers(requestId: string, answer: OwnerAnswer): Promise<boolean | null>;
  /**
   * Uses the control of one row of the open list `list`: a folder's path, or a session's id.
   * Throws when the list is not open or has no such row. Resolves with whether the pick reached
   * the daemon.
   */
  picks(list: MessageId, row: string): Promise<boolean>;
}

function key(channel: string, thread: string): string {
  return `${channel}\n${thread}`;
}

/** The thread a message is in, by the names the daemon sees; a line of the channel has none. */
export function refOf(message: StoredMessage): ThreadRef {
  return { channel: message.channel, thread: message.thread ?? "" };
}

function shown(message: StoredMessage): ShownMessage {
  const { id, author, kind, text, pressable, unfinished, topLevel } = message;
  return { id, author, kind, text, pressable, unfinished, topLevel };
}

/** What a memory chat holds, and the test's side of it. */
export class Room {
  readonly owner: string;
  #clock: ChatContext["clock"] | null = null;
  #inbound: ChatInbound | null = null;
  #sequence = 0;
  readonly #channels = new Set<string>();
  readonly #threads = new Map<string, number>();
  readonly #messages: StoredMessage[] = [];
  readonly #requests = new Map<string, OpenRequest>();
  readonly #lists = new Map<MessageId, OpenList>();
  readonly #strays: string[] = [];
  #lookupFails = false;

  constructor(owner: string) {
    this.owner = owner;
  }

  // ---- the test's side

  /** A channel of the chat; the id the daemon sees is the one returned. */
  openChannel(name: string): string {
    const channel = `chan-${name}`;
    this.#channels.add(channel);
    return channel;
  }

  /** The channel is gone: the chat answers `gone` about it and refuses what is written in it. */
  removeChannel(channel: string): void {
    this.#channels.delete(channel);
  }

  /** The thread's first message is gone: the chat answers `gone` about it. */
  removeThread(ref: ThreadRef): void {
    this.#threads.delete(key(ref.channel, ref.thread));
  }

  /** From now on the chat can not say whether a channel or a thread is there, or can again. */
  failChannelLookups(fails = true): void {
    this.#lookupFails = fails;
  }

  /**
   * A thread that was there before the daemon connected, opened by the owner's message in
   * `channel`: that message reaches no inbound.
   */
  openThread(channel: string, text = "an old thread"): ThreadRef {
    return refOf(this.write(channel, null, this.owner, text, "message"));
  }

  /** The person `user` plays: the owner, or anybody else. */
  as(user: string): Person {
    return {
      says: (channel, text, options) => this.#says(user, channel, text, options),
      answers: (requestId, answer) => this.#answers(user, requestId, answer),
      picks: (list, row) => this.#picks(user, list, row),
    };
  }

  /**
   * The messages of a thread (its root first), or with no `thread` of the channel's main view
   * (the roots of its threads, and the lines the daemon wrote outside any), in order. A deleted
   * message is not there.
   */
  messages(channel: string, thread?: string): readonly ShownMessage[] {
    return this.#messages
      .filter(
        (m) =>
          !m.deleted &&
          m.channel === channel &&
          (thread === undefined ? m.topLevel : m.thread === thread),
      )
      .map(shown);
  }

  /** What `messages` shows, as text. */
  texts(channel: string, thread?: string): readonly string[] {
    return this.messages(channel, thread).map((m) => m.text);
  }

  /** The requests the owner can still answer, in the order they were asked. */
  requests(): readonly OpenRequest[] {
    return [...this.#requests.values()];
  }

  /** The lists the owner can still pick from. */
  lists(): readonly OpenList[] {
    return [...this.#lists.values()];
  }

  /**
   * Calls the daemon made for a capability this chat lacks (a reaction, a status, an activity
   * line), or asked for a thread the chat never issued: empty while the core honours the seam.
   */
  strayCalls(): readonly string[] {
    return this.#strays;
  }

  // ---- the provider's side

  /** Binds the clock a thread's opening is dated with. */
  bind(clock: ChatContext["clock"]): void {
    this.#clock = clock;
  }

  /** From here what the owner does reaches `inbound`. */
  attach(inbound: ChatInbound): void {
    this.#inbound = inbound;
  }

  /** Nothing the owner does reaches the daemon any more, if `inbound` is the one attached. */
  detach(inbound: ChatInbound): void {
    if (this.#inbound === inbound) this.#inbound = null;
  }

  stray(call: string): void {
    this.#strays.push(call);
  }

  knows(channel: string): boolean {
    return this.#channels.has(channel);
  }

  knowsThread(ref: ThreadRef): boolean {
    return this.#threads.has(key(ref.channel, ref.thread));
  }

  lookupFails(): boolean {
    return this.#lookupFails;
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#threads.get(key(ref.channel, ref.thread)) ?? null;
  }

  /**
   * Where the other replies and the owner's messages of `message`'s thread sit, as positions:
   * what a reply needs to tell whether it is the last and whether it was overtaken.
   */
  around(message: StoredMessage): { others: number[]; marks: number[] } {
    const same = this.#messages.filter(
      (m) =>
        !m.deleted && m !== message && m.channel === message.channel && m.thread === message.thread,
    );
    return {
      others: same.filter((m) => m.kind === "reply").map((m) => m.position),
      marks: same
        .filter((m) => m.kind === "message" && m.author === this.owner)
        .map((m) => m.position),
    };
  }

  message(id: MessageId): StoredMessage | null {
    return this.#messages.find((m) => m.id === id && !m.deleted) ?? null;
  }

  /**
   * Writes a message. Without a `thread` it is top-level: by the owner or anybody it opens a
   * thread of its own, by the daemon it is a line of the channel. Throws `ChatError` for a
   * channel the chat does not have.
   */
  write(
    channel: string,
    thread: string | null,
    author: string,
    text: string,
    kind: MessageKind,
  ): StoredMessage {
    if (!this.#channels.has(channel)) throw new ChatError("channel_not_found");
    this.#sequence += 1;
    const id = `msg-${this.#sequence}`;
    let name = thread;
    if (name === null && author !== DAEMON) {
      if (this.#clock === null) throw new Error("the memory chat is not built yet");
      name = `thread-${this.#sequence}`;
      this.#threads.set(key(channel, name), this.#clock.time());
    }
    const message: StoredMessage = {
      id,
      position: this.#sequence,
      channel,
      thread: name,
      topLevel: thread === null,
      author,
      kind,
      text,
      pressable: false,
      unfinished: false,
      deleted: false,
    };
    this.#messages.push(message);
    return message;
  }

  /** Changes what a message shows. Throws `ChatError` once its channel is gone. */
  edit(message: StoredMessage, text: string): void {
    if (!this.#channels.has(message.channel)) throw new ChatError("channel_not_found");
    message.text = text;
  }

  /** A request is shown in a message; the owner can answer it until it is decided or withdrawn. */
  addRequest(request: OpenRequest): void {
    const message = this.message(request.message);
    if (message !== null) message.pressable = true;
    this.#requests.set(request.requestId, request);
  }

  addList(list: OpenList): void {
    const message = this.message(list.message);
    if (message !== null) message.pressable = true;
    this.#lists.set(list.message, list);
  }

  /** Nothing is left to press on the message. */
  settled(id: MessageId): void {
    const message = this.message(id);
    if (message !== null) message.pressable = false;
    for (const [requestId, open] of this.#requests) {
      if (open.message === id) this.#requests.delete(requestId);
    }
    this.#lists.delete(id);
  }

  remove(id: MessageId): void {
    const message = this.message(id);
    if (message === null) return;
    this.settled(id);
    message.deleted = true;
  }

  // ---- the people

  async #says(
    user: string,
    channel: string,
    text: string,
    options: SaysOptions = {},
  ): Promise<Sent> {
    const { thread = null, literal = false } = options;
    if (thread !== null && !this.#threads.has(key(channel, thread))) {
      throw new Error(`no thread ${thread} in ${channel}`);
    }
    const message = this.write(channel, thread, user, text, "message");
    const sent: Sent = { id: message.id, ref: refOf(message), topLevel: message.topLevel };
    // The owner check is this path's own: a message of somebody else is in the chat and nowhere else.
    if (user === this.owner && this.#inbound !== null) {
      await this.#inbound.message({
        ref: sent.ref,
        id: sent.id,
        topLevel: sent.topLevel,
        text,
        plain: text,
        literal,
        content: async () => text,
      });
    }
    return sent;
  }

  async #answers(user: string, requestId: string, answer: OwnerAnswer): Promise<boolean | null> {
    const open = this.#requests.get(requestId);
    if (open === undefined) throw new Error(`no open request ${requestId}`);
    if (open.request.type !== answer.type) {
      throw new Error(`a ${open.request.type} request takes no ${answer.type} answer`);
    }
    // The owner check is this path's own, for a click and for a form alike.
    if (user !== this.owner || this.#inbound === null) return null;
    return this.#inbound.answer(open.ref, requestId, answer, open.message);
  }

  async #picks(user: string, id: MessageId, row: string): Promise<boolean> {
    const open = this.#lists.get(id);
    if (open === undefined) throw new Error(`no open list ${id}`);
    const pick = this.#pickOf(open, row);
    // The owner check is this path's own.
    if (user !== this.owner || this.#inbound === null) return false;
    await this.#inbound.picked(pick);
    return true;
  }

  #pickOf(open: OpenList, row: string): ListPick {
    const { list, channel, message } = open;
    if (list.type === "folders") {
      if (!list.folders.includes(row)) throw new Error(`no folder ${row} in the list`);
      return { type: "folder", channel, path: row, list: message };
    }
    if (!list.sessions.some((s) => s.id === row)) throw new Error(`no session ${row} in the list`);
    return { type: "session", channel, sessionId: row, thread: list.thread, list: message };
  }
}

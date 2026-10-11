/**
 * The memory chat's provider: the chat seam implemented over a `Room`, with every capability
 * false. Nothing streams, nothing reacts, no activity line, no session index, no file upload,
 * and a line for the owner alone is a message of the thread.
 *
 * The seam is read as written. A member that "never rejects" swallows a refusal of the room; one
 * that rejects with `ChatError` lets the room's through. A call for a capability this chat lacks
 * does nothing but leave a record in `Room.strayCalls`, which a test asserts empty. So does a
 * thread asked for that the chat never issued.
 */
import type { Question } from "../../../src/agent/seam.ts";
import {
  type ChannelChat,
  type ChannelState,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type FooterFields,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerList,
  type OwnerRequest,
  type Reply,
  type SessionStatus,
  type TaskUpdate,
  type ThreadChat,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import { DAEMON, type MessageKind, type Room, type StoredMessage } from "./room.ts";

const CAPABILITIES: ChatCapabilities = {
  nativeStreaming: false,
  reactions: false,
  activityLine: false,
  homeIndex: false,
  fileUpload: false,
  ownerOnlyNotices: false,
};

/** The footer as one line of words. */
function footerLine(footer: FooterFields): string {
  const { changes, sessionTokens, contextPercent, sessionLimit, weekLimit } = footer;
  return [
    footer.bypass ? "bypass" : null,
    footer.model,
    footer.effort,
    footer.folder,
    footer.branch,
    changes === null ? null : `+${changes[0]} -${changes[1]}`,
    sessionTokens === null ? null : `${sessionTokens} tokens`,
    contextPercent === null ? null : `${contextPercent}% context`,
    sessionLimit === null ? null : `session ${sessionLimit.percent}%`,
    weekLimit === null ? null : `week ${weekLimit.percent}%`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

type Segment =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "task"; update: TaskUpdate };

/**
 * One reply: a single message whose content grows. Its text and its task lines stand in the
 * order they first came; a task line changes where it stands. After `finish` a line of a run of
 * calls shows its folded words, or goes when they are empty. `closeOut` adds the footer, then
 * (on the thread's latest reply) the counts of what still runs.
 */
class MemoryReply implements Reply {
  readonly #room: Room;
  readonly #ref: ThreadRef;
  readonly #onOpen: OpenMessageChange;
  readonly #segments: Segment[] = [];
  #message: StoredMessage | null = null;
  #finished = false;
  #closed = false;
  #footer: string | null = null;
  #running = "";
  #latest = true;
  #lost = false;
  #landed = false;
  readonly #landing: Promise<boolean>;
  #resolveLanding: (landed: boolean) => void = () => {};

  constructor(room: Room, ref: ThreadRef, onOpen: OpenMessageChange) {
    this.#room = room;
    this.#ref = ref;
    this.#onOpen = onOpen;
    this.#landing = new Promise((resolve) => {
      this.#resolveLanding = resolve;
    });
  }

  get footerShown(): boolean {
    return this.#landed && this.#message !== null;
  }

  async text(markdown: string): Promise<void> {
    const last = this.#segments.at(-1);
    if (last?.kind === "text") last.text += markdown;
    else this.#segments.push({ kind: "text", text: markdown });
    this.#write();
  }

  async task(update: TaskUpdate): Promise<void> {
    const held = this.#segments.find((s) => s.kind === "task" && s.update.id === update.id);
    if (held?.kind === "task") held.update = update;
    else this.#segments.push({ kind: "task", update });
    this.#write();
  }

  async finish(closing: readonly TaskUpdate[]): Promise<void> {
    for (const update of closing) await this.task(update);
    this.#finished = true;
    this.#write();
  }

  async closeOut(footer: FooterFields | null): Promise<boolean> {
    if (this.#closed) return this.#landed;
    this.#closed = true;
    this.#footer = footer === null ? null : footerLine(footer);
    this.#write();
    this.#landed = !this.#lost;
    if (this.#landed && this.#message !== null) {
      this.#message.unfinished = false;
      this.#onOpen(this.#message.id, null);
    }
    this.#resolveLanding(this.#landed);
    return this.#landed;
  }

  waitLanded(): Promise<boolean> {
    return this.#landing;
  }

  async settle(): Promise<boolean> {
    this.#write();
    return !this.#lost;
  }

  setRunning(counts: string): void {
    this.#running = counts;
    if (this.#closed) this.#write();
  }

  setLatest(latest: boolean): void {
    this.#latest = latest;
    if (this.#closed) this.#write();
  }

  #render(): string {
    const lines = this.#segments.flatMap((segment) => {
      if (segment.kind === "text") return [segment.text.trim()];
      const { folded, preview, status, title } = segment.update;
      if (this.#finished && folded !== null) return [folded];
      // The preview is where the core keeps an answered question's answers: under the line.
      const shown = preview === null ? [] : [preview.title, preview.summary, preview.body];
      return [`[${status}] ${title}`, ...shown];
    });
    if (this.#closed) {
      lines.push(this.#footer ?? "");
      if (this.#latest) lines.push(this.#running);
    }
    return lines.filter((line) => line !== "").join("\n");
  }

  /** Brings the message to what the reply is now; a refusal of the room is a write that did not land. */
  #write(): void {
    const text = this.#render();
    try {
      if (this.#message === null) {
        if (text === "") return;
        this.#message = this.#room.write(
          this.#ref.channel,
          this.#ref.thread,
          DAEMON,
          text,
          "reply",
        );
        this.#message.unfinished = true;
        this.#onOpen(null, this.#message.id);
      } else {
        this.#room.edit(this.#message, text);
      }
      this.#lost = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      this.#lost = true;
    }
  }
}

/** The record of an answered question: each question and what was answered to it. */
function answered(
  questions: readonly Question[],
  answers: Readonly<Record<string, string | readonly string[]>>,
): string {
  return questions
    .flatMap((question) => {
      const answer = answers[question.text];
      if (answer === undefined) return [];
      return [`${question.text}: ${typeof answer === "string" ? answer : answer.join(", ")}`];
    })
    .join("\n");
}

class MemoryThread implements ThreadChat {
  readonly #room: Room;
  readonly #ref: ThreadRef;

  constructor(room: Room, ref: ThreadRef) {
    this.#room = room;
    this.#ref = ref;
  }

  readonly activityRefused = false;

  openReply(onOpenMessage: OpenMessageChange): Reply {
    return new MemoryReply(this.#room, this.#ref, onOpenMessage);
  }

  async showStatus(status: SessionStatus): Promise<void> {
    this.#room.stray(`showStatus ${status}`);
  }

  async clearStatus(): Promise<void> {
    this.#room.stray("clearStatus");
  }

  async settleStatus(): Promise<void> {
    this.#room.stray("settleStatus");
  }

  showActivity(text: string): void {
    this.#room.stray(`showActivity ${text}`);
  }

  written(): void {}

  async notice(text: string): Promise<void> {
    await this.#post(text, "notice").catch(() => {});
  }

  async ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId> {
    const message = this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, title, "request");
    this.#room.addRequest({ requestId, message: message.id, ref: this.#ref, request, title });
    return message.id;
  }

  async withdraw(request: MessageId): Promise<void> {
    this.#room.remove(request);
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    rewritten(this.#room, request, answered(questions, answers));
  }

  async rewrite(message: MessageId, text: string): Promise<void> {
    rewritten(this.#room, message, text);
  }

  async tell(text: string): Promise<void> {
    await this.#post(text, "notice").catch(() => {});
  }

  async say(markdown: string): Promise<void> {
    await this.#post(markdown, "reference");
  }

  async acknowledge(message: MessageId): Promise<void> {
    this.#room.stray(`acknowledge ${message}`);
  }

  async link(): Promise<string | null> {
    return null;
  }

  async endReply(reply: MessageId, note: string): Promise<void> {
    const message = this.#room.message(reply);
    if (message === null) return;
    try {
      this.#room.edit(message, `${message.text}\n${note}`);
      message.unfinished = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }

  async close(): Promise<void> {}

  async #post(text: string, kind: MessageKind): Promise<void> {
    this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, text, kind);
  }
}

/** Rewrites a message into a notice with nothing left to press; `ChatError` for one that is not there. */
function rewritten(room: Room, id: MessageId, text: string): void {
  const message = room.message(id);
  if (message === null) throw new ChatError("message_not_found");
  room.edit(message, text);
  room.settled(id);
  message.kind = "notice";
}

class MemoryChannel implements ChannelChat {
  readonly #room: Room;
  readonly #channel: string;

  constructor(room: Room, channel: string) {
    this.#room = room;
    this.#channel = channel;
  }

  async notice(text: string): Promise<void> {
    this.#room.write(this.#channel, null, DAEMON, text, "notice");
  }

  async say(markdown: string): Promise<void> {
    this.#room.write(this.#channel, null, DAEMON, markdown, "reference");
  }

  async offer(list: OwnerList, title: string): Promise<void> {
    const message = this.#room.write(this.#channel, null, DAEMON, title, "list");
    this.#room.addList({ message: message.id, channel: this.#channel, list, title });
  }

  async withdraw(list: MessageId): Promise<boolean> {
    this.#room.remove(list);
    return true;
  }

  async rewrite(list: MessageId, text: string): Promise<void> {
    rewritten(this.#room, list, text);
  }
}

/** The chat provider over a room. */
export class MemoryProvider implements ChatProvider {
  readonly name = "Memory chat";
  readonly capabilities = CAPABILITIES;
  readonly #room: Room;
  #inbound: ChatInbound | null = null;

  constructor(room: Room) {
    this.#room = room;
  }

  thread(ref: ThreadRef): ThreadChat {
    // A thread is a name the chat gave out: the core builds none from something else (a message id).
    if (this.#room.openedAt(ref) === null) this.#room.stray(`thread ${ref.channel}/${ref.thread}`);
    return new MemoryThread(this.#room, ref);
  }

  channel(channel: string): ChannelChat {
    return new MemoryChannel(this.#room, channel);
  }

  escape(text: string, _markup: Markup): string {
    return text;
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#room.openedAt(ref);
  }

  async channelState(channel: string): Promise<ChannelState> {
    if (this.#room.lookupFails()) return "no answer";
    return this.#room.knows(channel) ? "there" : "gone";
  }

  async start(inbound: ChatInbound): Promise<void> {
    this.#inbound = inbound;
    this.#room.attach(inbound);
  }

  async stop(): Promise<void> {
    if (this.#inbound !== null) this.#room.detach(this.#inbound);
  }

  async close(): Promise<void> {}
}

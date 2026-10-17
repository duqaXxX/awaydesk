/**
 * The memory chat: a second chat provider held in memory, for the tests of the seam. Its
 * capabilities are all false (no native streaming, no reactions, no activity line, no session
 * index, no file upload, no line for the owner alone), and it implements every required member
 * of the chat seam for real. It is written against the seam and the core's port alone: the port
 * gives it the rule that places the footer and the list (`tails`, `isLast`, `isOvertaken`).
 *
 * `memoryChat()` is a registry entry that is also the handle on what the provider it builds
 * holds, and on the people a test plays:
 *
 *     const chat = memoryChat();
 *     const channel = chat.openChannel("work");
 *     // ... the daemon builds and starts the provider through `chat` ...
 *     const sent = await chat.as(OWNER).says(channel, "hello");  // top-level: opens a thread
 *     await chat.as(OWNER).says(channel, "more", { thread: sent.ref.thread });
 *     chat.texts(channel, sent.ref.thread);                      // what the thread shows
 *     chat.requests();                                           // what the owner can answer
 *     await chat.as(OWNER).answers(requestId, { type: "permission", allow: true });
 *     await chat.as(SOMEONE).says(channel, "hi");                // in the chat, never delivered
 *
 * Messages, threads and channels keep their names across a restart (build a new provider from
 * the same entry): the chat outlives the daemon.
 */
import type { ChatProvider } from "../../src/chat/seam.ts";
import type { ChatContext, ChatEntry } from "../../src/core/port.ts";
import { MemoryProvider } from "./memory-chat/provider.ts";
import { OWNER, Room } from "./memory-chat/room.ts";

export type {
  OpenList,
  OpenRequest,
  Person,
  SaysOptions,
  Sent,
  ShownMessage,
} from "./memory-chat/room.ts";
export { DAEMON, OWNER, SOMEONE } from "./memory-chat/room.ts";

export interface MemoryChatOptions {
  /** The owner's user id; `OWNER` when absent. */
  readonly owner?: string;
  /** The identity the provider reports (`ChatProvider.identity`); `MEMORY_IDENTITY` when absent. */
  readonly identity?: string;
}

/** The identity of a memory chat given none. */
export const MEMORY_IDENTITY = "memory:daemon";

/** The registry entry of the memory chat, and the handle on its room. */
export class MemoryChat extends Room implements ChatEntry {
  readonly required: readonly string[] = [];
  readonly optional: readonly string[] = [];
  readonly #identity: string;
  #built: MemoryProvider | null = null;

  constructor(owner: string, identity: string) {
    super(owner);
    this.#identity = identity;
  }

  /** The provider `build` made last; throws before the first build. */
  get provider(): ChatProvider {
    if (this.#built === null) throw new Error("the memory chat is not built yet");
    return this.#built;
  }

  async build(context: ChatContext): Promise<ChatProvider> {
    this.bind(context.clock);
    this.#built = new MemoryProvider(this, this.#identity);
    return this.#built;
  }
}

/** A memory chat with no channel yet. */
export function memoryChat(options: MemoryChatOptions = {}): MemoryChat {
  return new MemoryChat(options.owner ?? OWNER, options.identity ?? MEMORY_IDENTITY);
}

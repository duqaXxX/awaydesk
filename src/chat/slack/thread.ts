/**
 * The Slack provider (`ChatProvider` of the chat seam) and one Slack thread as its session uses
 * it (`ThreadChat`), composed from what the provider already has: a `ReplySink` per reply, the
 * `StatusReaction` on the thread's root, the `ThreadStatus` line under its last message, and the
 * request messages of `requests.ts`.
 *
 * What the thread adds to those parts is their wiring: every pass of a reply that wrote, and every
 * notice, tells the status line (Slack clears a thread's status when the app replies); the
 * seam's four statuses are the four reactions; an answered question is rewritten on the budget
 * every reply draws from; and a failed post or rewrite crosses the seam as a `ChatError` named
 * by Slack's code.
 */

import type { Receiver } from "@slack/bolt";
import type { KnownBlock, WebClient } from "@slack/web-api";
import type { AgentBackend, Question } from "../../agent/seam.ts";
import { type Clock, monotonicClock, systemClock } from "../../clock.ts";
import { Cancelled, type CorePort, type Names, named, texts } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import {
  type ChannelChat,
  type ChannelState,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerRequest,
  type Reply,
  type SessionIndex,
  type SessionStatus,
  type ThreadChat,
  type ThreadRef,
} from "../seam.ts";
import type { AppConfig, Fetch } from "./app/answers.ts";
import { type BuiltApp, buildApp } from "./app/app.ts";
import type { ChannelGuard } from "./app/guards.ts";
import { SlackChannel } from "./channel.ts";
import { channelLookup } from "./channels.ts";
import { holdBlocks } from "./hold.ts";
import type { Home } from "./home.ts";
import { crossing, deliver, deliverNotice } from "./notice.ts";
import type { Listings } from "./openfile/listing.ts";
import { endReply } from "./repair.ts";
import { contextBlock, noticeText, split } from "./reply/blocks.ts";
import { deleteRequest, describe } from "./reply/errors.ts";
import { markdownEscape, mrkdwnEscape } from "./reply/escape.ts";
import type { Limiter } from "./reply/limiter.ts";
import { ReplySink } from "./reply/sinks.ts";
import { Status, StatusReaction, ThreadStatus } from "./reply/status.ts";
import { answeredBlocks, approvalBlocks, questionBlocks } from "./requests.ts";
import { setupBlocks } from "./setup.ts";

export const logger = getLogger("awaydesk.chat.slack.thread");

/** The reaction that shows each status of a session on its root message. */
export const REACTIONS: Readonly<Record<SessionStatus, Status>> = {
  working: Status.WORKING,
  waiting: Status.WAITING,
  done: Status.DONE,
  error: Status.ERROR,
};

/** Who a reply's stream is addressed to, and whose messages are read back after a reset. */
export interface SlackIdentity {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly botUserId: string;
}

/** What `start` builds the Bolt app from: the Slack side's own parts, and the core. */
export interface SlackApp {
  /** The core; read when the connection opens, which is after the provider was built. */
  readonly core: () => CorePort;
  /** The bot token downloads a message's files with; the folder sessions may start under. */
  readonly config: AppConfig;
  readonly guard: ChannelGuard;
  /** The session index: the Home tab. */
  readonly home: Home;
  /** The folder a message's files that are no image are saved in (`attachments.uploadsDir`). */
  readonly uploads: string;
  /** Where Slack's payloads come from: `socketReceiver(appToken)` in the daemon. */
  readonly receiver: Receiver;
  /** How a file is downloaded; `attachments.download` with the bot token when absent. */
  readonly fetch?: Fetch;
  /** Wall-clock seconds as a Slack ts counts them; `Date.now` when absent. */
  readonly now?: () => number;
  /** `!open`'s listings; made over the core's `repository` when absent. */
  readonly listings?: Listings;
}

export interface SlackChatOptions {
  /** The client every call but a reply's goes through. */
  readonly slack: WebClient;
  /**
   * The client replies are written with: one that never sends a create or a stream call twice
   * after a reset (`repliesClient`). Required, with no fallback to `slack`: a wiring that
   * forgot it would send a create twice after a reset and nothing would say so.
   */
  readonly replies: WebClient;
  readonly identity: SlackIdentity;
  /** Shared by every reply in the process and by every `chat.update` made beside them. */
  readonly limiter: Limiter;
  /** Wall-clock seconds and every pause of a reply. */
  readonly clock?: Clock;
  /**
   * The clock the status line counts its refreshes on: a monotonic one, so that a step of the
   * system clock neither delays nor repeats a refresh.
   * A test's one clock serves for both.
   */
  readonly steady?: Clock;
  /**
   * The agent the texts name. Read when a text that names it is first needed, never in `build`:
   * the core, and with it the agent, exists only after the provider was built.
   */
  readonly agent: () => Pick<AgentBackend, "name" | "words">;
  /** `sinks.DEBOUNCE_SECONDS`, unless a test shortens it. */
  readonly debounceSeconds?: number;
  /** `sinks.FINAL_RETRY_SECONDS`, unless a test shortens it. */
  readonly finalRetrySeconds?: number;
  /**
   * What the connection is made of. Absent in a test of the threads alone: `start` then has
   * nothing to open, and there is no session index.
   */
  readonly app?: SlackApp;
}

/** Slack draws every part of the chat seam. */
const CAPABILITIES: ChatCapabilities = {
  nativeStreaming: true,
  reactions: true,
  activityLine: true,
  homeIndex: true,
  fileUpload: true,
  ownerOnlyNotices: true,
};

/** The Slack provider: one `SlackThread` per thread, one `SlackChannel` per channel. */
export class SlackChat implements ChatProvider {
  readonly name = "Slack";
  readonly capabilities = CAPABILITIES;
  /** Present when the provider holds the Home tab (`SlackApp.home`). */
  readonly index?: SessionIndex;
  private readonly options: SlackChatOptions;
  private readonly stopping = new AbortController();
  private built: BuiltApp | null = null;
  private named: Names | null = null;

  constructor(options: SlackChatOptions) {
    this.options = options;
    const home = options.app?.home;
    if (home !== undefined) this.index = { refresh: (changed) => home.request(changed) };
  }

  /**
   * The `chat.update` budget every reply in the process draws from, so an edit made outside a
   * reply (a handler's own) can share it.
   */
  get limiter(): Limiter {
    return this.options.limiter;
  }

  /**
   * Aborts when the daemon stops. A listener still in flight then does nothing at its next
   * step: the sessions are closed and the lock is released.
   */
  get stopped(): AbortSignal {
    return this.stopping.signal;
  }

  /** Tells every listener, and every call of the chat, that the daemon is stopping. */
  halt(): void {
    this.stopping.abort();
  }

  /** The names the texts take, the agent's and this chat's, made when first asked for. */
  names(): Names {
    this.named ??= texts.namesOf(this.options.agent(), this);
    return this.named;
  }

  thread(ref: ThreadRef): SlackThread {
    return new SlackThread(ref.channel, ref.thread, this.options, () => this.names(), this.stopped);
  }

  /**
   * The thread as a handler answers in it. A post of the app's clears the status line of the
   * session that lives there, not of this object, which only posts: `written` sets that line
   * again.
   */
  answering(ref: ThreadRef, written: () => void): SlackThread {
    return new SlackThread(
      ref.channel,
      ref.thread,
      this.options,
      () => this.names(),
      this.stopped,
      written,
    );
  }

  channel(channel: string): ChannelChat {
    const { slack, identity, limiter, clock } = this.options;
    return new SlackChannel(channel, {
      slack,
      ownerUserId: identity.ownerUserId,
      limiter,
      clock: clock ?? systemClock,
      stopped: this.stopped,
      names: () => this.names(),
    });
  }

  escape(text: string, markup: Markup): string {
    return markup === "notice" ? mrkdwnEscape(text) : markdownEscape(text);
  }

  openedAt(ref: ThreadRef): number | null {
    // A Slack ts is the post time in epoch seconds.
    const seconds = ref.thread.trim() === "" ? Number.NaN : Number(ref.thread);
    return Number.isNaN(seconds) ? null : seconds;
  }

  channelState(channel: string): Promise<ChannelState> {
    return channelLookup(this.options.slack)(channel);
  }

  async openFile(ref: ThreadRef, folder: string, target: string): Promise<void> {
    if (this.built === null) throw new Error("the Slack app is not started");
    await this.built.openFile(ref.channel, ref.thread, folder, target);
  }

  async start(inbound: ChatInbound): Promise<void> {
    const { app, identity, steady } = this.options;
    if (app === undefined) throw new Error("this Slack provider was built with no app to open");
    const core = app.core();
    this.built = buildApp({
      chat: this,
      slack: this.options.slack,
      config: app.config,
      identity,
      sessions: core.sessions,
      approvals: core.approvals,
      holds: core.holds,
      names: this.names(),
      inbound,
      guard: app.guard,
      state: core.state,
      uploads: app.uploads,
      home: app.home,
      receiver: app.receiver,
      ...(steady !== undefined && { clock: steady }),
      ...(app.fetch !== undefined && { fetch: app.fetch }),
      ...(app.now !== undefined && { now: app.now }),
      ...(app.listings !== undefined && { listings: app.listings }),
    });
    await this.built.app.start();
    logger.info(`connected to Slack workspace ${identity.teamId}`);
  }

  async stop(): Promise<void> {
    const built = this.built;
    try {
      await built?.app.stop();
    } finally {
      // Even when the connection would not close: what listens must stop all the same.
      this.halt();
      // The timers of clips still waiting for a transcript would keep the process alive.
      built?.close();
    }
  }

  async close(): Promise<void> {
    await this.options.app?.home.close();
  }
}

// The requests a provider withdrew lately, by channel and message, per provider (the options it
// was built over). A rewrite that waited for the budget while its message was withdrawn writes
// nothing.
const WITHDRAWN_KEPT = 64;
const withdrawn = new WeakMap<SlackChatOptions, Set<string>>();

export class SlackThread implements ThreadChat {
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly options: SlackChatOptions;
  private readonly names: () => Names;
  private readonly slack: WebClient;
  private readonly clock: Clock;
  // One reaction on the session's root message, which `threadTs` always is (a top-level owner
  // message, or the root of a `!resume` thread, the owner's own message).
  private readonly reaction: StatusReaction;
  /** Issues #83 and #95: Slack's status line at the bottom of the thread. */
  private readonly line: ThreadStatus;
  private readonly stopped: AbortSignal;
  private readonly onWritten: () => void;

  /**
   * `written` stands for this object's own status line where something else holds it: the
   * handlers answer through a thread of their own, and the session's line is the one a post
   * clears.
   */
  constructor(
    channelId: string,
    threadTs: string,
    options: SlackChatOptions,
    names: () => Names,
    stopped: AbortSignal,
    written?: () => void,
  ) {
    this.channel = channelId;
    this.threadTs = threadTs;
    this.options = options;
    this.names = names;
    this.stopped = stopped;
    this.slack = options.slack;
    this.clock = options.clock ?? systemClock;
    this.reaction = new StatusReaction(this.slack, { channel: channelId, rootTs: threadTs });
    this.line = new ThreadStatus(this.slack, {
      channel: channelId,
      threadTs,
      clock: options.steady ?? options.clock ?? monotonicClock,
    });
    this.onWritten = written ?? (() => this.line.wrote());
  }

  openReply(onOpenMessage: OpenMessageChange): Reply {
    const { identity } = this.options;
    return new ReplySink(this.options.replies, {
      channel: this.channel,
      threadTs: this.threadTs,
      teamId: identity.teamId,
      userId: identity.ownerUserId,
      botUserId: identity.botUserId,
      limiter: this.options.limiter,
      clock: this.clock,
      onOpenReply: onOpenMessage,
      onWrite: () => this.line.wrote(),
      ...(this.options.debounceSeconds !== undefined && {
        debounceSeconds: this.options.debounceSeconds,
      }),
      ...(this.options.finalRetrySeconds !== undefined && {
        finalRetrySeconds: this.options.finalRetrySeconds,
      }),
    });
  }

  showStatus(status: SessionStatus, signal?: AbortSignal): Promise<void> {
    return this.reaction.show(REACTIONS[status], signal);
  }

  clearStatus(): Promise<void> {
    return this.reaction.clear();
  }

  settleStatus(): Promise<void> {
    return this.reaction.settle();
  }

  showActivity(text: string, afterName: string): void {
    this.line.show(text, afterName);
  }

  get activityRefused(): boolean {
    return ThreadStatus.refused();
  }

  written(): void {
    this.onWritten();
  }

  async notice(text: string): Promise<void> {
    // mrkdwn reads `&`, `<` and `>` as markup, and a notice can quote the owner's own message.
    const shown = mrkdwnEscape(text);
    try {
      await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: shown,
        blocks: [contextBlock(noticeText(shown))],
        unfurl_links: false,
        unfurl_media: false,
      });
      this.line.wrote(); // a post of the app's clears the thread's status
    } catch (error) {
      logger.error(`could not post in ${this.channel}/${this.threadTs}: ${describe(error)}`);
    }
  }

  async ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId> {
    let blocks: readonly object[];
    switch (request.type) {
      case "question":
        blocks = questionBlocks(requestId, request.questions, this.names());
        break;
      case "permission":
        blocks = approvalBlocks(requestId, request, this.names());
        break;
      case "hold":
        blocks = holdBlocks(requestId, request.link);
        break;
      case "setup":
        blocks = setupBlocks(requestId, request.models, request.selection);
        break;
    }
    let ts: unknown;
    try {
      const posted = await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: title,
        // Built to Block Kit's reference by the modules that make them: opaque to the library's types.
        blocks: blocks as unknown as KnownBlock[],
        unfurl_links: false,
        unfurl_media: false,
      });
      ts = posted.ts;
    } catch (error) {
      // A wait that was cancelled is no refusal of the chat: it crosses as it is.
      if (error instanceof Cancelled) throw error;
      throw new ChatError(describe(error), { cause: error });
    }
    // The message is the only handle on its buttons: one Slack did not name cannot be removed.
    if (typeof ts !== "string" || ts === "") throw new ChatError("no_ts");
    return ts;
  }

  async withdraw(request: MessageId): Promise<void> {
    // (sync) Noted before the first await: a rewrite waiting for the budget sees it.
    this.noteWithdrawn(request);
    await deleteRequest(this.slack, { channel: this.channel, ts: request });
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    try {
      // One more chat.update against the app's budget, which every reply draws from.
      await this.options.limiter.acquire();
      await this.slack.chat.update({
        channel: this.channel,
        ts: request,
        text: named(texts.ANSWERED, this.names()),
        blocks: answeredBlocks(questions, answers, this.names()) as unknown as KnownBlock[],
      });
    } catch (error) {
      throw new ChatError(describe(error), { cause: error });
    }
  }

  rewrite(message: MessageId, text: string): Promise<void> {
    return crossing(async () => {
      await this.options.limiter.acquire();
      // The wait can outlast the message (withdrawn by a `!stop`) and the daemon: nothing is
      // left to edit then, and the edit would only be refused.
      if (this.stopped.aborted || this.wasWithdrawn(message)) return;
      await this.slack.chat.update({
        channel: this.channel,
        ts: message,
        text,
        blocks: [contextBlock(noticeText(text))],
      });
    });
  }

  private noteWithdrawn(message: MessageId): void {
    const kept = withdrawn.get(this.options) ?? new Set<string>();
    withdrawn.set(this.options, kept);
    kept.add(`${this.channel}/${message}`);
    // Only a rewrite that is waiting right now cares: the oldest go.
    for (const old of kept) {
      if (kept.size <= WITHDRAWN_KEPT) break;
      kept.delete(old);
    }
  }

  private wasWithdrawn(message: MessageId): boolean {
    return withdrawn.get(this.options)?.has(`${this.channel}/${message}`) ?? false;
  }

  async tell(text: string, options: { readonly stays?: boolean } = {}): Promise<void> {
    if (this.stopped.aborted) return;
    try {
      await deliverNotice(this.slack, this.options.identity.ownerUserId, this.place, text, {
        ephemeral: !options.stays,
      });
      // Slack clears a thread's status line when the app replies: the session's is set
      // again, so `Working…` does not go for a minute after the answer to a word.
      this.written();
    } catch (error) {
      logger.warning(`could not reach the owner in ${this.channel}: ${describe(error)}`);
    }
  }

  async say(markdown: string, options: { readonly ownerOnly?: boolean } = {}): Promise<void> {
    for (const chunk of split(markdown)) {
      if (this.stopped.aborted) return;
      await crossing(() =>
        deliver(
          this.slack,
          this.options.identity.ownerUserId,
          this.place,
          chunk,
          [{ type: "markdown", text: chunk }],
          { ephemeral: options.ownerOnly ?? false },
        ),
      );
      this.written();
    }
  }

  async acknowledge(message: MessageId): Promise<void> {
    if (this.stopped.aborted) return;
    try {
      await this.slack.reactions.add({
        channel: this.channel,
        name: "white_check_mark",
        timestamp: message,
      });
    } catch (error) {
      logger.warning(`could not react to a word in ${this.channel}: ${describe(error)}`);
    }
  }

  async link(label: string, markup: Markup): Promise<string | null> {
    let permalink: unknown;
    try {
      ({ permalink } = await this.slack.chat.getPermalink({
        channel: this.channel,
        message_ts: this.threadTs,
      }));
      if (typeof permalink !== "string") throw new TypeError("no permalink");
    } catch (error) {
      logger.warning(
        `could not get a permalink for ${this.channel}/${this.threadTs}: ${describe(error)}`,
      );
      return null;
    }
    // A notice is mrkdwn, which takes `<url|label>`; a reference is Markdown, `[label](url)`.
    return markup === "notice" ? `<${permalink}|${label}>` : `[${label}](${permalink})`;
  }

  endReply(reply: MessageId, note: string): Promise<void> {
    return endReply(this.slack, this.options.limiter, this.place, reply, note);
  }

  close(): Promise<void> {
    return this.line.close();
  }

  private get place(): { readonly channel: string; readonly threadTs: string } {
    return { channel: this.channel, threadTs: this.threadTs };
  }
}

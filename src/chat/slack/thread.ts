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
import {
  Cancelled,
  type CorePort,
  type Listings,
  type Names,
  named,
  texts,
} from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import {
  type ChannelChat,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerRequest,
  type Presence,
  type Reply,
  type RunningList,
  type SessionIndex,
  type SessionStatus,
  type ThreadChat,
  type ThreadRef,
} from "../seam.ts";
import type { AppConfig, Fetch } from "./app/answers.ts";
import { type BuiltApp, buildApp } from "./app/app.ts";
import type { ChannelGuard } from "./app/guards.ts";
import { threadKey } from "./app/order.ts";
import { SlackChannel } from "./channel.ts";
import { channelLookup, threadLookup } from "./channels.ts";
import { holdBlocks } from "./hold.ts";
import type { Home } from "./home.ts";
import { crossing, deliver, deliverNotice } from "./notice.ts";
import { endReply } from "./repair.ts";
import { contextBlock, noticeText, split } from "./reply/blocks.ts";
import { deleteRequest, describe } from "./reply/errors.ts";
import { markdownEscape, mrkdwnEscape } from "./reply/escape.ts";
import type { Limiter } from "./reply/limiter.ts";
import { ThreadPlaces } from "./reply/places.ts";
import { ReplySink } from "./reply/sinks.ts";
import { REACTIONS, StatusReaction, ThreadStatus } from "./reply/status.ts";
import { answeredBlocks, approvalBlocks, questionBlocks } from "./requests.ts";
import { type SetupDraw, setupBlocks } from "./setup.ts";

export const logger = getLogger("awaydesk.chat.slack.thread");

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
  fileUpload: true,
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
  /**
   * Where each thread's messages sit, by thread, while a thread object that opened a reply in it
   * is open (`users`), and after that while a reply of it is registered.
   */
  private readonly places = new Map<string, { readonly places: ThreadPlaces; users: number }>();
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

  /** What the setup posted for `requestId` said to draw, or undefined when it is no longer kept. */
  drawnSetup(requestId: string): SetupDraw | undefined {
    return drawnSetups.get(this.options)?.get(requestId);
  }

  thread(ref: ThreadRef): SlackThread {
    return new SlackThread(
      ref.channel,
      ref.thread,
      this.options,
      () => this.names(),
      this.stopped,
      this.leaseOf(ref.channel, ref.thread),
    );
  }

  /**
   * The owner wrote a message at `ts` in a thread. Called by the listener for every owner
   * message, before anything else of it is decided: a message the core later refuses still sits
   * below the replies above it.
   */
  ownerPosted(channel: string, thread: string, ts: string): void {
    this.places.get(threadKey(channel, thread))?.places.ownerPosted(ts);
  }

  /**
   * The thread's places: one object for every `SlackThread` of it, so that the replies of the
   * thread's successive sessions see each other. A thread object takes it at its first reply and
   * gives it back at its close (`ThreadLease`). It lives while one is open: a reply let go of
   * by an owner message must still be found by the next one. After the last give-back it lives
   * while a reply is registered with it.
   */
  private leaseOf(channel: string, thread: string): ThreadLease {
    const key = threadKey(channel, thread);
    return {
      peek: () => this.places.get(key)?.places,
      take: () => {
        const known = this.places.get(key);
        if (known !== undefined) {
          known.users += 1;
          return known.places;
        }
        const made = new ThreadPlaces(() => {
          const entry = this.places.get(key);
          if (entry?.places === made && entry.users === 0) this.places.delete(key);
        });
        this.places.set(key, { places: made, users: 1 });
        return made;
      },
      give: () => {
        const entry = this.places.get(key);
        if (entry === undefined) return;
        entry.users -= 1;
        if (entry.users === 0 && !entry.places.held) this.places.delete(key);
      },
    };
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
      this.leaseOf(ref.channel, ref.thread),
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

  // Slack's channel syntax in a notice. Whether a markdown block renders it was not confirmed
  // (the block's reference names neither mentions nor angle brackets), so `reference` gets the same.
  channelName(channel: string, _markup: Markup): string {
    return `<#${channel}>`;
  }

  openedAt(ref: ThreadRef): number | null {
    // A Slack ts is the post time in epoch seconds.
    const seconds = ref.thread.trim() === "" ? Number.NaN : Number(ref.thread);
    return Number.isNaN(seconds) ? null : seconds;
  }

  channelState(channel: string): Promise<Presence> {
    return channelLookup(this.options.slack)(channel);
  }

  threadState(ref: ThreadRef): Promise<Presence> {
    return threadLookup(this.options.slack)(ref);
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

// What the setups posted lately said to draw, by request id, per provider. A click that only
// redraws a setup (a model picked) draws the message again from this, since the hold it finds
// keeps the model list alone.
const SETUPS_KEPT = 64;
const drawnSetups = new WeakMap<SlackChatOptions, Map<string, SetupDraw>>();

/** How a thread object holds its thread's places: taken at its first reply, given back at its close. */
interface ThreadLease {
  take(): ThreadPlaces;
  give(): void;
  /** The thread's places when some thread object holds them, without taking them. */
  peek(): ThreadPlaces | undefined;
}

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
  private readonly lease: ThreadLease;
  /** The places of this thread, once a reply was opened in it and until the close. */
  private places: ThreadPlaces | null = null;
  private readonly onWritten: () => void;
  /** The replies this object opened, with the places each is registered in. */
  private readonly opened: Array<[ThreadPlaces, ReplySink]> = [];

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
    lease: ThreadLease,
    written?: () => void,
  ) {
    this.channel = channelId;
    this.threadTs = threadTs;
    this.options = options;
    this.names = names;
    this.stopped = stopped;
    this.lease = lease;
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
    this.places ??= this.lease.take();
    const places = this.places;
    const reply = new ReplySink(this.options.replies, {
      channel: this.channel,
      threadTs: this.threadTs,
      teamId: identity.teamId,
      userId: identity.ownerUserId,
      botUserId: identity.botUserId,
      limiter: this.options.limiter,
      clock: this.clock,
      ...(this.options.steady !== undefined && { steady: this.options.steady }),
      onOpenReply: onOpenMessage,
      onWrite: () => this.line.wrote(),
      places,
      ...(this.options.debounceSeconds !== undefined && {
        debounceSeconds: this.options.debounceSeconds,
      }),
      ...(this.options.finalRetrySeconds !== undefined && {
        finalRetrySeconds: this.options.finalRetrySeconds,
      }),
    });
    // A reply the places let go of needs no letting go at close, and must not stay reachable.
    this.opened.splice(
      0,
      this.opened.length,
      ...this.opened.filter(([held, old]) => held.holds(old)),
    );
    this.opened.push([places, reply]);
    return reply;
  }

  showRunning(list: RunningList | null): void {
    // No reply was opened yet: there is nothing for the list to sit under.
    this.places?.showRunning(list);
  }

  showStatus(status: SessionStatus, signal?: AbortSignal): Promise<boolean> {
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

  /**
   * A message of the app's own posted in the thread outside a reply: the places learn where it
   * sits, so that no reply posts its closing message below it later. Null for an ephemeral one.
   */
  private postedOwn(ts: unknown): void {
    if (typeof ts === "string" && ts !== "") (this.places ?? this.lease.peek())?.posted(ts);
  }

  async notice(text: string): Promise<void> {
    // mrkdwn reads `&`, `<` and `>` as markup, and a notice can quote the owner's own message.
    const shown = mrkdwnEscape(text);
    try {
      const posted = await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: shown,
        blocks: [contextBlock(noticeText(shown))],
        unfurl_links: false,
        unfurl_media: false,
      });
      this.postedOwn(posted.ts);
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
        this.noteSetup(requestId, request);
        blocks = setupBlocks(requestId, request, request.selection);
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
    this.postedOwn(ts);
    return ts;
  }

  async withdraw(request: MessageId): Promise<boolean> {
    // (sync) Noted before the first await: a rewrite waiting for the budget sees it.
    this.noteWithdrawn(request);
    return await deleteRequest(this.slack, { channel: this.channel, ts: request });
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
    notes: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      // One more chat.update against the app's budget, which every reply draws from.
      await this.options.limiter.acquire();
      await this.slack.chat.update({
        channel: this.channel,
        ts: request,
        text: named(texts.ANSWERED, this.names()),
        blocks: answeredBlocks(questions, answers, notes, this.names()) as unknown as KnownBlock[],
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

  private noteSetup(requestId: string, request: SetupDraw): void {
    const kept = drawnSetups.get(this.options) ?? new Map<string, SetupDraw>();
    drawnSetups.set(this.options, kept);
    const { models, efforts, bypassOffered } = request;
    kept.set(requestId, { models, efforts, bypassOffered });
    // Only a setup that is waiting right now can be redrawn: the oldest go.
    for (const old of kept.keys()) {
      if (kept.size <= SETUPS_KEPT) break;
      kept.delete(old);
    }
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
      this.postedOwn(
        await deliverNotice(this.slack, this.options.identity.ownerUserId, this.place, text, {
          ephemeral: !options.stays,
        }),
      );
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
      this.postedOwn(
        await crossing(() =>
          deliver(
            this.slack,
            this.options.identity.ownerUserId,
            this.place,
            chunk,
            [{ type: "markdown", text: chunk }],
            { ephemeral: options.ownerOnly ?? false },
          ),
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

  endReply(reply: MessageId, note: string): Promise<boolean> {
    return endReply(this.slack, this.options.limiter, this.place, reply, note);
  }

  async close(): Promise<void> {
    // The list that was just taken off a reply the session no longer tracks only debounced:
    // nothing else would write it before the process ends.
    await this.places?.settleListed();
    // The replies this object opened are let go of, their end landed or not: the session that
    // held them is over, and nothing else would drop them from the thread's places.
    for (const [places, reply] of this.opened) places.closed(reply);
    this.opened.length = 0;
    if (this.places !== null) {
      this.places = null;
      this.lease.give();
    }
    await this.line.close();
  }

  private get place(): { readonly channel: string; readonly threadTs: string } {
    return { channel: this.channel, threadTs: this.threadTs };
  }
}

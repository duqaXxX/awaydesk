/**
 * Forgetting what `state.json` no longer needs: a bound channel the chat no longer has, a thread
 * whose first message the chat no longer has, and a thread whose session is gone. Run once on
 * start and then every `CLEAN_EVERY_SECONDS`, so a daemon that stays up for weeks cleans too.
 *
 * Only a certain answer removes anything. For a channel that is Slack's `channel_not_found` from
 * `conversations.info` (its reference, read 2026-10-01; measured the same day on deleted
 * channels), which is also what a private channel the bot was removed from answers: the two cannot
 * be told apart, and a channel forgotten by mistake is bound again with `!bind`. A rate limit, a
 * server error or the network is no answer and removes nothing. A thread is asked about only in
 * a channel that answered `there` in the same pass (the token of another workspace must never
 * wipe threads), and its certain answer is `thread_not_found` from `conversations.replies` on its
 * root. A thread whose session is gone is dropped by `StateStore.prune`'s rule. The chat provider
 * supplies the lookups that turn Slack's answers into a `Presence`.
 */
import type { Presence, ThreadRef } from "../chat/seam.ts";
import { getLogger, type Logger } from "../log.ts";
import { errorName } from "../values.ts";
import type { OpenedAt, StateStore } from "./state.ts";

export const logger = getLogger("awaydesk.core.cleanup");

/** What a pass writes to the log, so a test can hand it a smaller object. */
type Log = Pick<Logger, "info" | "warning">;

/** What `forgetGoneChannels` did: the channels removed, and those the chat found. */
export interface ForgottenChannels {
  readonly forgotten: string[];
  readonly found: string[];
}

export const CLEAN_EVERY_SECONDS = 6 * 60 * 60;

/**
 * Asks the chat about one channel by its id; a lookup that throws counts as `no answer`. The
 * answer is `gone` (a certain one), `there`, or `no answer` (a rate limit, a server error, the
 * network, a refused scope).
 */
export type ChannelLookup = (channelId: string) => Promise<Presence>;

/** Asks the chat about one thread; answers like a `ChannelLookup`. */
export type ThreadLookup = (ref: ThreadRef) => Promise<Presence>;

/**
 * The (channelId, threadId) of every thread with a live session in the daemon, read at the moment
 * it is needed: nothing of theirs is removed under them.
 */
export type Live = () => Iterable<ThreadRef>;

/** A folder's session ids, or null when it cannot tell. */
export type Alive = (
  directory: string,
) => Iterable<string> | null | Promise<Iterable<string> | null>;

export interface CleanOptions {
  readonly threadLookup: ThreadLookup;
  /** True once a stop has begun: the threads not yet asked about wait for the next start. */
  readonly stopping?: () => boolean;
  readonly alive: Alive;
  readonly live: Live;
  /** The chat's name (`ChatProvider.name`), for the log lines that say whose answer it was. */
  readonly chat: string;
  /** When the chat opened a thread (`ChatProvider.openedAt`): a thread it cannot date is kept. */
  readonly openedAt: OpenedAt;
  /** Seconds since the epoch. */
  readonly now?: () => number;
  readonly logger?: Log;
}

/**
 * Remove from `state` each bound channel the chat answers `gone` about, with its threads. Returns
 * the ids it forgot and those it `found` (answered `there`): the channels whose threads may be
 * asked about. A channel with a live session is left for the next pass. When the chat finds
 * none of the bound channels (a channel it gave no answer about is not one it found), nothing is
 * removed: that is what the token of another workspace, or an app removed from every channel,
 * looks like, and forgetting every binding would be the wrong repair. `chat` is the chat's
 * name, for the log lines.
 */
export async function forgetGoneChannels(
  lookup: ChannelLookup,
  state: StateStore,
  live: Live,
  chat: string,
  log: Log = logger,
): Promise<ForgottenChannels> {
  const bound = state.channels();
  const gone: string[] = [];
  const found: string[] = [];
  for (const channelId of bound) {
    let answer: Presence;
    try {
      answer = await lookup(channelId);
    } catch (error) {
      log.warning(`could not read channel ${channelId}: ${errorName(error)}`);
      continue;
    }
    if (answer === "there") {
      found.push(channelId);
    } else if (answer === "gone") {
      gone.push(channelId);
    } else {
      log.warning(`could not read channel ${channelId}: ${answer}`);
    }
  }
  if (gone.length === 0) return { forgotten: [], found };
  if (found.length === 0) {
    log.warning(
      `${chat} finds none of the ${bound.length} bound channels: nothing is forgotten (check the ` +
        "workspace of the bot token, and that the bot is still in its channels)",
    );
    return { forgotten: [], found };
  }
  const busy = new Set([...live()].map((ref) => ref.channel));
  const forgotten: string[] = [];
  for (const channelId of gone) {
    const record = state.channel(channelId);
    if (record === null || busy.has(channelId)) continue;
    state.removeChannel(channelId);
    forgotten.push(channelId);
    log.info(
      `forgot channel ${channelId}: ${chat} no longer has it (${record.threads.size} thread(s))`,
    );
  }
  return { forgotten, found };
}

/**
 * Remove from `state` each thread, among those of the `channels` the chat found, whose first
 * message the chat answers `gone` about, and return them. A thread with a live session (read
 * when it is removed, after the chat was asked) is left for the next pass, as are the threads of
 * a channel after the first one the chat gave no answer about, and every thread not yet asked
 * about once `stopping` says a stop has begun.
 */
export async function forgetGoneThreads(
  lookup: ThreadLookup,
  state: StateStore,
  channels: readonly string[],
  live: Live,
  chat: string,
  log: Log = logger,
  stopping: () => boolean = () => false,
): Promise<ThreadRef[]> {
  const asked = new Set(channels);
  const gone: ThreadRef[] = [];
  for (const [channel, thread] of state.threads()) {
    // One call to the chat per thread: a stop that begins meanwhile waits for one, not for all.
    if (stopping()) break;
    if (!asked.has(channel)) continue;
    const ref = { channel, thread };
    let answer: Presence | string;
    try {
      answer = await lookup(ref);
    } catch (error) {
      answer = errorName(error);
    }
    if (answer === "gone") {
      gone.push(ref);
    } else if (answer !== "there") {
      // What kept the chat from answering (a rate limit, a history it may not read) holds for
      // the channel's other threads too: they wait for the next pass, with one line here.
      log.warning(`could not read thread ${thread} of ${channel}: ${answer}`);
      asked.delete(channel);
    }
  }
  const busy = new Set([...live()].map((ref) => `${ref.channel}\u0000${ref.thread}`));
  const forgotten: ThreadRef[] = [];
  for (const ref of gone) {
    if (
      busy.has(`${ref.channel}\u0000${ref.thread}`) ||
      state.thread(ref.channel, ref.thread) === null
    ) {
      continue;
    }
    state.removeThread(ref.channel, ref.thread);
    forgotten.push(ref);
    log.info(
      `forgot thread ${ref.thread} of ${ref.channel}: ${chat} no longer has its first message`,
    );
  }
  return forgotten;
}

/**
 * One pass: forget the channels that are gone, then the threads of the others whose first message
 * is gone, then prune the threads whose session is (`alive`
 * gives a folder's session ids, or null when it cannot tell). Never throws: a pass that fails is
 * logged and the next one tries again.
 */
export async function clean(
  lookup: ChannelLookup,
  state: StateStore,
  options: CleanOptions,
): Promise<void> {
  const { alive, live } = options;
  const now = options.now ?? (() => Date.now() / 1000);
  const log = options.logger ?? logger;
  let found: readonly string[] = [];
  try {
    found = (await forgetGoneChannels(lookup, state, live, options.chat, log)).found;
  } catch (error) {
    log.warning(`could not check the bound channels: ${errorName(error)}`);
  }
  try {
    await forgetGoneThreads(
      options.threadLookup,
      state,
      found,
      live,
      options.chat,
      log,
      options.stopping,
    );
  } catch (error) {
    log.warning(`could not check the threads: ${errorName(error)}`);
  }
  try {
    const folders = new Set(
      state
        .threads()
        .filter(([, , thread]) => thread.sessionId !== null)
        .map(([, , thread]) => thread.directory),
    );
    // Reading a folder's sessions is file work that may wait: the state is touched only once all
    // of it is read, and a folder opened meanwhile has no entry here, so its threads are kept.
    const known = new Map<string, readonly string[] | null>();
    for (const folder of folders) {
      const sessions = await alive(folder);
      known.set(folder, sessions === null ? null : [...sessions]);
    }
    const removed = state.prune(
      (directory) => known.get(directory) ?? null,
      options.openedAt,
      now(),
      live(),
    );
    if (removed > 0) log.info(`pruned ${removed} stale thread(s) from state.json`);
  } catch (error) {
    log.warning(`could not prune stale threads: ${errorName(error)}`);
  }
}

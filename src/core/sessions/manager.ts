/**
 * The live sessions, one per open thread, and what spans them: `!bind`, `!resume`, a thread's
 * release for its delete, and the drain of a stop. How its waits are made is the header of
 * `session.ts`.
 */
import type { ListedSession, Repository } from "../../agent/seam.ts";
import type { ThreadChat, ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { bindableFolders } from "../folders.ts";
import * as texts from "../texts.ts";
import { DRAIN_POLL_SECONDS } from "./constants.ts";
import type { SessionDeps } from "./deps.ts";
import { checkDirectory, repositoryBy, trustedBy } from "./directory.ts";
import { DirectoryUnavailable, SessionClosed } from "./errors.ts";
import { logger, ThreadSession } from "./session.ts";
import type { Event } from "./tasks.ts";

function keyOf(channelId: string, threadId: string): string {
  return `${channelId}\n${threadId}`;
}

export class SessionManager {
  private readonly deps: SessionDeps;
  private readonly names: texts.Names;
  private readonly sessions = new Map<string, ThreadSession>();
  /** The threads being deleted (`release`): no session is handed out or built in one. */
  private readonly heldThreads = new Set<string>();
  /**
   * Set at the top of `closeAll`: a listener still in flight when a stop ends must not build a
   * session nobody will close, nor write `state.json` after the lock was released (Node's
   * listeners keep running after a stop).
   */
  private closed = false;
  draining = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.names = texts.namesOf(deps.agent, deps.chat);
  }

  /**
   * A top-level owner message: creates the thread's entry, in the channel's current folder,
   * and its live session. Null when the channel is unbound; `SessionClosed` once a stop closed
   * the sessions, before anything is written.
   */
  open(channelId: string, threadId: string): ThreadSession | null {
    this.refuseWhenClosed();
    if (this.deps.state.channel(channelId) === null) return null;
    const thread = this.deps.state.openThread(channelId, threadId);
    return this.session(channelId, threadId, thread.directory);
  }

  /**
   * The repository holding `directory` when the daemon's git may run in it: the footer's own
   * lookup (`repositoryBy`), so what runs git for `!open` is what runs it for the footer.
   */
  repository(directory: string): Promise<Repository | null> {
    return repositoryBy(this.deps.agent)(directory);
  }

  /**
   * Something of the app's was posted in this thread outside its session (the answer to a
   * word, a notice): the live session's activity line, which that post cleared, is set again.
   * Nothing for a thread with no live session: it shows none.
   */
  wrote(channelId: string, threadId: string): void {
    this.sessions.get(keyOf(channelId, threadId))?.threadWritten();
  }

  /**
   * The thread as a flow answers in it: the live session's own, so that what is posted there
   * sets its activity line again, or the chat's for a thread with no live session.
   */
  chatOf(channelId: string, threadId: string): ThreadChat {
    return (
      this.sessions.get(keyOf(channelId, threadId))?.threadChat ??
      this.deps.chat.thread({ channel: channelId, thread: threadId })
    );
  }

  /**
   * The live session of a thread, or one rebuilt from its stored entry (after a restart, the
   * idle close, or a resume whose session turned out gone); null when the thread is not a
   * session. A closed session (`close()` has started: shutdown, an idle close, or the
   * SessionGone branch of `ensureConnected`) is never handed back here: it is discarded and
   * replaced, so a message never reaches a client that is going, or gone. The session handed
   * back has just been touched: its idle-close timer cannot fire before the caller's own next
   * await, however slow (a download, a slow call to the chat). Null for every thread once a stop
   * closed the sessions.
   */
  get(channelId: string, threadId: string): ThreadSession | null {
    if (this.closed) return null;
    const thread = this.deps.state.thread(channelId, threadId);
    if (thread === null || this.heldThreads.has(keyOf(channelId, threadId))) return null;
    return this.session(channelId, threadId, thread.directory);
  }

  private refuseWhenClosed(): void {
    if (this.closed) throw new SessionClosed();
  }

  private session(channelId: string, threadId: string, directory: string): ThreadSession {
    const key = keyOf(channelId, threadId);
    let session = this.sessions.get(key) ?? null;
    let predecessor: Event | null = null;
    if (session?.closed) {
      // Discarded as soon as closing has started, not once it finishes: a message must never
      // reach an object mid-teardown (every operation on it rejects with SessionClosed). The
      // replacement waits on the old session's own `doneClosing` before it connects, so a
      // rebuild never resumes the same id while the old process is still exiting.
      this.sessions.delete(key);
      predecessor = session.doneClosing;
      session = null;
    }
    if (session === null) {
      const built = new ThreadSession(channelId, threadId, directory, this.deps, { predecessor });
      built.draining = this.draining;
      built.onClosed = () => this.evictIfCurrent(key, built);
      this.sessions.set(key, built);
      session = built;
    }
    // (sync) About to be handed to a caller: never let the idle timer close it out from under
    // whatever slow step (a download, a call to the chat) the caller does before its own
    // submit.
    session.touch();
    return session;
  }

  /**
   * Drop a fully-closed session from the live map, but only if nothing has already replaced it
   * at this key (keeps a long-idle thread's dead object from piling up).
   */
  private evictIfCurrent(key: string, session: ThreadSession): void {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  /**
   * Every thread with a session object that is not closed: what the cleanup of `state.json`
   * must not remove under a running session.
   */
  liveThreads(): ThreadRef[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closed)
      .map((session) => ({ channel: session.channelId, thread: session.threadId }));
  }

  /**
   * The live sessions of a channel, across its threads; a closed one (the idle close, or a
   * gone resume) is left out even before the next lookup evicts it.
   */
  sessionsOf(channelId: string): ThreadSession[] {
    return [...this.sessions.values()].filter(
      (session) => session.channelId === channelId && !session.closed,
    );
  }

  /**
   * While a stop waits: each thread that holds it, of any channel, with what it waits for
   * there (`ThreadSession.restartHold`). Empty when no stop is under way.
   */
  restartHolds(): Array<readonly [session: ThreadSession, hold: string]> {
    if (!this.draining) return [];
    return [...this.sessions.values()]
      .filter((session) => !session.closed)
      .map((session) => [session, session.restartHold] as const)
      .filter(([, hold]) => hold !== "");
  }

  /**
   * A live session of any channel, other than `besides`, whose folder resolves to the same one
   * as `besides`'s own and is not idle (a background task counts as working, same as `idle`
   * already treats it). Each session's own `resolvedDirectory` is kept from its construction:
   * comparing it avoids resolving a path per live session on every message. The first one
   * found is enough: the question links to it.
   */
  workingIn(options: { readonly besides: ThreadSession }): ThreadSession | null {
    const { besides } = options;
    const resolved = besides.resolvedDirectory;
    for (const session of this.sessions.values()) {
      if (
        session !== besides &&
        !session.closed &&
        !session.idle &&
        session.resolvedDirectory === resolved
      ) {
        return session;
      }
    }
    return null;
  }

  /**
   * Bind the channel to `directory`, for the next thread it opens; false, and nothing changed,
   * while any live session of the channel is not idle. A thread already open keeps the folder
   * it started in. `SessionClosed` once a stop closed the sessions.
   */
  async bind(channelId: string, directory: string): Promise<boolean> {
    this.refuseWhenClosed();
    if (this.sessionsOf(channelId).some((session) => !session.idle)) return false;
    this.deps.state.bind(channelId, directory);
    return true;
  }

  /**
   * Close the thread's live session so the thread can be deleted, and wait for its teardown.
   * False, with nothing closed, when the session is not idle or waits for the owner: the same
   * test the idle close makes, so the close is as silent. True holds the thread until `free`:
   * `get` answers null for it meanwhile and `held` says so, so a message sent in a thread that
   * is being deleted is told it holds no session. False once a stop closed the sessions: no
   * thread is held for a delete the stop would cut short.
   */
  async release(channelId: string, threadId: string): Promise<boolean> {
    if (this.closed) return false;
    const key = keyOf(channelId, threadId);
    const session = this.sessions.get(key);
    const inUse =
      session !== undefined && !session.closed && (session.waitingForOwner || !session.idle);
    if (inUse) return false;
    // (sync) Held before the first await: a message that arrives while the session closes, or
    // while the thread's messages are deleted, must not build a session in it.
    this.heldThreads.add(key);
    if (session !== undefined) {
      if (!session.closed) await session.close(texts.ENDED_IDLE);
      await session.doneClosing.wait();
    }
    return true;
  }

  /** Whether the thread is being deleted: it still has its entry, and takes no session. */
  held(channelId: string, threadId: string): boolean {
    return this.heldThreads.has(keyOf(channelId, threadId));
  }

  /** End the hold `release` put on a thread: its delete ended, either way. */
  free(channelId: string, threadId: string): void {
    this.heldThreads.delete(keyOf(channelId, threadId));
  }

  /**
   * `stop()` on every live session of the channel; true if any stopped something. Null when
   * nothing did except cancel a hold: the caller adds no further notice of its own then, the
   * same as `ThreadSession.stop`'s own null, since the held thread already got `Not sent.`.
   */
  async stopChannel(channelId: string): Promise<boolean | null> {
    let stopped = false;
    let heldOnly = false;
    for (const session of this.sessionsOf(channelId)) {
      const result = await session.stop();
      if (result) stopped = true;
      else if (result === null) heldOnly = true;
    }
    if (stopped) return true;
    return heldOnly ? null : false;
  }

  /**
   * `!resume`: opens a thread at `threadId` (the `!resume` message's own ts) in the channel's
   * folder, already on `sessionId`. Null when the channel is unbound; `SessionClosed` once a
   * stop closed the sessions.
   */
  async resume(
    channelId: string,
    threadId: string,
    sessionId: string,
  ): Promise<ThreadSession | null> {
    this.refuseWhenClosed();
    if (this.deps.state.channel(channelId) === null) return null;
    const thread = this.deps.state.openThread(channelId, threadId, sessionId);
    return this.session(channelId, threadId, thread.directory);
  }

  /**
   * Every session of `directory`, the one the caller read for its channel; `dated`, by their
   * last message, newest first, as the terminal's picker shows them. None for an agent that
   * lists none (`sessionListing`).
   */
  async sessionsIn(
    directory: string,
    options: { readonly dated?: boolean } = {},
  ): Promise<readonly ListedSession[]> {
    if (!this.deps.agent.capabilities.sessionListing) return [];
    const found = await this.deps.agent.listSessions(directory);
    return options.dated ? this.dated(directory, found) : found;
  }

  /**
   * `found`, sessions of `directory`, by their last message, newest first. Dating reads files,
   * so a caller that shows only some of a folder's sessions passes those alone.
   */
  async dated(directory: string, found: readonly ListedSession[]): Promise<ListedSession[]> {
    if (!this.deps.agent.capabilities.sessionListing) return [];
    return this.deps.agent.datedSessions(directory, found);
  }

  /**
   * What would keep a session from starting in `directory`, by the checks a start makes; null
   * when nothing would.
   */
  async unavailable(directory: string): Promise<DirectoryUnavailable | null> {
    try {
      await checkDirectory(directory, trustedBy(this.deps.agent), this.names);
    } catch (error) {
      if (error instanceof DirectoryUnavailable) return error;
      throw error;
    }
    return null;
  }

  /** The folders under `root` where a session can start, as `bindableFolders` finds them. */
  foldersIn(root: string): Promise<string[]> {
    return bindableFolders(root, trustedBy(this.deps.agent));
  }

  /**
   * Let the turns already sent finish and send no other, then return: when every channel is
   * idle, or when `cutShort` aborts. Idle includes the background commands and agents, which
   * die with the agent's process, and the turn the agent starts to report each one, except a
   * background task started after the signal by a session whose turn was running when it came
   * (`ThreadSession.restartReady`, issue #87). Queued turns end at once, asking to be sent
   * again. An approval or a question stays open: the chat's connection lives until the drain
   * ends, so the owner can still answer it. A hold does not: it asks about a session the
   * restart is about to touch, so it is cancelled here exactly as `!stop` would (its own waiter
   * tells the owner `Not sent.`).
   */
  async drain(cutShort: AbortSignal): Promise<void> {
    this.draining = true;
    const sessions = [...this.sessions.values()];
    // (sync) Every flag before the first await: no worker sends a queued turn in between.
    for (const session of sessions) {
      session.draining = true;
      session.mayHaveOrderedRestart = session.busy;
    }
    for (const session of sessions) {
      await session.cancelHold();
      // A queued turn genuinely dropped by the drain reacts ❌.
      await session.dropQueued({ error: true });
    }
    while (!cutShort.aborted) {
      const waiting = [...this.sessions.values()];
      if (waiting.every((session) => session.restartReady && !session.reporting)) return;
      for (const session of waiting) {
        // a failed post must not end the wait
        await session.showRestartWait().catch(() => {});
      }
      // Polled: a turn ends in several places, and a stop needs no finer timing.
      await this.deps.clock.sleep(DRAIN_POLL_SECONDS, cutShort).catch(() => {});
    }
  }

  /**
   * Close every session and wait for each to be fully torn down, including one an idle close
   * already had in flight: `close()` is safe to call again on a session already closing, but
   * returning as soon as this call's own no-op finds the client already gone would not wait for
   * whichever call is actually disconnecting it. From its first line the manager refuses to open,
   * resume or bind, and hands out no session. `closed` is called after each session's close, so
   * a caller can tell a long shutdown that goes on from one that is stuck.
   */
  async closeAll(closed?: () => void): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      if (session.closed) continue;
      try {
        await session.close();
      } catch (error) {
        // one session's failure must not skip the rest
        logger.error(
          `could not close ${session.channelId}/${session.threadId}: ${errorName(error)}`,
        );
      }
      closed?.();
    }
    for (const session of sessions) await session.doneClosing.wait();
    this.sessions.clear();
  }
}

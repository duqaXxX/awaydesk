/**
 * The daemon's only written file: per channel, its bound directory and any pending migration
 * notice; per thread within it, the folder it was opened in, its session id, bypass switch and
 * effort level. A file names the agent and the chat it was written for (version 3), since a
 * session id and a thread's name mean nothing to others.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { SessionStatus, ThreadRef } from "../chat/seam.ts";
import { getLogger } from "../log.ts";
import { errorName } from "../values.ts";

export const logger = getLogger("awaydesk.core.state");

// A thread with no session id that was opened longer ago than this never finished its first
// turn: `prune` drops it. When it was opened is the chat's to say (`ChatProvider.openedAt`).
export const ONE_DAY = 24 * 60 * 60;

/** When a thread was opened, in epoch seconds; null when the chat cannot tell. */
export type OpenedAt = (ref: ThreadRef) => number | null;

/**
 * The names of the agent and the chat a `state.json` was written for: a session id and a thread's
 * name mean nothing to another agent or another chat.
 */
export interface StateModules {
  readonly agent: string;
  readonly chat: string;
}

/**
 * What an observer is told after a write: the threads it touched, as a set (no order, no
 * repeats).
 */
export type SessionsChange = (changed: readonly ThreadRef[]) => void;

/**
 * What a request message is, one word stored beside its id for the crash repair: a question or an
 * approval of a turn, the session's setup form, the same-folder hold.
 */
export type RequestKind = "question" | "approval" | "setup" | "hold";

const REQUEST_KINDS: ReadonlySet<unknown> = new Set<RequestKind>([
  "question",
  "approval",
  "setup",
  "hold",
]);

export interface ThreadState {
  /** The folder the thread was opened in. */
  readonly directory: string;
  readonly sessionId: string | null;
  // The owner's last word on bypass, kept across restarts (a restart is the daemon's doing, not
  // the owner's): true after `!bypass on` or a ticked setup, false after `!bypass off` or an
  // unticked one, null when never chosen, which leaves Claude Code's own mode alone. On disk,
  // `bypass` keeps its old meaning (`true` on, `false` not on) and an explicit off adds
  // `bypass_off: true`, written for that alone. A file from before reads as never chosen where
  // it held `false`; old code ignores the extra key and reads an off as not on.
  readonly bypass: boolean | null;
  /** The level the owner set by command; null when unset or set back to the default. */
  readonly effort: string | null;
  // Crash repair (issue #19), each an id only, never message content:
  // the ts of every open reply's last message (more than one can be open at once: a background
  // task's own reply can outlive the turn that started it). Each `ReplySink` owns one entry:
  // added on its first message, replaced on a continuation, removed once its final write is
  // known to have landed. A sink that gave up on that write leaves its entry: the next start's
  // crash repair (`repairCrash`) finishes the message and removes it.
  readonly openReplies: readonly string[];
  /** ts of every approval, question or same-folder hold request still carrying buttons. */
  readonly requests: readonly string[];
  // The kind of each request, by its ts. An entry written before the kinds existed has none; the
  // repair treats it as a request to delete.
  readonly requestKinds: Readonly<Record<string, RequestKind>>;
  // The root's status while it is working or waiting; cleared once done or error is requested.
  readonly status: SessionStatus | null;
  // The root's status once done or error is requested, cleared when it turns working or waiting
  // again: what the session index shows for a session with nothing running. Never read by crash
  // repair. Error stands here next to a kept `status` when an answer never reached the chat: the
  // root shows the error, and repair still owes the thread its notice.
  readonly ended: SessionStatus | null;
}

export interface ChannelRecord {
  readonly directory: string;
  /** Set by the v1 migration, cleared once the migration notice is posted to the channel. */
  readonly noticePending: boolean;
  readonly threads: ReadonlyMap<string, ThreadState>;
}

/** A `ThreadState` with every field but the folder defaulted to "nothing set". */
export function threadState(
  directory: string,
  fields: Partial<Omit<ThreadState, "directory">> = {},
): ThreadState {
  return {
    directory,
    sessionId: null,
    bypass: null,
    effort: null,
    openReplies: [],
    requests: [],
    requestKinds: {},
    status: null,
    ended: null,
    ...fields,
  };
}

/** A `ChannelRecord` with no pending notice and no threads unless given. */
export function channelRecord(
  directory: string,
  fields: Partial<Omit<ChannelRecord, "directory">> = {},
): ChannelRecord {
  return { directory, noticePending: false, threads: new Map(), ...fields };
}

/** state.json exists but cannot be read; the daemon refuses to guess. */
export class StateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateError";
  }
}

/** `openThread` was given a channel that has never been bound. */
export class UnknownChannel extends Error {
  constructor(channelId: string) {
    super(`unknown channel: ${channelId}`);
    this.name = "UnknownChannel";
  }
}

/** A part of the file has the wrong shape; the message becomes the detail of a `StateError`. */
class Malformed extends Error {
  override name = "Malformed";
}

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as an object, or `Malformed` naming `what`. */
function asRaw(value: unknown, what: string): Raw {
  if (!isRaw(value)) throw new Malformed(`${what} must be an object`);
  return value;
}

/** The key's value; a missing key is `Malformed`, named by the key in quotes. */
function required(raw: Raw, key: string): unknown {
  if (!Object.hasOwn(raw, key)) throw new Malformed(`'${key}'`);
  return raw[key];
}

function requiredString(raw: Raw, key: string): string {
  const value = required(raw, key);
  if (typeof value !== "string") throw new Malformed(`'${key}' must be a string`);
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Files written before the words were stored hold the name of the reaction that showed each
// status. They are read as the word they stand for; no file is rewritten for it.
const LEGACY_STATUS: ReadonlyMap<string, SessionStatus> = new Map<string, SessionStatus>([
  ["hourglass_flowing_sand", "working"],
  ["raised_hand", "waiting"],
  ["white_check_mark", "done"],
  ["x", "error"],
]);

const STATUS_WORDS: ReadonlySet<unknown> = new Set<SessionStatus>([
  "working",
  "waiting",
  "done",
  "error",
]);

/** A stored status as a word: a word as it is, a reaction name of an older file as its word. */
function statusOrNull(value: unknown): SessionStatus | null {
  if (typeof value !== "string") return null;
  if (STATUS_WORDS.has(value)) return value as SessionStatus;
  return LEGACY_STATUS.get(value) ?? null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The kinds stored beside `requests`: only a known word for an id that is in the list. */
function requestKinds(
  value: unknown,
  requests: readonly string[],
): Readonly<Record<string, RequestKind>> {
  const kinds: Record<string, RequestKind> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return kinds;
  for (const id of requests) {
    const kind: unknown = Object.hasOwn(value, id) ? (value as Raw)[id] : undefined;
    if (REQUEST_KINDS.has(kind)) kinds[id] = kind as RequestKind;
  }
  return kinds;
}

function parseBypass(raw: Raw): boolean | null {
  if (raw.bypass === true) return true;
  return raw.bypass_off === true ? false : null;
}

/** `bypass` as it always was (`true` on, `false` not on), plus `bypass_off: true` for an
 * explicit off only: never both set. */
function dumpBypass(bypass: boolean | null): Record<string, boolean> {
  if (bypass) return { bypass: true };
  return bypass === false ? { bypass: false, bypass_off: true } : { bypass: false };
}

/**
 * Tolerant of a v2 file written before the repair fields existed (they default to "nothing
 * open"), and a v2 file written with them read by code that does not know them yet ignores the
 * extra keys: both directions of the additive version stay 2 (`bypass_off` is one such key:
 * a file without it reads its `bypass: false` as never chosen; `ended` is another). A file
 * written by 1304c5e's single `open_reply` field (never shipped) is read the same as one with
 * none at all: that key is not looked at.
 */
export function parseThread(raw: Raw): ThreadState {
  const requests = stringList(raw.requests);
  return {
    directory: requiredString(raw, "directory"),
    sessionId: stringOrNull(raw.session_id),
    bypass: parseBypass(raw),
    effort: stringOrNull(raw.effort),
    openReplies: stringList(raw.open_replies),
    requests,
    requestKinds: requestKinds(raw.request_kinds, requests),
    status: statusOrNull(raw.status),
    ended: statusOrNull(raw.ended),
  };
}

function parseChannels(raw: Raw): Map<string, ChannelRecord> {
  const channels = new Map<string, ChannelRecord>();
  for (const [channelId, rawEntry] of Object.entries(
    asRaw(required(raw, "channels"), "'channels'"),
  )) {
    const entry = asRaw(rawEntry, `channel ${channelId}`);
    const threads = new Map<string, ThreadState>();
    const rawThreads = Object.hasOwn(entry, "threads") ? entry.threads : {};
    for (const [threadId, rawThread] of Object.entries(
      asRaw(rawThreads, `'threads' of ${channelId}`),
    )) {
      threads.set(threadId, parseThread(asRaw(rawThread, `thread ${threadId}`)));
    }
    channels.set(channelId, {
      directory: requiredString(entry, "directory"),
      noticePending: entry.notice_pending === true,
      threads,
    });
  }
  return channels;
}

/**
 * What the session index (the Home tab) shows of `threads`: a write that leaves this
 * unchanged is not announced to `StateStore.onSessionsChange`.
 */
function shown(threads: ReadonlyMap<string, ThreadState>): Map<string, string> {
  return new Map(
    [...threads].map(([ts, t]) => [ts, JSON.stringify([t.sessionId, t.status, t.ended])]),
  );
}

/**
 * Each channel keeps its directory, gets empty threads and a pending notice; the old session id
 * and bypass switch belonged to the channel, not to a thread, and are dropped.
 */
function migrateV1(raw: Raw): Map<string, ChannelRecord> {
  const channels = new Map<string, ChannelRecord>();
  for (const [channelId, rawEntry] of Object.entries(
    asRaw(required(raw, "channels"), "'channels'"),
  )) {
    const entry = asRaw(rawEntry, `channel ${channelId}`);
    channels.set(
      channelId,
      channelRecord(requiredString(entry, "directory"), { noticePending: true }),
    );
  }
  return channels;
}

/** The text Python's `json.dump(data, f, indent=2)` writes: ASCII only, no trailing newline. */
function dumpJson(data: unknown): string {
  // `JSON.stringify` differs from `ensure_ascii=True` only in leaving DEL and everything from
  // U+0080 up as they are; a UTF-16 code unit escaped on its own gives the same `🚀`
  // pair for an astral character that Python writes.
  return JSON.stringify(data, null, 2).replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function threadKey(channelId: string, threadId: string): string {
  return `${channelId}\0${threadId}`;
}

export interface StateStoreOptions {
  /** Where a warning goes; ids and error names only, never message content. */
  warn?: (message: string) => void;
  /**
   * The agent and the chat running now. A file written for others is refused (`StateError`), a
   * version 2 file (it carries no names) is taken for these and written as version 3 on the first
   * save. A store given none checks nothing, writes version 2 for a file that has none and keeps
   * the names of one that has.
   */
  modules?: StateModules;
  /**
   * Flushes a written file, then its directory, to the disk: `fs.fsyncSync` when absent. The
   * disk serves one flush at a time for the whole machine, so a store whose file no restart
   * will read (a test's) passes one that does nothing.
   */
  sync?: (fd: number) => void;
}

/** In-memory copy of state.json, written atomically on every change. */
export class StateStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly sync: (fd: number) => void;
  private channelsById: Map<string, ChannelRecord>;
  private modules: StateModules | null;
  // Called after a write that changed which channels are bound, which threads exist, the
  // session one holds, or a root's reaction: what the session index is built from. It is
  // given the (channelId, threadId) of each thread the write touched. Never while loading.
  onSessionsChange: SessionsChange | null = null;

  constructor(path: string, options: StateStoreOptions = {}) {
    this.path = path;
    this.warn = options.warn ?? ((message) => logger.warning(message));
    this.modules = options.modules ?? null;
    this.sync = options.sync ?? fs.fsyncSync;
    this.channelsById = this.load();
  }

  channel(channelId: string): ChannelRecord | null {
    return this.channelsById.get(channelId) ?? null;
  }

  /** The id of every bound channel, in the order they were bound. */
  channels(): string[] {
    return [...this.channelsById.keys()];
  }

  thread(channelId: string, threadId: string): ThreadState | null {
    return this.channelsById.get(channelId)?.threads.get(threadId) ?? null;
  }

  /** Every (channelId, threadId, thread), across all channels. */
  threads(): [string, string, ThreadState][] {
    return [...this.channelsById].flatMap(([channelId, channel]) =>
      [...channel.threads].map(([threadId, thread]): [string, string, ThreadState] => [
        channelId,
        threadId,
        thread,
      ]),
    );
  }

  /**
   * Bind a channel to a directory; its threads and their own folders stay untouched (each
   * thread keeps the folder it was created in), and so does its pending notice.
   */
  bind(channelId: string, directory: string): void {
    const current = this.channelsById.get(channelId);
    this.channelsById.set(channelId, {
      directory,
      noticePending: current?.noticePending ?? false,
      threads: current?.threads ?? new Map(),
    });
    this.save();
    if (current === undefined) this.announce(); // a new channel in the session index; a rebind changes no row
  }

  /** Forget a channel: its binding and every thread in it. A no-op for one that is not bound. */
  removeChannel(channelId: string): void {
    const channel = this.channelsById.get(channelId);
    if (channel === undefined) return;
    this.channelsById.delete(channelId);
    this.save();
    this.announce(
      [...channel.threads.keys()].map(
        (threadId): ThreadRef => ({ channel: channelId, thread: threadId }),
      ),
    );
  }

  /**
   * Create a thread's entry with the channel's current folder, or return the existing one
   * unchanged. Throws `UnknownChannel` for a channel that has never been bound.
   */
  openThread(channelId: string, threadId: string, sessionId: string | null = null): ThreadState {
    const channel = this.channelsById.get(channelId);
    if (channel === undefined) throw new UnknownChannel(channelId);
    const existing = channel.threads.get(threadId);
    if (existing !== undefined) return existing;
    const created = threadState(channel.directory, { sessionId });
    this.replaceThreads(channelId, new Map([...channel.threads, [threadId, created]]));
    return created;
  }

  /** Record a thread's session id; a no-op for a thread that does not exist. */
  setSession(channelId: string, threadId: string, sessionId: string | null): void {
    const current = this.thread(channelId, threadId);
    if (current !== null && current.sessionId !== sessionId) {
      this.setThread(channelId, threadId, { ...current, sessionId });
    }
  }

  /**
   * Record a thread's bypass choice (null: never chosen); a no-op for a thread that does not
   * exist.
   */
  setBypass(channelId: string, threadId: string, on: boolean | null): void {
    const current = this.thread(channelId, threadId);
    if (current !== null && current.bypass !== on) {
      this.setThread(channelId, threadId, { ...current, bypass: on });
    }
  }

  /** Record the effort level a command set for a thread; a no-op for an unknown thread. */
  setEffort(channelId: string, threadId: string, effort: string | null): void {
    const current = this.thread(channelId, threadId);
    if (current !== null && current.effort !== effort) {
      this.setThread(channelId, threadId, { ...current, effort });
    }
  }

  /**
   * One `ReplySink`'s own entry in the open-replies list (crash repair): drop `oldTs` (if it
   * was there), add `newTs` (if not already there), in one write. A no-op for a thread that
   * does not exist, and for a call that changes nothing (both ends of a fresh sink's first
   * message, `oldTs=null, newTs=null`, would otherwise still write).
   */
  replaceOpenReply(
    channelId: string,
    threadId: string,
    oldTs: string | null,
    newTs: string | null,
  ): void {
    const current = this.thread(channelId, threadId);
    if (current === null) return;
    let replies = current.openReplies;
    if (oldTs !== null && replies.includes(oldTs)) replies = replies.filter((t) => t !== oldTs);
    if (newTs !== null && !replies.includes(newTs)) replies = [...replies, newTs];
    if (
      replies.length !== current.openReplies.length ||
      replies.some((t, i) => t !== current.openReplies[i])
    ) {
      this.setThread(channelId, threadId, { ...current, openReplies: replies });
    }
  }

  /**
   * Record a request message still carrying buttons, with its kind (crash repair); a no-op for a
   * thread that does not exist or already has it.
   */
  addRequest(channelId: string, threadId: string, messageTs: string, kind: RequestKind): void {
    const current = this.thread(channelId, threadId);
    if (current !== null && !current.requests.includes(messageTs)) {
      this.setThread(channelId, threadId, {
        ...current,
        requests: [...current.requests, messageTs],
        requestKinds: { ...current.requestKinds, [messageTs]: kind },
      });
    }
  }

  /**
   * Drop a decided or removed request from the list (crash repair); a no-op if it is not there,
   * including for a thread that does not exist.
   */
  removeRequest(channelId: string, threadId: string, messageTs: string): void {
    const current = this.thread(channelId, threadId);
    if (current?.requests.includes(messageTs)) {
      const remaining = current.requests.filter((t) => t !== messageTs);
      const { [messageTs]: _gone, ...kinds } = current.requestKinds;
      this.setThread(channelId, threadId, {
        ...current,
        requests: remaining,
        requestKinds: kinds,
      });
    }
  }

  /**
   * Record the root's status while it is working or waiting (`status`), or clear it once done or
   * error is requested (crash repair) and keep that one as `ended`; both null for a root left
   * bare, both set for an error shown while repair still owes the thread. A no-op for a thread
   * that does not exist.
   */
  setStatusPending(
    channelId: string,
    threadId: string,
    status: SessionStatus | null,
    ended: SessionStatus | null = null,
  ): void {
    const current = this.thread(channelId, threadId);
    if (current !== null && (current.status !== status || current.ended !== ended)) {
      this.setThread(channelId, threadId, { ...current, status, ended });
    }
  }

  /**
   * Every (channelId, threadId, thread) whose crash-repair fields are not all empty: what a
   * crashed daemon left open for startup repair to find.
   */
  repairsPending(): [string, string, ThreadState][] {
    return this.threads().filter(
      ([, , thread]) =>
        thread.openReplies.length > 0 || thread.requests.length > 0 || thread.status !== null,
    );
  }

  /**
   * Clear a thread's crash-repair fields together, once it has been repaired (or repair failed
   * for good and was logged); a no-op if already clear or the thread is gone. With `keepOpen`
   * the open replies and the root's status stay: an answer never reached Slack, and the next
   * start's repair still has to close it and say so.
   */
  clearRepair(
    channelId: string,
    threadId: string,
    { keepOpen = false }: { keepOpen?: boolean } = {},
  ): void {
    const current = this.thread(channelId, threadId);
    if (current === null) return;
    const replies = keepOpen ? current.openReplies : [];
    const status = keepOpen ? current.status : null;
    if (
      current.requests.length === 0 &&
      replies.length === current.openReplies.length &&
      current.status === status
    ) {
      return;
    }
    this.setThread(channelId, threadId, {
      ...current,
      openReplies: replies,
      requests: [],
      requestKinds: {},
      status,
    });
  }

  /** Drop a thread's entry; a no-op if it is not there. */
  removeThread(channelId: string, threadId: string): void {
    const channel = this.channelsById.get(channelId);
    if (channel === undefined || !channel.threads.has(threadId)) return;
    const remaining = new Map(channel.threads);
    remaining.delete(threadId);
    this.replaceThreads(channelId, remaining);
  }

  /** The (channelId, threadId) whose thread holds this session id, across all channels. */
  holder(sessionId: string): ThreadRef | null {
    for (const [channelId, channel] of this.channelsById) {
      for (const [threadId, thread] of channel.threads) {
        if (thread.sessionId === sessionId) return { channel: channelId, thread: threadId };
      }
    }
    return null;
  }

  /** Channel ids whose v1-to-v2 migration notice has not been posted yet. */
  pendingNotices(): string[] {
    return [...this.channelsById].filter(([, c]) => c.noticePending).map(([id]) => id);
  }

  /** Mark a channel's migration notice as posted; a no-op if already clear or unbound. */
  clearNotice(channelId: string): void {
    const channel = this.channelsById.get(channelId);
    if (channel === undefined || !channel.noticePending) return;
    this.channelsById.set(channelId, { ...channel, noticePending: false });
    this.save();
  }

  /**
   * Remove a thread whose session id is gone from its folder's sessions, and a no-session
   * thread that `openedAt` says was opened more than `ONE_DAY` before `now` (one it cannot date
   * is kept). Calls `alive` once per distinct folder;
   * null means it cannot tell, and that folder's threads are kept. `keep` names the
   * (channelId, threadId) to leave alone whatever they look like: the threads with a live
   * session, whose id may not be on disk yet. If `alive` throws, nothing is removed or written;
   * the caller decides what to do next. Returns how many entries were removed.
   */
  prune(
    alive: (directory: string) => Iterable<string> | null,
    openedAt: OpenedAt,
    now: number,
    keep: Iterable<ThreadRef> = [],
  ): number {
    const kept = new Set([...keep].map((ref) => threadKey(ref.channel, ref.thread)));
    const aliveCache = new Map<string, ReadonlySet<string> | null>();
    const updated = new Map<string, ChannelRecord>();
    let removed = 0;
    for (const [channelId, channel] of this.channelsById) {
      const survivors = new Map<string, ThreadState>();
      for (const [threadId, thread] of channel.threads) {
        if (kept.has(threadKey(channelId, threadId))) {
          survivors.set(threadId, thread);
          continue;
        }
        if (thread.sessionId !== null) {
          if (!aliveCache.has(thread.directory)) {
            const sessions = alive(thread.directory);
            aliveCache.set(thread.directory, sessions === null ? null : new Set(sessions));
          }
          const sessions = aliveCache.get(thread.directory);
          if (sessions && !sessions.has(thread.sessionId)) {
            removed += 1;
            continue;
          }
        } else {
          const opened = openedAt({ channel: channelId, thread: threadId });
          if (opened !== null && now - opened > ONE_DAY) {
            removed += 1;
            continue;
          }
        }
        survivors.set(threadId, thread);
      }
      updated.set(
        channelId,
        survivors.size === channel.threads.size ? channel : { ...channel, threads: survivors },
      );
    }
    if (removed > 0) {
      const gone: ThreadRef[] = [];
      for (const [channelId, channel] of this.channelsById) {
        const after = updated.get(channelId)?.threads;
        for (const threadId of channel.threads.keys()) {
          if (!after?.has(threadId)) gone.push({ channel: channelId, thread: threadId });
        }
      }
      this.channelsById = updated;
      this.save();
      this.announce(gone);
    }
    return removed;
  }

  private setThread(channelId: string, threadId: string, updated: ThreadState): void {
    const channel = this.channelsById.get(channelId) as ChannelRecord;
    this.replaceThreads(channelId, new Map([...channel.threads, [threadId, updated]]));
  }

  private replaceThreads(channelId: string, threads: Map<string, ThreadState>): void {
    const channel = this.channelsById.get(channelId) as ChannelRecord;
    this.channelsById.set(channelId, { ...channel, threads });
    this.save();
    const before = shown(channel.threads);
    const after = shown(threads);
    const changed: ThreadRef[] = [];
    for (const threadId of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(threadId) !== after.get(threadId))
        changed.push({ channel: channelId, thread: threadId });
    }
    if (changed.length > 0) this.announce(changed);
  }

  /** The write is already on disk: an observer that fails must not fail its caller. */
  private announce(changed: readonly ThreadRef[] = []): void {
    if (this.onSessionsChange === null) return;
    try {
      this.onSessionsChange(changed);
    } catch (error) {
      this.warn(`the session index was not told of a change: ${errorName(error)}`);
    }
  }

  private load(): Map<string, ChannelRecord> {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
      throw error;
    }
    let channels: Map<string, ChannelRecord>;
    let migrated = false;
    try {
      // Bytes that are not UTF-8 stop the read and a BOM is kept, which the JSON parser then
      // refuses; `TextDecoder` does both with these two options.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const raw = asRaw(JSON.parse(text), "the file");
      const version = required(raw, "version");
      if (version === 2 || version === 3) {
        if (version === 3)
          this.checkModules(requiredString(raw, "agent"), requiredString(raw, "chat"));
        channels = parseChannels(raw);
      } else if (version === 1) {
        channels = migrateV1(raw);
        migrated = true;
      } else {
        throw new StateError(`${this.path} has an unknown version; fix or delete it`);
      }
    } catch (error) {
      const unreadable =
        error instanceof SyntaxError ||
        error instanceof Malformed ||
        (error instanceof TypeError &&
          "code" in error &&
          error.code === "ERR_ENCODING_INVALID_ENCODED_DATA");
      if (!unreadable) throw error;
      throw new StateError(`${this.path} cannot be read (${error.message}); fix or delete it`, {
        cause: error,
      });
    }
    if (migrated) this.write(channels);
    return channels;
  }

  /**
   * A version 3 file names the agent and the chat that wrote it: those now running must be the
   * same. A store given no names takes the file's, so that it writes them back unchanged.
   */
  private checkModules(agent: string, chat: string): void {
    if (this.modules === null) {
      this.modules = { agent, chat };
    } else if (this.modules.agent !== agent || this.modules.chat !== chat) {
      throw new StateError(
        `${this.path} belongs to other modules: it was written for the agent "${agent}" and the ` +
          `chat "${chat}", and this start selects the agent "${this.modules.agent}" and the chat ` +
          `"${this.modules.chat}"; select the modules it was written for, or delete the file`,
      );
    }
  }

  private save(): void {
    this.write(this.channelsById);
  }

  /**
   * Written synchronously, so two changes never interleave: the next line of the caller runs
   * with the file already renamed into place.
   */
  private write(channels: ReadonlyMap<string, ChannelRecord>): void {
    const data = {
      ...(this.modules === null
        ? { version: 2 }
        : { version: 3, agent: this.modules.agent, chat: this.modules.chat }),
      channels: Object.fromEntries(
        [...channels].map(([channelId, c]) => [
          channelId,
          {
            directory: c.directory,
            notice_pending: c.noticePending,
            threads: Object.fromEntries(
              [...c.threads].map(([threadId, t]) => [
                threadId,
                {
                  directory: t.directory,
                  session_id: t.sessionId,
                  ...dumpBypass(t.bypass),
                  effort: t.effort,
                  open_replies: [...t.openReplies],
                  requests: [...t.requests],
                  request_kinds: { ...t.requestKinds },
                  status: t.status,
                  ended: t.ended,
                },
              ]),
            ),
          },
        ]),
      ),
    };
    // Write beside the target and rename: a crash leaves the old file or the new one.
    const tmp = join(dirname(this.path), `.state-${randomBytes(4).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(fd, dumpJson(data));
        this.sync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.path);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch (unlinkError) {
        if (
          !(unlinkError instanceof Error && "code" in unlinkError && unlinkError.code === "ENOENT")
        ) {
          throw unlinkError;
        }
      }
      throw error;
    }
    // The rename is a directory entry: only a sync of the directory makes it survive a power cut.
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(dirname(this.path), "r");
      try {
        this.sync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  }
}

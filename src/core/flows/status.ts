/**
 * `!status` typed in the channel: its folder, then one line per live session, and what a stop
 * waits for when one is under way.
 */
import type { ListedSession } from "../../agent/seam.ts";
import { errorName } from "../../values.ts";
import { oneLine, TITLE_LIMIT } from "../reply/words.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/** How long ago, in one unit, as a channel's `!status` says it of an idle session. */
export function ago(seconds: number): string {
  const whole = Math.trunc(seconds);
  if (whole < 60) return "just now";
  if (whole < 3600) return `${Math.floor(whole / 60)}m ago`;
  if (whole < 86400) return `${Math.floor(whole / 3600)}h ago`;
  return `${Math.floor(whole / 86400)}d ago`;
}

/** The answer to `!status` typed in `channel`. */
export type ChannelStatus = (channel: string) => Promise<void>;

export function channelStatus(deps: FlowDeps, talk: Talk): ChannelStatus {
  const { state, sessions } = deps;

  async function row(
    channel: string,
    channelDirectory: string,
    session: ThreadSession,
    known: ReadonlyMap<string, ListedSession>,
  ): Promise<string> {
    const stored = state.thread(channel, session.threadId);
    const info = stored === null ? undefined : known.get(String(stored.sessionId));
    const title = info === undefined ? "" : oneLine(info.title, TITLE_LIMIT);
    const linked = await talk.referenceLink({ channel, thread: session.threadId }, title);
    let activity: string;
    if (session.waitingForOwner) {
      activity = texts.STATUS_CHANNEL_WAITING;
    } else if (session.busy || session.runningKinds) {
      // A session with only a background task running is not idle either.
      activity = texts.STATUS_CHANNEL_BUSY;
    } else {
      activity = texts.STATUS_CHANNEL_IDLE;
      if (info?.lastModified) {
        // In milliseconds, and by now the time of the session's last message (dated below).
        const since = ago(deps.now() - info.lastModified / 1000);
        activity += fill(texts.STATUS_CHANNEL_SINCE, { ago: since });
      }
    }
    let line = fill(texts.STATUS_CHANNEL_ROW, { link: linked, activity });
    if (session.runningKinds) {
      line += ` · ${fill(texts.RUNNING, { counts: session.runningKinds })}`;
    }
    if (session.bypass) line += texts.STATUS_CHANNEL_BYPASS;
    if (session.directory !== channelDirectory) {
      line += fill(texts.STATUS_CHANNEL_FOLDER, { directory: session.directory });
    }
    return line;
  }

  return async (channel) => {
    const record = state.channel(channel);
    if (record === null) {
      await talk.unbound(channel);
      return;
    }
    const lines = [fill(texts.STATUS_CHANNEL_HEADER, { directory: record.directory })];
    const live = sessions.sessionsOf(channel);
    if (live.length === 0) {
      lines.push(texts.STATUS_CHANNEL_EMPTY);
    } else {
      // What tells one thread from another (issue #76): the title the agent gave its session,
      // as the Home tab and a restart's notice name it, and the time of its last message. Not
      // the time of its file, which the listing gives: Claude Code writes entries with no
      // timestamp to a transcript when it connects the session again, so a session idle for 16
      // minutes read `just now` (seen 2026-10-07). Only the sessions the answer shows are
      // dated, since dating reads their files.
      const shown = new Set<string>();
      for (const session of live) {
        const stored = state.thread(channel, session.threadId);
        if (stored?.sessionId) shown.add(stored.sessionId);
      }
      const known = new Map<string, ListedSession>();
      for (const directory of new Set(live.map((session) => session.directory))) {
        try {
          const listed = await sessions.sessionsIn(directory);
          const dated = await sessions.dated(
            directory,
            listed.filter((session) => shown.has(session.id)),
          );
          for (const session of dated) known.set(session.id, session);
        } catch (error) {
          if (isCancelled(error)) throw error;
          logger.warning(`could not list a folder's sessions: ${errorName(error)}`);
        }
      }
      lines.push(
        ...(await Promise.all(
          live.map((session) => row(channel, record.directory, session, known)),
        )),
      );
    }
    await talk.say(channel, null, lines.join("\n"));
    const waits = await talk.restartWaits(channel);
    if (waits) {
      // A notice of its own: the rows are written for a notice, and the status above is a reference.
      await talk.inChannel(channel, [texts.RESTART_WAITS_HEADER, waits].join("\n"));
    }
  };
}

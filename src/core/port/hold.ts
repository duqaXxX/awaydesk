/**
 * The port of the hold flow: the question that holds a message before it wakes a session in a
 * folder another session is working in, and the owner's Send anyway or Don't send.
 */
import type { Holds } from "../hold.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { ThreadSession } from "../sessions/session.ts";

export type HoldSessions = Pick<SessionManager, "draining">;

export type HoldSession = Pick<ThreadSession, "channelId" | "threadId" | "holdStart" | "holdEnd">;

export type HoldHolds = Pick<Holds, "open" | "get" | "resolve" | "posted" | "discard">;

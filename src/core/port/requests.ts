/**
 * The port of the requests flow: the owner's answer to a permission and to a question, a
 * session's setup before its first prompt, and what every answer to the owner needs (the
 * threads a stop waits for, a request's message recorded for crash repair).
 */
import type { Holds } from "../hold.ts";
import type { Approvals } from "../requests.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { ThreadSession } from "../sessions/session.ts";
import type { StateStore } from "../state.ts";

export type RequestsSessions = Pick<
  SessionManager,
  "get" | "draining" | "wrote" | "restartHolds" | "sessionsIn"
>;

export type RequestsSession = Pick<
  ThreadSession,
  | "channelId"
  | "threadId"
  | "directory"
  | "models"
  | "bypass"
  | "ensureConnected"
  | "applySetup"
  | "forgetSetup"
>;

export type RequestsState = Pick<StateStore, "thread" | "addRequest" | "removeRequest">;

export type RequestsApprovals = Pick<Approvals, "get" | "resolve">;

/** A setup waits for its Start as a hold does. */
export type RequestsHolds = Pick<Holds, "get" | "resolve" | "atMessage">;

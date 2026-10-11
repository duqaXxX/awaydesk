/**
 * The port of the requests: what the Slack provider still reads to draw them (the open request a
 * click names, a setup's model list) and what every answer to the owner needs (the threads a
 * stop waits for, a request's message recorded for crash repair). What the owner's answer
 * decides is the core's: `ChatInbound.answer`.
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
  "channelId" | "threadId" | "directory" | "ensureConnected" | "forgetSetup"
>;

export type RequestsState = Pick<StateStore, "thread" | "addRequest" | "removeRequest">;

export type RequestsApprovals = Pick<Approvals, "get">;

/** A setup waits for its Start as a hold does; the model picked redraws the open one. */
export type RequestsHolds = Pick<Holds, "get" | "atMessage">;

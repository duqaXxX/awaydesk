/**
 * The port of the requests: what the Slack provider still reads to draw them (the open request a
 * click names, a setup's model list) and to answer a thread (a session's lookup, the mark that
 * something was written there). What the owner's answer decides is the core's:
 * `ChatInbound.answer`.
 */
import type { Holds } from "../hold.ts";
import type { Approvals } from "../requests.ts";
import type { SessionManager } from "../sessions/manager.ts";

export type RequestsSessions = Pick<SessionManager, "live" | "wrote">;

export type RequestsApprovals = Pick<Approvals, "questions">;

/**
 * A setup waits for its Start as a hold does; the model picked redraws the open one, and says
 * nothing when Start already decided it.
 */
export type RequestsHolds = Pick<Holds, "atMessage" | "decidedAt">;

/**
 * The port of the resume and bind flows: `!resume` with its list of sessions, `!bind` with its
 * list of folders, and the pick from either.
 */
import type { SessionManager } from "../sessions/manager.ts";
import type { StateStore } from "../state.ts";

export type ResumeBindSessions = Pick<
  SessionManager,
  "get" | "bind" | "held" | "resume" | "sessionsIn" | "dated" | "unavailable" | "foldersIn"
>;

export type ResumeBindState = Pick<StateStore, "channel" | "holder">;

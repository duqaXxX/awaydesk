/**
 * The port of what happens to a thread outside its session: what a stopped daemon left open in
 * it, repaired at the next start, and the thread deleted from the chat with what the daemon
 * keeps of it.
 */
import type { SessionManager } from "../sessions/manager.ts";
import type { StateStore } from "../state.ts";

export type ThreadsSessions = Pick<SessionManager, "release" | "free">;

export type ThreadsState = Pick<
  StateStore,
  | "repairsPending"
  | "replaceOpenReply"
  | "removeRequest"
  | "setStatusPending"
  | "channels"
  | "thread"
  | "removeThread"
>;

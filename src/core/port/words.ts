/**
 * The port of the words flow: a message the owner typed, read as a word of the daemon's, a
 * command of the agent's or a prompt, and what each does (`!status`, `!stop`, `!help`,
 * `!bypass`, and the prompt on its way to its session).
 */
import type { SessionManager } from "../sessions/manager.ts";
import type { ThreadSession } from "../sessions/session.ts";
import type { StateStore } from "../state.ts";

export type WordsSessions = Pick<
  SessionManager,
  "open" | "get" | "draining" | "workingIn" | "sessionsOf" | "stopChannel" | "sessionsIn" | "dated"
>;

export type WordsSession = Pick<
  ThreadSession,
  | "channelId"
  | "threadId"
  | "directory"
  | "commands"
  | "bypass"
  | "busy"
  | "waitingForOwner"
  | "runningKinds"
  | "neverRan"
  | "reactHoldAbandoned"
  | "submit"
  | "ensureConnected"
  | "switchBypass"
  | "forgetSetup"
  | "stop"
  | "stopLanded"
  | "status"
>;

export type WordsState = Pick<StateStore, "channel" | "thread">;

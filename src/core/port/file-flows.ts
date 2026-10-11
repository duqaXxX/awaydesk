/**
 * The port of the files flows: the files of a message, a spoken clip, and `!open`, which reads
 * the folder of a thread's session and the repository that holds it.
 */
import type { SessionManager } from "../sessions/manager.ts";
import type { ThreadSession } from "../sessions/session.ts";
import type { StateStore } from "../state.ts";

export type FilesSessions = Pick<SessionManager, "get" | "held" | "wrote" | "repository">;

export type FilesSession = Pick<ThreadSession, "directory">;

export type FilesState = Pick<StateStore, "channel" | "thread">;

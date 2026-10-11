/**
 * The port of the files flows: `!open`, which reads the repository that holds a thread's folder
 * and whether a thread is being deleted, and the channel's folder.
 */
import type { SessionManager } from "../sessions/manager.ts";
import type { StateStore } from "../state.ts";

export type FilesSessions = Pick<SessionManager, "held" | "repository">;

export type FilesState = Pick<StateStore, "channel">;

/**
 * The port of the session index: every thread the daemon keeps, by channel, and the sessions
 * the agent lists for a folder, which give each row its title and its date.
 */
import type { AgentBackend } from "../../agent/seam.ts";
import type { StateStore } from "../state.ts";

export type HomeState = Pick<StateStore, "threads">;

export type HomeAgent = Pick<AgentBackend, "listSessions">;

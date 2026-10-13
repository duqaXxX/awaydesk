/** The Claude back end as the registry holds it: the entry `claude`. */
import type { AgentEntry } from "../seam.ts";
import { ClaudeBackend, type ClaudeBackendOptions } from "./backend.ts";

// Claude Code's own variables the owner may set in the daemon's file; each reaches a thread's
// session as written, and Claude Code judges its value. `BASH_DEFAULT_TIMEOUT_MS`, in
// milliseconds, is how long a command may run: above 30 minutes it also replaces the limit a
// session of the SDK puts on a command in the background, which a terminal session does not
// have (tools reference, "Time limit for background commands", read 2026-10-13).
export const VARIABLES: readonly string[] = ["BASH_DEFAULT_TIMEOUT_MS"];

/**
 * The entry that builds the Claude back end. `options` are what a test replaces: the SDK's
 * query, the owner's home, the usage probe's start.
 */
export function claudeAgent(options: ClaudeBackendOptions = {}): AgentEntry {
  return {
    required: [],
    optional: VARIABLES,
    build: (context) =>
      new ClaudeBackend({ clock: context.clock, variables: context.variables, ...options }),
  };
}

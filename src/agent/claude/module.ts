/** The Claude back end as the registry holds it: the entry `claude`. */
import type { AgentEntry } from "../seam.ts";
import { ClaudeBackend, type ClaudeBackendOptions } from "./backend.ts";

/**
 * The entry that builds the Claude back end. `options` are what a test replaces: the SDK's
 * query, the owner's home, the usage probe's start.
 */
export function claudeAgent(options: ClaudeBackendOptions = {}): AgentEntry {
  return {
    required: [],
    optional: [],
    build: (context) => new ClaudeBackend({ clock: context.clock, ...options }),
  };
}

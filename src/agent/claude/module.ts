/** The Claude back end as the registry holds it: the entry `claude`. */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { AgentConfigError, type AgentEntry } from "../seam.ts";
import { ClaudeBackend, type ClaudeBackendOptions } from "./backend.ts";

// Claude Code's own variables the owner may set in the daemon's file; each reaches a thread's
// session as written, and Claude Code judges its value. `BASH_DEFAULT_TIMEOUT_MS`, in
// milliseconds, is how long a command may run: above 30 minutes it also replaces the limit a
// session of the SDK puts on a command in the background, which a terminal session does not
// have (tools reference, "Time limit for background commands", read 2026-10-13).
// `CLAUDE_CONFIG_DIR` is the folder of a login of its own, for an instance that drives a second
// Claude Code account (environment variables page, "useful for running multiple accounts side by
// side", read 2026-10-17); it is handled below, since the daemon reads the folder too.
export const VARIABLES: readonly string[] = ["BASH_DEFAULT_TIMEOUT_MS", "CLAUDE_CONFIG_DIR"];

/**
 * The declared variables the owner's file sets, each read by its name: the daemon hands a module
 * its variables readable by lookup and shown by nothing, so a spread of them copies none.
 */
function set(variables: Readonly<Record<string, string>>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of VARIABLES) {
    const value = variables[name];
    if (value !== undefined) found[name] = value;
  }
  return found;
}

/**
 * The folder the owner's file names, else the one the daemon's environment holds (an empty one is
 * none), `~` read as the home and `${HOME}` already expanded by the daemon; undefined when neither
 * names one. Refused unless absolute: a relative path would read from the working directory, the
 * terminal's folder in one run and `/` under launchd. The value is passed on as written once the
 * tilde is read: Claude Code keys the Keychain entry of a login by the folder's string, so a
 * trailing slash is another entry. (The core's `expandUser` is not importable from an agent
 * module, so the tilde is read here.)
 */
function configDirOf(written: string | undefined, home: string): string | undefined {
  const inherited = written === undefined ? process.env.CLAUDE_CONFIG_DIR || undefined : undefined;
  const value = written ?? inherited;
  if (value === undefined) return undefined;
  // Concatenated, not joined: `join` would rewrite `~/./work` or a doubled slash, and the Keychain
  // entry follows the string.
  const expanded = value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;
  if (!isAbsolute(expanded)) {
    const where =
      inherited === undefined ? "" : ", set in the daemon's environment and not in .env,";
    throw new AgentConfigError(
      `CLAUDE_CONFIG_DIR${where} must be an absolute path, or one starting with ~/; it is "${value}"`,
    );
  }
  return expanded;
}

/**
 * The entry that builds the Claude back end. `options` are what a test replaces: the SDK's
 * query, the owner's home, the usage probe's start.
 */
export function claudeAgent(options: ClaudeBackendOptions = {}): AgentEntry {
  return {
    required: [],
    optional: VARIABLES,
    build: (context) => {
      const variables = set(context.variables);
      const configDir = configDirOf(variables.CLAUDE_CONFIG_DIR, options.home ?? homedir());
      if (configDir !== undefined) {
        variables.CLAUDE_CONFIG_DIR = configDir;
        // The SDK's `listSessions`, which the back end calls in the daemon's own process, has no
        // option for the folder (`ListSessionsOptions`, sdk.d.ts 0.3.301) and reads
        // `process.env.CLAUDE_CONFIG_DIR` (bundled sdk.mjs, not documented): without this, it
        // would look in the default login's folder, and `!resume` and the Home tab's session
        // list would come up empty. (The cleanup reads the back end's own projects folder and
        // is not affected.) It is written once, at build. The usage probe's bare session passes
        // no `env`, so the SDK gives it this environment, and the limits it reads are those of
        // this login.
        process.env.CLAUDE_CONFIG_DIR = configDir;
      }
      return new ClaudeBackend({
        clock: context.clock,
        variables,
        ...(configDir !== undefined && { configDir }),
        ...options,
      });
    },
  };
}

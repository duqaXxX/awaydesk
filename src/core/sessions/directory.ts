/** Whether a folder can hold a session, the folder a typed path names, and `!status`'s terminal line. */
import { realpathSync, statSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { AgentBackend, Repository } from "../../agent/seam.ts";
import { shellQuote } from "../../text.ts";
import { errorCode } from "../../values.ts";
import { ABSENT, expandUser, resolvePath } from "../paths.ts";
import * as texts from "../texts.ts";
import { DirectoryMissing, DirectoryUnreadable, DirectoryUntrusted } from "./errors.ts";

/**
 * `agent`'s record of trust as `checkDirectory` and the folder list read it. An agent that
 * keeps none (`folderTrust`) has no gate to start a session behind: every folder counts.
 */
export function trustedBy(agent: AgentBackend): (folder: string) => Promise<boolean> {
  return async (folder) => !agent.capabilities.folderTrust || agent.folderTrusted(folder);
}

/**
 * `agent`'s answer for the repository holding a folder when the daemon's own git may run in it:
 * the one lookup behind the footer and `!open`. Null for an agent with no record of trust
 * (`folderTrust`): the daemon's git runs in no folder then.
 */
export function repositoryBy(agent: AgentBackend): (folder: string) => Promise<Repository | null> {
  return async (folder) =>
    agent.capabilities.folderTrust ? agent.trustedRepository(folder) : null;
}

/**
 * Rejects with the `DirectoryUnavailable` that keeps a session from starting in `directory`,
 * the first found in the order the owner can act on: missing, unreadable, untrusted.
 */
export async function checkDirectory(
  directory: string,
  trusted: (folder: string) => Promise<boolean>,
  names: texts.Names,
): Promise<void> {
  // One stat and one directory open on a local folder, as a session start always made them.
  // A folder the daemon is not let into is unreadable at either: at the stat when a folder
  // above it is closed, at the open when it is closed itself. Both say `DirectoryUnreadable`.
  try {
    if (!(await stat(directory)).isDirectory()) throw new DirectoryMissing(directory);
    await (await opendir(directory)).close();
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") throw new DirectoryUnreadable(directory);
    // A path with a null in it is one Node refuses to look at: it names no folder.
    if (code !== undefined && (ABSENT.has(code) || code === "ERR_INVALID_ARG_VALUE")) {
      throw new DirectoryMissing(directory);
    }
    throw error;
  }
  if (!(await trusted(directory))) throw new DirectoryUntrusted(directory, names);
}

/** Whether `path` is `root` or lies under it. */
function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The real directory `raw` names, if it exists under `root`; guards against a typo only. */
export function resolveDirectory(raw: string, root: string): string | null {
  // A relative path is read under the root: the daemon's own working directory means nothing
  // to the owner (launchd starts it in `/`).
  const written = expandUser(raw);
  try {
    // Joined as text: the disk follows a link before a `..`.
    const path = resolvePath(isAbsolute(written) ? written : `${root}/${written}`);
    if (!statSync(path).isDirectory() || !under(path, root)) return null;
    // The kernel is asked too, since a session runs in the folder it reaches: whatever the
    // reading above made of the spelling, that folder lies under the root or is refused.
    return under(realpathSync.native(path), realpathSync.native(root)) ? path : null;
  } catch {
    return null; // it names nothing, or goes through a loop of links
  }
}

/**
 * The `!status` line with the command that forks a session in the terminal (the agent's
 * `words.terminal`, `template`), run from the thread's folder, where `!resume` in its channel
 * then finds the fork. `escapeMarkup` is the chat's, for a reference (`ChatProvider.escape`).
 */
export function terminalLine(
  template: string,
  directory: string,
  sessionId: string,
  escapeMarkup: (text: string) => string,
): string {
  const command = texts.fill(template, {
    directory: shellQuote(directory),
    session: sessionId,
  });
  // A code span cannot hold a backtick: such a command is plain text, escaped.
  const shown = command.includes("`") ? escapeMarkup(command) : `\`${command}\``;
  return texts.fill(texts.STATUS_TERMINAL, { command: shown });
}

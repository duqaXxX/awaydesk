/** Whether a folder can hold a session, the folder a typed path names, and `!status`'s terminal line. */
import { realpathSync, statSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { errorCode } from "../../values.ts";
import { expandUser, resolvePath } from "../paths.ts";
import * as texts from "../texts.ts";
import { DirectoryMissing, DirectoryUnreadable, DirectoryUntrusted } from "./errors.ts";

/**
 * Rejects with the `DirectoryUnavailable` that keeps a session from starting in `directory`,
 * the first found in the order the owner can act on: missing, unreadable, untrusted.
 */
export async function checkDirectory(
  directory: string,
  trusted: (folder: string) => Promise<boolean>,
): Promise<void> {
  // One stat and one directory open on a local folder, as a session start always made them.
  const found = await stat(directory).catch(() => null);
  if (found === null || !found.isDirectory()) throw new DirectoryMissing(directory);
  try {
    await (await opendir(directory)).close();
  } catch (error) {
    // Python's `PermissionError` is these two.
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") {
      throw new DirectoryUnreadable(directory);
    }
    throw error;
  }
  if (!(await trusted(directory))) throw new DirectoryUntrusted(directory);
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
    // Joined as text, as Python's `root / raw` is: the disk follows a link before a `..`.
    const path = resolvePath(isAbsolute(written) ? written : `${root}/${written}`);
    if (!statSync(path).isDirectory() || !under(path, root)) return null;
    // The kernel is asked too, since a session runs in the folder it reaches: whatever the
    // reading above made of the spelling, that folder lies under the root or is refused.
    return under(realpathSync.native(path), realpathSync.native(root)) ? path : null;
  } catch {
    return null; // it names nothing, or goes through a loop of links
  }
}

/** `shlex.quote`: the word as one shell argument, quoted only when it needs to be. */
export function shellQuote(word: string): string {
  if (word === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\"'\"'")}'`;
}

// Slack's markdown block: the characters that start inline formatting there, each escapable
// with a backslash. The same set as the Slack provider's `markdownEscape`, which the core may
// not import: a reply's text is markdown on both sides of the chat seam.
const MARKDOWN_INLINE = /([\\`*_{}[\]()&~])/g;

/**
 * The `!status` line with the command that forks a session in the terminal, run from the
 * thread's folder, where `!resume` in its channel then finds the fork.
 */
export function terminalLine(directory: string, sessionId: string): string {
  const command = texts.fill(texts.TERMINAL_COMMAND, {
    directory: shellQuote(directory),
    session: sessionId,
  });
  // A code span cannot hold a backtick: such a command is plain text, escaped.
  const shown = command.includes("`") ? command.replace(MARKDOWN_INLINE, "\\$1") : `\`${command}\``;
  return texts.fill(texts.STATUS_TERMINAL, { command: shown });
}

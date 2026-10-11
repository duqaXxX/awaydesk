/**
 * Claude Code's Chrome integration, for the sessions the daemon starts.
 *
 * Claude Code turns the integration on in an interactive session when the owner chose "Enabled by
 * default" in `/chrome`: the key `claudeInChromeDefaultEnabled` of `~/.claude.json` (settings
 * reference, read 2026-10-09). A session the Agent SDK starts is not interactive, and there the key
 * connects nothing: the built-in `claude-in-chrome` server is listed only when Claude Code is
 * started with `--chrome` (measured 2026-10-09, CLI 2.1.292). The daemon passes the flag when the
 * key is on, so a session from Slack has the browser where the terminal has it.
 *
 * Nothing else is the daemon's. Which sites Claude may act on is the extension's own setting, and
 * whether an action asks first is the session's permission mode, as in the terminal: a browser
 * call that asks reaches Slack through `canUseTool` like any other tool (measured the same day,
 * SDK 0.2.164).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";

export const logger = getLogger("awaydesk.agent.claude.chrome");

// Strict UTF-8, and a BOM stays in the text, where `JSON.parse` refuses it.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whether the owner turned Chrome on by default in Claude Code; false when its record cannot be
 * read. Read at every call, so a change in `/chrome` holds from a session's next start.
 */
export async function chromeEnabled(home: string = homedir()): Promise<boolean> {
  let record: unknown;
  try {
    record = JSON.parse(STRICT_UTF8.decode(await readFile(join(home, ".claude.json"))));
  } catch (error) {
    logger.warning(`could not read Claude Code's Chrome setting: ${errorName(error)}`);
    return false;
  }
  return (
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    (record as Record<string, unknown>).claudeInChromeDefaultEnabled === true
  );
}

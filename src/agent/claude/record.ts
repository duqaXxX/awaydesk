import { join } from "node:path";

/**
 * Claude Code's record of the owner, `.claude.json`: in the folder `CLAUDE_CONFIG_DIR` names when
 * the login has its own (measured 2026-10-17, CLI 2.1.301: with the variable set, the file is
 * written inside that folder), else in the home.
 */
export function recordPath(home: string, configDir?: string): string {
  return join(configDir ?? home, ".claude.json");
}

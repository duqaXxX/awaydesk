/**
 * The names the daemon's texts take when Claude and Slack are the two modules, written out:
 * what a test fills a text with to compare it with what the owner reads. They are literals on
 * purpose: read from the modules, a wrong name there would pass every comparison.
 */
import type { Names } from "../../src/core/texts.ts";

export const NAMES: Names = {
  agent: "Claude Code",
  author: "Claude",
  cli: "claude",
  chat: "Slack",
  examples: "`!compact`, `!model opus`",
};

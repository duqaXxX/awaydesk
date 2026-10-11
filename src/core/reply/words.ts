/** The words a reply's lines share, whoever writes them: the renderer, the fold, a chat provider. */
import { escaped, PY_SPACE } from "../../text.ts";

export const BACKGROUND = "Running in background";
export const STOPPED = "Stopped";

const SPACES = new RegExp(`[${PY_SPACE}]+`);

/** `value` with its runs of whitespace as one space and none at its ends: `" ".join(value.split())`. */
export function spaced(value: string): string {
  return value
    .split(SPACES)
    .filter((word) => word !== "")
    .join(" ");
}

// The line boundaries of Python's `str.splitlines`: more than `\n` and `\r`, and not the unit
// separator U+001F, which is whitespace and no boundary.
const LINE_END_CODES = [0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029];
const LINE_ENDS = new RegExp(`\\r\\n|[${LINE_END_CODES.map(escaped).join("")}]`);

/** The lines of `text` as Python's `str.splitlines()` cuts them: a boundary at the end adds none. */
export function splitLines(text: string): string[] {
  const lines = text.split(LINE_ENDS);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** `value` on one line, its runs of whitespace as one space, cut with `…` past `limit` characters. */
export function oneLine(value: string, limit: number): string {
  const text = spaced(value);
  // Counted in code points: an emoji is one character.
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * The oldest Node that runs awaydesk, and the sentence that refuses an older one. The entry reads
 * it before it loads the daemon (`main.ts`). `test/node-version.test.ts` holds `MINIMUM_NODE` to
 * `engines.node` in `package.json`. This file and what it imports are loaded on every Node, so
 * they name `node:fs` and each other only.
 */
import { SETUP_SECTIONS, setupGuide } from "./version.ts";

// The first Node 22 release with long-term support. No Node API the source uses is newer than
// Node 20.12 (`util.parseEnv`); the dependencies set the floor. Measured on 2026-10-17:
// `@slack/socket-mode` takes `undici` 7 or 8 as a peer, 8 declares Node 22.19 and fails to load on
// 22.0.0, and npm 10.5.1 (bundled with 22.0.0) installs 8 where npm 10.9.0 (22.11.0) installs 7.
// The releases between 22.0.0 and 22.11.0 were not measured.
export const MINIMUM_NODE = "22.11.0";

/** `major.minor.patch` as three numbers; null for a text that does not start with them. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The refusal for a Node whose `process.versions.node` is `found`, or null when it is at least
 * `MINIMUM_NODE`. Compared number by number (22.9.0 is below 22.11.0); a pre-release suffix is
 * ignored, and a text that holds no version is not refused, since nothing says it is too old.
 */
export function nodeRefusal(found: string): string | null {
  const have = parts(found);
  const need = parts(MINIMUM_NODE) as [number, number, number];
  if (have === null) return null;
  for (const [index, wanted] of need.entries()) {
    const actual = have[index] as number;
    if (actual > wanted) return null;
    if (actual < wanted) {
      return `awaydesk needs Node ${MINIMUM_NODE} or later and this is Node ${found}; to run it on a newer Node without changing this one, see ${setupGuide(SETUP_SECTIONS.nodeOfItsOwn)}`;
    }
  }
  return null;
}

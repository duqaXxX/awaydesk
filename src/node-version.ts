/**
 * The oldest Node that runs awaydesk, and the sentence that refuses an older one. The entry reads
 * it before anything else (`require-node.ts`): below 22.18 `import.meta.main` is undefined, so
 * `main` is never called and the command would end with status 0 and no output.
 * `test/node-version.test.ts` holds `MINIMUM_NODE` to `engines.node` in `package.json`.
 */
export const MINIMUM_NODE = "22.18.0";

/** `major.minor.patch` as three numbers; null for a text that does not start with them. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The refusal for a Node whose `process.versions.node` is `found`, or null when it is at least
 * `MINIMUM_NODE`. Compared number by number (22.9.0 is below 22.18.0); a pre-release suffix is
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
      return `awaydesk needs Node ${MINIMUM_NODE} or later and this is Node ${found}; see docs/setup.md, Requirements`;
    }
  }
  return null;
}

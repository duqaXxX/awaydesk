/** Paths the way Python's `Path` treated them. */
import { isAbsolute, relative, sep } from "node:path";

/** `Path.is_relative_to` and `relative_to`: `path` from `root` when it lies under it, else null. */
export function relativeTo(root: string, path: string): string | null {
  const found = relative(root, path);
  if (found === ".." || found.startsWith(`..${sep}`) || isAbsolute(found)) return null;
  return found;
}
